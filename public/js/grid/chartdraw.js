/**
 * 图表的取数与绘制 —— 纯函数，不碰 DOM（只用传进来的 2D context）。
 * 表格里的浮动图表、仪表盘、插入图表对话框的实时预览共用这一份。
 *
 * 图表对象（props.charts 的一项）除 id / x / y / w / h / range / type / title / header 外，
 * 以下字段全部可选，缺省就是老版本的样子：
 *   seriesIn  'cols' | 'rows'   系列按列还是按行取（切换行 / 列）
 *   stacked   柱形 / 条形 / 面积图堆积
 *   smooth    折线平滑
 *   labels    显示数值标签
 *   subtitle, xTitle, yTitle    副标题、横轴标题、纵轴标题
 *   legend    'bottom' | 'top' | 'right' | 'none'
 *   palette   PALETTES 的 id；colors 逐个系列覆盖（稀疏数组，null 表示用配色方案）
 *   yMin, yMax                  数值轴范围，null 表示自动
 *   gridlines 是否画网格线（默认画）
 *   numfmt    数字格式（numfmt.js 的格式串），空串表示自动（万 / 亿）
 */

import { formatValue } from '../../shared/formula/numfmt.js';
import { t as tt, currentLang, langTag } from '../../shared/i18n/i18n.js';

/** 用「万 / 亿」缩写大数的语言；其余语言用 Intl 的紧凑写法（K / M / B）。 */
export const WAN_LANGS = new Set(['zh', 'ja', 'ko']);

const MAX_POINTS = 500;
const MAX_SERIES = 10;
const FONT = '12px system-ui, sans-serif';

/** 配色方案：[id, 名称, 颜色]。第一个是默认，与老版本一致。 */
export const PALETTES = [
  ['office', tt('默认'), ['#4472c4', '#ed7d31', '#a5a5a5', '#ffc000', '#5b9bd5', '#70ad47', '#264478', '#9e480e', '#636363', '#997300']],
  ['dream', tt('梦幻马卡龙'), ['#ff85bd', '#6cc4ef', '#b98ae6', '#5fcf92', '#f0cf4a', '#ffb3d6', '#a9def9', '#dcb3f7', '#9fe3bb', '#f7e98f']],
  ['fresh', tt('清新'), ['#3ba1e8', '#2ec7c9', '#b6a2de', '#ffb980', '#d87a80', '#8d98b3', '#e5cf0d', '#97b552', '#95706d', '#dc69aa']],
  ['business', tt('商务'), ['#1f3a5f', '#3d6a99', '#7aa6c2', '#f2a541', '#8c8c8c', '#4b7f52', '#b04a3b', '#5c4b8a', '#2f7f7f', '#c9a227']],
  ['warm', tt('暖色'), ['#d94e41', '#f28c38', '#f6c143', '#8f5a3c', '#e27d9a', '#b8483f', '#f4a261', '#9c6644', '#e9c46a', '#c1666b']],
  ['mono', tt('单色蓝'), ['#08306b', '#2171b5', '#6baed6', '#08519c', '#4292c6', '#9ecae1', '#3f5f8f', '#1c4a7a', '#5d86b5', '#c6dbef']],
];
export const PALETTE = PALETTES[0][2];

/** 图表的基本类型（存进 chart.type 的只有这些）。 */
export const CHART_TYPES = [
  ['column', tt('柱形图')], ['bar', tt('条形图')], ['line', tt('折线图')], ['area', tt('面积图')], ['pie', tt('饼图')], ['doughnut', tt('圆环图')],
  ['scatter', tt('散点图')], ['combo', tt('组合图（柱 + 线）')], ['radar', tt('雷达图')], ['funnel', tt('漏斗图')],
];

/** 插入菜单里多出来的快捷项：本质是基本类型 + 选项。 */
export const CHART_PRESETS = {
  stackedColumn: { type: 'column', stacked: true },
  stackedBar: { type: 'bar', stacked: true },
  stackedArea: { type: 'area', stacked: true },
};

/** 插入图表菜单：堆积版本紧跟在各自的基本类型后面。 */
export const INSERT_CHARTS = CHART_TYPES.flatMap(([t, label]) => {
  const extra = { column: ['stackedColumn', tt('堆积柱形图')], bar: ['stackedBar', tt('堆积条形图')], area: ['stackedArea', tt('堆积面积图')] }[t];
  return extra ? [[t, label], extra] : [[t, label]];
});

/** 能堆积 / 能平滑 / 有坐标轴的类型。 */
export const CAN_STACK = new Set(['column', 'bar', 'area']);
export const CAN_SMOOTH = new Set(['line', 'area', 'combo', 'radar']);
export const HAS_AXES = new Set(['column', 'bar', 'line', 'area', 'scatter', 'combo', 'radar']);

