/**
 * 透视表：纯计算，不碰 DOM。
 *
 * 定义存在 props.pivots（每张表最多 MAX_PIVOTS 个），每个是
 *   { id, name, range:[r0,c0,r1,c1], header,
 *     filters:[列号…], rows:[列号…], cols:[列号…], values:[{col, agg, show}],
 *     hide:{ 列号: [被筛掉的取值…] }, opts:{ rowTotals, colTotals, subtotals, sort, sortVal, sortCol, dec, empty,
 *                                          layout, repeat, subTop, blank, merge, top } }
 *   sort 为 valDesc / valAsc 时，sortVal 指按第几个值字段排，sortCol 指按哪一列（列字段取值数组；null = 总计列）。
 * 和 Excel 一样四个区域：筛选 / 列 / 行 / 值。hide 对任何字段都生效（筛选区的字段、行列字段的 ▾）。
 * 旧定义只有 col（单个列字段），读的时候当 cols:[col]。
 * 列号是工作表的**绝对**列号 —— 插删列时由 shared/model/sheet.js 的 adjustProps 平移。
 * 透视表单独占一个视图标签，不画在网格上，所以不会挤占表格的布局。
 */

import { t as tt } from '../../shared/i18n/i18n.js';

export const MAX_PIVOTS = 5;
export const PIVOT_AGGS = /** @type {const} */ ([
  ['sum', tt('求和')], ['count', tt('计数')], ['countNum', tt('数值计数')], ['distinct', tt('去重计数')],
  ['avg', tt('平均值')], ['max', tt('最大值')], ['min', tt('最小值')], ['median', tt('中位数')],
  ['product', tt('乘积')], ['stdev', tt('标准差')], ['var', tt('方差')],
]);
/** 值显示方式（Excel「值显示方式」里最常用的几种）。 */
export const PIVOT_SHOW = /** @type {const} */ ([
  ['none', tt('无计算')], ['pctGrand', tt('总计的百分比')], ['pctCol', tt('列汇总的百分比')], ['pctRow', tt('行汇总的百分比')],
]);
export const PIVOT_SORTS = /** @type {const} */ ([
  ['asc', tt('按标签升序')], ['desc', tt('按标签降序')], ['valDesc', tt('按值降序')], ['valAsc', tt('按值升序')],
]);
/** 报表布局（和 Excel「设计 → 报表布局」一样）。 */
export const PIVOT_LAYOUTS = /** @type {const} */ ([
  ['tabular', tt('表格形式')], ['outline', tt('大纲形式')], ['compact', tt('压缩形式')],
]);
const AGG_LABEL = Object.fromEntries(PIVOT_AGGS);
const SHOW_LABEL = Object.fromEntries(PIVOT_SHOW);
/** 各区域最多几个字段。 */
export const PIVOT_LIMITS = { filters: 4, rows: 3, cols: 2, values: 6 };
/** 行 / 列分组上限：再多就不是「透视」而是原表了，也画不动。 */
export const MAX_ROW_KEYS = 2000;
export const MAX_COL_KEYS = 100;
/** 筛选下拉里最多列这么多个取值。 */
export const MAX_FIELD_VALUES = 1000;
export const BLANK = '(空白)';
/** 分组键的显示文本：BLANK 是内部比较键（存进 hide 里），显示时换成当前语言。 @param {string} k */
export const blankText = (k) => (k === BLANK ? tt('(空白)') : k);

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const ints = (a) => (Array.isArray(a) ? a.filter(Number.isInteger) : []);

/** 分组键排序：数字按大小，其余按中文拼音；空白永远在最后。 @param {string} a @param {string} b */
export function keyCmp(a, b) {
  if (a === b) return 0;
  if (a === BLANK) return 1;
  if (b === BLANK) return -1;
  const x = Number(a), y = Number(b);
  if (a.trim() !== '' && b.trim() !== '' && Number.isFinite(x) && Number.isFinite(y)) return x - y;
  return a.localeCompare(b, 'zh-CN', { numeric: true });
}

