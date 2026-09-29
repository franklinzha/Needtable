/**
 * 账号等级与三级分享（工作区 / 内容 / 表）、默认密码。
 *
 * 和 members.test.mjs 一样用 node:sqlite + 真实迁移顶替 D1：权限判断全在 SQL 里。
 *
 * 覆盖：
 *   · 等级：normal 什么都建不了；plus 最多 3 个工作区、只能授出查看 / 编辑；pro 不限
 *   · 最具体的授权胜出（表 > 内容 > 工作区），工作区 owner 不可被覆盖
 *   · 低等级改不了高等级成员的权限
 *   · 只被分享了某个内容 / 某张表的人：主页树里只看得到那一块，别的表 404
 *   · 可见视图 scope 的校验与下发
 *   · 默认密码开户 → 登录带 mustChange → 除改密码外一律 403 → 改完放行、旧 Cookie 作废
 */

import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { installWorkerGlobals } from './do-stub.mjs';

installWorkerGlobals();
const { DatabaseSync } = await import('node:sqlite');
const { createUser, resetUser, updateUser } = await import('../worker/routes/admin.js');
const ws = await import('../worker/routes/workspaces.js');
const tables = await import('../worker/routes/tables.js');
const { requireTableRole, accessibleTree, resetUserCache } = await import('../worker/middleware/rbac.js');
const { resetRateLimit } = await import('../worker/middleware/ratelimit.js');
const auth = await import('../worker/routes/auth.js');
const { changePassword, getMe } = await import('../worker/routes/me.js');
const { getHome } = await import('../worker/routes/home.js');
const worker = (await import('../worker/index.js')).default;
const { deriveLoginKey } = await import('../public/shared/util/kdf.js');
const { bytesToB64url } = await import('../public/shared/util/b64.js');

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const MIGRATIONS = readdirSync(join(ROOT, 'migrations')).filter((f) => f.endsWith('.sql')).sort()
  .map((f) => readFileSync(join(ROOT, 'migrations', f), 'utf8'));

function d1() {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  for (const m of MIGRATIONS) db.exec(m);
  const stmt = (raw) => {
    let args = [];
    // D1 支持 ?1 ?2 这种编号参数，node:sqlite（v22）不支持：展开成按出现顺序的 ?
    const order = [...raw.matchAll(/\?(\d+)/g)].map((m) => Number(m[1]) - 1);
    const sql = order.length ? raw.replace(/\?(\d+)/g, '?') : raw;
    const s = {
      bind: (...a) => {
        args = a.map((v) => (typeof v === 'boolean' ? Number(v) : v));
        if (order.length) args = order.map((i) => args[i]);
        return s;
      },
      first: async () => db.prepare(sql).get(...args) ?? null,
      all: async () => ({ results: db.prepare(sql).all(...args) }),
      run: async () => { db.prepare(sql).run(...args); return { success: true }; },
      _exec: () => (/^\s*(SELECT|WITH)/i.test(sql) ? { results: db.prepare(sql).all(...args) } : (db.prepare(sql).run(...args), { results: [] })),
    };
    return s;
  };
  return {
    raw: db,
    prepare: stmt,
    async batch(list) {
      db.exec('BEGIN');
      try { const out = list.map((s) => s._exec()); db.exec('COMMIT'); return out; }
      catch (e) { db.exec('ROLLBACK'); throw e; }
    },
  };
}

/**
 * alice(admin) 拥有 ws_a：内容 bas_1（tbl_1、tbl_2）、bas_2（tbl_3）。
 * pat(pro)、pete(plus)、nora(normal) 另有账号，初始都不在 ws_a 里。
 */