/** 图例位置与数字格式的可选项（对话框用）。 */
export const LEGEND_POS = [['bottom', tt('底部')], ['top', tt('顶部')], ['right', tt('右侧')], ['none', tt('不显示')]];
export const NUM_FORMATS = [['', tt('自动（万 / 亿）')], ['0', tt('整数')], ['0.00', tt('两位小数')], ['#,##0', tt('千分位')], ['0%', tt('百分比')], ['¥#,##0', tt('货币')]];

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : typeof v === 'boolean' ? Number(v) : null);
const optNum = (v) => (v === '' || v == null ? null : num(typeof v === 'string' ? Number(v) : v));

/** 第 i 个系列的颜色。 */
export function colorAt(chart, i) {
  const own = Array.isArray(chart.colors) ? chart.colors[i] : null;
  if (typeof own === 'string' && /^#[0-9a-f]{6}$/i.test(own)) return own;
  const pal = (PALETTES.find((p) => p[0] === chart.palette) ?? PALETTES[0])[2];
  return pal[i % pal.length];
}

/** 数字 → 文本：自动格式把大数缩成「万 / 亿」。 */
export function fmtNum(v) {
  const a = Math.abs(v);
  if (a >= 1e4 && !WAN_LANGS.has(currentLang())) return new Intl.NumberFormat(langTag(), { notation: 'compact', maximumFractionDigits: 1 }).format(v);
  if (a >= 1e8) return tt('{n}亿', { n: (v / 1e8).toFixed(1).replace(/\.0$/, '') });
  if (a >= 1e4) return tt('{n}万', { n: (v / 1e4).toFixed(1).replace(/\.0$/, '') });
  return String(Math.round(v * 100) / 100);
}

/** @returns {(v: number) => string} */
export function numFormatter(chart) {
  const f = typeof chart.numfmt === 'string' ? chart.numfmt : '';
  if (!f) return fmtNum;
  return (v) => { try { return formatValue(v, f).text; } catch { return fmtNum(v); } };
}

/**
 * 从区域里抽出 { labels, series:[{name, values}], xs }。
 * 约定与 Excel 相同。按列（默认）：首列是文本时作为分类，首行作为系列名。
 * 按行：反过来 —— 首行是分类，首列是系列名。实现上把区域「转置」着读，其余逻辑不变。
 */
export function chartData(g, chart) {
  const [r0, c0, r1raw, c1raw] = chart.range ?? [0, 0, 0, 0];
  const r1 = Math.min(r1raw, g.model.rowCount - 1), c1 = Math.min(c1raw, g.model.colCount - 1);
  const byRow = chart.seriesIn === 'rows';
  // p 沿着数据点走，s 沿着系列走
  /** @type {(p: number, s: number) => [number, number]} */
  const at = byRow ? (p, s) => [r0 + s, c0 + p] : (p, s) => [r0 + p, c0 + s];
  const nP = byRow ? c1 - c0 + 1 : r1 - r0 + 1, nS = byRow ? r1 - r0 + 1 : c1 - c0 + 1;
  if (nP <= 0 || nS <= 0) return { labels: [], series: [], xs: null };
  const V = (p, s) => g.calc.value(...at(p, s));
  const header = chart.header !== false && nP > 1;
  const p0 = header ? 1 : 0;
  const pN = Math.min(nP - 1, p0 + MAX_POINTS - 1);
  let labelS = -1;
  if (nS > 1) {
    let text = 0;
    for (let p = p0, n = 0; p <= pN && n < 50; p++, n++) {
      const [r, c] = at(p, 0);
      if (num(g.calc.value(r, c)) == null && g.model.getCell(r, c) !== '') text++;
    }
    if (text > 0 || chart.type === 'scatter') labelS = 0;
  }
  const labels = [];
  for (let p = p0; p <= pN; p++) labels.push(labelS >= 0 ? g.calc.text(...at(p, labelS)) : String(p - p0 + 1));
  const series = [];
  for (let s = labelS >= 0 ? 1 : 0; s < nS && series.length < MAX_SERIES; s++) {
    const values = [];
    for (let p = p0; p <= pN; p++) values.push(num(V(p, s)));
    const [hr, hc] = at(0, s);
    const fallback = byRow ? tt('行 {n}', { n: hr + 1 }) : (g.model.colTitle?.(hc) || '');
    series.push({ name: header ? (g.calc.text(hr, hc) || fallback) : tt('系列{n}', { n: series.length + 1 }), values });
  }
  let xs = chart.type === 'scatter' && labelS >= 0 ? labels.map((_, i) => num(V(p0 + i, labelS))) : null;
  // 首列是文本（如「1月」）时没有数值 X，退回按序号 1、2、3… 排
  if (xs && xs.every((x) => x == null)) xs = null;
  return { labels, series, xs };
}

function niceStep(range, ticks) {
  const raw = range / Math.max(1, ticks);
  const p = 10 ** Math.floor(Math.log10(raw || 1));
  const m = raw / p;
  return (m <= 1 ? 1 : m <= 2 ? 2 : m <= 5 ? 5 : 10) * p;
}

/**
 * 数值轴的范围与刻度。auto 是数据的上下界；用户给的 yMin / yMax 优先。
 * @returns {{ lo: number, hi: number, ticks: number[] }}
 */
export function valueScale(lo, hi, includeZero, chart) {
  if (!Number.isFinite(lo)) { lo = 0; hi = 1; }
  if (includeZero) { lo = Math.min(0, lo); hi = Math.max(0, hi); }
  if (lo === hi) { hi += 1; lo -= lo === 0 ? 0 : 1; }
  let step = niceStep(hi - lo, 5);
  lo = Math.floor(lo / step) * step;
  hi = Math.ceil(hi / step) * step;
  const uMin = optNum(chart.yMin), uMax = optNum(chart.yMax);
  if (uMin != null || uMax != null) {
    if (uMin != null) lo = uMin;
    if (uMax != null) hi = uMax;
    if (hi <= lo) hi = lo + (Math.abs(lo) || 1);
    step = niceStep(hi - lo, 5);
  }
  const ticks = [];
  for (let k = Math.ceil(lo / step - 1e-9); k * step <= hi + step * 1e-9 && ticks.length < 50; k++) ticks.push(+(k * step).toPrecision(12));
  return { lo, hi, ticks };
}

/** 穿过一串点的路径；smooth 时用 Catmull-Rom 转贝塞尔，保证曲线经过每个点。 */
function tracePath(ctx, pts, smooth, moveFirst = true) {
  if (!pts.length) return;
  if (moveFirst) ctx.moveTo(pts[0][0], pts[0][1]); else ctx.lineTo(pts[0][0], pts[0][1]);
  if (!smooth || pts.length < 3) { for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0], pts[i][1]); return; }
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[i - 1] ?? pts[i], p1 = pts[i], p2 = pts[i + 1], p3 = pts[i + 2] ?? p2;
    ctx.bezierCurveTo(p1[0] + (p2[0] - p0[0]) / 6, p1[1] + (p2[1] - p0[1]) / 6, p2[0] - (p3[0] - p1[0]) / 6, p2[1] - (p3[1] - p1[1]) / 6, p2[0], p2[1]);
  }
}