/** 旧定义（单个 col）兼容成新形状，并补齐缺省。 @param {any} p */
export function normPivot(p) {
  const cols = Array.isArray(p?.cols) ? ints(p.cols) : Number.isInteger(p?.col) ? [p.col] : [];
  const values = (Array.isArray(p?.values) ? p.values : [])
    .filter((v) => Number.isInteger(v?.col))
    .map((v) => ({ col: v.col, agg: AGG_LABEL[v.agg] ? v.agg : 'sum', show: SHOW_LABEL[v.show] ? v.show : 'none' }));
  /** @type {Record<string, string[]>} */ const hide = {};
  if (p?.hide && typeof p.hide === 'object') {
    for (const [k, v] of Object.entries(p.hide)) if (Array.isArray(v) && v.length) hide[k] = v.map(String);
  }
  const o = p?.opts ?? {};
  return {
    ...p, filters: ints(p?.filters), rows: ints(p?.rows), cols, values, hide,
    opts: {
      rowTotals: o.rowTotals !== false, colTotals: o.colTotals !== false, subtotals: !!o.subtotals,
      sort: PIVOT_SORTS.some(([k]) => k === o.sort) ? o.sort : 'asc',
      sortVal: Number.isInteger(o.sortVal) && o.sortVal >= 0 && o.sortVal < values.length ? o.sortVal : 0,
      sortCol: Array.isArray(o.sortCol) ? o.sortCol.map(String) : null,
      dec: Number.isInteger(o.dec) && o.dec >= 0 && o.dec <= 6 ? o.dec : null,
      empty: typeof o.empty === 'string' ? o.empty.slice(0, 10) : '',
      layout: PIVOT_LAYOUTS.some(([k]) => k === o.layout) ? o.layout : 'tabular',
      /** 重复所有项目标签：外层标签每一行都写 */
      repeat: !!o.repeat,
      /** 分类汇总显示在组的顶部（默认底部） */
      subTop: !!o.subTop,
      /** 每个外层项目后插入空行 */
      blank: !!o.blank,
      /** 合并相同的外层标签（仅表格形式） */
      merge: !!o.merge,
      /** 只显示最外层的前 N 项（按当前排序），0 = 全部 */
      top: Number.isInteger(o.top) && o.top > 0 ? Math.min(o.top, 1000) : 0,
    },
  };
}

/** @param {string} agg */
function acc(agg) {
  return {
    sum: 0, n: 0, cnt: 0, max: -Infinity, min: Infinity, prod: 1, mean: 0, m2: 0,
    nums: agg === 'median' ? /** @type {number[]} */ ([]) : null,
    set: agg === 'distinct' ? new Set() : null,
  };
}
/** @param {ReturnType<typeof acc>} a @param {unknown} v */
function feed(a, v) {
  if (v == null || v === '') return;
  a.cnt++;
  if (a.set) a.set.add(typeof v === 'string' ? 's:' + v.trim().toLowerCase() : typeof v + ':' + String(v));
  if (!isNum(v)) return;
  a.sum += v; a.n++; a.prod *= v;
  const d = v - a.mean;
  a.mean += d / a.n;
  a.m2 += d * (v - a.mean);
  if (v > a.max) a.max = v;
  if (v < a.min) a.min = v;
  a.nums?.push(v);
}
/** @param {ReturnType<typeof acc> | undefined} a @param {string} agg @returns {number | null} */
function result(a, agg) {
  if (!a) return null;
  switch (agg) {
    case 'count': return a.cnt;
    case 'countNum': return a.n;
    case 'distinct': return a.set ? a.set.size : null;
    case 'avg': return a.n ? a.sum / a.n : null;
    case 'max': return a.n ? a.max : null;
    case 'min': return a.n ? a.min : null;
    case 'product': return a.n ? a.prod : null;
    case 'median': {
      if (!a.nums?.length) return null;
      const s = a.nums.slice().sort((x, y) => x - y), m = s.length >> 1;
      return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
    }
    case 'stdev': return a.n > 1 ? Math.sqrt(a.m2 / (a.n - 1)) : null;
    case 'var': return a.n > 1 ? a.m2 / (a.n - 1) : null;
    default: return a.n ? a.sum : (a.cnt ? 0 : null);
  }
}

/** 这个定义还能不能算（数据区域合法）。 @param {any} p */
export function validPivot(p) {
  return !!p && Array.isArray(p.range) && p.range.length === 4 && p.range.every(Number.isInteger);
}

