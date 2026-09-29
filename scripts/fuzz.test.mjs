/**
 * 多人并发的收敛性压力测试。
 *
 * 几个客户端对着同一个真 TableDO 随机乱改：单格、整块、格式、列宽、插删行列、偶尔清空；
 * 网络带随机延迟（WS 帧在单条连接内保序、HTTP 快照请求时取、晚些才到），中途还会随机
 * 断线重连。停手、等所有人安静下来之后，每个人看到的表必须和 DO 里的**一字不差**。
 *
 * 伪随机数带种子：失败时打印种子，`FUZZ_SEED=123 node scripts/fuzz.test.mjs` 可复现。
 */

import assert from 'node:assert/strict';
import { installWorkerGlobals, makeDO, tick } from './do-stub.mjs';
import { installNet } from './net-stub.mjs';

installWorkerGlobals();
const { TableDO } = await import('../worker/do/TableDO.js');
installNet(makeDO(TableDO));
const { GridModel } = await import('../public/js/grid/model.js');
const { SyncEngine } = await import('../public/js/core/sync.js');

let failures = 0;
async function test(name, fn) {
  try { await fn(); console.log('  ok   ' + name); }
  catch (err) { failures++; console.error('  FAIL ' + name + '\n       ' + (err.stack ?? err.message)); }
}

/** mulberry32 */
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 模型里和服务端可比的那部分状态，规范成同一种形状。 */
function modelView(m) {
  const cells = [...m.cells.entries()].map(([k, v]) => { const [r, c] = k.split(':').map(Number); return [r, c, v]; })
    .sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const formats = [...m.formats.entries()].map(([k, f]) => { const [r, c] = k.split(':').map(Number); return [r, c, f]; })
    .sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const widths = m.cols.map((c) => c.width);
  return { rowCount: m.rowCount, colCount: m.colCount, cells, formats, widths, props: m.props };
}

function serverView(snap) {
  const widths = Array.from({ length: snap.colCount }, () => 104);
  for (const f of snap.fields) if (f.c < snap.colCount) widths[f.c] = f.width;
  return { rowCount: snap.rowCount, colCount: snap.colCount, cells: snap.cells, formats: snap.formats, widths, props: snap.props };
}

/** 一个客户端的随机动作。坐标集中在一小块区域里，让冲突真的发生。 */
function randomOps(rand, model, opts) {
  const R = () => Math.floor(rand() * 12), C = () => Math.floor(rand() * 6);
  const x = rand();
  if (x < 0.45) return [{ t: 'setCell', r: R(), c: C(), v: rand() < 0.15 ? '' : (rand() < 0.2 ? '=A1+' + Math.floor(rand() * 9) : 'v' + Math.floor(rand() * 1000)) }];
  if (x < 0.60) {
    const cells = [];
    for (let i = 0, n = 1 + Math.floor(rand() * 8); i < n; i++) cells.push([R(), C(), 'b' + Math.floor(rand() * 100)]);
    return [{ t: 'setCells', cells }];
  }
  if (x < 0.70) return [{ t: 'setFormats', cells: [[R(), C(), rand() < 0.3 ? null : { b: true, fc: '#ff0000' }]] }];
  if (x < 0.76) return [{ t: 'resizeField', c: C(), w: 40 + Math.floor(rand() * 200) }];
  if (x < 0.78) return [{ t: 'addRows', n: 1 + Math.floor(rand() * 3) }];
  if (!opts.structural) return [{ t: 'setCell', r: R(), c: C(), v: 's' + Math.floor(rand() * 100) }];
  if (x < 0.84) return [{ t: 'insertRows', at: R(), n: 1 + Math.floor(rand() * 2) }];
  if (x < 0.90) return [{ t: 'deleteRows', at: R(), n: 1 }];
  if (x < 0.94) return [{ t: 'insertCols', at: C(), n: 1 }];
  if (x < 0.98) return model.colCount > 3 ? [{ t: 'deleteCols', at: C(), n: 1 }] : [];
  return rand() < 0.3 ? [{ t: 'clearAll' }] : [{ t: 'setProp', key: 'freeze', value: { r: Math.floor(rand() * 3), c: 0 } }];
}

/** 只列出不同的部分，比 deepEqual 的整棵树好读得多。 */
function diffViews(a, b) {
  const out = [];
  for (const k of ['rowCount', 'colCount']) if (a[k] !== b[k]) out.push(k + ' ' + a[k] + '≠' + b[k]);
  for (const k of ['cells', 'formats']) {
    const m = new Map(b[k].map((e) => [e[0] + ':' + e[1], JSON.stringify(e[2])]));
    const n = new Map(a[k].map((e) => [e[0] + ':' + e[1], JSON.stringify(e[2])]));
    for (const [key, v] of n) if (m.get(key) !== v) out.push(k + '[' + key + '] 本地 ' + v + ' 服务端 ' + (m.get(key) ?? '无'));
    for (const [key, v] of m) if (!n.has(key)) out.push(k + '[' + key + '] 本地 无 服务端 ' + v);
  }
  if (JSON.stringify(a.widths) !== JSON.stringify(b.widths)) out.push('widths ' + a.widths + ' ≠ ' + b.widths);
  if (JSON.stringify(a.props) !== JSON.stringify(b.props)) out.push('props ' + JSON.stringify(a.props) + ' ≠ ' + JSON.stringify(b.props));
  return out.join('；');
}

