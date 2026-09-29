/**
 * 中间件链的端到端冒烟测试（不需要 wrangler，也不需要联网）。
 *
 * 验证的是**门禁的决策**，不是业务逻辑：
 *   - 密钥没配完 → 全站 503（fail-closed）
 *   - 没有会话 → 401，**静态资源、index.html 一并被拦**
 *   - 登录页与它那几个依赖 → 未登录也能拿到，且绝不会漏出 index.html
 *   - 开通账号 → 登录 → 访问 /api/me 的完整一轮
 *   - 账号被删 / 被停用 / 会话代次被顶掉 → 手里的 Cookie 立刻失效
 *   - Access 模式（AUTH_MODE="access"）那条老路仍然成立
 *
 * 假的 ASSETS 刻意模拟了 not_found_handling = "single-page-application"：
 * 任何命不中的路径都回落到 index.html。整个白名单必须精确匹配这件事，
 * 只有在这种回落行为下才测得出来。
 */

import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';

import worker from './index.js';
import { resetUserCache } from './middleware/rbac.js';
import { resetRateLimit } from './middleware/ratelimit.js';
import { resetTotpKeyCache, totpCode, currentStep, base32ToBytes } from './lib/totp.js';
import { signSession } from './lib/session.js';
import { bytesToB64url } from '../public/shared/util/b64.js';

const SECRETS = { SESSION_SECRET: 's'.repeat(40), AUTH_PEPPER: 'p'.repeat(40) };

/** 受保护的应用外壳。任何一处测试里看到它，都说明门禁漏了。 */
const APP_HTML = '<!doctype html><title>Table</title><div id="app">受保护</div>';
const LOGIN_HTML = '<!doctype html><title>登录</title><form id="view-login"></form>';

// ── 假的 D1 ─────────────────────────────────────────────────────────────────

/**
 * 按 SQL 片段分发的内存实现。只覆盖鉴权链真正会发的那些语句 ——
 * 多写一条就多一份「假的和真的不一样」的风险。
 */
function fakeDB() {
  /** @type {any[]} */ const users = [];
  /** @type {any[]} */ const workspaces = [];
  /** @type {any[]} */ const members = [];
  /** @type {any[]} */ const invites = [];
  /** @type {string[]} */ const inserts = [];
  /** app_settings。没有这一行就是关 —— 与线上刚跑完 0003 迁移时一样。 */
  /** @type {Map<string,string>} */ const settings = new Map();

  const byEmail = (e) => users.find((u) => u.email === e) ?? null;
  const byId = (id) => users.find((u) => u.id === id) ?? null;

  const exec = (sql, args) => {
    const one = (first) => ({ first, results: [] });

    if (sql.includes('COUNT(*) AS n FROM users')) return one({ n: users.length });

    if (sql.includes('FROM app_settings WHERE key = ?')) {
      return one(settings.has(args[0]) ? { value: settings.get(args[0]) } : null);
    }
    if (sql.startsWith('INSERT INTO app_settings')) { settings.set(args[0], args[1]); return one(null); }
    if (sql.includes('totp_secret IS NULL')) {
      return { first: null, results: users.filter((u) => u.status === 'active' && !u.totp_secret) };
    }

    // —— users 的几种读法。返回整行即可：多出来的字段调用方不会看。
    if (sql.startsWith('SELECT') && sql.includes('FROM users WHERE email = ?')) return one(byEmail(args[0]));
    if (sql.startsWith('SELECT') && sql.includes('FROM users WHERE id = ?')) return one(byId(args[0]));

    if (sql.startsWith('INSERT INTO users')) {
      users.push({
        id: args[0], email: args[1], name: args[2], access_sub: args[3], role: args[4],
        created_at: args[5], last_seen_at: args[6],
        status: 'active', session_epoch: 1, pw_hash: null, pw_salt: null,
        totp_secret: null, totp_last_step: 0, failed_count: 0, locked_until: 0,
      });
      inserts.push('users'); return one(null);
    }
    if (sql.startsWith('INSERT INTO workspaces')) {
      workspaces.push({ id: args[0], name: args[1], icon: args[2] });
      inserts.push('workspaces'); return one(null);
    }
    if (sql.startsWith('INSERT INTO workspace_members')) {
      members.push({ workspace_id: args[0], user_id: args[1], role: args[2] });
      inserts.push('workspace_members'); return one(null);
    }
    if (sql.startsWith('INSERT INTO bases')) { inserts.push('bases'); return one(null); }

    // —— users 的几种写法。顺序从最长的匹配起，别让短的抢先。
    if (sql.includes('SET pw_hash = ?')) {
      const u = byId(args[8]);
      if (u) Object.assign(u, {
        pw_hash: args[0], pw_salt: args[1], pw_version: args[2], pw_updated_at: args[3],
        status: 'active', session_epoch: args[4], totp_last_step: args[5],
        failed_count: 0, locked_until: 0, last_seen_at: args[6], totp_secret: args[7],
      });
      return one(null);
    }
    if (sql.includes('SET totp_secret = ?, totp_last_step = ?')) {   // 已登录用户自己绑定
      const u = byId(args[2]);
      if (u) Object.assign(u, { totp_secret: args[0], totp_last_step: args[1] });
      return one(null);
    }
    if (sql.includes('SET totp_secret = ?')) {                       // 开通时生成
      const u = byId(args[1]);
      if (u) Object.assign(u, { totp_secret: args[0], totp_last_step: 0 });
      return one(null);
    }
    if (sql.includes('SET failed_count = 0, locked_until = 0, totp_last_step = ?')) {
      const u = byId(args[2]);
      if (u) Object.assign(u, { failed_count: 0, locked_until: 0, totp_last_step: args[0], last_seen_at: args[1] });
      return one(null);
    }
    if (sql.includes('SET failed_count = ?, locked_until = ?')) {
      const u = byId(args[2]);
      if (u) Object.assign(u, { failed_count: args[0], locked_until: args[1] });
      return one(null);
    }
    if (sql.includes('SET last_seen_at = ?, access_sub = ?')) {
      const u = byId(args[2]);
      if (u) Object.assign(u, { last_seen_at: args[0], access_sub: args[1] });
      return one(null);
    }

    // —— user_invites
    if (sql.includes('FROM user_invites WHERE token_hash = ?')) {
      return one(invites.find((i) => i.token_hash === args[0]) ?? null);
    }
    if (sql.includes('UPDATE user_invites SET used_at = ?')) {
      const inv = invites.find((i) => i.token_hash === args[1]);
      if (inv) inv.used_at = args[0];
      return one(null);
    }

    if (sql.includes('FROM workspaces w')) {
      return { first: null, results: workspaces.map((w) => ({ ...w, role: 'owner' })) };
    }
    return one(null);
  };

  const db = {
    prepare(sql) {
      const stmt = {
        args: [],
        bind(...a) { stmt.args = a; return stmt; },
        async first() { return exec(sql, stmt.args).first; },
        async all() { return { results: exec(sql, stmt.args).results }; },
        async run() { exec(sql, stmt.args); return { success: true }; },
      };
      return stmt;
    },
    async batch(stmts) { const out = []; for (const s of stmts) out.push(await s.all()); return out; },
  };

  /** 直接塞一个已开通的账号进去（不走开通流程时用）。 */
  const seedUser = (over = {}) => {
    const u = {
      id: 'usr_seed', email: 'seed@example.com', name: '种子', access_sub: null, role: 'member',
      created_at: 0, last_seen_at: 0, status: 'active', session_epoch: 1,
      pw_hash: null, pw_salt: null, totp_secret: null, totp_last_step: 0,
      failed_count: 0, locked_until: 0, ...over,
    };
    users.push(u);
    return u;
  };

  /** 签发一条邀请，返回明文令牌（库里只有 sha256，与 scripts/user.mjs 一致）。 */
  const seedInvite = (userId, email, kind = 'invite') => {
    const token = randomBytes(32).toString('base64url');
    invites.push({
      token_hash: createHash('sha256').update(token).digest('hex'),
      user_id: userId, email, kind, created_by: 'test',
      created_at: Date.now(), expires_at: Date.now() + 86400_000, used_at: null,
    });
    return token;
  };

  /** 打开 / 关掉「登录需要动态码」。 @param {boolean} on */
  const setTotp = (on) => settings.set('totp_required', on ? '1' : '0');

  return { db, users, workspaces, members, invites, inserts, settings, seedUser, seedInvite, setTotp };
}