/** 字段显示名：有表头取表头文字，否则「列 X」。 */
export function fieldName(p, c, text, colTitle) {
  const t = p.header ? String(text(p.range[0], c) ?? '').trim() : '';
  return t || colTitle(c);
}

/** 值字段的标题：「求和项:销量」「求和项:销量（列汇总的百分比）」。 */
export function valueLabel(v, name) {
  const agg = AGG_LABEL[v.agg] ?? tt('求和');
  return v.show && v.show !== 'none' ? tt('{agg}项:{name}（{show}）', { agg, name, show: SHOW_LABEL[v.show] }) : tt('{agg}项:{name}', { agg, name });
}

/** 分组键：显示文本去首尾空白，空串算「(空白)」。 */
const keyAt = (text, r, c) => { const s = String(text(r, c) ?? '').trim(); return s === '' ? BLANK : s; };

/**
 * 某个字段在数据区域里的全部取值（筛选下拉用）。已排好序，最多 MAX_FIELD_VALUES 个。
 * @param {any} p @param {number} col @param {(r:number, c:number) => string} text
 */
export function fieldValues(p, col, text) {
  const [r0, , r1] = p.range;
  const set = new Set();
  for (let r = p.header ? r0 + 1 : r0; r <= r1 && set.size < MAX_FIELD_VALUES; r++) set.add(keyAt(text, r, col));
  return [...set].sort(keyCmp);
}

/** 这一列在数据里主要是数字吗（勾选字段时决定放「值」还是「行」）。 */
export function looksNumeric(p, col, value) {
  const [r0, , r1] = p.range;
  let n = 0, t = 0;
  for (let r = p.header ? r0 + 1 : r0; r <= r1 && n + t < 50; r++) {
    const v = value(r, col);
    if (isNum(v)) n++; else if (v != null && v !== '') t++;
  }
  return n > 0 && n >= t;
}

/**
 * 算一张透视表。
 * @param {any} def 定义
 * @param {(r:number, c:number) => unknown} value 计算后的值
 * @param {(r:number, c:number) => string} text 显示文本（分组键用它，和单元格里看到的一致）
 * @param {(c:number) => string} [colTitle] 没有表头时的列名
 */
