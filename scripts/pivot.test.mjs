/**
 * 透视表计算（grid/pivotcalc.js）、仪表盘布局（views/dashlayout.js）、插删行列时的属性平移。
 * 纯逻辑，不需要 DOM。
 */
import assert from 'node:assert/strict';
const P = await import('../public/js/grid/pivotcalc.js');
const L = await import('../public/js/views/dashlayout.js');
const { adjustProps } = await import('../public/shared/model/sheet.js');

let failures = 0;
async function test(name, fn) {
  try { await fn(); console.log('  ok   ' + name); }
  catch (err) { failures++; console.error('  FAIL ' + name + '\n       ' + (err.stack ?? err.message)); }
}

const DATA = [
  ['地区', '产品', '销量', '备注'],
  ['华东', '苹果', 10, 'x'],
  ['华北', '苹果', 5, ''],
  ['华东', '香蕉', 3, ''],
  ['', '', '', ''],
  ['华东', '苹果', 7, ''],
  ['', '香蕉', 4, ''],
];
const value = (r, c) => { const v = DATA[r]?.[c]; return v === '' ? null : v; };
const text = (r, c) => String(DATA[r]?.[c] ?? '');
const def = (o) => ({ id: 'p1', name: '透视表1', range: [0, 0, DATA.length - 1, 3], header: true, rows: [0], col: null, values: [{ col: 2, agg: 'sum' }], ...o });

await test('按行分组求和，空白排最后，整行空白跳过', () => {
  const res = P.computePivot(def(), value, text);
  assert.deepEqual(res.rowFields, ['地区']);
  assert.deepEqual(res.valueLabels, ['求和项:销量']);
  assert.deepEqual(res.rows.map((r) => [r.keys[0], r.total[0]]), [['华北', 5], ['华东', 20], [P.BLANK, 4]]);
  assert.deepEqual(res.total.total, [29]);
  assert.equal(res.error, '');
});

await test('计数 / 平均值：总计按原始数据算，不是各组平均的平均', () => {
  const res = P.computePivot(def({ values: [{ col: 2, agg: 'count' }, { col: 2, agg: 'avg' }] }), value, text);
  const hd = res.rows.find((r) => r.keys[0] === '华东');
  assert.deepEqual(hd.total, [3, 20 / 3]);
  assert.deepEqual(res.total.total, [5, 29 / 5]);
});

await test('列字段：交叉表 + 行 / 列总计', () => {
  const res = P.computePivot(def({ col: 1 }), value, text);
  assert.deepEqual(res.colKeys, [['苹果'], ['香蕉']]);
  const hd = res.rows.find((r) => r.keys[0] === '华东');
  assert.deepEqual(hd.cells, [17, 3]);
  const hb = res.rows.find((r) => r.keys[0] === '华北');
  assert.deepEqual(hb.cells, [5, null]);
  assert.deepEqual(res.total.cells, [22, 7]);
  assert.deepEqual(res.total.total, [29]);
});

await test('没有表头：首行也算数据，字段名用列名', () => {
  const res = P.computePivot(def({ header: false, range: [1, 0, 3, 3] }), value, text, (c) => 'COL' + c);
  assert.deepEqual(res.rowFields, ['COL0']);
  assert.deepEqual(res.total.total, [18]);
});

await test('一个字段都没有 → 错误；只有行字段也能算；validPivot 检查范围', () => {
  assert.ok(P.computePivot(def({ rows: [], values: [{ col: 9, agg: 'sum' }] }), value, text).error);
  const only = P.computePivot(def({ values: [] }), value, text);
  assert.equal(only.error, '');
  assert.deepEqual(only.rows.map((r) => r.keys[0]), ['华北', '华东', P.BLANK]);
  assert.equal(P.validPivot(def()), true);
  assert.equal(P.validPivot({ range: [0, 0, 1] , values: [{ col: 0 }] }), false);
  assert.equal(P.validPivot(null), false);
});

