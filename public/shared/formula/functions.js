/**
 * 内置函数表。
 *
 * 每个函数收到的参数已经求过值（数字 / 文本 / 布尔 / null / 错误 / Ref / Arr），
 * 出错直接 throw 错误值 —— evaluate.js 在调用处统一接住变成单元格里的 #VALUE! 等。
 *
 * IF / IFERROR / CHOOSE 这些需要「短路」的放在 LAZY 里，收到的是 thunk：
 * =IF(A1=0, 0, 1/A1) 在 A1 为 0 时根本不去算 1/A1，这也是 Excel 的行为。
 *
 * 函数的「取数规则」照 Excel：区域里的文本、布尔、空格子被 SUM 忽略，
 * 但直接写在参数里的 "3"、TRUE 会被转换；错误值总是向上传播。
 */

import {
  ERR, FErr, Ref, Arr, isErr, isArr, scalar, each, toList, num, str, bool, tidy,
  compare, criteria, wildcard, dateToSerial, serialToDate, nowSerial, parseNumberText, parseDateText,
} from './values.js';
import { formatValue } from './numfmt.js';
import { t as tt } from '../i18n/i18n.js';

/** @typedef {{r:number, c:number, eng:any}} Ctx */

// ── 取数 ────────────────────────────────────────────────────────────────────

/**
 * 收集数字。区域里只要数字；标量参数做转换（opts.all 时区域里的布尔 / 文本也算，给 *A 系列用）。
 * @param {any[]} args @param {{all?:boolean}} [opts]
 */
function nums(args, opts = {}) {
  /** @type {number[]} */ const out = [];
  for (const a of args) {
    if (isArr(a)) {
      each(a, (v) => {
        if (typeof v === 'number') out.push(v);
        else if (v instanceof FErr) throw v;
        else if (opts.all && typeof v === 'boolean') out.push(v ? 1 : 0);
        else if (opts.all && typeof v === 'string') out.push(0);
      });
    } else if (a !== undefined && !(a && a.missing)) {
      if (a == null) continue;
      out.push(num(a));
    }
  }
  return out;
}

/** 区域 / 标量 → 按位置对齐的一维列表（SUMIF 一族、SUMPRODUCT 用）。 @param {any} a */
const flat = (a) => (isArr(a) ? toList(a) : [scalar(a)]);

const sum = (/** @type {number[]} */ xs) => { let s = 0; for (const x of xs) s += x; return s; };
const mean = (/** @type {number[]} */ xs) => { if (!xs.length) throw ERR.DIV0; return sum(xs) / xs.length; };

/** @param {number[]} xs @param {boolean} sample */
function variance(xs, sample) {
  const n = xs.length;
  if (n < (sample ? 2 : 1)) throw ERR.DIV0;
  const m = sum(xs) / n;
  let s = 0;
  for (const x of xs) s += (x - m) ** 2;
  return s / (sample ? n - 1 : n);
}

/** @param {number[]} xs @param {number} k 0..1 */
function percentile(xs, k) {
  if (!xs.length || k < 0 || k > 1) throw ERR.NUM;
  const s = [...xs].sort((a, b) => a - b);
  const pos = (s.length - 1) * k;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return s[lo] + (s[hi] - s[lo]) * (pos - lo);
}

/** 可选参数：没给 / 空参数 → 默认值。 @param {any} a @param {any} d */
const opt = (a, d) => (a === undefined || (a && a.missing) ? d : a);

/** @param {number} n */
const int = (n) => Math.trunc(n);

/** 结果必须是有限数。 @param {number} n */
function fin(n) {
  if (!Number.isFinite(n)) throw ERR.NUM;
  return n;
}

/** SUMIF 一族：多组（区域, 条件）→ 命中位置的布尔表。 @param {any[]} pairs */
function matchMask(pairs) {
  let len = -1;
  /** @type {boolean[]|null} */ let mask = null;
  for (let k = 0; k < pairs.length; k += 2) {
    const range = pairs[k];
    const test = criteria(pairs[k + 1]);
    const list = flat(range);
    if (len >= 0 && list.length !== len) throw ERR.VALUE;
    len = list.length;
    if (!mask) mask = list.map(() => true);
    for (let i = 0; i < list.length; i++) if (mask[i] && !test(list[i])) mask[i] = false;
  }
  return mask ?? [];
}

/** SUMIF(range, crit, [sum_range])：sum_range 以左上角为锚、按 range 的形状取。 @param {any} range @param {any} sr */
function alignedSumRange(range, sr) {
  if (!(sr instanceof Ref) || !(range instanceof Ref)) return flat(sr);
  const r = new Ref(sr.eng, sr.r0, sr.c0, sr.r0 + range.h - 1, sr.c0 + range.w - 1);
  return toList(r);
}

/**
 * 第 n 个分隔符的位置（n 为负从末尾数）。找不到 → #N/A；n 为 0 或分隔符为空 → #VALUE!。
 * @param {string} s @param {string} d @param {number} n
 */
function nthIndex(s, d, n) {
  if (n === 0 || d === '') throw ERR.VALUE;
  let i = n > 0 ? -1 : s.length + 1;
  for (let k = 0; k < Math.abs(n); k++) {
    i = n > 0 ? s.indexOf(d, i + 1) : (i - 1 < 0 ? -1 : s.lastIndexOf(d, i - 1));
    if (i < 0) throw ERR.NA;
  }
  return i;
}

// ── 日期 ────────────────────────────────────────────────────────────────────

/** 参数 → 日期序列号（接受数字与日期文本）。 @param {any} v */
function dateArg(v) {
  v = scalar(v);
  if (v instanceof FErr) throw v;
  if (typeof v === 'number') return v;
  if (typeof v === 'string') {
    const n = parseDateText(v) ?? parseNumberText(v);
    if (n == null) throw ERR.VALUE;
    return n;
  }
  return num(v);
}

/** @param {number} y @param {number} m */
const daysIn = (y, m) => new Date(Date.UTC(y, m, 0)).getUTCDate();

/** @param {number} serial @param {number} months */
function addMonths(serial, months) {
  const d = serialToDate(Math.floor(serial));
  const t = d.y * 12 + (d.m - 1) + months;
  const y = Math.floor(t / 12), m = (t % 12 + 12) % 12 + 1;
  return dateToSerial(y, m, Math.min(d.d, daysIn(y, m)));
}

/** @param {any} holidays */
function holidaySet(holidays) {
  const s = new Set();
  if (holidays !== undefined) for (const v of flat(holidays)) if (v != null && v !== '') s.add(Math.floor(dateArg(v)));
  return s;
}

/** @param {number} serial */
const isWeekend = (serial) => { const wd = serialToDate(serial).wd; return wd === 0 || wd === 6; };

// ── 查找 ────────────────────────────────────────────────────────────────────