const ctx = { waitUntil() {}, passThroughOnException() {} };

function baseEnv(over = {}) {
  const store = fakeDB();
  return {
    store,
    env: {
      DB: store.db,
      ASSETS: {
        async fetch(r) {
          const p = new URL(r.url).pathname;
          const files = {
            '/login.html': [LOGIN_HTML, 'text/html'],
            '/css/login.css': ['.card{}', 'text/css'],
            '/js/login.js': ['export {}', 'text/javascript'],
            '/help.html': ['<title>函数帮助</title>', 'text/html'],
            '/yonghuguanli.html': ['<title>用户管理页</title><script src="/js/yonghuguanli.js"></script>', 'text/html'],
            '/css/help.css': ['.fn{}', 'text/css'],
            '/js/help.js': ['export {}', 'text/javascript'],
            '/js/help-guide.js': ['export {}', 'text/javascript'],
            '/js/help-md.js': ['export {}', 'text/javascript'],
            '/shared/formula/docs.js': ['export {}', 'text/javascript'],
            '/js/main.js': ['export {}', 'text/javascript'],
          };
          const f = files[p];
          if (f) return new Response(f[0], { headers: { 'content-type': f[1] } });
          // SPA 回落：命不中的路径一律吐 index.html —— 这正是线上的行为。
          return new Response(APP_HTML, { headers: { 'content-type': 'text/html' } });
        },
      },
      ENVIRONMENT: 'production',
      APP_NAME: 'Needtable',
      ...over,
    },
  };
}

const req = (path, init) => new Request('https://table.example.com' + path, init);
const hit = (env, path, init) => worker.fetch(req(path, init), env, ctx);

/** 浏览器地址栏导航（会被 302 到登录页）与 fetch / import（保持 401）。 */
const NAV = { 'sec-fetch-dest': 'document', accept: 'text/html' };
const XHR = { 'sec-fetch-dest': 'empty', accept: 'application/json' };

/** 从响应里抠出会话 Cookie，形如 "__Host-tbl_sess=..."。 @param {Response} res */
const cookieOf = (res) => (res.headers.get('set-cookie') || '').split(';')[0];

const postJson = (env, path, body, headers = {}) => hit(env, path, {
  method: 'POST',
  headers: { 'content-type': 'application/json', ...XHR, ...headers },
  body: JSON.stringify(body),
});