await test('默认名跳过已占用；名称清洗', () => {
  assert.equal(P.nextPivotName([]), '透视表1');
  assert.equal(P.nextPivotName([{ name: '透视表1' }, { name: '透视表3' }]), '透视表2');
  assert.equal(P.cleanPivotName('  a \n b  '), 'a b');
  assert.equal(P.cleanPivotName('x'.repeat(50)).length, 30);
  assert.equal(P.MAX_PIVOTS, 5);
});

await test('dashlayout.arrange：保存的顺序优先，新项追加，已删的丢弃', () => {
  const items = L.arrange(['c:a', 'c:b', 'p:x'], { order: ['p:x', 'c:gone', 'c:a'], hidden: ['c:a'], wide: ['p:x'] });
  assert.deepEqual(items, [
    { id: 'p:x', hidden: false, wide: true },
    { id: 'c:a', hidden: true, wide: false },
    { id: 'c:b', hidden: false, wide: false },
  ]);
  assert.deepEqual(L.arrange(['c:a'], undefined), [{ id: 'c:a', hidden: false, wide: false }]);
});

await test('dashlayout.moveItem：前 / 后插入，没动返回 null', () => {
  const o = ['a', 'b', 'c', 'd'];
  assert.deepEqual(L.moveItem(o, 'd', 'a'), ['d', 'a', 'b', 'c']);
  assert.deepEqual(L.moveItem(o, 'a', 'c', true), ['b', 'c', 'a', 'd']);
  assert.equal(L.moveItem(o, 'a', 'b'), null);
  assert.equal(L.moveItem(o, 'a', 'a'), null);
  assert.equal(L.moveItem(o, 'z', 'a'), null);
});

await test('dashlayout.nextLayout：切换隐藏 / 整行，拖动时换顺序', () => {
  const items = L.arrange(['c:a', 'p:x'], { hidden: ['p:x'] });
  assert.deepEqual(L.nextLayout(items, 'hidden', 'p:x'), { order: ['c:a', 'p:x'], hidden: [], wide: [] });
  assert.deepEqual(L.nextLayout(items, 'wide', 'c:a'), { order: ['c:a', 'p:x'], hidden: ['p:x'], wide: ['c:a'] });
  assert.deepEqual(L.nextLayout(items, null, undefined, ['p:x', 'c:a']).order, ['p:x', 'c:a']);
});

await test('adjustProps：插删列平移透视表字段与指标卡列号，布局保留', () => {
  const props = {
    pivots: [def({ rows: [0, 1], col: 1, values: [{ col: 2, agg: 'sum' }] })],
    dashboard: { kpis: [{ col: 2, agg: 'sum' }], layout: { order: ['p:p1'], hidden: [], wide: [] } },
  };
  const ins = adjustProps(props, 'col', 1, 1);
  assert.deepEqual(ins.pivots[0].range, [0, 0, 6, 4]);
  assert.deepEqual(ins.pivots[0].rows, [0, 2]);
  assert.equal(ins.pivots[0].col, 2);
  assert.equal(ins.pivots[0].values[0].col, 3);
  assert.equal(ins.dashboard.kpis[0].col, 3);
  assert.deepEqual(ins.dashboard.layout, props.dashboard.layout);

  const del = adjustProps(props, 'col', 1, -1);
  assert.deepEqual(del.pivots[0].rows, [0]);
  assert.equal(del.pivots[0].col, null);
  assert.equal(del.pivots[0].values[0].col, 1);

  const rows = adjustProps(props, 'row', 0, 2);
  assert.deepEqual(rows.pivots[0].range, [2, 0, 8, 3]);
  // 行方向不碰 dashboard，也不能崩
  assert.ok(!rows.dashboard || rows.dashboard.kpis[0].col === 2);
});

// ── 字段列表版透视表 ──────────────────────────────────────────────────────