/**
 * @param {any} needle @param {any[]} list @param {number} mode 0 精确；1 小于等于的最大值（需升序）；-1 大于等于的最小值（需降序）
 * @param {{wild?:boolean, reverse?:boolean, approxUnsorted?:boolean}} [o]
 */
function findIndex(needle, list, mode, o = {}) {
  needle = scalar(needle);
  if (needle instanceof FErr) throw needle;
  if (mode === 0) {
    const re = o.wild && typeof needle === 'string' && /[*?~]/.test(needle) ? wildcard(needle) : null;
    const n = list.length;
    for (let k = 0; k < n; k++) {
      const i = o.reverse ? n - 1 - k : k;
      const v = list[i];
      if (re) { if (typeof v === 'string' && re.test(v)) return i; }
      else if (v != null && rankEq(v, needle)) return i;
    }
    return -1;
  }
  if (o.approxUnsorted) {
    // XLOOKUP 的 -1 / 1：不要求有序，线性找最接近的
    let best = -1;
    for (let i = 0; i < list.length; i++) {
      const v = list[i];
      if (v == null || typeof v !== typeof needle) continue;
      const c = compare(v, needle);
      if (c === 0) return i;
      if (mode === -1 && c < 0 && (best < 0 || compare(v, list[best]) > 0)) best = i;
      if (mode === 1 && c > 0 && (best < 0 || compare(v, list[best]) < 0)) best = i;
    }
    return best;
  }
  // 二分：与 Excel 一样假定有序；类型不同的格子视作不匹配
  let lo = 0, hi = list.length - 1, ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const v = list[mid];
    const c = v == null ? (mode === 1 ? -1 : 1) : compare(v, needle);
    if (mode === 1) { if (c <= 0) { if (v != null && typeof v === typeof needle) ans = mid; lo = mid + 1; } else hi = mid - 1; }
    else { if (c >= 0) { if (v != null && typeof v === typeof needle) ans = mid; lo = mid + 1; } else hi = mid - 1; }
  }
  return ans;
}

/** 精确匹配的相等：文本不分大小写，数字 "5" 与 5 不相等（Excel 如此）。 @param {any} a @param {any} b */
function rankEq(a, b) {
  if (typeof a !== typeof b) return false;
  return compare(a, b) === 0;
}

/** @param {any} v @returns {Ref|Arr} */
function asMatrix(v) {
  if (isArr(v)) return v;
  return new Arr([[scalar(v)]]);
}

/** 取矩阵的一行 / 一列。 @param {Ref|Arr} m @param {'row'|'col'} axis @param {number} i */
function slice(m, axis, i) {
  if (m instanceof Ref) {
    return axis === 'row' ? new Ref(m.eng, m.r0 + i, m.c0, m.r0 + i, m.c1) : new Ref(m.eng, m.r0, m.c0 + i, m.r1, m.c0 + i);
  }
  if (axis === 'row') return new Arr([m.rows[i]]);
  return new Arr(m.rows.map((row) => [row[i]]));
}

/** 与 evaluate.js 的 MAX_SPILL_CELLS 一致（那边引用本文件，不能反过来 import） */
const MAX_SPILL_CELLS = 50000;

/** 区域 → 二维数组；byCol 时转置（SORT / UNIQUE / FILTER 按列处理时用）。 @param {Ref|Arr} m @param {boolean} byCol */
function matrixRows(m, byCol) {
  if (m.h * m.w > MAX_SPILL_CELLS) throw ERR.NUM;
  const rows = [];
  if (byCol) for (let j = 0; j < m.w; j++) { const r = []; for (let i = 0; i < m.h; i++) r.push(m.get(i, j)); rows.push(r); }
  else for (let i = 0; i < m.h; i++) { const r = []; for (let j = 0; j < m.w; j++) r.push(m.get(i, j)); rows.push(r); }
  return rows;
}

/** matrixRows 的逆操作。 @param {any[][]} rows @param {boolean} byCol */
function fromRows(rows, byCol) {
  if (!byCol) return new Arr(rows);
  const w = rows.length, h = rows[0]?.length ?? 0, out = [];
  for (let i = 0; i < h; i++) { const r = []; for (let j = 0; j < w; j++) r.push(rows[j][i]); out.push(r); }
  return new Arr(out);
}

// ── 文本 ────────────────────────────────────────────────────────────────────

/** @param {string} s */
const proper = (s) => s.toLowerCase().replace(/(^|[^a-zÀ-ɏ])([a-zÀ-ɏ])/g, (_, a, b) => a + b.toUpperCase());

// ── 函数表 ──────────────────────────────────────────────────────────────────

