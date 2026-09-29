/** 下拉列表 / 多级下拉（grid/dropdown.js + calc.dropdownOptions）与数据源区域随插删行列平移。纯逻辑，不需要 DOM。 */
import assert from 'node:assert/strict';
const D = await import('../public/js/grid/dropdown.js');
const { GridModel } = await import('../public/js/grid/model.js');
const { Calc } = await import('../public/js/grid/calc.js');
const { Ref, ERR } = await import('../public/shared/formula/values.js');
const { adjustProps } = await import('../public/shared/model/sheet.js');

let failures = 0;
async function test(name, fn) {
  try { await fn(); console.log('  ok   ' + name); }
  catch (err) { failures++; console.error('  FAIL ' + name + '\n       ' + (err.stack ?? err.message)); }
}
function setup(rows, link) {
  const m = new GridModel();
  const cells = [];
  rows.forEach((row, r) => row.forEach((v, c) => { if (v !== '') cells.push([r, c, String(v)]); }));
  if (cells.length) m.apply([{ t: 'setCells', cells }]);
  return { m, calc: new Calc(m, link) };
}

// 数据源放在 A:C（省 / 市 / 区，第一行标题），要填的在 E:G
const SRC = [
  ['省', '市', '区'],
  ['浙江', '杭州', '西湖区'],
  ['', '杭州', '滨江区'],
  ['', '宁波', '海曙区'],
  ['江苏', '南京', '玄武区'],
  ['', '', ''],
  ['江苏', '苏州', '姑苏区'],
];

await test('toPaths：去标题、跳空行、上级留空沿用上一行', () => {
  const p = D.toPaths(SRC, true, true);
  assert.deepEqual(p, [
    ['浙江', '杭州', '西湖区'], ['浙江', '杭州', '滨江区'], ['浙江', '宁波', '海曙区'],
    ['江苏', '南京', '玄武区'], ['江苏', '苏州', '姑苏区'],
  ]);
  assert.deepEqual(D.cascadeOptions(p, []), ['浙江', '江苏']);
  assert.deepEqual(D.cascadeOptions(p, ['浙江']), ['杭州', '宁波']);
  assert.deepEqual(D.cascadeOptions(p, ['浙江', '杭州']), ['西湖区', '滨江区']);
  assert.deepEqual(D.cascadeOptions(p, ['', '杭州']), []);
  assert.deepEqual(D.listFromRows([['a', 'b'], ['a', ''], ['c', '1']], false), ['a', 'b', 'c', '1']);
});

await test('cascadeStale：上一级改了，对不上的下级清空', () => {
  const p = D.toPaths(SRC, true, true);
  assert.deepEqual(D.cascadeStale(p, ['江苏', '杭州', '西湖区'], 1), [1, 2]);
  assert.deepEqual(D.cascadeStale(p, ['浙江', '宁波', '西湖区'], 2), [2]);
  assert.deepEqual(D.cascadeStale(p, ['浙江', '杭州', ''], 1), []);
});

await test('srcError：区域格式、多级下拉至少两列、最多 6 级', () => {
  assert.equal(D.srcError({ range: 'A2:A9' }, 'list'), null);
  assert.equal(D.srcError({ range: 'A:C' }, 'cascade'), null);
  assert.ok(D.srcError({ range: 'A:A' }, 'cascade'));
  assert.ok(D.srcError({ range: 'A:Z' }, 'cascade'));
  assert.ok(D.srcError({ range: '1:3' }, 'list'));
  assert.ok(D.srcError({ range: '哈哈' }, 'list'));
  assert.ok(D.srcError(null, 'list'));
  assert.equal(D.isDropdown({ type: 'cascade' }), true);
  assert.equal(D.isDropdown({ type: 'int' }), false);
});

await test('calc.dropdownOptions：本表多级下拉按左边已选值过滤，校验 / 清空下级', () => {
  const rows = SRC.map((r) => [...r, '', '', '', '']);
  rows[1][4] = '浙江'; rows[1][5] = '杭州';
  const { m, calc } = setup(rows);
  const rule = { type: 'cascade', range: [1, 4, 100, 6], src: { range: 'A:C', header: true } };
  m.apply([{ t: 'setProp', key: 'validations', value: [rule] }]);
  assert.deepEqual(calc.dropdownOptions(rule, 1, 4).options, ['浙江', '江苏']);
  assert.deepEqual(calc.dropdownOptions(rule, 1, 5).options, ['杭州', '宁波']);
  assert.deepEqual(calc.dropdownOptions(rule, 1, 6).options, ['西湖区', '滨江区']);
  const empty = calc.dropdownOptions(rule, 2, 5);
  assert.deepEqual(empty.options, []);
  assert.match(empty.hint, /第 1 级（E 列）/);
  assert.equal(calc.checkValidation(rule, '宁波', 1, 5), null);
  assert.ok(calc.checkValidation(rule, '南京', 1, 5));
  assert.ok(calc.checkValidation(rule, '杭州', 2, 5));
  // 把 E2 改成江苏：F2 杭州对不上，清空
  assert.deepEqual(calc.cascadeClears(rule, 1, 4, '江苏'), [[1, 5, '']]);
  assert.deepEqual(calc.cascadeClears(rule, 1, 4, '浙江'), []);
});