await test('聚合：中位数 / 去重计数 / 最大最小 / 标准差', () => {
  const vals = ['median', 'distinct', 'max', 'min', 'stdev', 'countNum'].map((agg) => ({ col: 2, agg }));
  const res = P.computePivot(def({ values: vals }), value, text);
  const hd = res.rows.find((r) => r.keys[0] === '华东');
  // 华东：10, 3, 7
  assert.equal(hd.total[0], 7);
  assert.equal(hd.total[1], 3);
  assert.equal(hd.total[2], 10);
  assert.equal(hd.total[3], 3);
  assert.ok(Math.abs(hd.total[4] - Math.sqrt(((10 - 20 / 3) ** 2 + (3 - 20 / 3) ** 2 + (7 - 20 / 3) ** 2) / 2)) < 1e-9);
  assert.equal(hd.total[5], 3);
  // 全部 10,5,3,7,4 → 中位数 5；去重计数：产品列 苹果/香蕉 = 2
  assert.equal(res.total.total[0], 5);
  const d = P.computePivot(def({ values: [{ col: 1, agg: 'distinct' }] }), value, text);
  assert.equal(d.total.total[0], 2);
  assert.deepEqual(d.valueLabels, ['去重计数项:产品']);
});

await test('值显示方式：总计 / 列汇总 / 行汇总的百分比', () => {
  const vals = [{ col: 2, agg: 'sum', show: 'pctGrand' }, { col: 2, agg: 'sum', show: 'pctCol' }, { col: 2, agg: 'sum', show: 'pctRow' }];
  const res = P.computePivot(def({ cols: [1], values: vals }), value, text);
  assert.deepEqual(res.valuePct, [true, true, true]);
  assert.equal(res.valueLabels[1], '求和项:销量（列汇总的百分比）');
  const hd = res.rows.find((r) => r.keys[0] === '华东');
  // 华东 苹果 17 / 香蕉 3；列合计 苹果 22 香蕉 7；总计 29
  const nv = 3;
  const cell = (row, k, i) => row.cells[k * nv + i];
  assert.equal(cell(hd, 0, 0), 17 / 29);
  assert.equal(cell(hd, 0, 1), 17 / 22);
  assert.equal(cell(hd, 1, 1), 3 / 7);
  assert.equal(cell(hd, 0, 2), 17 / 20);
  assert.equal(cell(hd, 1, 2), 3 / 20);
  assert.equal(hd.total[0], 20 / 29);
  assert.equal(hd.total[1], 20 / 29);
  assert.equal(hd.total[2], 1);
  assert.equal(cell(res.total, 0, 1), 1);
  assert.equal(cell(res.total, 0, 0), 22 / 29);
  assert.equal(res.total.total[0], 1);
  assert.equal(P.fmtPivot(17 / 22, true, { dec: 1 }), '77.3%');
  assert.equal(P.fmtPivot(null, false, { empty: '-' }), '-');
  assert.equal(P.fmtPivot(1234.5, false, { dec: 0 }), '1,235');
});

await test('筛选：hide 里的取值不参与计算（筛选区 / 行字段都生效）', () => {
  const res = P.computePivot(def({ filters: [1], hide: { 1: ['香蕉'] } }), value, text);
  assert.deepEqual(res.rows.map((r) => [r.keys[0], r.total[0]]), [['华北', 5], ['华东', 17]]);
  assert.deepEqual(res.total.total, [22]);
  const r2 = P.computePivot(def({ hide: { 0: ['华东', P.BLANK] } }), value, text);
  assert.deepEqual(r2.rows.map((r) => r.keys[0]), ['华北']);
});

await test('多个行 / 列字段：分类汇总行、按值降序', () => {
  const res = P.computePivot(def({ rows: [0, 1], opts: { subtotals: true, sort: 'valDesc' } }), value, text);
  // 华东 20 > 华北 5 > (空白) 4；华东内 苹果 17 > 香蕉 3
  assert.deepEqual(res.rows.map((r) => [r.keys.join('/'), r.sub ?? null, r.total[0]]), [
    ['华东/苹果', null, 17], ['华东/香蕉', null, 3], ['华东', 0, 20],
    ['华北/苹果', null, 5], ['华北', 0, 5],
    [P.BLANK + '/香蕉', null, 4], [P.BLANK, 0, 4],
  ]);
  const two = P.computePivot(def({ rows: [], cols: [0, 1] }), value, text);
  assert.deepEqual(two.colKeys, [['华北', '苹果'], ['华东', '苹果'], ['华东', '香蕉'], [P.BLANK, '香蕉']]);
  assert.deepEqual(two.total.cells, [5, 17, 3, 4]);
  assert.deepEqual(two.rows.map((r) => r.keys), [[]]);   // 没有行字段：只有一行（视图里只画总计行）
});