export function computePivot(def, value, text, colTitle = (c) => tt('列{n}', { n: c + 1 })) {
  const p = normPivot(def);
  const [r0, c0, r1, c1] = p.range;
  const inRange = (c) => c >= c0 && c <= c1;
  const rowFields = p.rows.filter(inRange).slice(0, PIVOT_LIMITS.rows);
  const colFields = p.cols.filter(inRange).filter((c) => !rowFields.includes(c)).slice(0, PIVOT_LIMITS.cols);
  const values = p.values.filter((v) => inRange(v.col)).slice(0, PIVOT_LIMITS.values);
  const name = (c) => fieldName(p, c, text, colTitle);
  const nv = values.length;
  const depth = rowFields.length;
  const out = {
    rowFields: rowFields.map(name), colFields: colFields.map(name),
    rowCols: rowFields, colCols: colFields,
    valueLabels: values.map((v) => valueLabel(v, name(v.col))),
    /** 每个值字段是不是按百分比显示 */
    valuePct: values.map((v) => v.show !== 'none'),
    /** 列分组，每项是各层的取值；没有列字段时只有一个 [] */
    colKeys: /** @type {string[][]} */ ([]),
    /** sub 为小计行所在层（0 起），普通行没有；head = 大纲 / 压缩形式里外层项目自己的那一行（不显示汇总时值全空） */
    rows: /** @type {{keys:string[], cells:(number|null)[], total:(number|null)[], sub?:number, head?:boolean}[]} */ ([]),
    /** 「只显示前 N 项」隐藏掉的外层项目数 */
    topHidden: 0,
    total: { cells: /** @type {(number|null)[]} */ ([]), total: /** @type {(number|null)[]} */ ([]) },
    opts: p.opts,
    truncated: false, error: '',
  };
  if (!depth && !colFields.length && !nv) { out.error = tt('在「字段列表」中勾选字段，或把字段拖到「行」「列」「值」区域'); return out; }

  // 筛选：hide 里列出的取值不参与计算（范围外的字段忽略）
  const filters = Object.entries(p.hide)
    .map(([k, list]) => [Number(k), new Set(list)])
    .filter(([c]) => Number.isInteger(c) && inRange(/** @type {number} */ (c)));

  const newAccs = () => values.map((v) => acc(v.agg));
  /** 一个分组（完整行键或它的前缀）：按列分组的累加器 + 整行的累加器 */
  const newGroup = (keys) => ({ keys, by: new Map(), all: newAccs() });
  /** @type {Map<string, ReturnType<typeof newGroup>>} */ const groups = new Map();
  /** 前缀分组（小计 / 按值排序用），键是前缀的 join @type {Map<string, ReturnType<typeof newGroup>>} */ const prefixes = new Map();
  /** @type {Map<string, ReturnType<typeof newAccs>>} */ const colAll = new Map();
  /** @type {Map<string, string[]>} */ const colKeyOf = new Map();
  const grand = newAccs();
  const SEP = '\u0000';

  const feedGroup = (grp, ck, r) => {
    let cell = grp.by.get(ck);
    if (!cell) { cell = newAccs(); grp.by.set(ck, cell); }
    values.forEach((v, i) => { const x = value(r, v.col); feed(cell[i], x); feed(grp.all[i], x); });
  };

  for (let r = p.header ? r0 + 1 : r0; r <= r1; r++) {
    // 整行空白不计：数据区域往往框多了几行
    let empty = true;
    for (let c = c0; c <= c1 && empty; c++) { const v = value(r, c); if (v != null && v !== '') empty = false; }
    if (empty) continue;
    let skip = false;
    for (const [c, set] of filters) if (set.has(keyAt(text, r, c))) { skip = true; break; }
    if (skip) continue;

    const keys = rowFields.map((c) => keyAt(text, r, c));
    const gk = keys.join(SEP);
    let grp = groups.get(gk);
    if (!grp) {
      if (groups.size >= MAX_ROW_KEYS) { out.truncated = true; continue; }
      grp = newGroup(keys);
      groups.set(gk, grp);
    }
    const cks = colFields.map((c) => keyAt(text, r, c));
    const ck = cks.join(SEP);
    if (!colKeyOf.has(ck)) {
      if (colKeyOf.size >= MAX_COL_KEYS) { out.truncated = true; continue; }
      colKeyOf.set(ck, cks);
    }
    feedGroup(grp, ck, r);
    for (let d = 1; d < depth; d++) {
      const pk = keys.slice(0, d).join(SEP);
      let pg = prefixes.get(pk);
      if (!pg) { pg = newGroup(keys.slice(0, d)); prefixes.set(pk, pg); }
      feedGroup(pg, ck, r);
    }
    let ca = colAll.get(ck);
    if (!ca) { ca = newAccs(); colAll.set(ck, ca); }
    values.forEach((v, i) => { const x = value(r, v.col); feed(ca[i], x); feed(grand[i], x); });
  }

  const desc = p.opts.sort === 'desc';
  const byVal = p.opts.sort === 'valDesc' || p.opts.sort === 'valAsc';
  const sign = p.opts.sort === 'valAsc' ? 1 : -1;
  const cmpKeys = (a, b) => {
    for (let i = 0; i < a.length; i++) { const d = keyCmp(a[i], b[i]); if (d) return desc ? -d : d; }
    return 0;
  };
  const colEntries = [...colKeyOf.entries()].sort((a, b) => cmpKeys(a[1], b[1]));
  const colIds = colEntries.map((e) => e[0]);
  out.colKeys = colEntries.map((e) => e[1]);
  if (!out.colKeys.length) { out.colKeys = [colFields.map(() => BLANK)]; colIds.push(colFields.map(() => BLANK).join(SEP)); }

  // 按值排序：逐层比较那一层分组（前缀）在指定值字段 / 指定列上的结果，同层再按标签。
  // 指定的列已经不存在（比如被筛掉了）就退回总计列。
  const sv = p.opts.sortVal < nv ? p.opts.sortVal : 0;
  const sck = p.opts.sortCol && p.opts.sortCol.length === colFields.length && colKeyOf.has(p.opts.sortCol.join(SEP))
    ? p.opts.sortCol.join(SEP) : null;
  out.sortKey = byVal ? { v: sv, col: sck == null ? null : colKeyOf.get(sck), dir: p.opts.sort === 'valAsc' ? 'asc' : 'desc' } : null;
  const firstTotal = (grp) => (nv ? result(sck == null ? grp?.all[sv] : grp?.by.get(sck)?.[sv], values[sv].agg) ?? -Infinity : 0);
  const sorted = [...groups.values()].sort((a, b) => {
    if (byVal) {
      for (let d = 1; d <= depth; d++) {
        const ga = d === depth ? a : prefixes.get(a.keys.slice(0, d).join(SEP));
        const gb = d === depth ? b : prefixes.get(b.keys.slice(0, d).join(SEP));
        if (ga === gb) continue;
        const x = firstTotal(ga), y = firstTotal(gb);
        if (x !== y) return sign * (x - y);
        const k = keyCmp(a.keys[d - 1], b.keys[d - 1]);
        if (k) return k;
      }
      return 0;
    }
    return cmpKeys(a.keys, b.keys);
  });

  // 只显示前 N 项：把其余的外层项目当作被筛掉，重算一遍（总计也只算显示的，和 Excel 的值筛选一样）
  if (p.opts.top && depth) {
    const outer = [...new Set(sorted.map((g) => g.keys[0]))];
    if (outer.length > p.opts.top) {
      const c = rowFields[0];
      const hide = { ...p.hide, [c]: [...(p.hide[c] ?? []), ...outer.slice(p.opts.top)] };
      const res = computePivot({ ...p, hide, opts: { ...p.opts, top: 0 } }, value, text, colTitle);
      res.opts = p.opts;
      res.topHidden = outer.length - p.opts.top;
      return res;
    }
  }

  const rowOf = (grp, sub) => {
    const cells = [];
    for (const ck of colIds) values.forEach((v, i) => cells.push(result(grp.by.get(ck)?.[i], v.agg)));
    const row = { keys: grp.keys, cells, total: values.map((v, i) => result(grp.all[i], v.agg)) };
    if (sub != null) row.sub = sub;
    return row;
  };
  const withSubs = p.opts.subtotals && depth > 1;
  const subTop = withSubs && p.opts.subTop;
  // 大纲 / 压缩形式：每个外层项目先单独占一行（汇总放顶部时这一行就是汇总行）
  const heads = p.opts.layout !== 'tabular' && depth > 1;
  sorted.forEach((grp, idx) => {
    if (heads || subTop) {
      const prev = sorted[idx - 1];
      for (let d = 1; d < depth; d++) {
        if (prev && grp.keys.slice(0, d).every((k, i) => k === prev.keys[i])) continue;
        const row = rowOf(prefixes.get(grp.keys.slice(0, d).join(SEP)), d - 1);
        if (heads) row.head = true;
        if (!subTop) { row.cells = row.cells.map(() => null); row.total = row.total.map(() => null); }
        out.rows.push(row);
      }
    }
    out.rows.push(rowOf(grp));
    if (!withSubs || subTop) return;
    // 这一行之后，前缀变了的层（从最深往外）各补一行小计
    const next = sorted[idx + 1];
    for (let d = depth - 1; d >= 1; d--) {
      const same = next && grp.keys.slice(0, d).every((k, i) => k === next.keys[i]);
      if (same) break;
      out.rows.push(rowOf(prefixes.get(grp.keys.slice(0, d).join(SEP)), d - 1));
    }
  });
  for (const ck of colIds) values.forEach((v, i) => out.total.cells.push(result(colAll.get(ck)?.[i], v.agg)));
  out.total.total = values.map((v, i) => result(grand[i], v.agg));

  applyShow(out, values);
  return out;
}

