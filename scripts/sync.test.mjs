/**
 * P2 客户端测试：SyncEngine ↔ 真 TableDO 的端到端配合。
 *
 * 对着计划里 P2 的完成判据：
 *   「两个浏览器窗口同时编辑同一张表，改动互见」→ 双客户端用例
 *   「断网重连后自动补齐」→ 拔网线 / 悬空批次 / 溢出三组用例
 *   「刷新数据不丢」→ 载入快照 + 落库校验
 *
 * 链路是真的：SyncEngine → ws.js → 假 socket → TableDO → 真 SQLite → 广播回来。
 * 只有「浏览器的网络栈」是替身（net-stub.mjs），两端的协议代码都是线上那一份。
 */

import assert from 'node:assert/strict';
import { installWorkerGlobals, makeDO, tick } from './do-stub.mjs';
import { installNet } from './net-stub.mjs';

installWorkerGlobals();
const { TableDO } = await import('../worker/do/TableDO.js');
const { LIMITS } = await import('../public/shared/model/ops.js');

let failures = 0;
async function test(name, fn) {
  try { await fn(); console.log('  ok   ' + name); }
  catch (err) { failures++; console.error('  FAIL ' + name + '\n       ' + (err.stack ?? err.message)); }
}

// 这两个模块在 import 时不碰 DOM，但 ws.js 在构造时就要 window/document，
// 所以先装一次全局壳子，之后每个用例再换成自己的 net。
installNet(makeDO(TableDO));
const { GridModel } = await import('../public/js/grid/model.js');
const { SyncEngine } = await import('../public/js/core/sync.js');

/** 一套「DO + 网络 + 客户端」。多数用例只要一个。 */
async function setup(opts = {}) {
  const h = makeDO(TableDO);
  if (opts.seed) opts.seed(h);
  const net = installNet(h, opts.session);
  const c = await join(net, h, opts.session);
  return { h, net, ...c };
}

/** 再接一个客户端进同一个 DO。 */
async function join(net, h, session) {
  if (session) net.session = { ...net.session, ...session };
  const model = new GridModel({ rows: 500, cols: 26 });
  /** @type {any} */ const log = { states: [], presence: [], cursors: [], notices: [] };
  const sync = new SyncEngine(net.session.tableId, model, {
    onState: (s, d) => log.states.push([s, d]),
    onPresence: (u) => log.presence.push(u),
    onCursor: (from, sel, editing) => log.cursors.push([from, sel, editing]),
    onNotice: (m, k) => log.notices.push([k, m]),
  });
  await sync.start();
  await tick(20);
  return { model, sync, log };
}

/** 浏览器这一端实际发出去的帧。 */
function sentFrames(net, i = -1) {
  const ep = net.sockets.at(i)?._ep;
  return (ep?.sent ?? []).map((s) => JSON.parse(s));
}

// ── 载入与基本收发 ──────────────────────────────────────────────────────────

await test('打开表：拉全量快照 → welcome → synced，状态变成已同步', async () => {
  const { sync, model, log } = await setup({
    seed: (h) => h.obj.applyOps([{ t: 'setCells', cells: [[0, 0, '已有'], [2, 3, '数据']] }], 'seed'),
  });
  assert.equal(model.getCell(0, 0), '已有');
  assert.equal(model.getCell(2, 3), '数据');
  assert.equal(sync.state, 'online');
  assert.ok(sync.ready);
  assert.ok(sync.seq > 0, 'seq 应来自快照');
  assert.deepEqual(log.states.map((s) => s[0]), ['loading', 'connecting', 'syncing', 'online']);
  sync.destroy();
});

await test('快照里的列宽、列名、行高都还原到模型上', async () => {
  const { model, sync } = await setup({
    seed: (h) => h.obj.applyOps([
      { t: 'renameField', c: 1, name: '客户' },
      { t: 'resizeField', c: 1, w: 180 },
      { t: 'setRowHeight', r: 4, h: 60 },
    ], 'seed'),
  });
  assert.equal(model.colTitle(1), '客户');
  assert.equal(model.colWidth(1), 180);
  assert.equal(model.rowHeight(4), 60);
  sync.destroy();
});