await test('按指定值字段 / 指定列排序', () => {
  // 按「香蕉」这一列升序：华北(无香蕉) 最小排前，华东 3，(空白) 4
  const res = P.computePivot(def({ cols: [1], opts: { sort: 'valAsc', sortCol: ['香蕉'] } }), value, text);
  assert.deepEqual(res.rows.map((r) => r.keys[0]), ['华北', '华东', P.BLANK]);
  assert.deepEqual(res.sortKey, { v: 0, col: ['香蕉'], dir: 'asc' });
  // 第二个值字段（计数）降序：华东 3 条排第一
  const r2 = P.computePivot(def({ values: [{ col: 2, agg: 'max' }, { col: 2, agg: 'count' }], opts: { sort: 'valDesc', sortVal: 1 } }), value, text);
  assert.equal(r2.rows[0].keys[0], '华东');
  assert.equal(r2.sortKey.v, 1);
  // 指定的列不存在（被筛掉）就按总计
  const r3 = P.computePivot(def({ cols: [1], hide: { 1: ['香蕉'] }, opts: { sort: 'valDesc', sortCol: ['香蕉'] } }), value, text);
  assert.equal(r3.sortKey.col, null);
  assert.deepEqual(r3.rows.map((r) => r.keys[0]), ['华东', '华北']);
  // 越界的 sortVal 回落到 0
  assert.equal(P.normPivot(def({ opts: { sortVal: 5 } })).opts.sortVal, 0);
});

await test('旧定义（单个 col）照样能算；normPivot 补缺省', () => {
  const n = P.normPivot({ range: [0, 0, 1, 1], col: 3, values: [{ col: 1, agg: 'bogus' }] });
  assert.deepEqual(n.cols, [3]);
  assert.deepEqual(n.values, [{ col: 1, agg: 'sum', show: 'none' }]);
  assert.equal(n.opts.rowTotals, true);
  assert.equal(n.opts.subtotals, false);
  assert.equal(n.opts.sort, 'asc');
});

await test('moveField：勾选 / 拖动 / 挪区域 / 移除，筛选行列互斥，值可重复，受上限约束', () => {
  const d0 = def({ rows: [0], values: [{ col: 2, agg: 'sum' }] });
  const a = P.moveField(d0, { area: 'list', col: 1 }, { area: 'cols' });
  assert.deepEqual(a.cols, [1]);
  assert.ok(!('col' in a));
  const b = P.moveField(a, { area: 'cols', index: 0, col: 1 }, { area: 'rows', index: 0 });
  assert.deepEqual([b.rows, b.cols], [[1, 0], []]);
  // 拖到同一区域后面
  const c = P.moveField(b, { area: 'rows', index: 0, col: 1 }, { area: 'rows', index: 2 });
  assert.deepEqual(c.rows, [0, 1]);
  // 三个字段时「下移」（index + 2）只挪一格
  assert.deepEqual(P.moveField(def({ rows: [0, 1, 2] }), { area: 'rows', index: 0, col: 0 }, { area: 'rows', index: 2 }).rows, [1, 0, 2]);
  // 从清单拖一个已在行里的字段到筛选：从行里拿掉
  const f = P.moveField(c, { area: 'list', col: 0 }, { area: 'filters' });
  assert.deepEqual([f.filters, f.rows], [[0], [1]]);
  // 值区域：同一字段可以放两次
  const v = P.moveField(c, { area: 'list', col: 2 }, { area: 'values' });
  assert.deepEqual(v.values.map((x) => x.col), [2, 2]);
  const vr = P.moveField(v, { area: 'values', index: 0, col: 2 }, { area: 'remove' });
  assert.equal(vr.values.length, 1);
  // 列区域上限 2
  const full = def({ cols: [0, 1] });
  assert.equal(P.moveField(full, { area: 'list', col: 3 }, { area: 'cols' }), null);
  // 没变化 → null
  assert.equal(P.moveField(c, { area: 'rows', index: 0, col: 0 }, { area: 'rows', index: 0 }), null);
  assert.equal(P.fieldUsed(c, 1), true);
  assert.equal(P.fieldUsed(c, 3), false);
});