let failures = 0;
async function test(name, fn) {
  resetUserCache(); resetRateLimit(); resetTotpKeyCache();
  try { await fn(); console.log('  ok   ' + name); }
  catch (err) { failures++; console.error('  FAIL ' + name + '\n       ' + err.message); }
}

// ── 配置缺失 ────────────────────────────────────────────────────────────────

await test('密钥未配置 → 全站 503，且不泄露任何应用内容', async () => {
  const { env } = baseEnv();
  for (const path of ['/', '/index.html', '/js/main.js', '/api/me']) {
    const res = await hit(env, path, { headers: XHR });
    assert.equal(res.status, 503, path + ' 应为 503');
    assert.ok(!(await res.text()).includes('受保护'), path + ' 泄露了应用外壳');
  }
});

await test('密钥未配置时登录接口回 503，而不是 500', async () => {
  const { env } = baseEnv();
  const res = await postJson(env, '/api/auth/login', { email: 'a@b.com', dk: 'x', code: '000000' });
  assert.equal(res.status, 503);
  // 但 config 仍可用：登录页要靠它知道站点还没配好
  assert.equal((await hit(env, '/api/auth/config', { headers: XHR })).status, 200);
});

// ── 未登录 ──────────────────────────────────────────────────────────────────

await test('没有 Cookie → 401，index.html 与 JS 模块一并被拦', async () => {
  const { env } = baseEnv(SECRETS);
  for (const path of ['/', '/index.html', '/js/main.js', '/js/core/api.js', '/api/me']) {
    const res = await hit(env, path, { headers: XHR });
    assert.equal(res.status, 401, path + ' 应为 401');
    assert.ok(!(await res.text()).includes('受保护'), path + ' 泄露了应用外壳');
  }
});

await test('伪造 / 篡改的 Cookie 一律 401', async () => {
  const { env } = baseEnv(SECRETS);
  const forged = Buffer.from(JSON.stringify({
    uid: 'usr_x', email: 'evil@x.com', epoch: 1, iat: Date.now(), exp: Date.now() + 1e7,
  })).toString('base64url') + '.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
  const res = await hit(env, '/api/me', { headers: { ...XHR, cookie: '__Host-tbl_sess=' + forged } });
  assert.equal(res.status, 401);
});

await test('地址栏直接访问 → 302 去登录页并带上回跳地址', async () => {
  const { env } = baseEnv(SECRETS);

  const root = await hit(env, '/', { headers: NAV });
  assert.equal(root.status, 302);
  assert.equal(root.headers.get('location'), '/login', '根路径不该带多余的 next');

  const deep = await hit(env, '/t/abc?view=kanban', { headers: NAV });
  assert.equal(deep.status, 302);
  assert.equal(deep.headers.get('location'), '/login?next=' + encodeURIComponent('/t/abc?view=kanban'));

  // fetch / import 必须保持 401：给 ES module 回一个 302 到 HTML，
  // 浏览器报的会是「MIME 类型不对」，排查起来完全找不着北。
  assert.equal((await hit(env, '/js/main.js', { headers: { 'sec-fetch-dest': 'script' } })).status, 401);
});

// ── 公开白名单 ──────────────────────────────────────────────────────────────

await test('登录页与它的依赖未登录可取，且都不是 index.html', async () => {
  const { env } = baseEnv(SECRETS);
  for (const path of ['/login', '/login.html', '/enroll', '/enroll/AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', '/css/login.css', '/js/login.js']) {
    const res = await hit(env, path, { headers: NAV });
    assert.equal(res.status, 200, path + ' 应可访问');
    assert.ok(!(await res.text()).includes('受保护'), path + ' 吐出了 index.html');
  }
  const page = await hit(env, '/login', { headers: NAV });
  assert.ok((await page.text()).includes('view-login'), '/login 应改写到 login.html');
  assert.equal(page.headers.get('cache-control'), 'no-store', '登录页不该被缓存留下');
});

await test('帮助中心必须登录：未登录地址栏访问 302 去登录页，它的脚本样式一律 401', async () => {
  const { env } = baseEnv(SECRETS);
  for (const path of ['/help', '/help.html']) {
    const res = await hit(env, path, { headers: NAV });
    assert.equal(res.status, 302, path + ' 应跳登录页');
    assert.equal(res.headers.get('location'), '/login?next=' + encodeURIComponent(path));
  }
  for (const path of ['/css/help.css', '/js/help.js', '/js/help-guide.js', '/js/help-md.js', '/shared/formula/docs.js']) {
    const res = await hit(env, path, { headers: XHR });
    assert.equal(res.status, 401, path + ' 应被拦');
  }
});

await test('wrangler.jsonc 的 html_handling 是 none（否则 /login 无限重定向）', async () => {
  // 假 ASSETS 不模拟 html_handling，所以这条只能对着配置本身查。
  // auto-trailing-slash 会把 /login.html 307 回 /login，而 Worker 正是把 /login 改写成
  // /login.html 去取的 —— 两者一碰就是死循环。线上真出过这事。
  const cfg = readFileSync(new URL('../wrangler.jsonc', import.meta.url), 'utf8');
  const m = cfg.match(/^\s*"html_handling"\s*:\s*"([^"]*)"/m);
  assert.ok(m, 'wrangler.jsonc 里应显式写出 html_handling');
  assert.equal(m[1], 'none');
});