const clip = (s, n) => { s = String(s); return s.length > n ? s.slice(0, n - 1) + '…' : s; };

/**
 * 画一张图。w/h 是 CSS 像素；ctx 已按 DPR 缩放。
 * @returns {any[]} 命中区域，给悬停提示用：{ shape:'rect'|'pt'|'arc', ..., label, name, text, color }
 */
export function drawChart(ctx, w, hgt, chart, data, theme = {}) {
  const t = { fg: theme.fg ?? '#1a1d23', muted: theme.muted ?? '#5b6472', line: theme.line ?? '#e3e6ec', bg: theme.bg ?? '#ffffff' };
  const hits = [];
  ctx.clearRect(0, 0, w, hgt);
  ctx.font = FONT;
  ctx.textBaseline = 'middle';
  const box = { top: 10, bottom: hgt - 8, left: 10, right: w - 10 };

  // 标题 / 副标题
  if (chart.title) {
    ctx.fillStyle = t.fg; ctx.font = '600 14px system-ui, sans-serif'; ctx.textAlign = 'center';
    ctx.fillText(clip(chart.title, 60), w / 2, box.top + 7);
    box.top += 22;
  }
  if (chart.subtitle) {
    ctx.fillStyle = t.muted; ctx.font = FONT; ctx.textAlign = 'center';
    ctx.fillText(clip(chart.subtitle, 80), w / 2, box.top + 5);
    box.top += 18;
  }
  ctx.font = FONT;

  const { labels, series } = data;
  if (!series.length || !labels.length) {
    ctx.fillStyle = t.muted; ctx.textAlign = 'center';
    ctx.fillText(tt('所选区域没有可绘制的数值'), w / 2, (box.top + box.bottom) / 2);
    return hits;
  }
  const type = chart.type;
  const perPoint = type === 'pie' || type === 'doughnut' || type === 'funnel';
  // 饼 / 环 / 漏斗每个数据点一种颜色，其余每个系列一种颜色 —— 都按序号取
  const color = (i) => colorAt(chart, i);
  const items = perPoint ? labels.slice(0, 20) : series.map((s) => s.name);
  drawLegend(ctx, box, chart.legend ?? 'bottom', items, color, t);

  const ctxt = { chart, data, t, color, fmt: numFormatter(chart), hits };
  if (type === 'pie' || type === 'doughnut') drawPie(ctx, box, ctxt);
  else if (type === 'funnel') drawFunnel(ctx, box, ctxt);
  else if (type === 'radar') drawRadar(ctx, box, ctxt);
  else drawAxes(ctx, box, ctxt);
  return hits;
}

