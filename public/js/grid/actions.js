/**
 * 编辑动作：选区 + 参数 → op 列表。全部是纯函数，不碰 DOM、不直接改模型 ——
 * 由 grid.exec() 统一应用并记入撤销栈，也因此可以脱离浏览器单测。
 *
 * 功能区、右键菜单、快捷键、对话框最终都落到这里的某个函数上。
 */

import { normalizeStyle } from '../../shared/model/ops.js';
import { shiftFormula } from '../../shared/formula/parse.js';
import { isFormula } from '../../shared/formula/evaluate.js';
import { parseLiteral, dateToSerial, serialToDate, compare } from '../../shared/formula/values.js';
import { t } from '../../shared/i18n/i18n.js';

/** 一次格式 / 清除操作最多波及的单元格数（整列整行选中时按有内容的范围裁剪） */
export const MAX_ACTION_CELLS = 400000;

/** @typedef {{r0:number,c0:number,r1:number,c1:number}} Rect */

/** 把选区裁剪到"有内容的范围"，整列选中 20 万行时不必逐格生成 op。 */
export function clipRect(model, rect) {
  let maxR = -1, maxC = -1;
  for (const k of model.cells.keys()) {
    const i = k.indexOf(':'); const r = +k.slice(0, i), c = +k.slice(i + 1);
    if (r > maxR) maxR = r; if (c > maxC) maxC = c;
  }
  for (const k of model.formats.keys()) {
    const i = k.indexOf(':'); const r = +k.slice(0, i), c = +k.slice(i + 1);
    if (r > maxR) maxR = r; if (c > maxC) maxC = c;
  }
  const r1 = Math.min(rect.r1, Math.max(rect.r0, maxR));
  const c1 = Math.min(rect.c1, Math.max(rect.c0, maxC));
  return { r0: rect.r0, c0: rect.c0, r1, c1 };
}

function cellCount(rect) { return (rect.r1 - rect.r0 + 1) * (rect.c1 - rect.c0 + 1); }

/** 选区太大时的裁剪策略：先裁到内容范围，仍然过大就报错。 */
function bounded(model, rect) {
  let r = rect;
  if (cellCount(r) > 20000) r = clipRect(model, r);
  if (cellCount(r) > MAX_ACTION_CELLS) throw new Error(t('选区过大（超过 {n} 个单元格）', { n: MAX_ACTION_CELLS.toLocaleString() }));
  return r;
}

/**
 * 样式补丁。patch 里值为 null / false 的键表示去掉该样式。
 * @param {any} model @param {Rect} rect @param {Record<string, any>} patch
 */
export function styleOps(model, rect, patch) {
  const r = bounded(model, rect);
  const cells = [];
  for (let y = r.r0; y <= r.r1; y++) {
    for (let x = r.c0; x <= r.c1; x++) {
      const cur = model.getFormat(y, x) ?? {};
      const next = { ...cur };
      for (const [k, v] of Object.entries(patch)) {
        if (v == null || v === false || v === '') delete next[k]; else next[k] = v;
      }
      const f = normalizeStyle(next);
      if (JSON.stringify(f) !== JSON.stringify(model.getFormat(y, x) ?? null)) cells.push([y, x, f]);
    }
  }
  return cells.length ? [{ t: 'setFormats', cells }] : [];
}

/** 直接用给定的整份格式覆盖（格式刷、选择性粘贴格式）。 */
export function setFormatOps(rect, getFmt) {
  const cells = [];
  for (let y = rect.r0; y <= rect.r1; y++) for (let x = rect.c0; x <= rect.c1; x++) cells.push([y, x, normalizeStyle(getFmt(y, x))]);
  return cells.length ? [{ t: 'setFormats', cells }] : [];
}

/**
 * 边框。kind: all | outer | inner | none | top | bottom | left | right | thick（外粗框用同色两遍，这里等同 outer）
 * @param {any} model @param {Rect} rect @param {string} kind @param {string} [color]
 */