await test('白名单是精确匹配：同目录下不存在的文件不会漏出 index.html', async () => {
  const { env } = baseEnv(SECRETS);
  // 这几条正是「白名单写成前缀」时会出事的路径 —— SPA 回落会把 index.html 交出去
  for (const path of ['/css/nope.css', '/js/nope.js', '/shared/util/nope.js',
    '/login.html.bak', '/loginx', '/enroll/', '/enroll/short', '/enroll/AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', '/enroll/AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA/x', '/enroll/x/../js/nope.js']) {
    const res = await hit(env, path, { headers: XHR });
    assert.equal(res.status, 401, path + ' 应被拦');
    assert.ok(!(await res.text()).includes('受保护'), path + ' 泄露了应用外壳');
  }
});

await test('公开接口之外的 /api/auth/* 是 404 / 405，不会回落到静态资源', async () => {
  const { env } = baseEnv(SECRETS);
  assert.equal((await hit(env, '/api/auth/nope', { headers: XHR })).status, 404);
  assert.equal((await hit(env, '/api/auth/login', { headers: XHR })).status, 405, 'GET 登录接口应 405');
});

// ── 开通 → 登录 → 使用 ──────────────────────────────────────────────────────

/**
 * 跑一遍完整的开通流程，返回 { store, env, token, dk, secret, cookie }。
 * totp: true 时先打开全站动态码开关（这一节的老用例都是冲着 TOTP 写的）；
 * false 就是线上的默认状态：只设密码。
 */
async function enroll(overEnv = {}, { totp = true } = {}) {
  const { env, store } = baseEnv({ ...SECRETS, ...overEnv });
  store.setTotp(totp);
  const u = store.seedUser({ email: 'alice@example.com', status: 'pending', name: '爱丽丝' });
  const token = store.seedInvite(u.id, u.email);

  const begin = await postJson(env, '/api/auth/enroll/begin', { token });
  assert.equal(begin.status, 200, '开通链接应有效');
  const info = await begin.json();
  assert.equal(info.totpRequired, totp);
  const secret = totp ? base32ToBytes(new URL(info.otpauth).searchParams.get('secret')) : null;
  if (!totp) assert.equal(info.otpauth, undefined, '没开动态码就不该生成密钥');

  // dk 是浏览器里 600k PBKDF2 的产物。Worker 只当它是 32 字节，
  // 所以这里直接给随机值 —— KDF 本身在 lib/auth.test.mjs 里单独测。
  const dk = bytesToB64url(randomBytes(32));
  const step = currentStep(Date.now());
  const complete = await postJson(env, '/api/auth/enroll/complete',
    secret ? { token, dk, code: await totpCode(secret, step) } : { token, dk });

  return { env, store, user: u, token, dk, secret, step, complete };
}

await test('开通账号：拿到会话 Cookie，账号转为 active', async () => {
  const { store, complete, user } = await enroll();
  assert.equal(complete.status, 200);
  assert.ok(cookieOf(complete).startsWith('__Host-tbl_sess='), '应下发 __Host- 会话 Cookie');
  assert.ok(complete.headers.get('set-cookie').includes('HttpOnly'));

  const row = store.users.find((x) => x.id === user.id);
  assert.equal(row.status, 'active');
  assert.ok(row.pw_hash && row.pw_salt, '口令哈希应已落库');
  assert.equal(row.session_epoch, 2, '开通应顶掉旧会话代次');
  assert.equal(store.invites[0].used_at !== null, true, '邀请令牌应被标记为已用');
});

await test('开通用的链接不能用第二次', async () => {
  const { env, token, dk, secret } = await enroll();
  const again = await postJson(env, '/api/auth/enroll/complete',
    { token, dk, code: await totpCode(secret, currentStep(Date.now())) });
  assert.equal(again.status, 404, '一次性令牌必须一次性');
  assert.equal((await postJson(env, '/api/auth/enroll/begin', { token })).status, 404);
});

await test('开通时动态码不对 → 400，账号保持未开通', async () => {
  const { env, store } = baseEnv(SECRETS);
  store.setTotp(true);
  const u = store.seedUser({ email: 'bob@example.com', status: 'pending' });
  const token = store.seedInvite(u.id, u.email);
  await postJson(env, '/api/auth/enroll/begin', { token });

  const res = await postJson(env, '/api/auth/enroll/complete',
    { token, dk: bytesToB64url(randomBytes(32)), code: '000000' });
  assert.equal(res.status, 400);
  assert.equal(store.users[0].status, 'pending');
  assert.equal(store.users[0].pw_hash, null);
  assert.equal(store.invites[0].used_at, null, '失败不该烧掉令牌');
});

await test('开通后可以登录，并拿到自己的 /api/me', async () => {
  const { env, dk, secret, step } = await enroll();

  // 刚开通时用掉的那个码不能再用（totp_last_step 已记下），换下一个窗口的
  const res = await postJson(env, '/api/auth/login',
    { email: 'alice@example.com', dk, code: await totpCode(secret, step + 1) });
  assert.equal(res.status, 200);

  const cookie = cookieOf(res);
  const me = await hit(env, '/api/me', { headers: { ...XHR, cookie } });
  assert.equal(me.status, 200);
  const body = await me.json();
  assert.equal(body.user.email, 'alice@example.com');
  assert.equal(body.user.via, 'password', '顶栏靠它决定要不要显示退出按钮');

  // 有了会话，index.html 才发得出去
  const home = await hit(env, '/', { headers: { ...NAV, cookie } });
  assert.equal(home.status, 200);
  assert.ok((await home.text()).includes('受保护'));
});