function setup() {
  const DB = d1();
  const revoked = [];
  const waits = [];
  const env = {
    DB, APP_NAME: 'Needtable', SESSION_SECRET: 's'.repeat(40), AUTH_PEPPER: 'p'.repeat(40),
    TABLE_DO: {
      idFromName: (n) => n,
      get: (id) => ({
        fetch: async (u, init) => {
          revoked.push([init?.headers?.['x-user-id'], id]);
          return new Response('{"closed":1}');
        },
      }),
    },
    ASSETS: { fetch: async () => new Response('<!doctype html>app', { headers: { 'content-type': 'text/html' } }) },
  };
  const ctx = { waitUntil: (p) => waits.push(p) };
  const now = Date.now();
  const q = (sql, ...a) => DB.raw.prepare(sql).run(...a);
  let i = 0;
  for (const [id, role] of [['usr_alice', 'admin'], ['usr_pat', 'pro'], ['usr_pete', 'plus'], ['usr_nora', 'normal']]) {
    const email = id.slice(4) + '@x.com';
    q("INSERT INTO users (id, email, name, role, created_at, last_seen_at, status, session_epoch, pw_hash) VALUES (?,?,?,?,?,?,'active',1,'h')",
      id, email, id.slice(4), role, now + i++, now);
  }
  q("INSERT INTO workspaces (id, name, owner_id, created_at, updated_at) VALUES ('ws_a','A','usr_alice',?,?)", now, now);
  q("INSERT INTO workspace_members (workspace_id, user_id, role, created_at) VALUES ('ws_a','usr_alice','owner',?)", now);
  for (const b of ['bas_1', 'bas_2']) {
    q("INSERT INTO bases (id, workspace_id, name, ordinal, created_at, updated_at) VALUES (?, 'ws_a', ?, 'a0', ?, ?)", b, b, now, now);
  }
  for (const [t, b] of [['tbl_1', 'bas_1'], ['tbl_2', 'bas_1'], ['tbl_3', 'bas_2']]) {
    q("INSERT INTO tables (id, workspace_id, base_id, name, ordinal, created_by, created_at, updated_at) VALUES (?, 'ws_a', ?, ?, 'a0', 'usr_alice', ?, ?)", t, b, t, now, now);
  }
  const user = (id) => {
    const r = DB.raw.prepare('SELECT id, email, name, role, status, session_epoch, must_change_pw FROM users WHERE id = ?').get(id);
    return { id: r.id, email: r.email, name: r.name, role: r.role, status: r.status, sessionEpoch: r.session_epoch, mustChange: r.must_change_pw === 1 };
  };
  const url = new URL('https://table.example.com/api/x');
  const call = async (fn, who, { params = {}, body, method = 'POST' } = {}) => {
    const request = new Request(url, body === undefined ? { method } : { method, body: JSON.stringify(body), headers: { 'content-type': 'application/json' } });
    const res = await fn(request, { env, ctx, url, params, user: user(who), identity: { via: 'password' } });
    await Promise.all(waits.splice(0));
    return { status: res.status, body: await res.json(), headers: res.headers };
  };
  const share = (level, who, id, email, role, scope) =>
    call({ workspace: ws.putMember, base: ws.putBaseMember, table: tables.putTableMember }[level], who,
      { params: { id }, body: { email, role, ...(scope !== undefined ? { scope } : {}) }, method: 'PUT' });
  const roleOn = async (who, tbl) => {
    const g = await requireTableRole(env, user(who), tbl, 'viewer');
    return 'response' in g ? g.response.status : g.role;
  };
  return { DB, env, ctx, revoked, call, user, url, share, roleOn, row: (sql, ...a) => ({ ...DB.raw.prepare(sql).get(...a) }) };
}

let failures = 0;
async function test(name, fn) {
  resetUserCache(); resetRateLimit();
  try { await fn(); console.log('  ok   ' + name); }
  catch (err) { failures++; console.error('  FAIL ' + name + '\n       ' + (err.stack ?? err.message)); }
}

// ── 等级 ────────────────────────────────────────────────────────────────────

await test('normal 建不了工作区、内容、表（即使对内容有编辑权）', async () => {
  const t = setup();
  assert.equal((await t.call(ws.createWorkspace, 'usr_nora', { body: { name: 'x' } })).status, 403);
  await t.share('base', 'usr_alice', 'bas_1', 'nora@x.com', 'editor');
  assert.equal((await t.call(ws.createBase, 'usr_nora', { params: { id: 'ws_a' }, body: { name: 'x' } })).status, 404, '不是工作区成员，连工作区都看不到');
  assert.equal((await t.call(tables.createTable, 'usr_nora', { body: { name: 'x', baseId: 'bas_1' } })).status, 403);
  // 但被分享来的表能编辑
  assert.equal(await t.roleOn('usr_nora', 'tbl_1'), 'editor');
});