export function borderOps(model, rect, kind, color = '#000000') {
  const r = bounded(model, rect);
  const cells = [];
  for (let y = r.r0; y <= r.r1; y++) {
    for (let x = r.c0; x <= r.c1; x++) {
      const cur = model.getFormat(y, x) ?? {};
      const bd = kind === 'none' ? {} : { ...(cur.bd ?? {}) };
      const top = y === r.r0, bottom = y === r.r1, left = x === r.c0, right = x === r.c1;
      const set = (side, on) => { if (on) bd[side] = color; };
      switch (kind) {
        case 'all': set('t', 1); set('b', 1); set('l', 1); set('r', 1); break;
        case 'outer': case 'thick': set('t', top); set('b', bottom); set('l', left); set('r', right); break;
        case 'inner': set('b', !bottom); set('r', !right); break;
        case 'top': set('t', top); break;
        case 'bottom': set('b', bottom); break;
        case 'left': set('l', left); break;
        case 'right': set('r', right); break;
      }
      const f = normalizeStyle({ ...cur, bd: Object.keys(bd).length ? bd : undefined });
      cells.push([y, x, f]);
    }
  }
  return cells.length ? [{ t: 'setFormats', cells }] : [];
}

/**
 * 清除。what: content | format | all | notes
 * @param {any} model @param {Rect} rect @param {'content'|'format'|'all'} what
 * @param {(r: number) => boolean} [skip] 跳过的行（被筛选隐藏的行，和 Excel 一样不动）
 */
export function clearOps(model, rect, what, skip) {
  const ops = [];
  const inRect = (r, c) => r >= rect.r0 && r <= rect.r1 && c >= rect.c0 && c <= rect.c1 && !skip?.(r);
  const big = cellCount(rect) > 20000;
  if (what !== 'format') {
    const cells = [];
    if (big) { for (const k of model.cells.keys()) { const [r, c] = k.split(':').map(Number); if (inRect(r, c)) cells.push([r, c, '']); } }
    else for (let r = rect.r0; r <= rect.r1; r++) { if (skip?.(r)) continue; for (let c = rect.c0; c <= rect.c1; c++) if (model.getCell(r, c) !== '') cells.push([r, c, '']); }
    if (cells.length) ops.push({ t: 'setCells', cells });
  }
  if (what !== 'content') {
    const cells = [];
    for (const k of model.formats.keys()) { const [r, c] = k.split(':').map(Number); if (inRect(r, c)) cells.push([r, c, null]); }
    if (cells.length) ops.push({ t: 'setFormats', cells });
  }
  return ops;
}

// ── 合并 ──────────────────────────────────────────────────────────────────

/**
 * mode: center（合并后居中）| merge（合并单元格）| across（跨越合并：逐行合并）| unmerge
 * 与 Excel 一致：只保留左上角的值，其余清空。返回 { ops, lost }，lost 是被丢弃的非空格子数，
 * 调用方据此决定要不要先确认。
 * @param {any} model @param {any} calc @param {Rect} rect @param {string} mode
 */
export function mergeOps(model, calc, rect, mode) {
  const existing = calc.merges();
  const overlaps = (m) => !(m[2] < rect.r0 || m[0] > rect.r1 || m[3] < rect.c0 || m[1] > rect.c1);
  const kept = existing.filter((m) => !overlaps(m));
  if (mode === 'unmerge') {
    if (kept.length === existing.length) return { ops: [], lost: 0 };
    return { ops: [{ t: 'setProp', key: 'merges', value: kept.length ? kept : null }], lost: 0 };
  }
  const blocks = [];
  if (mode === 'across') { for (let r = rect.r0; r <= rect.r1; r++) if (rect.c1 > rect.c0) blocks.push([r, rect.c0, r, rect.c1]); }
  else if (rect.r1 > rect.r0 || rect.c1 > rect.c0) blocks.push([rect.r0, rect.c0, rect.r1, rect.c1]);
  if (!blocks.length) return { ops: [], lost: 0 };
  if (cellCount(rect) > 100000) throw new Error(t('合并区域过大'));

  const clear = [];
  let lost = 0;
  for (const [r0, c0, r1, c1] of blocks) {
    for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) {
      if (r === r0 && c === c0) continue;
      if (model.getCell(r, c) !== '') { clear.push([r, c, '']); lost++; }
    }
  }
  const ops = [];
  if (clear.length) ops.push({ t: 'setCells', cells: clear });
  ops.push({ t: 'setProp', key: 'merges', value: kept.concat(blocks) });
  if (mode === 'center') ops.push(...styleOps(model, rect, { ha: 'c', va: 'm' }));
  return { ops, lost };
}