/** 图例：占掉 box 的一条边。 */
function drawLegend(ctx, box, pos, items, color, t) {
  if (pos === 'none' || !items.length) return;
  ctx.font = FONT;
  ctx.textAlign = 'left';
  if (pos === 'right') {
    const tw = Math.min(120, Math.max(...items.map((s) => ctx.measureText(clip(s, 14)).width)));
    const x = box.right - tw - 14;
    let y = box.top + 8;
    items.forEach((name, i) => {
      if (y > box.bottom - 6) return;
      ctx.fillStyle = color(i); ctx.fillRect(x, y - 5, 10, 10);
      ctx.fillStyle = t.muted; ctx.fillText(clip(name, 14), x + 14, y);
      y += 18;
    });
    box.right = x - 10;
    return;
  }
  // 横排：放得下几个放几个，整体居中
  const cells = [];
  let total = 0;
  for (const [i, name] of items.entries()) {
    const s = clip(name, 14), tw = ctx.measureText(s).width + 26;
    if (total + tw > box.right - box.left) break;
    cells.push([i, s, tw]);
    total += tw;
  }
  const y = pos === 'top' ? box.top + 6 : box.bottom - 6;
  let x = (box.left + box.right - total) / 2;
  for (const [i, s, tw] of cells) {
    ctx.fillStyle = color(i); ctx.fillRect(x, y - 5, 10, 10);
    ctx.fillStyle = t.muted; ctx.fillText(s, x + 14, y);
    x += tw;
  }
  if (pos === 'top') box.top += 20; else box.bottom -= 20;
}

function drawPie(ctx, box, { chart, data, t, color, fmt, hits }) {
  const s0 = data.series[0];
  const vals = (s0?.values ?? []).map((v) => Math.max(0, v ?? 0));
  const total = vals.reduce((a, b) => a + b, 0);
  const cx = (box.left + box.right) / 2, cy = (box.top + box.bottom) / 2;
  const rad = Math.max(10, Math.min((box.right - box.left) / 2 - 6, (box.bottom - box.top) / 2 - 4));
  if (!total) { ctx.fillStyle = t.fg; ctx.textAlign = 'center'; ctx.fillText(tt('合计为 0'), cx, cy); return; }
  const inner = chart.type === 'doughnut' ? rad * 0.55 : 0;
  let a = -Math.PI / 2;
  /** @type {[string, number, number][]} */ const texts = [];
  /** @type {number[][]} */ const placed = [];
  const rr = chart.type === 'doughnut' ? rad * 0.78 : rad * 0.62;
  const ring = chart.type === 'doughnut' ? rad - inner : rad;
  const TH = 12;   // 标签文字高度（约）
  vals.forEach((v, i) => {
    const da = (v / total) * Math.PI * 2;
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.arc(cx, cy, rad, a, a + da);
    ctx.closePath();
    ctx.fillStyle = color(i);
    ctx.fill();
    const pct = Math.round((v / total) * 1000) / 10 + '%';
    hits.push({ shape: 'arc', cx, cy, r0: inner, r1: rad, a0: a, a1: a + da, label: data.labels[i], name: s0.name, text: fmt(v) + '（' + pct + '）', color: color(i) });
    // 标签要放得进扇区（沿切向、径向都量一下），且不和已放的标签相交；放不下先退到百分比，再放不下就不画（悬停仍有提示）
    const m = a + da / 2, x = cx + Math.cos(m) * rr, y = cy + Math.sin(m) * rr;
    const sin = Math.abs(Math.sin(m)), cos = Math.abs(Math.cos(m));
    for (const s of chart.labels ? [fmt(v), Math.round((v / total) * 100) + '%'] : [Math.round((v / total) * 100) + '%']) {
      const w = ctx.measureText(s).width + 4;
      const box = [x - w / 2, y - TH / 2, x + w / 2, y + TH / 2];
      if (w * sin + TH * cos > da * rr - 2) continue;
      if (w * cos + TH * sin > ring - 4) continue;
      if (placed.some((p) => box[0] < p[2] && p[0] < box[2] && box[1] < p[3] && p[1] < box[3])) continue;
      placed.push(box);
      texts.push([s, x, y]);
      break;
    }
    a += da;
  });
  // 扇区都画完再写字：先写的字不会被后画的扇区盖住
  ctx.fillStyle = '#fff';
  ctx.textAlign = 'center';
  for (const [s, x, y] of texts) ctx.fillText(s, x, y);
  if (inner) {
    ctx.globalCompositeOperation = 'destination-out';
    ctx.beginPath();
    ctx.arc(cx, cy, inner, 0, Math.PI * 2);
    ctx.fill();
    ctx.globalCompositeOperation = 'source-over';
    if (chart.labels) { ctx.fillStyle = t.fg; ctx.textAlign = 'center'; ctx.fillText(fmt(total), cx, cy); }
  }
}