await test('fieldValues / looksNumeric', () => {
  assert.deepEqual(P.fieldValues(def(), 0, text), ['华北', '华东', P.BLANK]);
  assert.equal(P.looksNumeric(def(), 2, value), true);
  assert.equal(P.looksNumeric(def(), 0, value), false);
});

await test('adjustProps：插删列平移 cols / filters / hide，被删的字段丢弃', () => {
  const props = { pivots: [def({ rows: [0], cols: [1], filters: [3], hide: { 1: ['香蕉'], 3: ['x'] } })] };
  const ins = adjustProps(props, 'col', 1, 1).pivots[0];
  assert.deepEqual([ins.cols, ins.filters], [[2], [4]]);
  assert.deepEqual(ins.hide, { 2: ['香蕉'], 4: ['x'] });
  const del = adjustProps(props, 'col', 1, -1).pivots[0];
  assert.deepEqual([del.cols, del.filters], [[], [2]]);
  assert.deepEqual(del.hide, { 2: ['x'] });
});

await test('dashlayout：拖大小存进 sizes，切换整行清掉宽度，删除项的大小丢弃', () => {
  const items = L.arrange(['c:a', 'p:x'], { sizes: { 'c:a': { w: 2, h: 400 }, 'p:x': { h: 50 }, 'c:gone': { h: 300 } } });
  assert.deepEqual(items[0].size, { w: 2, h: 400 });
  assert.deepEqual(items[1].size, { h: L.MIN_H });
  const t = L.nextLayout(items, 'wide', 'c:a');
  assert.deepEqual(t.sizes, { 'c:a': { h: 400 }, 'p:x': { h: L.MIN_H } });
  assert.deepEqual(t.wide, ['c:a']);
  const r = L.resizeLayout(items, 'p:x', { span: 3, cols: 3, h: 520 });
  assert.deepEqual(r.wide, ['p:x']);
  assert.deepEqual(r.sizes['p:x'], { h: 520 });
  const r2 = L.resizeLayout(L.arrange(['c:a'], { wide: ['c:a'] }), 'c:a', { span: 1, cols: 3, h: 9999 });
  assert.deepEqual([r2.wide, r2.sizes['c:a']], [[], { w: 1, h: L.MAX_H }]);
  const r3 = L.resizeLayout(items, 'c:a', { span: 1, cols: 1, h: 300 });
  assert.deepEqual(r3.sizes['c:a'], { w: 2, h: 300 });
});

await test('pivotMatrix：表头 / 数据 / 总计，外层标签只写第一行，列字段展开', () => {
  const mat = P.pivotMatrix(P.computePivot(def({ rows: [0, 1] }), value, text));
  assert.equal(mat.keyCols, 2);
  assert.deepEqual(mat.rows[0].slice(0, 2).map((c) => c.v), ['地区', '产品']);
  assert.equal(mat.kinds[0], 'head');
  assert.equal(mat.kinds.at(-1), 'total');
  assert.deepEqual(mat.rows.at(-1).map((c) => c.v), ['总计', '', 29]);
  const ea = mat.rows.findIndex((r) => r[0].v === '华东');
  assert.deepEqual(mat.rows[ea].map((c) => c.v), ['华东', '苹果', 17]);
  assert.deepEqual(mat.rows[ea + 1].map((c) => c.v), ['', '香蕉', 3]);

  // 一层列字段 + 一个值字段：只有一行表头，行字段名在第一格，后面是列取值和总计
  const m2 = P.pivotMatrix(P.computePivot(def({ rows: [0], cols: [1] }), value, text));
  assert.equal(m2.kinds.filter((k) => k === 'head').length, 1);
  assert.deepEqual(m2.rows[0].map((c) => c.v), ['地区', '苹果', '香蕉', '总计']);
  assert.equal(m2.rows.at(-1).length, 4);
});

