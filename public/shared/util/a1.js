/**
 * A1 表示法：列序号 ↔ 列名、单元格引用解析。
 *
 * 浏览器与 Worker 共用。公式引擎（P4）会直接复用这里的解析结果，
 * 所以返回的是结构化对象而不是字符串切片。
 *
 * 列名是 26 进制但没有 0：A..Z, AA..AZ, BA.. —— 常被写错，这里单独测过。
 */

const A = 65;

/** 列序号（0 起）→ 列名。0 → 'A'，25 → 'Z'，26 → 'AA'。 @param {number} index */
export function colName(index) {
  if (!Number.isInteger(index) || index < 0) return '';
  let n = index;
  let out = '';
  for (;;) {
    out = String.fromCharCode(A + (n % 26)) + out;
    n = Math.floor(n / 26) - 1;
    if (n < 0) return out;
  }
}

/** 列名 → 列序号（0 起）。非法返回 -1。 @param {string} name */
export function colIndex(name) {
  if (typeof name !== 'string' || name.length === 0 || name.length > 7) return -1;
  let n = 0;
  for (let i = 0; i < name.length; i++) {
    const c = name.charCodeAt(i) & ~32;          // 大小写归一
    if (c < A || c > A + 25) return -1;
    n = n * 26 + (c - A + 1);
  }
  return n - 1;
}

/** (行, 列) → 'B3'。行列均 0 起。 @param {number} row @param {number} col */
export function cellRef(row, col) {
  return colName(col) + (row + 1);
}

const REF_RE = /^(\$?)([A-Za-z]{1,7})(\$?)([0-9]{1,7})$/;

/**
 * 解析单个引用，支持 `$` 绝对锚点。
 * @param {string} ref
 * @returns {{row:number, col:number, absRow:boolean, absCol:boolean} | null}
 */
export function parseRef(ref) {
  const m = REF_RE.exec(typeof ref === 'string' ? ref.trim() : '');
  if (!m) return null;
  const col = colIndex(m[2]);
  const row = Number(m[4]) - 1;
  if (col < 0 || row < 0) return null;
  return { row, col, absRow: m[3] === '$', absCol: m[1] === '$' };
}

/**
 * 解析区域 `A1:C9`（单个引用也接受，退化为 1×1）。始终返回左上-右下规范化后的矩形。
 * @param {string} ref
 * @returns {{r0:number, c0:number, r1:number, c1:number} | null}
 */
export function parseRange(ref) {
  const parts = typeof ref === 'string' ? ref.split(':') : [];
  if (parts.length === 1) {
    const a = parseRef(parts[0]);
    return a ? { r0: a.row, c0: a.col, r1: a.row, c1: a.col } : null;
  }
  if (parts.length !== 2) return null;
  const a = parseRef(parts[0]);
  const b = parseRef(parts[1]);
  if (!a || !b) return null;
  return {
    r0: Math.min(a.row, b.row), c0: Math.min(a.col, b.col),
    r1: Math.max(a.row, b.row), c1: Math.max(a.col, b.col),
  };
}

/** 矩形 → 'A1:C9'（1×1 时只给单个引用，与用户书写习惯一致）。 */
export function rangeName(r0, c0, r1, c1) {
  return r0 === r1 && c0 === c1 ? cellRef(r0, c0) : cellRef(r0, c0) + ':' + cellRef(r1, c1);
}
