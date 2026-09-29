/**
 * 公式求值引擎。
 *
 * 惰性 + 缓存：只算被问到的格子（通常就是屏幕上那几百个），结果缓存到下一次
 * invalidate()。数据一变就整体作废 —— 精确的依赖图在协作场景下（别人随时改任何格子）
 * 维护成本高、出错代价大，而「看得见的才算」本身就足够快。
 *
 * 长依赖链（A2=A1+1 一路拉到第 10 万行）会把 JS 调用栈压爆。这里给递归深度设了上限：
 * 超过时抛出 Deep，由最外层的 value() 接住，先把「最深处那个格子」单独算完缓存起来，
 * 再回头重试 —— 相当于把一条长链切成若干段，每段都在栈的安全深度之内。
 *
 * 动态数组（与 Google 表格 / Excel 365 一致）：整个公式的结果是一块区域时——
 * =IMPORTRANGE(...)、=A1:C9、=TRANSPOSE(...) —— 结果从公式所在格往右下「溢出」铺开。
 * 铺开的格子本身是空的，值由锚点公式提供；要铺的位置上已有内容则锚点显示 #SPILL!。
 * 溢出索引在每次作废后、第一次对外取值时建好（只看可能产生区域的公式，A2=A1+1 这类不算）。
 */

import { parse } from './parse.js';
import { rgOf, keyOf, parseRange, tableIdFrom } from './extref.js';
import { FUNCS, LAZY } from './functions.js';
import {
  ERR, FErr, Ref, Arr, MISSING, isArr, scalar, num, str, compare, tidy, errOf, parseLiteral,
} from './values.js';

const DEPTH_LIMIT = 200;

class Deep {
  /** @param {number} r @param {number} c */
  constructor(r, c) { this.r = r; this.c = c; }
}

/** 解析失败的公式。 */
export const ERR_SYNTAX = new FErr('#ERROR!');

const DATE_FNS = new Set(['DATE', 'TODAY', 'EDATE', 'EOMONTH', 'DATEVALUE', 'WORKDAY']);

/** 一块溢出最多铺这么多格（和跨表取数的上限一致）。 */
export const MAX_SPILL_CELLS = 50000;
/** 本身就可能返回区域的函数。 */
const ARRAY_FNS = new Set(['IMPORTRANGE', 'TRANSPOSE', 'INDEX', 'XLOOKUP', 'FILTER', 'SORT', 'UNIQUE', 'SEQUENCE', 'OFFSET']);
/** 参数里有区域时结果也可能是区域的函数（IF(A1:A3>0, ...)）。 */
const PASS_FNS = new Set(['IF', 'IFERROR', 'IFNA', 'IFS', 'CHOOSE', 'SWITCH']);

/**
 * 静态判断：这个 AST 的结果**可能**是一块区域。宁多勿漏 —— 多判只是多算一个格子。
 * @param {any} n @returns {boolean}
 */
export function mayBeArray(n) {
  if (!n || typeof n !== 'object') return false;
  switch (n.type) {
    case 'range': return true;
    case 'neg': case 'pct': return mayBeArray(n.e);
    case 'bin': return mayBeArray(n.l) || mayBeArray(n.r);
    case 'fn': return ARRAY_FNS.has(n.name) || (PASS_FNS.has(n.name) && n.args.some(mayBeArray));
    default: return false;
  }
}

/**
 * @typedef {{
 *   raw:(r:number,c:number)=>string, rows:()=>number, cols:()=>number,
 *   tableId?: string,
 *   ext?: (tableId:string, range:string) => Ref | FErr,
 *   formulas?: () => Iterable<[number, number, string]>,
 * }} Host
 *   formulas 列出所有公式格（行, 列, 原文），用来建溢出索引；不给就不溢出（服务端取数就是这样）。
 *   tableId / ext 给跨表引用用：ext 按表编号和规范化的区域文本返回取回来的值（一个 Ref），
 *   还没取到返回 #LOADING（宿主负责去拉，拉到后作废缓存重算），没有权限或表不存在返回 #REF!。
 *   没有 ext 的宿主（比如单元测试里的）一律 #REF!。
 */

