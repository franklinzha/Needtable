/**
 * 命令表：功能区按钮、右键菜单、快捷键最终都调 grid.cmd.run(id, arg)。
 *
 * 每条命令只做三件事之一：算出 op 交给 grid.exec（可撤销、会同步）、打开一个对话框、
 * 或者改一个纯本地的视图开关（显示公式、格式刷）。命令本身不直接碰模型。
 */

import {
  styleOps, borderOps, clearOps, mergeOps, sortOps, fillOps, fillDownOps,
  toValuesOps, textTransformOps, clipRect, captureBlock, pasteBlockOps,
} from './actions.js';
import { adjustDecimals } from '../../shared/formula/numfmt.js';
import { openMenu } from '../ui/menu.js';
import { plainTitle } from '../ui/dom.js';
import { confirmDialog, alertDialog } from '../ui/dialog.js';
import { getAI } from '../ai/index.js';
import * as D from './dialogs.js';
import { MAX_PIVOTS, nextPivotName, cleanPivotName } from './pivotcalc.js';
import { rangeName, colName } from '../../shared/util/a1.js';
import { t as tt } from '../../shared/i18n/i18n.js';

export const BORDER_KINDS = [
  ['all', tt('所有框线')], ['outer', tt('外侧框线')], ['inner', tt('内部框线')], ['thick', tt('粗外侧框线')],
  ['top', tt('上框线')], ['bottom', tt('下框线')], ['left', tt('左框线')], ['right', tt('右框线')], ['none', tt('无框线')],
];

export class Commands {
  /** @param {import('./grid.js').Grid} grid */
  constructor(grid) {
    this.g = grid;
    this.borderColor = '#000000';
    this.fontColor = '#d93025';
    this.fillColor = '#fff2cc';
  }

  /** 当前选区（撑开到完整包住合并格）。 */
  get rect() { return this.g.calc.expandRect(this.g.sel.rect); }
  get model() { return this.g.model; }
  get active() { return this.g.sel.active; }
  fmt(r = this.active.r, c = this.active.c) { return this.model.getFormat(r, c) ?? {}; }

  status(msg, kind) { this.g.opts.onStatus?.(msg, kind); }

  /** 算 op 并执行；算的过程抛错（选区过大之类）就提示而不是崩掉。 */
  apply(fn) {
    if (!this.g._canEdit()) return null;
    try {
      const ops = fn();
      if (ops && ops.length) return this.g.exec(ops);
    } catch (err) {
      this.status(err instanceof Error ? err.message : String(err), 'error');
    }
    return null;
  }

  style(patch) { const s = this.rect; this.apply(() => styleOps(this.model, s, patch)); }
  toggle(k) { this.style({ [k]: !this.fmt()[k] }); }

  /** @param {string} id @param {any} [arg] */
  run(id, arg) {
    const fn = this.table[id];
    if (!fn) { console.warn('未知命令', id); return; }
    if (this.g.view !== 'grid' && !VIEW_SAFE.has(id)) return;
    if (this.g.noCopy && NO_COPY.has(id)) { this.status(tt('这是公开只读链接：不能复制或导出'), 'error'); return; }
    if (this.g.editor.open && id !== 'insertFunction') this.g.editor.commit('none');
    try {
      const r = fn.call(this, arg);
      if (r && typeof r.catch === 'function') r.catch((err) => this.status(String(err?.message ?? err), 'error'));
    } catch (err) {
      this.status(err instanceof Error ? err.message : String(err), 'error');
    }
    this.g.ribbon?.refresh();
  }

  get table() {
    return TABLE;
  }

  // ── 供 grid.js 直接调用的几个 ────────────────────────────────────────

  /** 填充柄拖完。 */
  fill(src, target) {
    this.apply(() => fillOps(this.model, src, target));
    this.g.sel.set(target.r0, target.c0);
    this.g.sel.extendTo(target.r1, target.c1);
    this.g._paint();
  }

  /** 格式刷落下：把刷子里的格式平铺到目标区域。 */
  applyPainter() {
    const p = this.g.painter;
    if (!p) return;
    const s = this.g.sel.rect;
    const h = p.block.raw.length, w = p.block.raw[0].length;
    const dest = s.r0 === s.r1 && s.c0 === s.c1 ? { r0: s.r0, c0: s.c0, r1: s.r0 + h - 1, c1: s.c0 + w - 1 } : s;
    this.apply(() => pasteBlockOps(p.block, dest, 'formats'));
    if (!p.sticky) this.g.painter = null;
    this.g.ribbon?.refresh();
  }

  /** 双击列边线 / 「自动调整列宽」。按可见行里最长的显示文本估算。 */
  autofitCols(c0, c1) {
    const g = this.g, ctx = g.canvas.getContext('2d');
    const ops = [];
    const r0 = 0;
    const rEnd = Math.min(g.model.rowCount - 1, lastRow(g.model) );
    const limit = Math.min(rEnd, r0 + 5000);
    for (let c = c0; c <= c1; c++) {
      let w = 0;
      for (let r = r0; r <= limit; r++) {
        if (g.model.getCell(r, c) === '') continue;
        const f = g.model.getFormat(r, c);
        if (ctx) ctx.font = g.renderer.fontOf ? g.renderer.fontOf(f) : '13px sans-serif';
        const t = g.calc.text(r, c);
        const tw = ctx ? ctx.measureText(t).width : t.length * 8;
        if (tw > w) w = tw;
      }
      ops.push({ t: 'resizeField', c, w: Math.max(40, Math.ceil(w + 16)) });
    }
    this.apply(() => ops);
  }

  /** 双击行边线：按换行后的行数估算行高。 */
  autofitRows(r0, r1) {
    const g = this.g, ops = [];
    for (let r = r0; r <= Math.min(r1, r0 + 2000); r++) {
      let lines = 1, fs = 13;
      for (let c = 0; c < g.model.colCount; c++) {
        const v = g.model.getCell(r, c);
        if (v === '') continue;
        const f = g.model.getFormat(r, c);
        if (f?.fs) fs = Math.max(fs, f.fs);
        const t = g.calc.text(r, c);
        let n = t.split('\n').length;
        if (f?.wr) n = Math.max(n, Math.ceil((t.length * fs * 0.6) / Math.max(20, g.model.colWidth(c) - 8)));
        lines = Math.max(lines, n);
      }
      ops.push({ t: 'setRowHeight', r, h: Math.max(g.model.defaultRowHeight, Math.round(lines * fs * 1.35 + 8)) });
    }
    this.apply(() => ops);
  }