await test('本地编辑会落到 DO 的库里，回声不会把值改回去', async () => {
  const { h, model, sync } = await setup();
  model.apply([{ t: 'setCell', r: 1, c: 1, v: '你好' }]);
  assert.equal(model.getCell(1, 1), '你好', '乐观应用：不等服务端就先显示');
  await tick(60);
  const snap = await h.state();
  assert.deepEqual(snap.cells, [[1, 1, '你好']]);
  assert.equal(model.getCell(1, 1), '你好');
  assert.equal(sync._pending.size, 0, '回声到了就该销掉 pending');
  sync.destroy();
});

await test('16ms 窗口内的连续输入合成一条消息', async () => {
  const { net, model, sync } = await setup();
  model.apply([{ t: 'setCell', r: 0, c: 0, v: 'a' }]);
  model.apply([{ t: 'setCell', r: 0, c: 1, v: 'b' }]);
  model.apply([{ t: 'setCell', r: 0, c: 2, v: 'c' }]);
  await tick(60);
  const ops = sentFrames(net).filter((m) => m.t === 'ops');
  assert.equal(ops.length, 1, '三次改动应合并成一条 ops 消息');
  assert.equal(ops[0].ops.length, 1, '并且合并成一条 setCells');
  assert.equal(ops[0].ops[0].cells.length, 3);
  sync.destroy();
});

await test('addRows/addCols 上网前换算成绝对值（幂等的关键）', async () => {
  const { h, net, model, sync } = await setup();
  model.apply([{ t: 'addRows', n: 100 }]);
  model.apply([{ t: 'addCols', n: 4 }]);
  await tick(60);

  const wire = sentFrames(net).filter((m) => m.t === 'ops').flatMap((m) => m.ops);
  assert.deepEqual(wire.map((o) => o.t), ['setRowCount', 'setColCount'], '相对量不能上网');
  assert.equal(wire[0].n, 600);
  assert.equal(wire[1].n, 30);

  const snap = await h.state();
  assert.equal(snap.rowCount, 600);
  assert.equal(snap.colCount, 30);
  sync.destroy();
});

await test('绝对值 op 重放两遍结果不变（重发悬空批次的前提）', async () => {
  const { h, sync } = await setup();
  const ops = [{ t: 'setRowCount', n: 700 }];
  h.obj.applyOps(ops, 'u1');
  h.obj.applyOps(ops, 'u1');
  const snap = await h.state();
  assert.equal(snap.rowCount, 700, '换成 addRows 的话这里会变成 1400');
  sync.destroy();
});

await test('远端改动直接进模型，且不会被当成本地改动再发回去', async () => {
  const { h, net, model, sync } = await setup();
  h.obj.broadcast({ t: 'ops', seq: h.obj.currentSeq() + 1, actorId: 'other', batchId: null,
                    ops: [{ t: 'setCells', cells: [[5, 5, '别人写的'] ] }] });
  await tick(40);
  assert.equal(model.getCell(5, 5), '别人写的');
  assert.equal(sentFrames(net).filter((m) => m.t === 'ops').length, 0, '远端改动绝不能回环');
  sync.destroy();
});

// ── 两个人 ──────────────────────────────────────────────────────────────────

await test('两个客户端：一个人的改动另一个人立刻看到', async () => {
  const { h, net, model: mA, sync: sA } = await setup({ session: { uid: 'ua', email: 'a@x.com' } });
  const { model: mB, sync: sB } = await join(net, h, { uid: 'ub', email: 'b@x.com' });

  mB.apply([{ t: 'setCell', r: 2, c: 2, v: 'B 写的' }]);
  await tick(60);
  assert.equal(mA.getCell(2, 2), 'B 写的');

  mA.apply([{ t: 'setCell', r: 3, c: 3, v: 'A 写的' }]);
  await tick(60);
  assert.equal(mB.getCell(3, 3), 'A 写的');
  sA.destroy(); sB.destroy();
});

