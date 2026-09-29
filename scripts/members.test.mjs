/**
 * 用户管理（管理员）与工作区共享（成员）。
 *
 * D1 用 node:sqlite + 真实迁移文件顶上：权限判断全在 SQL 里（JOIN、COALESCE、
 * 子查询），换成按 SQL 片段分发的假库就测不出东西了。
 *
 * 覆盖：只有管理员能开户、开户链接能走完开通 → 登录、重复邮箱、不能对自己下手、
 * 停用 / 重置会踢掉实时连接、owner 才能增删成员、被移除的人再也拿不到表。
 */

import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { installWorkerGlobals } from './do-stub.mjs';

installWorkerGlobals();
const { DatabaseSync } = await import('node:sqlite');
const { listUsers, createUser, resetUser, updateUser } = await import('../worker/routes/admin.js');
const { listMembers, putMember, removeMember } = await import('../worker/routes/workspaces.js');
const { requireTableRole, resetUserCache } = await import('../worker/middleware/rbac.js');
const { resetRateLimit } = await import('../worker/middleware/ratelimit.js');
const auth = await import('../worker/routes/auth.js');
const { deriveLoginKey } = await import('../public/shared/util/kdf.js');
const { bytesToB64url } = await import('../public/shared/util/b64.js');

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const MIGRATIONS = readdirSync(join(ROOT, 'migrations')).filter((f) => f.endsWith('.sql')).sort()
  .map((f) => readFileSync(join(ROOT, 'migrations', f), 'utf8'));

/** D1 的最小替身：prepare/bind/first/all/run + 事务化的 batch。 */
function d1() {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  for (const m of MIGRATIONS) db.exec(m);
  const stmt = (sql) => {
    let args = [];
    const s = {
      bind: (...a) => { args = a.map((v) => (typeof v === 'boolean' ? Number(v) : v)); return s; },
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
          assert.equal(u, 'https://do/revoke');
          revoked.push([init.headers['x-user-id'], id]);
          return new Response('{"closed":1}');
        },
      }),
    },
  };
  const ctx = { waitUntil: (p) => waits.push(p) };
  const now = Date.now();
  const q = (sql, ...a) => DB.raw.prepare(sql).run(...a);
  // 管理员 alice，拥有工作区 ws_a（里面两张表）；普通成员 bob，有自己的 ws_b
  q("INSERT INTO users (id, email, name, role, created_at, last_seen_at, status, session_epoch, pw_hash) VALUES ('usr_alice','alice@x.com','Alice','admin',?,?,'active',1,'h')", now, now);
  q("INSERT INTO users (id, email, name, role, created_at, last_seen_at, status, session_epoch, pw_hash) VALUES ('usr_bob','bob@x.com','Bob','plus',?,?,'active',1,'h')", now + 1, now);
  for (const [ws, owner] of [['ws_a', 'usr_alice'], ['ws_b', 'usr_bob']]) {
    q('INSERT INTO workspaces (id, name, owner_id, created_at, updated_at) VALUES (?,?,?,?,?)', ws, ws, owner, now, now);
    q("INSERT INTO workspace_members (workspace_id, user_id, role, created_at) VALUES (?,?,'owner',?)", ws, owner, now);
    q("INSERT INTO bases (id, workspace_id, name, ordinal, created_at, updated_at) VALUES (?,?,'b','a0',?,?)", 'bas_' + ws, ws, now, now);
  }
  for (const t of ['tbl_1', 'tbl_2']) {
    q("INSERT INTO tables (id, workspace_id, base_id, name, ordinal, created_by, created_at, updated_at) VALUES (?, 'ws_a', 'bas_ws_a', ?, 'a0', 'usr_alice', ?, ?)", t, t, now, now);
  }
  const user = (id) => {
    const r = DB.raw.prepare('SELECT id, email, name, role, status, session_epoch FROM users WHERE id = ?').get(id);
    return { id: r.id, email: r.email, name: r.name, role: r.role, status: r.status, sessionEpoch: r.session_epoch };
  };
  const url = new URL('https://table.example.com/api/x');
  /** 调一个 handler。 */
  const call = async (fn, who, { params = {}, body, method = 'POST' } = {}) => {
    const request = new Request(url, body === undefined ? { method } : { method, body: JSON.stringify(body), headers: { 'content-type': 'application/json' } });
    const res = await fn(request, { env, ctx, url, params, user: user(who), identity: { via: 'password' } });
    await Promise.all(waits.splice(0));
    return { status: res.status, body: await res.json() };
  };
  return { DB, env, ctx, revoked, call, user, url, row: (sql, ...a) => ({ ...DB.raw.prepare(sql).get(...a) }) };
}

