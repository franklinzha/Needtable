/**
 * 下拉列表 / 多级下拉的选项：纯逻辑，不碰 DOM。
 *
 * 数据验证规则（props.validations 里的一项）两种和下拉有关：
 *   { type:'list',    range, list:['a','b'] }                   手动输入的选项（旧写法，一直兼容）
 *   { type:'list',    range, src:{ table?, range, header? } }   引用一块区域，选项实时跟着区域变
 *   { type:'cascade', range, src:{ table?, range, header? } }   多级下拉
 * src.table 为空 = 本表；否则是另一张表的编号（tbl_xxx），走跨表引用（extrefs.js）取值。
 * src.range 是 A1 文本（A2:C200、A:C 都行）；header = 区域第一行是标题，不当选项。
 *
 * 多级下拉的数据源是「路径表」：每一行是一条完整路径，第 1 列一级、第 2 列二级……
 *   浙江 | 杭州 | 西湖区
 *   浙江 | 杭州 | 滨江区
 *   浙江 | 宁波 | 海曙区
 * 上级留空表示沿用上一行（像合并单元格那样只写第一行也行）。
 * 规则的范围横跨几列就是几级：第 1 列选一级，第 2 列的选项是「一级 = 左边那格」的二级，依此类推。
 */

import { parseRange as parseExtRange } from '../../shared/formula/extref.js';
import { t } from '../../shared/i18n/i18n.js';

/** 区域最多读这么多行 / 选项最多这么多个（再多下拉也没法用了） */
export const MAX_SRC_ROWS = 5000;
export const MAX_OPTIONS = 1000;
/** 多级下拉最多几级 */
export const MAX_LEVELS = 6;

/** 规则是不是下拉（有 ▾ 按钮）。 @param {any} rule */
export const isDropdown = (rule) => rule?.type === 'list' || rule?.type === 'cascade';

/**
 * 数据源是否合法。返回 null 表示没问题，否则是给人看的原因。
 * @param {any} src @param {'list'|'cascade'} type
 */
export function srcError(src, type) {
  if (!src || typeof src.range !== 'string' || !src.range.trim()) return t('请填写数据源区域，例如 A2:C200');
  const g = parseExtRange(src.range);
  if (!g) return t('区域「{range}」写得不对，请写成 A2:C200 或 A:C 这样', { range: src.range });
  if (g.c0 == null) return t('请用列区域（如 A:C 或 A2:C200），不要用整行');
  const w = /** @type {number} */ (g.c1) - g.c0 + 1;
  if (type === 'cascade' && w < 2) return t('多级下拉的数据源至少要两列：第 1 列一级、第 2 列二级……');
  if (type === 'cascade' && w > MAX_LEVELS) return t('最多 {n} 级（数据源最多 {n} 列）', { n: MAX_LEVELS });
  return null;
}

/** 数据源的简短说明：「本表 A2:C200」「客户表 A:A」。 @param {any} src @param {(id:string)=>string} [tableName] */
export function srcLabel(src, tableName) {
  if (!src) return '';
  return (src.table ? (tableName?.(src.table) || src.table) : t('本表')) + ' ' + src.range;
}

/**
 * 读出的原始行 → 路径：去掉标题行、全空行，上级留空的沿用上一行。
 * @param {string[][]} rows @param {boolean} header @param {boolean} fill 上级留空时沿用上一行（多级下拉用）
 */
export function toPaths(rows, header, fill) {
  /** @type {string[][]} */ const out = [];
  /** @type {string[]} */ let prev = [];
  for (let i = header ? 1 : 0; i < rows.length && out.length < MAX_SRC_ROWS; i++) {
    const row = rows[i].map((x) => String(x ?? '').trim());
    let last = -1;
    row.forEach((x, j) => { if (x !== '') last = j; });
    if (last < 0) continue;
    if (fill) for (let j = 0; j < last; j++) if (row[j] === '') row[j] = prev[j] ?? '';
    out.push(row);
    prev = row;
  }
  return out;
}

/** 去重、保持先后顺序、去掉空白。 @param {Iterable<string>} xs */
function uniq(xs) {
  /** @type {string[]} */ const out = [];
  const seen = new Set();
  for (const x of xs) {
    if (x === '' || seen.has(x)) continue;
    seen.add(x);
    out.push(x);
    if (out.length >= MAX_OPTIONS) break;
  }
  return out;
}

/**
 * 普通下拉引用区域时的选项：区域里所有非空的格子，按行读，去重。
 * @param {string[][]} rows @param {boolean} header
 */
export function listFromRows(rows, header) {
  return uniq(toPaths(rows, header, false).flat());
}

/**
 * 多级下拉某一级的选项。
 * @param {string[][]} paths toPaths 的结果
 * @param {string[]} prefix 左边各级已选的值（长度 = 这一级的序号）
 * @returns {string[]} 上一级没选时为空
 */
export function cascadeOptions(paths, prefix) {
  if (prefix.some((x) => x === '')) return [];
  const k = prefix.length;
  return uniq(paths.filter((p) => prefix.every((x, i) => p[i] === x)).map((p) => p[k] ?? ''));
}

/**
 * 上一级改了之后，右边哪些级已经对不上、要清空。
 * @param {string[][]} paths @param {string[]} vals 这一行各级当前的值（已经是改过之后的）
 * @param {number} from 从第几级开始检查（改动那一级 + 1）
 * @returns {number[]} 要清空的级（序号）
 */
export function cascadeStale(paths, vals, from) {
  const cur = vals.slice();
  /** @type {number[]} */ const out = [];
  for (let k = Math.max(1, from); k < cur.length; k++) {
    if (cur[k] === '') continue;
    if (!cascadeOptions(paths, cur.slice(0, k)).includes(cur[k])) { cur[k] = ''; out.push(k); }
  }
  return out;
}

/** 值（数字 / 布尔 / 文本 / 错误 / null）→ 选项文本。 @param {any} v */
export function optText(v) {
  if (v == null) return '';
  if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE';
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : '';
  if (typeof v === 'string') return v;
  return '';   // 错误值不当选项
}
