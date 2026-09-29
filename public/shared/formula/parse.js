/**
 * 公式的词法 / 语法分析，以及两种「改写公式文本」的操作：
 *
 *   shiftFormula   —— 复制粘贴、填充柄：相对引用跟着位移，$ 锚定的不动（与 Excel 一致）
 *   adjustFormula  —— 插入 / 删除行列：所有引用（含 $）跟着结构变化走，被删掉的变 #REF!
 *
 * 浏览器与 Durable Object 共用这一份：插入行列时 DO 要把库里每个公式都改写一遍，
 * 客户端也要对本地模型做同样的事 —— 两边必须逐字节一致，所以只能有一份实现。
 *
 * 跨表引用写成 tbl_xxx!A1 / tbl_xxx!A:C（表编号就是地址栏 /t/ 后面那段），引用 token 带上
 * table 字段。它指向别的表，所以插入 / 删除本表的行列时不动它；复制粘贴时照常位移。
 *
 * 改写基于 token 的源码位置做局部替换，而不是「解析成 AST 再打印回去」：
 * 用户写的空格、大小写、多余括号都原样保留，只动引用本身。
 */

import { t as tt } from '../i18n/i18n.js';
import { colName, colIndex } from '../util/a1.js';

export const MAX_ROW = 1048576;
export const MAX_COL = 16384;

/**
 * @typedef {{r:number|null, c:number|null, ar:boolean, ac:boolean}} RefPart
 *   r 为 null 表示整列（A:A），c 为 null 表示整行（1:1）
 * @typedef {{t:string, v:any, s:number, e:number}} Token
 * @typedef {{a:RefPart, b:RefPart|null, table?:string}} RefTok
 */