await test('presence：名单里两个人都在；一个人走了名单缩回去', async () => {
  const { h, net, sync: sA, log: lA } = await setup({ session: { uid: 'ua', email: 'a@x.com' } });
  const { sync: sB } = await join(net, h, { uid: 'ub', email: 'b@x.com' });
  await tick(20);
  const both = lA.presence.at(-1);
  assert.deepEqual(both.map((u) => u.id).sort(), ['ua', 'ub']);

  sB.destroy();
  await tick(20);
  assert.deepEqual(lA.presence.at(-1).map((u) => u.id), ['ua']);
  sA.destroy();
});

await test('光标广播：节流到 10Hz，只发最后一个位置', async () => {
  const { h, net, sync: sA, log: lA } = await setup({ session: { uid: 'ua' } });
  const { sync: sB } = await join(net, h, { uid: 'ub' });

  for (let i = 0; i < 20; i++) sB.sendCursor({ r0: i, c0: 0, r1: i, c1: 0 });
  await tick(160);

  const sentByB = sentFrames(net).filter((m) => m.t === 'cursor');
  assert.equal(sentByB.length, 1, '20 次移动在一个节流窗口里只应发一次');
  assert.deepEqual(sentByB[0].sel, { r0: 19, c0: 0, r1: 19, c1: 0 }, '发的必须是最后那个位置');

  const seen = lA.cursors.at(-1);
  assert.equal(seen[0], 'ub');
  assert.deepEqual(seen[1], { r0: 19, c0: 0, r1: 19, c1: 0 });
  assert.equal(seen[2], false);

  sB.sendCursor({ r0: 3, c0: 3, r1: 3, c1: 3 }, true);
  await tick(160);
  assert.deepEqual(lA.cursors.at(-1), ['ub', { r0: 3, c0: 3, r1: 3, c1: 3 }, true], '正在输入的标志一路带到对方');
  sA.destroy(); sB.destroy();
});

// ── 权限 ────────────────────────────────────────────────────────────────────

await test('viewer：状态是只读，本地改动一个字也不发出去', async () => {
  const { h, net, model, sync } = await setup({ session: { uid: 'uv', role: 'viewer' } });
  assert.equal(sync.state, 'readonly');
  assert.equal(sync.readonly, true);
  assert.equal(sync.canEdit, false);

  model.apply([{ t: 'setCell', r: 0, c: 0, v: '偷偷改' }]);
  await tick(60);
  assert.equal(sentFrames(net).filter((m) => m.t === 'ops').length, 0);
  assert.deepEqual((await h.state()).cells, []);
  sync.destroy();
});

await test('viewer 断线后依然是只读（可写性不跟着连接状态走）', async () => {
  const { net, sync } = await setup({ session: { uid: 'uv', role: 'viewer' } });
  net.cut();
  await tick(20);
  assert.equal(sync.state, 'offline', '状态确实变成了离线');
  assert.equal(sync.readonly, true, '但只读不能因为断线被解除');
  assert.equal(sync.canEdit, false);
  sync.destroy();
});

await test('服务端拒绝时：提示用户并重新对齐，不留下分叉', async () => {
  const { h, model, sync, log } = await setup({ session: { uid: 'uv', role: 'viewer' } });
  sync.readonly = false;                      // 假装客户端被改过，绕过本地这道闸
  model.apply([{ t: 'setCell', r: 0, c: 0, v: '本地已经改了' }]);
  await tick(80);

  assert.ok(log.notices.some(([k]) => k === 'error'), '必须明确告诉用户没写进去');
  assert.equal(model.getCell(0, 0), '', 'resync 之后本地要被服务端的空值覆盖回来');
  assert.deepEqual((await h.state()).cells, []);
  sync.destroy();
});

