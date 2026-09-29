/**
 * 跨表引用（=tbl_xxx!A1、IMPORTRANGE）。
 *
 * 两层：
 *   · 引擎：分词器认 tbl_x! 前缀、区域规范化、#LOADING → 取到后变成数值、本表编号按本表算
 *   · 端到端：真实的 refs.js 路由 + 真实的 TableDO（/range）+ node:sqlite 顶替 D1。
 *     覆盖「引用大于权限」：对 B 没有权限、但能看 A 的人读得到 A 登记过的区域，
 *     区域外 / 没登记 / 登记被删 → #REF!；A→B→C 链式取值；循环 #CIRC!；层数上限。
 */

import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { installWorkerGlobals, makeDO } from './do-stub.mjs';

installWorkerGlobals();
const { DatabaseSync } = await import('node:sqlite');
const { TableDO } = await import('../worker/do/TableDO.js');
const { registerRefs, readExt } = await import('../worker/routes/refs.js');
const { resetUserCache } = await import('../worker/middleware/rbac.js');
const { Engine } = await import('../public/shared/formula/evaluate.js');
const { parse } = await import('../public/shared/formula/parse.js');
const X = await import('../public/shared/formula/extref.js');
const { ERR, FErr } = await import('../public/shared/formula/values.js');

let failures = 0;
async function test(name, fn) {
  try { await fn(); console.log('  ok   ' + name); }
  catch (err) { failures++; console.error('  FAIL ' + name + '\n       ' + (err.stack ?? err.message)); }
}

// ── 引擎层 ──────────────────────────────────────────────────────────────────

/** 一张内存表 + 可控的外表取值。 */
function sheet(cells, { tableId = 'tbl_self1', ext } = {}) {
  const m = new Map(Object.entries(cells));
  const a1 = (r, c) => String.fromCharCode(65 + c) + (r + 1);
  return new Engine({
    raw: (r, c) => m.get(a1(r, c)) ?? '',
    rows: () => 20, cols: () => 10, tableId, ext,
  });
}

await test('分词器：tbl_x!A1 与 tbl_x!A1:B2 带 table 字段', () => {
  const a = parse('tbl_abcd1!A1');
  assert.equal(a.type, 'ref'); assert.equal(a.table, 'tbl_abcd1');
  const b = parse('SUM(tbl_abcd1!$B$2:B9)');
  assert.equal(b.args[0].type, 'range'); assert.equal(b.args[0].table, 'tbl_abcd1');
  assert.equal(parse('A1').table, undefined);
});

await test('区域规范化：$、小写、反写、整列整行、Sheet 前缀', () => {
  assert.equal(X.normRange('$c$10:a1'), 'A1:C10');
  assert.equal(X.normRange('b:a'), 'A:B');
  assert.equal(X.normRange('3:1'), '1:3');
  assert.equal(X.normRange('Sheet1!B2'), 'B2');
  assert.equal(X.normRange('A0'), null);
  assert.equal(X.normRange('hello'), null);
  assert.ok(X.covers(X.parseRange('A:C'), X.parseRange('B2:B9')));
  assert.ok(!X.covers(X.parseRange('A1:B5'), X.parseRange('B2:C3')));
  assert.ok(X.tooBig(X.parseRange('A1:Z5000')));
  assert.ok(X.tooBig(X.parseRange('A:ZZ')));
  assert.equal(X.tableIdFrom('https://table.example.com/t/tbl_ab12cd?x=1'), 'tbl_ab12cd');
});

await test('extRefsIn：收集引用，IMPORTRANGE 只认字面量', () => {
  const got = X.extRefsIn('SUM(tbl_bbbb1!B2:B9)+tbl_bbbb1!a1+IMPORTRANGE("tbl_cccc1","c1:a3")+IMPORTRANGE(A1,"A1")');
  assert.deepEqual(got.map((x) => x.table + '!' + x.range).sort(),
    ['tbl_bbbb1!A1', 'tbl_bbbb1!B2:B9', 'tbl_cccc1!A1:C3']);
});