const CELL = String.raw`(\$?)([A-Za-z]{1,3})(\$?)([0-9]{1,7})`;
const RE_RANGE = new RegExp('^' + CELL + ':' + CELL, 'y');
const RE_CELL = new RegExp('^' + CELL, 'y');
const RE_COLS = /^(\$?)([A-Za-z]{1,3}):(\$?)([A-Za-z]{1,3})(?![A-Za-z0-9_(])/y;
const RE_ROWS = /^(\$?)([0-9]{1,7}):(\$?)([0-9]{1,7})(?![0-9.])/y;
const RE_NUM = /^(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?/y;
const RE_NAME = /^[A-Za-z_一-龥][A-Za-z0-9_.一-龥]*/y;
const RE_TBL = /^[tT][bB][lL]_([A-Za-z0-9]{4,40})!/y;
const RE_ERR = /^#(NULL!|DIV\/0!|VALUE!|REF!|NAME\?|NUM!|N\/A|CIRC!|SPILL!)/y;

/** 在 src 的 i 处尝试匹配粘性正则。 @param {RegExp} re @param {string} src @param {number} i */
function at(re, src, i) {
  let r = STICKY.get(re);
  if (!r) STICKY.set(re, (r = new RegExp(re.source.slice(1), 'y')));
  r.lastIndex = i;
  return r.exec(src);
}
/** @type {Map<RegExp, RegExp>} 去掉 ^ 的粘性版本，按需生成一次 */
const STICKY = new Map();

/** @param {string} dollarC @param {string} col @param {string} dollarR @param {string} row @returns {RefPart|null} */
function cellPart(dollarC, col, dollarR, row) {
  const c = colIndex(col);
  const r = Number(row) - 1;
  if (c < 0 || c >= MAX_COL || r < 0 || r >= MAX_ROW) return null;
  return { r, c, ar: dollarR === '$', ac: dollarC === '$' };
}

/**
 * 词法分析。src 不含开头的 '='。
 * @param {string} src
 * @returns {Token[]}
 */
export function tokenize(src) {
  /** @type {Token[]} */ const out = [];
  let i = 0;
  const n = src.length;
  const prevIsOperand = () => {
    for (let k = out.length - 1; k >= 0; k--) {
      const t = out[k].t;
      if (t === 'ws') continue;
      return t === 'num' || t === 'str' || t === 'ref' || t === 'bool' || t === 'err' || t === ')';
    }
    return false;
  };

  while (i < n) {
    const ch = src[i];
    const s = i;

    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') {
      while (i < n && /\s/.test(src[i])) i++;
      out.push({ t: 'ws', v: src.slice(s, i), s, e: i });
      continue;
    }
    if (ch === '"') {
      let v = '';
      i++;
      for (;;) {
        if (i >= n) throw new SyntaxError(tt('字符串缺少结束引号'));
        if (src[i] === '"') {
          if (src[i + 1] === '"') { v += '"'; i += 2; continue; }
          i++;
          break;
        }
        v += src[i++];
      }
      out.push({ t: 'str', v, s, e: i });
      continue;
    }
    if (ch === '#') {
      const m = at(RE_ERR, src, i);
      if (!m) throw new SyntaxError(tt('无法识别的错误值'));
      i += m[0].length;
      out.push({ t: 'err', v: m[0].toUpperCase(), s, e: i });
      continue;
    }
    if (ch === '\'') throw new SyntaxError(tt('暂不支持跨工作表引用，跨表请写 tbl_表编号!A1'));

    // 跨表引用：tbl_xxx! 后面必须紧跟一个引用
    let m = at(RE_TBL, src, i);
    if (m) {
      const ref = readRef(src, i + m[0].length, true);
      if (!ref) throw new SyntaxError(tt('表编号后面应该是单元格或区域，如 {ref}', { ref: m[0] + 'A1' }));
      i = ref.e;
      out.push({ t: 'ref', v: { ...ref.v, table: 'tbl_' + m[1].toLowerCase() }, s, e: i });
      continue;
    }

    // 引用优先于数字与名字：A1:B2、A:A、1:1
    const ref = readRef(src, i, !prevIsOperand());
    if (ref) {
      i = ref.e;
      out.push({ t: 'ref', v: ref.v, s, e: i });
      continue;
    }


    if ((ch >= '0' && ch <= '9') || (ch === '.' && /[0-9]/.test(src[i + 1] ?? ''))) {
      m = at(RE_NUM, src, i);
      if (m) {
        i += m[0].length;
        out.push({ t: 'num', v: Number(m[0]), s, e: i });
        continue;
      }
    }
    m = at(RE_NAME, src, i);
    if (m) {
      i += m[0].length;
      const up = m[0].toUpperCase();
      if ((up === 'TRUE' || up === 'FALSE') && src[i] !== '(') out.push({ t: 'bool', v: up === 'TRUE', s, e: i });
      else out.push({ t: 'name', v: up, s, e: i });
      continue;
    }

    const two = src.slice(i, i + 2);
    if (two === '<>' || two === '<=' || two === '>=') {
      i += 2;
      out.push({ t: 'op', v: two, s, e: i });
      continue;
    }
    if ('+-*/^&=<>%'.includes(ch)) { i++; out.push({ t: 'op', v: ch, s, e: i }); continue; }
    if (ch === '(' || ch === ')') { i++; out.push({ t: ch, v: ch, s, e: i }); continue; }
    if (ch === ',' || ch === ';') { i++; out.push({ t: ',', v: ',', s, e: i }); continue; }
    if (ch === ':') { i++; out.push({ t: ':', v: ':', s, e: i }); continue; }
    if (ch === '{' || ch === '}') throw new SyntaxError(tt('暂不支持数组常量'));
    throw new SyntaxError(tt('无法识别的字符 “{ch}”', { ch }));
  }
  return mergeSpacedRanges(out);
}

/**
 * 在 i 处读一个引用：A1:B2、A:A、1:1、A1。
 * spans = false 时不认整列 / 整行（前面是操作数时，「1:2」更可能是别的意思）。
 * @param {string} src @param {number} i @param {boolean} spans
 * @returns {{ v: RefTok, e: number } | null}
 */
function readRef(src, i, spans) {
  let m = at(RE_RANGE, src, i);
  if (m && !/[A-Za-z0-9_(]/.test(src[i + m[0].length] ?? '')) {
    const a = cellPart(m[1], m[2], m[3], m[4]);
    const b = cellPart(m[5], m[6], m[7], m[8]);
    if (a && b) return { v: { a, b }, e: i + m[0].length };
  }
  if (spans) {
    m = at(RE_COLS, src, i);
    if (m) {
      const c0 = colIndex(m[2]), c1 = colIndex(m[4]);
      if (c0 >= 0 && c1 >= 0 && c0 < MAX_COL && c1 < MAX_COL) {
        return { v: { a: { r: null, c: c0, ar: false, ac: m[1] === '$' }, b: { r: null, c: c1, ar: false, ac: m[3] === '$' } }, e: i + m[0].length };
      }
    }
    m = at(RE_ROWS, src, i);
    if (m) {
      const r0 = Number(m[2]) - 1, r1 = Number(m[4]) - 1;
      if (r0 >= 0 && r1 >= 0 && r0 < MAX_ROW && r1 < MAX_ROW) {
        return { v: { a: { r: r0, c: null, ar: m[1] === '$', ac: false }, b: { r: r1, c: null, ar: m[3] === '$', ac: false } }, e: i + m[0].length };
      }
    }
  }
  m = at(RE_CELL, src, i);
  if (m && !/[A-Za-z0-9_(.]/.test(src[i + m[0].length] ?? '')) {
    const a = cellPart(m[1], m[2], m[3], m[4]);
    if (a) return { v: { a, b: null }, e: i + m[0].length };
  }
  return null;
}

/**
 * 「A1 : B2」（冒号两边有空格）合并成一个区域 token。
 * @param {Token[]} toks
 */
function mergeSpacedRanges(toks) {
  if (!toks.some((t) => t.t === ':')) return toks;
  const sig = toks.filter((t) => t.t !== 'ws');
  /** @type {Token[]} */ const out = [];
  for (let k = 0; k < sig.length; k++) {
    const t = sig[k];
    if (t.t !== ':') { out.push(t); continue; }
    const prev = out[out.length - 1];
    const nxt = sig[k + 1];
    if (prev?.t !== 'ref' || prev.v.b || nxt?.t !== 'ref' || nxt.v.b
      || prev.v.a.r == null || prev.v.a.c == null || nxt.v.a.r == null || nxt.v.a.c == null
      || (nxt.v.table && nxt.v.table !== prev.v.table)) {
      throw new SyntaxError(tt('无法识别的字符 “{ch}”', { ch: ':' }));
    }
    const v = prev.v.table ? { a: prev.v.a, b: nxt.v.a, table: prev.v.table } : { a: prev.v.a, b: nxt.v.a };
    out[out.length - 1] = { t: 'ref', v, s: prev.s, e: nxt.e };
    k++;
  }
  return out;
}

// ── 语法分析 ──────────────────────────────────────────────────────────────

/*
 * 优先级（低 → 高），与 Excel 一致：
 *   比较 = <> < > <= >=
 *   连接 &
 *   加减 + -
 *   乘除 * /
 *   乘方 ^
 *   一元 + -   （注意 Excel 里 -2^2 = 4：一元负号比乘方绑得更紧）
 *   百分号 %
 */

/**
 * @param {string} src 不含开头 '=' 的公式正文
 * @returns {any} AST
 */
export function parse(src) {
  const toks = tokenize(src).filter((t) => t.t !== 'ws');
  let p = 0;
  const peek = () => toks[p];
  const next = () => toks[p++];
  const isOp = (/** @type {string[]} */ ...ops) => peek()?.t === 'op' && ops.includes(peek().v);

  function expr() { return compare(); }

  function compare() {
    let l = concat();
    while (isOp('=', '<>', '<', '>', '<=', '>=')) {
      const op = next().v;
      l = { type: 'bin', op, l, r: concat() };
    }
    return l;
  }
  function concat() {
    let l = additive();
    while (isOp('&')) { next(); l = { type: 'bin', op: '&', l, r: additive() }; }
    return l;
  }
  function additive() {
    let l = mult();
    while (isOp('+', '-')) { const op = next().v; l = { type: 'bin', op, l, r: mult() }; }
    return l;
  }
  function mult() {
    let l = power();
    while (isOp('*', '/')) { const op = next().v; l = { type: 'bin', op, l, r: power() }; }
    return l;
  }
  function power() {
    let l = unary();
    while (isOp('^')) { next(); l = { type: 'bin', op: '^', l, r: unary() }; }
    return l;
  }
  function unary() {
    if (isOp('-', '+')) {
      const op = next().v;
      const e = unary();
      return op === '-' ? { type: 'neg', e } : e;
    }
    return percent();
  }
  function percent() {
    let e = primary();
    while (isOp('%')) { next(); e = { type: 'pct', e }; }
    return e;
  }
  function primary() {
    const t = next();
    if (!t) throw new SyntaxError(tt('公式不完整'));
    switch (t.t) {
      case 'num': return { type: 'num', v: t.v };
      case 'str': return { type: 'str', v: t.v };
      case 'bool': return { type: 'bool', v: t.v };
      case 'err': return { type: 'err', v: t.v };
      case 'ref': {
        const n = t.v.b ? { type: 'range', a: t.v.a, b: t.v.b } : { type: 'ref', a: t.v.a };
        return t.v.table ? { ...n, table: t.v.table } : n;
      }
      case '(': {
        const e = expr();
        if (next()?.t !== ')') throw new SyntaxError(tt('缺少右括号'));
        return e;
      }
      case 'name': {
        if (peek()?.t !== '(') return { type: 'name', v: t.v };
        next();
        /** @type {any[]} */ const args = [];
        if (peek()?.t === ')') { next(); return { type: 'fn', name: t.v, args }; }
        for (;;) {
          // 允许空参数：IF(A1,,1)
          if (peek()?.t === ',' || peek()?.t === ')') args.push({ type: 'missing' });
          else args.push(expr());
          const sep = next();
          if (!sep) throw new SyntaxError(tt('缺少右括号'));
          if (sep.t === ')') break;
          if (sep.t !== ',') throw new SyntaxError(tt('参数之间应以逗号分隔'));
        }
        return { type: 'fn', name: t.v, args };
      }
      default:
        throw new SyntaxError(tt('意外的 “{tok}”', { tok: t.v }));
    }
  }

  const ast = expr();
  if (p < toks.length) throw new SyntaxError(tt('意外的 “{tok}”', { tok: toks[p].v }));
  return ast;
}

// ── 引用改写 ──────────────────────────────────────────────────────────────

/** @param {RefPart} p */
function fmtPart(p) {
  let s = '';
  if (p.c != null) s += (p.ac ? '$' : '') + colName(p.c);
  if (p.r != null) s += (p.ar ? '$' : '') + (p.r + 1);
  return s;
}

/** 引用 token → 文本（跨表的带上 tbl_xxx! 前缀）。 @param {RefTok} v */
export function fmtRef(v) {
  const body = v.b ? fmtPart(v.a) + ':' + fmtPart(v.b) : fmtPart(v.a);
  return v.table ? v.table + '!' + body : body;
}

/**
 * 逐个引用 token 做替换，其余字符原样拷贝。
 * @param {string} formula 以 '=' 开头的完整公式
 * @param {(v:RefTok) => string | null} fn 返回新文本；null 表示不改
 */
function rewrite(formula, fn) {
  if (typeof formula !== 'string' || formula[0] !== '=') return formula;
  const body = formula.slice(1);
  let toks;
  try { toks = tokenize(body); } catch { return formula; }   // 本来就是坏公式：原样保留
  let out = '';
  let last = 0;
  let changed = false;
  for (const t of toks) {
    if (t.t !== 'ref') continue;
    const rep = fn(t.v);
    if (rep == null) continue;
    out += body.slice(last, t.s) + rep;
    last = t.e;
    changed = true;
  }
  return changed ? '=' + out + body.slice(last) : formula;
}

/**
 * 复制 / 填充时的相对位移。
 * @param {string} formula @param {number} dr @param {number} dc
 */
export function shiftFormula(formula, dr, dc) {
  if (!dr && !dc) return formula;
  return rewrite(formula, (v) => {
    const mv = (/** @type {RefPart} */ p) => ({
      r: p.r == null || p.ar ? p.r : p.r + dr,
      c: p.c == null || p.ac ? p.c : p.c + dc,
      ar: p.ar, ac: p.ac,
    });
    const a = mv(v.a);
    const b = v.b ? mv(v.b) : null;
    const bad = (/** @type {RefPart} */ p) => (p.r != null && (p.r < 0 || p.r >= MAX_ROW)) || (p.c != null && (p.c < 0 || p.c >= MAX_COL));
    if (bad(a) || (b && bad(b))) return '#REF!';
    return fmtRef({ a, b, table: v.table });
  });
}

/**
 * 插入 / 删除行列之后改写引用。
 * n > 0：在 at 处插入 n 行（列）；n < 0：删除 [at, at-n) 这 |n| 行（列）。
 * 结构变化不看 $ —— 在 Excel 里 $A$5 在第 3 行上方插一行之后同样会变成 $A$6。
 * @param {string} formula @param {'row'|'col'} axis @param {number} at @param {number} n
 */
export function adjustFormula(formula, axis, at, n) {
  if (!n) return formula;
  const key = axis === 'row' ? 'r' : 'c';
  const del = n < 0 ? -n : 0;

  /** 单个索引；返回 null 表示落在被删区间内。 @param {number} i */
  const move = (i) => {
    if (i < at) return i;
    if (n > 0) return i + n;
    if (i < at + del) return null;
    return i - del;
  };

  return rewrite(formula, (v) => {
    if (v.table) return null;                         // 别的表的引用：本表的结构变化与它无关
    const a = { ...v.a };
    const b = v.b ? { ...v.b } : null;
    if (a[key] == null) return null;                 // 整列引用遇到行变化：不受影响

    if (!b) {
      const m = move(/** @type {number} */ (a[key]));
      if (m == null) return '#REF!';
      if (m === a[key]) return null;
      a[key] = m;
      return fmtRef({ a, b: null });
    }

    let lo = /** @type {number} */ (a[key]);
    let hi = /** @type {number} */ (b[key]);
    const flip = lo > hi;
    if (flip) [lo, hi] = [hi, lo];
    let nlo, nhi;
    if (n > 0) { nlo = move(lo); nhi = move(hi); }
    else {
      // 区间被删掉一部分：收缩；整段被删：#REF!
      nlo = lo < at ? lo : lo < at + del ? at : lo - del;
      nhi = hi < at ? hi : hi < at + del ? at - 1 : hi - del;
      if (nhi < nlo) return '#REF!';
    }
    if (nlo === lo && nhi === hi) return null;
    if (flip) { a[key] = nhi; b[key] = nlo; } else { a[key] = nlo; b[key] = nhi; }
    return fmtRef({ a, b });
  });
}

/**
 * 公式里出现的所有引用（给编辑器上色、给「追踪引用」用）。跨表引用的 v.table 有值。
 * @param {string} body 不含 '='
 * @returns {{s:number, e:number, v:RefTok}[]}
 */
export function refsIn(body) {
  try { return tokenize(body).filter((t) => t.t === 'ref'); } catch { return []; }
}
