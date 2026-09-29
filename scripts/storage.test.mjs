/**
 * v5 存储结构：一行一条记录 + 行 / 列映射表 + 环形日志 + 写入量统计。
 *
 * 最要紧的是第一组：线上的表都是 v4，升级必须一个字都不丢；
 * 校验不过就整体回滚、保持只读，旧表原样留着。
 */

import assert from 'node:assert/strict';
import { installWorkerGlobals, makeDO, collect, tick } from './do-stub.mjs';

installWorkerGlobals();
const { TableDO, DAILY_WRITE_QUOTA } = await import('../worker/do/TableDO.js');
const { AxisMap } = await import('../worker/do/axismap.js');
const { DatabaseSync } = await import('node:sqlite');

let failures = 0;
async function test(name, fn) {
  try { await fn(); console.log('  ok   ' + name); }
  catch (err) { failures++; console.error('  FAIL ' + name + '\n       ' + (err.stack ?? err.message)); }
}

const quiet = async (fn) => {
  const e = console.error, w = console.warn;
  console.error = () => { }; console.warn = () => { };
  try { return await fn(); } finally { console.error = e; console.warn = w; }
};

/** 手工造一个 v4 的库（结构与 _migrateOld 建出来的一致），带数据 */
function v4db({ badFormat = false } = {}) {
  const db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT);
    CREATE TABLE used_nonce (nonce TEXT PRIMARY KEY, used_at INTEGER NOT NULL);
    CREATE TABLE cells (r INTEGER NOT NULL, c INTEGER NOT NULL, v TEXT NOT NULL, PRIMARY KEY (r, c)) WITHOUT ROWID;
    CREATE TABLE fields (c INTEGER PRIMARY KEY, id TEXT NOT NULL, name TEXT NOT NULL, width INTEGER NOT NULL);
    CREATE TABLE row_meta (r INTEGER PRIMARY KEY, id TEXT NOT NULL, height INTEGER NOT NULL);
    CREATE TABLE oplog (seq INTEGER PRIMARY KEY AUTOINCREMENT, actor_id TEXT, op_json TEXT NOT NULL, ts INTEGER NOT NULL);
    CREATE TABLE formats (r INTEGER NOT NULL, c INTEGER NOT NULL, f TEXT NOT NULL, PRIMARY KEY (r, c)) WITHOUT ROWID;
    CREATE TABLE files (id TEXT PRIMARY KEY, name TEXT NOT NULL, type TEXT NOT NULL, size INTEGER NOT NULL, chunks INTEGER NOT NULL, created_by TEXT, created_at INTEGER NOT NULL);
    CREATE TABLE file_chunks (id TEXT NOT NULL, idx INTEGER NOT NULL, data BLOB NOT NULL, PRIMARY KEY (id, idx));
  `);
  const q = (s, ...a) => db.prepare(s).run(...a);
  for (const [k, v] of [['schema_version', '4'], ['row_count', '1500'], ['col_count', '30'], ['structural_seq', '7'], ['prop:merges', '[[0,0,1,1]]']]) q('INSERT INTO meta VALUES (?, ?)', k, v);
  for (let r = 0; r < 1200; r += 3) for (let c = 0; c < 5; c++) q('INSERT INTO cells VALUES (?, ?, ?)', r, c, r % 7 === 0 && c === 4 ? '=A' + (r + 1) + '+1' : `v${r}_${c}é"\\`);
  q('INSERT INTO cells VALUES (?, ?, ?)', 1499, 29, '最后一格');
  for (let r = 0; r < 600; r += 11) q('INSERT INTO formats VALUES (?, ?, ?)', r, 1, JSON.stringify({ b: true, bg: '#ff0' }));
  q('INSERT INTO formats VALUES (?, ?, ?)', 2, 2, badFormat ? '{bad' : '{"i": true, "fs": 14}');   // 带空格：迁移后会被规范化
  q('INSERT INTO row_meta VALUES (?, ?, ?)', 5, 'row5', 40);
  q('INSERT INTO row_meta VALUES (?, ?, ?)', 1000, 'row1000', 60);
  q('INSERT INTO fields VALUES (?, ?, ?, ?)', 0, 'fld0', '姓名', 150);
  q('INSERT INTO fields VALUES (?, ?, ?, ?)', 3, 'fld3', '', 60);
  for (let i = 0; i < 42; i++) q('INSERT INTO oplog (actor_id, op_json, ts) VALUES (?, ?, ?)', 'u', '{"t":"addRows","n":0}', 0);
  return db;
}

