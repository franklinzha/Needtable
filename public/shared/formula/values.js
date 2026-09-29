/**
 * 公式引擎的值类型与类型转换。
 *
 * 引擎里流动的值只有这几种：
 *   number | string | boolean | null（空单元格） | FErr（错误值）
 *   Ref（一块单元格区域，惰性取值） | Arr（运算产生的临时数组）
 *
 * 存储层每个单元格都是字符串，"123" 就是数字 123 —— 用户在 Excel 里敲 123
 * 得到的也是数字。所以「读单元格」这一步要做一次字面量解析（parseLiteral）。
 * 日期字符串（2024-01-15）刻意保持为文本：否则 =A1 会显示成 45306，
 * 而这里没有 Excel 那种「值是数字、格式记在别处」的单元格类型。
 * 代价是 SUM 不会把日期文本加进去；日期函数与算术运算会按需把它换成序列号。
 */

export class FErr {
  /** @param {string} code */
  constructor(code) { this.err = code; }
  toString() { return this.err; }
}

export const ERR = {
  DIV0: new FErr('#DIV/0!'),
  VALUE: new FErr('#VALUE!'),
  REF: new FErr('#REF!'),
  NAME: new FErr('#NAME?'),
  NUM: new FErr('#NUM!'),
  NA: new FErr('#N/A'),
  NULL: new FErr('#NULL!'),
  CIRC: new FErr('#CIRC!'),
  /** 跨表引用的数据还在路上；到了之后整表重算 */
  LOADING: new FErr('#LOADING'),
  /** 结果是一块区域，但要铺开的位置上已经有内容 */
  SPILL: new FErr('#SPILL!'),
  /** 结果为空（FILTER 一个都没筛到又没给「为空时」） */
  CALC: new FErr('#CALC!'),
};

const BY_CODE = new Map(Object.values(ERR).map((e) => [e.err, e]));
/** @param {string} code */
export const errOf = (code) => BY_CODE.get(code) ?? new FErr(code);

/** @param {any} v @returns {v is FErr} */
export const isErr = (v) => v instanceof FErr;

/**
 * 一块矩形区域。取值走引擎，所以 SUM(A:A) 不会先把 20 万个格子物化成数组。
 */
export class Ref {
  /**
   * @param {{cell:(r:number,c:number)=>any}} eng
   * @param {number} r0 @param {number} c0 @param {number} r1 @param {number} c1
   */
  constructor(eng, r0, c0, r1, c1) {
    this.eng = eng;
    this.r0 = r0; this.c0 = c0; this.r1 = r1; this.c1 = c1;
  }
  get h() { return this.r1 - this.r0 + 1; }
  get w() { return this.c1 - this.c0 + 1; }
  /** @param {number} i @param {number} j */
  get(i, j) { return this.eng.cell(this.r0 + i, this.c0 + j); }
}

/** 运算产生的临时二维数组（A1:A3*2、(B1:B9="x") 这类）。 */
export class Arr {
  /** @param {any[][]} rows */
  constructor(rows) { this.rows = rows; }
  get h() { return this.rows.length; }
  get w() { return this.rows[0]?.length ?? 0; }
  /** @param {number} i @param {number} j */
  get(i, j) { return this.rows[i]?.[j] ?? null; }
}

/** @param {any} v @returns {v is Ref|Arr} */
export const isArr = (v) => v instanceof Ref || v instanceof Arr;

/** 空参数：IF(A1,,1) 中间那个。当值用时等同空。 */
export const MISSING = Object.freeze({ missing: true });

/** 需要单个值的地方拿到区域：取左上角（相当于隐式交集的简化）。 @param {any} v */
export function scalar(v) {
  if (v instanceof Ref || v instanceof Arr) return v.h && v.w ? v.get(0, 0) : ERR.VALUE;
  if (v === MISSING) return null;
  return v;
}

/** 按行主序遍历。 @param {any} v @param {(x:any, i:number, j:number)=>void} fn */
export function each(v, fn) {
  if (v instanceof Ref || v instanceof Arr) {
    const h = v.h, w = v.w;
    for (let i = 0; i < h; i++) for (let j = 0; j < w; j++) fn(v.get(i, j), i, j);
  } else fn(v, 0, 0);
}