// ── 断网与恢复 ──────────────────────────────────────────────────────────────

await test('拔网线：状态变离线，改动先攒着；插回去自动补发', async () => {
  const { h, net, model, sync } = await setup();
  net.cut();
  await tick(20);
  assert.equal(sync.state, 'offline');

  model.apply([{ t: 'setCell', r: 7, c: 0, v: '离线写的' }]);
  await tick(40);
  assert.deepEqual((await h.state()).cells, [], '离线期间当然写不进去');
  assert.ok(sync._out.length > 0, '但必须攒在队列里');

  net.restore();
  await sync.conn.connect(true);              // 跳过退避，等同于退避计时器到点
  await tick(80);

  assert.equal(sync.state, 'online');
  assert.deepEqual((await h.state()).cells, [[7, 0, '离线写的']], '补发必须发生');
  assert.equal(sync._out.length, 0);
  sync.destroy();
});

await test('断网期间会不断重试（带退避），不是一次失败就放弃', async () => {
  const { net, sync } = await setup();
  net.cut();
  await tick(20);
  const before = net.ticketFails;
  await tick(900);                            // 退避表第一档 500ms（±30% 抖动）
  assert.ok(net.ticketFails > before, '应该至少又试了一次');
  sync.destroy();
});

await test('悬空批次（发了但没收到回声）在重连后重发', async () => {
  const { h, sync } = await setup();
  // 直接构造"已发出、未确认"的状态：这正是 socket 在 send 之后、echo 之前死掉的样子
  sync._pending.set('lost', [{ t: 'setCells', cells: [[9, 9, '悬空的那批'] ] }]);
  sync._resume();
  await tick(60);
  assert.deepEqual((await h.state()).cells, [[9, 9, '悬空的那批']]);
  assert.equal(sync._pending.size, 0);
  sync.destroy();
});

await test('离线缓存溢出：明确告知用户，并在恢复后以服务器为准', async () => {
  const { h, net, model, sync, log } = await setup({
    seed: (hh) => hh.obj.applyOps([{ t: 'setCells', cells: [[0, 0, '服务器的值']] }], 'seed'),
  });
  net.cut();
  await tick(20);

  const cells = [];
  for (let i = 0; i < 100001; i++) cells.push([i, 0, 'x']);
  model.apply([{ t: 'setCells', cells }]);
  await tick(20);

  assert.ok(log.notices.some(([k, m]) => k === 'error' && m.includes('以服务器数据为准')),
            '不能悄悄分叉，必须说清楚代价');
  assert.equal(sync._out.length, 0, '溢出的队列要丢掉，不能无限涨');

  net.restore();
  await sync.conn.connect(true);
  await tick(120);
  assert.equal(model.getCell(0, 0), '服务器的值', '恢复后以服务器为准');
  assert.equal(model.getCell(5, 0), '', '离线期间写的那 10 万格不该留在本地');
  assert.equal(sync.state, 'online');
  sync.destroy();
});

await test('baseSeq 落后于结构性改动时，DO 让重拉，客户端照做', async () => {
  const { h, model, sync, log } = await setup({
    seed: (hh) => hh.obj.applyOps([{ t: 'setCells', cells: [[1, 1, '权威值']] }], 'seed'),
  });
  h.obj.applyOps([{ t: 'clearAll' }], 'other');       // 别人清了表，产生一次结构性 op
  sync.seq = 0;                                        // 假装我们还停在很早以前
  model.apply([{ t: 'setCell', r: 2, c: 2, v: '基于旧状态的改动' }]);
  await tick(100);

  assert.ok(log.notices.some(([, m]) => m.includes('重新载入')), '要告诉用户为什么内容变了');
  assert.equal(model.getCell(2, 2), '', 'resync 之后本地改动被服务端状态覆盖');
  assert.equal(sync.seq, h.obj.currentSeq());
  sync.destroy();
});