/** 漏斗图：按原顺序自上而下，宽度与数值成正比，居中。 */
function drawFunnel(ctx, box, { chart, data, t, color, fmt, hits }) {
  const s0 = data.series[0];
  const vals = (s0?.values ?? []).map((v) => Math.max(0, v ?? 0));
  const max = Math.max(0, ...vals);
  if (!max) { ctx.fillStyle = t.fg; ctx.textAlign = 'center'; ctx.fillText(tt('没有正数可画'), (box.left + box.right) / 2, (box.top + box.bottom) / 2); return; }
  const n = vals.length, gap = 3;
  const bh = Math.max(4, (box.bottom - box.top - gap * (n - 1)) / n);
  const labelW = Math.min(110, Math.max(...data.labels.map((l) => ctx.measureText(clip(l, 10)).width)) + 8);
  const left = box.left + labelW, width = box.right - left, mid = left + width / 2;
  vals.forEach((v, i) => {
    const bw = Math.max(2, (v / max) * width), y = box.top + i * (bh + gap);
    ctx.fillStyle = color(i);
    ctx.fillRect(mid - bw / 2, y, bw, bh);
    ctx.fillStyle = t.muted; ctx.textAlign = 'right';
    if (bh >= 10) ctx.fillText(clip(data.labels[i], 10), left - 6, y + bh / 2);
    const first = vals[0] || 0;
    const text = fmt(v) + (i > 0 && first ? '（' + Math.round((v / first) * 1000) / 10 + '%）' : '');
    hits.push({ shape: 'rect', x: mid - bw / 2, y, w: bw, h: bh, label: data.labels[i], name: s0.name, text, color: color(i) });
    if (chart.labels !== false && bh >= 12) {
      const s = chart.labels ? text : fmt(v);
      const tw = ctx.measureText(s).width;
      ctx.textAlign = 'center';
      ctx.fillStyle = tw + 8 < bw ? '#fff' : t.fg;
      ctx.fillText(s, tw + 8 < bw ? mid : Math.min(box.right - tw / 2, mid + bw / 2 + tw / 2 + 6), y + bh / 2);
    }
  });
}

