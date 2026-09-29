/**
 * 字符串分数索引（fractional indexing）。
 *
 * 用途：行与列的排序。拖动一行时只给它算一个「介于前后邻居之间」的新 key，
 * 写一行即可，不必像整数 ordinal 那样重排整张表并广播一大串 op。
 * Kanban 的卡片拖拽是高频操作，这一点尤其重要。
 *
 * 相比浮点 ordinal：浮点在同一对邻居间反复插入约 50 次后精度耗尽、两个 key 相等；
 * 字符串 key 只会变长，永不相撞。
 *
 * ── key 的结构 ──────────────────────────────────────────────────────────────
 * key = 整数部分 + 小数部分，按普通字典序比较即为正确顺序。
 *
 * 整数部分的首字符既是符号也是长度标记：
 *   'a'..'z' → 正数，后跟 1..26 位数字（'a0' 是最小的正整数 key）
 *   'A'..'Z' → 负数，后跟 26..1 位数字
 *
 * 整数部分是关键：没有它，"在末尾追加" 只能靠小数位不断逼近上界，
 * key 长度随行数线性增长（实测追加 500 行 → 100 字符）。有了整数部分，
 * 追加只是整数 +1，500 行后 key 仍然只有 2~3 字符。
 *
 * 算法取自业界通行的 fractional-indexing 方案。
 */

const D = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
const ZERO = D[0];         // '0'
const LAST = D[D.length - 1]; // 'z'
/** 负数区的下界，不可再往前插 */
const SMALLEST = 'A' + ZERO.repeat(26);

/** 由首字符推出整数部分的总长度。@param {string} head @returns {number} */
function integerLength(head) {
  if (head >= 'a' && head <= 'z') return head.charCodeAt(0) - 97 + 2;
  if (head >= 'A' && head <= 'Z') return 90 - head.charCodeAt(0) + 2;
  throw new RangeError(`fracindex: 非法首字符 ${JSON.stringify(head)}`);
}

/** @param {string} key @returns {string} */
function integerPart(key) {
  const len = integerLength(key[0]);
  if (len > key.length) throw new RangeError(`fracindex: key 残缺 ${JSON.stringify(key)}`);
  return key.slice(0, len);
}

/** @param {string} key */
function validate(key) {
  if (key === SMALLEST) throw new RangeError('fracindex: 已到下界');
  const int = integerPart(key);
  if (int.length !== integerLength(int[0])) throw new RangeError(`fracindex: 整数部分非法 ${key}`);
  // 小数部分不允许以 '0' 结尾，否则同一个位置会有多种写法，破坏唯一性
  const frac = key.slice(int.length);
  if (frac.endsWith(ZERO)) throw new RangeError(`fracindex: 小数部分不得以 0 结尾 ${key}`);
}

/** 整数部分 +1。溢出到上界时返回 null。@param {string} x @returns {string | null} */
function incrementInteger(x) {
  const head = x[0];
  const digs = x.slice(1).split('');
  let carry = true;
  for (let i = digs.length - 1; carry && i >= 0; i--) {
    const d = D.indexOf(digs[i]) + 1;
    if (d === D.length) digs[i] = ZERO;
    else { digs[i] = D[d]; carry = false; }
  }
  if (!carry) return head + digs.join('');
  // 进位溢出：整数部分需要换一个更长（或跨越正负）的量级
  if (head === 'Z') return 'a' + ZERO;
  if (head === 'z') return null;
  const h = String.fromCharCode(head.charCodeAt(0) + 1);
  if (h > 'a') digs.push(ZERO); else digs.pop();
  return h + digs.join('');
}

/** 整数部分 -1。溢出到下界时返回 null。@param {string} x @returns {string | null} */
function decrementInteger(x) {
  const head = x[0];
  const digs = x.slice(1).split('');
  let borrow = true;
  for (let i = digs.length - 1; borrow && i >= 0; i--) {
    const d = D.indexOf(digs[i]) - 1;
    if (d === -1) digs[i] = LAST;
    else { digs[i] = D[d]; borrow = false; }
  }
  if (!borrow) return head + digs.join('');
  if (head === 'a') return 'Z' + LAST;
  if (head === 'A') return null;
  const h = String.fromCharCode(head.charCodeAt(0) - 1);
  if (h < 'Z') digs.push(LAST); else digs.pop();
  return h + digs.join('');
}

