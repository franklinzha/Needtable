/**
 * P2 服务端测试：Durable Object 的权威行为。
 *
 * 对着计划里 P2 的判据里属于服务端的那几条：
 *   「刷新数据不丢」→ 物化表 + 全量快照
 *   「断网重连后自动补齐」→ _catchUp 的三条分支（已最新 / 补增量 / 让你重拉）
 *   以及所有不能退让的安全性质：ticket 一次性、viewer 不能写、身份只认请求头。
 *
 * 这里跑的是 `worker/do/TableDO.js` 的真实代码，SQL 也是真 SQLite（见 do-stub.mjs）。
 */

import assert from 'node:assert/strict';
import { installWorkerGlobals, makeDO, collect, tick } from './do-stub.mjs';

installWorkerGlobals();
const { TableDO } = await import('../worker/do/TableDO.js');
const { LIMITS } = await import('../public/shared/model/ops.js');

let failures = 0;
async function test(name, fn) {
  try { await fn(); console.log('  ok   ' + name); }
  catch (err) { failures++; console.error('  FAIL ' + name + '\n       ' + (err.stack ?? err.message)); }
}

/** 建一个新 DO，并接进一条已经握过手的连接。 */
async function connected(opts = {}) {
  const h = makeDO(TableDO);
  const res = await h.connect({ uid: 'u1', ...opts });
  const ws = res.webSocket;
  const got = collect(ws);
  await tick();
  return { h, ws, got };
}

/** 发一条消息并等它被处理完。 */
async function say(ws, msg, ms = 0) { ws.send(JSON.stringify(msg)); await tick(ms); }

// ── 存储与 op 应用 ──────────────────────────────────────────────────────────

await test('新建的 DO 有合理的默认尺寸，快照可读', async () => {
  const h = makeDO(TableDO);
  const snap = await h.state();
  assert.equal(snap.seq, 0);
  assert.equal(snap.rowCount, 500);
  assert.equal(snap.colCount, 26);
  assert.deepEqual(snap.cells, []);
  assert.deepEqual(snap.fields, []);
});

await test('applyOps 物化到 cells 表，seq 单调递增', async () => {
  const h = makeDO(TableDO);
  const a = h.obj.applyOps([{ t: 'setCells', cells: [[0, 0, 'A'], [1, 1, 'B']] }], 'u1');
  assert.ok(!('error' in a));
  const b = h.obj.applyOps([{ t: 'setCells', cells: [[2, 2, 'C']] }], 'u1');
  assert.ok(b.seq > a.seq, 'seq 必须递增');

  const snap = await h.state();
  assert.equal(snap.seq, b.seq);
  assert.deepEqual(snap.cells, [[0, 0, 'A'], [1, 1, 'B'], [2, 2, 'C']]);
});

await test('写空串等于删除，不会在快照里留下空格子', async () => {
  const h = makeDO(TableDO);
  h.obj.applyOps([{ t: 'setCells', cells: [[0, 0, 'x'], [0, 1, 'y']] }], 'u1');
  h.obj.applyOps([{ t: 'setCells', cells: [[0, 0, '']] }], 'u1');
  const snap = await h.state();
  assert.deepEqual(snap.cells, [[0, 1, 'y']]);
});

await test('写到边界外时表自动长大（粘贴超出表尾的数据）', async () => {
  const h = makeDO(TableDO);
  h.obj.applyOps([{ t: 'setCells', cells: [[900, 30, '远']] }], 'u1');
  const snap = await h.state();
  assert.equal(snap.rowCount, 901);
  assert.equal(snap.colCount, 31);
});

await test('列宽/列名/行高落库并出现在快照里', async () => {
  const h = makeDO(TableDO);
  h.obj.applyOps([
    { t: 'resizeField', c: 2, w: 210 },
    { t: 'renameField', c: 2, name: '金额' },
    { t: 'setRowHeight', r: 5, h: 48 },
  ], 'u1');
  const snap = await h.state();
  assert.deepEqual(snap.fields, [{ c: 2, name: '金额', width: 210 }]);
  assert.deepEqual(snap.rowHeights, [[5, 48]]);
});