/** 值显示方式：把原始结果换成占比。 @param {any} out @param {{show:string}[]} values */
function applyShow(out, values) {
  const nv = values.length;
  if (!values.some((v) => v.show !== 'none')) return;
  const div = (a, b) => (a == null || b == null || b === 0 ? null : a / b);
  const nk = out.colKeys.length;
  const colTot = out.total.cells.slice(), grandTot = out.total.total.slice();
  const conv = (row, isTotal) => {
    const rowTot = row.total.slice();
    for (let k = 0; k < nk; k++) {
      for (let i = 0; i < nv; i++) {
        const j = k * nv + i, s = values[i].show;
        if (s === 'pctGrand') row.cells[j] = div(row.cells[j], grandTot[i]);
        else if (s === 'pctCol') row.cells[j] = isTotal ? div(row.cells[j], colTot[j]) : div(row.cells[j], colTot[j]);
        else if (s === 'pctRow') row.cells[j] = div(row.cells[j], rowTot[i]);
      }
    }
    for (let i = 0; i < nv; i++) {
      const s = values[i].show;
      if (s === 'pctGrand' || s === 'pctCol') row.total[i] = div(rowTot[i], grandTot[i]);
      else if (s === 'pctRow') row.total[i] = div(rowTot[i], rowTot[i]);
    }
  };
  for (const row of out.rows) conv(row, false);
  conv(out.total, true);
}

