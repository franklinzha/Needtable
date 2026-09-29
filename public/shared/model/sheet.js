/**
 * 插入 / 删除行列时「谁挪到哪」的规则 —— 浏览器模型与 Durable Object 共用。
 *
 * 结构性改动牵动四样东西：格子位置、公式里的引用、按区域记的表属性（合并、条件格式、
 * 数据验证、图表、筛选……）、以及行高 / 列宽这类按索引记的元数据。
 * 规则只写一份，两端各自套到自己的存储上（Map / SQLite），才不会出现
 * 「本地看着对、刷新后错位」的分叉。
 */

import { adjustFormula } from '../formula/parse.js';
import { parseRange as parseA1Range, keyOf } from '../formula/extref.js';

/**
 * @typedef {'row'|'col'} Axis
 * @typedef {[number, number, number, number]} Range  [r0, c0, r1, c1]
 */

/**
 * 结构性 op → 轴、起点、带符号的数量（正数插入，负数删除）。
 * @param {any} op @returns {{axis:Axis, at:number, n:number} | null}
 */
export function structuralSpec(op) {
  switch (op?.t) {
    case 'insertRows': return { axis: 'row', at: op.at, n: op.n };
    case 'deleteRows': return { axis: 'row', at: op.at, n: -op.n };
    case 'insertCols': return { axis: 'col', at: op.at, n: op.n };
    case 'deleteCols': return { axis: 'col', at: op.at, n: -op.n };
    default: return null;
  }
}

/**
 * 单个索引的新位置；被删掉返回 -1。
 * @param {number} i @param {number} at @param {number} n
 */
export function shiftIndex(i, at, n) {
  if (n > 0) return i >= at ? i + n : i;
  const d = -n;
  if (i < at) return i;
  return i < at + d ? -1 : i - d;
}

/**
 * 区域跟着插入 / 删除变化：插在区域中间会撑大它，删掉一部分会缩小它，全删掉返回 null。
 * @param {Range} rg @param {Axis} axis @param {number} at @param {number} n
 * @returns {Range | null}
 */
export function adjustRange(rg, axis, at, n) {
  const [r0, c0, r1, c1] = rg;
  let lo = axis === 'row' ? r0 : c0;
  let hi = axis === 'row' ? r1 : c1;
  if (n > 0) {
    if (lo >= at) lo += n;
    if (hi >= at) hi += n;
  } else {
    const d = -n, end = at + d;                   // 删除 [at, end)
    if (hi < at) { /* 在前面，不动 */ }
    else if (lo >= end) { lo -= d; hi -= d; }
    else if (lo >= at && hi < end) return null;   // 整个被删
    else {
      const nlo = lo < at ? lo : at;
      const nhi = hi >= end ? hi - d : at - 1;
      lo = nlo; hi = nhi;
      if (hi < lo) return null;
    }
  }
  return axis === 'row' ? [lo, c0, hi, c1] : [r0, lo, r1, hi];
}

/** @param {any} v @returns {v is Range} */
const isRange = (v) => Array.isArray(v) && v.length === 4 && v.every((x) => Number.isInteger(x));

/**
 * 按轴平移一组索引（隐藏行 / 隐藏列）。
 * @param {number[]} list @param {number} at @param {number} n
 */
function shiftList(list, at, n) {
  /** @type {number[]} */ const out = [];
  for (const i of list) { const j = shiftIndex(i, at, n); if (j >= 0) out.push(j); }
  return out;
}

/**
 * 表属性跟着结构改动调整。只返回**变了**的键（新值为 null 表示删掉这个键）。
 * @param {Record<string, any>} props @param {Axis} axis @param {number} at @param {number} n
 * @returns {Record<string, any>}
 */