await test('#LOADING → 取到之后作废缓存，变成数值', () => {
  const cache = new Map();
  const asked = [];
  const eng = sheet({ A1: '=SUM(tbl_bbbb1!A1:A3)*2', A2: '=IMPORTRANGE("tbl_bbbb1","B1")' }, {
    ext: (t, k) => { asked.push(t + '!' + k); return cache.get(t + '!' + k) ?? ERR.LOADING; },
  });
  assert.equal(eng.value(0, 0), ERR.LOADING);
  assert.equal(eng.value(1, 0), ERR.LOADING);
  assert.deepEqual([...new Set(asked)].sort(), ['tbl_bbbb1!A1:A3', 'tbl_bbbb1!B1']);
  cache.set('tbl_bbbb1!A1:A3', X.unpackRange({ r0: 0, c0: 0, rows: [[1], [2], ['x']] }));
  cache.set('tbl_bbbb1!B1', X.unpackRange({ r0: 0, c0: 1, rows: [['hi']] }));
  eng.invalidate();
  assert.equal(eng.value(0, 0), 6);          // 文本不参与求和
  assert.equal(eng.value(1, 0), 'hi');
});

await test('外表错误值原样透传；没有宿主 ext → #REF!；写本表编号按本表算', () => {
  const eng = sheet({ A1: '=tbl_bbbb1!A1', B1: '5', B2: '=tbl_self1!B1*3' }, {
    ext: () => X.unpackRange({ e: '#DIV/0!' }),
  });
  assert.ok(eng.value(0, 0) instanceof FErr);
  assert.equal(eng.value(0, 0).err, '#DIV/0!');
  assert.equal(eng.value(1, 1), 15);
  const bare = sheet({ A1: '=tbl_bbbb1!A1' });
  assert.equal(bare.value(0, 0), ERR.REF);
});

// ── 端到端 ──────────────────────────────────────────────────────────────────

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const MIGRATIONS = readdirSync(join(ROOT, 'migrations')).filter((f) => f.endsWith('.sql')).sort()
  .map((f) => readFileSync(join(ROOT, 'migrations', f), 'utf8'));

function d1() {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  for (const m of MIGRATIONS) db.exec(m);
  const stmt = (raw) => {
    let args = [];
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
      run: async () => ({ success: true, meta: { changes: Number(db.prepare(sql).run(...args).changes) } }),
    };
    return s;
  };
  return { raw: db, prepare: stmt };
}

const A = 'tbl_aaaa1', B = 'tbl_bbbb1', C = 'tbl_cccc1';

/**
 * alice(admin) 拥有 ws_a，里面三张表 A、B、C。nora(normal) 只被分享了 A 的查看权。
 * 每张表一个真实的 TableDO，格子直接写进 DO 的 SQLite。
 */
function setup() {
  resetUserCache();
  const DB = d1();
  const dos = new Map();
  const doOf = (id) => {
    if (!dos.has(id)) dos.set(id, makeDO(TableDO));
    return dos.get(id);
  };
  let doCalls = 0;
  const env = {
    DB,
    TABLE_DO: {
      idFromName: (n) => n,
      get: (id) => ({ fetch: async (u, init) => { doCalls++; return doOf(id).obj.fetch(new Request(u, init)); } }),
    },
  };
  const now = Date.now();
  const q = (sql, ...a) => DB.raw.prepare(sql).run(...a);
  let i = 0;
  for (const [id, role] of [['usr_alice', 'admin'], ['usr_nora', 'normal']]) {
    q("INSERT INTO users (id, email, name, role, created_at, last_seen_at, status, session_epoch, pw_hash) VALUES (?,?,?,?,?,?,'active',1,'h')",
      id, id.slice(4) + '@x.com', id.slice(4), role, now + i++, now);
  }
  q("INSERT INTO workspaces (id, name, owner_id, created_at, updated_at) VALUES ('ws_a','A','usr_alice',?,?)", now, now);
  q("INSERT INTO workspace_members (workspace_id, user_id, role, created_at) VALUES ('ws_a','usr_alice','owner',?)", now);
  q("INSERT INTO bases (id, workspace_id, name, ordinal, created_at, updated_at) VALUES ('bas_1','ws_a','b','a0',?,?)", now, now);
  for (const t of [A, B, C]) {
    q("INSERT INTO tables (id, workspace_id, base_id, name, ordinal, created_by, created_at, updated_at) VALUES (?, 'ws_a', 'bas_1', ?, 'a0', 'usr_alice', ?, ?)", t, t, now, now);
  }
  q("INSERT INTO table_acl (table_id, user_id, role, created_at) VALUES (?, 'usr_nora', 'viewer', ?)", A, now);

  const put = (id, cells) => {
    const h = doOf(id);
    for (const [a1, v] of Object.entries(cells)) {
      const g = X.parseRange(a1);
      h.obj.applyOps([{ t: 'setCells', cells: [[g.r0, g.c0, String(v)]] }], 'x');
    }
  };
  const user = (id) => {
    const r = DB.raw.prepare('SELECT id, email, name, role, status, session_epoch FROM users WHERE id = ?').get(id);
    return { id: r.id, email: r.email, name: r.name, role: r.role, status: r.status, sessionEpoch: r.session_epoch, mustChange: false };
  };
  const url = new URL('https://table.example.com/api/x');
  const call = async (fn, who, table, body) => {
    const request = new Request(url, { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } });
    const res = await fn(request, { env, url, params: { id: table }, user: user(who) });
    return { status: res.status, body: await res.json() };
  };
  const ext = async (who, from, items) => {
    const r = await call(readExt, who, from, { items: items.map(([src, range]) => ({ src, range })) });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    return r.body.results;
  };
  const reg = (who, from, refs) => call(registerRefs, who, from, { refs: refs.map(([to, range]) => ({ to, range })) });
  return { DB, put, call, ext, reg, doCalls: () => doCalls };
}

