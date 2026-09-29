/**
 * 跨表引用的公共部分：浏览器、Worker、TableDO 三处共用。
 *
 * 语法与 Google 表格一致，表编号就是地址栏 /t/ 后面那段：
 *   =tbl_xxx!A1        =SUM(tbl_xxx!B2:B100)        =XLOOKUP(A2, tbl_xxx!A:A, tbl_xxx!C:C)
 *   =IMPORTRANGE("tbl_xxx", "A1:C10")   —— 第一个参数也可以是整条表格链接
 *
 * 区域在网络上、在 table_refs 里一律用「规范化的 A1 文本」表示：去掉 $、左上到右下、
 * 大写，整列 A:C、整行 1:3。这样同一块区域不管公式里怎么写，都是同一个键。
 *
 * 取回来的值打包成 { r0, c0, rows }：rows 里是计算结果（数字 / 文本 / 布尔 / null），
 * 错误值写成 { e: '#REF!' }。解包成一个 Ref —— 于是 ROW()、SUMIF 的对齐、
 * 「区域里的文本不参与求和」这些规则和本表引用完全一样。
 */

import { colName, colIndex } from '../util/a1.js';
import { parse, MAX_ROW, MAX_COL } from './parse.js';
import { Ref, FErr, errOf, ERR } from './values.js';

/** 表编号的格式（uid('tbl')：8 位时间戳 + 随机，全小写 base36） */
export const TABLE_ID_RE = /^tbl_[a-z0-9]{4,40}$/;

/** 单次引用的区域上限：有界区域按格数算，整列 / 整行按列数 / 行数算 */
export const MAX_EXT_CELLS = 50000;
export const MAX_EXT_SPAN = 50;

/** 跨表最多往下追几层（A 引 B、B 引 C …） */
export const MAX_EXT_DEPTH = 3;

/**
 * @typedef {{ r0: number|null, c0: number|null, r1: number|null, c1: number|null }} Rg
 *   整列时 r0/r1 为 null，整行时 c0/c1 为 null
 */

/**
 * 把 parse.js 的引用两端（RefPart）规范化成区域。
 * @param {{r:number|null, c:number|null}} a @param {{r:number|null, c:number|null}} b
 * @returns {Rg}
 */
export function rgOf(a, b) {
  return {
    r0: a.r == null || b.r == null ? null : Math.min(a.r, b.r),
    r1: a.r == null || b.r == null ? null : Math.max(a.r, b.r),
    c0: a.c == null || b.c == null ? null : Math.min(a.c, b.c),
    c1: a.c == null || b.c == null ? null : Math.max(a.c, b.c),
  };
}

/** 区域 → 规范化文本。 @param {Rg} g */
export function keyOf(g) {
  if (g.r0 == null) return colName(/** @type {number} */ (g.c0)) + ':' + colName(/** @type {number} */ (g.c1));
  if (g.c0 == null) return (g.r0 + 1) + ':' + (/** @type {number} */ (g.r1) + 1);
  const a = colName(g.c0) + (g.r0 + 1);
  return g.r0 === g.r1 && g.c0 === g.c1 ? a : a + ':' + colName(/** @type {number} */ (g.c1)) + (/** @type {number} */ (g.r1) + 1);
}

/**
 * 区域文本 → 区域。接受 $、小写、反着写（C10:A1）、Google 那种「Sheet1!A1:C10」的前缀。
 * @param {string} s @returns {Rg | null}
 */
export function parseRange(s) {
  if (typeof s !== 'string') return null;
  let t = s.trim().replace(/\$/g, '').toUpperCase();
  const bang = t.lastIndexOf('!');
  if (bang >= 0) t = t.slice(bang + 1);
  let m = /^([A-Z]{1,3})([0-9]{1,7})(?::([A-Z]{1,3})([0-9]{1,7}))?$/.exec(t);
  if (m) {
    const a = { c: colIndex(m[1]), r: Number(m[2]) - 1 };
    const b = m[3] ? { c: colIndex(m[3]), r: Number(m[4]) - 1 } : a;
    if (!okR(a.r) || !okR(b.r) || !okC(a.c) || !okC(b.c)) return null;
    return rgOf(a, b);
  }
  m = /^([A-Z]{1,3}):([A-Z]{1,3})$/.exec(t);
  if (m) {
    const c0 = colIndex(m[1]), c1 = colIndex(m[2]);
    if (!okC(c0) || !okC(c1)) return null;
    return rgOf({ r: null, c: c0 }, { r: null, c: c1 });
  }
  m = /^([0-9]{1,7}):([0-9]{1,7})$/.exec(t);
  if (m) {
    const r0 = Number(m[1]) - 1, r1 = Number(m[2]) - 1;
    if (!okR(r0) || !okR(r1)) return null;
    return rgOf({ r: r0, c: null }, { r: r1, c: null });
  }
  return null;
}
/** @param {number} r */ const okR = (r) => Number.isInteger(r) && r >= 0 && r < MAX_ROW;
/** @param {number} c */ const okC = (c) => Number.isInteger(c) && c >= 0 && c < MAX_COL;