/** 展开成一维（查找函数用）。 @param {any} v @returns {any[]} */
export function toList(v) {
  /** @type {any[]} */ const out = [];
  each(v, (x) => out.push(x));
  return out;
}

// ── 日期序列号：1899-12-30 为 0，与 Excel 的 1900 日期系统在 1900-03-01 之后一致 ──

const EPOCH = Date.UTC(1899, 11, 30);
const DAY = 86400000;

/** @param {number} y @param {number} m 1 起 @param {number} d */
export function dateToSerial(y, m, d) {
  return Math.round((Date.UTC(y, m - 1, d) - EPOCH) / DAY);
}

/** @param {number} serial @returns {{y:number, m:number, d:number, wd:number, H:number, M:number, S:number, ms:number}} */
export function serialToDate(serial) {
  const ms = Math.round(serial * DAY) + EPOCH;
  const dt = new Date(ms);
  return {
    y: dt.getUTCFullYear(), m: dt.getUTCMonth() + 1, d: dt.getUTCDate(), wd: dt.getUTCDay(),
    H: dt.getUTCHours(), M: dt.getUTCMinutes(), S: dt.getUTCSeconds(), ms: dt.getUTCMilliseconds(),
  };
}

/** 当前本地时间的序列号（带小数）。 */
export function nowSerial() {
  const d = new Date();
  return dateToSerial(d.getFullYear(), d.getMonth() + 1, d.getDate())
    + (d.getHours() * 3600 + d.getMinutes() * 60 + d.getSeconds()) / 86400;
}

const RE_DATE = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?$/;
const RE_DATE_CN = /^(\d{4})年(\d{1,2})月(\d{1,2})日?(?:\s*(\d{1,2}):(\d{2})(?::(\d{2}))?)?$/;
const RE_TIME = /^(\d{1,2}):(\d{2})(?::(\d{2}(?:\.\d+)?))?\s*([AaPp][Mm])?$/;
const RE_NUMTEXT = /^[-+]?(?:\d+(?:,\d{3})*|\d*)(?:\.\d+)?(?:[eE][-+]?\d+)?$/;

/** 日期 / 时间文本 → 序列号；不是日期返回 null。 @param {string} s */
export function parseDateText(s) {
  const t = s.trim();
  let m = RE_DATE.exec(t) || RE_DATE_CN.exec(t);
  if (m) {
    const y = +m[1], mo = +m[2], d = +m[3];
    if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
    const dt = new Date(Date.UTC(y, mo - 1, d));
    if (dt.getUTCMonth() !== mo - 1) return null;          // 2 月 30 日之类
    let v = dateToSerial(y, mo, d);
    if (m[4] != null) v += (+m[4] * 3600 + +m[5] * 60 + +(m[6] ?? 0)) / 86400;
    return v;
  }
  m = RE_TIME.exec(t);
  if (m) {
    let h = +m[1];
    const mi = +m[2], sec = +(m[3] ?? 0);
    if (m[4]) {
      const pm = m[4].toLowerCase() === 'pm';
      if (h > 12) return null;
      if (h === 12) h = pm ? 12 : 0; else if (pm) h += 12;
    }
    if (h > 23 || mi > 59 || sec >= 60) return null;
    return (h * 3600 + mi * 60 + sec) / 86400;
  }
  return null;
}

/**
 * 「看起来像数字」的文本 → 数字；做不到返回 null。
 * 接受：千分位、百分号、货币符号、括号负数、日期、时间。
 * @param {string} s
 */
export function parseNumberText(s) {
  let t = s.trim();
  if (!t) return null;
  let neg = false;
  if (t[0] === '(' && t[t.length - 1] === ')') { neg = true; t = t.slice(1, -1).trim(); }
  let pct = false;
  if (t.endsWith('%')) { pct = true; t = t.slice(0, -1).trim(); }
  let sign = '';
  if (t[0] === '-' || t[0] === '+') { sign = t[0]; t = t.slice(1).trim(); }
  if (/^[¥$€£￥]/.test(t)) t = t.slice(1).trim();
  if (RE_NUMTEXT.test(t) && /\d/.test(t)) {
    let n = Number(t.replace(/,/g, ''));
    if (!Number.isFinite(n)) return null;
    if (sign === '-') n = -n;
    if (neg) n = -n;
    if (pct) n /= 100;
    return n;
  }
  if (!neg && !pct && !sign) return parseDateText(s);
  return null;
}