/**
 * 数字显示：整数加千分位，小数默认最多两位；百分比带 %。
 * @param {number | null} n @param {boolean} [pct] @param {{dec?:number|null, empty?:string}} [opts]
 */
export function fmtPivot(n, pct = false, opts = {}) {
  if (n == null || !Number.isFinite(n)) return opts.empty ?? '';
  const dec = opts.dec ?? null;
  const o = dec == null ? { maximumFractionDigits: 2 } : { minimumFractionDigits: dec, maximumFractionDigits: dec };
  return pct ? (n * 100).toLocaleString('zh-CN', o) + '%' : n.toLocaleString('zh-CN', o);
}

/**
 * 行区域怎么摆：按报表布局把 res.rows 排成一行行（每行几个标签格 + 对应的数据行）。
 * HTML 表、导出 Excel、仪表盘图片都用它，保证三处一样。
 *   表格形式：每个行字段一列，外层标签写在分组第一行；
 *   大纲形式：每个行字段一列，外层项目单独占一行，下一层从下一行开始；
 *   压缩形式：所有行字段挤在一列，按层缩进。
 * lines[i].kind：'' 普通行 / 'group' 外层项目行 / 'sub' 汇总行 / 'blank' 空行；indent 为压缩形式的缩进层数。
 * merges：[起始行, 列, 行数]，相同外层标签合并（仅表格形式且开了 merge）。
 * @param {ReturnType<typeof computePivot>} res
 */
export function pivotLayout(res) {
  const o = res.opts;
  const depth = res.rowFields.length;
  const layout = depth > 1 ? o.layout : 'tabular';
  const compact = layout === 'compact';
  const keyCols = compact ? 1 : depth || 1;
  /** @type {{kind: ''|'group'|'sub'|'blank', keys: string[], indent: number, row: any}[]} */ const lines = [];
  /** @type {[number, number, number][]} */ const merges = [];
  if (!depth) return { keyCols, compact, lines, merges };
  const repeat = o.repeat && !compact;
  /** @type {string[]} */ let prev = [];
  res.rows.forEach((row, i) => {
    /** @type {string[]} */ let keys;
    let indent = 0;
    /** @type {''|'group'|'sub'} */ let kind = '';
    if (row.sub != null) {
      kind = row.head ? 'group' : 'sub';
      const label = row.head ? row.keys[row.sub] : tt('{label} 汇总', { label: blankText(row.keys[row.sub]) });
      if (compact) { keys = [label]; indent = row.sub; }
      else keys = Array.from({ length: depth }, (_, d) => (d === row.sub ? label : row.head && repeat && d < row.sub ? row.keys[d] : ''));
      prev = row.head ? row.keys.slice(0, row.sub + 1) : [];
    } else if (compact) {
      keys = [row.keys[depth - 1]];
      indent = depth - 1;
    } else if (layout === 'outline') {
      keys = row.keys.map((k, d) => (d === depth - 1 || repeat ? k : ''));
    } else {
      let same = true;
      keys = row.keys.map((k, d) => { same = same && prev[d] === k && d < depth - 1; return same && !repeat ? '' : k; });
      prev = row.keys;
    }
    lines.push({ kind, keys, indent, row });
    const next = res.rows[i + 1];
    if (o.blank && depth > 1 && next && next.keys[0] !== row.keys[0]) lines.push({ kind: 'blank', keys: Array(keyCols).fill(''), indent: 0, row: null });
  });
  if (o.merge && layout === 'tabular' && depth > 1) {
    for (let d = 0; d < depth - 1; d++) {
      for (let i = 0; i < lines.length;) {
        const a = lines[i];
        let j = i + 1;
        if (a.kind === '') {
          while (j < lines.length && lines[j].kind === '' && a.row.keys.slice(0, d + 1).every((/** @type {string} */ k, /** @type {number} */ t) => k === lines[j].row.keys[t])) j++;
          if (j - i > 1) merges.push([i, d, j - i]);
        }
        i = j;
      }
    }
  }
  return { keyCols, compact, lines, merges };
}