// ── 大批量 ──────────────────────────────────────────────────────────────────

await test('超大粘贴按 MAX_CELLS_PER_MSG 拆包，且一格不少', async () => {
  const { h, net, model, sync } = await setup();
  const n = LIMITS.MAX_CELLS_PER_MSG + 2500;
  const cells = [];
  for (let i = 0; i < n; i++) cells.push([Math.floor(i / 20), i % 20, 'v' + i]);
  model.apply([{ t: 'setCells', cells }]);
  await tick(400);

  const msgs = sentFrames(net).filter((m) => m.t === 'ops');
  assert.equal(msgs.length, 2, '一条装不下就该拆成两条');
  for (const m of msgs) {
    const count = m.ops.reduce((s, o) => s + (o.t === 'setCells' ? o.cells.length : 1), 0);
    assert.ok(count <= LIMITS.MAX_CELLS_PER_MSG, '每条都不能超限');
  }
  const snap = await h.state();
  assert.equal(snap.cells.length, n, '拆包不能丢格子');
  sync.destroy();
});

// ── 收尾 ────────────────────────────────────────────────────────────────────

await test('destroy 之后不再发送任何东西，也不再改模型', async () => {
  const { net, model, sync } = await setup();
  sync.destroy();
  const before = sentFrames(net).length;
  model.apply([{ t: 'setCell', r: 0, c: 0, v: '关掉之后' }]);
  await tick(60);
  assert.equal(sentFrames(net).length, before);
});

await test('快照请求失败时只报错，不会卡在载入中', async () => {
  const h = makeDO(TableDO);
  const net = installNet(h);
  net.offline = true;
  const model = new GridModel({ rows: 500, cols: 26 });
  /** @type {any[]} */ const notices = [];
  const sync = new SyncEngine('t1', model, { onNotice: (m, k) => notices.push([k, m]) });
  await sync.start();
  assert.equal(sync.state, 'offline');
  assert.equal(notices.length, 1);
  assert.equal(notices[0][0], 'error');
  sync.destroy();
});

// ── 权限变更 ────────────────────────────────────────────────────────────────

/** Worker 在改权限 / 移除成员 / 停用账号之后打给 DO 的那一下。 */
const revoke = (h, uid) => h.obj.fetch(new Request('https://do/revoke', {
  method: 'POST', headers: { 'x-user-id': uid, 'x-user-role': 'editor', 'x-table-id': 't1' },
}));

await test('降为只读：被踢后立刻按新角色重连，界面切到只读', async () => {
  const { h, net, sync, model, log } = await setup();
  const n0 = net.sockets.length;
  net.session.role = 'viewer';
  await revoke(h, 'u1');
  await tick(30);
  assert.equal(net.sockets.length, n0 + 1, '应当马上重连一次，不走退避');
  assert.equal(sync.state, 'readonly', '界面应切到只读');
  assert.ok(log.states.some(([, d]) => d === '权限已变更，正在重新连接…'));
  const [ws] = h.ctx.getWebSockets();
  assert.equal(ws.deserializeAttachment().role, 'viewer');
  assert.equal(model.getCell(0, 0), '', '模型没被动过');
  sync.destroy();
});

await test('被移出工作区：拿不到 ticket 就停下并说明原因，不在后台无限重连', async () => {
  const { h, net, sync, log } = await setup();
  net.ticketStatus = 404;
  await revoke(h, 'u1');
  await tick(50);
  assert.equal(sync.state, 'offline');
  assert.equal(log.states.at(-1)[1], '你已没有这张表的访问权限');
  const n = net.ticketRequests;
  await tick(200);
  assert.equal(net.ticketRequests, n, '不应再重试');
  assert.equal(h.ctx.getWebSockets().length, 0);
  sync.destroy();
});

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
