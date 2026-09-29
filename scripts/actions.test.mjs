/** 编辑动作（grid/actions.js）+ 计算层（grid/calc.js）+ 撤销逆 op。纯逻辑，不需要 DOM。 */
import assert from 'node:assert/strict';
const { GridModel } = await import('../public/js/grid/model.js');
const { Calc } = await import('../public/js/grid/calc.js');
const A = await import('../public/js/grid/actions.js');

let failures = 0;
async function test(name, fn) {
  try { await fn(); console.log('  ok   ' + name); }
  catch (err) { failures++; console.error('  FAIL ' + name + '\n       ' + (err.stack ?? err.message)); }
}
const R = (r0, c0, r1, c1) => ({ r0, c0, r1, c1 });
function setup(rows) {
  const m = new GridModel();
  const cells = [];
  rows.forEach((row, r) => row.forEach((v, c) => { if (v !== '') cells.push([r, c, String(v)]); }));
  if (cells.length) m.apply([{ t: 'setCells', cells }]);
  return { m, calc: new Calc(m) };
}
const col = (m, c, n) => Array.from({ length: n }, (_, r) => m.getCell(r, c));

await test('公式求值与显示：=SUM、=A1*2、除零错误', () => {
  const { m, calc } = setup([['1', '=A1*2'], ['2', '=SUM(A1:A2)'], ['', '=1/0']]);
  assert.equal(calc.display(0, 1).text, '2');
  assert.equal(calc.display(1, 1).text, '3');
  assert.equal(calc.display(2, 1).text, '#DIV/0!');
  m.apply([{ t: 'setCell', r: 0, c: 0, v: '10' }]);
  assert.equal(calc.display(1, 1).text, '12');
});

await test('styleOps 合并补丁、null 去掉样式，撤销还原', () => {
  const { m } = setup([['a']]);
  const inv = m.apply(A.styleOps(m, R(0, 0, 1, 1), { b: true, bg: '#ffff00' }));
  assert.deepEqual(m.getFormat(0, 0), { b: true, bg: '#ffff00' });
  m.apply(A.styleOps(m, R(0, 0, 0, 0), { b: null }));
  assert.deepEqual(m.getFormat(0, 0), { bg: '#ffff00' });
  m.apply(inv);
  assert.equal(m.getFormat(1, 1), undefined);
});

await test('边框：外框只画四边', () => {
  const { m } = setup([]);
  m.apply(A.borderOps(m, R(0, 0, 1, 1), 'outer', '#000000'));
  assert.deepEqual(m.getFormat(0, 0).bd, { t: '#000000', l: '#000000' });
  assert.deepEqual(m.getFormat(1, 1).bd, { b: '#000000', r: '#000000' });
  m.apply(A.borderOps(m, R(0, 0, 1, 1), 'none'));
  assert.equal(m.getFormat(0, 0), undefined);
});

await test('合并后居中：保留左上值，记入 merges，取消合并', () => {
  const { m, calc } = setup([['x', 'y'], ['z', '']]);
  const { ops, lost } = A.mergeOps(m, calc, R(0, 0, 1, 1), 'center');
  assert.equal(lost, 2);
  m.apply(ops);
  assert.deepEqual(m.props.merges, [[0, 0, 1, 1]]);
  assert.equal(m.getCell(0, 1), '');
  assert.equal(m.getFormat(0, 0).ha, 'c');
  m.apply(A.mergeOps(m, calc, R(0, 0, 0, 0), 'unmerge').ops);
  assert.equal(m.props.merges, undefined);
});

await test('排序：数字在前、空值垫底、公式随行平移', () => {
  const { m, calc } = setup([['名', '分'], ['b', '3'], ['a', ''], ['c', '10'], ['d', '=LEN(A5)']]);
  m.apply(A.sortOps(m, calc, R(0, 0, 4, 1), [{ c: 1, desc: true }], true));
  assert.deepEqual(col(m, 0, 5), ['名', 'c', 'b', 'd', 'a']);
  assert.equal(m.getCell(3, 1), '=LEN(A4)');
  assert.equal(calc.display(3, 1).text, '1');
});