await test('calc.dropdownOptions：普通下拉引用本表区域，跟着内容实时变', () => {
  const { m, calc } = setup([['颜色'], ['红'], ['绿'], ['红']]);
  const rule = { type: 'list', range: [0, 2, 9, 2], src: { range: 'A1:A10', header: true } };
  assert.deepEqual(calc.dropdownOptions(rule, 0, 2).options, ['红', '绿']);
  m.apply([{ t: 'setCells', cells: [[4, 0, '蓝']] }]);
  assert.deepEqual(calc.dropdownOptions(rule, 0, 2).options, ['红', '绿', '蓝']);
  assert.equal(calc.checkValidation(rule, '蓝', 0, 2), null);
  assert.ok(calc.checkValidation(rule, '紫', 0, 2));
  // 旧规则（手动列表）照旧
  assert.deepEqual(calc.dropdownOptions({ type: 'list', list: ['x', 'y'] }, 0, 0).options, ['x', 'y']);
});

await test('calc.dropdownOptions：引用别的表，加载中放行，取不到给出原因', () => {
  const other = [['A类'], ['B类']];
  let state = 'loading';
  const link = {
    tableId: 'tbl_me',
    ext: (t, r) => {
      assert.equal(t, 'tbl_other');
      assert.equal(r, 'A1:A2');
      if (state === 'loading') return ERR.LOADING;
      if (state === 'denied') return ERR.REF;
      return new Ref({ cell: (i, j) => other[i]?.[j] ?? null }, 0, 0, 1, 0);
    },
  };
  const { calc } = setup([[]], link);
  const rule = { type: 'list', range: [0, 0, 9, 0], src: { table: 'tbl_other', range: 'A1:A2' } };
  assert.equal(calc.dropdownOptions(rule, 0, 0).loading, true);
  assert.equal(calc.checkValidation(rule, '随便', 0, 0), null);
  state = 'ok';
  assert.deepEqual(calc.dropdownOptions(rule, 0, 0).options, ['A类', 'B类']);
  assert.ok(calc.checkValidation(rule, '随便', 0, 0));
  state = 'denied';
  assert.match(calc.dropdownOptions(rule, 0, 0).error, /取不到/);
  // 离线网格没有跨表能力
  const off = setup([[]]).calc;
  assert.ok(off.dropdownOptions(rule, 0, 0).error);
});

await test('adjustProps：本表数据源区域跟着插删行列平移，别的表的不动', () => {
  const props = { validations: [
    { type: 'cascade', range: [1, 4, 100, 6], src: { range: 'A:C', header: true } },
    { type: 'list', range: [0, 8, 9, 8], src: { range: 'B2:B20' } },
    { type: 'list', range: [0, 9, 9, 9], src: { table: 'tbl_x', range: 'A:A' } },
  ] };
  const ins = adjustProps(props, 'col', 0, 1).validations;
  assert.equal(ins[0].src.range, 'B:D');
  assert.deepEqual(ins[0].range, [1, 5, 100, 7]);
  assert.equal(ins[1].src.range, 'C2:C20');
  assert.equal(ins[2].src.range, 'A:A');
  const rows = adjustProps(props, 'row', 0, 2).validations;
  assert.equal(rows[0].src.range, 'A:C');
  assert.equal(rows[1].src.range, 'B4:B22');
  const del = adjustProps(props, 'col', 1, -1).validations;
  assert.equal(del[0].src.range, 'A:B');
  assert.equal(del[1].src.range, 'B2:B20');   // 数据源整个被删：原文保留
});

await test('adjustProps：冻结行列数跟着冻结区里的插删变化', () => {
  const props = { freeze: { r: 2, c: 1 } };
  assert.deepEqual(adjustProps(props, 'row', 0, 3).freeze, { r: 5, c: 1 });
  assert.equal(adjustProps(props, 'row', 2, 3).freeze, undefined, '冻结线以下插入不动');
  assert.deepEqual(adjustProps(props, 'row', 1, -5).freeze, { r: 1, c: 1 });
  assert.deepEqual(adjustProps(props, 'col', 0, -1).freeze, { r: 2, c: 0 });
  assert.equal(adjustProps({ freeze: { r: 0, c: 1 } }, 'col', 0, -2).freeze, null, '全删掉就取消冻结');
});

if (failures) { console.error(`\n${failures} 个下拉列表测试失败`); process.exit(1); }
console.log('\n下拉列表 / 多级下拉测试全部通过');