export class Engine {
  /** @param {Host} host */
  constructor(host) {
    this.host = host;
    /** @type {Map<number, any>} */
    this.cache = new Map();
    /** @type {Map<string, any>} 公式正文 → AST（或解析错误） */
    this.asts = new Map();
    /** @type {Set<number>} */
    this.computing = new Set();
    this.depth = 0;
    /** 结果是区域的公式格 → 那块区域 @type {Map<number, any>} */
    this.arrays = new Map();
    /** 溢出索引：被铺到的空格 → [锚点行, 锚点列, 行偏移, 列偏移]；null = 还没建 @type {Map<number, number[]> | null} */
    this.spills = null;
    /** 溢出锚点 → 实际铺开的 [行数, 列数]（被挡住的不在里面） @type {Map<number, number[]>} */
    this.anchors = new Map();
    this._building = false;
  }

  /** 数据变了：作废所有缓存的计算结果（AST 缓存保留，它只跟公式文本有关）。 */
  invalidate() { this.cache.clear(); this.arrays.clear(); this.anchors.clear(); this.spills = null; }

  /**
   * 建溢出索引：挨个算「可能产生区域」的公式，按行主序认领要铺的格子。
   * 目标格有内容、或已被前面的溢出占了 → 这个锚点 #SPILL!。
   */
  _buildSpills() {
    const list = this.host.formulas?.();
    /** @type {Map<number, number[]>} */ const idx = new Map();
    this.spills = idx;
    if (!list) return;
    /** @type {[number, number][]} */ const cands = [];
    for (const [r, c, raw] of list) {
      if (!isFormula(raw)) continue;
      const ast = this.compile(raw.slice(1));
      if (ast.type !== 'syntax' && mayBeArray(ast)) cands.push([r, c]);
    }
    if (!cands.length) return;
    cands.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    const rows = this.host.rows(), cols = this.host.cols();
    this._building = true;
    try {
      for (const [r, c] of cands) {
        this.value(r, c);
        const k = r * 16384 + c;
        const arr = this.arrays.get(k);
        if (!arr) continue;
        const [h, w] = spillSize(arr, rows - r, cols - c);
        if (h * w <= 1) { this.anchors.set(k, [h, w]); continue; }
        let blocked = false;
        for (let i = 0; i < h && !blocked; i++) {
          for (let j = 0; j < w; j++) {
            if (!i && !j) continue;
            const t = (r + i) * 16384 + (c + j);
            if (idx.has(t) || this.host.raw(r + i, c + j)) { blocked = true; break; }
          }
        }
        if (blocked) { this.cache.set(k, ERR.SPILL); continue; }
        for (let i = 0; i < h; i++) for (let j = 0; j < w; j++) if (i || j) idx.set((r + i) * 16384 + (c + j), [r, c, i, j]);
        this.anchors.set(k, [h, w]);
      }
    } finally {
      this._building = false;
    }
  }

  /**
   * (r,c) 是不是某块溢出里的格子（不含锚点本身）。返回锚点位置，不是返回 null。
   * @param {number} r @param {number} c @returns {{r:number, c:number} | null}
   */
  spillOwner(r, c) {
    if (!this.spills && !this._building) this._buildSpills();
    const s = this.spills?.get(r * 16384 + c);
    return s ? { r: s[0], c: s[1] } : null;
  }

  /** 空格子上溢出来的值；不在任何溢出里返回 undefined。 @param {number} r @param {number} c */
  _spilled(r, c) {
    const s = this.spills?.get(r * 16384 + c);
    if (!s) return undefined;
    const arr = this.arrays.get(s[0] * 16384 + s[1]);
    if (!arr) return undefined;
    // =A1:A3 写在 A2：溢出格又回头引用自己
    const k = -1 - (r * 16384 + c);
    if (this.computing.has(k)) return ERR.CIRC;
    this.computing.add(k);
    try { return spillValue(arr.get(s[2], s[3])); } finally { this.computing.delete(k); }
  }

  /** @param {string} body @returns {any} */
  compile(body) {
    let ast = this.asts.get(body);
    if (ast === undefined) {
      try { ast = parse(body); } catch (e) { ast = { type: 'syntax', msg: /** @type {Error} */ (e).message }; }
      if (this.asts.size > 50000) this.asts.clear();
      this.asts.set(body, ast);
    }
    return ast;
  }