await test('clearAll 清空内容但保留表尺寸', async () => {
  const h = makeDO(TableDO);
  h.obj.applyOps([{ t: 'setCells', cells: [[0, 0, 'x']] }, { t: 'setRowCount', n: 800 }], 'u1');
  h.obj.applyOps([{ t: 'clearAll' }], 'u1');
  const snap = await h.state();
  assert.deepEqual(snap.cells, []);
  assert.equal(snap.rowCount, 800, 'clearAll 只清内容，不该把表缩回去');
});

await test('clearAll 被记为结构性 op，旧 baseSeq 提交会被要求重拉', async () => {
  const { h, ws, got } = await connected();
  await say(ws, { t: 'ops', batchId: 'b1', baseSeq: 0, ops: [{ t: 'clearAll' }] });
  const after = h.obj.currentSeq();
  got.length = 0;
  await say(ws, { t: 'ops', batchId: 'b2', baseSeq: after - 1, ops: [{ t: 'setCell', r: 0, c: 0, v: 'x' }] });
  assert.equal(got[0]?.t, 'resync');
  assert.equal(got[0]?.reason, 'structural');
});

await test('coalesce：一批零散 setCell 只产生一条 oplog 记录', async () => {
  const h = makeDO(TableDO);
  const res = h.obj.applyOps([
    { t: 'setCell', r: 0, c: 0, v: 'a' },
    { t: 'setCell', r: 0, c: 1, v: 'b' },
    { t: 'setCell', r: 0, c: 0, v: 'a2' },      // 同一格重写，只留最后一次
  ], 'u1');
  assert.equal(res.seq, 1, '三条 setCell 应合并成一条 oplog');
  assert.equal(res.ops.length, 1);
  assert.deepEqual(res.ops[0].cells, [[0, 0, 'a2'], [0, 1, 'b']]);
});

await test('超出单表单元格上限时整批拒绝，一个字也不写', async () => {
  const h = makeDO(TableDO);
  h.obj._cellCount = LIMITS.MAX_CELLS;          // 假装已经满了
  const res = h.obj.applyOps([{ t: 'setCells', cells: [[0, 0, 'x']] }], 'u1');
  assert.ok('error' in res);
  const snap = await h.state();
  assert.deepEqual(snap.cells, [], '拒绝之后不能有半截写入');
});

await test('大表快照流式输出正确（分片边界不截断 JSON）', async () => {
  const h = makeDO(TableDO);
  const N = 5000;                                // > STREAM_CHUNK(2000)，会跨 3 个分片
  for (let i = 0; i < N; i += 1000) {
    const cells = [];
    for (let j = 0; j < 1000; j++) cells.push([i + j, 0, 'v' + (i + j)]);
    h.obj.applyOps([{ t: 'setCells', cells }], 'u1');
  }
  const snap = await h.state();
  assert.equal(snap.cells.length, N);
  assert.deepEqual(snap.cells[0], [0, 0, 'v0']);
  assert.deepEqual(snap.cells[N - 1], [N - 1, 0, 'v' + (N - 1)]);
});

await test('单元格里的引号与换行经过快照往返不变形', async () => {
  const h = makeDO(TableDO);
  const weird = 'a"b\\c\n第二行\t制表';
  h.obj.applyOps([{ t: 'setCells', cells: [[0, 0, weird]] }], 'u1');
  const snap = await h.state();
  assert.equal(snap.cells[0][2], weird);
});

// ── 连接与鉴权 ──────────────────────────────────────────────────────────────