await test('plus 最多 3 个工作区，新工作区自带一个内容；pro 不限', async () => {
  const t = setup();
  for (let k = 0; k < 3; k++) {
    const r = await t.call(ws.createWorkspace, 'usr_pete', { body: { name: 'w' + k } });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.equal(t.row('SELECT COUNT(*) AS n FROM bases WHERE workspace_id = ?', r.body.id).n, 1);
  }
  const over = await t.call(ws.createWorkspace, 'usr_pete', { body: { name: 'w4' } });
  assert.equal(over.status, 403);
  assert.match(over.body.error.message, /最多拥有 3 个/);
  for (let k = 0; k < 5; k++) assert.equal((await t.call(ws.createWorkspace, 'usr_pat', { body: { name: 'p' + k } })).status, 201);
});

await test('plus 只能授出查看 / 编辑；pro 能授出管理者；normal 不能分享', async () => {
  const t = setup();
  await t.share('workspace', 'usr_alice', 'ws_a', 'pete@x.com', 'manager');
  await t.share('workspace', 'usr_alice', 'ws_a', 'pat@x.com', 'manager');
  assert.equal((await t.share('table', 'usr_pete', 'tbl_1', 'nora@x.com', 'manager')).status, 403);
  assert.equal((await t.share('table', 'usr_pete', 'tbl_1', 'nora@x.com', 'editor')).status, 201);
  assert.equal((await t.share('base', 'usr_pat', 'bas_2', 'nora@x.com', 'manager')).status, 201);
  // nora 是 bas_2 的管理者，但等级是 normal，照样不能分享
  const r = await t.share('table', 'usr_nora', 'tbl_3', 'pete@x.com', 'viewer');
  assert.equal(r.status, 403);
  assert.match(r.body.error.message, /等级/);
});

await test('低等级管理者改不了高等级成员；非 owner 管理者动不了同级授权', async () => {
  const t = setup();
  await t.share('workspace', 'usr_alice', 'ws_a', 'pete@x.com', 'manager');
  await t.share('workspace', 'usr_alice', 'ws_a', 'pat@x.com', 'editor');
  const r = await t.share('workspace', 'usr_pete', 'ws_a', 'pat@x.com', 'viewer');
  assert.equal(r.status, 403);
  assert.match(r.body.error.message, /比你高/);
  assert.equal((await t.call(ws.removeMember, 'usr_pete', { params: { id: 'ws_a', userId: 'usr_pat' }, method: 'DELETE' })).status, 403);
  // pro 管理者可以改 plus 编辑者，但改不了另一位管理者
  await t.share('workspace', 'usr_alice', 'ws_a', 'pat@x.com', 'manager');
  assert.equal((await t.share('workspace', 'usr_pat', 'ws_a', 'pete@x.com', 'viewer')).status, 403);
  assert.equal((await t.share('workspace', 'usr_alice', 'ws_a', 'pete@x.com', 'editor')).status, 200);
  assert.equal((await t.share('workspace', 'usr_pat', 'ws_a', 'pete@x.com', 'viewer')).status, 200);
});

// ── 最具体的授权胜出 ────────────────────────────────────────────────────────

await test('表 > 内容 > 工作区：可以收窄，也可以放宽', async () => {
  const t = setup();
  await t.share('workspace', 'usr_alice', 'ws_a', 'pete@x.com', 'editor');
  await t.share('base', 'usr_alice', 'bas_1', 'pete@x.com', 'viewer');
  await t.share('table', 'usr_alice', 'tbl_2', 'pete@x.com', 'editor');
  assert.equal(await t.roleOn('usr_pete', 'tbl_1'), 'viewer', '内容级收窄');
  assert.equal(await t.roleOn('usr_pete', 'tbl_2'), 'editor', '表级再放宽');
  assert.equal(await t.roleOn('usr_pete', 'tbl_3'), 'editor', '其它内容按工作区');

  const list = await t.call(tables.listTableMembers, 'usr_alice', { params: { id: 'tbl_1' }, method: 'GET' });
  const pete = list.body.members.find((m) => m.email === 'pete@x.com');
  assert.deepEqual([pete.role, pete.via, pete.direct, pete.inherited], ['viewer', 'base', false, { role: 'editor', via: 'workspace' }]);
});