  /** 筛选按钮下拉：排序、按值筛选、清除。 */
  filterMenu(col, x, y) {
    const g = this.g, f = g.model.props.filter;
    if (!f) return;
    const crit = f.crit?.[col];
    const [fr0, fc0, fr1, fc1] = f.range;
    const body = { r0: fr0, c0: fc0, r1: fr1, c1: fc1 };
    const sortBy = (desc) => this.apply(() => sortOps(g.model, g.calc, body, [{ c: col, desc }], true));
    const setCrit = (v) => {
      const next = { ...(f.crit ?? {}) };
      if (v == null) delete next[col]; else next[col] = v;
      this.apply(() => [{ t: 'setProp', key: 'filter', value: { ...f, crit: next } }]);
    };
    const act = this.active;
    openMenu([
      { label: tt('升序'), icon: '↑', action: () => sortBy(false) },
      { label: tt('降序'), icon: '↓', action: () => sortBy(true) },
      { sep: true },
      { label: tt('按值筛选…'), icon: '⚲', action: () => D.filterValues(g, col, f, setCrit) },
      { label: tt('按所选单元格的值筛选'), disabled: act.c !== col || act.r <= fr0, action: () => setCrit({ show: [g.calc.text(act.r, act.c)] }) },
      { label: tt('清除“{name}”中的筛选', { name: g.calc.text(fr0, col) || colName(col) }), disabled: !crit, action: () => setCrit(null) },
      { label: tt('清除全部筛选'), disabled: !Object.keys(f.crit ?? {}).length, action: () => this.run('clearFilter') },
      { sep: true },
      { label: tt('取消筛选'), action: () => this.run('toggleFilter') },
    ], { x, y });
  }

  /** 活动单元格所在的连续数据区域（Excel 的 Ctrl+A / 自动筛选范围）。 */
  region() {
    const s = this.g.sel.rect;
    if (s.r0 !== s.r1 || s.c0 !== s.c1) return clipRect(this.model, s);
    return this.regionAt(s.r0, s.c0);
  }

  /** 从 (r, c) 向四周扩展出的连续数据区域。 @param {number} r @param {number} c */
  regionAt(r, c) {
    const s = { r0: r, c0: c };
    const m = this.model, has = (r, c) => r >= 0 && c >= 0 && r < m.rowCount && c < m.colCount && m.getCell(r, c) !== '';
    let r0 = s.r0, r1 = s.r0, c0 = s.c0, c1 = s.c0;
    for (let grew = true, guard = 0; grew && guard < 200; guard++) {
      grew = false;
      const rowHas = (r) => { for (let c = c0 - 1; c <= c1 + 1; c++) if (has(r, c)) return true; return false; };
      const colHas = (c) => { for (let r = r0 - 1; r <= r1 + 1; r++) if (has(r, c)) return true; return false; };
      while (r0 > 0 && rowHas(r0 - 1)) { r0--; grew = true; }
      while (r1 < m.rowCount - 1 && rowHas(r1 + 1)) { r1++; grew = true; }
      while (c0 > 0 && colHas(c0 - 1)) { c0--; grew = true; }
      while (c1 < m.colCount - 1 && colHas(c1 + 1)) { c1++; grew = true; }
    }
    return { r0, c0, r1, c1 };
  }

  /** 当前表的透视表定义（总是数组）。 */
  pivots() { const v = this.model.props.pivots; return Array.isArray(v) ? v.filter((p) => p && p.id) : []; }

  /** 首行看起来像表头吗：全是文本，而第二行有数字。 */
  looksLikeHeader(rect) {
    const g = this.g;
    if (rect.r1 <= rect.r0) return false;
    let text = 0, num2 = 0;
    for (let c = rect.c0; c <= rect.c1; c++) {
      const a = g.calc.value(rect.r0, c), b = g.calc.value(rect.r0 + 1, c);
      if (typeof a === 'string') text++;
      else if (a != null) return false;
      if (typeof b === 'number') num2++;
    }
    return text > 0 && (num2 > 0 || this.model.getFormat(rect.r0, rect.c0)?.b === true);
  }

  selectRect(s) {
    this.g.sel.set(s.r0, s.c0);
    this.g.sel.extendTo(s.r1, s.c1);
    this.g._paint();
  }

  /** 选区覆盖的行 / 列范围。 */
  rows() { const s = this.rect; return { at: s.r0, n: s.r1 - s.r0 + 1 }; }
  cols() { const s = this.rect; return { at: s.c0, n: s.c1 - s.c0 + 1 }; }

  hide(axis, on) {
    const key = axis === 'row' ? 'hiddenRows' : 'hiddenCols';
    const { at, n } = axis === 'row' ? this.rows() : this.cols();
    const cur = new Set(this.model.props[key] ?? []);
    if (on) {
      const count = axis === 'row' ? this.model.rowCount : this.model.colCount;
      if (n >= count) { this.status(axis === 'row' ? tt('不能隐藏全部行') : tt('不能隐藏全部列'), 'error'); return; }
      for (let i = at; i < at + n; i++) cur.add(i);
    } else {
      // 取消隐藏：选区内以及紧邻选区两侧的隐藏行列都放出来（和 Excel 一样可以选中两侧再取消隐藏）
      for (const i of [...cur]) if (i >= at - 1 && i <= at + n) cur.delete(i);
      if (n === 1) for (let i = at + 1; cur.has(i); i++) cur.delete(i);
    }
    const list = [...cur].sort((a, b) => a - b);
    this.apply(() => [{ t: 'setProp', key, value: list.length ? list : null }]);
  }