await test('revoke 只踢指定用户的连接（4001），其他人留下并收到新的在线列表', async () => {
  const h = makeDO(TableDO);
  const a = (await h.connect({ uid: 'u1' })).webSocket;
  const a2 = (await h.connect({ uid: 'u1' })).webSocket;
  const b = (await h.connect({ uid: 'u2' })).webSocket;
  const codes = [];
  for (const ws of [a, a2]) ws.addEventListener('close', (e) => codes.push(e.code));
  const gotA = collect(a);
  const gotB = collect(b);
  await tick();
  gotB.length = 0;
  const res = await h.obj.fetch(new Request('https://do/revoke', {
    method: 'POST', headers: { 'x-user-id': 'u1', 'x-user-role': 'editor', 'x-table-id': 't1' },
  }));
  assert.equal((await res.json()).closed, 2);
  await tick();
  assert.deepEqual(codes, [4001, 4001]);
  assert.ok(gotA.some((m) => m.t === 'revoked'), '被踢的一方应先收到 revoked');
  // 线上 TCP 可能不拆：一条被收回、但还"半开"着的旧连接继续发写操作，必须被丢弃
  const sent = [];
  const ghost = { deserializeAttachment: () => ({ uid: 'u1', email: 'u1@x.com', role: 'editor', revoked: true }), send: (x) => sent.push(x) };
  await h.obj.webSocketMessage(ghost, JSON.stringify({ t: 'ops', batchId: 'g', baseSeq: 0, ops: [{ t: 'setCell', r: 0, c: 0, v: 'ghost' }] }));
  assert.deepEqual((await h.state()).cells, []);
  assert.equal(sent.length, 0);
  assert.equal(b.readyState, 1);
  const pres = gotB.filter((m) => m.t === 'presence').pop();
  assert.ok(pres, '应广播在线列表');
  assert.ok(!JSON.stringify(pres).includes('u1@x.com'), JSON.stringify(pres));
});

await test('缺少身份头的请求一律 401', async () => {
  const h = makeDO(TableDO);
  const res = await h.obj.fetch(new Request('https://do/state', { headers: { 'x-table-id': 't1' } }));
  assert.equal(res.status, 401);
});

await test('非 upgrade 请求打到 ws 路径返回 400', async () => {
  const h = makeDO(TableDO);
  const res = await h.obj.fetch(new Request('https://do/ws', {
    headers: { 'x-user-id': 'u1', 'x-table-id': 't1' },
  }));
  assert.equal(res.status, 400);
});

await test('ticket nonce 一次性：同一个 nonce 第二次连接被拒', async () => {
  const h = makeDO(TableDO);
  const first = await h.connect({ uid: 'u1', nonce: 'once' });
  assert.equal(first.status, 101);
  const second = await h.connect({ uid: 'u2', nonce: 'once' });
  assert.equal(second.status, 401);
});

await test('welcome 带回身份与角色，身份取自请求头而非客户端自报', async () => {
  const { got } = await connected({ uid: 'u9', email: 'a@b.com', role: 'viewer' });
  assert.equal(got[0]?.t, 'welcome');
  assert.deepEqual(got[0].you, { id: 'u9', email: 'a@b.com', name: '', role: 'viewer', scope: null });

  // 显示名（可能是中文，头里是编码过的）和可见视图原样带回
  const w2 = (await connected({ uid: 'u8', name: '张三', scope: 'dashboard' })).got[0];
  assert.deepEqual([w2.you.name, w2.you.scope], ['张三', 'dashboard']);
  assert.equal(got[0].limits.maxCells, LIMITS.MAX_CELLS);
});

await test('viewer 发 ops 被拒，且一个字都没写进去', async () => {
  const { h, ws, got } = await connected({ role: 'viewer' });
  got.length = 0;
  await say(ws, { t: 'ops', batchId: 'b1', baseSeq: 0, ops: [{ t: 'setCell', r: 0, c: 0, v: 'x' }] });
  assert.equal(got[0]?.t, 'rejected');
  assert.equal(got[0]?.code, 'forbidden');
  assert.equal(got[0]?.batchId, 'b1');
  assert.equal(h.obj.currentSeq(), 0);
});

await test('非法 op 整批拒绝并带回 batchId', async () => {
  const { h, ws, got } = await connected();
  got.length = 0;
  await say(ws, { t: 'ops', batchId: 'b2', baseSeq: 0, ops: [{ t: 'setCell', r: 0, c: 0, v: 'ok' }, { t: '不存在' }] });
  assert.equal(got[0]?.t, 'rejected');
  assert.equal(got[0]?.code, 'bad_ops');
  assert.equal(h.obj.currentSeq(), 0, '整批拒绝就不能有半批生效');
});

await test('坏 JSON 与未知消息类型都只回 error，不会把 DO 打崩', async () => {
  const { ws, got } = await connected();
  got.length = 0;
  ws.send('{ 这不是 json');
  await tick();
  assert.equal(got[0]?.t, 'error');
  assert.equal(got[0]?.code, 'bad_json');
  await say(ws, { t: '没这个类型' });
  assert.equal(got[1]?.code, 'unknown_type');
});