await test('工作区 owner 不能被内容 / 表级授权覆盖，也不能改自己', async () => {
  const t = setup();
  await t.share('workspace', 'usr_alice', 'ws_a', 'pat@x.com', 'manager');
  assert.equal((await t.share('table', 'usr_pat', 'tbl_1', 'alice@x.com', 'viewer')).status, 400);
  assert.equal((await t.share('table', 'usr_pat', 'tbl_1', 'pat@x.com', 'viewer')).status, 400);
  assert.equal(await t.roleOn('usr_alice', 'tbl_1'), 'owner');
});

await test('只分享一个内容 / 一张表：树里只有那一块，别的表 404；移出工作区连带收回', async () => {
  const t = setup();
  await t.share('base', 'usr_alice', 'bas_2', 'nora@x.com', 'viewer');
  await t.share('table', 'usr_alice', 'tbl_1', 'nora@x.com', 'viewer');
  const tree = await accessibleTree(t.env, 'usr_nora');
  assert.equal(tree.length, 1);
  assert.equal(tree[0].partial, true);
  const shape = tree[0].bases.map((b) => [b.id, b.via, b.tables.map((x) => x.id)]).sort();
  assert.deepEqual(shape, [['bas_1', 'container', ['tbl_1']], ['bas_2', 'base', ['tbl_3']]]);
  assert.equal(await t.roleOn('usr_nora', 'tbl_2'), 404);

  const w = await t.call(ws.getWorkspace, 'usr_nora', { params: { id: 'ws_a' }, method: 'GET' });
  assert.equal(w.status, 200);
  assert.deepEqual(w.body.tables.map((x) => x.id).sort(), ['tbl_1', 'tbl_3']);

  // 被分享的人可以自己退出某张表
  assert.equal((await t.call(tables.removeTableMember, 'usr_nora', { params: { id: 'tbl_1', userId: 'usr_nora' }, method: 'DELETE' })).status, 200);
  assert.equal(await t.roleOn('usr_nora', 'tbl_1'), 404);

  // 先加入工作区，再移出：内容级授权一起没了
  await t.share('workspace', 'usr_alice', 'ws_a', 'nora@x.com', 'viewer');
  await t.call(ws.removeMember, 'usr_alice', { params: { id: 'ws_a', userId: 'usr_nora' }, method: 'DELETE' });
  assert.equal(await t.roleOn('usr_nora', 'tbl_3'), 404);
});

await test('可见视图 scope：校验、存储、随 getTable 下发', async () => {
  const t = setup();
  assert.equal((await t.share('table', 'usr_alice', 'tbl_1', 'nora@x.com', 'viewer', ['chart'])).status, 400);
  assert.equal((await t.share('table', 'usr_alice', 'tbl_1', 'nora@x.com', 'viewer', [])).status, 400);
  assert.equal((await t.share('table', 'usr_alice', 'tbl_1', 'nora@x.com', 'viewer', ['dashboard'])).status, 201);
  const g = await t.call(tables.getTable, 'usr_nora', { params: { id: 'tbl_1' }, method: 'GET' });
  assert.equal(g.body.scope, 'dashboard');
  // 三项全选等于不限制
  await t.share('table', 'usr_alice', 'tbl_1', 'nora@x.com', 'viewer', ['grid', 'kanban', 'dashboard']);
  assert.equal(t.row("SELECT scope FROM table_acl WHERE table_id = 'tbl_1'").scope, null);
});

