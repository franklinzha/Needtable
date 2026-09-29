/**
 * 计算层：原文 → 显示。夹在 model 与 renderer 之间，所有"看起来是什么样"的判断都在这里。
 *
 *   · 公式求值（shared/formula 的 Engine，惰性 + 按版本号整体作废）
 *   · 数字格式（nf）与公式结果的建议格式（=TODAY() 显示成日期）
 *   · 条件格式（props.cf）、合并（props.merges）、筛选（props.filter）、批注、数据验证的查询
 *
 * 缓存全部挂在 model.rev 上：数据一变就整体作废。协作场景下别人随时改任何格子，
 * 精确的失效追踪不值得它的复杂度，而"只算看得见的"本身就足够快。
 */

import { Engine, isFormula } from '../../shared/formula/evaluate.js';
import { formatValue } from '../../shared/formula/numfmt.js';
import { parseLiteral, parseDateText, FErr, compare, Ref, ERR } from '../../shared/formula/values.js';
import { parseRange as parseExtRange, keyOf as keyOfRange } from '../../shared/formula/extref.js';
import { srcError, toPaths, listFromRows, cascadeOptions, cascadeStale, optText, MAX_SRC_ROWS } from './dropdown.js';
import { shiftFormula } from '../../shared/formula/parse.js';
import { colName } from '../../shared/util/a1.js';
import { t as tt } from '../../shared/i18n/i18n.js';

const K = 16384;
const EMPTY = Object.freeze({ text: '', color: null, align: 'l' });
const DISPLAY_CACHE_MAX = 60000;
/** 条件格式统计（重复值、前 N 项、平均值、色阶）最多扫这么多格 */
const CF_SCAN_MAX = 300000;

/** @typedef {[number, number, number, number]} Range */
/** @typedef {{text:string, color:string|null, align:'l'|'c'|'r'}} Display */

/** 条件格式规则的中文名（对话框与规则列表共用）。 */
export const CF_TYPES = [
  ['gt', tt('大于')], ['lt', tt('小于')], ['ge', tt('大于或等于')], ['le', tt('小于或等于')],
  ['eq', tt('等于')], ['ne', tt('不等于')], ['between', tt('介于')],
  ['contains', tt('文本包含')], ['notContains', tt('文本不包含')],
  ['blank', tt('为空')], ['notBlank', tt('不为空')],
  ['dup', tt('重复值')], ['uniq', tt('唯一值')],
  ['top', tt('值最大的 N 项')], ['bottom', tt('值最小的 N 项')],
  ['aboveAvg', tt('高于平均值')], ['belowAvg', tt('低于平均值')],
  ['formula', tt('使用公式确定')],
  ['bar', tt('数据条')], ['scale', tt('色阶')],
];

export class Calc {
  /**
   * @param {import('./model.js').GridModel} model
   * @param {{ tableId?: string, ext?: (table: string, range: string) => any }} [link]
   *   跨表引用：当前表编号和外表取数（见 extrefs.js）。没有就一律 #REF!。
   */
  constructor(model, link = {}) {
    this.model = model;
    /** 下拉列表引用别的表时取数用 */
    this.link = link;
    this.engine = new Engine({
      raw: (r, c) => model.getCell(r, c),
      rows: () => model.rowCount,
      cols: () => model.colCount,
      tableId: link.tableId,
      ext: link.ext,
      formulas: () => model.formulaCells(),
    });
    /** 显示公式原文而不是结果（公式 → 显示公式） */
    this.showFormulas = false;
    this._rev = -1;
    /** @type {Map<number, Display>} */ this._disp = new Map();
    /** @type {Map<any, any>} */ this._cfStats = new Map();
    /** @type {Set<number> | null | undefined} */ this._filtered = undefined;
    /** @type {Map<number, string> | null} */ this._notes = null;
  }

  /** 版本号变了就把所有缓存作废。每个公开方法第一行都要调它。 */
  _check() {
    if (this.model.rev === this._rev) return;
    this._rev = this.model.rev;
    this.engine.invalidate();
    this._disp.clear();
    this._cfStats.clear();
    this._filtered = undefined;
    this._notes = null;
    this._files = null;
    this._srcRows = null;
  }

  /** 强制作废（切换"显示公式"之类不改数据的开关时用）。 */
  invalidate() { this._rev = -1; }