await test('ping 回 pong（心跳判活靠它）', async () => {
  const { ws, got } = await connected();
  got.length = 0;
  await say(ws, { t: 'ping' });
  assert.equal(got[0]?.t, 'pong');
});

// ── 广播与补齐 ──────────────────────────────────────────────────────────────

await test('一个人的改动广播给所有人，自己那份带着 batchId 当 ack', async () => {
  const h = makeDO(TableDO);
  const a = (await h.connect({ uid: 'ua', nonce: 'na' })).webSocket;
  const b = (await h.connect({ uid: 'ub', nonce: 'nb' })).webSocket;
  const ga = collect(a); const gb = collect(b);
  await tick();
  ga.length = 0; gb.length = 0;

  await say(a, { t: 'ops', batchId: 'mine', baseSeq: 0, ops: [{ t: 'setCell', r: 3, c: 4, v: 'hi' }] });

  const opsA = ga.find((m) => m.t === 'ops');
  const opsB = gb.find((m) => m.t === 'ops');
  assert.equal(opsA?.batchId, 'mine', '自己也要收到回声，它同时是 ack');
  assert.equal(opsB?.batchId, 'mine');
  assert.equal(opsA.actorId, 'ua');
  assert.deepEqual(opsB.ops[0].cells, [[3, 4, 'hi']]);
});

await test('presence：进出都会重新广播在线名单', async () => {
  const h = makeDO(TableDO);
  const a = (await h.connect({ uid: 'ua', email: 'a@x.com', nonce: 'na' })).webSocket;
  const ga = collect(a);
  await tick();
  const b = (await h.connect({ uid: 'ub', email: 'b@x.com', nonce: 'nb' })).webSocket;
  await tick();

  const joined = ga.filter((m) => m.t === 'presence').pop();
  assert.deepEqual(joined.users.map((u) => u.id).sort(), ['ua', 'ub']);
  // 头像要用：名字（没给就用邮箱前缀）和角色
  assert.deepEqual(joined.users.find((u) => u.id === 'ub'), { id: 'ub', email: 'b@x.com', name: 'b', role: 'editor' });

  b.close();
  await tick();
  const left = ga.filter((m) => m.t === 'presence').pop();
  assert.deepEqual(left.users.map((u) => u.id), ['ua']);
});

await test('光标只广播给别人，不回给自己，且会被洗干净', async () => {
  const h = makeDO(TableDO);
  const a = (await h.connect({ uid: 'ua', nonce: 'na' })).webSocket;
  const b = (await h.connect({ uid: 'ub', nonce: 'nb' })).webSocket;
  const ga = collect(a); const gb = collect(b);
  await tick();
  ga.length = 0; gb.length = 0;

  await say(a, { t: 'cursor', sel: { r0: -5, c0: 1.6, r1: 'x', c1: 3, 注入: '<script>' } });
  assert.equal(ga.filter((m) => m.t === 'cursor').length, 0, '自己的光标不该回给自己');
  const cur = gb.find((m) => m.t === 'cursor');
  assert.equal(cur.from, 'ua');
  assert.deepEqual(cur.sel, { r0: 0, c0: 2, r1: 0, c1: 3 }, '负数钳零、小数取整、非数字归零、多余字段丢弃');
  assert.equal(cur.editing, false);
  gb.length = 0;
  await say(a, { t: 'cursor', sel: { r0: 1, c0: 1, r1: 1, c1: 1 }, editing: true });
  assert.equal(gb.find((m) => m.t === 'cursor').editing, true, '正在输入的标志要带给别人');
  gb.length = 0;
  await say(a, { t: 'cursor', sel: { r0: 1, c0: 1, r1: 1, c1: 1 }, editing: 'yes' });
  assert.equal(gb.find((m) => m.t === 'cursor').editing, false, '只认布尔 true');
});

await test('hello：已经是最新的客户端直接拿 synced', async () => {
  const { ws, got } = await connected();
  await say(ws, { t: 'ops', batchId: 'b', baseSeq: 0, ops: [{ t: 'setCell', r: 0, c: 0, v: 'x' }] });
  const cur = got.find((m) => m.t === 'ops').seq;
  got.length = 0;
  await say(ws, { t: 'hello', lastSeq: cur });
  assert.deepEqual(got.map((m) => m.t), ['synced']);
  assert.equal(got[0].seq, cur);
});