await test('重命名：工作区要管理者，内容要编辑者', async () => {
  const t = setup();
  await t.share('workspace', 'usr_alice', 'ws_a', 'pete@x.com', 'editor');
  assert.equal((await t.call(ws.updateWorkspace, 'usr_pete', { params: { id: 'ws_a' }, body: { name: 'B' }, method: 'PATCH' })).status, 403);
  assert.equal((await t.call(ws.updateBase, 'usr_pete', { params: { id: 'bas_1' }, body: { name: '销售' }, method: 'PATCH' })).status, 200);
  assert.equal((await t.call(ws.updateWorkspace, 'usr_alice', { params: { id: 'ws_a' }, body: { name: '  ' }, method: 'PATCH' })).status, 400);
  assert.equal((await t.call(ws.updateWorkspace, 'usr_alice', { params: { id: 'ws_a' }, body: { name: '总部' }, method: 'PATCH' })).status, 200);
  assert.equal(t.row("SELECT name FROM workspaces WHERE id = 'ws_a'").name, '总部');
  assert.equal(t.row("SELECT name FROM bases WHERE id = 'bas_1'").name, '销售');
});

// ── 管理员：等级与默认工作区 ────────────────────────────────────────────────

await test('开户按等级：normal 没有默认工作区，升级后补建；非法等级 400', async () => {
  const t = setup();
  assert.equal((await t.call(createUser, 'usr_alice', { body: { email: 'z@x.com', role: 'member' } })).status, 400);
  const r = await t.call(createUser, 'usr_alice', { body: { email: 'n2@x.com', role: 'normal' } });
  assert.equal(r.status, 201);
  const owned = (id) => t.row('SELECT COUNT(*) AS n FROM workspaces WHERE owner_id = ?', id).n;
  assert.equal(owned(r.body.user.id), 0);
  await t.call(updateUser, 'usr_alice', { params: { id: r.body.user.id }, body: { role: 'plus' }, method: 'PATCH' });
  assert.equal(owned(r.body.user.id), 1);
  await t.call(updateUser, 'usr_alice', { params: { id: r.body.user.id }, body: { role: 'pro' }, method: 'PATCH' });
  assert.equal(owned(r.body.user.id), 1, '已经有了就不再建');
  const me = await t.call(getMe, r.body.user.id, { method: 'GET' });
  assert.deepEqual(me.body.user.tier, { name: 'pro', label: 'Pro', create: true, share: true, grantable: ['viewer', 'editor', 'manager'], maxWorkspaces: null });
});

await test('GET /api/home：自己的 + 共享的工作区；直接改库升级的人第一次进主页补建工作区', async () => {
  const t = setup();
  await t.share('table', 'usr_alice', 'tbl_2', 'nora@x.com', 'editor', ['grid']);
  const home = await t.call(getHome, 'usr_nora', { method: 'GET' });
  assert.equal(home.status, 200);
  assert.equal(home.body.workspaces.length, 1, 'normal 没有自己的工作区，只看到分享进来的');
  const w = home.body.workspaces[0];
  assert.deepEqual([w.id, w.partial, w.owner_id], ['ws_a', true, 'usr_alice']);
  assert.ok(w.owner_name || w.owner_email, '卡片上要能写「来自 X」');
  const tb = w.bases.flatMap((b) => b.tables);
  assert.deepEqual(tb.map((x) => [x.id, x.role, x.scope]), [['tbl_2', 'editor', 'grid']]);

  // 绕过 updateUser 直接改库（比如用 scripts/user.mjs）：getHome 负责补建
  t.DB.raw.prepare("UPDATE users SET role = 'plus' WHERE id = 'usr_nora'").run();
  resetUserCache();
  const again = await t.call(getHome, 'usr_nora', { method: 'GET' });
  const own = again.body.workspaces.filter((x) => x.owner_id === 'usr_nora');
  assert.equal(own.length, 1);
  assert.equal(own[0].role, 'owner');
  assert.equal((await t.call(getHome, 'usr_nora', { method: 'GET' })).body.workspaces.length, 2, '不会重复建');
});

// ── 管理员监控 / 公开链接 ─────────────────────────────────────────────────