await test('只返回计算结果，不返回公式原文；区域裁到表格实际大小', async () => {
  const s = setup();
  s.put(B, { A1: '10', A2: '=A1*2', A3: 'text', B1: '=SUM(A1:A2)' });
  const [r] = await s.ext('usr_alice', A, [[B, 'A1:B3']]);
  assert.deepEqual(r, { r0: 0, c0: 0, rows: [[10, 30], [20, null], ['text', null]] });
  const [col] = await s.ext('usr_alice', A, [[B, 'A:A']]);
  assert.equal(col.rows.length > 3, true);            // 整列：裁到行数
  assert.deepEqual(col.rows.slice(0, 3), [[10], [20], ['text']]);
});

await test('引用大于权限：登记过的区域，对 B 无权限的人也读得到', async () => {
  const s = setup();
  s.put(B, { A1: '1', A2: '2', A3: '3', C1: 'secret' });
  // 未登记：nora 对 B 没有权限 → #REF!
  assert.deepEqual(await s.ext('usr_nora', A, [[B, 'A1:A3']]), [{ e: '#REF!' }]);
  // alice 在 A 上写了 =SUM(tbl_bbbb1!A:A) 并登记
  const r = await s.reg('usr_alice', A, [[B, 'a:a']]);
  assert.deepEqual(r.body.results, [{ to: B, range: 'A:A', ok: true }]);
  const [inside, sub, outside] = await s.ext('usr_nora', A, [[B, 'A1:A3'], [B, 'A2'], [B, 'C1']]);
  assert.deepEqual(inside.rows, [[1], [2], [3]]);
  assert.deepEqual(sub.rows, [[2]]);                    // 被 A:A 盖住的小区域也行
  assert.deepEqual(outside, { e: '#REF!' });            // 区域外看不到
  // 登记只对 A 生效：拿 C 当入口不行（nora 连 C 都看不了）
  assert.equal((await s.call(readExt, 'usr_nora', C, { items: [{ src: B, range: 'A1' }] })).status, 404);
});

await test('登记的门槛：对 A 要能编辑、对 B 要能查看；区域太大拒绝', async () => {
  const s = setup();
  assert.equal((await s.reg('usr_nora', A, [[B, 'A1']])).status, 403);   // nora 对 A 只是查看
  const r = await s.reg('usr_alice', A, [[B, 'A1:Z5000'], ['tbl_nope1', 'A1'], [A, 'A1'], ['bad', 'A1']]);
  const ok = r.body.results.map((x) => x.ok);
  assert.deepEqual(ok, [false, false, true, false]);
  assert.match(r.body.results[0].error, /太大/);
  assert.match(r.body.results[1].error, /不存在/);
  assert.equal(s.DB.raw.prepare('SELECT COUNT(*) AS n FROM table_refs').get().n, 0);   // 引用自己不入库
});