await test('hello：落后的客户端拿到增量再 synced', async () => {
  const h = makeDO(TableDO);
  h.obj.applyOps([{ t: 'setCells', cells: [[0, 0, '一']] }], 'u1');
  const afterFirst = h.obj.currentSeq();
  h.obj.applyOps([{ t: 'setCells', cells: [[1, 0, '二']] }], 'u1');

  const ws = (await h.connect({ uid: 'u2' })).webSocket;
  const got = collect(ws);
  await tick();
  got.length = 0;

  await say(ws, { t: 'hello', lastSeq: afterFirst });
  const ops = got.find((m) => m.t === 'ops');
  assert.deepEqual(ops.ops[0].cells, [[1, 0, '二']], '只补自己缺的那一段');
  assert.equal(got.at(-1).t, 'synced');
  assert.equal(got.at(-1).seq, h.obj.currentSeq());
});

await test('hello：oplog 已被裁掉那一段时，回 resync 而不是发有缺口的增量', async () => {
  const h = makeDO(TableDO);
  for (let i = 0; i < 5; i++) h.obj.applyOps([{ t: 'setCells', cells: [[i, 0, 'v' + i]] }], 'u1');
  // 模拟 alarm 裁掉前几条
  h.ctx.storage.sql.exec('UPDATE ops_ring SET op_json = NULL WHERE seq <= 3');

  const ws = (await h.connect({ uid: 'u2' })).webSocket;
  const got = collect(ws);
  await tick();
  got.length = 0;

  await say(ws, { t: 'hello', lastSeq: 1 });
  assert.equal(got[0]?.t, 'resync');
  assert.equal(got[0]?.reason, 'oplog_truncated');
});

await test('hello：全新客户端（lastSeq=-1）也走 resync', async () => {
  const h = makeDO(TableDO);
  h.obj.applyOps([{ t: 'setCells', cells: [[0, 0, 'x']] }], 'u1');
  const ws = (await h.connect({ uid: 'u2' })).webSocket;
  const got = collect(ws);
  await tick();
  got.length = 0;
  await say(ws, { t: 'hello', lastSeq: -1 });
  assert.equal(got[0]?.t, 'resync');
});

// ── 维护 ────────────────────────────────────────────────────────────────────

await test('写入会排一次 alarm，且不会被后续写入一直往后推', async () => {
  const h = makeDO(TableDO);
  h.obj.applyOps([{ t: 'setCells', cells: [[0, 0, 'a']] }], 'u1');
  await h.settle();
  const first = h.ctx.storage._alarm;
  assert.ok(first != null, '第一次写入应该排上 alarm');

  h.obj.applyOps([{ t: 'setCells', cells: [[0, 1, 'b']] }], 'u1');
  await h.settle();
  assert.equal(h.ctx.storage._alarm, first, '已排期就不能重排，否则 alarm 永远不触发');
});

await test('alarm 裁 oplog 并把行数回写 D1；D1 失败不影响表本身', async () => {
  let bound = null;
  const env = {
    DB: {
      prepare: (sql) => ({
        bind: (...args) => {
          if (sql.startsWith('UPDATE tables')) bound = args;
          return { run: async () => ({}), first: async () => (sql.includes('RETURNING') ? { value: String(args[1]) } : null) };
        },
      }),
    },
  };
  const h = makeDO(TableDO, env);
  await h.connect({ uid: 'u1', tableId: 'tbl-abc' });     // 让 DO 记住自己的 table_id
  h.obj.applyOps([{ t: 'setRowCount', n: 1234 }], 'u1');
  await h.obj.alarm();
  assert.equal(bound[0], 1234);
  assert.equal(bound[2], 'tbl-abc');

  const broken = makeDO(TableDO, { DB: { prepare: () => { throw new Error('D1 挂了'); } } });
  await broken.connect({ uid: 'u1' });
  broken.obj.applyOps([{ t: 'setCells', cells: [[0, 0, 'x']] }], 'u1');
  const err = console.error; console.error = () => { };        // 这条报错是预期的，别刷屏
  try { await broken.obj.alarm(); } finally { console.error = err; }
  const snap = await broken.state();
  assert.deepEqual(snap.cells, [[0, 0, 'x']], 'D1 回写失败不该影响表内容');
});

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