/** pat(pro) 自己的工作区 ws_p：内容 bas_p、表 tbl_p */
function withPat(t) {
  const now = Date.now();
  const q = (sql, ...a) => t.DB.raw.prepare(sql).run(...a);
  q("INSERT INTO workspaces (id, name, owner_id, created_at, updated_at) VALUES ('ws_p','P','usr_pat',?,?)", now, now);
  q("INSERT INTO workspace_members (workspace_id, user_id, role, created_at) VALUES ('ws_p','usr_pat','owner',?)", now);
  q("INSERT INTO bases (id, workspace_id, name, ordinal, created_at, updated_at) VALUES ('bas_p','ws_p','bp','a0',?,?)", now, now);
  q("INSERT INTO tables (id, workspace_id, base_id, name, ordinal, created_by, created_at, updated_at) VALUES ('tbl_p','ws_p','bas_p','tp','a0','usr_pat',?,?)", now, now);
  return t;
}

await test('admin 监控：主页附带别人的全部工作区（只读），能看不能改；别人看不到', async () => {
  const t = withPat(setup());
  const home = await t.call(getHome, 'usr_alice', { method: 'GET' });
  assert.deepEqual(home.body.workspaces.map((w) => w.id), ['ws_a']);
  const mon = home.body.monitor;
  assert.deepEqual(mon.map((w) => [w.id, w.monitor, w.role]), [['ws_p', true, 'viewer']]);
  assert.deepEqual(mon[0].bases[0].tables.map((x) => [x.id, x.role, x.via]), [['tbl_p', 'viewer', 'admin']]);

  assert.equal(await t.roleOn('usr_alice', 'tbl_p'), 'viewer');
  const edit = await requireTableRole(t.env, t.user('usr_alice'), 'tbl_p', 'editor');
  assert.equal('response' in edit && edit.response.status, 403);
  const w = await t.call(ws.getWorkspace, 'usr_alice', { params: { id: 'ws_p' }, method: 'GET' });
  assert.equal(w.status, 200);
  assert.deepEqual(w.body.tables.map((x) => x.id), ['tbl_p']);
  // 不能借监控身份改名 / 分享
  assert.equal((await t.share('table', 'usr_alice', 'tbl_p', 'nora@x.com', 'viewer')).status, 403);

  assert.equal((await t.call(getHome, 'usr_pat', { method: 'GET' })).body.monitor, undefined);
  assert.equal(await t.roleOn('usr_pete', 'tbl_p'), 404);
  assert.equal((await t.call(ws.getWorkspace, 'usr_pete', { params: { id: 'ws_p' }, method: 'GET' })).status, 404);
});