/** 按 v4 的读法直接从旧表拼出快照，作为「升级前」的标准答案 */
function v4snapshot(db) {
  const all = (s) => db.prepare(s).all();
  return {
    fields: all('SELECT c, name, width FROM fields ORDER BY c').map((f) => ({ c: f.c, name: f.name, width: f.width })),
    rowHeights: all('SELECT r, height FROM row_meta ORDER BY r').map((x) => [x.r, x.height]),
    cells: all('SELECT r, c, v FROM cells ORDER BY r, c').map((x) => [x.r, x.c, x.v]),
    formats: all('SELECT r, c, f FROM formats ORDER BY r, c').map((x) => [x.r, x.c, JSON.parse(x.f)]),
  };
}

const pick = (s) => ({ fields: s.fields, rowHeights: s.rowHeights, cells: s.cells, formats: s.formats });
const tables = (db) => db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((x) => x.name);

console.log('── 升级 ──');

await test('v4 → v5：快照逐格一致，seq 接着往下编，旧表原样保留', async () => {
  const db = v4db();
  const before = v4snapshot(db);
  const h = makeDO(TableDO, {}, db);
  await h.ready;
  assert.equal(h.obj._legacy, false);
  const s = await h.state();
  assert.deepEqual(pick(s), before);
  assert.equal(s.rowCount, 1500);
  assert.equal(s.colCount, 30);
  assert.deepEqual(s.props.merges, [[0, 0, 1, 1]]);
  assert.equal(s.seq, 42, '升级后 seq 不能倒退');
  for (const t of ['cells', 'formats', 'row_meta', 'fields', 'oplog']) assert.ok(tables(db).includes(t), '旧表 ' + t + ' 要留着');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM cells').get().n, before.cells.length, '旧表内容不动');

  // 升级之后照常写，seq 继续
  const r = h.obj.applyOps([{ t: 'setCells', cells: [[0, 0, '新']] }], 'u1');
  assert.equal(r.seq, 43);
  assert.equal((await h.state()).cells[0][2], '新');
});

await test('升级后重启（同一个库重新构造）：数据还在，不会再迁移一次', async () => {
  const db = v4db();
  const before = v4snapshot(db);
  const h = makeDO(TableDO, {}, db);
  await h.ready;
  const again = makeDO(TableDO, {}, db);
  await again.ready;
  assert.equal(again.obj._wTotal, 0, '第二次启动不应再写任何东西');
  assert.deepEqual(pick(await again.state()), before);
});

await test('迁移校验不过（坏格式 JSON）：整体回滚，只读，旧表和旧数据原样', async () => {
  const db = v4db({ badFormat: true });
  const before = { cells: db.prepare('SELECT r FROM cells').all() };
  const h = await quiet(async () => { const x = makeDO(TableDO, {}, db); await x.ready; return x; });
  assert.equal(h.obj._legacy, true);
  assert.ok(!tables(db).includes('rows') && !tables(db).includes('ops_ring'), '新表应随事务回滚');
  assert.equal(db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get().value, '4');
  const txt = await h.obj.stateResponse().text();
  assert.ok(txt.includes('最后一格'), '只读期间照样能打开，内容来自旧表');
  const r = h.obj.applyOps([{ t: 'setCells', cells: [[0, 0, 'x']] }], 'u1');
  assert.equal(r.code, 'upgrading', '只读期间拒绝写入');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM cells').get().n, before.cells.length);
});

await test('今天额度不够：先不升级（只读），额度重置后 alarm 自动完成', async () => {
  const db = v4db();
  const before = v4snapshot(db);
  let used = DAILY_WRITE_QUOTA - 10;
  const reported = [];
  const env = {
    DB: {
      prepare: (sql) => ({
        bind: (...a) => ({
          first: async () => {
            if (sql.includes('RETURNING')) { reported.push(Number(a[1])); return { value: String(used += Number(a[1])) }; }
            return { value: String(used) };
          },
          run: async () => ({}),
        }),
      }),
    },
  };
  const h = await quiet(async () => { const x = makeDO(TableDO, env, db); await x.ready; return x; });
  assert.equal(h.obj._legacy, true);
  assert.ok(!tables(db).includes('rows'));
  used = 0;                                           // UTC 0 点重置
  await h.obj.alarm();
  assert.equal(h.obj._legacy, false);
  assert.deepEqual(pick(await h.state()), before);
  await h.obj.alarm();
  assert.ok(reported.length >= 1 && reported[0] > 0, '迁移写入要上报：' + reported);
});