  /** 单元格的值（数字 / 文本 / 布尔 / FErr / null）。排序、图表、状态栏求和都用它。 */
  value(r, c) {
    this._check();
    if (this.model.getCell(r, c) === '' && !this.engine.spillOwner(r, c)) return null;
    return this.engine.value(r, c);
  }

  /**
   * 这一格是不是被某个公式的结果铺到了（动态数组溢出）。是就返回锚点公式的位置。
   * @param {number} r @param {number} c @returns {{r:number, c:number} | null}
   */
  spillOwner(r, c) {
    this._check();
    return this.model.getCell(r, c) === '' ? this.engine.spillOwner(r, c) : null;
  }

  /** 格子里有东西可显示：自己有内容，或者被溢出铺到。 */
  hasContent(r, c) {
    return this.model.getCell(r, c) !== '' || !!this.spillOwner(r, c);
  }

  /** @param {number} r @param {number} c @returns {Display} */
  display(r, c) {
    this._check();
    const k = r * K + c;
    const hit = this._disp.get(k);
    if (hit) return hit;
    const d = this._compute(r, c);
    if (d === EMPTY) return d;
    if (this._disp.size > DISPLAY_CACHE_MAX) this._disp.clear();
    this._disp.set(k, d);
    return d;
  }

  /** 显示文本（不走缓存，给筛选、查找、导出这种批量扫描用）。 */
  text(r, c) { this._check(); return this._compute(r, c).text; }

  /** @returns {Display} */
  _compute(r, c) {
    const raw = this.model.getCell(r, c);
    if (raw === '') {
      if (!this.engine.spillOwner(r, c) || this.showFormulas) return EMPTY;
      const v = this.engine.value(r, c);
      if (v == null) return EMPTY;
      const f = formatValue(v, this.model.getFormat(r, c)?.nf);
      return { text: f.text, color: f.color, align: typeof v === 'number' ? 'r' : typeof v === 'boolean' || v instanceof FErr ? 'c' : 'l' };
    }
    const nf = this.model.getFormat(r, c)?.nf;
    if (this.showFormulas || nf === '@') return { text: raw, color: null, align: 'l' };

    let v, fmt = nf;
    if (isFormula(raw)) {
      v = this.engine.value(r, c);
      if (!fmt) fmt = this.engine.formatHint(raw);
    } else if (raw.charCodeAt(0) === 39) {
      return { text: raw.slice(1), color: null, align: 'l' };
    } else {
      v = parseLiteral(raw);
      if (!fmt && typeof v === 'string') return { text: raw, color: null, align: 'l' };
    }
    const f = formatValue(v, fmt);
    const align = typeof v === 'number' ? 'r'
      : typeof v === 'boolean' || v instanceof FErr ? 'c'
      : 'l';
    return { text: f.text, color: f.color, align };
  }

  /** 公式有没有语法错误（公式栏提示用）。 */
  syntaxError(raw) { return this.engine.syntaxError(raw); }

  // ── 合并 ──────────────────────────────────────────────────────────────

  /** @returns {Range[]} */
  merges() {
    const m = this.model.props.merges;
    return Array.isArray(m) ? m : [];
  }

  /** 包含 (r,c) 的合并区域。 @returns {Range | null} */
  mergeAt(r, c) {
    for (const m of this.merges()) if (r >= m[0] && r <= m[2] && c >= m[1] && c <= m[3]) return m;
    return null;
  }

  /** 与给定矩形相交的合并区域。 @returns {Range[]} */
  mergesIn(r0, r1, c0, c1) {
    const out = [];
    for (const m of this.merges()) if (m[0] <= r1 && m[2] >= r0 && m[1] <= c1 && m[3] >= c0) out.push(m);
    return out;
  }

  /** 把矩形撑大到完整包住所有与它相交的合并区域（选区不能切开合并格）。 */
  expandRect(s) {
    const ms = this.merges();
    if (!ms.length) return s;
    let { r0, r1, c0, c1 } = s;
    for (let changed = true, guard = 0; changed && guard < 20; guard++) {
      changed = false;
      for (const m of ms) {
        if (m[0] <= r1 && m[2] >= r0 && m[1] <= c1 && m[3] >= c0) {
          if (m[0] < r0) { r0 = m[0]; changed = true; }
          if (m[2] > r1) { r1 = m[2]; changed = true; }
          if (m[1] < c0) { c0 = m[1]; changed = true; }
          if (m[3] > c1) { c1 = m[3]; changed = true; }
        }
      }
    }
    return { r0, r1, c0, c1 };
  }