/** @type {Record<string, (args:any[], ctx:Ctx) => any>} */
export const FUNCS = {
  // 数学与统计
  SUM: (a) => tidy(sum(nums(a))),
  PRODUCT: (a) => { const xs = nums(a); return xs.length ? xs.reduce((p, x) => p * x, 1) : 0; },
  SUMSQ: (a) => sum(nums(a).map((x) => x * x)),
  AVERAGE: (a) => mean(nums(a)),
  AVERAGEA: (a) => mean(nums(a, { all: true })),
  MIN: (a) => { const xs = nums(a); return xs.length ? Math.min(...xs) : 0; },
  MAX: (a) => { const xs = nums(a); return xs.length ? Math.max(...xs) : 0; },
  MINA: (a) => { const xs = nums(a, { all: true }); return xs.length ? Math.min(...xs) : 0; },
  MAXA: (a) => { const xs = nums(a, { all: true }); return xs.length ? Math.max(...xs) : 0; },
  COUNT: (a) => {
    let n = 0;
    for (const x of a) {
      if (isArr(x)) each(x, (v) => { if (typeof v === 'number') n++; });
      else if (typeof x === 'number' || (typeof x === 'string' && parseNumberText(x) != null) || typeof x === 'boolean') n++;
    }
    return n;
  },
  COUNTA: (a) => {
    let n = 0;
    for (const x of a) {
      if (isArr(x)) each(x, (v) => { if (v != null && v !== '') n++; });
      else if (!(x && x.missing)) n++;
    }
    return n;
  },
  COUNTBLANK: (a) => { let n = 0; each(a[0], (v) => { if (v == null || v === '') n++; }); return n; },
  COUNTIF: (a) => { const t = criteria(a[1]); let n = 0; each(a[0], (v) => { if (t(v)) n++; }); return n; },
  COUNTIFS: (a) => matchMask(a).filter(Boolean).length,
  SUMIF: (a) => {
    const t = criteria(a[1]);
    const keys = flat(a[0]);
    const vals = a[2] === undefined ? keys : alignedSumRange(a[0], a[2]);
    let s = 0;
    for (let i = 0; i < keys.length; i++) if (t(keys[i]) && typeof vals[i] === 'number') s += vals[i];
    return tidy(s);
  },
  SUMIFS: (a) => {
    const vals = flat(a[0]);
    const mask = matchMask(a.slice(1));
    if (mask.length !== vals.length) throw ERR.VALUE;
    let s = 0;
    for (let i = 0; i < vals.length; i++) if (mask[i] && typeof vals[i] === 'number') s += vals[i];
    return tidy(s);
  },
  AVERAGEIF: (a) => {
    const t = criteria(a[1]);
    const keys = flat(a[0]);
    const vals = a[2] === undefined ? keys : alignedSumRange(a[0], a[2]);
    /** @type {number[]} */ const xs = [];
    for (let i = 0; i < keys.length; i++) if (t(keys[i]) && typeof vals[i] === 'number') xs.push(vals[i]);
    return mean(xs);
  },
  AVERAGEIFS: (a) => {
    const vals = flat(a[0]);
    const mask = matchMask(a.slice(1));
    return mean(vals.filter((v, i) => mask[i] && typeof v === 'number'));
  },
  MAXIFS: (a) => {
    const vals = flat(a[0]);
    const mask = matchMask(a.slice(1));
    const xs = vals.filter((v, i) => mask[i] && typeof v === 'number');
    return xs.length ? Math.max(...xs) : 0;
  },
  MINIFS: (a) => {
    const vals = flat(a[0]);
    const mask = matchMask(a.slice(1));
    const xs = vals.filter((v, i) => mask[i] && typeof v === 'number');
    return xs.length ? Math.min(...xs) : 0;
  },
  SUMPRODUCT: (a) => {
    const lists = a.map(flat);
    const n = lists[0]?.length ?? 0;
    if (lists.some((l) => l.length !== n)) throw ERR.VALUE;
    let s = 0;
    for (let i = 0; i < n; i++) {
      let p = 1;
      for (const l of lists) {
        const v = l[i];
        if (v instanceof FErr) throw v;
        p *= typeof v === 'number' ? v : typeof v === 'boolean' ? (v ? 1 : 0) : 0;
      }
      s += p;
    }
    return tidy(s);
  },
  MEDIAN: (a) => percentile(nums(a), 0.5),
  MODE: (a) => {
    const xs = nums(a);
    const cnt = new Map();
    let best = null, bc = 1;
    for (const x of xs) {
      const c = (cnt.get(x) ?? 0) + 1;
      cnt.set(x, c);
      if (c > bc) { bc = c; best = x; }
    }
    if (best == null) throw ERR.NA;
    return best;
  },
  STDEV: (a) => Math.sqrt(variance(nums(a), true)),
  STDEVP: (a) => Math.sqrt(variance(nums(a), false)),
  VAR: (a) => variance(nums(a), true),
  VARP: (a) => variance(nums(a), false),
  LARGE: (a) => { const xs = nums([a[0]]).sort((x, y) => y - x); const k = int(num(a[1])); if (k < 1 || k > xs.length) throw ERR.NUM; return xs[k - 1]; },
  SMALL: (a) => { const xs = nums([a[0]]).sort((x, y) => x - y); const k = int(num(a[1])); if (k < 1 || k > xs.length) throw ERR.NUM; return xs[k - 1]; },
  RANK: (a) => {
    const x = num(a[0]);
    const xs = nums([a[1]]);
    const asc = num(opt(a[2], 0)) !== 0;
    if (!xs.some((v) => tidy(v - x) === 0)) throw ERR.NA;
    return 1 + xs.filter((v) => (asc ? v < x : v > x)).length;
  },
  PERCENTILE: (a) => percentile(nums([a[0]]), num(a[1])),
  QUARTILE: (a) => { const q = int(num(a[1])); if (q < 0 || q > 4) throw ERR.NUM; return percentile(nums([a[0]]), q / 4); },
  SUBTOTAL: (a, ctx) => {
    const code = int(num(a[0])) % 100;
    const map = { 1: 'AVERAGE', 2: 'COUNT', 3: 'COUNTA', 4: 'MAX', 5: 'MIN', 6: 'PRODUCT', 7: 'STDEV', 8: 'STDEVP', 9: 'SUM', 10: 'VAR', 11: 'VARP' };
    const name = map[/** @type {keyof typeof map} */ (code)];
    if (!name) throw ERR.VALUE;
    return FUNCS[name](a.slice(1), ctx);
  },

  ABS: (a) => Math.abs(num(a[0])),
  ROUND: (a) => roundHalf(num(a[0]), int(num(opt(a[1], 0)))),
  ROUNDUP: (a) => roundDir(num(a[0]), int(num(opt(a[1], 0))), 1),
  ROUNDDOWN: (a) => roundDir(num(a[0]), int(num(opt(a[1], 0))), -1),
  INT: (a) => Math.floor(num(a[0])),
  TRUNC: (a) => roundDir(num(a[0]), int(num(opt(a[1], 0))), -1),
  MOD: (a) => { const n = num(a[0]), d = num(a[1]); if (d === 0) throw ERR.DIV0; return tidy(n - d * Math.floor(n / d)); },
  QUOTIENT: (a) => { const d = num(a[1]); if (d === 0) throw ERR.DIV0; return int(num(a[0]) / d); },
  POWER: (a) => fin(num(a[0]) ** num(a[1])),
  SQRT: (a) => { const n = num(a[0]); if (n < 0) throw ERR.NUM; return Math.sqrt(n); },
  EXP: (a) => fin(Math.exp(num(a[0]))),
  LN: (a) => { const n = num(a[0]); if (n <= 0) throw ERR.NUM; return Math.log(n); },
  LOG: (a) => { const n = num(a[0]), b = num(opt(a[1], 10)); if (n <= 0 || b <= 0 || b === 1) throw ERR.NUM; return tidy(Math.log(n) / Math.log(b)); },
  LOG10: (a) => { const n = num(a[0]); if (n <= 0) throw ERR.NUM; return Math.log10(n); },
  PI: () => Math.PI,
  RAND: () => Math.random(),
  RANDBETWEEN: (a) => { const lo = Math.ceil(num(a[0])), hi = Math.floor(num(a[1])); if (lo > hi) throw ERR.NUM; return lo + Math.floor(Math.random() * (hi - lo + 1)); },
  CEILING: (a) => { const n = num(a[0]), s = num(opt(a[1], 1)); if (s === 0) return 0; if (n > 0 && s < 0) throw ERR.NUM; return tidy(Math.ceil(tidy(n / s)) * s); },
  FLOOR: (a) => { const n = num(a[0]), s = num(opt(a[1], 1)); if (s === 0) throw ERR.DIV0; if (n > 0 && s < 0) throw ERR.NUM; return tidy(Math.floor(tidy(n / s)) * s); },
  MROUND: (a) => { const n = num(a[0]), m = num(a[1]); if (m === 0) return 0; if (n * m < 0) throw ERR.NUM; return tidy(roundHalf(n / m, 0) * m); },
  SIGN: (a) => Math.sign(num(a[0])),
  EVEN: (a) => { const n = num(a[0]); const v = Math.ceil(Math.abs(n) / 2) * 2; return n < 0 ? -v : v; },
  ODD: (a) => { const n = num(a[0]); let v = Math.ceil(Math.abs(n)); if (v % 2 === 0) v += 1; return n < 0 ? -v : v; },
  FACT: (a) => { const n = int(num(a[0])); if (n < 0) throw ERR.NUM; let p = 1; for (let i = 2; i <= n; i++) p *= i; return fin(p); },
  GCD: (a) => nums(a).map((x) => int(Math.abs(x))).reduce((x, y) => { while (y) [x, y] = [y, x % y]; return x; }, 0),
  LCM: (a) => nums(a).map((x) => int(Math.abs(x))).reduce((x, y) => { if (!x || !y) return 0; let g = x, h = y; while (h) [g, h] = [h, g % h]; return x / g * y; }, 1),
  SIN: (a) => Math.sin(num(a[0])),
  COS: (a) => Math.cos(num(a[0])),
  TAN: (a) => Math.tan(num(a[0])),
  ASIN: (a) => fin(Math.asin(num(a[0]))),
  ACOS: (a) => fin(Math.acos(num(a[0]))),
  ATAN: (a) => Math.atan(num(a[0])),
  ATAN2: (a) => { const x = num(a[0]), y = num(a[1]); if (!x && !y) throw ERR.DIV0; return Math.atan2(y, x); },
  DEGREES: (a) => num(a[0]) * 180 / Math.PI,
  RADIANS: (a) => num(a[0]) * Math.PI / 180,

  // 逻辑
  AND: (a) => { let r = true, any = false; for (const x of a) each(x, (v) => { if (v == null || typeof v === 'string' && isArr(x)) return; any = true; if (!bool(v)) r = false; }); if (!any) throw ERR.VALUE; return r; },
  OR: (a) => { let r = false, any = false; for (const x of a) each(x, (v) => { if (v == null || typeof v === 'string' && isArr(x)) return; any = true; if (bool(v)) r = true; }); if (!any) throw ERR.VALUE; return r; },
  XOR: (a) => { let r = false; for (const x of a) each(x, (v) => { if (v != null && !(typeof v === 'string' && isArr(x)) && bool(v)) r = !r; }); return r; },
  NOT: (a) => !bool(a[0]),
  TRUE: () => true,
  FALSE: () => false,

  // 文本
  CONCATENATE: (a) => a.map((x) => str(x)).join(''),
  CONCAT: (a) => { let s = ''; for (const x of a) each(x, (v) => { s += str(v); }); return s; },
  TEXTJOIN: (a) => {
    const sep = str(a[0]);
    const skip = bool(a[1]);
    /** @type {string[]} */ const parts = [];
    for (const x of a.slice(2)) each(x, (v) => { const s = str(v); if (!(skip && s === '')) parts.push(s); });
    return parts.join(sep);
  },
  LEFT: (a) => { const n = int(num(opt(a[1], 1))); if (n < 0) throw ERR.VALUE; return [...str(a[0])].slice(0, n).join(''); },
  RIGHT: (a) => { const n = int(num(opt(a[1], 1))); if (n < 0) throw ERR.VALUE; const s = [...str(a[0])]; return n ? s.slice(-n).join('') : ''; },
  MID: (a) => { const s = [...str(a[0])]; const st = int(num(a[1])), n = int(num(a[2])); if (st < 1 || n < 0) throw ERR.VALUE; return s.slice(st - 1, st - 1 + n).join(''); },
  LEN: (a) => [...str(a[0])].length,
  LOWER: (a) => str(a[0]).toLowerCase(),
  UPPER: (a) => str(a[0]).toUpperCase(),
  PROPER: (a) => proper(str(a[0])),
  TRIM: (a) => str(a[0]).trim().replace(/ {2,}/g, ' '),
  CLEAN: (a) => str(a[0]).replace(/[\x00-\x1f]/g, ''),
  SUBSTITUTE: (a) => {
    const s = str(a[0]), from = str(a[1]), to = str(a[2]);
    if (!from) return s;
    if (a[3] === undefined) return s.split(from).join(to);
    const k = int(num(a[3]));
    if (k < 1) throw ERR.VALUE;
    let idx = -1;
    for (let i = 0; i < k; i++) { idx = s.indexOf(from, idx + 1); if (idx < 0) return s; }
    return s.slice(0, idx) + to + s.slice(idx + from.length);
  },
  REPLACE: (a) => { const s = [...str(a[0])]; const st = int(num(a[1])), n = int(num(a[2])); if (st < 1 || n < 0) throw ERR.VALUE; s.splice(st - 1, n, str(a[3])); return s.join(''); },
  FIND: (a) => { const s = str(a[1]); const st = int(num(opt(a[2], 1))); if (st < 1 || st > s.length + 1) throw ERR.VALUE; const i = s.indexOf(str(a[0]), st - 1); if (i < 0) throw ERR.VALUE; return i + 1; },
  SEARCH: (a) => {
    const s = str(a[1]); const st = int(num(opt(a[2], 1)));
    if (st < 1 || st > s.length + 1) throw ERR.VALUE;
    const pat = str(a[0]);
    if (/[*?]/.test(pat)) {
      const re = new RegExp(wildcard(pat).source.slice(1, -1), 'i');
      const m = re.exec(s.slice(st - 1));
      if (!m) throw ERR.VALUE;
      return m.index + st;
    }
    const i = s.toLowerCase().indexOf(pat.toLowerCase(), st - 1);
    if (i < 0) throw ERR.VALUE;
    return i + 1;
  },
  TEXT: (a) => { const v = scalar(a[0]); if (v instanceof FErr) throw v; const fmt = str(a[1]); return formatValue(typeof v === 'string' ? (parseNumberText(v) ?? v) : v, fmt).text; },
  VALUE: (a) => { const v = scalar(a[0]); if (typeof v === 'number') return v; const n = parseNumberText(str(v)); if (n == null) throw ERR.VALUE; return n; },
  NUMBERVALUE: (a) => {
    const v = scalar(a[0]);
    if (typeof v === 'number') return v;
    const dec = str(opt(a[1], '.')).charAt(0) || '.';
    const grp = str(opt(a[2], ',')).charAt(0) || ',';
    if (dec === grp) throw ERR.VALUE;
    let t = str(v).replace(/\s+/g, '').split(grp).join('');
    const pct = /%+$/.exec(t)?.[0].length ?? 0;
    t = t.slice(0, t.length - pct);
    if (t.split(dec).length > 2) throw ERR.VALUE;
    t = t.replace(dec, '.');
    if (t === '') return 0;
    if (!/^[+-]?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?$/i.test(t)) throw ERR.VALUE;
    return tidy(Number(t) / 100 ** pct);
  },
  FIXED: (a) => { const d = int(num(opt(a[1], 2))); const noComma = bool(opt(a[2], false)); const v = roundHalf(num(a[0]), d); return formatValue(v, (noComma ? '0' : '#,##0') + (d > 0 ? '.' + '0'.repeat(d) : '')).text; },
  REPT: (a) => { const n = int(num(a[1])); if (n < 0) throw ERR.VALUE; const s = str(a[0]); if (s.length * n > 32767) throw ERR.VALUE; return s.repeat(n); },
  EXACT: (a) => str(a[0]) === str(a[1]),
  CHAR: (a) => { const n = int(num(a[0])); if (n < 1 || n > 65535) throw ERR.VALUE; return String.fromCharCode(n); },
  CODE: (a) => { const s = str(a[0]); if (!s) throw ERR.VALUE; return s.codePointAt(0); },
  UNICHAR: (a) => { const n = int(num(a[0])); if (n < 1 || n > 0x10ffff) throw ERR.VALUE; return String.fromCodePoint(n); },
  UNICODE: (a) => { const s = str(a[0]); if (!s) throw ERR.VALUE; return s.codePointAt(0); },
  T: (a) => { const v = scalar(a[0]); return typeof v === 'string' ? v : ''; },
  N: (a) => { const v = scalar(a[0]); return typeof v === 'number' ? v : typeof v === 'boolean' ? (v ? 1 : 0) : 0; },
  TEXTBEFORE: (a) => { const s = str(a[0]), d = str(a[1]); const i = nthIndex(s, d, int(num(opt(a[2], 1)))); return s.slice(0, i); },
  TEXTAFTER: (a) => { const s = str(a[0]), d = str(a[1]); const i = nthIndex(s, d, int(num(opt(a[2], 1)))); return s.slice(i + d.length); },

  // 信息
  ISBLANK: (a) => { const v = scalar(a[0]); return v == null; },
  ISNUMBER: (a) => typeof scalar(a[0]) === 'number',
  ISTEXT: (a) => typeof scalar(a[0]) === 'string',
  ISNONTEXT: (a) => typeof scalar(a[0]) !== 'string',
  ISLOGICAL: (a) => typeof scalar(a[0]) === 'boolean',
  ISERROR: (a) => isErr(scalar(a[0])),
  ISERR: (a) => { const v = scalar(a[0]); return isErr(v) && v !== ERR.NA; },
  ISNA: (a) => scalar(a[0]) === ERR.NA,
  ISEVEN: (a) => int(num(a[0])) % 2 === 0,
  ISODD: (a) => Math.abs(int(num(a[0]))) % 2 === 1,
  NA: () => { throw ERR.NA; },
  ROW: (a, ctx) => (a[0] instanceof Ref ? a[0].r0 + 1 : ctx.r + 1),
  COLUMN: (a, ctx) => (a[0] instanceof Ref ? a[0].c0 + 1 : ctx.c + 1),
  ROWS: (a) => asMatrix(a[0]).h,
  COLUMNS: (a) => asMatrix(a[0]).w,

  // 查找与引用
  VLOOKUP: (a) => {
    const m = asMatrix(a[1]);
    const col = int(num(a[2]));
    if (col < 1) throw ERR.VALUE;
    if (col > m.w) throw ERR.REF;
    const approx = bool(opt(a[3], true));
    const keys = toList(slice(m, 'col', 0));
    const i = findIndex(a[0], keys, approx ? 1 : 0, { wild: true });
    if (i < 0) throw ERR.NA;
    return m.get(i, col - 1);
  },
  HLOOKUP: (a) => {
    const m = asMatrix(a[1]);
    const row = int(num(a[2]));
    if (row < 1) throw ERR.VALUE;
    if (row > m.h) throw ERR.REF;
    const approx = bool(opt(a[3], true));
    const keys = toList(slice(m, 'row', 0));
    const i = findIndex(a[0], keys, approx ? 1 : 0, { wild: true });
    if (i < 0) throw ERR.NA;
    return m.get(row - 1, i);
  },
  LOOKUP: (a) => {
    const m = asMatrix(a[1]);
    const vertical = m.h >= m.w;
    const keys = toList(vertical ? slice(m, 'col', 0) : slice(m, 'row', 0));
    const i = findIndex(a[0], keys, 1);
    if (i < 0) throw ERR.NA;
    if (a[2] !== undefined) return toList(asMatrix(a[2]))[i] ?? ERR.NA;
    return vertical ? m.get(i, m.w - 1) : m.get(m.h - 1, i);
  },
  MATCH: (a) => {
    const type = int(num(opt(a[2], 1)));
    const list = toList(a[1]);
    const i = findIndex(a[0], list, type === 0 ? 0 : type > 0 ? 1 : -1, { wild: true });
    if (i < 0) throw ERR.NA;
    return i + 1;
  },
  XMATCH: (a) => {
    const mode = int(num(opt(a[2], 0)));
    const search = int(num(opt(a[3], 1)));
    const i = findIndex(a[0], toList(a[1]), mode === 2 ? 0 : mode, { wild: mode === 2, reverse: search < 0, approxUnsorted: true });
    if (i < 0) throw ERR.NA;
    return i + 1;
  },
  XLOOKUP: (a) => {
    const look = asMatrix(a[1]);
    const ret = asMatrix(a[2]);
    const vertical = look.w === 1;
    const mode = int(num(opt(a[4], 0)));
    const search = int(num(opt(a[5], 1)));
    const i = findIndex(a[0], toList(look), mode === 2 ? 0 : mode, { wild: mode === 2, reverse: search < 0, approxUnsorted: true });
    if (i < 0) {
      if (a[3] !== undefined && !(a[3] && a[3].missing)) return scalar(a[3]);
      throw ERR.NA;
    }
    if (vertical) return ret.w === 1 ? ret.get(i, 0) : slice(ret, 'row', i);
    return ret.h === 1 ? ret.get(0, i) : slice(ret, 'col', i);
  },
  INDEX: (a) => {
    const m = asMatrix(a[0]);
    let r = int(num(opt(a[1], 0)));
    let c = int(num(opt(a[2], 0)));
    if (m.h === 1 && a[2] === undefined) { c = r; r = 1; }     // 一维行：INDEX(A1:E1, 3)
    if (r < 0 || c < 0 || r > m.h || c > m.w) throw ERR.REF;
    if (r === 0 && c === 0) return m;
    if (r === 0) return slice(m, 'col', c - 1);
    if (c === 0) return m.w === 1 ? m.get(r - 1, 0) : slice(m, 'row', r - 1);
    return m.get(r - 1, c - 1);
  },
  TRANSPOSE: (a) => {
    const m = asMatrix(a[0]);
    const rows = [];
    for (let j = 0; j < m.w; j++) { const row = []; for (let i = 0; i < m.h; i++) row.push(m.get(i, j)); rows.push(row); }
    return new Arr(rows);
  },
  SEQUENCE: (a) => {
    const h = int(num(a[0])), w = int(num(opt(a[1], 1)));
    const start = num(opt(a[2], 1)), step = num(opt(a[3], 1));
    if (h < 1 || w < 1) throw ERR.CALC;
    if (h * w > MAX_SPILL_CELLS) throw ERR.NUM;
    const rows = [];
    for (let i = 0; i < h; i++) { const row = []; for (let j = 0; j < w; j++) row.push(tidy(start + (i * w + j) * step)); rows.push(row); }
    return new Arr(rows);
  },
  SORT: (a) => {
    const byCol = bool(opt(a[3], false));
    const rows = matrixRows(asMatrix(a[0]), byCol);
    const k = int(num(opt(a[1], 1))) - 1;
    const order = int(num(opt(a[2], 1)));
    if (order !== 1 && order !== -1) throw ERR.VALUE;
    if (k < 0 || (rows.length && k >= rows[0].length)) throw ERR.VALUE;
    // 空格子不管升序降序都排在最后（与 Excel 一致）；稳定排序，相等的保持原顺序
    const sorted = rows.map((r, i) => ({ r, i })).sort((x, y) => {
      const u = x.r[k], v = y.r[k];
      if (u instanceof FErr) throw u;
      if (v instanceof FErr) throw v;
      const eu = u == null || u === '', ev = v == null || v === '';
      if (eu || ev) return eu === ev ? x.i - y.i : eu ? 1 : -1;
      return compare(u, v) * order || x.i - y.i;
    }).map((x) => x.r);
    return fromRows(sorted, byCol);
  },
  UNIQUE: (a) => {
    const byCol = bool(opt(a[1], false));
    const once = bool(opt(a[2], false));
    const rows = matrixRows(asMatrix(a[0]), byCol);
    // 按「行内容」分组；文本不分大小写（与 Excel 一致）
    const keyOf = (/** @type {any[]} */ r) => JSON.stringify(r.map((v) => (v instanceof FErr ? v.err : typeof v === 'string' ? 's' + v.toLowerCase() : v == null ? '' : typeof v === 'number' ? tidy(v) : v)));
    /** @type {Map<string, {r:any[], n:number}>} */ const seen = new Map();
    for (const r of rows) { const k = keyOf(r); const e = seen.get(k); if (e) e.n++; else seen.set(k, { r, n: 1 }); }
    const out = [...seen.values()].filter((e) => !once || e.n === 1).map((e) => e.r);
    if (!out.length) throw ERR.CALC;
    return fromRows(out, byCol);
  },
  FILTER: (a) => {
    const m = asMatrix(a[0]), inc = asMatrix(a[1]);
    // 条件是一列（按行筛）或一行（按列筛），长度要和数据对上
    const byCol = inc.h === 1 && inc.w === m.w && m.w > 1 && !(inc.w === 1 && m.h === 1);
    if (!byCol && !(inc.w === 1 && inc.h === m.h)) throw ERR.VALUE;
    const keep = toList(inc).map((v) => {
      if (v instanceof FErr) throw v;
      if (typeof v === 'string') { if (v === '') return false; throw ERR.VALUE; }
      return v == null ? false : typeof v === 'boolean' ? v : num(v) !== 0;
    });
    const rows = matrixRows(m, byCol).filter((_, i) => keep[i]);
    if (!rows.length) {
      if (a[2] !== undefined && !(a[2] && a[2].missing)) return isArr(a[2]) ? a[2] : scalar(a[2]);
      throw ERR.CALC;
    }
    return fromRows(rows, byCol);
  },

  // 日期与时间
  DATE: (a) => {
    let y = int(num(a[0]));
    if (y < 1900) y += 1900;
    const s = Math.round((Date.UTC(y, int(num(a[1])) - 1, int(num(a[2]))) - Date.UTC(1899, 11, 30)) / 86400000);
    if (s < 0) throw ERR.NUM;
    return s;
  },
  TIME: (a) => { const s = int(num(a[0])) * 3600 + int(num(a[1])) * 60 + int(num(a[2])); if (s < 0) throw ERR.NUM; return (s % 86400) / 86400; },
  TODAY: () => Math.floor(nowSerial()),
  NOW: () => nowSerial(),
  YEAR: (a) => serialToDate(dateArg(a[0])).y,
  MONTH: (a) => serialToDate(dateArg(a[0])).m,
  DAY: (a) => serialToDate(dateArg(a[0])).d,
  HOUR: (a) => serialToDate(Math.round(dateArg(a[0]) * 86400) / 86400).H,
  MINUTE: (a) => serialToDate(Math.round(dateArg(a[0]) * 86400) / 86400).M,
  SECOND: (a) => serialToDate(Math.round(dateArg(a[0]) * 86400) / 86400).S,
  WEEKDAY: (a) => {
    const wd = serialToDate(dateArg(a[0])).wd;
    const type = int(num(opt(a[1], 1)));
    if (type === 1) return wd + 1;
    if (type === 2) return wd === 0 ? 7 : wd;
    if (type === 3) return wd === 0 ? 6 : wd - 1;
    throw ERR.NUM;
  },
  WEEKNUM: (a) => {
    const s = Math.floor(dateArg(a[0]));
    const type = int(num(opt(a[1], 1)));
    const d = serialToDate(s);
    const jan1 = dateToSerial(d.y, 1, 1);
    const startWd = type === 2 ? 1 : 0;
    const wd1 = (serialToDate(jan1).wd - startWd + 7) % 7;
    return Math.floor((s - jan1 + wd1) / 7) + 1;
  },
  ISOWEEKNUM: (a) => {
    const s = Math.floor(dateArg(a[0]));
    const wd = (serialToDate(s).wd + 6) % 7;             // 周一 = 0
    const thu = s - wd + 3;
    const y = serialToDate(thu).y;
    return Math.floor((thu - dateToSerial(y, 1, 1)) / 7) + 1;
  },
  EDATE: (a) => addMonths(dateArg(a[0]), int(num(a[1]))),
  EOMONTH: (a) => { const s = addMonths(dateArg(a[0]), int(num(a[1]))); const d = serialToDate(s); return dateToSerial(d.y, d.m, daysIn(d.y, d.m)); },
  DAYS: (a) => Math.floor(dateArg(a[0])) - Math.floor(dateArg(a[1])),
  DATEDIF: (a) => {
    const s = Math.floor(dateArg(a[0])), e = Math.floor(dateArg(a[1]));
    if (s > e) throw ERR.NUM;
    const u = str(a[2]).toUpperCase();
    const A = serialToDate(s), B = serialToDate(e);
    let months = (B.y - A.y) * 12 + (B.m - A.m);
    if (B.d < A.d) months--;
    switch (u) {
      case 'D': return e - s;
      case 'M': return months;
      case 'Y': return Math.floor(months / 12);
      case 'YM': return months % 12;
      case 'MD': { let d = B.d - A.d; if (d < 0) d += daysIn(B.m === 1 ? B.y - 1 : B.y, B.m === 1 ? 12 : B.m - 1); return d; }
      case 'YD': { let start = dateToSerial(B.y, A.m, Math.min(A.d, daysIn(B.y, A.m))); if (start > e) start = dateToSerial(B.y - 1, A.m, Math.min(A.d, daysIn(B.y - 1, A.m))); return e - start; }
      default: throw ERR.NUM;
    }
  },
  NETWORKDAYS: (a) => {
    let s = Math.floor(dateArg(a[0])), e = Math.floor(dateArg(a[1]));
    const sign = s > e ? -1 : 1;
    if (s > e) [s, e] = [e, s];
    if (e - s > 100000) throw ERR.NUM;
    const hol = holidaySet(a[2]);
    let n = 0;
    for (let d = s; d <= e; d++) if (!isWeekend(d) && !hol.has(d)) n++;
    return n * sign;
  },
  WORKDAY: (a) => {
    let d = Math.floor(dateArg(a[0]));
    let left = int(num(a[1]));
    const step = left < 0 ? -1 : 1;
    const hol = holidaySet(a[2]);
    if (Math.abs(left) > 100000) throw ERR.NUM;
    while (left !== 0) { d += step; if (!isWeekend(d) && !hol.has(d)) left -= step; }
    return d;
  },
  DATEVALUE: (a) => { const n = parseDateText(str(a[0])); if (n == null) throw ERR.VALUE; return Math.floor(n); },
  TIMEVALUE: (a) => { const n = parseDateText(str(a[0])); if (n == null) throw ERR.VALUE; return n - Math.floor(n); },
  YEARFRAC: (a) => {
    let s = Math.floor(dateArg(a[0])), e = Math.floor(dateArg(a[1]));
    const basis = int(num(opt(a[2], 0)));
    if (s > e) [s, e] = [e, s];
    const A = serialToDate(s), B = serialToDate(e);
    switch (basis) {
      case 0: {                                    // 美式 30/360
        let d1 = A.d, d2 = B.d;
        const lastFeb = (x) => x.m === 2 && x.d === daysIn(x.y, 2);
        if (lastFeb(A) && lastFeb(B)) d2 = 30;
        if (lastFeb(A)) d1 = 30;
        if (d2 === 31 && d1 >= 30) d2 = 30;
        if (d1 === 31) d1 = 30;
        return tidy(((B.y - A.y) * 360 + (B.m - A.m) * 30 + (d2 - d1)) / 360);
      }
      case 1: {                                    // 实际/实际
        if (A.y === B.y) return tidy((e - s) / (dateToSerial(A.y + 1, 1, 1) - dateToSerial(A.y, 1, 1)));
        const oneYear = B.y === A.y + 1 && (B.m < A.m || (B.m === A.m && B.d <= A.d));
        if (oneYear) {
          const leap = (y) => daysIn(y, 2) === 29;
          const feb29In = [A.y, B.y].some((y) => leap(y) && dateToSerial(y, 2, 29) >= s && dateToSerial(y, 2, 29) <= e);
          return tidy((e - s) / (feb29In ? 366 : 365));
        }
        const avg = (dateToSerial(B.y + 1, 1, 1) - dateToSerial(A.y, 1, 1)) / (B.y - A.y + 1);
        return tidy((e - s) / avg);
      }
      case 2: return tidy((e - s) / 360);
      case 3: return tidy((e - s) / 365);
      case 4: {                                    // 欧式 30/360
        const d1 = Math.min(A.d, 30), d2 = Math.min(B.d, 30);
        return tidy(((B.y - A.y) * 360 + (B.m - A.m) * 30 + (d2 - d1)) / 360);
      }
      default: throw ERR.NUM;
    }
  },

  // 财务
  PMT: (a) => {
    const r = num(a[0]), n = num(a[1]), pv = num(a[2]), fv = num(opt(a[3], 0)), type = num(opt(a[4], 0)) ? 1 : 0;
    if (n === 0) throw ERR.NUM;
    if (r === 0) return -(pv + fv) / n;
    const f = (1 + r) ** n;
    return fin(-(r * (pv * f + fv)) / ((1 + r * type) * (f - 1)));
  },
  FV: (a) => {
    const r = num(a[0]), n = num(a[1]), pmt = num(a[2]), pv = num(opt(a[3], 0)), type = num(opt(a[4], 0)) ? 1 : 0;
    if (r === 0) return -(pv + pmt * n);
    const f = (1 + r) ** n;
    return fin(-(pv * f + pmt * (1 + r * type) * (f - 1) / r));
  },
  PV: (a) => {
    const r = num(a[0]), n = num(a[1]), pmt = num(a[2]), fv = num(opt(a[3], 0)), type = num(opt(a[4], 0)) ? 1 : 0;
    if (r === 0) return -(fv + pmt * n);
    const f = (1 + r) ** n;
    return fin(-(fv + pmt * (1 + r * type) * (f - 1) / r) / f);
  },
  NPV: (a) => { const r = num(a[0]); let s = 0, k = 1; for (const x of nums(a.slice(1))) s += x / (1 + r) ** k++; return fin(s); },
  IRR: (a) => {
    const cf = nums([a[0]]);
    let r = num(opt(a[1], 0.1));
    for (let it = 0; it < 100; it++) {
      let f = 0, df = 0;
      for (let k = 0; k < cf.length; k++) { f += cf[k] / (1 + r) ** k; df -= k * cf[k] / (1 + r) ** (k + 1); }
      if (Math.abs(f) < 1e-10) return r;
      if (df === 0) break;
      r -= f / df;
    }
    throw ERR.NUM;
  },
};