// ── 写入量 ──

console.log('── 写入量 ──');

/** 新表，填 n 行 × cols 列 */
async function filled(n, cols = 3) {
  const h = makeDO(TableDO);
  await h.ready;
  const cells = [];
  for (let r = 0; r < n; r++) for (let c = 0; c < cols; c++) cells.push([r, c, `${r}:${c}`]);
  h.obj.applyOps([{ t: 'setRowCount', n: n + 10 }, { t: 'setCells', cells }], 'u1');
  return h;
}
const writes = (h, fn) => { const w0 = h.obj._wTotal; fn(); return h.obj._wTotal - w0; };

await test('粘贴 1000 行 × 20 列 ≈ 1000 行写入（以前是 2 万）', async () => {
  const h = makeDO(TableDO);
  await h.ready;
  const cells = [];
  for (let r = 0; r < 1000; r++) for (let c = 0; c < 20; c++) cells.push([r, c, 'x']);
  const w = writes(h, () => h.obj.applyOps([{ t: 'setCells', cells }], 'u1'));
  assert.ok(w >= 1000 && w < 1010, String(w));
});

await test('在最上面插入 / 删除行列：写入量与表大小无关', async () => {
  const h = await filled(1000);
  for (const op of [{ t: 'insertRows', at: 0, n: 3 }, { t: 'deleteRows', at: 0, n: 2 }, { t: 'insertCols', at: 0, n: 1 }, { t: 'deleteCols', at: 0, n: 1 }]) {
    const w = writes(h, () => h.obj.applyOps([op], 'u1'));
    assert.ok(w <= 6, op.t + ' 写了 ' + w + ' 行');
  }
  const s = await h.state();
  assert.equal(s.cells.length, 3000);
  assert.deepEqual(s.cells[0], [1, 0, '0:0'], '插 3 删 2 → 下移 1 行；插 1 列又删掉它 → 列不变');
});