function drawRadar(ctx, box, { chart, data, t, color, fmt, hits }) {
  const { labels, series } = data;
  const n = labels.length;
  const cx = (box.left + box.right) / 2, cy = (box.top + box.bottom) / 2;
  if (n < 3) { ctx.fillStyle = t.muted; ctx.textAlign = 'center'; ctx.fillText(tt('雷达图至少需要 3 个分类'), cx, cy); return; }
  const R = Math.max(10, Math.min((box.right - box.left) / 2 - 40, (box.bottom - box.top) / 2 - 14));
  let lo = Infinity, hi = -Infinity;
  for (const s of series) for (const v of s.values) if (v != null) { lo = Math.min(lo, v); hi = Math.max(hi, v); }
  const sc = valueScale(lo, hi, true, chart);
  const ang = (i) => -Math.PI / 2 + (i / n) * Math.PI * 2;
  const pos = (i, v) => {
    const r = ((Math.max(sc.lo, Math.min(sc.hi, v)) - sc.lo) / (sc.hi - sc.lo)) * R;
    return [cx + Math.cos(ang(i)) * r, cy + Math.sin(ang(i)) * r];
  };
  ctx.strokeStyle = t.line; ctx.lineWidth = 1;
  if (chart.gridlines !== false) {
    for (const v of sc.ticks) {
      if (v === sc.lo) continue;
      ctx.beginPath();
      for (let i = 0; i < n; i++) { const [x, y] = pos(i, v); if (i) ctx.lineTo(x, y); else ctx.moveTo(x, y); }
      ctx.closePath(); ctx.stroke();
    }
  }
  const every = Math.max(1, Math.ceil(n / 24));
  for (let i = 0; i < n; i++) {
    const [x, y] = pos(i, sc.hi);
    ctx.beginPath(); ctx.moveTo(cx, cy); ctx.lineTo(x, y); ctx.stroke();
    if (i % every) continue;
    const c = Math.cos(ang(i));
    ctx.fillStyle = t.muted;
    ctx.textAlign = Math.abs(c) < 0.2 ? 'center' : c > 0 ? 'left' : 'right';
    ctx.fillText(clip(labels[i], 8), cx + Math.cos(ang(i)) * (R + 8), cy + Math.sin(ang(i)) * (R + 8));
  }
  ctx.fillStyle = t.muted; ctx.textAlign = 'left';
  for (const v of sc.ticks) if (v !== sc.lo) ctx.fillText(fmt(v), cx + 3, pos(0, v)[1]);
  series.forEach((s, si) => {
    const col = color(si);
    const pts = s.values.map((v, i) => pos(i, v ?? sc.lo));
    ctx.beginPath(); tracePath(ctx, [...pts, pts[0]], false); ctx.closePath();
    ctx.globalAlpha = 0.15; ctx.fillStyle = col; ctx.fill(); ctx.globalAlpha = 1;
    ctx.strokeStyle = col; ctx.lineWidth = 2; ctx.stroke(); ctx.lineWidth = 1;
    pts.forEach(([x, y], i) => {
      if (s.values[i] == null) return;
      ctx.fillStyle = col; ctx.beginPath(); ctx.arc(x, y, 2.5, 0, Math.PI * 2); ctx.fill();
      hits.push({ shape: 'pt', x, y, label: labels[i], name: s.name, text: fmt(s.values[i]), color: col });
      if (chart.labels) { ctx.fillStyle = t.fg; ctx.textAlign = 'center'; ctx.fillText(fmt(s.values[i]), x, y - 9); }
    });
  });
}