  // ── 批注 / 数据验证 ───────────────────────────────────────────────────

  noteAt(r, c) {
    this._check();
    if (!this._notes) {
      this._notes = new Map();
      const list = this.model.props.notes;
      if (Array.isArray(list)) for (const n of list) if (Array.isArray(n)) this._notes.set(n[0] * K + n[1], String(n[2] ?? ''));
    }
    return this._notes.size ? this._notes.get(r * K + c) ?? null : null;
  }

/** 单元格的附件列表 [{id, n, t, s}]；没有返回 null。 */
  filesAt(r, c) {
    this._check();
    if (!this._files) {
      this._files = new Map();
      for (const e of this.fileEntries()) this._files.set(e[0] * K + e[1], e[2]);
    }
    return this._files.size ? this._files.get(r * K + c) ?? null : null;
  }

  /** @returns {[number, number, any[]][]} 只留形状正确、且至少有一个附件的条目 */
  fileEntries() {
    const list = this.model.props.files;
    if (!Array.isArray(list)) return [];
    return list.filter((e) => Array.isArray(e) && Number.isInteger(e[0]) && Number.isInteger(e[1]) && Array.isArray(e[2]) && e[2].length);
  }

  get hasNotes() { const n = this.model.props.notes; return Array.isArray(n) && n.length > 0; }

  /** @returns {any | null} */
  validationAt(r, c) {
    const list = this.model.props.validations;
    if (!Array.isArray(list)) return null;
    for (let i = list.length - 1; i >= 0; i--) {
      const v = list[i];
      const g = v?.range;
      if (g && r >= g[0] && r <= g[2] && c >= g[1] && c <= g[3]) return v;
    }
    return null;
  }

  /**
   * 输入值是否满足数据验证。返回 null 表示通过，否则是一句给人看的原因。
   * @param {any} rule @param {string} raw
   */
  checkValidation(rule, raw, r = -1, c = -1) {
    if (!rule || raw === '' || isFormula(raw)) return null;
    const v = parseLiteral(raw);
    const n = typeof v === 'number' ? v : null;
    const has = (x) => x != null && x !== '';
    const inRange = (x) => (!has(rule.min) || x >= Number(rule.min)) && (!has(rule.max) || x <= Number(rule.max));
    switch (rule.type) {
      case 'list': case 'cascade': {
        const d = this.dropdownOptions(rule, r, c);
        if (d.loading || d.error) return null;   // 数据源还没取到 / 取不到：先放行，别挡住输入
        if (!d.options.length && d.hint) return d.hint;
        return d.options.includes(raw) ? null : tt('只能从下拉列表中选择：{list}', { list: d.options.slice(0, 8).join(tt('、')) });
      }
      case 'int':
        return n != null && Number.isInteger(n) && inRange(n) ? null : rangeMsg(rule, 'int');
      case 'decimal':
        return n != null && inRange(n) ? null : rangeMsg(rule, 'decimal');
      case 'textLen':
        return inRange(raw.length) ? null : rangeMsg(rule, 'textLen');
      case 'checkbox':
        return /^(TRUE|FALSE)$/i.test(raw) ? null : tt('复选框只接受 TRUE / FALSE');
      case 'date':
        // 录入的日期是文本（2026-01-31 不会存成序列号），要按日期文本认
        return n != null || parseDateText(raw) != null ? null : tt('请输入日期，如 2026-01-31');
      default:
        return null;
    }
  }

  /**
   * 下拉列表数据源（src）读成文本二维表。本表直接读计算结果，别的表走跨表引用。
   * @param {any} src
   * @returns {{ rows: string[][], loading?: boolean, error?: string }}
   */
  sourceRows(src) {
    const bad = srcError(src, 'list');
    if (bad) return { rows: [], error: bad };
    const g = /** @type {any} */ (parseExtRange(src.range));
    const own = !src.table || src.table === this.link.tableId;
    if (!own) {
      if (!this.link.ext) return { rows: [], error: tt('这里不能引用别的表') };
      const v = this.link.ext(src.table, keyOfRange(g));
      if (v === ERR.LOADING) return { rows: [], loading: true };
      if (!(v instanceof Ref)) return { rows: [], error: tt('取不到「{table}」的数据（没有权限或表格已删除）', { table: src.table }) };
      /** @type {string[][]} */ const rows = [];
      for (let i = 0; i < Math.min(v.h, MAX_SRC_ROWS); i++) {
        const row = [];
        for (let j = 0; j < v.w; j++) row.push(optText(v.get(i, j)));
        rows.push(row);
      }
      return { rows };
    }
    this._check();
    // 同一版本里缓存：粘贴一大片带下拉的格子时不用每格都重读一遍区域
    const key = keyOfRange(g);
    const hit = this._srcRows?.get(key);
    if (hit) return hit;
    const r0 = g.r0 ?? 0, r1 = Math.min(g.r1 ?? Infinity, this.model.rowCount - 1, r0 + MAX_SRC_ROWS - 1);
    const c1 = Math.min(g.c1, this.model.colCount - 1);
    /** @type {string[][]} */ const rows = [];
    for (let r = r0; r <= r1; r++) {
      const row = [];
      for (let c = g.c0; c <= c1; c++) row.push(this.text(r, c));
      rows.push(row);
    }
    (this._srcRows ??= new Map()).set(key, { rows });
    return { rows };
  }