await test('公开链接：只有 admin / pro 能开，manager 能关；令牌拉数据、关掉后 404；页面发资源 Cookie', async () => {
  const t = withPat(setup());
  const pub = await import('../worker/routes/public.js');
  const P = { params: { id: 'tbl_p' } };

  // pete(plus) 是 tbl_p 的管理者：能看到、能关，但开不了
  await t.share('table', 'usr_pat', 'tbl_p', 'pete@x.com', 'manager');
  await t.share('table', 'usr_pat', 'tbl_p', 'nora@x.com', 'viewer');
  const petes = await t.call(pub.getPublicLink, 'usr_pete', { ...P, method: 'GET' });
  assert.deepEqual([petes.body.link, petes.body.canCreate, petes.body.canRevoke], [null, false, true]);
  assert.equal((await t.call(pub.createPublicLink, 'usr_pete', P)).status, 403);
  assert.equal((await t.call(pub.createPublicLink, 'usr_nora', P)).status, 403);
  // 监控中的 admin 不是这张表的管理者：不能开
  assert.equal((await t.call(pub.createPublicLink, 'usr_alice', P)).status, 403);

  const made = await t.call(pub.createPublicLink, 'usr_pat', P);
  assert.equal(made.status, 200);
  const link = new URL(made.body.link.url);
  assert.equal(link.pathname, '/t/tbl_p');
  const token = link.searchParams.get('view');
  assert.match(token, pub.TOKEN_RE);
  // 再开一次：还是同一个链接
  assert.equal((await t.call(pub.createPublicLink, 'usr_pat', P)).body.link.url, made.body.link.url);
  assert.equal((await t.call(pub.getPublicLink, 'usr_nora', { ...P, method: 'GET' })).body.canRevoke, false);

  // 未登录：元信息 / 数据 / seq；写方法一律 404；坏令牌 404
  const api = (path, method = 'GET') => worker.fetch(new Request('https://table.example.com' + path,
    { method, headers: path.startsWith('/t/') ? { 'sec-fetch-dest': 'document' } : {} }), t.env, t.ctx);
  const meta = await api('/api/public/' + token);
  assert.equal(meta.status, 200);
  assert.deepEqual((await meta.json()).table.id, 'tbl_p');
  assert.equal((await api('/api/public/' + token + '/data')).status, 200);
  assert.equal((await api('/api/public/' + token + '/data', 'POST')).status, 404);
  assert.equal((await api('/api/public/' + 'x'.repeat(43))).status, 404);

  // 打开公开页面：发 tbl_pub Cookie；凭它只能拿 js / css
  const page = await api('/t/tbl_p?view=' + token);
  assert.equal(page.status, 200);
  const cookie = (page.headers.get('set-cookie') ?? '').split(';')[0];
  assert.match(cookie, /^tbl_pub=tbl_p\.\d+\./);
  t.env.ASSETS = { fetch: async () => new Response('export {}', { headers: { 'content-type': 'text/javascript' } }) };
  const asset = (path, withCookie) => worker.fetch(new Request('https://table.example.com' + path,
    withCookie ? { headers: { cookie } } : {}), t.env, t.ctx);
  assert.equal((await asset('/js/main.js', true)).status, 200);
  assert.notEqual((await asset('/js/main.js', false)).status, 200);
  assert.notEqual((await asset('/api/home', true)).status, 200);
  // 令牌对不上表 id：不发 Cookie
  assert.equal((await api('/t/tbl_1?view=' + token)).headers.get('set-cookie'), null);

  // manager（plus）关掉：令牌立即失效
  assert.equal((await t.call(pub.revokePublicLink, 'usr_pete', { ...P, method: 'DELETE' })).status, 200);
  assert.equal((await api('/api/public/' + token)).status, 404);
  assert.equal((await api('/t/tbl_p?view=' + token)).headers.get('set-cookie'), null);
});

// ── 默认密码 ────────────────────────────────────────────────────────────────

const dkOf = async (pw, email) => bytesToB64url(await deriveLoginKey(pw, email));

await test('默认密码开户：直接可登录，但只能改密码；改完旧 Cookie 失效、新 Cookie 放行', async () => {
  const t = setup();
  const email = 'dan@x.com';
  const dk0 = await dkOf('Password@130', email);
  const r = await t.call(createUser, 'usr_alice', { body: { email, role: 'plus', dk: dk0 } });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(r.body.user.status, 'active');
  assert.equal(r.body.link, undefined, '默认密码开户不发链接');

  const login = await auth.login(new Request('https://table.example.com/api/auth/login', { method: 'POST', body: JSON.stringify({ email, dk: dk0 }) }), { env: t.env, url: t.url });
  assert.equal(login.status, 200);
  assert.equal((await login.json()).user.mustChange, true);
  const cookie = login.headers.get('set-cookie').split(';')[0];

  const get = (path, c = cookie, init = {}) => worker.fetch(new Request('https://table.example.com' + path, { ...init, headers: { cookie: c, ...(init.headers ?? {}) } }), t.env, t.ctx);
  assert.equal((await get('/api/me')).status, 200);
  const blocked = await get('/api/workspaces', cookie, { method: 'POST', body: '{"name":"x"}', headers: { 'content-type': 'application/json' } });
  assert.equal(blocked.status, 403);
  assert.equal((await blocked.json()).error.code, 'must_change_password');
  assert.equal((await get('/api/home')).status, 403);

  const dk1 = await dkOf('Dan-new-pass-1', email);
  const same = await get('/api/me/password', cookie, { method: 'POST', body: JSON.stringify({ oldDk: dk0, newDk: dk0 }), headers: { 'content-type': 'application/json' } });
  assert.equal(same.status, 400);
  const wrong = await get('/api/me/password', cookie, { method: 'POST', body: JSON.stringify({ oldDk: dk1, newDk: dk0 }), headers: { 'content-type': 'application/json' } });
  assert.equal(wrong.status, 401);
  const ok = await get('/api/me/password', cookie, { method: 'POST', body: JSON.stringify({ oldDk: dk0, newDk: dk1 }), headers: { 'content-type': 'application/json' } });
  assert.equal(ok.status, 200);
  const fresh = ok.headers.get('set-cookie').split(';')[0];

  assert.equal((await get('/api/me', cookie)).status, 401, '旧 Cookie 作废');
  const me = await get('/api/me', fresh);
  assert.equal(me.status, 200);
  assert.equal((await me.json()).user.mustChange, false);
  assert.equal((await get('/api/workspaces', fresh, { method: 'POST', body: '{"name":"x"}', headers: { 'content-type': 'application/json' } })).status, 201);

  const old = await auth.login(new Request('https://t/api/auth/login', { method: 'POST', body: JSON.stringify({ email, dk: dk0 }) }), { env: t.env, url: t.url });
  assert.equal(old.status, 401, '默认密码不能再用');
});

