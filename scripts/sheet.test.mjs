/**
 * P3 结构与格式：插入 / 删除行列、单元格格式、表属性。
 *
 * 核心性质只有一条：**浏览器模型与 DO 对同一串 op 得出逐格一致的结果**。
 * 所以每个用例都同时对两端施加同样的 op，再比较快照。
 */

import assert from 'node:assert/strict';
import { installWorkerGlobals, makeDO } from './do-stub.mjs';

installWorkerGlobals();
const { TableDO } = await import('../worker/do/TableDO.js');
const { GridModel } = await import('../public/js/grid/model.js');
const { normalizeOps, normalizeStyle } = await import('../public/shared/model/ops.js');
const { adjustRange, adjustProps } = await import('../public/shared/model/sheet.js');

let failures = 0;
async function test(name, fn) {
  try { await fn(); console.log('  ok   ' + name); }
  catch (err) { failures++; console.error('  FAIL ' + name + '\n       ' + (err.stack ?? err.message)); }
}

const byPos = (a, b) => a[0] - b[0] || a[1] - b[1];
const unkey = (map) => [...map].map(([k, v]) => { const [r, c] = k.split(':').map(Number); return [r, c, v]; }).sort(byPos);

/** 模型的内容，排成与 DO 快照相同的形状。 */
function modelState(m) {
  return { rowCount: m.rowCount, colCount: m.colCount, cells: unkey(m.cells), formats: unkey(m.formats), props: m.props };
}

/** normalizeOps 的返回值统一成数组。 */
function clean(ops) {
  const r = normalizeOps(ops);
  assert.ok(Array.isArray(r) || Array.isArray(r?.ops), '被拒绝：' + JSON.stringify(r));
  return Array.isArray(r) ? r : r.ops;
}

/** 两端同时施加同一串 op，返回两边的状态。 */
async function both(opsList) {
  const h = makeDO(TableDO);
  const m = new GridModel();
  m.loadSnapshot(await h.state());
  for (const ops of opsList) {
    const c = clean(ops);
    const res = h.obj.applyOps(c, 'u1');
    assert.ok(!('error' in res), JSON.stringify(res));
    m.apply(c);
  }
  const snap = await h.state();
  return {
    m, h,
    model: modelState(m),
    server: { rowCount: snap.rowCount, colCount: snap.colCount, cells: snap.cells.sort(byPos), formats: (snap.formats ?? []).sort(byPos), props: snap.props ?? {} },
  };
}

await test('normalizeStyle 只留白名单里的合法值', () => {
  assert.deepEqual(normalizeStyle({ b: true, fs: 14, fc: '#FF0000', ha: 'c', evil: 1, bg: 'red' }), { b: true, fs: 14, fc: '#ff0000', ha: 'c' });
  assert.equal(normalizeStyle({ b: false, fs: 999 }), null);
  assert.deepEqual(normalizeStyle({ bd: { t: '#000000', x: '#111111' } }), { bd: { t: '#000000' } });
});

await test('setProp 拒绝不认识的键', () => {
  const r = normalizeOps([{ t: 'setProp', key: '__proto__', value: 1 }]);
  const ops = Array.isArray(r) ? r : r?.ops;
  assert.ok(!ops || ops.length === 0, JSON.stringify(r));
});

await test('adjustRange：插入撑大、部分删除收缩、整段删除为 null', () => {
  assert.deepEqual(adjustRange([2, 0, 5, 1], 'row', 3, 2), [2, 0, 7, 1]);
  assert.deepEqual(adjustRange([2, 0, 5, 1], 'row', 0, 1), [3, 0, 6, 1]);
  assert.deepEqual(adjustRange([2, 0, 5, 1], 'row', 4, -3), [2, 0, 3, 1]);
  assert.equal(adjustRange([2, 0, 5, 1], 'row', 2, -4), null);
  assert.deepEqual(adjustRange([0, 2, 0, 4], 'col', 0, -3), [0, 0, 0, 1]);
});

await test('adjustProps：合并缩成单格就消失，筛选条件跟着列走', () => {
  const out = adjustProps({ merges: [[0, 0, 1, 0], [5, 0, 6, 1]] }, 'row', 1, -1);
  assert.deepEqual(out.merges, [[4, 0, 5, 1]]);
  const out2 = adjustProps({ filter: { range: [0, 0, 9, 3], crit: { 2: ['a'], 0: ['b'] } } }, 'col', 1, 1);
  assert.deepEqual(out2.filter.crit, { 0: ['b'], 3: ['a'] });
  assert.deepEqual(out2.filter.range, [0, 0, 9, 4]);
});