await test('刚用过的动态码不能拿来登录（30 秒内重放）', async () => {
  const { env, dk, secret, step } = await enroll();
  const res = await postJson(env, '/api/auth/login',
    { email: 'alice@example.com', dk, code: await totpCode(secret, step) });
  assert.equal(res.status, 401);
});

await test('口令错、动态码错、查无此人 —— 回的是同一句话', async () => {
  const { env, secret, step } = await enroll();
  const code = await totpCode(secret, step + 1);
  const msgs = new Set();
  for (const body of [
    { email: 'alice@example.com', dk: bytesToB64url(randomBytes(32)), code },  // 口令错
    { email: 'alice@example.com', dk: bytesToB64url(randomBytes(32)), code: '000000' },
    { email: 'nobody@example.com', dk: bytesToB64url(randomBytes(32)), code },  // 查无此人
  ]) {
    const res = await postJson(env, '/api/auth/login', body);
    assert.equal(res.status, 401);
    const j = await res.json();
    msgs.add(j.error.code + '|' + j.error.message);
  }
  assert.equal(msgs.size, 1, '错误信息有差异就等于给攻击者做账号枚举：' + [...msgs].join(' / '));
});

await test('登出清掉 Cookie', async () => {
  const { env, dk, secret, step } = await enroll();
  const login = await postJson(env, '/api/auth/login',
    { email: 'alice@example.com', dk, code: await totpCode(secret, step + 1) });
  const cookie = cookieOf(login);

  const out = await postJson(env, '/api/auth/logout', {}, { cookie });
  assert.equal(out.status, 200);
  assert.ok(out.headers.get('set-cookie').includes('Max-Age=0'));
});

// ── 动态码是可选的（默认关）────────────────────────────────────────────────

await test('默认不要动态码：config 说关，开通与登录都只要邮箱 + 密码', async () => {
  const cfg = await (await hit(baseEnv(SECRETS).env, '/api/auth/config', { headers: XHR })).json();
  assert.equal(cfg.totpRequired, false, '没有 app_settings 那一行就是关');

  const { env, store, dk, complete } = await enroll({}, { totp: false });
  assert.equal(complete.status, 200, '不带动态码也能开通');
  assert.equal(store.users[0].totp_secret, null);

  const res = await postJson(env, '/api/auth/login', { email: 'alice@example.com', dk });
  assert.equal(res.status, 200, '不带动态码也能登录');
  const me = await hit(env, '/api/me', { headers: { ...XHR, cookie: cookieOf(res) } });
  assert.equal(me.status, 200);
});

await test('关着动态码时：密码错与查无此人回同一句话，且不提动态码', async () => {
  const { env } = await enroll({}, { totp: false });
  const msgs = new Set();
  for (const email of ['alice@example.com', 'nobody@example.com']) {
    const res = await postJson(env, '/api/auth/login', { email, dk: bytesToB64url(randomBytes(32)) });
    assert.equal(res.status, 401);
    const j = await res.json();
    msgs.add(j.error.code + '|' + j.error.message);
  }
  assert.equal(msgs.size, 1, [...msgs].join(' / '));
  assert.ok(![...msgs][0].includes('动态码'), '没开动态码，报错里就别提它');
});

await test('关着动态码时开通，会清掉没确认过的密钥（免得日后开开关被它挡住）', async () => {
  const { env, store } = baseEnv(SECRETS);
  const u = store.seedUser({ email: 'carol@example.com', status: 'pending', totp_secret: '未确认的密文' });
  const token = store.seedInvite(u.id, u.email);
  const res = await postJson(env, '/api/auth/enroll/complete', { token, dk: bytesToB64url(randomBytes(32)) });
  assert.equal(res.status, 200);
  assert.equal(u.totp_secret, null);
});

await test('开着动态码时：没带码、或还没绑验证器的账号都登录不了', async () => {
  const { env, store, dk } = await enroll({}, { totp: false });
  store.setTotp(true);
  const res = await postJson(env, '/api/auth/login', { email: 'alice@example.com', dk });
  assert.equal(res.status, 401);
  const res2 = await postJson(env, '/api/auth/login', { email: 'alice@example.com', dk, code: '123456' });
  assert.equal(res2.status, 401);
});

await test('开过又关掉：已绑验证器的人也不用再输码', async () => {
  const { env, store, dk } = await enroll();
  store.setTotp(false);
  const res = await postJson(env, '/api/auth/login', { email: 'alice@example.com', dk });
  assert.equal(res.status, 200);
});