await test('被引用的表删掉之后，登记失效', async () => {
  const s = setup();
  s.put(B, { A1: '7' });
  await s.reg('usr_alice', A, [[B, 'A1']]);
  assert.deepEqual((await s.ext('usr_nora', A, [[B, 'A1']]))[0].rows, [[7]]);
  s.DB.raw.prepare('DELETE FROM tables WHERE id = ?').run(B);
  assert.deepEqual(await s.ext('usr_nora', A, [[B, 'A1']]), [{ e: '#REF!' }]);
});

await test('链式：A 引 B、B 又引 C，按 B→C 的登记取来再算', async () => {
  const s = setup();
  s.put(C, { A1: '100' });
  s.put(B, { A1: `=${C}!A1+1`, A2: `=IMPORTRANGE("${C}","A1")*2` });
  await s.reg('usr_alice', A, [[B, 'A1:A2']]);
  // B→C 还没登记：nora 读到的 B!A1 是 #REF!（B 自己拿不到 C）
  let [r] = await s.ext('usr_nora', A, [[B, 'A1:A2']]);
  assert.deepEqual(r.rows, [[{ e: '#REF!' }], [{ e: '#REF!' }]]);
  await s.reg('usr_alice', B, [[C, 'A1']]);
  [r] = await s.ext('usr_nora', A, [[B, 'A1:A2']]);
  assert.deepEqual(r.rows, [[101], [200]]);
});

await test('循环引用 → #CIRC!', async () => {
  const s = setup();
  s.put(B, { A1: `=${C}!A1` });
  s.put(C, { A1: `=${B}!A1` });
  await s.reg('usr_alice', A, [[B, 'A1']]);
  await s.reg('usr_alice', B, [[C, 'A1']]);
  await s.reg('usr_alice', C, [[B, 'A1']]);
  const [r] = await s.ext('usr_alice', A, [[B, 'A1']]);
  assert.deepEqual(r.rows, [[{ e: '#CIRC!' }]]);
});

await test(`层数上限：最多往下 ${X.MAX_EXT_DEPTH} 层`, async () => {
  const s = setup();
  const D = 'tbl_dddd1', E = 'tbl_eeee1';
  const now = Date.now();
  for (const t of [D, E]) {
    s.DB.raw.prepare("INSERT INTO tables (id, workspace_id, base_id, name, ordinal, created_by, created_at, updated_at) VALUES (?, 'ws_a', 'bas_1', ?, 'a0', 'usr_alice', ?, ?)").run(t, t, now, now);
  }
  // A 读 B（第 1 层）→ C（2）→ D（3）→ E（超限）
  s.put(E, { A1: '1' });
  s.put(D, { A1: `=${E}!A1` });
  s.put(C, { A1: `=${D}!A1` });
  s.put(B, { A1: `=${C}!A1` });
  for (const [f, t] of [[A, B], [B, C], [C, D], [D, E]]) await s.reg('usr_alice', f, [[t, 'A1']]);
  const [r] = await s.ext('usr_alice', A, [[B, 'A1']]);
  assert.deepEqual(r.rows, [[{ e: '#REF!' }]]);
  // 从 B 开始读就在限内
  const [ok] = await s.ext('usr_alice', B, [[C, 'A1']]);
  assert.deepEqual(ok.rows, [[1]]);
});

await test('请求校验：items 必须是数组且不超过 10 项；坏项给 #REF!', async () => {
  const s = setup();
  assert.equal((await s.call(readExt, 'usr_alice', A, { items: 'x' })).status, 400);
  assert.equal((await s.call(readExt, 'usr_alice', A, { items: Array(11).fill({ src: B, range: 'A1' }) })).status, 400);
  assert.deepEqual(await s.ext('usr_alice', A, [['bad', 'A1'], [B, 'A1:Z9999']]), [{ e: '#REF!' }, { e: '#REF!' }]);
});

if (failures) { console.error(`\n${failures} 个用例失败`); process.exit(1); }
console.log('\n跨表引用：全部通过');