let failures = 0;
async function test(name, fn) {
  resetUserCache(); resetRateLimit();
  try { await fn(); console.log('  ok   ' + name); }
  catch (err) { failures++; console.error('  FAIL ' + name + '\n       ' + (err.stack ?? err.message)); }
}

// ── 用户管理 ────────────────────────────────────────────────────────────────

await test('普通成员调不了用户管理接口', async () => {
  const t = setup();
  assert.equal((await t.call(listUsers, 'usr_bob', { method: 'GET' })).status, 403);
  assert.equal((await t.call(createUser, 'usr_bob', { body: { email: 'c@x.com' } })).status, 403);
  assert.equal((await t.call(resetUser, 'usr_bob', { params: { id: 'usr_alice' } })).status, 403);
  assert.equal((await t.call(updateUser, 'usr_bob', { params: { id: 'usr_alice' }, body: { status: 'disabled' } })).status, 403);
});

await test('开户：待开通、自带工作区、同时加入共享工作区，链接能走完开通并登录', async () => {
  const t = setup();
  const res = await t.call(createUser, 'usr_alice', {
    body: { email: ' Carol@X.com ', name: '卡罗尔', shareWorkspaceId: 'ws_a', shareRole: 'viewer' },
  });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  const { user, link } = res.body;
  assert.equal(user.email, 'carol@x.com');
  assert.equal(user.status, 'pending');
  assert.match(link, /^https:\/\/table\.example\.com\/enroll\/[A-Za-z0-9_-]{43}$/);

  const own = t.row("SELECT w.name FROM workspaces w JOIN workspace_members m ON m.workspace_id = w.id WHERE m.user_id = ? AND m.role = 'owner'", user.id);
  assert.equal(own.name, '卡罗尔 的工作区');
  assert.equal(t.row("SELECT role FROM workspace_members WHERE workspace_id = 'ws_a' AND user_id = ?", user.id).role, 'viewer');

  // 开通：用的是登录页那条公开接口，证明管理员签的令牌格式与 CLI 一致
  const token = link.split('/enroll/')[1];
  const begin = await auth.enrollBegin(new Request('https://t/api/auth/enroll/begin', { method: 'POST', body: JSON.stringify({ token }) }), { env: t.env });
  assert.equal(begin.status, 200);
  assert.equal((await begin.json()).email, 'carol@x.com');
  const dk = bytesToB64url(await deriveLoginKey('Carol-pass-123', 'carol@x.com'));
  const done = await auth.enrollComplete(new Request('https://t/api/auth/enroll/complete', { method: 'POST', body: JSON.stringify({ token, dk }) }), { env: t.env, url: t.url });
  assert.equal(done.status, 200);
  assert.equal(t.row('SELECT status FROM users WHERE id = ?', user.id).status, 'active');
  const login = await auth.login(new Request('https://t/api/auth/login', { method: 'POST', body: JSON.stringify({ email: 'carol@x.com', dk }) }), { env: t.env, url: t.url });
  assert.equal(login.status, 200);

  // 共享进来的表是只读
  const gate = await requireTableRole(t.env, t.user(user.id), 'tbl_1', 'viewer');
  assert.equal(gate.role, 'viewer');
});

await test('重复邮箱 409；非法邮箱 400；分享到自己不是 owner 的工作区被拒', async () => {
  const t = setup();
  assert.equal((await t.call(createUser, 'usr_alice', { body: { email: 'BOB@x.com' } })).status, 409);
  assert.equal((await t.call(createUser, 'usr_alice', { body: { email: 'nope' } })).status, 400);
  assert.equal((await t.call(createUser, 'usr_alice', { body: { email: 'd@x.com', shareWorkspaceId: 'ws_b' } })).status, 403);   // 管理员能监控（只读）ws_b，但不是 owner
  assert.equal(t.row("SELECT COUNT(*) AS n FROM users WHERE email = 'd@x.com'").n, 0, '失败时不能留半个账号');
});