  /**
   * 对外入口：单元格 (r,c) 的计算结果。
   * @param {number} r @param {number} c
   */
  value(r, c) {
    if (!this.spills && !this._building) this._buildSpills();
    /** @type {[number, number][]} */
    const stack = [[r, c]];
    for (let guard = 0; guard < 1e6; guard++) {
      const [rr, cc] = stack[stack.length - 1];
      try {
        const v = this.cell(rr, cc);
        stack.pop();
        if (!stack.length) return v;
      } catch (e) {
        this.depth = 0;
        this.computing.clear();
        if (e instanceof Deep) { stack.push([e.r, e.c]); continue; }
        if (e instanceof RangeError) return ERR.VALUE;          // 公式本身嵌套得离谱
        throw e;
      }
    }
    return ERR.VALUE;
  }

  /** 公式解析失败时的提示文字；不是公式或解析成功返回 ''。 @param {string} raw */
  syntaxError(raw) {
    if (!isFormula(raw)) return '';
    const ast = this.compile(raw.slice(1));
    return ast.type === 'syntax' ? ast.msg : '';
  }

  /**
   * 引擎内部与 Ref 取值用：可能抛 Deep。
   * @param {number} r @param {number} c
   */
  cell(r, c) {
    if (r < 0 || c < 0) return ERR.REF;
    const raw = this.host.raw(r, c);
    if (!raw) { const s = this.spills && this._spilled(r, c); return s === undefined ? null : s; }
    if (raw.charCodeAt(0) === 39 /* ' */) return raw.slice(1);
    if (!isFormula(raw)) return parseLiteral(raw);

    const k = r * 16384 + c;
    const hit = this.cache.get(k);
    if (hit !== undefined) return hit;
    if (this.computing.has(k)) return ERR.CIRC;
    if (this.depth >= DEPTH_LIMIT) throw new Deep(r, c);

    this.computing.add(k);
    this.depth++;
    let v;
    try {
      v = this._top(this.compile(raw.slice(1)), r, c);
    } finally {
      this.depth--;
      this.computing.delete(k);
    }
    this.cache.set(k, v);
    return v;
  }

  /** @param {any} ast @param {number} r @param {number} c */
  _top(ast, r, c) {
    if (ast.type === 'syntax') return ERR_SYNTAX;
    let v;
    try { v = this.eval(ast, { r, c, eng: this }); }
    catch (e) { if (e instanceof FErr) return e; throw e; }
    if (isArr(v)) {
      if (!v.h || !v.w) return ERR.VALUE;
      // 整块结果留着给溢出用；锚点自己显示左上角那一格（空就是空，不是 0）
      if (v.h * v.w > 1 && this.host.formulas) { this.arrays.set(r * 16384 + c, v); return spillValue(v.get(0, 0)); }
      v = v.get(0, 0);
    }
    if (v == null || v === MISSING) return 0;               // =A1 引用空格子显示 0，与 Excel 一致
    if (typeof v === 'number') return Number.isFinite(v) ? tidy(v) : ERR.NUM;
    return v;
  }

  /**
   * @param {any} n AST 节点
   * @param {{r:number, c:number, eng:Engine}} ctx
   * @returns {any}
   */
  eval(n, ctx) {
    switch (n.type) {
      case 'num': case 'str': case 'bool': return n.v;
      case 'err': return errOf(n.v);
      case 'missing': return MISSING;
      case 'name': return ERR.NAME;
      case 'ref': return n.table ? this._ext(n.table, n.a, n.a) : new Ref(this, n.a.r, n.a.c, n.a.r, n.a.c);
      case 'range': return n.table ? this._ext(n.table, n.a, n.b) : this._range(n.a, n.b);
      case 'neg': return unary(this.eval(n.e, ctx), (x) => -x);
      case 'pct': return unary(this.eval(n.e, ctx), (x) => x / 100);
      case 'bin': return binary(n.op, this.eval(n.l, ctx), this.eval(n.r, ctx));
      case 'fn': return this._call(n, ctx);
      default: return ERR.VALUE;
    }
  }