// ── 排序 / 筛选 / 去重 ─────────────────────────────────────────────────────

/** 排序键：空值永远垫底，数字排在文本前面（与 Excel 一致）。 */
function sortKey(calc, r, c) {
  const v = calc.value(r, c);
  if (v == null || v === '') return { k: 2, v: null };
  if (typeof v === 'number') return { k: 0, v };
  if (typeof v === 'boolean') return { k: 1, v: v ? 'TRUE' : 'FALSE' };
  return { k: 1, v: String(v?.err ?? v) };
}

const collator = new Intl.Collator('zh-Hans-CN', { numeric: true, sensitivity: 'base' });

/**
 * 按若干列排序选区内的行。公式随行移动并按行差平移引用。
 * @param {any} model @param {any} calc @param {Rect} rect
 * @param {{c:number, desc?:boolean}[]} keys @param {boolean} hasHeader
 */
export function sortOps(model, calc, rect, keys, hasHeader = false) {
  const r = clipRect(model, rect);
  const start = r.r0 + (hasHeader ? 1 : 0);
  if (r.r1 <= start) return [];
  const rows = [];
  for (let y = start; y <= r.r1; y++) rows.push({ y, keys: keys.map((k) => sortKey(calc, y, k.c)) });
  rows.sort((a, b) => {
    for (let i = 0; i < keys.length; i++) {
      const x = a.keys[i], z = b.keys[i];
      if (x.k !== z.k) return x.k - z.k;              // 空值不受升降序影响，始终在最后
      if (x.k === 2) continue;
      let d = x.k === 0 ? x.v - z.v : collator.compare(x.v, z.v);
      if (keys[i].desc) d = -d;
      if (d) return d;
    }
    return a.y - b.y;                                  // 稳定排序
  });
  const cells = [], fmts = [];
  rows.forEach((row, i) => {
    const to = start + i;
    if (row.y === to) return;
    for (let x = r.c0; x <= r.c1; x++) {
      const raw = model.getCell(row.y, x);
      cells.push([to, x, isFormula(raw) ? shiftFormula(raw, to - row.y, 0) : raw]);
      fmts.push([to, x, model.getFormat(row.y, x) ?? null]);
    }
  });
  const ops = [];
  if (cells.length) ops.push({ t: 'setCells', cells });
  if (fmts.some((f) => f[2]) || fmts.some(([y, x]) => model.getFormat(y, x))) ops.push({ t: 'setFormats', cells: fmts });
  return ops;
}

/**
 * 删除重复行：按选定列的显示值判断，保留第一次出现的行，其余行上移补齐。
 * @returns {{ops:any[], removed:number}}
 */
export function dedupeOps(model, calc, rect, cols, hasHeader = false) {
  const r = clipRect(model, rect);
  const start = r.r0 + (hasHeader ? 1 : 0);
  const seen = new Set();
  const keep = [];
  for (let y = start; y <= r.r1; y++) {
    const k = cols.map((c) => calc.text(y, c)).join('\u0001');
    if (seen.has(k)) continue;
    seen.add(k);
    keep.push(y);
  }
  const removed = r.r1 - start + 1 - keep.length;
  if (!removed) return { ops: [], removed: 0 };
  const cells = [], fmts = [];
  for (let i = 0; i < r.r1 - start + 1; i++) {
    const to = start + i, from = keep[i];
    for (let x = r.c0; x <= r.c1; x++) {
      if (from == null) { cells.push([to, x, '']); fmts.push([to, x, null]); continue; }
      const raw = model.getCell(from, x);
      cells.push([to, x, isFormula(raw) ? shiftFormula(raw, to - from, 0) : raw]);
      fmts.push([to, x, model.getFormat(from, x) ?? null]);
    }
  }
  return { ops: [{ t: 'setCells', cells }, { t: 'setFormats', cells: fmts }], removed };
}