/**
 * 把算好的透视表摊成一个二维表：导出 Excel 的单独工作表、仪表盘导出图片都用它。
 * 布局和页面上的 HTML 表一致（见 pivotLayout）。
 * 单元格：{ v: 字符串 / 数字 / null, pct?: 是百分比 }；kinds[i] 标出第 i 行是表头 / 外层项目 / 小计 / 空行 / 总计。
 * merges：[r0, c0, r1, c1] 要合并的单元格。
 * @param {ReturnType<typeof computePivot>} res
 * @returns {{ rows: {v: string|number|null, pct?: boolean}[][], kinds: (''|'head'|'group'|'sub'|'blank'|'total')[], keyCols: number, merges: number[][] }}
 */
export function pivotMatrix(res) {
  const o = res.opts;
  const nv = res.valueLabels.length;
  const ncf = res.colFields.length;
  const depth = res.rowFields.length;
  const lay = pivotLayout(res);
  const keyCols = lay.keyCols;
  const nk = res.colKeys.length;
  const totalCol = ncf > 0 && o.rowTotals;
  /** @type {{v: string|number|null, pct?: boolean}[][]} */ const rows = [];
  /** @type {(''|'head'|'group'|'sub'|'blank'|'total')[]} */ const kinds = [];
  const T = (/** @type {string} */ v) => ({ v });
  const rowHeads = () => (!depth ? [T('')] : lay.compact ? [T(res.rowFields.join(' / '))] : res.rowFields.map(T));
  const push = (/** @type {any[]} */ r, /** @type {any} */ k) => { rows.push(r); kinds.push(k); };

  if (ncf) {
    // 每一层列字段一行（相同前缀只写第一格），多个值字段再加一行值标题；行字段名写在最后一行表头
    const vn = Math.max(1, nv);
    for (let l = 0; l < ncf; l++) {
      const last = l === ncf - 1 && nv <= 1;
      const r = last ? rowHeads() : Array.from({ length: keyCols }, (_, i) => T(l === 0 && i === 0 ? res.colFields.join(' / ') : ''));
      for (let k = 0; k < nk; k++) {
        const first = k === 0 || res.colKeys[k].slice(0, l + 1).some((x, t) => x !== res.colKeys[k - 1][t]);
        for (let i = 0; i < vn; i++) r.push(T(first && i === 0 ? blankText(res.colKeys[k][l]) : ''));
      }
      if (totalCol) for (let i = 0; i < vn; i++) r.push(T(l === 0 && i === 0 ? tt('总计') : ''));
      push(r, 'head');
    }
    if (nv > 1) {
      const r = rowHeads();
      for (let k = 0; k < nk + (totalCol ? 1 : 0); k++) r.push(...res.valueLabels.map(T));
      push(r, 'head');
    }
  } else {
    push([...rowHeads(), ...res.valueLabels.map(T)], 'head');
  }
  const heads = rows.length;

  const num = (/** @type {number|null} */ n, /** @type {number} */ i) => ({ v: n, pct: res.valuePct[i] });
  const data = (/** @type {any} */ row) => {
    if (!ncf) return row.total.map(num);
    const out = row.cells.map((/** @type {number|null} */ n, /** @type {number} */ j) => num(n, j % Math.max(1, nv)));
    if (totalCol) out.push(...row.total.map(num));
    return out;
  };
  const width = keyCols + (ncf ? nk * Math.max(1, nv) + (totalCol ? Math.max(1, nv) : 0) : nv);
  for (const line of lay.lines) {
    if (line.kind === 'blank') { push(Array.from({ length: width }, () => T('')), 'blank'); continue; }
    // 压缩形式用全角空格缩进（Excel 里看起来也是缩进）
    const keys = line.keys.map((k, i) => T(i === 0 && line.indent ? '　'.repeat(line.indent) + blankText(k) : blankText(k)));
    push([...keys, ...data(line.row)], line.kind);
  }
  if (o.colTotals || !depth) {
    push([T(tt('总计')), ...Array.from({ length: keyCols - 1 }, () => T('')), ...data(res.total)], 'total');
  }
  const merges = lay.merges.map(([r, c, n]) => [heads + r, c, heads + r + n - 1, c]);
  return { rows, kinds, keyCols, merges };
}