// 别名
FUNCS['STDEV.S'] = FUNCS.STDEV;
FUNCS['STDEV.P'] = FUNCS.STDEVP;
FUNCS['VAR.S'] = FUNCS.VAR;
FUNCS['VAR.P'] = FUNCS.VARP;
FUNCS['RANK.EQ'] = FUNCS.RANK;
FUNCS['MODE.SNGL'] = FUNCS.MODE;
FUNCS['PERCENTILE.INC'] = FUNCS.PERCENTILE;
FUNCS['QUARTILE.INC'] = FUNCS.QUARTILE;
// .MATH 版本：基数取绝对值；负数默认朝正无穷（CEILING）/ 负无穷（FLOOR），模式非 0 时反过来（远离 / 朝向 0）
FUNCS['CEILING.MATH'] = (a) => {
  const n = num(a[0]), s = Math.abs(num(opt(a[1], 1))), away = num(opt(a[2], 0)) !== 0;
  if (s === 0) return 0;
  const q = tidy(n / s);
  return tidy((n < 0 && away ? Math.floor(q) : Math.ceil(q)) * s);
};
FUNCS['FLOOR.MATH'] = (a) => {
  const n = num(a[0]), s = Math.abs(num(opt(a[1], 1))), toward = num(opt(a[2], 0)) !== 0;
  if (s === 0) return 0;
  const q = tidy(n / s);
  return tidy((n < 0 && toward ? Math.ceil(q) : Math.floor(q)) * s);
};