// ── 分列 ──────────────────────────────────────────────────────────────────

/**
 * 分列：把选区第一列的文本按分隔符拆到右侧各列。
 * delim: 'tab' | 'comma' | 'semicolon' | 'space' | 其他任意字符串；width 为固定宽度模式（数组形式的切分点）
 * @returns {{ops:any[], cols:number, overwrite:number}}
 */
export function splitTextOps(model, rect, { delim = 'comma', widths = null, mergeRepeat = false } = {}) {
  const r = clipRect(model, rect);
  const sep = { tab: '\t', comma: /[,，]/, semicolon: /[;；]/, space: ' ' }[delim] ?? delim;
  const cells = [];
  let maxCols = 1, overwrite = 0;
  const pieces = [];
  for (let y = r.r0; y <= r.r1; y++) {
    const v = model.getCell(y, r.c0);
    if (v === '' || isFormula(v)) { pieces.push(null); continue; }
    let parts;
    if (widths && widths.length) {
      parts = []; let at = 0;
      for (const w of widths) { parts.push(v.slice(at, at + w)); at += w; }
      if (at < v.length) parts.push(v.slice(at));
    } else {
      parts = v.split(sep);
      if (mergeRepeat) parts = parts.filter((p) => p !== '');
    }
    parts = parts.map((p) => p.trim());
    pieces.push(parts);
    maxCols = Math.max(maxCols, parts.length);
  }
  pieces.forEach((parts, i) => {
    if (!parts) return;
    const y = r.r0 + i;
    for (let j = 0; j < maxCols; j++) {
      const x = r.c0 + j;
      if (j > 0 && model.getCell(y, x) !== '') overwrite++;
      cells.push([y, x, parts[j] ?? '']);
    }
  });
  return { ops: cells.length ? [{ t: 'setCells', cells }] : [], cols: maxCols, overwrite };
}

// ── 填充柄 / Ctrl+D / Ctrl+R ───────────────────────────────────────────────

const LISTS = [
  ['星期一', '星期二', '星期三', '星期四', '星期五', '星期六', '星期日'],
  ['周一', '周二', '周三', '周四', '周五', '周六', '周日'],
  ['一月', '二月', '三月', '四月', '五月', '六月', '七月', '八月', '九月', '十月', '十一月', '十二月'],
  ['第一季度', '第二季度', '第三季度', '第四季度'],
  ['甲', '乙', '丙', '丁', '戊', '己', '庚', '辛', '壬', '癸'],
  ['子', '丑', '寅', '卯', '辰', '巳', '午', '未', '申', '酉', '戌', '亥'],
  ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'],
  ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'],
  ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'],
  ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'],
];
LISTS.push(Array.from({ length: 12 }, (_, i) => (i + 1) + '月'));

const RE_DATE = /^(\d{4})([-/.])(\d{1,2})\2(\d{1,2})$/;
const RE_SUFFIX = /^(.*?)(\d+)(\D*)$/;

/**
 * 从一组源值推断出第 k 个延伸值（k 从 0 起，表示紧接源序列之后的第一个）。
 * 返回一个 (k) => string 的生成器，推断不出规律就原样循环复制。
 * @param {string[]} src @param {boolean} series  false = 仅复制（按住 Ctrl 拖或 Ctrl+D）
 */