/**
 * 求小数部分 a 与 b 之间的中点。a < b；b 为 null 表示上界。
 * 结果保证不以 '0' 结尾。
 * @param {string} a @param {string | null} b @returns {string}
 */
function midpoint(a, b) {
  if (b !== null && a >= b) {
    throw new RangeError(`fracindex: 顺序错误 ${JSON.stringify(a)} >= ${JSON.stringify(b)}`);
  }
  // 剥掉公共前缀再递归，结果最短
  if (b !== null) {
    let n = 0;
    while ((a[n] ?? ZERO) === b[n]) n++;
    if (n > 0) return b.slice(0, n) + midpoint(a.slice(n), b.slice(n));
  }
  const da = a.length > 0 ? D.indexOf(a[0]) : 0;
  const db = b !== null ? D.indexOf(b[0]) : D.length;
  if (db - da > 1) return D[Math.round((da + db) / 2)];
  if (b !== null && b.length > 1) return b.slice(0, 1);
  return D[da] + midpoint(a.slice(1), null);
}

/**
 * 生成一个严格位于 before 与 after 之间的 key。
 * @param {string | null} before 前一个邻居，null = 插到最前面
 * @param {string | null} after  后一个邻居，null = 追加到最后面
 * @returns {string}
 */
export function keyBetween(before, after) {
  if (before !== null) validate(before);
  if (after !== null) validate(after);
  if (before !== null && after !== null && before >= after) {
    throw new RangeError(`fracindex: ${before} >= ${after}`);
  }

  if (before === null) {
    if (after === null) return 'a' + ZERO;          // 第一个 key
    const intB = integerPart(after);
    const fracB = after.slice(intB.length);
    if (intB === SMALLEST) return intB + midpoint('', fracB);
    if (intB < after) return intB;                   // after 有小数部分，取其整数部分即可
    const dec = decrementInteger(intB);
    if (dec === null) throw new RangeError('fracindex: 已到下界，无法再往前插');
    return dec;
  }

  if (after === null) {
    const intA = integerPart(before);
    const fracA = before.slice(intA.length);
    const inc = incrementInteger(intA);
    return inc === null ? intA + midpoint(fracA, null) : inc;
  }

  const intA = integerPart(before);
  const fracA = before.slice(intA.length);
  const intB = integerPart(after);
  const fracB = after.slice(intB.length);
  if (intA === intB) return intA + midpoint(fracA, fracB);

  const inc = incrementInteger(intA);
  if (inc === null) throw new RangeError('fracindex: 已到上界');
  if (inc < after) return inc;
  return intA + midpoint(fracA, null);
}

/**
 * 一次生成 n 个依次递增、且都落在 before 与 after 之间的 key。
 * 批量导入 / 新建表时用，比循环调用 keyBetween 得到的 key 更短。
 * @param {string | null} before @param {string | null} after @param {number} n
 * @returns {string[]}
 */
export function keysBetween(before, after, n) {
  if (n <= 0) return [];
  if (n === 1) return [keyBetween(before, after)];

  if (after === null) {
    // 末尾批量追加：连续递增整数部分，key 最短
    let k = keyBetween(before, null);
    const out = [k];
    for (let i = 1; i < n; i++) { k = keyBetween(k, null); out.push(k); }
    return out;
  }
  if (before === null) {
    let k = keyBetween(null, after);
    const out = [k];
    for (let i = 1; i < n; i++) { k = keyBetween(null, k); out.push(k); }
    return out.reverse();
  }
  // 中间插入：二分，左右两半长度最均衡
  const mid = keyBetween(before, after);
  const left = Math.floor((n - 1) / 2);
  return [
    ...keysBetween(before, mid, left),
    mid,
    ...keysBetween(mid, after, n - 1 - left),
  ];
}

/** 追加到末尾。@param {string | null} last @returns {string} */
export const keyAfter = (last) => keyBetween(last, null);

/** 插到最前面。@param {string | null} first @returns {string} */
export const keyBefore = (first) => keyBetween(null, first);
