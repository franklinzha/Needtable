/**
 * 图表绘制（public/js/grid/chartdraw.js，纯模块，不碰 DOM）：
 *   · chartData 按列 / 按行取系列，表头、分类列识别
 *   · 每种图表（含堆积、平滑、数值标签、各图例位置）都能画完并返回可悬停的点
 *   · valueScale 尊重 yMin / yMax，堆积时刻度覆盖总和
 *   · hitTest 命中矩形 / 扇区 / 最近的点
 */

import assert from 'node:assert/strict';

const {
  chartData, drawChart, hitTest, valueScale, colorAt, numFormatter,
  CHART_TYPES, CHART_PRESETS, INSERT_CHARTS, PALETTES,
} = await import('../public/js/grid/chartdraw.js');

let failures = 0;
async function test(name, fn) {
  try { await fn(); console.log('  ok   ' + name); }
  catch (err) { failures++; console.error('  FAIL ' + name + '\n       ' + (err.stack ?? err.message)); }
}

/** 二维数组当表格用 */
function fakeGrid(rows) {
  const get = (r, c) => rows[r]?.[c] ?? '';
  return {
    model: { rowCount: 1000, colCount: 100, getCell: (r, c) => String(get(r, c)), colTitle: () => '' },
    calc: { value: (r, c) => get(r, c), text: (r, c) => String(get(r, c)) },
  };
}

/** 记录调用、什么都不画的 2D context */
function fakeCtx() {
  const calls = [];
  const noop = (name) => (...a) => { calls.push(name); };
  const ctx = new Proxy({ calls, measureText: (t) => ({ width: String(t).length * 7 }) }, {
    get(t, k) { return k in t ? t[k] : (t[k] = noop(String(k))); },
    set(t, k, v) { t[k] = v; return true; },
  });
  return ctx;
}

const TABLE = [
  ['月份', '销售', '成本'],
  ['1月', 120, 80],
  ['2月', 150, 90],
  ['3月', 90, 60],
];
const g = fakeGrid(TABLE);
const RANGE = [0, 0, 3, 2];

await test('按列：首列是分类，其余各列一个系列', () => {
  const d = chartData(g, { type: 'column', range: RANGE });
  assert.deepEqual(d.labels, ['1月', '2月', '3月']);
  assert.deepEqual(d.series.map((s) => s.name), ['销售', '成本']);
  assert.deepEqual(d.series[0].values, [120, 150, 90]);
});

await test('按行：首行是分类，其余各行一个系列', () => {
  const d = chartData(g, { type: 'column', range: RANGE, seriesIn: 'rows' });
  assert.deepEqual(d.labels, ['销售', '成本']);
  assert.deepEqual(d.series.map((s) => s.name), ['1月', '2月', '3月']);
  assert.deepEqual(d.series[1].values, [150, 90]);
});

await test('没有表头时系列按序号命名', () => {
  const d = chartData(fakeGrid([[1, 2], [3, 4]]), { type: 'line', range: [0, 0, 1, 1], header: false });
  assert.deepEqual(d.series.map((s) => s.name), ['系列1', '系列2']);
  assert.equal(d.labels.length, 2);
});

await test('空区域返回空数据', () => {
  const d = chartData(g, { type: 'column', range: [0, 0, -1, -1] });
  assert.deepEqual(d, { labels: [], series: [], xs: null });
});

const variants = [
  {}, { stacked: true }, { smooth: true }, { labels: true }, { legend: 'top' }, { legend: 'right' }, { legend: 'none' },
  { title: '标题', subtitle: '副标题', xTitle: 'X', yTitle: 'Y' }, { yMin: 0, yMax: 500 }, { gridlines: false },
  { numfmt: '0%' }, { palette: 'warm', colors: ['#ff0000'] }, { seriesIn: 'rows' },
];
await test('每种图表 × 各种选项都能画完，并返回悬停点', () => {
  for (const [type] of CHART_TYPES) {
    for (const v of variants) {
      const chart = { type, range: RANGE, ...v };
      const ctx = fakeCtx();
      const data = chartData(g, chart);
      const hits = drawChart(ctx, 480, 300, chart, data, {});
      assert.ok(Array.isArray(hits), type + ' 返回 hits');
      // 雷达图少于 3 个分类时只画一行提示
      if (type === 'radar' && data.labels.length < 3) { assert.ok(ctx.calls.includes('fillText')); continue; }
      assert.ok(hits.length > 0, type + ' ' + JSON.stringify(v) + ' 应有悬停点');
      assert.ok(ctx.calls.length > 0, type + ' 应该画了东西');
    }
  }
});