await test('重置为默认密码：清掉验证器、踢下线、再次强制改密；停用的账号不能这样重置', async () => {
  const t = setup();
  t.DB.raw.prepare("UPDATE users SET totp_secret = 'x' WHERE id = 'usr_pete'").run();
  const dk0 = await dkOf('Password@130', 'pete@x.com');
  const r = await t.call(resetUser, 'usr_alice', { params: { id: 'usr_pete' }, body: { dk: dk0 } });
  assert.equal(r.status, 200);
  assert.deepEqual(t.row("SELECT status, must_change_pw, totp_secret, session_epoch FROM users WHERE id = 'usr_pete'"),
    { status: 'active', must_change_pw: 1, totp_secret: null, session_epoch: 2 });
  t.DB.raw.prepare("UPDATE users SET status = 'disabled' WHERE id = 'usr_nora'").run();
  assert.equal((await t.call(resetUser, 'usr_alice', { params: { id: 'usr_nora' }, body: { dk: dk0 } })).status, 400);
  assert.equal((await t.call(resetUser, 'usr_alice', { params: { id: 'usr_pete' }, body: { dk: 'bad' } })).status, 400);
});

await test('全站开了动态码时不能用默认密码开户（对方没有验证器会进不来）', async () => {
  const t = setup();
  t.DB.raw.prepare("INSERT INTO app_settings (key, value, updated_at) VALUES ('totp_required', '1', 0)").run();
  const r = await t.call(createUser, 'usr_alice', { body: { email: 'e@x.com', dk: await dkOf('Password@130', 'e@x.com') } });
  assert.equal(r.status, 400);
  assert.match(r.body.error.message, /动态码/);
});

await test('开通链接走完会清掉 mustChange；普通用户改密码限流', async () => {
  const t = setup();
  t.DB.raw.prepare("UPDATE users SET must_change_pw = 1 WHERE id = 'usr_pete'").run();
  const res = await t.call(resetUser, 'usr_alice', { params: { id: 'usr_pete' } });
  const token = res.body.link.split('/enroll/')[1];
  const dk = await dkOf('Pete-pass-123', 'pete@x.com');
  const done = await auth.enrollComplete(new Request('https://t/x', { method: 'POST', body: JSON.stringify({ token, dk }) }), { env: t.env, url: t.url });
  assert.equal(done.status, 200);
  assert.equal(t.row("SELECT must_change_pw FROM users WHERE id = 'usr_pete'").must_change_pw, 0);

  let last = 0;
  for (let k = 0; k < 8; k++) last = (await t.call(changePassword, 'usr_pete', { body: { oldDk: dk, newDk: dk } })).status;
  assert.equal(last, 429);
});

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