await test('日志不再用 AUTOINCREMENT：单格修改 = 本行 1 + 日志 1', async () => {
  const h = await filled(10);
  const w = writes(h, () => h.obj.applyOps([{ t: 'setCells', cells: [[0, 0, 'y']] }], 'u1'));
  assert.equal(w, 2);
  assert.equal(h.ctx.db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name = 'sqlite_sequence'").get().n, 0);
});

// ── 行列映射 ──

console.log('── 行列映射 ──');

/** 同一串操作打在一个纯数组模型上，比对快照 */
function model(rows, cols) {
  const g = Array.from({ length: rows }, () => Array(cols).fill(''));
  return {
    g,
    set(r, c, v) { g[r][c] = v; },
    insR(at, n) { g.splice(at, 0, ...Array.from({ length: n }, () => Array(g[0].length).fill(''))); },
    delR(at, n) { g.splice(at, n); },
    insC(at, n) { for (const row of g) row.splice(at, 0, ...Array(n).fill('')); },
    delC(at, n) { for (const row of g) row.splice(at, n); },
    cells() { const out = []; g.forEach((row, r) => row.forEach((v, c) => { if (v !== '') out.push([r, c, v]); })); return out; },
  };
}

await test('随机插删行列 + 写格子：与数组模型一致，重启 / 压缩后仍一致', async () => {
  let seed = 7;
  const rnd = (n) => { seed = (Math.imul(seed, 1103515245) + 12345) & 0x7fffffff; return seed % n; };
  const h = makeDO(TableDO);
  await h.ready;
  const R = 60, C = 12;
  h.obj.applyOps([{ t: 'setRowCount', n: R }, { t: 'setColCount', n: C }], 'u');
  const m = model(R, C);
  for (let step = 0; step < 400; step++) {
    const k = rnd(10);
    if (k < 5) {
      const r = rnd(R), c = rnd(C), v = rnd(4) ? 's' + step : '';
      h.obj.applyOps([{ t: 'setCells', cells: [[r, c, v]] }], 'u'); m.set(r, c, v);
    } else {
      const row = k < 8, ins = rnd(2) === 0, at = rnd(row ? R - 3 : C - 3), n = 1 + rnd(3);
      const t = (ins ? 'insert' : 'delete') + (row ? 'Rows' : 'Cols');
      h.obj.applyOps([{ t, at, n }], 'u');
      // 行列总数保持不变，方便对齐：插完再从尾部删掉 / 删完再在尾部补上
      if (row) { ins ? m.insR(at, n) : m.delR(at, n); h.obj.applyOps([{ t: ins ? 'deleteRows' : 'insertRows', at: R, n }].map((o) => ins ? { ...o, at: R } : { ...o, at: R - n }), 'u'); ins ? m.delR(R, n) : m.insR(R - n, n); }
      else { ins ? m.insC(at, n) : m.delC(at, n); h.obj.applyOps([ins ? { t: 'deleteCols', at: C, n } : { t: 'insertCols', at: C - n, n }], 'u'); ins ? m.delC(C, n) : m.insC(C - n, n); }
    }
  }
  const want = m.cells();
  assert.deepEqual((await h.state()).cells, want);
  assert.ok(h.obj.cellCount() >= want.length, '删列后计数只是上界');
  h.obj._cellCount = null;
  assert.equal(h.obj.cellCount(), want.length, '重新数一遍也对（已删列的残留不算）');
  const again = makeDO(TableDO, {}, h.ctx.db);
  await again.ready;
  assert.deepEqual((await again.state()).cells, want, '重启后一致');
  again.obj._compact('row');
  again.obj._compact('col');
  assert.ok(again.obj.rows.isIdentity() && again.obj.cols.isIdentity());
  assert.deepEqual((await again.state()).cells, want, '压缩后一致');
  const third = makeDO(TableDO, {}, h.ctx.db);
  await third.ready;
  assert.deepEqual((await third.state()).cells, want, '压缩后重启一致');
});

await test('插入行时公式引用跟着改；列宽 / 行高 / 格式跟着行列走', async () => {
  const h = makeDO(TableDO);
  await h.ready;
  h.obj.applyOps([
    { t: 'setCells', cells: [[0, 0, '=B2+1'], [1, 1, '5']] },
    { t: 'setFormats', cells: [[1, 1, { b: true }]] },
    { t: 'resizeField', c: 1, w: 200 },
    { t: 'setRowHeight', r: 1, h: 50 },
  ], 'u');
  h.obj.applyOps([{ t: 'insertRows', at: 1, n: 2 }, { t: 'insertCols', at: 0, n: 1 }], 'u');
  const s = await h.state();
  assert.deepEqual(s.cells, [[0, 1, '=C4+1'], [3, 2, '5']]);
  assert.deepEqual(s.formats, [[3, 2, { b: true }]]);
  assert.deepEqual(s.fields.map((f) => [f.c, f.width]), [[2, 200]]);
  assert.deepEqual(s.rowHeights, [[3, 50]]);
  h.obj.applyOps([{ t: 'deleteCols', at: 2, n: 1 }], 'u');
  const s2 = await h.state();
  assert.deepEqual(s2.cells, [[0, 1, '=#REF!+1']]);
  assert.deepEqual(s2.fields, []);
  assert.deepEqual(s2.formats, []);
});

await test('AxisMap：随机插删与数组模型一致，序列化往返不变', () => {
  let seed = 3;
  const rnd = (n) => { seed = (Math.imul(seed, 1103515245) + 12345) & 0x7fffffff; return seed % n; };
  let map = new AxisMap();
  const arr = Array.from({ length: 2000 }, (_, i) => i);
  let fresh = -1;
  for (let step = 0; step < 2000; step++) {
    const at = rnd(150), n = 1 + rnd(5);
    if (rnd(2)) {
      const [a, b] = map.insert(at, n);
      assert.equal(b - a + 1, n);
      assert.ok(b <= fresh);
      fresh = a - 1;
      arr.splice(at, 0, ...Array.from({ length: n }, (_, i) => a + i));
    } else {
      const gone = map.delete(at, n).flatMap(([a, b]) => Array.from({ length: b - a + 1 }, (_, i) => a + i));
      assert.deepEqual(gone, arr.splice(at, n));
    }
    if (step % 97 === 0) map = new AxisMap(JSON.parse(JSON.stringify(map)));
  }
  arr.slice(0, 400).forEach((k, i) => { assert.equal(map.keyAt(i), k); assert.equal(map.indexOf(k), i); });
  const flat = map.ranges(0, 400).flatMap(([a, b, i0]) => Array.from({ length: b - a + 1 }, (_, i) => { assert.equal(map.keyAt(i0 + i), a + i); return a + i; }));
  assert.deepEqual(flat, arr.slice(0, 400));
});

// ── 日志环 ──

console.log('── 日志环 ──');

async function hello(h, lastSeq) {
  const ws = (await h.connect({ uid: 'u9' })).webSocket;
  const got = collect(ws);
  await tick();
  got.length = 0;
  ws.send(JSON.stringify({ t: 'hello', lastSeq }));
  await tick(); await tick();
  return got;
}

await test('日志环绕回之后，补增量照样连续；超出保留范围就让重拉', async () => {
  const h = makeDO(TableDO);
  await h.ready;
  for (let i = 0; i < 3010; i++) h.obj.applyOps([{ t: 'setCells', cells: [[i % 50, 0, 'v' + i]] }], 'u');
  assert.equal(h.ctx.db.prepare('SELECT COUNT(*) AS n FROM ops_ring').get().n, 3000, '环的大小固定');
  const got = await hello(h, 2990);
  const ops = got.find((m) => m.t === 'ops');
  assert.equal(ops.ops.length, 20);
  assert.deepEqual(ops.ops.at(-1).cells, [[3009 % 50, 0, 'v3009']]);
  assert.equal(got.at(-1).t, 'synced');
  assert.equal((await hello(h, 5))[0].t, 'resync', '已被覆盖的一段');
});

await test('按体积裁日志：只清旧条目的内容，最新一条永远保留', async () => {
  const h = makeDO(TableDO);
  await h.ready;
  const big = 'x'.repeat(9 * 1024 * 1024);
  h.obj.applyOps([{ t: 'setProp', key: 'doc', value: { t: big } }], 'u');
  h.obj.applyOps([{ t: 'setProp', key: 'doc', value: { t: big + 'y' } }], 'u');
  await h.obj.alarm();
  const rows = h.ctx.db.prepare('SELECT seq, op_json IS NULL AS gone FROM ops_ring ORDER BY seq').all();
  assert.deepEqual(rows.map((x) => [x.seq, x.gone]), [[1, 1], [2, 0]]);
  const got = await hello(h, 0);
  assert.equal(got[0].t, 'resync');
  const got2 = await hello(h, 1);
  assert.equal(got2.find((m) => m.t === 'ops').ops.length, 1);
});

// ── 额度 ──

console.log('── 额度 ──');

await test('快到每日额度：大批量改动被拒（code=quota），小修改照常', async () => {
  const h = makeDO(TableDO);
  await h.ready;
  h.obj._usage = { day: new Date().toISOString().slice(0, 10), rows: DAILY_WRITE_QUOTA * 0.96, at: Date.now() };
  const cells = Array.from({ length: 500 }, (_, r) => [r, 0, 'x']);
  const r = h.obj.applyOps([{ t: 'setCells', cells }], 'u');
  assert.equal(r.code, 'quota');
  assert.match(r.error, /08:00/);
  assert.equal((await h.state()).cells.length, 0, '被拒的批次一个字都没写');
  assert.ok('seq' in h.obj.applyOps([{ t: 'setCells', cells: [[0, 0, 'ok']] }], 'u'));
});

await test('alarm 上报写入量：只报新增的部分，没有变化就不报', async () => {
  const sent = [];
  let total = 0;
  const env = { DB: { prepare: (sql) => ({ bind: (...a) => ({ first: async () => { if (sql.includes('RETURNING')) { sent.push(Number(a[1])); total += Number(a[1]); return { value: String(total) }; } return null; }, run: async () => ({}) }) }) } };
  const h = makeDO(TableDO, env);
  await h.ready;
  h.obj.applyOps([{ t: 'setCells', cells: [[0, 0, 'a'], [1, 0, 'b']] }], 'u');
  await h.obj.alarm();
  assert.ok(sent[0] >= 3, '两行 + 一条日志：' + sent);
  assert.ok(h.obj._usedToday() >= total);
  const n = sent.length;
  await h.obj.alarm();
  await h.obj.alarm();
  assert.ok(sent.length <= n + 1, '没有新写入时最多再报一次 alarm 自己的零散写入');
});

if (failures) { console.error(`\n${failures} 个存储测试失败`); process.exit(1); }
console.log('\n存储结构测试全部通过');