await test('没有数据也不抛错', () => {
  for (const [type] of CHART_TYPES) {
    const hits = drawChart(fakeCtx(), 300, 200, { type, range: [0, 0, -1, -1] }, { labels: [], series: [], xs: null }, {});
    assert.ok(Array.isArray(hits));
  }
});

await test('插入菜单包含堆积预设，预设都指向真实类型', () => {
  const ids = INSERT_CHARTS.map(([t]) => t);
  for (const k of Object.keys(CHART_PRESETS)) {
    assert.ok(ids.includes(k), k);
    assert.ok(CHART_TYPES.some(([t]) => t === CHART_PRESETS[k].type), k);
  }
});

await test('valueScale：yMin / yMax 覆盖自动范围', () => {
  const auto = valueScale(3, 97, true, {});
  assert.ok(auto.lo <= 0 && auto.hi >= 97);
  const fixed = valueScale(3, 97, true, { yMin: 10, yMax: 200 });
  assert.equal(fixed.lo, 10);
  assert.equal(fixed.hi, 200);
  assert.ok(fixed.ticks.every((t) => t >= 10 && t <= 200));
});

await test('堆积柱形图的矩形顶到总和', () => {
  const chart = { type: 'column', stacked: true, range: RANGE, legend: 'none' };
  const hits = drawChart(fakeCtx(), 480, 300, chart, chartData(g, chart), {});
  const rects = hits.filter((x) => x.shape === 'rect' && x.label === '2月');
  assert.equal(rects.length, 2);
  const [a, b] = rects.sort((p, q) => p.y - q.y);
  assert.ok(Math.abs(a.y + a.h - b.y) < 1.01, '两段首尾相接');
});

await test('hitTest：矩形、扇区、最近的点', () => {
  const hits = [
    { shape: 'rect', x: 10, y: 10, w: 20, h: 40, name: 'r' },
    { shape: 'arc', cx: 200, cy: 200, r0: 0, r1: 50, a0: 0, a1: Math.PI / 2, name: 'a' },
    { shape: 'pt', x: 400, y: 100, name: 'p1' },
    { shape: 'pt', x: 406, y: 100, name: 'p2' },
  ];
  assert.equal(hitTest(hits, 15, 30)?.name, 'r');
  assert.equal(hitTest(hits, 220, 220)?.name, 'a');
  assert.equal(hitTest(hits, 180, 180), null, '扇区角度外');
  assert.equal(hitTest(hits, 405, 101)?.name, 'p2');
  assert.equal(hitTest(hits, 450, 100), null, '12px 之外');
});

await test('配色：自定义颜色优先，其余用方案里的颜色', () => {
  const warm = PALETTES.find((p) => p[0] === 'warm')[2];
  assert.equal(colorAt({ palette: 'warm', colors: ['#123456'] }, 0), '#123456');
  assert.equal(colorAt({ palette: 'warm', colors: ['#123456'] }, 1), warm[1]);
  assert.equal(colorAt({}, 0), PALETTES[0][2][0]);
});

await test('数字格式作用于刻度与提示', () => {
  assert.equal(numFormatter({ numfmt: '0%' })(0.25), '25%');
  assert.equal(numFormatter({ numfmt: '#,##0' })(12345), '12,345');
  assert.equal(numFormatter({})(123456789), numFormatter({ numfmt: '' })(123456789));
});

await test('饼图：小扇区的标签放不下就不画，标签之间互不重叠', () => {
  for (const type of ['pie', 'doughnut']) {
    const ctx = fakeCtx();
    const texts = [];
    ctx.fillText = (s, x, y) => texts.push({ s, x, y, w: String(s).length * 7 + 4 });
    const vals = [40, 5, 5, 5, 5, 5, 35];
    const data = { labels: vals.map((_, i) => '项' + i), series: [{ name: '值', values: vals }], xs: null };
    drawChart(ctx, 240, 160, { type, labels: true, legend: 'none', range: [0, 0, -1, -1] }, data, {});
    const labels = texts.filter((t) => t.s !== '合计为 0' && !String(t.s).startsWith('项'));
    assert.ok(labels.length >= 2 && labels.length <= 5, type + ' 只有大扇区有标签：' + labels.map((t) => t.s));
    for (let i = 0; i < labels.length; i++) for (let j = i + 1; j < labels.length; j++) {
      const p = labels[i], q = labels[j];
      const overlap = Math.abs(p.x - q.x) < (p.w + q.w) / 2 && Math.abs(p.y - q.y) < 12;
      assert.ok(!overlap, type + ' 标签重叠：' + p.s + ' / ' + q.s);
    }
  }
});

if (failures) { console.error(`\n${failures} 个图表测试失败`); process.exit(1); }
console.log('\n图表测试全部通过');