await test('报表布局：重复标签 / 大纲 / 压缩 / 汇总在顶部 / 空行 / 合并', () => {
  const v = (m) => m.rows.map((r) => r.map((c) => c.v));
  const run = (opts) => P.pivotMatrix(P.computePivot(def({ rows: [0, 1], opts }), value, text));
  // 表格形式 + 重复所有项目标签
  const rep = v(run({ repeat: true }));
  assert.deepEqual(rep.slice(1, 4), [['华北', '苹果', 5], ['华东', '苹果', 17], ['华东', '香蕉', 3]]);
  // 大纲形式：外层项目单独一行（值为空），下一层从下一行起
  const out = run({ layout: 'outline' });
  assert.deepEqual(v(out).slice(1, 6), [['华北', '', null], ['', '苹果', 5], ['华东', '', null], ['', '苹果', 17], ['', '香蕉', 3]]);
  assert.equal(out.kinds[1], 'group');
  // 大纲 + 分类汇总放顶部：外层行带汇总值，底部不再有「汇总」行
  const top = v(run({ layout: 'outline', subtotals: true, subTop: true }));
  assert.deepEqual(top[3], ['华东', '', 20]);
  assert.ok(!top.some((r) => String(r[0]).endsWith('汇总') || String(r[1]).endsWith('汇总')));
  // 压缩形式：一列，按层缩进
  const cmp = run({ layout: 'compact' });
  assert.equal(cmp.keyCols, 1);
  assert.deepEqual(v(cmp)[0], ['地区 / 产品', '求和项:销量']);
  assert.deepEqual(v(cmp).slice(1, 3), [['华北', null], ['　苹果', 5]]);
  // 每项后空行：最后一项后面不加
  const bl = run({ blank: true });
  assert.deepEqual(bl.kinds, ['head', '', 'blank', '', '', 'blank', '', 'total']);
  // 合并：华东两行合并成一格
  const mg = run({ merge: true });
  assert.deepEqual(mg.merges, [[2, 0, 3, 0]]);
  // 表格形式 + 汇总在顶部：「汇总」行排在组前面
  const tt = v(run({ subtotals: true, subTop: true }));
  assert.deepEqual(tt.slice(1, 3), [['华北 汇总', '', 5], ['华北', '苹果', 5]]);
});

await test('只显示前 N 项：按当前排序取外层前 N 个，总计只算显示的', () => {
  const res = P.computePivot(def({ opts: { sort: 'valDesc', top: 1 } }), value, text);
  assert.deepEqual(res.rows.map((r) => r.keys[0]), ['华东']);
  assert.deepEqual(res.total.total, [20]);
  assert.equal(res.topHidden, 2);
  assert.equal(res.opts.top, 1);
  assert.equal(P.normPivot(def({ opts: { top: -3, layout: 'x' } })).opts.top, 0);
  assert.equal(P.normPivot(def({ opts: { layout: 'x' } })).opts.layout, 'tabular');
});