/** @param {number} n @param {number} d */
function roundHalf(n, d) {
  const f = 10 ** d;
  const x = tidy(Math.abs(n) * f);
  return Math.sign(n) * Math.round(x) / f;
}

/** @param {number} n @param {number} d @param {1|-1} dir 1 远离 0，-1 朝向 0 */
function roundDir(n, d, dir) {
  const f = 10 ** d;
  const x = tidy(Math.abs(n) * f);
  return Math.sign(n) * (dir > 0 ? Math.ceil(x) : Math.floor(x)) / f;
}

/**
 * 短路求值的函数：参数是 thunk。
 * @type {Record<string, (args:(() => any)[], ctx:Ctx) => any>}
 */
export const LAZY = {
  IF: (a) => {
    if (a.length < 2) throw ERR.VALUE;
    const c = bool(a[0]());
    if (c) return a[1]();
    return a.length > 2 ? a[2]() : false;
  },
  IFS: (a) => {
    for (let k = 0; k + 1 < a.length; k += 2) if (bool(a[k]())) return a[k + 1]();
    throw ERR.NA;
  },
  IFERROR: (a) => {
    let v;
    try { v = scalar(a[0]()); } catch (e) { if (e instanceof FErr) return a[1](); throw e; }
    return isErr(v) ? a[1]() : v;
  },
  IFNA: (a) => {
    let v;
    try { v = scalar(a[0]()); } catch (e) { if (e === ERR.NA) return a[1](); throw e; }
    return v === ERR.NA ? a[1]() : v;
  },
  CHOOSE: (a) => {
    const i = int(num(a[0]()));
    if (i < 1 || i >= a.length) throw ERR.VALUE;
    return a[i]();
  },
  SWITCH: (a) => {
    const v = scalar(a[0]());
    if (v instanceof FErr) throw v;
    let k = 1;
    for (; k + 1 < a.length; k += 2) {
      const cand = scalar(a[k]());
      if (cand != null && typeof cand === typeof v && compare(cand, v) === 0) return a[k + 1]();
    }
    if (k < a.length) return a[k]();
    throw ERR.NA;
  },
};