/**
 * 字段列表的拖放 / 勾选：把字段从一个区域挪到另一个区域（或移除）。纯函数，返回新定义；没变化返回 null。
 *   from: { area: 'list'|'filters'|'rows'|'cols'|'values', index?, col }
 *   to:   { area: 'filters'|'rows'|'cols'|'values'|'remove', index? }（index 缺省 = 末尾）
 * 同一个字段只能在 筛选 / 行 / 列 中出现一次（挪过去就从原处拿掉）；值区域可以重复（销量的求和和计数）。
 * @param {any} def @param {{area:string, index?:number, col:number}} from @param {{area:string, index?:number}} to
 */
export function moveField(def, from, to) {
  const p = normPivot(def);
  const lists = { filters: p.filters.slice(), rows: p.rows.slice(), cols: p.cols.slice(), values: p.values.slice() };
  /** @type {any} */ let item = from.col;
  // to.index 是按挪动前的位置算的：同一区域里往后挪，拿掉自己之后目标位置要前移一格
  const shift = (/** @type {number} */ i) => { if (to.area === from.area && to.index != null && i < to.index) to = { ...to, index: to.index - 1 }; };
  if (from.area === 'values') {
    const i = from.index ?? lists.values.findIndex((v) => v.col === from.col);
    if (i < 0) return null;
    item = lists.values.splice(i, 1)[0];
    shift(i);
  } else if (from.area in lists) {
    const L = lists[/** @type {'filters'|'rows'|'cols'} */ (from.area)];
    const i = from.index ?? L.indexOf(from.col);
    if (i < 0) return null;
    L.splice(i, 1);
    shift(i);
  }
  if (to.area !== 'remove') {
    const dest = /** @type {'filters'|'rows'|'cols'|'values'} */ (to.area);
    if (!(dest in lists)) return null;
    const col = typeof item === 'object' ? item.col : item;
    if (dest === 'values') {
      item = typeof item === 'object' ? item : { col, agg: 'sum', show: 'none' };
    } else {
      item = col;
      for (const k of /** @type {const} */ (['filters', 'rows', 'cols'])) {
        const j = lists[k].indexOf(col);
        if (j < 0) continue;
        lists[k].splice(j, 1);
        if (k === dest && to.index != null && j < to.index) to = { ...to, index: to.index - 1 };
      }
    }
    const L = /** @type {any[]} */ (lists[dest]);
    if (L.length >= PIVOT_LIMITS[dest]) return null;
    const at = to.index == null ? L.length : Math.max(0, Math.min(L.length, to.index));
    L.splice(at, 0, item);
  }
  const next = { ...def, ...lists };
  delete next.col;
  const same = ['filters', 'rows', 'cols', 'values'].every((k) => JSON.stringify(next[k]) === JSON.stringify(p[k]));
  return same && def.col == null ? null : next;
}

/** 字段是否已用在某个区域。 @param {any} def @param {number} col */
export function fieldUsed(def, col) {
  const p = normPivot(def);
  return p.filters.includes(col) || p.rows.includes(col) || p.cols.includes(col) || p.values.some((v) => v.col === col);
}

/** 新透视表的默认名：透视表1、透视表2…跳过已占用的。 @param {any[]} list */
export function nextPivotName(list) {
  const used = new Set(list.map((p) => p?.name));
  for (let i = 1; ; i++) { const n = tt('透视表{n}', { n: i }); if (!used.has(n)) return n; }
}

/** 名称清洗：去首尾空白，最长 30 字。空串返回 ''。 @param {unknown} s */
export function cleanPivotName(s) {
  return String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, 30);
}