await test('分列：逗号拆到右侧', () => {
  const { m } = setup([['a,b,c'], ['d，e']]);
  const { ops, cols } = A.splitTextOps(m, R(0, 0, 1, 0), { delim: 'comma' });
  assert.equal(cols, 3);
  m.apply(ops);
  assert.deepEqual([m.getCell(0, 2), m.getCell(1, 1), m.getCell(1, 2)], ['c', 'e', '']);
});

await test('删除重复行', () => {
  const { m, calc } = setup([['k'], ['a'], ['b'], ['a'], ['c'], ['b']]);
  const { ops, removed } = A.dedupeOps(m, calc, R(0, 0, 5, 0), [0], true);
  assert.equal(removed, 2);
  m.apply(ops);
  assert.deepEqual(col(m, 0, 6), ['k', 'a', 'b', 'c', '', '']);
});

await test('填充柄：等差、日期、星期、文本序号、公式平移', () => {
  const { m } = setup([['1', '2026-01-30', '星期六', '项目9', '=A1*2'], ['3']]);
  m.apply(A.fillOps(m, R(0, 0, 1, 0), R(0, 0, 3, 0)));
  assert.deepEqual(col(m, 0, 4), ['1', '3', '5', '7']);
  m.apply(A.fillOps(m, R(0, 1, 0, 4), R(0, 1, 2, 4)));
  assert.deepEqual(col(m, 1, 3), ['2026-01-30', '2026-01-31', '2026-02-01']);
  assert.deepEqual(col(m, 2, 3), ['星期六', '星期日', '星期一']);
  assert.deepEqual(col(m, 3, 3), ['项目9', '项目10', '项目11']);
  assert.deepEqual(col(m, 4, 3), ['=A1*2', '=A2*2', '=A3*2']);
});

await test('查找与替换', () => {
  const { m, calc } = setup([['Apple', 'pineapple'], ['=A1&"!"', 'x']]);
  const hits = A.findAll(m, (r, c) => calc.text(r, c), { q: 'apple' });
  assert.deepEqual(hits, [{ r: 0, c: 0 }, { r: 0, c: 1 }, { r: 1, c: 0 }]);
  const cs = A.findAll(m, (r, c) => calc.text(r, c), { q: 'apple', matchCase: true });
  assert.equal(cs.length, 1);
  m.apply(A.replaceOps(m, cs, { q: 'apple', matchCase: true }, 'berry'));
  assert.equal(m.getCell(0, 1), 'pineberry');
});

await test('选择性粘贴：转置、数值、公式平移', () => {
  const { m, calc } = setup([['1', '=A1+1'], ['2', '=A2+1']]);
  const b = A.captureBlock(m, calc, R(0, 0, 1, 1));
  m.apply(A.pasteBlockOps(b, R(5, 0, 5, 0), 'all'));
  assert.equal(m.getCell(5, 1), '=A6+1');
  m.apply(A.pasteBlockOps(b, R(10, 0, 10, 0), 'values'));
  assert.equal(m.getCell(10, 1), '2');
  m.apply(A.pasteBlockOps(b, R(20, 0, 20, 0), 'transpose'));
  assert.deepEqual([m.getCell(20, 1), m.getCell(21, 1)], ['2', '=A22+1']);
});

await test('条件格式与筛选', () => {
  const { m, calc } = setup([['h'], ['5'], ['20'], ['15']]);
  m.apply([{ t: 'setProp', key: 'cf', value: [{ id: 'a', range: [1, 0, 3, 0], type: 'gt', v1: '10', style: { bg: '#ff0000' } }] }]);
  assert.equal(calc.cfAt(1, 0), null);
  assert.equal(calc.cfAt(2, 0).bg, '#ff0000');
  m.apply([{ t: 'setProp', key: 'filter', value: { range: [0, 0, 3, 0], crit: { 0: { hide: ['5'] } } } }]);
  assert.deepEqual([...calc.filteredRows()], [1]);
});

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