  /**
   * 单元格 (r, c) 的下拉选项。多级下拉按左边各级已选的值过滤。
   * hint：选项为空时给人看的原因（「请先选择上一级」）。
   * @param {any} rule @param {number} r @param {number} c
   * @returns {{ options: string[], loading?: boolean, error?: string, hint?: string, level?: number }}
   */
  dropdownOptions(rule, r, c) {
    if (rule?.type === 'list') {
      if (!rule.src) return { options: listOptions(rule) };
      const s = this.sourceRows(rule.src);
      if (s.loading || s.error) return { options: [], loading: s.loading, error: s.error };
      return { options: listFromRows(s.rows, !!rule.src.header) };
    }
    if (rule?.type !== 'cascade') return { options: [] };
    const bad = srcError(rule.src, 'cascade');
    if (bad) return { options: [], error: bad };
    const s = this.sourceRows(rule.src);
    if (s.loading || s.error) return { options: [], loading: s.loading, error: s.error };
    const paths = toPaths(s.rows, !!rule.src.header, true);
    const c0 = Array.isArray(rule.range) ? rule.range[1] : c;
    const level = Math.max(0, c - c0);
    const width = s.rows[0]?.length ?? 0;
    if (level >= width) return { options: [], level, hint: tt('数据源只有 {n} 列，这一列没有对应的级别', { n: width }) };
    const prefix = [];
    for (let i = 0; i < level; i++) prefix.push(this.text(r, c0 + i).trim());
    const miss = prefix.findIndex((x) => x === '');
    if (miss >= 0) return { options: [], level, hint: tt('请先选择第 {n} 级（{col} 列）', { n: miss + 1, col: colName(c0 + miss) }) };
    return { options: cascadeOptions(paths, prefix), level };
  }

  /**
   * 多级下拉：(r, c) 改成 v 之后，右边哪些格子已经对不上、要清空。
   * @param {any} rule @param {number} r @param {number} c @param {string} v
   * @returns {[number, number, string][]} setCells 用的 [r, c, '']
   */
  cascadeClears(rule, r, c, v) {
    if (rule?.type !== 'cascade' || !Array.isArray(rule.range)) return [];
    const s = this.sourceRows(rule.src);
    if (s.loading || s.error) return [];
    const paths = toPaths(s.rows, !!rule.src.header, true);
    const c0 = rule.range[1], c1 = rule.range[3];
    const vals = [];
    for (let j = c0; j <= c1; j++) vals.push(j === c ? String(v).trim() : this.text(r, j).trim());
    return cascadeStale(paths, vals, c - c0 + 1).map((k) => [r, c0 + k, '']);
  }

  // ── 筛选 ──────────────────────────────────────────────────────────────

  /** 被筛选隐藏的行。没有筛选或没有条件时返回 null。 @returns {Set<number> | null} */
  filteredRows() {
    this._check();
    if (this._filtered !== undefined) return this._filtered;
    this._filtered = null;
    const f = this.model.props.filter;
    if (!f || !Array.isArray(f.range)) return null;
    const crit = Object.entries(f.crit ?? {}).map(([c, v]) => [Number(c), normCrit(v)]).filter(([, v]) => v);
    if (!crit.length) return null;
    const out = new Set();
    const end = Math.min(f.range[2], this.model.rowCount - 1);
    for (let r = f.range[0] + 1; r <= end; r++) {
      for (const [c, cr] of crit) {
        const t = this._compute(r, c).text;
        const hit = cr.set.has(t);
        if (cr.show ? !hit : hit) { out.add(r); break; }
      }
    }
    this._filtered = out;
    return out;
  }