  /** 插入 / 删除单元格并移动其余格子（不改变表的行列数）。 */
  shiftCells(dir, insert) {
    const g = this.g, m = this.model, s = this.rect;
    const h = s.r1 - s.r0 + 1, w = s.c1 - s.c0 + 1;
    const cells = [], fmts = [];
    const last = dir === 'down' ? lastRow(m) : lastCol(m);
    const move = (r, c, nr, nc) => { cells.push([nr, nc, m.getCell(r, c)]); fmts.push([nr, nc, m.getFormat(r, c) ?? null]); };
    const blank = (r, c) => { cells.push([r, c, '']); fmts.push([r, c, null]); };
    if (dir === 'down') {
      for (let c = s.c0; c <= s.c1; c++) {
        if (insert) { for (let r = Math.min(last, m.rowCount - 1 - h); r >= s.r0; r--) move(r, c, r + h, c); for (let r = s.r0; r <= s.r1; r++) blank(r, c); }
        else { for (let r = s.r0; r <= last; r++) { if (r + h <= last) move(r + h, c, r, c); else blank(r, c); } }
      }
    } else {
      for (let r = s.r0; r <= s.r1; r++) {
        if (insert) { for (let c = Math.min(last, m.colCount - 1 - w); c >= s.c0; c--) move(r, c, r, c + w); for (let c = s.c0; c <= s.c1; c++) blank(r, c); }
        else { for (let c = s.c0; c <= last; c++) { if (c + w <= last) move(r, c + w, r, c); else blank(r, c); } }
      }
    }
    if (cells.length > 400000) { this.status(tt('区域过大，请改用插入整行 / 整列'), 'error'); return; }
    this.apply(() => [{ t: 'setCells', cells }, { t: 'setFormats', cells: fmts }]);
    g._paint();
  }

  /** 自动求和：单格时向上（其次向左）找连续数字；多格时在选区下方逐列写公式。 */
  autoSum(fn = 'SUM') {
    const g = this.g, m = this.model, s = this.rect;
    const isNum = (r, c) => typeof g.calc.value(r, c) === 'number';
    if (s.r0 === s.r1 && s.c0 === s.c1) {
      let top = s.r0 - 1;
      while (top >= 0 && isNum(top, s.c0)) top--;
      let f;
      if (top < s.r0 - 1) f = '=' + fn + '(' + rangeName(top + 1, s.c0, s.r0 - 1, s.c0) + ')';
      else {
        let left = s.c0 - 1;
        while (left >= 0 && isNum(s.r0, left)) left--;
        f = left < s.c0 - 1 ? '=' + fn + '(' + rangeName(s.r0, left + 1, s.r0, s.c0 - 1) + ')' : '=' + fn + '()';
      }
      g._beginEdit(false, f);
      return;
    }
    const out = [];
    const row = s.r1 + 1;
    const lastIsBlank = (() => { for (let c = s.c0; c <= s.c1; c++) if (m.getCell(s.r1, c) !== '') return false; return true; })();
    const target = lastIsBlank ? s.r1 : row;
    const bottom = lastIsBlank ? s.r1 - 1 : s.r1;
    for (let c = s.c0; c <= s.c1; c++) out.push([target, c, '=' + fn + '(' + rangeName(s.r0, c, bottom, c) + ')']);
    this.apply(() => [{ t: 'setCells', cells: out }]);
  }

  /**
   * 数据验证下拉列表 / 多级下拉：在单元格下方弹出候选值。
   * 数据源在别的表、还没取到时，稍等一下再弹（最多约 3 秒）。
   */
  async openListPicker() {
    const g = this.g, { r, c } = this.active;
    const rule = g.calc.validationAt(r, c);
    if (!rule || (rule.type !== 'list' && rule.type !== 'cascade') || !g._canEdit()) return;
    let d = g.calc.dropdownOptions(rule, r, c);
    for (let i = 0; d.loading && i < 20; i++) {
      if (i === 0) this.status(tt('正在读取下拉列表的数据源…'));
      await new Promise((res) => setTimeout(res, 150));
      if (this.active.r !== r || this.active.c !== c) return;
      d = g.calc.dropdownOptions(rule, r, c);
    }
    if (d.loading) { this.status(tt('数据源还没取到，请稍后再点一次'), 'error'); return; }
    const b = g._editRect(), cr = g.canvas.getBoundingClientRect();
    const cur = g.model.getCell(r, c);
    /** 选中后：多级下拉顺手清掉右边对不上的下级 */
    const pick = (/** @type {string} */ v) => this.apply(() => {
      const clears = g.calc.cascadeClears(rule, r, c, v);
      return [{ t: 'setCell', r, c, v }, ...(clears.length ? [{ t: 'setCells', cells: clears }] : [])];
    });
    const note = d.error || (!d.options.length ? d.hint || tt('没有可选的值（检查数据源区域）') : '');
    openMenu([
      ...(note ? [{ label: note, disabled: true }] : []),
      ...d.options.map((o) => ({ label: o, checked: o === cur, action: () => pick(o) })),
      { sep: true },
      { label: tt('清空'), action: () => pick('') },
    ], { x: cr.left + b.x, y: cr.top + b.y + b.h });
  }

  async merge(mode) {
    const g = this.g, s = this.rect;
    const cur = g.calc.mergeAt(s.r0, s.c0);
    if (mode === 'center' && cur && cur[0] === s.r0 && cur[1] === s.c0 && cur[2] === s.r1 && cur[3] === s.c1) mode = 'unmerge';
    let res;
    try { res = mergeOps(g.model, g.calc, s, mode); } catch (err) { this.status(err.message, 'error'); return; }
    if (!res.ops.length) { if (mode !== 'unmerge') this.status(tt('请先选择多个单元格再合并')); return; }
    if (res.lost > 0 && !(await confirmDialog(tt('合并单元格'), tt('合并单元格时，仅保留左上角的值，而放弃其他值。是否继续？')))) return;
    this.apply(() => res.ops);
    if (mode !== 'unmerge' && mode !== 'across') this.selectRect(s);
  }

  togglePainter(sticky) {
    const g = this.g;
    if (g.painter) { g.painter = null; this.status(tt('已退出格式刷')); return; }
    const s = this.rect;
    if ((s.r1 - s.r0 + 1) * (s.c1 - s.c0 + 1) > 10000) { this.status(tt('格式刷的源区域过大'), 'error'); return; }
    g.painter = { block: captureBlock(g.model, null, s), sticky: !!sticky };
    this.status(sticky ? tt('格式刷（连续）：可多次刷，按 Esc 退出') : tt('格式刷：选择要应用格式的区域'));
  }

