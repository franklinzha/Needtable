#!/usr/bin/env node
/**
 * 账号管理 CLI。
 *
 * 本站不开放注册，账号只能从这里签发 —— 这是用户提的硬性要求，
 * 也是把登录墙从 Cloudflare Access 搬进应用之后最重要的一条补偿措施。
 *
 * 一个刻意的设计：**管理员不掌握用户的凭据**。
 * 这台机器上没有 AUTH_PEPPER（它是 wrangler secret，只存在于 Cloudflare 那边），
 * 所以这个脚本根本算不出可入库的密码哈希。它只做一件事：写一行
 * sha256(一次性令牌) 进 user_invites，然后把令牌交给你转给用户。
 * 密码和 TOTP 密钥都在「用户点开链接」那一刻才在浏览器与 Worker 之间产生。
 *
 * 令牌放在路径里（/enroll/<token>）：老格式 /enroll#<token> 常被微信等聊天软件
 * 在 # 处截断。库里只存哈希、一次性、7 天过期，Referrer-Policy 为 same-origin。
 *
 * 用法（不需要 npm install，wrangler 走 npx 按需拉取）：
 *
 *   node scripts/user.mjs add alice@example.com --name 爱丽丝 --admin   (或 --role pro|plus|normal)
 *   node scripts/user.mjs list
 *   node scripts/user.mjs reset alice@example.com      # 重新签发链接，旧凭据立即作废
 *   node scripts/user.mjs disable alice@example.com    # 停用，已登录的设备立刻被踢
 *   node scripts/user.mjs enable  alice@example.com
 *   node scripts/user.mjs role    alice@example.com admin|pro|plus|normal
 *   node scripts/user.mjs delete  alice@example.com
 *
 * 加 --local 操作本地开发库（wrangler dev 用的那个），默认操作线上库。
 */

import { spawnSync } from 'node:child_process';
import { randomBytes, createHash } from 'node:crypto';
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { newUserId, newWorkspaceId, newBaseId } from '../public/shared/util/uid.js';
import { keyBetween } from '../public/shared/model/fracindex.js';
import { qrToAscii } from '../public/shared/util/qr.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;   // 与 worker/routes/auth.js 保持一致

// ── 读 wrangler.jsonc（带注释，正则取值即可，不值得为此引一个 jsonc 解析器）──
// 有 wrangler.local.jsonc（本机真实配置，不进仓库）就用它

const WRANGLER_CONFIG = existsSync(join(ROOT, 'wrangler.local.jsonc')) ? 'wrangler.local.jsonc' : 'wrangler.jsonc';
const wranglerText = readFileSync(join(ROOT, WRANGLER_CONFIG), 'utf8');
/** @param {string} key */
const cfg = (key) => (wranglerText.match(new RegExp('"' + key + '"\\s*:\\s*"([^"]*)"')) || [])[1] || '';

const DB_NAME = cfg('database_name') || 'table-db';
const APP_HOST = cfg('APP_HOST') || 'localhost';

// ── 参数 ────────────────────────────────────────────────────────────────────

const argv = process.argv.slice(2);
/** 带值的参数。列出来才能正确切分 positional —— 否则 `--local add x` 里的
 *  add 会被当成 --local 的值吃掉。 */
const VALUED = new Set(['name', 'host', 'role']);
const flags = new Set(argv.filter((a) => a.startsWith('--') && !a.includes('=')));

/** @param {string} name */
function flagValue(name) {
  const i = argv.indexOf('--' + name);
  if (i >= 0 && argv[i + 1] !== undefined) return argv[i + 1];
  const eq = argv.find((a) => a.startsWith('--' + name + '='));
  return eq ? eq.slice(name.length + 3) : '';
}

const positional = (() => {
  /** @type {string[]} */ const out = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) { out.push(a); continue; }
    if (!a.includes('=') && VALUED.has(a.slice(2))) i++;   // 跳过它的值
  }
  return out;
})();

const LOCAL = flags.has('--local');
const BASE_URL = flagValue('host') || (LOCAL ? 'http://localhost:8787' : 'https://' + APP_HOST);

// ── SQL 执行 ────────────────────────────────────────────────────────────────