  /** @param {any} a @param {any} b */
  _range(a, b) {
    const rows = this.host.rows(), cols = this.host.cols();
    let r0, r1, c0, c1;
    if (a.r == null) { r0 = 0; r1 = Math.max(0, rows - 1); } else { r0 = Math.min(a.r, b.r); r1 = Math.max(a.r, b.r); }
    if (a.c == null) { c0 = 0; c1 = Math.max(0, cols - 1); } else { c0 = Math.min(a.c, b.c); c1 = Math.max(a.c, b.c); }
    // 超出表格实际大小的部分都是空：裁掉，SUM(A1:A1048576) 不必真的走一百万格
    if (r1 >= rows) r1 = Math.max(r0, rows - 1);
    if (c1 >= cols) c1 = Math.max(c0, cols - 1);
    return new Ref(this, r0, c0, r1, c1);
  }

  /**
   * 跨表引用。写的是本表自己的编号就按本表算。
   * @param {string} table @param {any} a @param {any} b
   */
  _ext(table, a, b) {
    if (table === this.host.tableId) return a === b && a.r != null && a.c != null ? new Ref(this, a.r, a.c, a.r, a.c) : this._range(a, b);
    return this._extKey(table, keyOf(rgOf(a, b)));
  }

  /** @param {string} table @param {string} key 规范化的区域文本 */
  _extKey(table, key) {
    if (!this.host.ext) return ERR.REF;
    return this.host.ext(table, key);
  }

  /** IMPORTRANGE("tbl_xxx" 或链接, "A1:C10")：地址可以是算出来的。 @param {any} n @param {any} ctx */
  _importRange(n, ctx) {
    if (n.args.length !== 2) return ERR.VALUE;
    const t = scalar(this.eval(n.args[0], ctx));
    if (t instanceof FErr) return t;
    const r = scalar(this.eval(n.args[1], ctx));
    if (r instanceof FErr) return r;
    const table = tableIdFrom(String(t ?? ''));
    const g = parseRange(String(r ?? ''));
    if (!table || !g) return ERR.REF;
    if (table === this.host.tableId) {
      return this._range({ r: g.r0, c: g.c0 }, { r: g.r1, c: g.c1 });
    }
    return this._extKey(table, keyOf(g));
  }

  /** @param {any} n @param {{r:number, c:number, eng:Engine}} ctx */
  _call(n, ctx) {
    if (n.name === 'IMPORTRANGE') return this._importRange(n, ctx);
    const lazy = LAZY[n.name];
    if (lazy) {
      const thunks = n.args.map((/** @type {any} */ a) => () => {
        const v = this.eval(a, ctx);
        return v === MISSING ? 0 : v;
      });
      try { return lazy(thunks, ctx); } catch (e) { if (e instanceof FErr) return e; throw e; }
    }
    const fn = FUNCS[n.name];
    if (!fn) return ERR.NAME;
    const args = n.args.map((/** @type {any} */ a) => this.eval(a, ctx));
    try {
      const v = fn(args, ctx);
      return typeof v === 'number' && !Number.isFinite(v) ? ERR.NUM : v;
    } catch (e) {
      if (e instanceof FErr) return e;
      throw e;
    }
  }

  /**
   * 公式结果的「建议格式」：=TODAY() 该显示成日期而不是 45306。
   * @param {string} raw @returns {string}
   */
  formatHint(raw) {
    if (!isFormula(raw)) return '';
    const ast = this.compile(raw.slice(1));
    const root = ast.type === 'bin' && (ast.op === '+' || ast.op === '-') ? ast.l : ast;
    if (root.type !== 'fn') return '';
    if (root.name === 'NOW') return 'yyyy-mm-dd hh:mm';
    if (root.name === 'TIME' || root.name === 'TIMEVALUE') return 'hh:mm:ss';
    if (DATE_FNS.has(root.name)) return 'yyyy-mm-dd';
    return '';
  }
}

/**
 * 溢出实际铺开的大小：不超出表格，末尾整行空白的裁掉（IMPORTRANGE("…","A:D") 取的是整列），
 * 总格数不超过 MAX_SPILL_CELLS。
 * @param {any} arr @param {number} maxH @param {number} maxW @returns {[number, number]}
 */
function spillSize(arr, maxH, maxW) {
  const w = Math.max(0, Math.min(arr.w, maxW));
  let h = Math.max(0, Math.min(arr.h, maxH));
  if (!w || !h) return [0, 0];
  if (h * w > MAX_SPILL_CELLS) h = Math.max(1, Math.floor(MAX_SPILL_CELLS / w));
  const blank = (x) => x == null || x === '' || x === MISSING;
  while (h > 1) {
    let empty = true;
    for (let j = 0; j < w && empty; j++) if (!blank(safeGet(arr, h - 1, j))) empty = false;
    if (!empty) break;
    h--;
  }
  return [h, w];
}