await test('安全设置：成员不能碰开关；管理员得先绑验证器才能打开', async () => {
  const { env, store, dk, complete } = await enroll({}, { totp: false });
  const cookie = cookieOf(complete);
  const put = (on) => hit(env, '/api/admin/settings', {
    method: 'PUT', headers: { ...XHR, cookie, 'content-type': 'application/json' },
    body: JSON.stringify({ totpRequired: on }),
  });

  assert.equal((await hit(env, '/api/admin/settings', { headers: { ...XHR, cookie } })).status, 403);
  assert.equal((await put(true)).status, 403, '成员不能改');

  store.users[0].role = 'admin';
  resetUserCache();

  const view = await (await hit(env, '/api/admin/settings', { headers: { ...XHR, cookie } })).json();
  assert.equal(view.totpRequired, false);
  assert.deepEqual(view.withoutTotp, ['alice@example.com'], '开开关前要让管理员看到谁会被挡住');
  assert.equal((await put(true)).status, 409, '自己没绑就开 = 把自己锁在门外');

  // 绑定：begin 不入库，confirm 输对一次码才入库
  const begin = await (await postJson(env, '/api/me/totp/begin', {}, { cookie })).json();
  assert.equal(store.users[0].totp_secret, null, 'begin 不该直接写库');
  const secret = base32ToBytes(begin.secret);
  const bad = await postJson(env, '/api/me/totp/confirm', { pending: begin.pending, code: '000000' }, { cookie });
  assert.equal(bad.status, 400);
  const step = currentStep(Date.now());
  const ok = await postJson(env, '/api/me/totp/confirm',
    { pending: begin.pending, code: await totpCode(secret, step) }, { cookie });
  assert.equal(ok.status, 200);
  assert.ok(store.users[0].totp_secret);
  assert.equal((await (await hit(env, '/api/me/security', { headers: { ...XHR, cookie } })).json()).hasTotp, true);

  const on = await put(true);
  assert.equal(on.status, 200);
  assert.equal((await on.json()).totpRequired, true);
  assert.equal((await (await hit(env, '/api/auth/config', { headers: XHR })).json()).totpRequired, true);

  // 开了之后：不带码进不来，带下一个窗口的码进得来
  assert.equal((await postJson(env, '/api/auth/login', { email: 'alice@example.com', dk })).status, 401);
  const login = await postJson(env, '/api/auth/login',
    { email: 'alice@example.com', dk, code: await totpCode(secret, step + 1) });
  assert.equal(login.status, 200);

  assert.equal((await put(false)).status, 200, '关掉不需要任何前提');
  assert.equal((await put('yes')).status, 400);
});

// ── 会话吊销 ────────────────────────────────────────────────────────────────

/** 开通并登录，返回 { env, store, cookie }。 */
async function loggedIn() {
  const { env, store, dk, secret, step } = await enroll();
  const res = await postJson(env, '/api/auth/login',
    { email: 'alice@example.com', dk, code: await totpCode(secret, step + 1) });
  assert.equal(res.status, 200, '前置登录应成功');
  return { env, store, cookie: cookieOf(res) };
}

await test('账号被删 → 手里的 Cookie 立刻失效（不会被顺手建回来）', async () => {
  const { env, store, cookie } = await loggedIn();
  store.users.length = 0;
  resetUserCache();                     // 模拟换了一个 isolate，缓存不在了

  const res = await hit(env, '/api/me', { headers: { ...XHR, cookie } });
  assert.equal(res.status, 401);
  assert.ok((res.headers.get('set-cookie') || '').includes('Max-Age=0'), '应顺手把废 Cookie 清掉');
  assert.equal(store.users.length, 0, '口令模式下不许自动开户');
});

await test('账号被停用 → Cookie 立刻失效', async () => {
  const { env, store, cookie } = await loggedIn();
  store.users[0].status = 'disabled';
  resetUserCache();

  assert.equal((await hit(env, '/api/me', { headers: { ...XHR, cookie } })).status, 401);
});

await test('会话代次被顶掉（改口令 / disable）→ 旧设备立刻掉线', async () => {
  const { env, store, cookie } = await loggedIn();
  store.users[0].session_epoch += 1;
  resetUserCache();

  const res = await hit(env, '/api/me', { headers: { ...XHR, cookie } });
  assert.equal(res.status, 401);

  // 而地址栏导航要看到登录页，不是一段 JSON
  const nav = await hit(env, '/', { headers: { ...NAV, cookie } });
  assert.equal(nav.status, 302);
  assert.equal(nav.headers.get('location'), '/login');
});

await test('60 秒缓存不该把刚换过代次的新 Cookie 挡在门外', async () => {
  const { env, store, cookie } = await loggedIn();
  // 先让这个 isolate 把当前用户行缓存住
  assert.equal((await hit(env, '/api/me', { headers: { ...XHR, cookie } })).status, 200);

  // 用户在另一台设备上重设了口令：库里代次 +1，本 isolate 的缓存还是旧的。
  // 拿着新代次 Cookie 的请求必须放行 —— index.js 会先丢缓存重读一次再判断。
  const row = store.users[0];
  row.session_epoch += 1;
  const token = await signSession(
    { id: row.id, email: row.email, session_epoch: row.session_epoch }, env,
  );
  const res = await hit(env, '/api/me', { headers: { ...XHR, cookie: '__Host-tbl_sess=' + token } });
  assert.equal(res.status, 200, '新 Cookie 不该被旧缓存拒掉');

  // 反过来，旧代次的那张必须掉线
  assert.equal((await hit(env, '/api/me', { headers: { ...XHR, cookie } })).status, 401);
});

// ── 通用防线 ────────────────────────────────────────────────────────────────

await test('WebSocket 无 ticket → 401', async () => {
  const { env } = baseEnv({ ...SECRETS, REALTIME_SECRET: 's'.repeat(32) });
  const res = await hit(env, '/api/realtime/ws', { headers: { upgrade: 'websocket' } });
  assert.equal(res.status, 401);
});

await test('登录接口自带限流，且 429 带 retry-after', async () => {
  const { env } = baseEnv(SECRETS);
  let limited = null;
  for (let i = 0; i < 40 && !limited; i++) {
    const res = await postJson(env, '/api/auth/login',
      { email: 'a@b.com', dk: bytesToB64url(randomBytes(32)), code: '000000' });
    if (res.status === 429) limited = res;
  }
  assert.ok(limited, '撞库必须被内存限流拦住 —— 它保护的是 D1 的写额度');
  assert.ok(Number(limited.headers.get('retry-after')) >= 1);
});