export function inferSeries(src, series = true) {
  const n = src.length;
  const copy = (k) => src[(n + k % n) % n];
  if (!series || src.some((v) => isFormula(v))) return copy;

  // 纯数字：两个及以上按等差，单个数字 Excel 是复制
  const nums = src.map((v) => parseLiteral(v));
  if (nums.every((v) => typeof v === 'number') && !src.some((v) => RE_DATE.test(v.trim()))) {
    if (n === 1) return copy;
    const step = linearStep(nums);
    const last = nums[n - 1];
    const dec = Math.max(...src.map((v) => (v.split('.')[1] ?? '').length));
    return (k) => fix(last + step * (k + 1), dec);
  }
  // 日期 yyyy-mm-dd：单个按天递增，多个按差值
  const dates = src.map((v) => RE_DATE.exec(v.trim()));
  if (dates.every(Boolean)) {
    const sep = dates[0][2];
    const serials = dates.map((m) => dateToSerial(+m[1], +m[3], +m[4]));
    const step = n === 1 ? 1 : linearStep(serials);
    const pad = dates[0][3].length === 2;
    const last = serials[n - 1];
    return (k) => {
      const d = serialToDate(last + step * (k + 1));
      const p2 = (x) => (pad ? String(x).padStart(2, '0') : String(x));
      return d.y + sep + p2(d.m) + sep + p2(d.d);
    };
  }
  // 内置序列（星期、月份……）
  for (const list of LISTS) {
    const idx = src.map((v) => list.indexOf(v.trim()));
    if (idx.every((i) => i >= 0)) {
      const step = n === 1 ? 1 : ((idx[n - 1] - idx[n - 2]) || 1);
      return (k) => list[(((idx[n - 1] + step * (k + 1)) % list.length) + list.length) % list.length];
    }
  }
  // 文本 + 数字后缀：项目1 → 项目2，第3周 → 第4周
  const sm = src.map((v) => RE_SUFFIX.exec(v));
  if (sm.every(Boolean) && sm.every((m) => m[1] === sm[0][1] && m[3] === sm[0][3])) {
    const vals = sm.map((m) => +m[2]);
    const step = n === 1 ? 1 : linearStep(vals);
    const width = sm[0][2].startsWith('0') ? sm[0][2].length : 0;
    const last = vals[n - 1];
    return (k) => sm[0][1] + String(Math.max(0, last + step * (k + 1))).padStart(width, '0') + sm[0][3];
  }
  return copy;
}

function linearStep(v) {
  // 最小二乘斜率；对等差序列就是公差
  const n = v.length;
  let sx = 0, sy = 0, sxy = 0, sxx = 0;
  for (let i = 0; i < n; i++) { sx += i; sy += v[i]; sxy += i * v[i]; sxx += i * i; }
  const d = n * sxx - sx * sx;
  return d ? (n * sxy - sx * sy) / d : 0;
}

function fix(x, dec) { return String(+x.toFixed(Math.min(10, Math.max(dec, 0)))); }

/**
 * 填充：把 src 区域沿某个方向延伸到 target（target 包含 src）。
 * 方向由两者的关系推出：target 比 src 高就是纵向，宽就是横向；向上 / 向左拖也支持。
 * @param {any} model @param {Rect} src @param {Rect} target @param {{series?:boolean}} [opt]
 */
export function fillOps(model, src, target, { series = true } = {}) {
  const cells = [], fmts = [];
  const vertical = (target.r1 - target.r0) !== (src.r1 - src.r0);
  if (vertical) {
    const down = target.r1 > src.r1;
    for (let c = src.c0; c <= src.c1; c++) {
      const vals = [];
      for (let r = src.r0; r <= src.r1; r++) vals.push(model.getCell(r, c));
      const seq = down ? vals : vals.slice().reverse();
      const gen = inferSeries(seq, series);
      const len = src.r1 - src.r0 + 1;
      const rows = down ? range(src.r1 + 1, target.r1) : range(src.r0 - 1, target.r0, -1);
      rows.forEach((r, k) => {
        const srcR = down ? src.r0 + (k % len) : src.r1 - (k % len);
        const raw = model.getCell(srcR, c);
        cells.push([r, c, isFormula(raw) ? shiftFormula(raw, r - srcR, 0) : gen(k)]);
        fmts.push([r, c, model.getFormat(srcR, c) ?? null]);
      });
    }
  } else {
    const right = target.c1 > src.c1;
    for (let r = src.r0; r <= src.r1; r++) {
      const vals = [];
      for (let c = src.c0; c <= src.c1; c++) vals.push(model.getCell(r, c));
      const seq = right ? vals : vals.slice().reverse();
      const gen = inferSeries(seq, series);
      const len = src.c1 - src.c0 + 1;
      const colsTo = right ? range(src.c1 + 1, target.c1) : range(src.c0 - 1, target.c0, -1);
      colsTo.forEach((c, k) => {
        const srcC = right ? src.c0 + (k % len) : src.c1 - (k % len);
        const raw = model.getCell(r, srcC);
        cells.push([r, c, isFormula(raw) ? shiftFormula(raw, 0, c - srcC) : gen(k)]);
        fmts.push([r, c, model.getFormat(r, srcC) ?? null]);
      });
    }
  }
  const ops = [];
  if (cells.length) ops.push({ t: 'setCells', cells });
  if (fmts.some((f) => f[2]) || fmts.some(([r, c]) => model.getFormat(r, c))) ops.push({ t: 'setFormats', cells: fmts });
  return ops;
}