export function adjustProps(props, axis, at, n) {
  /** @type {Record<string, any>} */ const out = {};
  const adjAll = (/** @type {any[]} */ list) => {
    /** @type {any[]} */ const res = [];
    for (const item of list) {
      if (!item || !isRange(item.range)) { res.push(item); continue; }
      const rg = adjustRange(item.range, axis, at, n);
      if (rg) res.push({ ...item, range: rg });
    }
    return res;
  };

  for (const [key, val] of Object.entries(props)) {
    if (val == null) continue;
    switch (key) {
      case 'merges': {
        /** @type {Range[]} */ const res = [];
        for (const m of val) {
          if (!isRange(m)) continue;
          const rg = adjustRange(m, axis, at, n);
          if (rg && (rg[0] !== rg[2] || rg[1] !== rg[3])) res.push(rg);
        }
        out[key] = res;
        break;
      }
      case 'cf': case 'charts':
        out[key] = adjAll(val);
        break;
      case 'validations':
        // 下拉列表引用本表的区域（src.range 是 A1 文本）也要跟着挪
        out[key] = adjAll(val).map((item) => {
          const src = item?.src;
          if (!src || src.table || typeof src.range !== 'string') return item;
          const g = parseA1Range(src.range);
          if (!g || g.c0 == null) return item;
          const whole = g.r0 == null;   // A:C 整列
          if (whole && axis === 'row') return item;
          const rg = adjustRange([whole ? 0 : g.r0, g.c0, whole ? 0 : /** @type {number} */ (g.r1), /** @type {number} */ (g.c1)], axis, at, n);
          if (!rg) return item;         // 数据源整个被删：留着原文，下拉会提示取不到
          const range = keyOf(whole ? { r0: null, r1: null, c0: rg[1], c1: rg[3] } : { r0: rg[0], c0: rg[1], r1: rg[2], c1: rg[3] });
          return range === src.range ? item : { ...item, src: { ...src, range } };
        });
        break;
      case 'dashboard': {
        // { kpis:[{col, agg}], layout }：只有指标卡带列号
        if (axis !== 'col' || !Array.isArray(val.kpis)) break;
        const kpis = [];
        for (const k of val.kpis) {
          if (!k || !Number.isInteger(k.col)) { kpis.push(k); continue; }
          const j = shiftIndex(k.col, at, n);
          if (j >= 0) kpis.push({ ...k, col: j });
        }
        out[key] = { ...val, kpis };
        break;
      }
      case 'pivots': {
        // 数据区域跟着平移；字段存的是绝对列号，插删列时一起挪，被删掉的字段丢弃
        /** @type {any[]} */ const res = [];
        for (const p of val) {
          if (!p || !isRange(p.range)) { res.push(p); continue; }
          const rg = adjustRange(p.range, axis, at, n);
          if (!rg) continue;
          if (axis !== 'col') { res.push({ ...p, range: rg }); continue; }
          const mv = (/** @type {any} */ c) => (Number.isInteger(c) ? shiftIndex(c, at, n) : -1);
          const rows = (Array.isArray(p.rows) ? p.rows : []).map(mv).filter((c) => c >= 0);
          const values = (Array.isArray(p.values) ? p.values : []).map((v) => ({ ...v, col: mv(v?.col) })).filter((v) => v.col >= 0);
          const list = (/** @type {any} */ a) => (Array.isArray(a) ? a.map(mv).filter((c) => c >= 0) : a);
          /** @type {any} */ const next = { ...p, range: rg, rows, values };
          if ('col' in p) { const col = mv(p.col); next.col = col >= 0 ? col : null; }
          if ('cols' in p) next.cols = list(p.cols);
          if ('filters' in p) next.filters = list(p.filters);
          if (p.hide && typeof p.hide === 'object') {
            /** @type {Record<string, any>} */ const hide = {};
            for (const [k, v] of Object.entries(p.hide)) { const c = mv(Number(k)); if (c >= 0) hide[c] = v; }
            next.hide = hide;
          }
          if (p.labels && typeof p.labels === 'object') {
            /** @type {Record<string, any>} */ const labels = {};
            for (const [k, v] of Object.entries(p.labels)) { const c = mv(Number(k)); if (c >= 0) labels[c] = v; }
            next.labels = labels;
          }
          res.push(next);
        }
        out[key] = res;
        break;
      }
      case 'filter': {
        if (!isRange(val.range)) break;
        const rg = adjustRange(val.range, axis, at, n);
        if (!rg) { out[key] = null; break; }
        /** @type {Record<string, any>} */ let crit = val.crit ?? {};
        if (axis === 'col') {
          crit = {};
          for (const [c, v] of Object.entries(val.crit ?? {})) {
            const j = shiftIndex(Number(c), at, n);
            if (j >= 0) crit[j] = v;
          }
        }
        out[key] = { ...val, range: rg, crit };
        break;
      }
      case 'freeze': {
        // { r, c } 是冻结的行数 / 列数：在冻结线以内插入会推远它，删掉冻结区里的行列会收回来
        const k = axis === 'row' ? 'r' : 'c';
        const cnt = Number.isInteger(val[k]) ? val[k] : 0;
        if (!cnt || at >= cnt) break;
        const next = n > 0 ? cnt + n : cnt - (Math.min(cnt, at - n) - at);
        const fz = { ...val, [k]: next };
        out[key] = fz.r || fz.c ? fz : null;
        break;
      }
      case 'hiddenRows':
        if (axis === 'row') out[key] = shiftList(val, at, n);
        break;
      case 'hiddenCols':
        if (axis === 'col') out[key] = shiftList(val, at, n);
        break;
      case 'notes': case 'files': {
        /** @type {any[]} */ const res = [];
        for (const nt of val) {
          if (!Array.isArray(nt)) continue;
          let [r, c, text] = nt;
          if (axis === 'row') r = shiftIndex(r, at, n); else c = shiftIndex(c, at, n);
          if (r >= 0 && c >= 0) res.push([r, c, text]);
        }
        out[key] = res;
        break;
      }
      case 'kanban':
        if (axis === 'col') {
          const k = { ...val };
          for (const f of ['groupCol', 'titleCol', 'descCol']) {
            if (Number.isInteger(k[f])) { const j = shiftIndex(k[f], at, n); if (j < 0) delete k[f]; else k[f] = j; }
          }
          out[key] = k;
        }
        break;
      default:
        break;
    }
  }
  return out;
}

/**
 * 公式文本跟着结构改动改写；没变返回原串。
 * @param {string} v @param {Axis} axis @param {number} at @param {number} n
 */
export function adjustCellText(v, axis, at, n) {
  if (v.length < 2 || v.charCodeAt(0) !== 61 /* = */) return v;
  return adjustFormula(v, axis, at, n);
}