await test('插入行：格子、公式、格式、合并在两端一致地下移', async () => {
  const { model, server } = await both([
    [{ t: 'setCells', cells: [[0, 0, '1'], [1, 0, '2'], [2, 0, '=A1+A2'], [3, 0, '=SUM(A1:A2)']] }],
    [{ t: 'setFormats', cells: [[1, 0, { b: true }]] }],
    [{ t: 'setProp', key: 'merges', value: [[1, 1, 2, 2]] }],
    [{ t: 'insertRows', at: 1, n: 2 }],
  ]);
  assert.deepEqual(model.cells, [[0, 0, '1'], [3, 0, '2'], [4, 0, '=A1+A4'], [5, 0, '=SUM(A1:A4)']]);
  assert.deepEqual(model.formats, [[3, 0, { b: true }]]);
  assert.deepEqual(model.props.merges, [[3, 1, 4, 2]]);
  assert.equal(model.rowCount, 502);
  assert.deepEqual(server, model);
});

await test('删除列：被删的引用变 #REF!，右侧的左移，两端一致', async () => {
  const { model, server } = await both([
    [{ t: 'setCells', cells: [[0, 0, 'a'], [0, 1, 'b'], [0, 2, 'c'], [1, 2, '=B1&C1'], [1, 3, '=SUM(A1:C1)']] }],
    [{ t: 'setFormats', cells: [[0, 2, { fc: '#ff0000' }], [0, 1, { i: true }]] }],
    [{ t: 'deleteCols', at: 1, n: 1 }],
  ]);
  assert.deepEqual(model.cells, [[0, 0, 'a'], [0, 1, 'c'], [1, 1, '=#REF!&B1'], [1, 2, '=SUM(A1:B1)']]);
  assert.deepEqual(model.formats, [[0, 1, { fc: '#ff0000' }]]);
  assert.equal(model.colCount, 25);
  assert.deepEqual(server, model);
});

await test('删除行后撤销：内容、公式、格式、行高全部回来', () => {
  const m = new GridModel();
  m.apply([{ t: 'setCells', cells: [[0, 0, '1'], [1, 0, '2'], [2, 0, '3'], [3, 0, '=SUM(A1:A3)']] }]);
  m.apply([{ t: 'setFormats', cells: [[1, 0, { bg: '#ffff00' }]] }]);
  m.apply([{ t: 'setRowHeight', r: 1, h: 40 }]);
  m.apply([{ t: 'setProp', key: 'merges', value: [[1, 1, 1, 3]] }]);
  const before = JSON.stringify(modelState(m));
  const beforeH = [...m.rowHeights];
  const inv = m.apply([{ t: 'deleteRows', at: 1, n: 1 }]);
  assert.equal(m.getCell(2, 0), '=SUM(A1:A2)');
  assert.equal(m.props.merges.length, 0);
  m.apply(inv);
  assert.equal(JSON.stringify(modelState(m)), before);
  assert.deepEqual([...m.rowHeights], beforeH);
});

await test('插入列后撤销：列宽与列名回到原位', () => {
  const m = new GridModel();
  m.apply([{ t: 'renameField', c: 1, name: '单价' }, { t: 'resizeField', c: 1, w: 180 }]);
  const inv = m.apply([{ t: 'insertCols', at: 0, n: 1 }]);
  assert.equal(m.colTitle(2), '单价');
  assert.equal(m.colWidth(2), 180);
  m.apply(inv);
  assert.equal(m.colTitle(1), '单价');
  assert.equal(m.colWidth(1), 180);
  assert.equal(m.colCount, 26);
});

await test('DO 快照带回格式与表属性，清除后消失', async () => {
  const h = makeDO(TableDO);
  h.obj.applyOps(clean([
    { t: 'setCells', cells: [[0, 0, 'x']] },
    { t: 'setFormats', cells: [[0, 0, { b: true, nf: '0.00' }]] },
    { t: 'setProp', key: 'freeze', value: { r: 1, c: 0 } },
  ]), 'u1');
  const snap = await h.state();
  assert.deepEqual(snap.formats, [[0, 0, { b: true, nf: '0.00' }]]);
  assert.deepEqual(snap.props, { freeze: { r: 1, c: 0 } });
  h.obj.applyOps(clean([{ t: 'setFormats', cells: [[0, 0, null]] }, { t: 'setProp', key: 'freeze', value: null }]), 'u1');
  const snap2 = await h.state();
  assert.deepEqual(snap2.formats, []);
  assert.deepEqual(snap2.props, {});
});

await test('连续结构操作（插、删、插）后两端仍然逐格一致', async () => {
  const cells = [];
  for (let r = 0; r < 8; r++) {
    for (let c = 0; c < 4; c++) {
      const col = 'ABCD'[c];
      cells.push([r, c, r === 7 ? '=SUM(' + col + '1:' + col + '7)' : String(r * 10 + c)]);
    }
  }
  const { model, server } = await both([
    [{ t: 'setCells', cells }],
    [{ t: 'insertRows', at: 3, n: 2 }],
    [{ t: 'deleteCols', at: 0, n: 2 }],
    [{ t: 'deleteRows', at: 0, n: 1 }],
    [{ t: 'insertCols', at: 1, n: 1 }],
  ]);
  assert.deepEqual(server, model);
  assert.equal(model.cells.find(([r, c]) => r === 8 && c === 0)[2], '=SUM(A1:A8)');
});

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