await test('静态资源在鉴权通过后正常返回，并带上安全头', async () => {
  const { env } = baseEnv({ ENVIRONMENT: 'development', DEV_BYPASS_EMAIL: 'dev2@example.com' });
  const res = await hit(env, '/');
  assert.equal(res.status, 200);
  assert.ok((await res.text()).includes('受保护'));
  const csp = res.headers.get('content-security-policy') ?? '';
  assert.ok(csp.includes("script-src 'self'"), 'CSP 缺 script-src');
  assert.ok(!csp.includes('unsafe-inline'), 'CSP 不应出现 unsafe-inline');
  assert.ok(csp.includes('wss://table.example.com'), 'CSP connect-src 应含同源 wss');
  assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
  assert.ok(res.headers.get('strict-transport-security'), 'https 下应有 HSTS');
});

await test('登录页也带全套安全头', async () => {
  const { env } = baseEnv(SECRETS);
  const res = await hit(env, '/login', { headers: NAV });
  const csp = res.headers.get('content-security-policy') ?? '';
  assert.ok(csp.includes("script-src 'self'"));
  assert.ok(csp.includes("frame-ancestors 'none'"), '登录页尤其不能被 iframe 套进去');
  assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
});

await test('未知接口 404、方法不对 405', async () => {
  const { env } = baseEnv({ ENVIRONMENT: 'development', DEV_BYPASS_EMAIL: 'dev3@example.com' });
  assert.equal((await hit(env, '/api/nope')).status, 404);
  assert.equal((await hit(env, '/api/me', { method: 'DELETE' })).status, 405);
});

await test('每用户限流生效，且 429 带 retry-after', async () => {
  const { env } = baseEnv({ ENVIRONMENT: 'development', DEV_BYPASS_EMAIL: 'dev4@example.com' });
  let limited = null;
  for (let i = 0; i < 400 && !limited; i++) {
    const res = await hit(env, '/api/health');
    if (res.status === 429) limited = res;
  }
  assert.ok(limited, '连打 400 次应触发限流');
  assert.ok(Number(limited.headers.get('retry-after')) >= 1);
});

await test('未捕获异常不泄露堆栈', async () => {
  const { env } = baseEnv({ ENVIRONMENT: 'development', DEV_BYPASS_EMAIL: 'dev5@example.com' });
  env.DB = { prepare() { throw new Error('secret table name leaked here'); } };
  const orig = console.error; console.error = () => {};       // 预期会打日志，测试里静音
  const res = await hit(env, '/api/me');
  console.error = orig;
  assert.equal(res.status, 500);
  const text = await res.text();
  assert.ok(!text.includes('secret table name'), '响应体泄露了内部错误');
  assert.ok(JSON.parse(text).error.errorId, '应返回可追查的 errorId');
});

await test('dev bypass：/api/me 通过，并自动开户 + 建默认工作区', async () => {
  const { env, store } = baseEnv({ ENVIRONMENT: 'development', DEV_BYPASS_EMAIL: 'Dev@Example.com' });
  const res = await hit(env, '/api/me');
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.user.email, 'dev@example.com', '邮箱应被统一小写');
  assert.equal(body.user.role, 'admin', '第一个用户应为 admin');
  assert.equal(body.user.via, 'dev-bypass');
  assert.deepEqual(store.inserts, ['users', 'workspaces', 'workspace_members', 'bases']);
  assert.equal(body.workspaces.length, 1);
});

await test('AI 接口只占位：capabilities 说未启用，调用一律 501；未登录仍被拦', async () => {
  const { env } = baseEnv({ ENVIRONMENT: 'development', DEV_BYPASS_EMAIL: 'dev@example.com' });
  const cap = await hit(env, '/api/ai/capabilities');
  assert.equal(cap.status, 200);
  assert.deepEqual(await cap.json(), { enabled: false, providers: [] });
  for (const path of ['/api/ai/complete', '/api/ai/formula']) {
    const res = await hit(env, path, { method: 'POST', headers: { 'content-type': 'application/json', ...XHR }, body: '{"prompt":"x","question":"x"}' });
    assert.equal(res.status, 501, path);
    assert.equal((await res.json()).error.code, 'ai_disabled');
  }
  const { env: prod } = baseEnv(SECRETS);
  assert.equal((await hit(prod, '/api/ai/capabilities', { headers: XHR })).status, 401);
});

await test('生产环境下 DEV_BYPASS_EMAIL 无效', async () => {
  const { env } = baseEnv({ ...SECRETS, DEV_BYPASS_EMAIL: 'sneaky@x.com' });  // ENVIRONMENT 仍是 production
  assert.equal((await hit(env, '/api/me', { headers: XHR })).status, 401, 'production 下旁路必须失效');
});

// ── Access 模式（AUTH_MODE="access"）：老路仍然成立 ─────────────────────────

const ACCESS = { AUTH_MODE: 'access', ACCESS_TEAM_DOMAIN: 'team.cloudflareaccess.com', ACCESS_AUD: 'aud123' };

await test('Access 模式：无凭据 → 401，静态资源同样被拦', async () => {
  const { env } = baseEnv(ACCESS);
  for (const path of ['/', '/js/main.js', '/api/me']) {
    const res = await hit(env, path, { headers: XHR });
    assert.equal(res.status, 401, path + ' 应为 401');
    assert.ok(!(await res.text()).includes('受保护'), path + ' 泄露了应用外壳');
  }
});