  // ── 条件格式 ──────────────────────────────────────────────────────────

  get hasCf() { const cf = this.model.props.cf; return Array.isArray(cf) && cf.length > 0; }

  /**
   * (r,c) 命中的条件格式。多条规则时靠前的优先（与 Excel 的规则优先级一致）。
   * @returns {null | {bg?:string, fc?:string, b?:boolean, i?:boolean, bar?:{ratio:number, color:string}}}
   */
  cfAt(r, c) {
    const rules = this.model.props.cf;
    if (!Array.isArray(rules) || !rules.length) return null;
    this._check();
    /** @type {any} */ let out = null;
    for (const rule of rules) {
      const g = rule?.range;
      if (!g || r < g[0] || r > g[2] || c < g[1] || c > g[3]) continue;
      const hit = this._cfEval(rule, r, c);
      if (!hit) continue;
      out = out ?? {};
      for (const [k, v] of Object.entries(hit)) if (out[k] === undefined && v != null && v !== false && v !== '') out[k] = v;
    }
    return out;
  }

  /** @returns {any | null} */
  _cfEval(rule, r, c) {
    const v = this.value(r, c);
    const style = rule.style ?? {};
    const num = typeof v === 'number' ? v : null;
    const cmp = (x) => compare(v, parseLiteral(String(x ?? '')));
    const txt = () => (v == null ? '' : String(this.display(r, c).text)).toLowerCase();
    const needle = String(rule.v1 ?? '').toLowerCase();
    switch (rule.type) {
      case 'gt': return v != null && cmp(rule.v1) > 0 ? style : null;
      case 'lt': return v != null && cmp(rule.v1) < 0 ? style : null;
      case 'ge': return v != null && cmp(rule.v1) >= 0 ? style : null;
      case 'le': return v != null && cmp(rule.v1) <= 0 ? style : null;
      case 'eq': return v != null && cmp(rule.v1) === 0 ? style : null;
      case 'ne': return v != null && cmp(rule.v1) !== 0 ? style : null;
      case 'between': return v != null && cmp(rule.v1) >= 0 && cmp(rule.v2) <= 0 ? style : null;
      case 'contains': return v != null && txt().includes(needle) ? style : null;
      case 'notContains': return !txt().includes(needle) ? style : null;
      case 'blank': return v == null || v === '' ? style : null;
      case 'notBlank': return v != null && v !== '' ? style : null;
      case 'dup': case 'uniq': {
        if (v == null) return null;
        const n = this._stat(rule, 'counts').get(keyOf(v)) ?? 0;
        return (rule.type === 'dup' ? n > 1 : n === 1) ? style : null;
      }
      case 'top': case 'bottom': {
        if (num == null) return null;
        const s = this._stat(rule, 'sorted');
        if (!s.length) return null;
        const n = Math.max(1, Math.min(s.length, Number(rule.v1) || 10));
        return (rule.type === 'top' ? num >= s[s.length - n] : num <= s[n - 1]) ? style : null;
      }
      case 'aboveAvg': case 'belowAvg': {
        if (num == null) return null;
        const s = this._stat(rule, 'sorted');
        if (!s.length) return null;
        let sum = 0;
        for (const x of s) sum += x;
        const avg = sum / s.length;
        return (rule.type === 'aboveAvg' ? num > avg : num < avg) ? style : null;
      }
      case 'formula': {
        const src = String(rule.v1 ?? '');
        if (!isFormula(src)) return null;
        const f = shiftFormula(src, r - rule.range[0], c - rule.range[1]);
        let res;
        try {
          res = this.engine._top(this.engine.compile(f.slice(1)), r, c);
        } catch {
          this.engine.depth = 0;
          this.engine.computing?.clear?.();
          return null;
        }
        return res === true || (typeof res === 'number' && res !== 0) ? style : null;
      }
      case 'bar': {
        if (num == null) return null;
        const s = this._stat(rule, 'sorted');
        if (!s.length) return null;
        const lo = Math.min(0, s[0]), hi = s[s.length - 1];
        const ratio = hi === lo ? 1 : (num - lo) / (hi - lo);
        return { bar: { ratio: Math.max(0, Math.min(1, ratio)), color: rule.color || '#638ec6' } };
      }
      case 'scale': {
        if (num == null) return null;
        const s = this._stat(rule, 'sorted');
        if (!s.length) return null;
        const lo = s[0], hi = s[s.length - 1];
        const t = hi === lo ? 0.5 : (num - lo) / (hi - lo);
        const colors = Array.isArray(rule.colors) && rule.colors.length >= 2 ? rule.colors : ['#f8696b', '#ffeb84', '#63be7b'];
        return { bg: scaleColor(colors, t) };
      }
      default: return null;
    }
  }