/** 规范化：任何写法 → 同一个键；不合法返回 null。 @param {string} s */
export function normRange(s) {
  const g = parseRange(s);
  return g ? keyOf(g) : null;
}

/** 区域是否大到不允许跨表取。 @param {Rg} g */
export function tooBig(g) {
  if (g.r0 == null) return /** @type {number} */ (g.c1) - /** @type {number} */ (g.c0) + 1 > MAX_EXT_SPAN;
  if (g.c0 == null) return /** @type {number} */ (g.r1) - g.r0 + 1 > MAX_EXT_SPAN;
  return (/** @type {number} */ (g.r1) - g.r0 + 1) * (/** @type {number} */ (g.c1) - g.c0 + 1) > MAX_EXT_CELLS;
}

/** outer 是否完整盖住 inner（登记过 A:C，那 B2:B9 当然也能读）。 @param {Rg} o @param {Rg} i */
export function covers(o, i) {
  const rows = o.r0 == null || (i.r0 != null && i.r0 >= o.r0 && /** @type {number} */ (i.r1) <= /** @type {number} */ (o.r1));
  const cols = o.c0 == null || (i.c0 != null && i.c0 >= o.c0 && /** @type {number} */ (i.c1) <= /** @type {number} */ (o.c1));
  return rows && cols;
}

/**
 * IMPORTRANGE 的第一个参数：表编号本身，或者带 /t/tbl_xxx 的整条链接。
 * @param {string} s @returns {string | null}
 */
export function tableIdFrom(s) {
  if (typeof s !== 'string') return null;
  const m = /(?:^|\/t\/)(tbl_[A-Za-z0-9]{4,40})(?:$|[/?#])/.exec(s.trim());
  return m ? m[1].toLowerCase() : null;
}

/**
 * 公式里的全部外表引用（去重）。公式提交时拿它去服务端登记。
 * IMPORTRANGE 只认两个参数都是字面量字符串的写法 —— 算出来的地址没法在写入时登记。
 * @param {string} body 不含 '='
 * @returns {{ table: string, range: string }[]}
 */
export function extRefsIn(body) {
  let ast;
  try { ast = parse(body); } catch { return []; }
  /** @type {Map<string, { table: string, range: string }>} */ const out = new Map();
  const add = (/** @type {string} */ table, /** @type {string | null} */ range) => {
    if (range) out.set(table + '!' + range, { table, range });
  };
  (function walk(/** @type {any} */ n) {
    if (!n || typeof n !== 'object') return;
    if (n.type === 'ref' && n.table) add(n.table, keyOf(rgOf(n.a, n.a)));
    else if (n.type === 'range' && n.table) add(n.table, keyOf(rgOf(n.a, n.b)));
    else if (n.type === 'fn') {
      if (n.name === 'IMPORTRANGE' && n.args[0]?.type === 'str' && n.args[1]?.type === 'str') {
        const t = tableIdFrom(n.args[0].v);
        if (t) add(t, normRange(n.args[1].v));
      }
      n.args.forEach(walk);
    } else {
      walk(n.e); walk(n.l); walk(n.r);
    }
  })(ast);
  return [...out.values()];
}

// ── 打包 / 解包 ──────────────────────────────────────────────────────────────

/** 单个计算结果 → JSON。 @param {any} v */
export function packValue(v) {
  if (v instanceof FErr) return { e: v.err };
  if (v == null || typeof v === 'number' || typeof v === 'string' || typeof v === 'boolean') return v ?? null;
  return String(v);
}

/**
 * 服务端返回的一项 → 引擎能用的值：Ref，或者错误。
 * @param {any} p { r0, c0, rows } | { e }
 * @returns {Ref | FErr}
 */
export function unpackRange(p) {
  if (!p || typeof p !== 'object') return ERR.REF;
  if (typeof p.e === 'string') return errOf(p.e);
  const rows = Array.isArray(p.rows) ? p.rows : [];
  const r0 = Number(p.r0) || 0, c0 = Number(p.c0) || 0;
  const h = Math.max(1, rows.length);
  const w = Math.max(1, ...rows.map((/** @type {any[]} */ r) => (Array.isArray(r) ? r.length : 0)));
  const eng = {
    /** @param {number} r @param {number} c */
    cell(r, c) {
      const v = rows[r - r0]?.[c - c0];
      if (v && typeof v === 'object') return typeof v.e === 'string' ? errOf(v.e) : null;
      return v ?? null;
    },
  };
  return new Ref(eng, r0, c0, r0 + h - 1, c0 + w - 1);
}