await test('Access 模式：伪造的 JWT 拿不到任何东西', async () => {
  const { env } = baseEnv(ACCESS);
  const forged = Buffer.from(JSON.stringify({ alg: 'none' })).toString('base64url') + '.'
    + Buffer.from(JSON.stringify({ email: 'evil@x.com', aud: ['aud123'] })).toString('base64url') + '.x';
  const res = await hit(env, '/api/me', { headers: { ...XHR, 'Cf-Access-Jwt-Assertion': forged } });
  assert.equal(res.status, 401);
});

await test('Access 模式：ACCESS_* 没填完 → 503', async () => {
  const { env } = baseEnv({ AUTH_MODE: 'access' });
  assert.equal((await hit(env, '/api/me', { headers: XHR })).status, 503);
});

await test('Access 模式：会话 Cookie 不被接受（不能拿它绕过 Access）', async () => {
  const token = await signSession({ id: 'usr_x', email: 'evil@x.com', session_epoch: 1 }, SECRETS);
  const { env } = baseEnv({ ...ACCESS, ...SECRETS });
  const res = await hit(env, '/api/me', { headers: { ...XHR, cookie: '__Host-tbl_sess=' + token } });
  assert.equal(res.status, 401);
});

// ── 静态资源版本前缀 ────────────────────────────────────────────────────────

await test('index.html 里的站内引用被改写成带部署版本的路径，且自身不缓存', async () => {
  const { env, cookie } = await loggedIn();
  env.CF_VERSION_METADATA = { id: 'ABC-123' };
  const inner = env.ASSETS;
  env.ASSETS = { async fetch(r) {
    if (new URL(r.url).pathname === '/') {
      return new Response('<link rel="stylesheet" href="/css/app.css"><link rel="modulepreload" href="/shared/util/a1.js"><script type="module" src="/js/main.js"></script><a href="/login">x</a>',
        { headers: { 'content-type': 'text/html', etag: '"e1"' } });
    }
    return inner.fetch(r);
  } };
  const res = await hit(env, '/', { headers: { ...NAV, cookie } });
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.ok(html.includes('href="/v/abc-123/css/app.css"'), html);
  assert.ok(html.includes('href="/v/abc-123/shared/util/a1.js"'), html);
  assert.ok(html.includes('src="/v/abc-123/js/main.js"'), html);
  assert.ok(html.includes('href="/login"'), '非静态资源链接不动');
  assert.equal(res.headers.get('cache-control'), 'no-store');
  assert.equal(res.headers.get('etag'), null, '改写后的 HTML 不能带原文件的 ETag，否则部署后会 304 回旧前缀');
});

await test('/v/<版本>/… 取到真实文件并长缓存；不存在的文件 404 而不是回落成 index.html', async () => {
  const { env, cookie } = await loggedIn();
  env.CF_VERSION_METADATA = { id: 'v1' };
  const ok = await hit(env, '/v/v1/js/main.js', { headers: { cookie } });
  assert.equal(ok.status, 200);
  assert.equal(await ok.text(), 'export {}');
  assert.match(ok.headers.get('cache-control'), /immutable/);
  assert.equal((await hit(env, '/v/v1/js/nope.js', { headers: { cookie } })).status, 404);
});

await test('/v/… 同样要先登录', async () => {
  const { env } = await loggedIn();
  const res = await hit(env, '/v/v1/js/main.js', { headers: {} });
  assert.equal(res.status, 401);
});

await test('帮助中心登录后可看：/help 改写到 help.html（不是表格首页），资源走带版本的路径', async () => {
  const { env, cookie } = await loggedIn();
  env.CF_VERSION_METADATA = { id: 'v1' };
  for (const path of ['/help', '/help.html']) {
    const res = await hit(env, path, { headers: { ...NAV, cookie } });
    assert.equal(res.status, 200, path + ' 应可访问');
    const body = await res.text();
    assert.ok(body.includes('函数帮助') && !body.includes('受保护'), path + ' 应是帮助页');
    assert.equal(res.headers.get('cache-control'), 'no-store');
  }
  assert.equal((await hit(env, '/v/v1/js/help.js', { headers: { cookie } })).status, 200);
});

await test('用户管理页 /yonghuguanli：只有管理员能打开，其他人 404（跟不存在一样）', async () => {
  const { env, store, cookie } = await loggedIn();
  env.CF_VERSION_METADATA = { id: 'v1' };
  const nav = (p) => hit(env, p, { headers: { ...NAV, cookie } });
  for (const p of ['/yonghuguanli', '/yonghuguanli.html']) assert.equal((await nav(p)).status, 404, p + ' 非管理员应 404');
  assert.equal((await hit(env, '/yonghuguanli', { headers: NAV })).status, 302, '未登录先去登录页');
  store.users.find((u) => u.email === 'alice@example.com').role = 'admin';
  resetUserCache();
  for (const p of ['/yonghuguanli', '/yonghuguanli.html']) {
    const res = await nav(p);
    assert.equal(res.status, 200, p);
    const body = await res.text();
    assert.ok(body.includes('用户管理页') && body.includes('/v/v1/js/yonghuguanli.js'), body);
    assert.equal(res.headers.get('cache-control'), 'no-store');
  }
});

console.log(failures === 0 ? '\nALL PASS' : '\n' + failures + ' FAILED');
if (failures > 0) process.exit(1);