function range(a, b, step = 1) {
  const out = [];
  if (step > 0) for (let i = a; i <= b; i++) out.push(i); else for (let i = a; i >= b; i--) out.push(i);
  return out;
}

/** Ctrl+D：用选区首行向下复制；Ctrl+R：用首列向右复制。 */
export function fillDownOps(model, rect, dir) {
  if (dir === 'down') {
    if (rect.r1 === rect.r0) return [];
    return fillOps(model, { ...rect, r1: rect.r0 }, rect, { series: false });
  }
  if (rect.c1 === rect.c0) return [];
  return fillOps(model, { ...rect, c1: rect.c0 }, rect, { series: false });
}

// ── 查找 / 替换 ────────────────────────────────────────────────────────────

/**
 * @param {{q:string, matchCase?:boolean, whole?:boolean, inFormulas?:boolean, regex?:boolean}} o
 * @returns {(s:string)=>boolean}
 */
function matcher(o) {
  let re;
  const flags = o.matchCase ? 'g' : 'gi';
  try {
    const body = o.regex ? o.q : o.q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    re = new RegExp(o.whole ? '^(?:' + body + ')$' : body, flags);
  } catch { re = /$^/; }
  return re;
}

/**
 * 查找全部匹配，按行优先排序。text 为显示值读取函数。
 * @param {any} model @param {(r:number,c:number)=>string} text
 * @param {Rect | null} scope
 */
export function findAll(model, text, o, scope = null) {
  if (!o.q) return [];
  const re = matcher(o);
  const out = [];
  for (const [k, raw] of model.cells) {
    const i = k.indexOf(':'); const r = +k.slice(0, i), c = +k.slice(i + 1);
    if (scope && (r < scope.r0 || r > scope.r1 || c < scope.c0 || c > scope.c1)) continue;
    const s = o.inFormulas || !isFormula(raw) ? raw : text(r, c);
    re.lastIndex = 0;
    if (re.test(s)) out.push({ r, c });
  }
  out.sort((a, b) => a.r - b.r || a.c - b.c);
  return out;
}

/** 替换：只作用于原文（公式里的文字也会被替换，与 Excel 的"查找范围：公式"一致）。 */
export function replaceOps(model, hits, o, replacement) {
  const re = matcher(o);
  const cells = [];
  for (const { r, c } of hits) {
    const raw = model.getCell(r, c);
    re.lastIndex = 0;
    const next = raw.replace(re, o.regex ? replacement : () => replacement);
    if (next !== raw) cells.push([r, c, next]);
  }
  return cells.length ? [{ t: 'setCells', cells }] : [];
}

// ── 选择性粘贴 / 其他 ──────────────────────────────────────────────────────

/**
 * 内部剪贴板的块：原文 + 格式，另记源位置用于公式平移。
 * @typedef {{r0:number,c0:number,raw:string[][],fmt:any[][],values:string[][]}} ClipBlock
 */

/** 从模型抓一块，供复制 / 剪切 / 格式刷使用。 */
export function captureBlock(model, calc, rect) {
  const raw = [], fmt = [], values = [];
  for (let r = rect.r0; r <= rect.r1; r++) {
    const a = [], b = [], v = [];
    for (let c = rect.c0; c <= rect.c1; c++) {
      a.push(model.getCell(r, c));
      b.push(model.getFormat(r, c) ?? null);
      v.push(calc ? valueText(calc, r, c) : model.getCell(r, c));
    }
    raw.push(a); fmt.push(b); values.push(v);
  }
  return { r0: rect.r0, c0: rect.c0, raw, fmt, values };
}