/** SQL 字符串字面量。d1 execute 不支持参数化，只能自己转义。 */
const q = (/** @type {string|null} */ v) =>
  v === null || v === undefined ? 'NULL'
    : "'" + String(v).replace(/[\r\n]+/g, ' ').replace(/'/g, "''") + "'";   // 换行见 sql()

/**
 * npx 的启动方式。Windows 上 npx 是个 .cmd，要是自己用 shell: true 去起，
 * SQL 里的引号、& 、% 就得我们亲手按 cmd.exe 的规矩转义。直接用 node 跑 npm 自带的
 * npx-cli.js，这层转义交给 npm 去做。
 */
const NPX = (() => {
  if (process.platform !== 'win32') return { cmd: 'npx', pre: [] };
  const cli = join(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npx-cli.js');
  if (!existsSync(cli)) die('找不到 npx-cli.js（' + cli + '），Node 装得不完整？');
  return { cmd: process.execPath, pre: [cli] };
})();

/**
 * 跑一段 SQL。走 --command 而不是 --file：对线上库，--file 走的是 D1 的导入
 * （ingest）通道，每次要一分多钟，也不是拿来回查询结果的。
 * @param {string} sql @returns {any[]} 每条语句一个结果对象
 */
function sql(sql_) {
  // 压成一行。Windows 上 npx 最后还得经 wrangler.cmd 那个 shim，cmd.exe 会在换行处
  // 把参数截断（D1 回 "incomplete input"）；别的字符 npm 会替我们转义。
  // 所以 SQL 里不能写 -- 注释，q() 也把值里的换行换成了空格。
  const oneLine = sql_.replace(/\s*[\r\n]+\s*/g, ' ').trim();
  const args = [
    ...NPX.pre, '--yes', 'wrangler@4', 'd1', 'execute', DB_NAME,
    LOCAL ? '--local' : '--remote', '--json', '-c', WRANGLER_CONFIG, '--command', oneLine,
  ];
  const r = spawnSync(NPX.cmd, args, {
    cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
    // 别设 WRANGLER_LOG=error：新版 wrangler 连 --json 的结果都走 logger，一并被吞掉。
    env: { ...process.env, CI: 'true' },
  });
  if (r.error) throw r.error;
  if (r.status !== 0) {
    process.stderr.write(r.stdout || '');
    process.stderr.write(r.stderr || '');
    throw new Error('wrangler d1 execute 失败（退出码 ' + r.status + '）');
  }
  return parseJsonOut(r.stdout);
}

/** wrangler 偶尔会在 JSON 前面打横幅或 ▲ [WARNING]，从第一个行首的 [ 或 { 开始截。 @param {string} out */
function parseJsonOut(out) {
  const i = out.search(/^[[{]/m);
  if (i < 0) return [];
  try {
    const v = JSON.parse(out.slice(i));
    return Array.isArray(v) ? v : [v];
  } catch { return []; }
}

/** @param {string} sql_ @returns {any[]} 第一条语句的行 */
const rows = (sql_) => sql(sql_)[0]?.results ?? [];

// ── 业务 ────────────────────────────────────────────────────────────────────

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** @param {string} raw */
function email(raw) {
  const e = String(raw || '').trim().toLowerCase();
  if (!EMAIL_RE.test(e)) die('邮箱格式不对：' + raw);
  return e;
}

/** @param {string} msg */
function die(msg) { console.error('\n  ✖ ' + msg + '\n'); process.exit(1); }

/** @param {string} e */
function findUser(e) {
  return rows(`SELECT id, email, name, role, status, pw_hash, session_epoch
                 FROM users WHERE email = ${q(e)};`)[0] ?? null;
}

/**
 * 签发一次性链接。库里只落 sha256(token) —— 令牌有 256 位熵，
 * 不需要慢哈希（慢哈希是为了保护低熵口令，对随机令牌没有意义）。
 * @param {string} userId @param {string} e @param {'invite'|'reset'} kind
 */
function issueInvite(userId, e, kind) {
  const token = randomBytes(32).toString('base64url');
  const hash = createHash('sha256').update(token).digest('hex');
  const now = Date.now();

  // 同一个人的旧链接一律作废，避免「发了三次，三条都还能用」
  sql(`UPDATE user_invites SET used_at = ${now}
        WHERE user_id = ${q(userId)} AND used_at IS NULL;
       INSERT INTO user_invites (token_hash, user_id, email, kind, created_by, created_at, expires_at)
       VALUES (${q(hash)}, ${q(userId)}, ${q(e)}, ${q(kind)}, 'cli', ${now}, ${now + INVITE_TTL_MS});`);

  return BASE_URL + '/enroll/' + token;
}

/** @param {string} url @param {string} e */
function printInvite(url, e) {
  console.log('\n  把下面这条链接交给 ' + e + '（7 天内有效，只能用一次）：\n');
  console.log('  ' + url + '\n');
  console.log(qrToAscii(url));
  console.log('  用户打开后当场设置密码（管理员开了动态码的话，还要先绑定验证器 App）。');
  console.log('  你不会知道他的密码，也不会知道他的 TOTP 密钥 —— 这是设计如此。\n');
}

// ── 命令 ────────────────────────────────────────────────────────────────────

/** 账号等级，和 worker/lib/tiers.js 一致 */
const TIERS = ['admin', 'pro', 'plus', 'normal'];

const commands = {
  /** add <email> [--name X] [--admin | --role pro|plus|normal] */
  add() {
    const e = email(positional[1]);
    if (findUser(e)) die(e + ' 已存在。要重新发链接用 reset，要改角色用 role。');

    const name = flagValue('name') || e.split('@')[0];
    const role = flags.has('--admin') ? 'admin' : (flagValue('role') || 'plus').toLowerCase();
    if (!TIERS.includes(role)) die('等级只能是 ' + TIERS.join(' / '));
    const now = Date.now();
    const userId = newUserId();
    const wsId = newWorkspaceId();
    const baseId = newBaseId();

    // 能建东西的等级顺手建默认工作区与 base：否则第一次进来会看到一个什么都干不了的空界面。
    // normal 不能建表，给他空工作区没有意义；以后升级时网页端会补建。
    const workspaceSql = role === 'normal' ? '' : `
         INSERT INTO workspaces (id, name, icon, owner_id, created_at, updated_at)
         VALUES (${q(wsId)}, ${q(name + ' 的工作区')}, '📊', ${q(userId)}, ${now}, ${now});

         INSERT INTO workspace_members (workspace_id, user_id, role, created_at)
         VALUES (${q(wsId)}, ${q(userId)}, 'owner', ${now});

         INSERT INTO bases (id, workspace_id, name, icon, ordinal, created_at, updated_at)
         VALUES (${q(baseId)}, ${q(wsId)}, '默认', '📁', ${q(keyBetween(null, null))}, ${now}, ${now});`;
    sql(`INSERT INTO users (id, email, name, access_sub, role, created_at, last_seen_at,
                            status, session_epoch, pw_version, pw_updated_at, totp_last_step,
                            failed_count, locked_until)
         VALUES (${q(userId)}, ${q(e)}, ${q(name)}, NULL, ${q(role)}, ${now}, ${now},
                 'pending', 1, 1, 0, 0, 0, 0);${workspaceSql}`);

    console.log('\n  ✔ 已创建 ' + e + '（' + role + '，待开通）');
    printInvite(issueInvite(userId, e, 'invite'), e);
  },

  /** reset <email> —— 重发链接。旧密码、旧验证器、已登录的设备全部立即失效。 */
  reset() {
    const e = email(positional[1]);
    const u = findUser(e);
    if (!u) die(e + ' 不存在');

    sql(`UPDATE users
            SET pw_hash = NULL, pw_salt = NULL, pw_updated_at = 0,
                totp_secret = NULL, totp_last_step = 0,
                status = 'pending', session_epoch = session_epoch + 1,
                failed_count = 0, locked_until = 0
          WHERE id = ${q(u.id)};`);

    console.log('\n  ✔ ' + e + ' 的旧密码与旧验证器已作废，在线会话已全部踢下线');
    printInvite(issueInvite(u.id, e, 'reset'), e);
  },

  /** disable <email> */
  disable() {
    const e = email(positional[1]);
    const u = findUser(e);
    if (!u) die(e + ' 不存在');
    // session_epoch + 1 才是真正把人踢下线的那一下；只改 status 的话，
    // 已签发的 Cookie 还要等缓存过期（最多 60 秒）才会被拒。
    sql(`UPDATE users SET status = 'disabled', session_epoch = session_epoch + 1
          WHERE id = ${q(u.id)};`);
    console.log('\n  ✔ 已停用 ' + e + '，其所有设备上的会话立即失效\n');
  },

  /** enable <email> */
  enable() {
    const e = email(positional[1]);
    const u = findUser(e);
    if (!u) die(e + ' 不存在');
    const back = u.pw_hash ? 'active' : 'pending';   // 还没设过密码的，恢复成待开通
    sql(`UPDATE users SET status = ${q(back)}, failed_count = 0, locked_until = 0
          WHERE id = ${q(u.id)};`);
    console.log('\n  ✔ 已恢复 ' + e + '（' + back + '）'
      + (back === 'pending' ? '，他还没设置过密码，需要 reset 发一条开通链接' : '') + '\n');
  },

  /** role <email> admin|pro|plus|normal */
  role() {
    const e = email(positional[1]);
    const want = String(positional[2] || '').toLowerCase();
    if (!TIERS.includes(want)) die('等级只能是 ' + TIERS.join(' / '));
    const u = findUser(e);
    if (!u) die(e + ' 不存在');
    sql(`UPDATE users SET role = ${q(want)} WHERE id = ${q(u.id)};`);
    console.log('\n  ✔ ' + e + ' 现在是 ' + want + '（最多 60 秒后在服务端生效）\n');
  },

  /** delete <email> */
  delete() {
    const e = email(positional[1]);
    const u = findUser(e);
    if (!u) die(e + ' 不存在');
    if (!flags.has('--force')) {
      die('删除不可撤销，且他名下的工作区会留成孤儿。确认请加 --force；\n'
        + '    只是想让人进不来的话，用 disable 更合适。');
    }
    sql(`DELETE FROM user_invites WHERE user_id = ${q(u.id)};
         DELETE FROM table_acl     WHERE user_id = ${q(u.id)};
         DELETE FROM workspace_members WHERE user_id = ${q(u.id)};
         DELETE FROM users         WHERE id = ${q(u.id)};`);
    console.log('\n  ✔ 已删除 ' + e + '\n');
  },

  /** list */
  list() {
    const list = rows(`SELECT u.email, u.name, u.role, u.status, u.last_seen_at,
                              u.locked_until, u.pw_hash IS NOT NULL AS has_pw,
                              (SELECT COUNT(*) FROM user_invites i
                                WHERE i.user_id = u.id AND i.used_at IS NULL
                                  AND i.expires_at > ${Date.now()}) AS pending_invites
                         FROM users u ORDER BY u.created_at;`);
    if (!list.length) {
      console.log('\n  还没有任何账号。先建一个管理员：\n');
      console.log('    node scripts/user.mjs add 你的邮箱@example.com --admin\n');
      return;
    }
    const when = (/** @type {number} */ t) =>
      !t ? '从未' : new Date(Number(t)).toISOString().slice(0, 16).replace('T', ' ');

    console.log('');
    console.log('  邮箱                          角色     状态      最近活动          备注');
    console.log('  ' + '─'.repeat(88));
    for (const r of list) {
      const notes = [];
      if (!r.has_pw) notes.push('未设置密码');
      if (Number(r.locked_until) > Date.now()) notes.push('已锁定至 ' + when(r.locked_until));
      if (Number(r.pending_invites) > 0) notes.push('有未使用的开通链接');
      console.log('  ' + String(r.email).padEnd(30) + String(r.role).padEnd(9)
        + String(r.status).padEnd(10) + when(r.last_seen_at).padEnd(18) + notes.join('，'));
    }
    console.log('');
  },

  help() {
    console.log(`
  账号管理（本站不开放注册，账号只能从这里签发）

    node scripts/user.mjs add <邮箱> [--name 姓名] [--admin|--role pro|plus|normal]   新建并签发开通链接
    node scripts/user.mjs list                                  列出所有账号
    node scripts/user.mjs reset <邮箱>                          重发链接，旧凭据立即作废
    node scripts/user.mjs disable <邮箱>                        停用，会话立即失效
    node scripts/user.mjs enable  <邮箱>                        恢复
    node scripts/user.mjs role    <邮箱> admin|pro|plus|normal  改账号等级
    node scripts/user.mjs delete  <邮箱> --force                删除

  通用参数
    --local          操作本地开发库（默认操作线上库 ${DB_NAME}）
    --host <地址>    覆盖链接里的站点地址（默认 ${BASE_URL}）

  第一次用：先 add 一个 --admin，把打印出来的链接在浏览器里打开。
`);
  },
};

const cmd = positional[0] || 'help';
if (!(cmd in commands)) die('未知命令 "' + cmd + '"。可用：' + Object.keys(commands).join(' / '));
try {
  commands[/** @type {keyof typeof commands} */ (cmd)]();
} catch (err) {
  die(/** @type {Error} */ (err).message);
}