  decimals(delta) {
    const s = this.rect, g = this.g;
    const cur = this.fmt().nf;
    const nf = adjustDecimals(cur, delta, g.calc.value(this.active.r, this.active.c));
    this.style({ nf });
  }

  /** 双击填充柄：沿左侧（或右侧）相邻列的数据长度向下填充。 */
  fillToEnd() {
    const g = this.g, m = this.model, s = this.rect;
    const probe = s.c0 > 0 && m.getCell(s.r1 + 1, s.c0 - 1) !== '' ? s.c0 - 1 : s.c1 + 1;
    let end = s.r1;
    while (end + 1 < m.rowCount && m.getCell(end + 1, probe) !== '') end++;
    if (end === s.r1) return;
    this.fill(s, { ...s, r1: end });
  }

  structural(kind) {
    const g = this.g, R = this.model.rowCount, C = this.model.colCount;
    const rows = this.rows(), cols = this.cols();
    const op = {
      insertRowsAbove: { t: 'insertRows', at: rows.at, n: rows.n },
      insertRowsBelow: { t: 'insertRows', at: rows.at + rows.n, n: rows.n },
      insertColsLeft: { t: 'insertCols', at: cols.at, n: cols.n },
      insertColsRight: { t: 'insertCols', at: cols.at + cols.n, n: cols.n },
      deleteRows: { t: 'deleteRows', at: rows.at, n: Math.min(rows.n, R - 1) },
      deleteCols: { t: 'deleteCols', at: cols.at, n: Math.min(cols.n, C - 1) },
    }[kind];
    if (!op || op.n <= 0) { this.status(tt('至少要保留一行 / 一列'), 'error'); return; }
    if (op.t.startsWith('insert') && op.n > 1000) { this.status(tt('一次最多插入 1000 行 / 列'), 'error'); return; }
    this.apply(() => [op]);
    if (kind === 'insertRowsBelow') this.selectRect({ r0: op.at, c0: 0, r1: op.at + op.n - 1, c1: C - 1 });
    if (kind === 'insertColsRight') this.selectRect({ r0: 0, c0: op.at, r1: R - 1, c1: op.at + op.n - 1 });
  }

  async sortQuick(desc) {
    const g = this.g;
    const s = this.g.sel.rect;
    const single = s.r0 === s.r1 && s.c0 === s.c1;
    const f = g.model.props.filter;
    let region = single ? this.region() : clipRect(g.model, s);
    let header = single ? this.looksLikeHeader(region) : false;
    // 整列选中（列标菜单里的排序）：像 Excel 一样扩展到该列所在的整块数据，只排这一列会让各行数据错位
    if (s.c0 === s.c1 && s.r0 === 0 && s.r1 === g.model.rowCount - 1) {
      let r = 0;
      while (r < region.r1 && g.model.getCell(r, s.c0) === '') r++;
      region = this.regionAt(r, s.c0);
      header = this.looksLikeHeader(region);
    }
    if (f && single && inRect(f.range, this.active.r, this.active.c)) {
      region = { r0: f.range[0], c0: f.range[1], r1: f.range[2], c1: f.range[3] };
      header = true;
    }
    if (region.r1 <= region.r0) return;
    this.apply(() => sortOps(g.model, g.calc, region, [{ c: this.active.c, desc }], header));
  }

  toggleFilter() {
    const g = this.g, f = g.model.props.filter;
    if (f) { this.apply(() => [{ t: 'setProp', key: 'filter', value: null }]); this.status(tt('已取消筛选')); return; }
    const reg = this.region();
    if (g.model.getCell(reg.r0, reg.c0) === '' && reg.r0 === reg.r1 && reg.c0 === reg.c1) {
      this.status(tt('请先选中一个数据区域（首行作为表头）'), 'error');
      return;
    }
    const r1 = Math.max(reg.r1, reg.r0 + 1);
    this.apply(() => [{ t: 'setProp', key: 'filter', value: { range: [reg.r0, reg.c0, r1, reg.c1], crit: {} } }]);
    this.status(tt('已添加筛选：点击表头右侧的 ▾ 按钮选择条件'));
  }

  setNoteText(r, c, text) {
    const list = (this.model.props.notes ?? []).filter((n) => !(n[0] === r && n[1] === c));
    if (text) list.push([r, c, text]);
    this.apply(() => [{ t: 'setProp', key: 'notes', value: list.length ? list : null }]);
  }

  clearNotes() {
    const s = this.rect;
    const list = (this.model.props.notes ?? []).filter((n) => !inRect([s.r0, s.c0, s.r1, s.c1], n[0], n[1]));
    return [{ t: 'setProp', key: 'notes', value: list.length ? list : null }];
  }

  // ── 附件 ──────────────────────────────────────────────────────────────

  /** 选文件 → 上传 → 挂到活动单元格。 */
  pickFiles() {
    if (!this.g._canEdit() || !this._fileTable()) return;
    const { r, c } = this.active;
    const input = document.createElement('input');
    input.type = 'file';
    input.multiple = true;
    input.addEventListener('change', () => { if (input.files?.length) void this.uploadFiles([...input.files], r, c); });
    input.click();
  }

  /** 附件存在表自己的 DO 里，离线网格（没有表 ID）用不了。 */
  _fileTable() {
    const id = this.g.sync?.tableId;
    if (!id) this.status(tt('附件需要在已登录的协作表格里使用（离线网格没有存储）'), 'error');
    return id || null;
  }

  /** @param {File[]} list @param {number} r @param {number} c */
  async uploadFiles(list, r, c) {
    const tableId = this._fileTable();
    if (!tableId || !this.g._canEdit()) return;
    const A = await import('../io/attach.js');
    const added = [];
    for (let i = 0; i < list.length; i++) {
      const tag = list.length > 1 ? (i + 1) + '/' + list.length + ' ' : '';
      try {
        const file = await A.prepare(list[i]);
        if (file.size > A.MAX_BYTES) { this.status(tt('「{name}」超过 10MB，未上传', { name: list[i].name }), 'error'); continue; }
        this.status(tt('正在上传 {name}…', { name: tag + file.name }));
        added.push(await A.upload(tableId, file, (p) => this.status(tt('正在上传 {name} {pct}%', { name: tag + file.name, pct: Math.round(p * 100) }))));
      } catch (err) {
        this.status(tt('「{name}」上传失败：{msg}', { name: list[i].name, msg: err instanceof Error ? err.message : String(err) }), 'error');
      }
    }
    if (!added.length) return;
    this.addFileRefs(r, c, added);
    this.status(tt('已添加 {n} 个附件到 {cell}', { n: added.length, cell: colName(c) + (r + 1) }));
  }