/** 柱形、条形、折线、面积、散点、组合：有直角坐标轴的都在这里。 */
function drawAxes(ctx, box, { chart, data, t, color, fmt, hits }) {
  const { labels, series, xs } = data;
  const type = chart.type;
  const horiz = type === 'bar';
  const stacked = !!chart.stacked && CAN_STACK.has(type);
  const smooth = !!chart.smooth;
  const n = labels.length;

  // 组合图：最后一个系列画折线，其余画柱（只有一个系列时就是柱形图）
  const lineIdx = type === 'line' || type === 'area' || type === 'scatter' ? series.map((_, i) => i)
    : type === 'combo' && series.length > 1 ? [series.length - 1] : [];
  const barIdx = series.map((_, i) => i).filter((i) => !lineIdx.includes(i) && type !== 'scatter');

  // 数值范围：堆积时按每个分类的正、负累计
  let lo = Infinity, hi = -Infinity;
  if (stacked) {
    for (let i = 0; i < n; i++) {
      let pos = 0, neg = 0;
      for (const s of series) { const v = s.values[i]; if (v == null) continue; if (v > 0) pos += v; else neg += v; }
      lo = Math.min(lo, neg); hi = Math.max(hi, pos);
    }
  } else {
    for (const s of series) for (const v of s.values) if (v != null) { lo = Math.min(lo, v); hi = Math.max(hi, v); }
  }
  const sc = valueScale(lo, hi, type !== 'scatter' && type !== 'line', chart);

  // 轴标题
  if (chart.xTitle) {
    ctx.fillStyle = t.muted; ctx.textAlign = 'center';
    ctx.fillText(clip(chart.xTitle, 40), (box.left + box.right) / 2, box.bottom - 6);
    box.bottom -= 18;
  }
  if (chart.yTitle) {
    ctx.save();
    ctx.translate(box.left + 6, (box.top + box.bottom) / 2);
    ctx.rotate(-Math.PI / 2);
    ctx.fillStyle = t.muted; ctx.textAlign = 'center';
    ctx.fillText(clip(chart.yTitle, 30), 0, 0);
    ctx.restore();
    box.left += 18;
  }

  const tickW = Math.max(...sc.ticks.map((v) => ctx.measureText(fmt(v)).width), 10);
  const left = horiz ? box.left + Math.min(110, 4 + Math.max(...labels.slice(0, 50).map((l) => ctx.measureText(clip(l, 12)).width)))
    : box.left + 4 + tickW;
  const right = box.right - 2, plotT = box.top + 4, plotB = box.bottom - 18;
  const valPos = horiz ? (v) => left + ((v - sc.lo) / (sc.hi - sc.lo)) * (right - left)
    : (v) => plotB - ((v - sc.lo) / (sc.hi - sc.lo)) * (plotB - plotT);

  // 网格线与数值轴刻度
  ctx.strokeStyle = t.line; ctx.lineWidth = 1;
  for (const v of sc.ticks) {
    const p = Math.round(valPos(v)) + 0.5;
    ctx.fillStyle = t.muted;
    if (horiz) {
      if (chart.gridlines !== false) { ctx.beginPath(); ctx.moveTo(p, plotT); ctx.lineTo(p, plotB); ctx.stroke(); }
      ctx.textAlign = 'center'; ctx.fillText(fmt(v), p, plotB + 10);
    } else {
      if (chart.gridlines !== false) { ctx.beginPath(); ctx.moveTo(left, p); ctx.lineTo(right, p); ctx.stroke(); }
      ctx.textAlign = 'right'; ctx.fillText(fmt(v), left - 4, p);
    }
  }
  // 基线（0 或最小值）总是画出来，关掉网格线时也看得出轴在哪
  const base = Math.max(sc.lo, Math.min(sc.hi, 0));
  const zero = valPos(base);
  ctx.strokeStyle = t.muted; ctx.globalAlpha = 0.5;
  ctx.beginPath();
  if (horiz) { ctx.moveTo(Math.round(zero) + 0.5, plotT); ctx.lineTo(Math.round(zero) + 0.5, plotB); }
  else { ctx.moveTo(left, Math.round(zero) + 0.5); ctx.lineTo(right, Math.round(zero) + 0.5); }
  ctx.stroke(); ctx.globalAlpha = 1;

  // 用户给的范围可能比数据窄：超出的部分裁掉
  ctx.save();
  ctx.beginPath(); ctx.rect(left - 1, plotT - 1, right - left + 2, plotB - plotT + 2); ctx.clip();

  if (type === 'scatter') {
    let xlo = Infinity, xhi = -Infinity;
    const X = xs ?? labels.map((_, i) => i + 1);
    for (const x of X) if (x != null) { xlo = Math.min(xlo, x); xhi = Math.max(xhi, x); }
    const xs2 = valueScale(xlo, xhi, false, {});
    const xPos = (x) => left + ((x - xs2.lo) / (xs2.hi - xs2.lo)) * (right - left);
    ctx.restore();
    ctx.fillStyle = t.muted; ctx.textAlign = 'center';
    for (const x of xs2.ticks) ctx.fillText(fmt(x), xPos(x), plotB + 10);
    series.forEach((s, si) => {
      const col = color(si);
      s.values.forEach((v, i) => {
        if (v == null || X[i] == null || v < sc.lo || v > sc.hi) return;
        const px = xPos(X[i]), py = valPos(v);
        ctx.fillStyle = col; ctx.beginPath(); ctx.arc(px, py, 3.5, 0, Math.PI * 2); ctx.fill();
        hits.push({ shape: 'pt', x: px, y: py, label: s.name, name: 'X = ' + fmt(X[i]), text: 'Y = ' + fmt(v), color: col });
        if (chart.labels) { ctx.fillStyle = t.fg; ctx.fillText(fmt(v), px, py - 9); }
      });
    });
    return;
  }

  const band = (horiz ? plotB - plotT : right - left) / Math.max(1, n);
  const catPos = (i) => (horiz ? plotT : left) + band * (i + 0.5);
  const labelQueue = [];

  // 柱 / 条
  if (barIdx.length) {
    const k = stacked ? 1 : barIdx.length;
    const bw = Math.max(1, (band * (stacked ? 0.6 : 0.75)) / k);
    const posAcc = new Array(n).fill(0), negAcc = new Array(n).fill(0);
    barIdx.forEach((si, slot) => {
      const s = series[si], col = color(si);
      s.values.forEach((v, i) => {
        if (v == null) return;
        let from = base, to = v;
        if (stacked) {
          if (v >= 0) { from = posAcc[i]; to = posAcc[i] += v; } else { from = negAcc[i]; to = negAcc[i] += v; }
        }
        const off = catPos(i) - (bw * k) / 2 + (stacked ? 0 : slot * bw);
        const a = valPos(from), b = valPos(to);
        const rect = horiz ? { x: Math.min(a, b), y: off, w: Math.abs(b - a), h: bw - 1 } : { x: off, y: Math.min(a, b), w: bw - 1, h: Math.abs(b - a) };
        ctx.fillStyle = col;
        ctx.fillRect(rect.x, rect.y, rect.w, rect.h);
        hits.push({ shape: 'rect', ...rect, label: labels[i], name: s.name, text: fmt(v), color: col });
        if (chart.labels) {
          const s2 = fmt(v);
          if (stacked) {
            const tw = ctx.measureText(s2).width;
            if ((horiz ? rect.w : rect.h) >= (horiz ? tw + 4 : 14) && (horiz ? rect.h : rect.w) >= (horiz ? 12 : tw + 2)) {
              labelQueue.push([s2, rect.x + rect.w / 2, rect.y + rect.h / 2, '#fff', 'center']);
            }
          } else if (horiz) labelQueue.push([s2, (v >= 0 ? rect.x + rect.w + 4 : rect.x - 4), rect.y + rect.h / 2, t.fg, v >= 0 ? 'left' : 'right']);
          else labelQueue.push([s2, rect.x + rect.w / 2, v >= 0 ? rect.y - 8 : rect.y + rect.h + 8, t.fg, 'center']);
        }
      });
    });
  }

  // 折线 / 面积
  const acc = new Array(n).fill(0);
  for (const si of lineIdx) {
    const s = series[si], col = color(si);
    const stackedArea = stacked && type === 'area';
    const topV = s.values.map((v, i) => (stackedArea ? acc[i] + (v ?? 0) : v));
    const pts = [];
    topV.forEach((v, i) => { if (v != null) pts.push([catPos(i), valPos(v), i]); });
    if (!pts.length) continue;
    if (type === 'area') {
      ctx.beginPath();
      if (stackedArea) {
        tracePath(ctx, pts, smooth);
        const low = pts.map(([x, , i]) => [x, valPos(acc[i])]).reverse();
        tracePath(ctx, low, smooth, false);
      } else {
        ctx.moveTo(pts[0][0], zero);
        tracePath(ctx, pts, smooth, false);
        ctx.lineTo(pts[pts.length - 1][0], zero);
      }
      ctx.closePath();
      ctx.globalAlpha = stackedArea ? 0.6 : 0.35; ctx.fillStyle = col; ctx.fill(); ctx.globalAlpha = 1;
    }
    ctx.beginPath(); tracePath(ctx, pts, smooth);
    ctx.strokeStyle = col; ctx.lineWidth = 2; ctx.stroke(); ctx.lineWidth = 1;
    const dots = pts.length <= 40;
    for (const [x, y, i] of pts) {
      if (dots) { ctx.fillStyle = col; ctx.beginPath(); ctx.arc(x, y, 2.5, 0, Math.PI * 2); ctx.fill(); }
      const v = s.values[i];
      if (v == null) continue;
      hits.push({ shape: 'pt', x, y, label: labels[i], name: s.name, text: fmt(v), color: col });
      if (chart.labels) labelQueue.push([fmt(v), x, y - 9, t.fg, 'center']);
    }
    if (stackedArea) topV.forEach((v, i) => { acc[i] = v ?? acc[i]; });
  }

  // 数值标签最后画，免得被后面的系列盖住
  for (const [s, x, y, fill, align] of labelQueue) { ctx.fillStyle = fill; ctx.textAlign = align; ctx.fillText(s, x, y); }
  ctx.restore();

  // 分类轴标签（太密就抽稀）
  ctx.fillStyle = t.muted;
  const every = Math.max(1, Math.ceil((horiz ? 16 : 60) / band));
  for (let i = 0; i < n; i += every) {
    const l = clip(labels[i], 12);
    if (horiz) { ctx.textAlign = 'right'; ctx.fillText(l, left - 4, catPos(i)); }
    else { ctx.textAlign = 'center'; ctx.fillText(l, catPos(i), plotB + 10); }
  }
}