const RE_PLAIN_NUM = /^\s*[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?\s*$/;

/**
 * 单元格原文 → 值。只把「明确是数字」的认成数字：普通数字与百分数。
 * 带千分位、货币符号的仍当文本（和 Excel 里「文本格式的单元格」一样），
 * 但参与运算时 num() 会替它转换。
 * @param {string} raw
 */
export function parseLiteral(raw) {
  if (raw === '' || raw == null) return null;
  if (RE_PLAIN_NUM.test(raw)) return Number(raw);
  const last = raw.charCodeAt(raw.length - 1);
  if (last === 37 /* % */ && RE_PLAIN_NUM.test(raw.slice(0, -1))) return Number(raw.slice(0, -1)) / 100;
  if (raw.length <= 5) {
    const u = raw.toUpperCase();
    if (u === 'TRUE') return true;
    if (u === 'FALSE') return false;
  }
  if (raw[0] === '#') {
    const e = BY_CODE.get(raw.toUpperCase());
    if (e) return e;
  }
  return raw;
}

// ── 强制转换：失败时 throw 错误值，由函数调用处统一接住 ─────────────────────

/** @param {any} v @returns {number} */
export function num(v) {
  v = scalar(v);
  if (typeof v === 'number') return v;
  if (v == null) return 0;
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (v instanceof FErr) throw v;
  const n = parseNumberText(String(v));
  if (n == null) throw ERR.VALUE;
  return n;
}

/** @param {any} v @returns {string} */
export function str(v) {
  v = scalar(v);
  if (v == null) return '';
  if (typeof v === 'string') return v;
  if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE';
  if (typeof v === 'number') return numToStr(v);
  if (v instanceof FErr) throw v;
  return String(v);
}

/** @param {any} v @returns {boolean} */
export function bool(v) {
  v = scalar(v);
  if (typeof v === 'boolean') return v;
  if (typeof v === 'number') return v !== 0;
  if (v == null) return false;
  if (v instanceof FErr) throw v;
  const u = String(v).toUpperCase();
  if (u === 'TRUE') return true;
  if (u === 'FALSE') return false;
  throw ERR.VALUE;
}

/** 浮点噪音归零：0.1+0.2 → 0.3。 @param {number} n */
export const tidy = (n) => (Number.isFinite(n) ? +n.toPrecision(15) : n);

/**
 * 「常规」格式下数字的文本：最多 10 位有效数字，过大过小改用科学计数。
 * @param {number} n
 */
export function numToText(n) {
  if (!Number.isFinite(n)) return '#NUM!';
  if (n === 0) return '0';
  const a = Math.abs(n);
  // JS 在 1e-7 以下自己改用 1e-7 写法：一律走 Excel 风格的 1E-07
  if (a >= 1e11 || a < 1e-6) {
    const [m, e] = n.toExponential(5).split('e');
    const mm = m.replace(/\.?0+$/, '');
    const ee = Number(e);
    return mm + 'E' + (ee < 0 ? '-' : '+') + String(Math.abs(ee)).padStart(2, '0');
  }
  return String(parseFloat(n.toPrecision(10)));
}

/**
 * 数字参与文本运算（& LEFT LEN …）时的文本：和 Excel 一样保留 15 位有效数字，
 * 123456789012&"" 得 "123456789012"，不像「常规」显示那样截成科学计数。
 * @param {number} n
 */
function numToStr(n) {
  const a = Math.abs(n);
  if (!Number.isFinite(n) || n === 0 || a >= 1e15 || a < 1e-6) return numToText(n);
  return String(parseFloat(n.toPrecision(15)));
}

/** Excel 的比较序：数字 < 文本 < 布尔；文本不分大小写。 @param {any} t */
const rank = (t) => (typeof t === 'number' ? 0 : typeof t === 'string' ? 1 : typeof t === 'boolean' ? 2 : 3);

/** @param {any} a @param {any} b @returns {number} */
export function compare(a, b) {
  if (a == null) a = typeof b === 'string' ? '' : typeof b === 'boolean' ? false : 0;
  if (b == null) b = typeof a === 'string' ? '' : typeof a === 'boolean' ? false : 0;
  const ra = rank(a), rb = rank(b);
  if (ra !== rb) return ra < rb ? -1 : 1;
  if (typeof a === 'string') {
    const x = a.toLowerCase(), y = b.toLowerCase();
    return x < y ? -1 : x > y ? 1 : 0;
  }
  if (typeof a === 'number') { const x = tidy(a), y = tidy(b); return x < y ? -1 : x > y ? 1 : 0; }
  return a === b ? 0 : a ? 1 : -1;
}

/** 通配符 * ? 与转义 ~ → 正则。 @param {string} pat */
export function wildcard(pat) {
  let re = '';
  for (let i = 0; i < pat.length; i++) {
    const ch = pat[i];
    if (ch === '~' && i + 1 < pat.length) { re += pat[++i].replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); continue; }
    if (ch === '*') re += '[\\s\\S]*';
    else if (ch === '?') re += '[\\s\\S]';
    else re += ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp('^' + re + '$', 'i');
}

/**
 * COUNTIF / SUMIF 一族的条件 → 判定函数。
 * 支持 ">=10"、"<>x"、"=x"、"a*"、"" （空）、以及直接给数字 / 布尔。
 * @param {any} crit
 * @returns {(v:any) => boolean}
 */
export function criteria(crit) {
  crit = scalar(crit);
  if (crit instanceof FErr) throw crit;
  if (typeof crit === 'number') return (v) => typeof v === 'number' ? tidy(v - crit) === 0
    : typeof v === 'string' && parseNumberText(v) === crit;
  if (typeof crit === 'boolean') return (v) => v === crit;
  if (crit == null) return (v) => v == null || v === '';

  const s = String(crit);
  const m = /^(<=|>=|<>|<|>|=)?([\s\S]*)$/.exec(s);
  const op = m?.[1] ?? '';
  const rest = m?.[2] ?? '';

  if (rest === '') {
    if (op === '<>') return (v) => v != null && v !== '';
    if (op === '' || op === '=') return (v) => v == null || v === '';
    return () => false;
  }

  const n = parseNumberText(rest);
  if (n != null) {
    const toN = (/** @type {any} */ v) => typeof v === 'number' ? v
      : typeof v === 'string' ? parseNumberText(v) : null;
    switch (op) {
      case '>': return (v) => { const x = toN(v); return x != null && typeof v !== 'boolean' && tidy(x - n) > 0; };
      case '>=': return (v) => { const x = toN(v); return x != null && typeof v !== 'boolean' && tidy(x - n) >= 0; };
      case '<': return (v) => { const x = toN(v); return x != null && typeof v !== 'boolean' && tidy(x - n) < 0; };
      case '<=': return (v) => { const x = toN(v); return x != null && typeof v !== 'boolean' && tidy(x - n) <= 0; };
      case '<>': return (v) => { const x = toN(v); return x == null || tidy(x - n) !== 0; };
      default: return (v) => { const x = toN(v); return x != null && tidy(x - n) === 0; };
    }
  }

  const u = rest.toUpperCase();
  if (u === 'TRUE' || u === 'FALSE') {
    const b = u === 'TRUE';
    return op === '<>' ? (v) => v !== b : (v) => v === b;
  }

  const hasWild = /[*?]/.test(rest);
  const re = hasWild ? wildcard(rest) : null;
  const low = rest.toLowerCase();
  const eq = (/** @type {any} */ v) => {
    if (typeof v !== 'string') return false;
    return re ? re.test(v) : v.toLowerCase() === low;
  };
  switch (op) {
    case '<>': return (v) => !eq(v);
    case '>': return (v) => typeof v === 'string' && v.toLowerCase() > low;
    case '>=': return (v) => typeof v === 'string' && v.toLowerCase() >= low;
    case '<': return (v) => typeof v === 'string' && v.toLowerCase() < low;
    case '<=': return (v) => typeof v === 'string' && v.toLowerCase() <= low;
    default: return eq;
  }
}