/** 公式的"值"：数字保持完整精度而不是按格式四舍五入后的文本。 */
export function valueText(calc, r, c) {
  const v = calc.value(r, c);
  if (v == null) return '';
  if (typeof v === 'number') return String(+v.toPrecision(15));
  if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE';
  if (v && typeof v === 'object' && 'err' in v) return String(v.err);
  return String(v);
}

/**
 * 粘贴一个内部块。mode: all | values | formats | formulas | transpose
 * 目标区域是多格且正好是块的整数倍时平铺（与 Excel 一致）。
 * @param {ClipBlock} block @param {Rect} dest
 */
export function pasteBlockOps(block, dest, mode = 'all') {
  let raw = block.raw, fmt = block.fmt, values = block.values;
  if (mode === 'transpose') { raw = transpose(raw); fmt = transpose(fmt); values = transpose(values); }
  const h = raw.length, w = raw[0]?.length ?? 0;
  if (!h || !w) return [];
  const dh = dest.r1 - dest.r0 + 1, dw = dest.c1 - dest.c0 + 1;
  const ty = dh > h && dh % h === 0 ? dh / h : 1;
  const tx = dw > w && dw % w === 0 ? dw / w : 1;
  const cells = [], fmts = [];
  for (let iy = 0; iy < ty; iy++) for (let ix = 0; ix < tx; ix++) {
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const r = dest.r0 + iy * h + y, c = dest.c0 + ix * w + x;
      const sr = mode === 'transpose' ? block.r0 + x : block.r0 + y;
      const sc = mode === 'transpose' ? block.c0 + y : block.c0 + x;
      if (mode !== 'formats') {
        const v = raw[y][x];
        const out = mode === 'values' ? values[y][x] : isFormula(v) ? shiftFormula(v, r - sr, c - sc) : v;
        cells.push([r, c, out]);
      }
      if (mode === 'all' || mode === 'formats' || mode === 'transpose') fmts.push([r, c, fmt[y][x]]);
    }
  }
  const ops = [];
  if (cells.length) ops.push({ t: 'setCells', cells });
  if (fmts.length) ops.push({ t: 'setFormats', cells: fmts });
  return ops;
}

function transpose(m) {
  const out = [];
  for (let x = 0; x < (m[0]?.length ?? 0); x++) out.push(m.map((row) => row[x]));
  return out;
}

/** 把选区里的公式就地换成它的值（"复制 → 粘贴为数值"的一步版）。 */
export function toValuesOps(model, calc, rect) {
  const cells = [];
  for (const [k, raw] of model.cells) {
    if (!isFormula(raw)) continue;
    const i = k.indexOf(':'); const r = +k.slice(0, i), c = +k.slice(i + 1);
    if (r < rect.r0 || r > rect.r1 || c < rect.c0 || c > rect.c1) continue;
    cells.push([r, c, valueText(calc, r, c)]);
  }
  return cells.length ? [{ t: 'setCells', cells }] : [];
}

/** 文本变换：upper / lower / trim / proper。公式不动。 */
export function textTransformOps(model, rect, kind) {
  const f = {
    upper: (s) => s.toUpperCase(),
    lower: (s) => s.toLowerCase(),
    trim: (s) => s.replace(/\s+/g, ' ').trim(),
    proper: (s) => s.toLowerCase().replace(/(^|[^a-z])([a-z])/g, (_, a, b) => a + b.toUpperCase()),
  }[kind];
  const cells = [];
  for (const [k, raw] of model.cells) {
    if (isFormula(raw)) continue;
    const i = k.indexOf(':'); const r = +k.slice(0, i), c = +k.slice(i + 1);
    if (r < rect.r0 || r > rect.r1 || c < rect.c0 || c > rect.c1) continue;
    const next = f(raw);
    if (next !== raw) cells.push([r, c, next]);
  }
  return cells.length ? [{ t: 'setCells', cells }] : [];
}

/** 下拉列表的选项在 calc.dropdownOptions 里算（手动列表 / 引用区域 / 多级下拉）。 */
export { compare };