/** 取区域里的一格；本表的格子走 value()，长依赖链不会压爆栈。 @param {any} arr @param {number} i @param {number} j */
function safeGet(arr, i, j) {
  if (arr instanceof Ref && arr.eng instanceof Engine) return arr.eng.value(arr.r0 + i, arr.c0 + j);
  return arr.get(i, j);
}

/** 溢出格里的值：空还是空（不像 =A1 那样显示 0）。 @param {any} v */
function spillValue(v) {
  if (v == null || v === MISSING) return null;
  if (typeof v === 'number') return Number.isFinite(v) ? tidy(v) : ERR.NUM;
  return v;
}

/** @param {string} raw */
export function isFormula(raw) {
  return typeof raw === 'string' && raw.length > 1 && raw.charCodeAt(0) === 61 /* = */;
}

// ── 运算符 ─────────────────────────────────────────────────────────────────

/** 1×1 的 Ref 当标量。 @param {any} v */
const deref = (v) => (v instanceof Ref && v.h === 1 && v.w === 1 ? v.get(0, 0) : v);

/** @param {any} v @param {(x:number)=>number} f */
function unary(v, f) {
  v = deref(v);
  if (isArr(v)) return mapArr(v, (x) => unary(x, f));
  if (v instanceof FErr) return v;
  try { return f(num(v)); } catch (e) { if (e instanceof FErr) return e; throw e; }
}

/** @param {Ref|Arr} m @param {(x:any)=>any} f */
function mapArr(m, f) {
  const rows = [];
  for (let i = 0; i < m.h; i++) { const row = []; for (let j = 0; j < m.w; j++) row.push(f(m.get(i, j))); rows.push(row); }
  return new Arr(rows);
}

/** @param {string} op @param {any} a @param {any} b @returns {any} */
function binary(op, a, b) {
  a = deref(a);
  b = deref(b);
  if (isArr(a) || isArr(b)) {
    // 数组运算：按元素广播（1 行 / 1 列的一边沿另一边展开）
    const A = isArr(a) ? a : null, B = isArr(b) ? b : null;
    const h = Math.max(A ? A.h : 1, B ? B.h : 1);
    const w = Math.max(A ? A.w : 1, B ? B.w : 1);
    const pick = (/** @type {any} */ m, /** @type {any} */ v, /** @type {number} */ i, /** @type {number} */ j) => {
      if (!m) return v;
      const ii = m.h === 1 ? 0 : i, jj = m.w === 1 ? 0 : j;
      return ii < m.h && jj < m.w ? m.get(ii, jj) : ERR.NA;
    };
    const rows = [];
    for (let i = 0; i < h; i++) {
      const row = [];
      for (let j = 0; j < w; j++) row.push(binary(op, pick(A, a, i, j), pick(B, b, i, j)));
      rows.push(row);
    }
    return new Arr(rows);
  }
  if (a instanceof FErr) return a;
  if (b instanceof FErr) return b;
  if (a === MISSING) a = null;
  if (b === MISSING) b = null;
  try {
    switch (op) {
      case '&': return str(a) + str(b);
      case '=': return compare(a, b) === 0;
      case '<>': return compare(a, b) !== 0;
      case '<': return compare(a, b) < 0;
      case '>': return compare(a, b) > 0;
      case '<=': return compare(a, b) <= 0;
      case '>=': return compare(a, b) >= 0;
      case '+': return num(a) + num(b);
      case '-': return num(a) - num(b);
      case '*': return num(a) * num(b);
      case '/': { const d = num(b); const x = num(a); if (d === 0) return ERR.DIV0; return x / d; }
      case '^': {
        const x = num(a), y = num(b);
        if (x === 0 && y === 0) return ERR.NUM;
        const v = x ** y;
        return Number.isFinite(v) ? v : ERR.NUM;
      }
      default: return ERR.VALUE;
    }
  } catch (e) {
    if (e instanceof FErr) return e;
    throw e;
  }
}

export { scalar };