await test('管理员不能停用、降级、重置自己', async () => {
  const t = setup();
  assert.equal((await t.call(updateUser, 'usr_alice', { params: { id: 'usr_alice' }, body: { status: 'disabled' } })).status, 403);
  assert.equal((await t.call(updateUser, 'usr_alice', { params: { id: 'usr_alice' }, body: { role: 'plus' } })).status, 403);
  assert.equal((await t.call(resetUser, 'usr_alice', { params: { id: 'usr_alice' } })).status, 403);
  assert.equal(t.row("SELECT role, status FROM users WHERE id = 'usr_alice'").status, 'active');
});

await test('停用：会话代次 +1、实时连接被踢；恢复后因为有密码回到 active', async () => {
  const t = setup();
  t.DB.raw.prepare("INSERT INTO workspace_members (workspace_id, user_id, role, created_at) VALUES ('ws_a','usr_bob','editor',0)").run();
  const r = await t.call(updateUser, 'usr_alice', { params: { id: 'usr_bob' }, body: { status: 'disabled' } });
  assert.equal(r.status, 200);
  assert.deepEqual(t.row("SELECT status, session_epoch FROM users WHERE id = 'usr_bob'"), { status: 'disabled', session_epoch: 2 });
  assert.deepEqual(t.revoked.map((x) => x[1]).sort(), ['tbl_1', 'tbl_2']);
  assert.ok(t.revoked.every((x) => x[0] === 'usr_bob'));
  const back = await t.call(updateUser, 'usr_alice', { params: { id: 'usr_bob' }, body: { status: 'active' } });
  assert.equal(back.body.user.status, 'active');
  assert.equal((await t.call(updateUser, 'usr_alice', { params: { id: 'usr_bob' }, body: { status: 'gone' } })).status, 400);
  assert.equal((await t.call(updateUser, 'usr_alice', { params: { id: 'usr_bob' }, body: {} })).status, 400);
});

await test('重置：清掉密码与验证器、旧链接作废、新链接可用', async () => {
  const t = setup();
  const a = await t.call(resetUser, 'usr_alice', { params: { id: 'usr_bob' } });
  const b = await t.call(resetUser, 'usr_alice', { params: { id: 'usr_bob' } });
  assert.equal(b.status, 200);
  const u = t.row("SELECT status, pw_hash, session_epoch FROM users WHERE id = 'usr_bob'");
  assert.deepEqual(u, { status: 'pending', pw_hash: null, session_epoch: 3 });
  assert.equal(t.row("SELECT COUNT(*) AS n FROM user_invites WHERE user_id = 'usr_bob' AND used_at IS NULL").n, 1);
  const begin = (token) => auth.enrollBegin(new Request('https://t/x', { method: 'POST', body: JSON.stringify({ token }) }), { env: t.env });
  assert.equal((await begin(a.body.link.split('/enroll/')[1])).status, 404, '第一条链接应已作废');
  assert.equal((await begin(b.body.link.split('/enroll/')[1])).status, 200);
});

await test('列表：带上每个人的状态与「是不是我」', async () => {
  const t = setup();
  await t.call(createUser, 'usr_alice', { body: { email: 'e@x.com' } });
  const r = await t.call(listUsers, 'usr_alice', { method: 'GET' });
  assert.equal(r.status, 200);
  const byEmail = Object.fromEntries(r.body.users.map((u) => [u.email, u]));
  assert.equal(byEmail['alice@x.com'].me, true);
  assert.equal(byEmail['e@x.com'].status, 'pending');
  assert.equal(byEmail['e@x.com'].pendingInvite, true);
  assert.equal(byEmail['e@x.com'].hasPassword, false);
});

// ── 工作区成员 ──────────────────────────────────────────────────────────────

await test('owner 按邮箱拉人进工作区，对方立刻能看到表', async () => {
  const t = setup();
  const r = await t.call(putMember, 'usr_alice', { params: { id: 'ws_a' }, body: { email: 'BOB@x.com', role: 'editor' }, method: 'PUT' });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const gate = await requireTableRole(t.env, t.user('usr_bob'), 'tbl_2', 'editor');
  assert.equal(gate.role, 'editor');
  const list = await t.call(listMembers, 'usr_bob', { params: { id: 'ws_a' }, method: 'GET' });
  assert.deepEqual(list.body.members.map((m) => [m.email, m.role]), [['alice@x.com', 'owner'], ['bob@x.com', 'editor']]);
  assert.equal(list.body.myRole, 'editor');
});