  /** 一条规则在其区域上的统计量（每个数据版本算一次）。 */
  _stat(rule, kind) {
    const key = (rule.id ?? '') + ':' + kind + ':' + rule.range.join(',');
    let s = this._cfStats.get(key);
    if (s) return s;
    const [r0, c0, r1, c1] = rule.range;
    const rEnd = Math.min(r1, this.model.rowCount - 1), cEnd = Math.min(c1, this.model.colCount - 1);
    let scanned = 0;
    if (kind === 'counts') {
      s = new Map();
      for (let r = r0; r <= rEnd && scanned < CF_SCAN_MAX; r++) {
        for (let c = c0; c <= cEnd; c++, scanned++) {
          const v = this.value(r, c);
          if (v == null) continue;
          const k = keyOf(v);
          s.set(k, (s.get(k) ?? 0) + 1);
        }
      }
    } else {
      s = [];
      for (let r = r0; r <= rEnd && scanned < CF_SCAN_MAX; r++) {
        for (let c = c0; c <= cEnd; c++, scanned++) {
          const v = this.value(r, c);
          if (typeof v === 'number') s.push(v);
        }
      }
      s.sort((a, b) => a - b);
    }
    this._cfStats.set(key, s);
    return s;
  }
}

/** 数据验证下拉列表的选项。 @param {any} rule @returns {string[]} */
export function listOptions(rule) {
  const src = Array.isArray(rule?.list) ? rule.list : String(rule?.list ?? '').split(/[,，\n]/);
  return src.map((s) => String(s).trim()).filter(Boolean);
}

/** 数据验证的范围提示，整句翻译。 @param {any} rule @param {'int'|'decimal'|'textLen'} kind */
function rangeMsg(rule, kind) {
  const lo = rule.min != null && rule.min !== '', hi = rule.max != null && rule.max !== '';
  const p = { min: rule.min, max: rule.max };
  if (kind === 'int') {
    if (lo && hi) return tt('请输入介于 {min} 与 {max} 之间的整数', p);
    if (lo) return tt('请输入不小于 {min} 的整数', p);
    if (hi) return tt('请输入不大于 {max} 的整数', p);
    return tt('请输入整数');
  }
  if (kind === 'decimal') {
    if (lo && hi) return tt('请输入介于 {min} 与 {max} 之间的数字', p);
    if (lo) return tt('请输入不小于 {min} 的数字', p);
    if (hi) return tt('请输入不大于 {max} 的数字', p);
    return tt('请输入数字');
  }
  if (lo && hi) return tt('文本长度应介于 {min} 与 {max} 之间', p);
  if (lo) return tt('文本长度应不小于 {min}', p);
  if (hi) return tt('文本长度应不大于 {max}', p);
  return tt('文本长度不符合要求');
}

/** 筛选条件：{show:[...]} / {hide:[...]} / 数组（等价于 show）。 */
function normCrit(v) {
  if (Array.isArray(v)) return { show: true, set: new Set(v.map(String)) };
  if (v && Array.isArray(v.show)) return { show: true, set: new Set(v.show.map(String)) };
  if (v && Array.isArray(v.hide) && v.hide.length) return { show: false, set: new Set(v.hide.map(String)) };
  return null;
}

function keyOf(v) {
  if (typeof v === 'string') return 's:' + v.toLowerCase();
  if (v instanceof FErr) return 'e:' + v.err;
  return typeof v + ':' + String(v);
}

/** 多段色阶插值。 @param {string[]} colors @param {number} t 0..1 */
export function scaleColor(colors, t) {
  t = Math.max(0, Math.min(1, t));
  const seg = (colors.length - 1) * t;
  const i = Math.min(colors.length - 2, Math.floor(seg));
  const f = seg - i;
  const a = hexRgb(colors[i]), b = hexRgb(colors[i + 1]);
  const mix = (x, y) => Math.round(x + (y - x) * f).toString(16).padStart(2, '0');
  return '#' + mix(a[0], b[0]) + mix(a[1], b[1]) + mix(a[2], b[2]);
}

function hexRgb(h) {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(h));
  if (!m) return [255, 255, 255];
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