await test('只显示前 N 项：按值字段总计排名（最大 / 最小、指定值字段、作用于列）', () => {
  // 按标签排序也按值取前 N：华东 20 最大
  const a = P.computePivot(def({ opts: { top: 1 } }), value, text);
  assert.deepEqual(a.rows.map((r) => r.keys[0]), ['华东']);
  assert.deepEqual(a.topInfo, { field: '地区', by: '求和项:销量', dir: 'max' });
  // 最小：空白 4 < 华北 5
  const b = P.computePivot(def({ opts: { top: 1, topDir: 'min' } }), value, text);
  assert.deepEqual(b.rows.map((r) => r.keys[0]), [P.BLANK]);
  // 按第二个值字段（计数）：华东 3，华北 / 空白 各 1 一样大按标签 → 华北
  const c = P.computePivot(def({ values: [{ col: 2, agg: 'sum' }, { col: 2, agg: 'count' }], opts: { top: 2, topVal: 1 } }), value, text);
  assert.deepEqual(c.rows.map((r) => r.keys[0]), ['华北', '华东']);
  assert.equal(c.topInfo.by, '计数项:销量');
  // 作用于列：产品 苹果 22 > 香蕉 7
  const d = P.computePivot(def({ cols: [1], opts: { top: 1, topOn: 'cols' } }), value, text);
  assert.deepEqual(d.colKeys, [['苹果']]);
  assert.deepEqual(d.total.total, [22]);
  assert.equal(d.topInfo.field, '产品');
  // 旧定义「按值升序」没有 topDir → 取最小
  assert.equal(P.normPivot(def({ opts: { top: 1, sort: 'valAsc' } })).opts.topDir, 'min');
});

await test('值显示格式：每个值字段自己的格式和小数位；旧的整表小数位兜底', () => {
  assert.equal(P.fmtPivot(1234.5, false, { fmt: 'cny' }), '¥1,234.50');
  assert.equal(P.fmtPivot(-1234.5, false, { fmt: 'usd', dec: 0 }), '-$1,235');
  assert.equal(P.fmtPivot(12345.6, false, { fmt: 'plain' }), '12345.6');
  assert.equal(P.fmtPivot(0.123, false, { fmt: 'pct', dec: 1 }), '12.3%');
  const res = P.computePivot(def({ values: [{ col: 2, agg: 'avg', dec: 3 }, { col: 2, agg: 'avg', fmt: 'cny' }], opts: { dec: 1 } }), value, text);
  assert.deepEqual(res.valueFmt, [{ fmt: 'auto', dec: 3 }, { fmt: 'cny', dec: 1 }]);
  assert.equal(P.fmtValue(res, 20 / 3, 0), '6.667');
  assert.equal(P.fmtValue(res, 20 / 3, 1), '¥6.7');
  const m = P.pivotMatrix(res);
  assert.deepEqual(m.rows[1][2].f, { fmt: 'cny', dec: 1 });
  const n = P.normPivot(def({ values: [{ col: 2, fmt: 'bad', dec: 9 }, { col: 2, fmt: 'auto' }] })).values;
  assert.deepEqual(n, [{ col: 2, agg: 'sum', show: 'none' }, { col: 2, agg: 'sum', show: 'none' }]);
});

await test('重命名：值字段 name、行列字段 labels；插删列时 labels 跟着平移', () => {
  const res = P.computePivot(def({ cols: [1], values: [{ col: 2, agg: 'sum', name: '  总销量 ' }], labels: { 0: '区域', 1: '' } }), value, text);
  assert.deepEqual(res.valueLabels, ['总销量']);
  assert.deepEqual(res.rowFields, ['区域']);
  assert.deepEqual(res.colFields, ['产品']);
  const p = def({ labels: { 0: '区域' } });
  assert.equal(P.fieldName(p, 0, text, String), '区域');
  assert.equal(P.fieldName(p, 0, text, String, true), '地区');
  const out = adjustProps({ pivots: [def({ labels: { 0: '区域', 2: '量' } })] }, 'col', 1, 1);
  assert.deepEqual(out.pivots[0].labels, { 0: '区域', 3: '量' });
  const del = adjustProps({ pivots: [def({ labels: { 0: '区域', 2: '量' } })] }, 'col', 0, -1);
  assert.deepEqual(del.pivots[0].labels, { 1: '量' });
});

if (failures) { console.error(`\n${failures} 个透视表测试失败`); process.exit(1); }
console.log('\n透视表 / 仪表盘布局测试全部通过');