/** 找鼠标下的数据点：矩形 / 扇区直接命中，点取 12px 内最近的。 */
export function hitTest(hits, x, y) {
  let best = null, bestD = 144;
  for (const hh of hits) {
    if (hh.shape === 'rect') {
      if (x >= hh.x - 1 && x <= hh.x + hh.w + 1 && y >= hh.y - 1 && y <= hh.y + hh.h + 1) return hh;
    } else if (hh.shape === 'arc') {
      const dx = x - hh.cx, dy = y - hh.cy, d = Math.hypot(dx, dy);
      if (d < hh.r0 || d > hh.r1) continue;
      let a = Math.atan2(dy, dx);
      while (a < hh.a0) a += Math.PI * 2;
      if (a <= hh.a1) return hh;
    } else {
      const d = (x - hh.x) ** 2 + (y - hh.y) ** 2;
      if (d < bestD) { bestD = d; best = hh; }
    }
  }
  return best;
}

export function readChartTheme(el) {
  const cs = typeof getComputedStyle === 'function' ? getComputedStyle(el) : null;
  const v = (n, d) => (cs?.getPropertyValue(n) || '').trim() || d;
  return { fg: v('--c-text', '#1a1d23'), muted: v('--c-text-muted', '#5b6472'), line: v('--c-border', '#e3e6ec'), bg: v('--c-surface', '#ffffff') };
}