await test('只有 owner 能管成员；不存在的邮箱、非法角色、改 owner 都被拒', async () => {
  const t = setup();
  await t.call(putMember, 'usr_alice', { params: { id: 'ws_a' }, body: { email: 'bob@x.com', role: 'editor' }, method: 'PUT' });
  assert.equal((await t.call(putMember, 'usr_bob', { params: { id: 'ws_a' }, body: { email: 'bob@x.com', role: 'editor' }, method: 'PUT' })).status, 403);
  assert.equal((await t.call(removeMember, 'usr_bob', { params: { id: 'ws_a', userId: 'usr_alice' }, method: 'DELETE' })).status, 403);
  assert.equal((await t.call(putMember, 'usr_alice', { params: { id: 'ws_a' }, body: { email: 'ghost@x.com', role: 'editor' }, method: 'PUT' })).status, 404);
  assert.equal((await t.call(putMember, 'usr_alice', { params: { id: 'ws_a' }, body: { email: 'bob@x.com', role: 'owner' }, method: 'PUT' })).status, 400);
  assert.equal((await t.call(putMember, 'usr_alice', { params: { id: 'ws_a' }, body: { email: 'alice@x.com', role: 'viewer' }, method: 'PUT' })).status, 400);
  assert.equal((await t.call(removeMember, 'usr_alice', { params: { id: 'ws_a', userId: 'usr_alice' }, method: 'DELETE' })).status, 400);
  // 不是成员的人连成员列表都看不到（当作不存在）；管理员监控例外，只读
  assert.equal((await t.call(listMembers, 'usr_bob', { params: { id: 'ws_b' }, method: 'GET' })).status, 200);
  assert.equal((await t.call(listMembers, 'usr_alice', { params: { id: 'ws_b' }, method: 'GET' })).status, 200);
  assert.equal((await t.call(putMember, 'usr_alice', { params: { id: 'ws_b' }, body: { email: 'bob@x.com', role: 'viewer' }, method: 'PUT' })).status, 403);
  await t.call(putMember, 'usr_alice', { params: { id: 'ws_a' }, body: { email: 'bob@x.com', role: 'viewer' }, method: 'PUT' });
  assert.equal((await t.call(listMembers, 'usr_bob', { params: { id: 'ws_a' }, method: 'GET' })).status, 200);
});

await test('降成只读会让他开着的表按新角色重连；移除后拿不到表、表级授权一并收回', async () => {
  const t = setup();
  await t.call(putMember, 'usr_alice', { params: { id: 'ws_a' }, body: { email: 'bob@x.com', role: 'editor' }, method: 'PUT' });
  assert.equal(t.revoked.length, 0, '新加入不需要踢');
  const r = await t.call(putMember, 'usr_alice', { params: { id: 'ws_a' }, body: { email: 'bob@x.com', role: 'viewer' }, method: 'PUT' });
  assert.equal(r.status, 200);
  assert.equal(t.revoked.length, 2);

  t.DB.raw.prepare("INSERT INTO table_acl (table_id, user_id, role, created_at) VALUES ('tbl_1','usr_bob','editor',0)").run();
  const del = await t.call(removeMember, 'usr_alice', { params: { id: 'ws_a', userId: 'usr_bob' }, method: 'DELETE' });
  assert.equal(del.status, 200);
  assert.equal(t.revoked.length, 4);
  for (const tbl of ['tbl_1', 'tbl_2']) {
    const gate = await requireTableRole(t.env, t.user('usr_bob'), tbl, 'viewer');
    assert.ok('response' in gate && gate.response.status === 404, tbl + ' 应该拿不到了');
  }
});

await test('成员可以自己退出；停用的账号拉不进来', async () => {
  const t = setup();
  await t.call(putMember, 'usr_alice', { params: { id: 'ws_a' }, body: { email: 'bob@x.com', role: 'viewer' }, method: 'PUT' });
  assert.equal((await t.call(removeMember, 'usr_bob', { params: { id: 'ws_a', userId: 'usr_bob' }, method: 'DELETE' })).status, 200);
  t.DB.raw.prepare("UPDATE users SET status = 'disabled' WHERE id = 'usr_bob'").run();
  assert.equal((await t.call(putMember, 'usr_alice', { params: { id: 'ws_a' }, body: { email: 'bob@x.com', role: 'viewer' }, method: 'PUT' })).status, 400);
});

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