async function settle(clients, net) {
  const quiet = () => clients.every(({ sync }) => sync.ready && !sync._resyncing && !sync._out.length && !sync._pending.size && !sync._timer);
  let stable = 0;
  for (let i = 0; i < 400 && stable < 4; i++) {
    await tick(25);
    stable = quiet() ? stable + 1 : 0;
  }
  // 最后再多等一会，让还在路上的广播落地
  await tick(net.lag ? 120 : 20);
}

/**
 * @param {number} seed
 * @param {{ clients?: number, steps?: number, lag?: number, structural?: boolean, drops?: boolean }} o
 */
async function run(seed, o) {
  const rand = rng(seed);
  const h = makeDO(TableDO);
  const net = installNet(h);
  if (o.lag) net.lag = () => Math.floor(rand() * o.lag);
  const clients = [];
  for (let i = 0; i < (o.clients ?? 3); i++) {
    const me = { ...net.session, uid: 'u' + i, email: 'u' + i + '@x.com' };
    net.session = me;
    const model = new GridModel({ rows: 500, cols: 26 });
    const sync = new SyncEngine('t1', model, {});
    /** @type {string[]} FUZZ_TRACE=1 时记下这个客户端经历的一切，失败时打印 */
    const trace = [];
    if (process.env.FUZZ_TRACE) {
      const on = sync._onMessage.bind(sync);
      sync._onMessage = (m) => { if (m.t !== 'presence' && m.t !== 'pong') trace.push(['<<', m, sync.seq, sync._resyncing ? 'R' : '', sync._linkUp ? 'L' : '', sync.ready ? 'Y' : '']); on(m); };
      const rs = sync._resync.bind(sync);
      sync._resync = (r) => { trace.push(['!! resync', r, sync.seq, sync._resyncing ? 'R' : '']); return rs(r); };
      const sd = sync._send.bind(sync);
      sync._send = (ops) => { trace.push(['>>', ops, sync.seq]); return sd(ops); };
      model.subscribe((ops, m) => { if (m.local) trace.push(['.. local', ops]); });
      const ls = sync._loadSnapshot.bind(sync);
      sync._loadSnapshot = async () => { trace.push(['.. snap req']); await ls(); trace.push(['.. snap got', sync.seq]); };
    }
    await sync.start();
    // ticket 按 net.session 签发：重连时换回自己的身份，否则 u0 断线后会以 u2 的名义回来
    const cn = sync.conn.connect.bind(sync.conn);
    sync.conn.connect = (...a) => { net.session = me; return cn(...a); };
    if (process.env.FUZZ_TRACE) {
      const os = sync.conn.onState;
      sync.conn.onState = (st, d) => { trace.push(['## conn', st, d ?? '']); os(st, d); };
    }
    clients.push({ model, sync, trace });
  }
  await settle(clients, net);

  for (let step = 0; step < (o.steps ?? 200); step++) {
    const who = clients[Math.floor(rand() * clients.length)];
    // 离线、重新同步中也照样能编辑（界面不拦），所以这里也不拦
    {
      const ops = randomOps(rand, who.model, o);
      if (ops.length) who.model.apply(ops);
    }
    if (o.drops && rand() < 0.02) {
      // 随机拔掉某个人的连接，ws.js 会自己重连、补增量
      const s = net.sockets.filter((x) => x.readyState === 1);
      s[Math.floor(rand() * s.length)]?._serverClose(1006);
    }
    if (rand() < 0.3) await tick(Math.floor(rand() * (o.lag ? o.lag : 5)));
  }
  await settle(clients, net);

  const truth = serverView(await h.state());
  clients.forEach(({ model, trace }, i) => {
    try { assert.deepEqual(modelView(model), truth, `种子 ${seed}：客户端 u${i} 与服务端不一致`); }
    catch (e) {
      if (trace.length) console.error(trace.map((e) => typeof e === 'string' ? e : e.map((x) => typeof x === 'string' ? x : JSON.stringify(x)).join(' ').slice(0, 400)).join(String.fromCharCode(10)));
      console.error(`       差异（种子 ${seed}，u${i}）：${diffViews(modelView(model), truth)}`);
      throw e;
    }
  });
  for (const c of clients) c.sync.destroy();
  await h.settle();
  return truth;
}

const SEEDS = process.env.FUZZ_SEED ? [Number(process.env.FUZZ_SEED)] : [1, 2, 3, 4, 5, 6, 7, 8];

await test('只改内容（无延迟）：3 人 × 300 步后完全一致', async () => {
  for (const s of SEEDS) await run(s, { clients: 3, steps: 300 });
});

await test('只改内容（随机延迟 0~40ms）：4 人 × 200 步后完全一致', async () => {
  for (const s of SEEDS) await run(s, { clients: 4, steps: 200, lag: 40 });
});

await test('含插删行列、清空（随机延迟）：3 人 × 200 步后完全一致', async () => {
  for (const s of SEEDS) await run(100 + s, { clients: 3, steps: 200, lag: 30, structural: true });
});

await test('含随机断线重连：3 人 × 200 步后完全一致', async () => {
  for (const s of SEEDS) await run(200 + s, { clients: 3, steps: 200, lag: 20, structural: true, drops: true });
});

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