  /** 单元格引用的附件整体替换。一格最多 50 个。 */
  setFileRefs(r, c, files) {
    const list = (this.model.props.files ?? []).filter((e) => !(e[0] === r && e[1] === c));
    if (files.length) list.push([r, c, files.slice(0, 50)]);
    return this.apply(() => [{ t: 'setProp', key: 'files', value: list.length ? list : null }]);
  }

  addFileRefs(r, c, add) { return this.setFileRefs(r, c, [...(this.g.calc.filesAt(r, c) ?? []), ...add]); }

  /** 只摘掉引用；文件本身由 DO 在宽限期后清理，所以撤销还能找回来。 */
  removeFileRef(r, c, id) { return this.setFileRefs(r, c, (this.g.calc.filesAt(r, c) ?? []).filter((f) => f.id !== id)); }

  clearFiles() {
    const s = this.rect;
    const list = (this.model.props.files ?? []).filter((e) => !inRect([s.r0, s.c0, s.r1, s.c1], e[0], e[1]));
    return list.length === (this.model.props.files ?? []).length ? [] : [{ t: 'setProp', key: 'files', value: list.length ? list : null }];
  }

  viewFiles() {
    const { r, c } = this.active;
    const files = this.g.calc.filesAt(r, c);
    if (!files?.length) { this.pickFiles(); return; }
    D.files(this.g, r, c);
  }

  /** 选区内的数据验证规则全部去掉（与选区部分重叠的规则按整条删除）。 */
  clearValidation() {
    const s = this.rect;
    const list = (this.model.props.validations ?? []).filter((v) => !overlaps(v.range, s));
    this.apply(() => [{ t: 'setProp', key: 'validations', value: list.length ? list : null }]);
  }

  addValidation(rule) {
    const list = (this.model.props.validations ?? []).filter((v) => !sameRange(v.range, rule.range));
    list.push(rule);
    return [{ t: 'setProp', key: 'validations', value: list }];
  }

  addCf(rule) {
    const list = (this.model.props.cf ?? []).slice();
    list.unshift({ id: 'cf' + Date.now().toString(36), ...rule });
    this.apply(() => [{ t: 'setProp', key: 'cf', value: list }]);
  }

  clearCf(scope) {
    const s = this.rect;
    const list = scope === 'all' ? [] : (this.model.props.cf ?? []).filter((r) => !overlaps(r.range, s));
    this.apply(() => [{ t: 'setProp', key: 'cf', value: list.length ? list : null }]);
  }

  insertCheckbox() {
    const s = clipRect(this.model, this.rect);
    const range = [s.r0, s.c0, s.r1, s.c1];
    const cells = [];
    for (let r = s.r0; r <= s.r1; r++) for (let c = s.c0; c <= s.c1; c++) {
      const v = this.model.getCell(r, c);
      if (!/^(TRUE|FALSE)$/i.test(v)) cells.push([r, c, 'FALSE']);
    }
    this.apply(() => [...this.addValidation({ range, type: 'checkbox' }), ...(cells.length ? [{ t: 'setCells', cells }] : [])]);
  }

  toggleCheckbox() {
    const { r, c } = this.active;
    const v = this.model.getCell(r, c);
    this.apply(() => [{ t: 'setCell', r, c, v: /^TRUE$/i.test(v) ? 'FALSE' : 'TRUE' }]);
  }

  async clearSheet() {
    if (!(await confirmDialog(tt('清空整张表'), tt('将删除所有单元格内容与格式（合并、条件格式等表属性保留）。此操作不可撤销，并会同步给所有协作者。'), { ok: tt('清空'), danger: true }))) return;
    this.apply(() => [{ t: 'clearAll' }]);
  }