/** 所有函数名（公式栏自动补全用）。 */
export const FUNCTION_NAMES = [...Object.keys(FUNCS), ...Object.keys(LAZY), 'IMPORTRANGE'].sort();

/** 常用函数的中文说明（自动补全提示）。 */
export const FUNCTION_HELP = {
  SUM: tt('SUM(数值1, ...) 求和'),
  AVERAGE: tt('AVERAGE(数值1, ...) 平均值'),
  COUNT: tt('COUNT(值1, ...) 数字个数'),
  COUNTA: tt('COUNTA(值1, ...) 非空个数'),
  MAX: tt('MAX(数值1, ...) 最大值'),
  MIN: tt('MIN(数值1, ...) 最小值'),
  IF: tt('IF(条件, 真值, [假值])'),
  IFS: tt('IFS(条件1, 值1, ...)'),
  IFERROR: tt('IFERROR(值, 出错时的值)'),
  AND: tt('AND(条件1, ...) 全部为真'),
  OR: tt('OR(条件1, ...) 任一为真'),
  SUMIF: tt('SUMIF(区域, 条件, [求和区域])'),
  SUMIFS: tt('SUMIFS(求和区域, 区域1, 条件1, ...)'),
  COUNTIF: tt('COUNTIF(区域, 条件)'),
  COUNTIFS: tt('COUNTIFS(区域1, 条件1, ...)'),
  AVERAGEIF: tt('AVERAGEIF(区域, 条件, [平均区域])'),
  VLOOKUP: tt('VLOOKUP(查找值, 表格区域, 列序号, [近似匹配])'),
  HLOOKUP: tt('HLOOKUP(查找值, 表格区域, 行序号, [近似匹配])'),
  XLOOKUP: tt('XLOOKUP(查找值, 查找区域, 返回区域, [未找到], [匹配模式], [搜索模式])'),
  INDEX: tt('INDEX(区域, 行号, [列号])'),
  MATCH: tt('MATCH(查找值, 区域, [匹配类型])'),
  ROUND: tt('ROUND(数值, 小数位数) 四舍五入'),
  ROUNDUP: tt('ROUNDUP(数值, 小数位数) 向上舍入'),
  ROUNDDOWN: tt('ROUNDDOWN(数值, 小数位数) 向下舍入'),
  CONCAT: tt('CONCAT(文本1, ...) 连接文本'),
  TEXTJOIN: tt('TEXTJOIN(分隔符, 忽略空值, 文本1, ...)'),
  LEFT: tt('LEFT(文本, [字符数])'),
  RIGHT: tt('RIGHT(文本, [字符数])'),
  MID: tt('MID(文本, 起始位置, 字符数)'),
  LEN: tt('LEN(文本) 字符数'),
  TEXT: tt('TEXT(值, 格式) 按格式显示'),
  TODAY: tt('TODAY() 今天'),
  NOW: tt('NOW() 现在'),
  DATE: tt('DATE(年, 月, 日)'),
  DATEDIF: tt('DATEDIF(开始日期, 结束日期, "Y"/"M"/"D")'),
  SUMPRODUCT: tt('SUMPRODUCT(数组1, ...) 乘积之和'),
  RANK: tt('RANK(数值, 区域, [升序])'),
  SUBSTITUTE: tt('SUBSTITUTE(文本, 旧文本, 新文本, [第几个])'),
  TRIM: tt('TRIM(文本) 去除多余空格'),
  ABS: tt('ABS(数值) 绝对值'),
  MOD: tt('MOD(被除数, 除数) 余数'),
  PMT: tt('PMT(利率, 期数, 现值, [终值], [类型]) 每期还款额'),
  IMPORTRANGE: tt('IMPORTRANGE(表编号或链接, 区域) 引用另一张表，如 IMPORTRANGE("tbl_xxx", "A1:C10")'),
};