  async exportFile(kind) {
    const g = this.g;
    const name = (plainTitle(g.nameEl?.textContent) || tt('表格')).replace(/[\/:*?"<>|]/g, '_');
    if (kind === 'csv') {
      const { toCsv } = await import('../io/csv.js');
      download(new Blob(['﻿' + toCsv(g.model, g.calc)], { type: 'text/csv;charset=utf-8' }), name + '.csv');
    } else {
      const [{ toXlsx }, P] = await Promise.all([import('../io/xlsx.js'), import('./pivotcalc.js')]);
      // 透视表各占一张工作表，排在数据后面（导出的是算好的结果，不是 Excel 原生的数据透视表对象）
      const pivots = this.pivots().filter((p) => P.validPivot(p)).map((p) => {
        const res = P.computePivot(p, (r, c) => g.calc.value(r, c), (r, c) => g.calc.text(r, c), (c) => g.model.colTitle(c));
        return res.error ? null : { name: p.name || tt('透视表'), matrix: P.pivotMatrix(res), opts: { dec: res.opts.dec } };
      }).filter((x) => x != null);
      download(new Blob([await toXlsx(g.model, g.calc, name, pivots)], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }), name + '.xlsx');
      if (pivots.length) { this.status(tt('已导出 {file}（含 {n} 个透视表，各占一张工作表）', { file: name + '.xlsx', n: pivots.length })); return; }
    }
    this.status(tt('已导出 {file}', { file: name + '.' + kind }));
  }

  importFile() {
    const g = this.g;
    if (!g._canEdit()) return;
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.csv,.tsv,.txt,.xlsx';
    input.addEventListener('change', async () => {
      const file = input.files?.[0];
      if (!file) return;
      try {
        let rows;
        if (/\.xlsx$/i.test(file.name)) {
          const { fromXlsx } = await import('../io/xlsx.js');
          rows = await fromXlsx(await file.arrayBuffer());
        } else {
          const { parseCsv } = await import('../io/csv.js');
          rows = parseCsv(await file.text(), /\.tsv$/i.test(file.name) ? '\t' : undefined);
        }
        D.importOptions(g, file.name, rows, (mode) => this.applyImport(rows, mode));
      } catch (err) {
        this.status(tt('导入失败：{msg}', { msg: err instanceof Error ? err.message : String(err) }), 'error');
      }
    });
    input.click();
  }

  applyImport(rows, mode) {
    const g = this.g;
    const n = rows.reduce((s, r) => s + r.length, 0);
    if (n > 200000) { this.status(tt('文件过大：一次最多导入 20 万个单元格（当前 {n}）', { n: n.toLocaleString() }), 'error'); return; }
    const at = mode === 'replace' ? { r: 0, c: 0 } : this.active;
    const cells = [];
    rows.forEach((row, i) => row.forEach((v, j) => { if (v !== '' && v != null) cells.push([at.r + i, at.c + j, String(v)]); }));
    const ops = mode === 'replace' ? clearOps(g.model, { r0: 0, c0: 0, r1: g.model.rowCount - 1, c1: g.model.colCount - 1 }, 'all') : [];
    ops.push({ t: 'setCells', cells });
    this.apply(() => ops);
    this.selectRect({ r0: at.r, c0: at.c, r1: at.r + Math.max(0, rows.length - 1), c1: at.c + Math.max(0, ...rows.map((r) => r.length - 1)) });
    this.status(tt('已导入 {n} 行', { n: rows.length.toLocaleString() }));
  }
}

/** 看板 / 仪表盘视图下仍然可用的命令。 */
/** 公开只读链接里不给用的：复制、导出，以及需要登录的 AI。 */
export const NO_COPY = new Set(['copy', 'cut', 'exportCsv', 'exportXlsx', 'ai']);
const VIEW_SAFE = new Set(['undo', 'redo', 'help', 'ai', 'editPivot', 'renamePivot', 'deletePivot', 'exportCsv', 'exportXlsx', 'importFile', 'demo']);

const PCT = '0.00%', CUR = '¥#,##0.00', THOU = '#,##0.00';

/**
 * 命令表。方法里的 this 是 Commands 实例。
 * @type {Record<string, (this: Commands, arg?: any) => any>}
 */
const TABLE = {
  // 剪贴板
  undo() { this.g.undo(); },
  redo() { this.g.redo(); },
  cut() { if (this.g._canEdit()) this.g.copySelection(true); },
  copy() { this.g.copySelection(false); this.status(tt('已复制，可用 Ctrl+V 或右键「粘贴」')); },
  paste() { return this.g.pasteFromMenu('all'); },
  pasteValues() { return this.g.pasteFromMenu('values'); },
  pasteFormats() { return this.g.pasteFromMenu('formats'); },
  pasteFormulas() { return this.g.pasteFromMenu('formulas'); },
  pasteTranspose() { return this.g.pasteFromMenu('transpose'); },
  painter() { this.togglePainter(false); },
  painterSticky() { this.togglePainter(true); },

  // 字体
  bold() { this.toggle('b'); },
  italic() { this.toggle('i'); },
  underline() { this.toggle('u'); },
  strike() { this.toggle('s'); },
  fontSize(n) { this.style({ fs: Number(n) || null }); },
  fontFamily(f) { this.style({ ff: f || null }); },
  growFont() { this.style({ fs: Math.min(72, (this.fmt().fs ?? 13) + 1) }); },
  shrinkFont() { this.style({ fs: Math.max(6, (this.fmt().fs ?? 13) - 1) }); },
  fontColor(c) { if (c) this.fontColor = c; this.style({ fc: c === null ? null : this.fontColor }); },
  fillColor(c) { if (c) this.fillColor = c; this.style({ bg: c === null ? null : this.fillColor }); },

  // 对齐
  alignL() { this.style({ ha: this.fmt().ha === 'l' ? null : 'l' }); },
  alignC() { this.style({ ha: this.fmt().ha === 'c' ? null : 'c' }); },
  alignR() { this.style({ ha: this.fmt().ha === 'r' ? null : 'r' }); },
  valignT() { this.style({ va: 't' }); },
  valignM() { this.style({ va: 'm' }); },
  valignB() { this.style({ va: null }); },
  wrap() { this.toggle('wr'); },

  // 边框
  border(kind) {
    const s = this.rect;
    this.apply(() => borderOps(this.model, s, kind || 'all', this.borderColor));
  },
  borderColor(c) { if (c) this.borderColor = c; },

  // 合并
  mergeCenter() { return this.merge('center'); },
  merge() { return this.merge('merge'); },
  mergeAcross() { return this.merge('across'); },
  unmerge() { return this.merge('unmerge'); },

  // 数字格式
  numFmt(nf) { this.style({ nf: nf || null }); },
  percent() { this.style({ nf: this.fmt().nf === PCT ? null : PCT }); },
  currency() { this.style({ nf: this.fmt().nf === CUR ? null : CUR }); },
  thousands() { this.style({ nf: this.fmt().nf === THOU ? null : THOU }); },
  incDecimals() { this.decimals(1); },
  decDecimals() { this.decimals(-1); },
  formatCells(tab) { if (this.g._canEdit()) D.formatCells(this.g, tab); },

  // 条件格式
  cf(type) { if (this.g._canEdit()) D.cfRule(this.g, type || 'gt', (rule) => this.addCf(rule)); },
  cfBar(color) { const s = this.rect; this.addCf({ range: [s.r0, s.c0, s.r1, s.c1], type: 'bar', color: color || '#638ec6' }); },
  cfScale(colors) { const s = this.rect; this.addCf({ range: [s.r0, s.c0, s.r1, s.c1], type: 'scale', colors: colors || ['#f8696b', '#ffeb84', '#63be7b'] }); },
  cfManage() { D.cfManager(this.g); },
  cfClear(scope) { this.clearCf(scope === 'all' ? 'all' : 'sel'); },

  // 行列
  insertRowsAbove() { this.structural('insertRowsAbove'); },
  insertRowsBelow() { this.structural('insertRowsBelow'); },
  insertColsLeft() { this.structural('insertColsLeft'); },
  insertColsRight() { this.structural('insertColsRight'); },
  deleteRows() { this.structural('deleteRows'); },
  deleteCols() { this.structural('deleteCols'); },
  insertDialog() { if (this.g._canEdit()) D.insertDelete(this.g, true, (k) => this.runShift(k, true)); },
  deleteDialog() { if (this.g._canEdit()) D.insertDelete(this.g, false, (k) => this.runShift(k, false)); },
  shiftDown() { this.shiftCells('down', true); },
  shiftRight() { this.shiftCells('right', true); },
  shiftUp() { this.shiftCells('down', false); },
  shiftLeft() { this.shiftCells('right', false); },
  hideRows() { this.hide('row', true); },
  hideCols() { this.hide('col', true); },
  unhideRows() { this.hide('row', false); },
  unhideCols() { this.hide('col', false); },
  rowHeight() {
    const { at, n } = this.rows();
    D.sizeDialog(this.g, tt('行高'), this.model.rowHeight(at), 18, 400, (v) => {
      const ops = [];
      for (let r = at; r < at + Math.min(n, 5000); r++) ops.push({ t: 'setRowHeight', r, h: v });
      this.apply(() => ops);
    });
  },
  colWidth() {
    const { at, n } = this.cols();
    D.sizeDialog(this.g, tt('列宽'), this.model.colWidth(at), 32, 1000, (v) => {
      const ops = [];
      for (let c = at; c < at + n; c++) ops.push({ t: 'resizeField', c, w: v });
      this.apply(() => ops);
    });
  },
  autofit() { const { at, n } = this.cols(); this.autofitCols(at, at + n - 1); },
  autofitRow() { const { at, n } = this.rows(); this.autofitRows(at, at + n - 1); },

  // 清除
  clearContent() { const s = this.rect; this.apply(() => clearOps(this.model, s, 'content', this.g._filterSkip(s) ?? undefined)); },
  clearFormat() { const s = this.rect; this.apply(() => clearOps(this.model, s, 'format', this.g._filterSkip(s) ?? undefined)); },
  clearAll() { const s = this.rect; this.apply(() => [...clearOps(this.model, s, 'all', this.g._filterSkip(s) ?? undefined), ...this.clearNotes(), ...this.clearFiles()]); },
  clearFiles() { this.apply(() => this.clearFiles()); },
  clearNotes() { this.apply(() => this.clearNotes()); },
  clearValidation() { this.clearValidation(); },
  clearSheet() { return this.clearSheet(); },

  // 填充
  fillDown() { const s = this.rect; this.apply(() => fillDownOps(this.model, s, 'down')); },
  fillRight() { const s = this.rect; this.apply(() => fillDownOps(this.model, s, 'right')); },
  fillToEnd() { this.fillToEnd(); },

  // 排序与筛选
  sortAsc() { return this.sortQuick(false); },
  sortDesc() { return this.sortQuick(true); },
  sortDialog() {
    if (!this.g._canEdit()) return;
    const s = this.g.sel.rect;
    const region = s.r0 === s.r1 && s.c0 === s.c1 ? this.region() : clipRect(this.model, s);
    D.sort(this.g, region, this.looksLikeHeader(region), (keys, header) => this.apply(() => sortOps(this.model, this.g.calc, region, keys, header)));
  },
  toggleFilter() { this.toggleFilter(); },
  clearFilter() {
    const f = this.model.props.filter;
    if (f) this.apply(() => [{ t: 'setProp', key: 'filter', value: { ...f, crit: {} } }]);
  },

  // 数据工具
  splitText() { if (this.g._canEdit()) D.splitText(this.g, clipRect(this.model, this.rect)); },
  dedupe() {
    if (!this.g._canEdit()) return;
    const s = this.g.sel.rect;
    const region = s.r0 === s.r1 && s.c0 === s.c1 ? this.region() : clipRect(this.model, s);
    D.dedupe(this.g, region, this.looksLikeHeader(region));
  },
  validation() { if (this.g._canEdit()) D.validation(this.g, clipRect(this.model, this.rect), (rule) => this.apply(() => this.addValidation(rule))); },
  toValues() { const s = this.rect; this.apply(() => toValuesOps(this.model, this.g.calc, s)); },
  upper() { const s = this.rect; this.apply(() => textTransformOps(this.model, s, 'upper')); },
  lower() { const s = this.rect; this.apply(() => textTransformOps(this.model, s, 'lower')); },
  trim() { const s = this.rect; this.apply(() => textTransformOps(this.model, s, 'trim')); },
  proper() { const s = this.rect; this.apply(() => textTransformOps(this.model, s, 'proper')); },
  find() { D.findReplace(this.g, 'find'); },
  replace() { D.findReplace(this.g, this.g._canEdit() ? 'replace' : 'find'); },
  selectRegion() { this.selectRect(this.region()); },

  // 公式
  insertFunction(name) { if (this.g._canEdit()) D.insertFunction(this.g, name); },
  autoSum(fn) { if (this.g._canEdit()) this.autoSum(fn || 'SUM'); },
  sum() { if (this.g._canEdit()) this.autoSum('SUM'); },
  avg() { if (this.g._canEdit()) this.autoSum('AVERAGE'); },
  count() { if (this.g._canEdit()) this.autoSum('COUNT'); },
  max() { if (this.g._canEdit()) this.autoSum('MAX'); },
  min() { if (this.g._canEdit()) this.autoSum('MIN'); },
  recalc() { this.g.calc.invalidate(); this.g._paint(); this.status(tt('已重新计算')); },
  help() { window.open('/help', '_blank', 'noopener'); },
  // AI 只预留了接口（见 js/ai/index.js）；服务端启用前按钮是灰的，这里兜底提示一句
  async ai() {
    const ai = await getAI();
    if (!ai.enabled) return alertDialog(tt('AI 助手'), tt('AI 功能即将推出，接口已经预留好了。'));
    return alertDialog(tt('AI 助手'), tt('AI 已启用，具体功能还在开发中。'));
  },

  // 插入
  insertDate() { const { r, c } = this.active; this.apply(() => [{ t: 'setCell', r, c, v: today() }]); },
  insertTime() { const { r, c } = this.active; this.apply(() => [{ t: 'setCell', r, c, v: today() + ' ' + nowTime() }]); },
  insertNote() {
    if (!this.g._canEdit()) return;
    const { r, c } = this.active;
    D.note(this.g, r, c, this.g.calc.noteAt(r, c) ?? '', (text) => this.setNoteText(r, c, text));
  },
  deleteNote() { const { r, c } = this.active; this.setNoteText(r, c, ''); },
  insertFile() { this.pickFiles(); },
  viewFiles() { this.viewFiles(); },
  insertChart(type) { if (this.g._canEdit()) D.chart(this.g, type || 'column'); },
  insertPivot() {
    if (!this.g._canEdit()) return;
    const list = this.pivots();
    if (list.length >= MAX_PIVOTS) {
      return alertDialog(tt('插入透视表'), tt('每张表最多 {n} 个透视表。可以先删掉不用的，或者在已有透视表里点「字段设置」修改。', { n: MAX_PIVOTS }));
    }
    D.pivot(this.g, null, nextPivotName(list), (spec) => {
      const cur = this.pivots();
      if (cur.length >= MAX_PIVOTS) return;
      const id = 'pv' + Date.now().toString(36);
      const name = cleanPivotName(spec.name) || nextPivotName(cur);
      this.g.exec([{ t: 'setProp', key: 'pivots', value: [...cur, { ...spec, id, name }] }]);
      void this.g.setView('pivot:' + id);
    });
  },
  editPivot(id) {
    const p = this.pivots().find((x) => x.id === id);
    if (!p || !this.g._canEdit()) return;
    D.pivot(this.g, p, p.name, (spec) => {
      const name = cleanPivotName(spec.name) || p.name;
      this.g.exec([{ t: 'setProp', key: 'pivots', value: this.pivots().map((x) => (x.id === id ? { ...x, ...spec, name } : x)) }]);
    });
  },
  renamePivot(id) {
    const p = this.pivots().find((x) => x.id === id);
    if (!p || !this.g._canEdit()) return;
    D.renamePivot(p.name, (raw) => {
      const name = cleanPivotName(raw);
      if (name) this.g.exec([{ t: 'setProp', key: 'pivots', value: this.pivots().map((x) => (x.id === id ? { ...x, name } : x)) }]);
    });
  },
  async deletePivot(id) {
    const p = this.pivots().find((x) => x.id === id);
    if (!p || !this.g._canEdit()) return;
    if (!(await confirmDialog(tt('删除透视表'), tt('删除「{name}」？表格里的数据不受影响，可以撤销。', { name: p.name }), { ok: tt('删除'), danger: true }))) return;
    const rest = this.pivots().filter((x) => x.id !== id);
    this.g.exec([{ t: 'setProp', key: 'pivots', value: rest.length ? rest : null }]);
  },
  insertCheckbox() { this.insertCheckbox(); },
  insertDropdown() {
    if (!this.g._canEdit()) return;
    D.validation(this.g, clipRect(this.model, this.rect), (rule) => this.apply(() => this.addValidation(rule)), 'list');
  },
  insertCascade() {
    if (!this.g._canEdit()) return;
    D.validation(this.g, clipRect(this.model, this.rect), (rule) => this.apply(() => this.addValidation(rule)), 'cascade');
  },

  // 冻结
  freeze() { this.g._toggleFreeze(); },
  freezeRow() { this.g.freezeAt(1, 0); },
  freezeCol() { this.g.freezeAt(0, 1); },
  freezeHere() { const { r, c } = this.active; this.g.freezeAt(r, c); },
  unfreeze() { this.g.freezeAt(0, 0); },

  // 视图
  gridlines() { this.apply(() => [{ t: 'setProp', key: 'gridlines', value: this.model.props.gridlines === false ? null : false }]); },
  showFormulas() {
    const calc = this.g.calc;
    calc.showFormulas = !calc.showFormulas;
    calc.invalidate();
    this.g._paint();
  },
  demo(n) {
    if (this.g.sync) { this.status(tt('协作表格里不能生成示例数据（会覆盖所有人的内容）'), 'error'); return; }
    this.g.loadDemo(n || 100000);
  },
  openListPicker() { this.openListPicker(); },
  toggleCheckbox() { if (this.g._canEdit()) this.toggleCheckbox(); },

  // 文件
  exportCsv() { return this.exportFile('csv'); },
  exportXlsx() { return this.exportFile('xlsx'); },
  importFile() { this.importFile(); },
};

/** 插入 / 删除对话框的选择 → 具体动作。 */
Commands.prototype.runShift = function (kind, insert) {
  if (kind === 'row') this.structural(insert ? 'insertRowsAbove' : 'deleteRows');
  else if (kind === 'col') this.structural(insert ? 'insertColsLeft' : 'deleteCols');
  else this.shiftCells(kind === 'down' ? 'down' : 'right', insert);
};

/** 最后一个有内容或格式的行号（没有则 -1）。 */
export function lastRow(model) {
  let max = -1;
  for (const k of model.cells.keys()) { const r = +k.slice(0, k.indexOf(':')); if (r > max) max = r; }
  for (const k of model.formats.keys()) { const r = +k.slice(0, k.indexOf(':')); if (r > max) max = r; }
  return max;
}

export function lastCol(model) {
  let max = -1;
  for (const k of model.cells.keys()) { const c = +k.slice(k.indexOf(':') + 1); if (c > max) max = c; }
  for (const k of model.formats.keys()) { const c = +k.slice(k.indexOf(':') + 1); if (c > max) max = c; }
  return max;
}

function inRect(range, r, c) { return !!range && r >= range[0] && r <= range[2] && c >= range[1] && c <= range[3]; }
function overlaps(range, s) { return !!range && range[0] <= s.r1 && range[2] >= s.r0 && range[1] <= s.c1 && range[3] >= s.c0; }
function sameRange(a, b) { return !!a && !!b && a.every((v, i) => v === b[i]); }

function pad(n) { return String(n).padStart(2, '0'); }
function today() { const d = new Date(); return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); }
function nowTime() { const d = new Date(); return pad(d.getHours()) + ':' + pad(d.getMinutes()); }

/** 触发浏览器下载。 */
export function download(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}
