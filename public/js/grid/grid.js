/**
 * 网格控件总装：model / calc / viewport / renderer / selection / editor 接起来，
 * 外加 Excel 式的功能区、公式栏、右键菜单、撤销栈，以及看板 / 仪表盘 / 透视表视图。
 *
 * 结构上有一个刻意的选择：滚动交给浏览器原生实现。
 * Canvas 铺在底层不滚动，上面盖一个透明的 overflow:auto 容器，里面只有一个撑开尺寸的空 div。
 * 滚动事件一到就把 scrollLeft/scrollTop 抄进 viewport 再重画。
 *
 * 所有写入都走 exec(ops)：它应用 op、记下逆 op 进撤销栈，sync 再把 local op 发给 DO。
 * 功能区 / 菜单 / 快捷键只负责"算出 op"（见 actions.js 与 commands.js），不直接碰模型。
 */

import { GridModel } from './model.js';
import { Calc } from './calc.js';
import { ExtRefs } from './extrefs.js';
import { Viewport } from './viewport.js';
import { GridRenderer, hashHue } from './renderer.js';
import { Selection } from './selection.js';
import { CellEditor } from './editor.js';
import { serializeRange, readClipboard, parseTsv } from './clipboard.js';
import { captureBlock, pasteBlockOps, clearOps } from './actions.js';
import { Commands } from './commands.js';
import { Ribbon } from './ribbon.js';
import { FormulaAssist } from './assist.js';
import { ChartLayer } from './chart.js';
import { openCellMenu, openHeaderMenu } from './menus.js';
import { cellRef, rangeName, parseRange, parseRef } from '../../shared/util/a1.js';
import { isStructural } from '../../shared/model/ops.js';
import { h } from '../ui/dom.js';
import { t as tt } from '../../shared/i18n/i18n.js';

const RESIZE_GRAB = 4;         // 列宽 / 行高拖拽的命中半径（px）
const MAX_PASTE_CELLS = 200000;
const UNDO_MAX = 100;
/** 粗筛：可能含跨表引用的公式，细的交给 extRefsIn */
const EXT_HINT = /tbl_|IMPORTRANGE/i;
export const NO_COPY_MSG = tt('这是公开只读链接：不能复制或导出');

export class Grid {
  /**
   * @param {HTMLElement} host 挂载点，内容会被替换
   * @param {{name?:string, tableId?:string, rows?:number, cols?:number, onStatus?:(s:string, kind?:string)=>void, extPath?:string, noCopy?:boolean}} [opts]
   *   tableId 有值时启用跨表引用（=tbl_xxx!A1、IMPORTRANGE）
   *   noCopy 公开只读链接：不许复制、导出（只能劝阻，挡不住截图）
   */
  constructor(host, opts = {}) {
    this.model = new GridModel({ rows: opts.rows ?? 500, cols: opts.cols ?? 26 });
    /** @type {ExtRefs | null} */ this.ext = opts.tableId ? new ExtRefs(opts.tableId, {
      onChange: () => this._onExt(),
      onError: (msg) => this.opts.onStatus?.(msg, 'error'),
    }, opts.extPath) : null;
    const ext = this.ext;
    this.calc = new Calc(this.model, ext ? { tableId: opts.tableId, ext: (t, r) => ext.get(t, r) } : {});
    this.vp = new Viewport(this.model);
    this.vp.hiddenRowsFn = () => this.calc.filteredRows();
    this.sel = new Selection();
    this.opts = opts;
    /** @type {import('../core/sync.js').SyncEngine | null} */ this.sync = null;
    /** 只读（viewer 角色或移动端）时所有写入路径都要被挡住。 */ this.readonly = false;
    /** 公开只读链接：复制、剪切、导出一律不给。 */ this.noCopy = !!opts.noCopy;
    this.mobile = isMobile();
    /** @type {Map<string, {id:string, email:string, name:string, role:string}>} 在线的人（含自己） */ this._peerInfo = new Map();
    this._drag = /** @type {any} */ (null);
    /** @type {{fwd:any[], back:any[], sel:any}[]} */ this._undo = [];
    /** @type {{fwd:any[], back:any[], sel:any}[]} */ this._redo = [];
    /** 内部剪贴板：带格式与公式源位置，粘回本表时比纯文本更完整。 */ this._clip = null;
    /** 格式刷：{block, sticky} */ this.painter = null;
    this.view = 'grid';
    /** 被分享时限定的可见视图；null = 不限 */ this.scope = /** @type {string[] | null} */ (null);

    this._buildDom(host, opts.name ?? tt('未命名表'));
    this.renderer = new GridRenderer(this.canvas, this.model, this.vp, this.sel, this.calc);
    this.editor = new CellEditor(this.layer, {
      onCommit: (v, move) => this._commitEdit(v, move),
      onCancel: () => this._endEdit(),
      onKey: (e) => this.assist.key(e),
      onInput: (v) => { this.fx.value = v; this.assist.update(this.editor.el); },
      keepOnBlur: (e) => this._picking || e.relatedTarget === this.fx || this.assist.owns(e.relatedTarget),
    });
    this.cmd = new Commands(this);
    this.assist = new FormulaAssist(this);
    this.ribbon = new Ribbon(this, this.ribbonHost);
    this.charts = new ChartLayer(this, this.chartHost);

    this._unsub = this.model.subscribe((ops, meta) => this._onModel(ops, meta));
    this._syncPivotTabs();
    this._wire();
    this._measure();
    this._syncSizer();
    this._paint();
    if (this.mobile) this.setReadonlyReason(tt('移动端为只读模式，请在电脑上编辑'));
  }

  // ── DOM ───────────────────────────────────────────────────────────────

  _buildDom(host, name) {
    host.replaceChildren();
    this.nameEl = h('div', { class: 'grid__name', text: name });
    this.viewTabs = h('div', { class: 'grid__views', attrs: { role: 'tablist' } },
      [['grid', tt('表格')], ['kanban', tt('看板')], ['dashboard', tt('仪表盘')]].map(([v, label]) =>
        h('button', { class: 'grid__view-tab', type: 'button', text: label, dataset: { view: v },
          attrs: { 'aria-selected': String(v === 'grid') }, onclick: () => this.setView(v) })));
    this.note = h('span', { class: 'grid__note', text: tt('离线网格：数据只在本页，刷新即失'),
      title: tt('接入实时同步后，改动会立即保存到 Cloudflare 并同步给协作者。') });
    const bar = h('div', { class: 'grid__toolbar' }, this.nameEl, this.viewTabs,
      h('div', { class: 'grid__spacer' }), this.note);

    this.ribbonHost = h('div', { class: 'rb' });

    // 公式栏：名称框（可输入地址跳转）+ fx + 编辑框
    this.addr = h('input', { class: 'fbar__addr', type: 'text', spellcheck: false, value: 'A1',
      attrs: { 'aria-label': tt('名称框') } });
    this.addr.textContent = 'A1';
    this.fxBtn = h('button', { class: 'fbar__fx', type: 'button', text: 'fx', title: tt('插入函数'),
      onclick: () => this.cmd.run('insertFunction') });
    this.fx = h('textarea', { class: 'fbar__input', rows: 1, spellcheck: false,
      attrs: { 'aria-label': tt('编辑栏') } });
    const fbar = this.fbar = h('div', { class: 'fbar' }, this.addr, this.fxBtn, this.fx);

    this.canvas = h('canvas', { class: 'grid__canvas' });
    this.sizer = h('div', { class: 'grid__sizer' });
    this.scroll = h('div', { class: 'grid__scroll' }, this.sizer);
    this.scroll.tabIndex = 0;
    this.chartHost = h('div', { class: 'grid__charts' });
    this.layer = h('div', { class: 'grid__layer' });
    this.stage = h('div', { class: 'grid__stage' }, this.canvas, this.scroll, this.chartHost, this.layer);
    // tabindex 让点在视图空白处时焦点落到这里，看板 / 透视表 / 仪表盘里也能 Ctrl+Z / Ctrl+Y（它们的改动同样进撤销栈）
    this.viewHost = h('div', { class: 'grid__view', tabindex: '-1' });
    this.viewHost.hidden = true;
    this.viewHost.addEventListener('keydown', (e) => {
      if (!(e.ctrlKey || e.metaKey) || e.altKey) return;
      const t = /** @type {HTMLElement} */ (e.target);
      if (t.closest('input, textarea, select, [contenteditable="true"]')) return;
      const k = e.key.toLowerCase();
      if (k === 'z' && !e.shiftKey) { e.preventDefault(); this.undo(); }
      else if (k === 'y' || (k === 'z' && e.shiftKey)) { e.preventDefault(); this.redo(); }
    });
    this.body = h('div', { class: 'grid__body' }, this.stage, this.viewHost);

    this.statConn = h('div', { class: 'grid__conn' });
    this.statSel = h('div', { class: 'grid__stat' });
    this.statSum = h('div', { class: 'grid__stat' });
    this.statSize = h('div', { class: 'grid__stat' });
    this.zoomNote = h('div', { class: 'grid__stat grid__ro' });
    this.zoomNote.hidden = true;
    const status = h('div', { class: 'grid__status' }, this.statConn, this.statSel, this.statSum,
      h('div', { class: 'grid__spacer' }), this.zoomNote, this.statSize);

    this.root = h('div', { class: 'grid' + (this.mobile ? ' grid--mobile' : '') }, bar, this.ribbonHost, fbar, this.body, status);
    host.append(this.root);
  }

  // ── 事件 ──────────────────────────────────────────────────────────────

  _wire() {
    this.scroll.addEventListener('scroll', () => {
      this.vp.scrollX = this.scroll.scrollLeft;
      this.vp.scrollY = this.scroll.scrollTop;
      if (this.editor.open) this.editor.place(this._editRect());
      this.charts.position();
      this.renderer.schedule();
    }, { passive: true });

    this.scroll.addEventListener('pointerdown', (e) => this._pointerDown(e));
    this.scroll.addEventListener('mousedown', (e) => { if (this._picking) e.preventDefault(); });
    this.scroll.addEventListener('pointermove', (e) => this._pointerMove(e));
    this.scroll.addEventListener('pointerup', (e) => this._pointerUp(e));
    this.scroll.addEventListener('dblclick', (e) => this._dblclick(e));
    this.scroll.addEventListener('contextmenu', (e) => this._contextMenu(e));
    this.scroll.addEventListener('keydown', (e) => this._keydown(e));
    this.scroll.addEventListener('copy', (e) => this._copy(e));
    this.scroll.addEventListener('cut', (e) => this._copy(e, true));
    this.scroll.addEventListener('paste', (e) => this._paste(e));
    // 把文件拖到单元格上 = 作为附件上传到那一格
    this.scroll.addEventListener('dragover', (e) => {
      if (!e.dataTransfer?.types?.includes('Files') || this.readonly) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
    });
    this.scroll.addEventListener('drop', (e) => {
      const list = [...(e.dataTransfer?.files ?? [])];
      if (!list.length) return;
      e.preventDefault();
      if (!this._canEdit()) return;
      const { x, y } = this._pos(e);
      const hit = this.vp.hit(x, y);
      if (hit.row < 0 || hit.col < 0) return;
      const m = this.calc.mergeAt(hit.row, hit.col);
      const r = m ? m[0] : hit.row, c = m ? m[1] : hit.col;
      this._select(r, c);
      this._paint();
      void this.cmd.uploadFiles(list, r, c);
    });

    // 名称框：输入 B7 / A1:C9 回车跳转
    this.addr.addEventListener('focus', () => this.addr.select?.());
    this.addr.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { this._status(); this.scroll.focus({ preventScroll: true }); return; }
      if (e.key !== 'Enter') return;
      e.preventDefault();
      this.goto(this.addr.value);
    });

    // 编辑栏：聚焦即进入编辑（不抢单元格编辑器的焦点，两边内容实时互相镜像）
    this.fx.addEventListener('focus', () => {
      if (this.readonly) { this.fx.blur(); return; }
      if (!this.editor.open) this._beginEdit(true, undefined, false);
      this.assist.update(this.fx);
    });
    this.fx.addEventListener('input', () => {
      if (!this.editor.open) this._beginEdit(true, undefined, false);
      this.editor.el.value = this.fx.value;
      this.editor._autoGrow();
      this.assist.update(this.fx);
    });
    this.fx.addEventListener('keydown', (e) => {
      if (this.assist.key(e)) return;
      if (e.key === 'Enter' && !e.altKey) { e.preventDefault(); this.editor.commit(e.shiftKey ? 'up' : 'down'); }
      else if (e.key === 'Escape') { e.preventDefault(); this.editor.cancel(); }
      else if (e.key === 'Tab') { e.preventDefault(); this.editor.commit(e.shiftKey ? 'left' : 'right'); }
    });
    this.fx.addEventListener('blur', (e) => {
      if (!this.editor.open || this._picking) return;
      const to = /** @type {any} */ (e).relatedTarget;
      if (to === this.editor.el || this.assist.owns(to)) return;
      this.editor.commit('none');
    });

    this._ro = new ResizeObserver(() => { this._measure(); this._paint(); this.charts.position(); });
    this._ro.observe(this.stage);

    this._mq = window.matchMedia('(prefers-color-scheme: dark)');
    this._onTheme = () => { this.renderer.refreshTheme(); this.renderer.schedule(); this.charts.refresh(); };
    this._mq.addEventListener('change', this._onTheme);
    // 换了主题配色（js/core/theme.js）
    window.addEventListener('themechange', this._onTheme);
  }

  /** 表改名后更新工具栏上的名字（正在原地编辑时不打断）。 @param {string} name */
  setName(name) {
    if (!this.nameEl.querySelector('input')) this.nameEl.textContent = name;
  }

  destroy() {
    this._ro?.disconnect();
    this._mq?.removeEventListener('change', this._onTheme);
    window.removeEventListener('themechange', this._onTheme);
    this._unsub?.();
    this.ext?.dispose();
    this.assist?.close();
    this.view3?.destroy?.();
  }

  _measure() {
    const r = this.stage.getBoundingClientRect();
    this.renderer.resize(Math.max(1, r.width), Math.max(1, r.height));
  }

  /** 滚动容器里那个空 div 的尺寸，决定了能滚多远。 */
  _syncSizer() {
    this.vp.sync();
    this.sizer.style.width = (this.vp.headerW + this.vp.cols.total()) + 'px';
    this.sizer.style.height = (this.vp.headerH + this.vp.rows.total()) + 'px';
  }

  /** 模型的任何变化（本地或远端）都从这里进来。 */
  /** 跨表取回的值变了：值不在 model 里，版本号不会动，只能强制作废再画。 */
  _onExt() {
    this.calc.invalidate();
    this._paint();
    this.charts.refresh();
    if (this.view !== 'grid') this._refreshView();
  }

  /** 本地写进去的公式里有外表引用：登记到服务端（粘贴、填充、导入都走这里）。 @param {any[]} ops */
  _registerExt(ops) {
    /** @type {string[]} */ const fs = [];
    const take = (/** @type {any} */ v) => {
      if (typeof v === 'string' && v.charCodeAt(0) === 61 && EXT_HINT.test(v)) fs.push(v);
    };
    for (const o of ops) {
      if (o.t === 'setCell') take(o.v);
      else if (o.t === 'setCells' && Array.isArray(o.cells)) for (const c of o.cells) take(c?.[2]);
    }
    if (fs.length) void this.ext?.register(fs);
  }

  _onModel(ops, meta) {
    if (meta.local && this.ext) this._registerExt(ops);
    if (!meta.local && ops.some((o) => o.t === 'bulk' || o.t === 'clearAll' || isStructural(o))) {
      // 别人改了结构或整表重载：我手里的逆 op 坐标已经失效，撤销只会写错地方
      this._undo.length = 0;
      this._redo.length = 0;
    }
    if (ops.some((o) => o.t === 'bulk' || isStructural(o) || o.t === 'setRowCount' || o.t === 'setColCount')) {
      this._clampSel();
    }
    this._syncSizer();
    this._paint();
    this.charts.refresh();
    if (ops.some((o) => o.t === 'bulk' || o.t === 'clearAll' || (o.t === 'setProp' && o.key === 'pivots'))) this._syncPivotTabs();
    if (this.view !== 'grid') this._refreshView();
  }

  _clampSel() {
    const R = this.model.rowCount - 1, C = this.model.colCount - 1;
    const s = this.sel;
    for (const p of [s.anchor, s.focus, s.cursor]) { p.r = Math.min(p.r, R); p.c = Math.min(p.c, C); }
  }

  /** 把画布坐标从事件里算出来（滚动容器与画布完全重合，所以共用一个 rect）。 */
  _pos(e) {
    const r = this.canvas.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  /** 指针是不是停在某条列分隔线上（用于拖拽调宽）。 @returns {number} 列号，-1 表示否 */
  _resizeTarget(x, y) {
    const vp = this.vp;
    if (y >= vp.headerH || x < vp.headerW) return -1;
    const v = vp.visible();
    const test = (c) => { const box = vp.cellRect(0, c); return box.w > 0 && Math.abs(x - (box.x + box.w)) <= RESIZE_GRAB; };
    for (let c = vp.frozenCols - 1; c >= 0; c--) if (test(c)) return c;
    for (let c = v.c1; c >= Math.max(0, v.c0 - 1); c--) if (test(c)) return c;
    return -1;
  }

  /** 行头下边缘（拖拽调行高）。 */
  _rowResizeTarget(x, y) {
    const vp = this.vp;
    if (x >= vp.headerW || y < vp.headerH) return -1;
    const v = vp.visible();
    const test = (r) => { const box = vp.cellRect(r, 0); return box.h > 0 && Math.abs(y - (box.y + box.h)) <= 3; };
    for (let r = vp.frozenRows - 1; r >= 0; r--) if (test(r)) return r;
    for (let r = v.r1; r >= Math.max(0, v.r0 - 1); r--) if (test(r)) return r;
    return -1;
  }

  /** 所有会改数据的入口都先过这道闸。viewer 角色一个字也写不进去。 */
  _canEdit() {
    if (!this.readonly) return true;
    this.opts.onStatus?.(this._roReason || tt('只读权限，无法编辑这张表'), 'error');
    return false;
  }

  /** 移动端 / viewer 的只读提示。 */
  setReadonlyReason(msg) {
    this._roReason = msg;
    this.readonly = true;
    this.zoomNote.textContent = msg;
    this.zoomNote.hidden = false;
    this.ribbon?.refresh();
  }

  _pointerDown(e) {
    if (e.button !== 0) return;
    const { x, y } = this._pos(e);
    const hit = this.vp.hit(x, y);

    // 公式编辑中点格子 = 插入引用，而不是提交；点列标插入整列（A:A），点行号插入整行（1:1）
    const pickMode = hit.inColHeader && hit.inRowHeader ? null
      : hit.inColHeader ? 'col' : hit.inRowHeader ? 'row' : 'cell';
    if (this.editor.open && pickMode && this.assist.canPick()) {
      e.preventDefault();
      this._picking = true;
      const r = Math.max(0, hit.row), c = Math.max(0, hit.col);
      this._drag = { kind: 'ref', r, c, mode: pickMode };
      this.assist.pick(r, c, r, c, pickMode);
      this.scroll.setPointerCapture?.(e.pointerId);
      return;
    }

    this.scroll.focus({ preventScroll: true });
    this.assist.close();

    const rc = this._resizeTarget(x, y);
    if (rc >= 0 && this._canEdit()) {
      this._drag = { kind: 'resize', col: rc, x0: e.clientX, w0: this.model.colWidth(rc), back: null };
      this.scroll.setPointerCapture(e.pointerId);
      e.preventDefault();
      return;
    }
    const rr = this._rowResizeTarget(x, y);
    if (rr >= 0 && this._canEdit()) {
      this._drag = { kind: 'rowResize', row: rr, y0: e.clientY, h0: this.model.rowHeight(rr), back: null };
      this.scroll.setPointerCapture(e.pointerId);
      e.preventDefault();
      return;
    }

    if (this.editor.open) this.editor.commit('none');

    // 填充柄 / 下拉按钮 / 筛选按钮：它们都画在 Canvas 上，命中要自己判断
    if (inBox(this.renderer.handleRect, x, y) && !this.readonly) {
      this._drag = { kind: 'fill', src: this.calc.expandRect(this.sel.rect), target: null };
      this.scroll.setPointerCapture(e.pointerId);
      return;
    }
    if (inBox(this.renderer.listBtnRect, x, y)) { this.cmd.run('openListPicker'); return; }
    const fh = this.renderer.fileHitAt(x, y);
    if (fh && !e.shiftKey) { this._select(fh.r, fh.c); this._paint(); this.cmd.run('viewFiles'); return; }
    const fb = this._filterBtnAt(x, y);
    if (fb >= 0) { this.cmd.filterMenu(fb, e.clientX, e.clientY); return; }

    if (hit.inColHeader && hit.inRowHeader) {
      this.sel.set(0, 0);
      this.sel.extendTo(this.model.rowCount - 1, this.model.colCount - 1);
    } else if (hit.inColHeader) {
      const c = hit.col < 0 ? 0 : hit.col;
      // Shift+点列标：锚点挪到第 0 行，否则从普通单元格出发时选不成整列
      if (e.shiftKey) { this.sel.anchor = { r: 0, c: this.sel.anchor.c }; this.sel.mode = 'col'; this.sel.extendTo(this.model.rowCount - 1, c); }
      else { this.sel.set(0, c, 'col'); this.sel.extendTo(this.model.rowCount - 1, c); }
      this._drag = { kind: 'colSel' };
      this.scroll.setPointerCapture(e.pointerId);
    } else if (hit.inRowHeader) {
      const r = hit.row < 0 ? 0 : hit.row;
      if (e.shiftKey) { this.sel.anchor = { r: this.sel.anchor.r, c: 0 }; this.sel.mode = 'row'; this.sel.extendTo(r, this.model.colCount - 1); }
      else { this.sel.set(r, 0, 'row'); this.sel.extendTo(r, this.model.colCount - 1); }
      this._drag = { kind: 'rowSel' };
      this.scroll.setPointerCapture(e.pointerId);
    } else {
      if (e.shiftKey) this._extend(hit.row, hit.col);
      else this._select(hit.row, hit.col);
      // 复选框：点中即切换
      const rule = this.calc.validationAt(hit.row, hit.col);
      if (rule?.type === 'checkbox' && !e.shiftKey && !this.readonly) this.cmd.run('toggleCheckbox');
      this._drag = { kind: 'select' };
      this.scroll.setPointerCapture(e.pointerId);
    }
    this._paint();
  }

  _filterBtnAt(x, y) {
    const f = this.model.props.filter;
    if (!f?.range) return -1;
    const [r, c0, , c1] = f.range;
    for (let c = c0; c <= c1; c++) if (!this.vp.colHidden(c) && inBox(this.renderer.filterBtnRect(r, c), x, y)) return c;
    return -1;
  }

  /** 选中一格；落在合并区域里就选中整块，活动单元格停在左上角。 */
  _select(r, c) {
    const m = this.calc.mergeAt(r, c);
    this.sel.set(r, c);
    if (m) { this.sel.set(m[0], m[1]); this.sel.extendTo(m[2], m[3]); }
  }

  _extend(r, c) {
    this.sel.extendTo(r, c);
  }

  _pointerMove(e) {
    const { x, y } = this._pos(e);
    const d = this._drag;
    if (!d) {
      let cur = 'cell';
      if (this._resizeTarget(x, y) >= 0) cur = 'col-resize';
      else if (this._rowResizeTarget(x, y) >= 0) cur = 'row-resize';
      else if (inBox(this.renderer.handleRect, x, y)) cur = 'crosshair';
      else if (this.renderer.fileHitAt(x, y)) cur = 'pointer';
      else if (this.painter) cur = 'copy';
      this.scroll.style.cursor = cur;
      // 批注：鼠标停在有批注的格子上时用原生提示显示内容
      const at = this.vp.hit(x, y);
      const note = at.row >= 0 && at.col >= 0 ? this.calc.noteAt(at.row, at.col) ?? '' : '';
      if (this.scroll.title !== note) this.scroll.title = note;
      return;
    }
    if (d.kind === 'resize') {
      const back = this.model.apply([{ t: 'resizeField', c: d.col, w: d.w0 + (e.clientX - d.x0) }]);
      if (!d.back && back.length) d.back = back;
      return;
    }
    if (d.kind === 'rowResize') {
      const back = this.model.apply([{ t: 'setRowHeight', r: d.row, h: d.h0 + (e.clientY - d.y0) }]);
      if (!d.back) d.back = back;
      return;
    }
    const hit = this.vp.hit(x, y);
    const r = Math.max(0, hit.row), c = Math.max(0, hit.col);
    if (d.kind === 'ref') { this.assist.pick(d.r, d.c, r, c, d.mode); return; }
    if (d.kind === 'fill') {
      const s = d.src;
      const dr = r > s.r1 ? r - s.r1 : r < s.r0 ? r - s.r0 : 0;
      const dc = c > s.c1 ? c - s.c1 : c < s.c0 ? c - s.c0 : 0;
      let t = null;
      if (dr && Math.abs(dr) >= Math.abs(dc)) t = dr > 0 ? { ...s, r1: r } : { ...s, r0: r };
      else if (dc) t = dc > 0 ? { ...s, c1: c } : { ...s, c0: c };
      d.target = t;
      this.renderer.fillPreview = t;
      this.renderer.schedule();
      return;
    }
    if (d.kind === 'colSel') { if (hit.col >= 0) this.sel.extendTo(this.model.rowCount - 1, hit.col); }
    else if (d.kind === 'rowSel') { if (hit.row >= 0) this.sel.extendTo(hit.row, this.model.colCount - 1); }
    else if (hit.row >= 0 && hit.col >= 0) this._extend(hit.row, hit.col);
    this._paint();
  }

  _pointerUp(e) {
    const d = this._drag;
    if (!d) return;
    this._drag = null;
    try { this.scroll.releasePointerCapture(e.pointerId); } catch (err) { void err; }
    if (d.kind === 'ref') {
      this._picking = false;
      this.assist.refocus();
      return;
    }
    if ((d.kind === 'resize' || d.kind === 'rowResize') && d.back) {
      // 拖拽中每帧直接 apply 跟手；松开时把整段拖拽记成一步撤销
      const fwd = d.kind === 'resize'
        ? [{ t: 'resizeField', c: d.col, w: this.model.colWidth(d.col) }]
        : [{ t: 'setRowHeight', r: d.row, h: this.model.rowHeight(d.row) }];
      this._pushUndo(fwd, d.back);
      return;
    }
    if (d.kind === 'fill') {
      this.renderer.fillPreview = null;
      if (d.target) this.cmd.fill(d.src, d.target);
      this.renderer.schedule();
      return;
    }
    if (this.painter && d.kind === 'select') this.cmd.applyPainter();
  }

  _dblclick(e) {
    const { x, y } = this._pos(e);
    const rc = this._resizeTarget(x, y);
    if (rc >= 0) { this.cmd.autofitCols(rc, rc); return; }
    const rr = this._rowResizeTarget(x, y);
    if (rr >= 0) { this.cmd.autofitRows(rr, rr); return; }
    if (inBox(this.renderer.handleRect, x, y)) { this.cmd.run('fillToEnd'); return; }
    const hit = this.vp.hit(x, y);
    if (hit.row < 0 || hit.col < 0) return;
    this._select(hit.row, hit.col);
    if (this._canEdit()) this._beginEdit(true);
  }

  _contextMenu(e) {
    e.preventDefault();
    if (this.editor.open) this.editor.commit('none');
    const { x, y } = this._pos(e);
    const hit = this.vp.hit(x, y);
    const at = { x: e.clientX, y: e.clientY };
    const s = this.sel.rect;
    const R = this.model.rowCount - 1, C = this.model.colCount - 1;
    if (hit.inColHeader && hit.inRowHeader) return;
    if (hit.inColHeader) {
      const whole = s.r0 === 0 && s.r1 === R && hit.col >= s.c0 && hit.col <= s.c1;
      if (!whole) { this.sel.set(0, hit.col, 'col'); this.sel.extendTo(R, hit.col); }
      this._paint();
      openHeaderMenu(this, 'col', at);
      return;
    }
    if (hit.inRowHeader) {
      const whole = s.c0 === 0 && s.c1 === C && hit.row >= s.r0 && hit.row <= s.r1;
      if (!whole) { this.sel.set(hit.row, 0, 'row'); this.sel.extendTo(hit.row, C); }
      this._paint();
      openHeaderMenu(this, 'row', at);
      return;
    }
    if (!this.sel.contains(hit.row, hit.col)) this._select(hit.row, hit.col);
    this._paint();
    openCellMenu(this, at);
  }

  // ── 键盘 ──────────────────────────────────────────────────────────────

  _keydown(e) {
    if (this.editor.open) return;
    const sel = this.sel;
    const bounds = { rows: this.model.rowCount, cols: this.model.colCount };
    const ctrl = e.ctrlKey || e.metaKey;
    const k = e.key.length === 1 ? e.key.toLowerCase() : e.key;

    // 快捷键先行：和 Excel 保持一致
    if (ctrl && !e.altKey) {
      const map = {
        z: e.shiftKey ? 'redo' : 'undo', y: 'redo', b: 'bold', i: 'italic', u: 'underline', '5': 'strike',
        '1': 'formatCells', f: 'find', h: 'replace', d: 'fillDown', r: 'fillRight', ';': 'insertDate',
        k: 'insertNote', '-': 'deleteDialog', '=': 'insertDialog', '+': 'insertDialog',
      };
      if (e.shiftKey && k === 'l') { e.preventDefault(); this.cmd.run('toggleFilter'); return; }
      if (k === 'a') { sel.set(0, 0); sel.extendTo(bounds.rows - 1, bounds.cols - 1); e.preventDefault(); this._paint(); return; }
      if (k === ' ') { const c = sel.active.c; sel.set(0, c, 'col'); sel.extendTo(bounds.rows - 1, c); e.preventDefault(); this._paint(); return; }
      if (map[k]) { e.preventDefault(); this.cmd.run(map[k]); return; }
    }
    if (e.altKey && (k === '=' || e.code === 'Equal')) { e.preventDefault(); this.cmd.run('autoSum'); return; }

    let handled = true;
    switch (e.key) {
      case 'ArrowUp':    ctrl ? this._jump(-1, 0, e.shiftKey) : this._move(-1, 0, e.shiftKey); break;
      case 'ArrowDown':  ctrl ? this._jump(1, 0, e.shiftKey) : this._move(1, 0, e.shiftKey); break;
      case 'ArrowLeft':  ctrl ? this._jump(0, -1, e.shiftKey) : this._move(0, -1, e.shiftKey); break;
      case 'ArrowRight': ctrl ? this._jump(0, 1, e.shiftKey) : this._move(0, 1, e.shiftKey); break;
      case 'Home':       sel.move(ctrl ? -bounds.rows : 0, -bounds.cols, bounds, e.shiftKey); break;
      case 'End':        sel.move(ctrl ? bounds.rows : 0, bounds.cols, bounds, e.shiftKey); break;
      case 'PageUp':     sel.move(-this._pageRows(), 0, bounds, e.shiftKey); break;
      case 'PageDown':   sel.move(this._pageRows(), 0, bounds, e.shiftKey); break;
      case 'Tab':        sel.advance(e.shiftKey ? -1 : 1, 'col', bounds); break;
      case 'Enter':      sel.advance(e.shiftKey ? -1 : 1, 'row', bounds); break;
      case 'F2':         e.preventDefault(); if (e.shiftKey) { this.cmd.run('insertNote'); return; } if (this._canEdit()) this._beginEdit(true); return;
      case 'F3':         if (e.shiftKey) { e.preventDefault(); this.cmd.run('insertFunction'); return; } handled = false; break;
      case 'Delete':
      case 'Backspace':  e.preventDefault(); this._clearSelection(); return;
      case 'Escape':
        if (this.painter || this.renderer.copyRect) { this.painter = null; this.renderer.copyRect = null; this.ribbon.refresh(); }
        else sel.set(sel.active.r, sel.active.c);
        break;
      case 'ContextMenu': {
        const b = this._editRect(), r = this.canvas.getBoundingClientRect();
        e.preventDefault();
        openCellMenu(this, { x: r.left + b.x + b.w / 2, y: r.top + b.y + b.h / 2 });
        return;
      }
      default:
        handled = false;
    }
    if (handled) {
      e.preventDefault();
      this._reveal();
      this._paint();
      return;
    }
    // 可打印字符直接进入编辑，和 Excel 一样；输入法组合键（key 长度 > 1）交给编辑器自己收
    if (!ctrl && !e.altKey && e.key.length === 1) {
      e.preventDefault();
      if (this._canEdit()) this._beginEdit(false, e.key);
    }
  }

  _pageRows() {
    return Math.max(1, Math.floor(this.vp.bodyH / this.model.defaultRowHeight) - 1);
  }

  /** 方向键：跳过隐藏行列；从合并格出发时从它的边缘起步。 */
  _move(dr, dc, extend) {
    const s = this.sel;
    let { r, c } = extend ? s.focus : s.cursor;
    const m = extend ? null : this.calc.mergeAt(r, c);
    if (m) { if (dr > 0) r = m[2]; if (dr < 0) r = m[0]; if (dc > 0) c = m[3]; if (dc < 0) c = m[1]; }
    const nr = this._step(r, dr, 'row'), nc = this._step(c, dc, 'col');
    if (extend) s.focus = { r: nr, c: nc };
    else this._select(nr, nc);
  }

  /** 沿一个方向走一格，隐藏的行列不停留。 */
  _step(i, d, axis) {
    if (!d) return i;
    const n = axis === 'row' ? this.model.rowCount : this.model.colCount;
    const hidden = axis === 'row' ? (x) => this.vp.rowHidden(x) : (x) => this.vp.colHidden(x);
    let j = i + d;
    while (j >= 0 && j < n && hidden(j)) j += d;
    return j < 0 || j >= n ? i : j;
  }

  /** Ctrl+方向：跳到数据块边缘，没有数据就到表的尽头。 */
  _jump(dr, dc, extend) {
    const s = this.sel;
    const from = extend ? s.focus : s.cursor;
    const R = this.model.rowCount, C = this.model.colCount;
    const has = (r, c) => this.model.getCell(r, c) !== '';
    let r = from.r, c = from.c;
    const inb = (a, b) => a >= 0 && a < R && b >= 0 && b < C;
    if (inb(r + dr, c + dc) && has(r, c) && has(r + dr, c + dc)) {
      while (inb(r + dr, c + dc) && has(r + dr, c + dc)) { r += dr; c += dc; }
    } else {
      r += dr; c += dc;
      while (inb(r, c) && !has(r, c)) { r += dr; c += dc; }
      if (!inb(r, c)) { r = dr ? (dr > 0 ? R - 1 : 0) : from.r; c = dc ? (dc > 0 ? C - 1 : 0) : from.c; }
    }
    if (extend) s.focus = { r, c };
    else this._select(r, c);
  }

  // ── 编辑 ──────────────────────────────────────────────────────────────

  /** 编辑器应当盖住的矩形：合并格盖住整块。 */
  _editRect() {
    const { r, c } = this._editing ?? this.sel.active;
    const m = this.calc.mergeAt(r, c);
    return m ? this.renderer.rectOf(m[0], m[1], m[2], m[3]) : this.vp.cellRect(r, c);
  }

  /**
   * @param {boolean} keepValue true = 双击 / F2 / 编辑栏（保留原值）
   * @param {string} [seed] 直接打字进入时的第一个字符
   */
  _beginEdit(keepValue, seed, focus = true) {
    if (this.view !== 'grid' || this.readonly) return;
    const { r, c } = this.sel.active;
    this._reveal();
    this._editing = { r, c };
    const value = seed != null ? seed : keepValue ? this.model.getCell(r, c) : '';
    this.editor.show(this._editRect(), value, false, focus);
    this.fx.value = value;
    this.renderer.showFillHandle = false;
    this.renderer.copyRect = null;
    if (focus) this.assist.update(this.editor.el);
    else this.assist.highlight(value);
    this._paint();
  }

  /** @param {string} v @param {'down'|'right'|'up'|'left'|'none'} move */
  _commitEdit(v, move) {
    const { r, c } = this._editing ?? this.sel.active;
    this._endEdit();
    let val = v;
    if (val.startsWith('=') && val.length > 1) val = upperFormula(closeParens(val));
    else if (val.startsWith('=')) val = '';

    const rule = this.calc.validationAt(r, c);
    const why = rule ? this.calc.checkValidation(rule, val, r, c) : null;
    if (why && !rule.warn) {
      this.opts.onStatus?.(tt('输入无效：{why}', { why }), 'error');
      this.sel.set(r, c);
      this._beginEdit(false, val);
      return;
    }
    if (why) this.opts.onStatus?.(tt('提示：{why}', { why }), 'error');

    if (val !== this.model.getCell(r, c)) {
      const ops = [{ t: 'setCell', r, c, v: val }];
      // 输入 50% 这样的值：顺手给个百分比格式，和 Excel 一样
      const pm = /^\s*-?[\d,]*(\.(\d+))?\s*%\s*$/.exec(val);
      const fmt = this.model.getFormat(r, c);
      if (pm && !fmt?.nf) ops.push({ t: 'setFormats', cells: [[r, c, { ...(fmt ?? {}), nf: pm[2] ? '0.' + '0'.repeat(Math.min(4, pm[2].length)) + '%' : '0%' }]] });
      // 多级下拉：上一级改了，右边对不上的下级一起清空
      const clears = rule?.type === 'cascade' ? this.calc.cascadeClears(rule, r, c, val) : [];
      if (clears.length) ops.push({ t: 'setCells', cells: clears });
      this.exec(ops);
    }

    const bounds = { rows: this.model.rowCount, cols: this.model.colCount };
    const s = this.sel.rect, m = this.calc.mergeAt(r, c);
    const onMerge = m && s.r0 === m[0] && s.c0 === m[1] && s.r1 === m[2] && s.c1 === m[3];
    // Excel：Tab 连续向右录入后按 Enter，回到这一串 Tab 开始的那一列的下一行
    const run = this._tabRun;
    this._tabRun = move === 'right' && this.sel.isSingle ? { r, c: run?.r === r ? run.c : c } : null;
    const d = { down: [1, 0], up: [-1, 0], right: [0, 1], left: [0, -1] }[move];
    if (move === 'down' && run?.r === r && this.sel.isSingle && r + 1 < bounds.rows) this.sel.set(r + 1, run.c);
    else if (d && (onMerge || this.sel.isSingle)) this._move(d[0], d[1], false);
    else if (d) this.sel.advance(d[0] || d[1], d[0] ? 'row' : 'col', bounds);
    this.scroll.focus({ preventScroll: true });
    this._reveal();
    this._syncSizer();
    this._paint();
  }

  _endEdit() {
    this._editing = null;
    this._picking = false;
    this.renderer.showFillHandle = true;
    this.renderer.refHighlights = [];
    this.assist.close();
    this.fx.value = this.model.getCell(this.sel.active.r, this.sel.active.c);
    if (this.editor.open) this.editor.hide();
    this.scroll.focus({ preventScroll: true });
    this._paint();
  }

  _clearSelection() {
    if (!this._canEdit()) return;
    const s = this.calc.expandRect(this.sel.rect);
    this.exec(clearOps(this.model, s, 'content', this._filterSkip(s) ?? undefined));
  }

  /**
   * 区域里有被筛选隐藏的行时，返回「跳过这些行」的判断；没有返回 null。
   * @param {{r0:number, r1:number}} s @returns {((r: number) => boolean) | null}
   */
  _filterSkip(s) {
    const hid = this.calc.filteredRows();
    if (!hid || !hid.size) return null;
    for (const r of hid) if (r >= s.r0 && r <= s.r1) return (x) => hid.has(x);
    return null;
  }

  // ── 写入与撤销 ────────────────────────────────────────────────────────

  /**
   * 唯一的写入口：应用 op、记撤销。返回逆 op；只读时返回 null。
   * @param {any[]} ops
   */
  exec(ops) {
    if (!ops || !ops.length) return [];
    if (!this._canEdit()) return null;
    const back = this.model.apply(ops);
    if (ops.some((o) => o.t === 'clearAll')) { this._undo.length = 0; this._redo.length = 0; }
    else this._pushUndo(ops, back);
    this._syncSizer();
    this._paint();
    return back;
  }

  _pushUndo(fwd, back) {
    if (!back || !back.length) return;
    this._undo.push({ fwd, back, sel: { ...this.sel.rect } });
    if (this._undo.length > UNDO_MAX) this._undo.shift();
    this._redo.length = 0;
    this.ribbon?.refresh();
  }

  undo() {
    if (!this._canEdit()) return;
    const e = this._undo.pop();
    if (!e) { this.opts.onStatus?.(tt('没有可撤销的操作')); return; }
    this.model.apply(e.back);
    this._redo.push(e);
    this._restoreSel(e.sel);
  }

  redo() {
    if (!this._canEdit()) return;
    const e = this._redo.pop();
    if (!e) { this.opts.onStatus?.(tt('没有可恢复的操作')); return; }
    const back = this.model.apply(e.fwd);
    this._undo.push({ fwd: e.fwd, back: back.length ? back : e.back, sel: e.sel });
    this._restoreSel(e.sel);
  }

  get canUndo() { return this._undo.length > 0; }
  get canRedo() { return this._redo.length > 0; }

  _restoreSel(s) {
    const R = this.model.rowCount - 1, C = this.model.colCount - 1;
    this.sel.set(Math.min(s.r0, R), Math.min(s.c0, C));
    this.sel.extendTo(Math.min(s.r1, R), Math.min(s.c1, C));
    this._reveal();
    this._syncSizer();
    this._paint();
    this.ribbon?.refresh();
  }

  // ── 剪贴板 ────────────────────────────────────────────────────────────

  /** @param {ClipboardEvent} e */
  _copy(e, cut = false) {
    if (this.noCopy) { e.preventDefault(); this.opts.onStatus?.(NO_COPY_MSG, 'error'); return; }
    if (!e.clipboardData || this.editor.open) return;
    e.preventDefault();
    this.copySelection(cut, e.clipboardData);
  }

  /**
   * 复制选区：外部剪贴板拿显示文本（和 Excel 一样），内部另存一份带公式与格式的副本。
   * @param {boolean} cut @param {DataTransfer} [dt] 没有时走异步剪贴板 API（右键菜单）
   */
  copySelection(cut = false, dt) {
    if (this.noCopy) { this.opts.onStatus?.(NO_COPY_MSG, 'error'); return; }
    const s = this.calc.expandRect(this.sel.rect);
    if ((s.r1 - s.r0 + 1) * (s.c1 - s.c0 + 1) > MAX_PASTE_CELLS) {
      this.opts.onStatus?.(tt('选区过大，一次最多复制 {n} 个单元格', { n: MAX_PASTE_CELLS.toLocaleString() }), 'error');
      return;
    }
    // 筛选中：和 Excel 一样只复制看得见的行。跳过了行的块没法按原位置平移公式，只放文字（粘贴走外部文本那条路）
    const skip = cut ? null : this._filterSkip(s);
    const { tsv, html } = serializeRange((r, c) => this.calc.text(r, c), s, skip ?? undefined);
    if (dt) {
      dt.setData('text/plain', tsv);
      dt.setData('text/html', html);
    } else {
      navigator.clipboard?.writeText?.(tsv).catch(() => { /* 权限被拒时仍保留内部剪贴板 */ });
    }
    this._clip = skip ? null : { block: captureBlock(this.model, this.calc, s), tsv, cut };
    this.renderer.copyRect = cut ? null : s;
    if (cut) {
      this._clearSelection();
      this._clip.cut = true;
    }
    this.renderer.schedule();
  }

  /** @param {ClipboardEvent} e */
  _paste(e) {
    if (!e.clipboardData || this.editor.open) return;
    e.preventDefault();
    if (!this._canEdit()) return;
    const text = e.clipboardData.getData('text/plain');
    // 截图 / 复制的文件：没有文字时当作附件挂到活动单元格
    const pasted = [...(e.clipboardData.files ?? [])];
    if (pasted.length && !text) { const { r, c } = this.sel.active; void this.cmd.uploadFiles(pasted, r, c); return; }
    if (this._clip && text && norm(text) === norm(this._clip.tsv)) { this.pasteInternal('all'); return; }
    const grid = readClipboard(e.clipboardData);
    this.pasteGrid(grid);
  }

  /** 外部文本（Excel / 网页表格）粘贴。 @param {string[][] | null} grid */
  pasteGrid(grid) {
    if (!grid || !grid.length) return;
    const { r, c } = this.sel.active;
    const rows = grid.length;
    const cols = grid.reduce((m, row) => Math.max(m, row.length), 0);
    if (rows * cols > MAX_PASTE_CELLS) {
      alert(tt('一次最多粘贴 {max} 个单元格，当前 {n} 个。请分批粘贴。',
        { max: MAX_PASTE_CELLS.toLocaleString(), n: (rows * cols).toLocaleString() }));
      return;
    }
    // 和 Excel 一样：选区是粘贴内容的整数倍（比如复制一格、选中一片）时铺满整个选区
    const sel = this.sel.rect, sh = sel.r1 - sel.r0 + 1, sw = sel.c1 - sel.c0 + 1;
    const tile = !this.sel.isSingle && sh % rows === 0 && sw % cols === 0 && sh * sw <= MAX_PASTE_CELLS
      && grid.every((row) => row.length === cols);
    const r0 = tile ? sel.r0 : r, c0 = tile ? sel.c0 : c;
    const H = tile ? sh : rows, W = tile ? sw : cols;
    const cells = [];
    if (tile) { for (let i = 0; i < H; i++) for (let j = 0; j < W; j++) cells.push([r0 + i, c0 + j, grid[i % rows][j % cols]]); }
    else for (let i = 0; i < rows; i++) for (let j = 0; j < grid[i].length; j++) cells.push([r + i, c + j, grid[i][j]]);
    this.exec([{ t: 'setCells', cells }]);
    this.sel.set(r0, c0);
    this.sel.extendTo(r0 + H - 1, c0 + W - 1);
    this._syncSizer();
    this._paint();
  }

  /**
   * 内部剪贴板粘贴（选择性粘贴也走这里）。
   * @param {'all'|'values'|'formats'|'formulas'|'transpose'} mode
   */
  pasteInternal(mode) {
    const clip = this._clip;
    if (!clip) { this.opts.onStatus?.(tt('请先复制一个区域'), 'error'); return; }
    if (!this._canEdit()) return;
    const b = clip.block;
    const h = mode === 'transpose' ? b.raw[0].length : b.raw.length;
    const w = mode === 'transpose' ? b.raw.length : b.raw[0].length;
    const s = this.sel.rect;
    const big = (s.r1 - s.r0 + 1) >= h && (s.c1 - s.c0 + 1) >= w;
    const dest = big ? s : { r0: s.r0, c0: s.c0, r1: s.r0 + h - 1, c1: s.c0 + w - 1 };
    // 剪切后粘贴 = 移动：公式不做相对偏移
    const block = clip.cut ? { ...b, r0: dest.r0, c0: dest.c0 } : b;
    const ops = pasteBlockOps(block, dest, mode);
    const n = ops.reduce((m, o) => m + (o.cells?.length ?? 0), 0);
    if (n > MAX_PASTE_CELLS * 2) { alert(tt('一次最多粘贴 {max} 个单元格', { max: MAX_PASTE_CELLS.toLocaleString() })); return; }
    this.exec(ops);
    const hh = big && dest.r1 - dest.r0 + 1 > h && (dest.r1 - dest.r0 + 1) % h === 0 ? dest.r1 - dest.r0 + 1 : h;
    const ww = big && dest.c1 - dest.c0 + 1 > w && (dest.c1 - dest.c0 + 1) % w === 0 ? dest.c1 - dest.c0 + 1 : w;
    this.sel.set(dest.r0, dest.c0);
    this.sel.extendTo(dest.r0 + hh - 1, dest.c0 + ww - 1);
    if (clip.cut) { this._clip = null; this.renderer.copyRect = null; }
    this._syncSizer();
    this._paint();
  }

  /** 右键菜单里的「粘贴」：优先内部剪贴板，否则读系统剪贴板。 */
  async pasteFromMenu(mode = 'all') {
    if (!this._canEdit()) return;
    let text = '';
    try { text = await navigator.clipboard.readText(); } catch { text = ''; }
    if (this._clip && (!text || norm(text) === norm(this._clip.tsv))) { this.pasteInternal(mode); return; }
    if (!text) { this.opts.onStatus?.(tt('浏览器不允许读取剪贴板，请使用 Ctrl+V 粘贴'), 'error'); return; }
    this.pasteGrid(parseTsv(text));
  }

  // ── 导航与视图状态 ────────────────────────────────────────────────────

  /** 名称框跳转：B7、A1:C9、整列 C:C、整行 3:5。 */
  goto(text) {
    const t = String(text ?? '').trim().toUpperCase().replace(/\s+/g, '');
    const R = this.model.rowCount - 1, C = this.model.colCount - 1;
    let g = parseRange(t);
    if (!g) {
      const p = parseRef(t);
      if (p) g = { r0: p.row, c0: p.col, r1: p.row, c1: p.col };
    }
    if (!g) {
      const col = /^([A-Z]+):([A-Z]+)$/.exec(t), row = /^(\d+):(\d+)$/.exec(t);
      if (col) { const a = parseRef(col[1] + '1'), b = parseRef(col[2] + '1'); if (a && b) g = { r0: 0, c0: Math.min(a.col, b.col), r1: R, c1: Math.max(a.col, b.col) }; }
      else if (row) { const a = +row[1] - 1, b = +row[2] - 1; if (a >= 0 && b >= 0) g = { r0: Math.min(a, b), c0: 0, r1: Math.max(a, b), c1: C }; }
    }
    if (!g) { this.opts.onStatus?.(tt('无法识别的地址：{text}', { text }), 'error'); this._status(); return; }
    this.sel.set(Math.min(g.r0, R), Math.min(g.c0, C));
    this.sel.extendTo(Math.min(g.r1, R), Math.min(g.c1, C));
    this._reveal();
    this._paint();
    this.scroll.focus({ preventScroll: true });
  }

  /** 冻结窗格：以活动单元格为界；活动单元格在 A1 时冻结首行首列；已冻结则取消。 */
  _toggleFreeze() {
    const cur = this.model.props.freeze;
    if (cur && (cur.r || cur.c)) { this.exec([{ t: 'setProp', key: 'freeze', value: null }]); this.ribbon?.refresh(); return; }
    const { r, c } = this.sel.active;
    const v = r === 0 && c === 0 ? { r: 1, c: 1 } : { r, c };
    this.freezeAt(v.r, v.c);
  }

  freezeAt(r, c) {
    if (this.readonly) { this.vp.frozenRows = r; this.vp.frozenCols = c; this._paint(); return; }
    this.exec([{ t: 'setProp', key: 'freeze', value: r || c ? { r, c } : null }]);
    this.ribbon?.refresh();
  }

  /** 把活动单元格滚进可视区（改的是原生滚动位置，让两边不打架）。 */
  _reveal() {
    if (this.vp.scrollIntoView(this.sel.active.r, this.sel.active.c)) {
      this.scroll.scrollLeft = this.vp.scrollX;
      this.scroll.scrollTop = this.vp.scrollY;
    }
  }

  _paint() {
    this.renderer.schedule();
    this._status();
    this.ribbon?.refresh();
    if (this.sync) this.sync.sendCursor(this.sel.rect, !!this._editing);
  }

  /**
   * 分享时限定的可见视图（「只能看仪表盘」之类）。不允许的标签藏起来；
   * 当前视图不在允许范围里就切到第一个允许的。只是界面限制，数据照样在浏览器里。
   * @param {string | null | undefined} scope 逗号分隔；空 = 不限
   */
  setScope(scope) {
    const list = scope ? scope.split(',').filter((v) => v === 'grid' || v === 'kanban' || v === 'dashboard') : [];
    this.scope = list.length ? list : null;
    this._applyScope();
  }

  /** 透视表是分析视图，和仪表盘同进退：能看仪表盘就能看透视表。 @param {string} v */
  _allowed(v) {
    if (!this.scope) return true;
    return this.scope.includes(v.startsWith('pivot:') ? 'dashboard' : v);
  }

  _applyScope() {
    let shown = 0;
    for (const b of /** @type {HTMLElement[]} */ ([...this.viewTabs.children])) {
      b.hidden = !this._allowed(b.dataset.view ?? '');
      if (!b.hidden) shown++;
    }
    // 只剩一个视图时标签栏没意义
    this.viewTabs.hidden = shown <= 1;
    if (!this._allowed(this.view)) void this.setView(/** @type {any} */ (this.scope?.[0] ?? 'grid'));
  }

  /**
   * 透视表标签：排在「仪表盘」后面，一个透视表一个。双击标签改名。
   * props.pivots 变了（本地或远端）就重建；当前正看着的透视表被删了就回表格。
   */
  _syncPivotTabs() {
    const list = Array.isArray(this.model.props.pivots) ? this.model.props.pivots.filter((p) => p?.id) : [];
    const sig = JSON.stringify(list.map((p) => [p.id, p.name]));
    if (sig !== this._pivotSig) {
      this._pivotSig = sig;
      for (const b of [...this.viewTabs.querySelectorAll('[data-pivot]')]) b.remove();
      for (const p of list) {
        const v = 'pivot:' + p.id;
        this.viewTabs.append(h('button', { class: 'grid__view-tab grid__view-tab--pivot', type: 'button', text: p.name || tt('透视表'),
          title: tt('{name} · 双击改名', { name: p.name }), dataset: { view: v, pivot: p.id },
          attrs: { 'aria-selected': String(this.view === v) }, onclick: () => this.setView(v),
          ondblclick: () => { if (!this.readonly) this.cmd.run('renamePivot', p.id); } }));
      }
      this._applyScope();
    }
    if (this.view.startsWith('pivot:') && !list.some((p) => 'pivot:' + p.id === this.view)) void this.setView('grid');
  }

  /** 切换 表格 / 看板 / 仪表盘 / 透视表。后几个按需加载。 @param {string} v 'grid' | 'kanban' | 'dashboard' | 'pivot:<id>' */
  async setView(v) {
    if (v === this.view) return;
    if (!this._allowed(v)) return;
    if (this.editor.open) this.editor.commit('none');
    this.view3?.destroy?.();
    this.view3 = null;
    this.view = v;
    for (const b of this.viewTabs.children) b.setAttribute?.('aria-selected', String(b.dataset?.view === v));
    const grid = v === 'grid';
    this.stage.hidden = !grid;
    this.viewHost.hidden = grid;
    this.ribbonHost.hidden = !grid;
    this.fbar.hidden = !grid;
    if (grid) { this.viewHost.replaceChildren(); this._measure(); this._paint(); this.charts.position(); return; }
    if (v.startsWith('pivot:')) {
      const { PivotView } = await import('../views/pivot.js');
      if (this.view !== v) return;
      this.view3 = new PivotView(this, this.viewHost, v.slice(6));
      return;
    }
    const mod = v === 'kanban' ? await import('../views/kanban.js') : await import('../views/dashboard.js');
    if (this.view !== v) return;
    const View = v === 'kanban' ? mod.KanbanView : mod.DashboardView;
    this.view3 = new View(this, this.viewHost);
  }

  _refreshView() { this.view3?.refresh?.(); }

  /** 地址框 + 底部统计。求和只扫选区，全选 10 万行时按上限截断，不卡 UI。 */
  _status() {
    const s = this.sel.rect;
    const single = this.sel.isSingle;
    const m = this.calc.mergeAt(s.r0, s.c0);
    const isMerge = m && m[0] === s.r0 && m[1] === s.c0 && m[2] === s.r1 && m[3] === s.c1;
    const label = single || isMerge ? cellRef(s.r0, s.c0)
      : rangeName(s.r0, s.c0, s.r1, s.c1) + '  ' + (s.r1 - s.r0 + 1) + '×' + (s.c1 - s.c0 + 1);
    this.addr.textContent = label;
    if (document.activeElement !== this.addr) this.addr.value = single || isMerge ? label : rangeName(s.r0, s.c0, s.r1, s.c1);
    if (!this.editor.open && document.activeElement !== this.fx) {
      this.fx.value = this.model.getCell(this.sel.active.r, this.sel.active.c);
    }

    this.statSel.textContent = single ? tt('单元格 {ref}', { ref: cellRef(s.r0, s.c0) })
      : tt('已选 {n} 格', { n: ((s.r1 - s.r0 + 1) * (s.c1 - s.c0 + 1)).toLocaleString() });

    // 汇总按「选区 + 数据版本」缓存；大选区拖动时每次移动都全扫一遍会卡，改成停下来再算
    const key = s.r0 + ',' + s.c0 + ',' + s.r1 + ',' + s.c1 + '|' + this.model.rev + '|' + this.calc.showFormulas;
    if (key !== this._aggKey) {
      this._aggKey = key;
      clearTimeout(this._aggTimer);
      const area = (s.r1 - s.r0 + 1) * (s.c1 - s.c0 + 1);
      if (area <= 5000) this._aggregate(s, single);
      else { this.statSum.textContent = tt('统计中…'); this._aggTimer = setTimeout(() => this._aggregate(this.sel.rect, this.sel.isSingle), 150); }
    }

    this.statSize.textContent = tt('{rows} 行 × {cols} 列 · 已填 {n} 格', {
      rows: this.model.rowCount.toLocaleString(), cols: this.model.colCount, n: this.model.cells.size.toLocaleString() });
  }

  /** 状态栏的求和 / 平均 / 计数。 @param {{r0:number,c0:number,r1:number,c1:number}} s @param {boolean} single */
  _aggregate(s, single) {
    let count = 0, sum = 0, numeric = 0, scanned = 0, min = Infinity, max = -Infinity;
    const LIMIT = 50000;
    outer:
    for (let r = s.r0; r <= s.r1; r++) {
      if (this.vp.rowHidden(r)) continue;
      for (let c = s.c0; c <= s.c1; c++) {
        if (++scanned > LIMIT) break outer;
        if (this.model.getCell(r, c) === '') continue;
        count++;
        const v = this.calc.value(r, c);
        if (typeof v === 'number' && Number.isFinite(v)) { sum += v; numeric++; if (v < min) min = v; if (v > max) max = v; }
      }
    }
    const partial = scanned > LIMIT ? tt('（前 5 万格）') : '';
    this.statSum.textContent = numeric > 1 || (numeric === 1 && !single)
      ? tt('求和 {sum} · 平均 {avg} · 最小 {min} · 最大 {max} · 计数 {count}', {
        sum: round(sum).toLocaleString(), avg: round(sum / numeric).toLocaleString(),
        min: round(min).toLocaleString(), max: round(max).toLocaleString(), count }) + partial
      : count > 1 ? tt('计数 {count}', { count }) + partial : '';
  }

  // ── 实时同步 ──────────────────────────────────────────────────────────

  /** 接上同步引擎。接上之后这张网格就不再是"本页数据"了。 @param {import('../core/sync.js').SyncEngine} sync */
  attachSync(sync) {
    this.sync = sync;
    // 示例数据会真的写进这张表并同步给所有人，联网后没有理由留着这个按钮
    if (this.btnDemo) {
      this.btnDemo.disabled = true;
      this.btnDemo.title = tt('已接入实时同步：示例数据会写进真实表格，因此在此禁用。');
    }
    this.note.textContent = tt('实时同步');
    this.note.title = tt('改动会立即保存到 Cloudflare Durable Objects，并同步给其他协作者。');
    this.setConnState(sync.state);
  }

  /** @param {import('../core/sync.js').SyncState} s @param {string} [detail] */
  setConnState(s, detail) {
    // 可写性取自 sync.readonly 而不是状态字符串：断线时状态是 offline，
    // 但一个 viewer 不该因为断了一下就变得能编辑。
    const viewer = this.sync ? this.sync.readonly : false;
    this.readonly = viewer || this.mobile;
    if (viewer && !this.mobile) this.setReadonlyReason(tt('只读权限：你可以查看，但不能修改这张表'));
    const label = {
      loading: tt('载入中…'), connecting: tt('连接中…'), syncing: tt('同步中…'),
      online: tt('已同步'), offline: tt('离线'), readonly: tt('只读'),
    }[s] ?? s;
    const tone = s === 'online' ? 'ok' : s === 'offline' ? 'bad' : s === 'readonly' ? 'muted' : 'wait';
    this.statConn.className = 'grid__conn grid__conn--' + tone;
    this.statConn.textContent = label;
    this.statConn.title = detail ?? '';
    this.ribbon?.refresh();
  }

  /**
   * 在线的人变了。头像画在顶栏右上角（由 opts.onPeers 交给外面），选区框画在画布上。
   * @param {{id:string, email:string, name?:string, role?:string}[]} users
   */
  setPeers(users) {
    this._peerInfo = new Map(users.map((u) => [u.id, {
      id: u.id, email: u.email, name: u.name || shortName(u.email), role: u.role ?? 'viewer',
    }]));
    // 离开的人要把光标一并抹掉，否则会留下一个永远不动的幽灵选区
    for (const id of [...this.renderer.peers.keys()]) if (!this._peerInfo.has(id)) this.renderer.peers.delete(id);
    this.renderer.schedule();
    this.opts.onPeers?.(this.peerList());
  }

  /** @param {string} from @param {any} sel @param {boolean} [editing] */
  setPeerCursor(from, sel, editing = false) {
    if (!from || from === this.sync?.you?.id) return;
    this.renderer.peers.set(from, { sel, editing, label: this._peerInfo.get(from)?.name ?? tt('协作者') });
    this.renderer.schedule();
    this.opts.onPeers?.(this.peerList());
  }

  /**
   * 顶栏头像用：自己排第一，其余按进来的顺序。where 是对方选区的 A1 地址（还没动过就是 null）。
   * @returns {{id:string, name:string, email:string, role:string, hue:number, me:boolean, where:string|null, editing:boolean}[]}
   */
  peerList() {
    const meId = this.sync?.you?.id;
    const out = [...this._peerInfo.values()].map((u) => {
      const p = this.renderer.peers.get(u.id);
      const s = u.id === meId ? this.sel.rect : p?.sel;
      return {
        ...u, hue: hashHue(u.id), me: u.id === meId,
        where: s ? rangeName(s.r0, s.c0, s.r1, s.c1) : null,
        editing: u.id === meId ? !!this._editing : !!p?.editing,
      };
    });
    return out.sort((a, b) => Number(b.me) - Number(a.me));
  }

  /** 点顶栏头像：跳到那个人的选区。 @param {string} id */
  async jumpToPeer(id) {
    const s = this.renderer.peers.get(id)?.sel;
    if (!s) { this.opts.onStatus?.(tt('对方还没有选中任何格子'), 'error'); return; }
    if (this.view !== 'grid') await this.setView('grid');
    if (this.view !== 'grid') return;   // 分享范围不含表格视图
    if (this.editor.open) this.editor.commit('none');
    const R = this.model.rowCount - 1, C = this.model.colCount - 1;
    this.sel.set(Math.min(s.r0, R), Math.min(s.c0, C));
    this.sel.extendTo(Math.min(s.r1, R), Math.min(s.c1, C));
    this._reveal();
    this._paint();
    this.scroll.focus({ preventScroll: true });
  }

  // ── 示例数据 ──────────────────────────────────────────────────────────

  /** 生成 n 行演示数据，用来验证"10 万行滚动流畅"这条判据。 @param {number} n */
  loadDemo(n) {
    const t0 = performance.now();
    const head = ['订单号', '客户', '地区', '品类', '数量', '单价', '金额', '下单日期'];
    const cust = ['星海科技', '平川贸易', '和光制造', '南岭食品', '云梯物流', '锦程电子'];
    const area = ['华东', '华南', '华北', '西南', '东北'];
    const kind = ['原材料', '半成品', '成品', '配件', '服务'];

    this.model.clear();
    this.model.props = { freeze: { r: 1, c: 1 } };
    this.model.bulkFill(n + 1, head.length, (r, c) => {
      if (r === 0) return head[c];
      const i = r - 1;
      const qty = 1 + (i * 7) % 200;
      const price = 5 + ((i * 13) % 4000) / 100;
      switch (c) {
        case 0: return 'SO' + String(100000 + i);
        case 1: return cust[i % cust.length];
        case 2: return area[(i >> 2) % area.length];
        case 3: return kind[(i >> 1) % kind.length];
        case 4: return String(qty);
        case 5: return price.toFixed(2);
        case 6: return (qty * price).toFixed(2);
        case 7: return new Date(Date.UTC(2026, 0, 1 + (i % 365))).toISOString().slice(0, 10);
        default: return '';
      }
    });
    this._undo.length = 0;
    this._redo.length = 0;
    this.sel.set(1, 0);
    this.scroll.scrollTop = 0;
    this.scroll.scrollLeft = 0;
    this.vp.scrollX = 0;
    this.vp.scrollY = 0;
    this._syncSizer();
    this._paint();
    this.opts.onStatus?.(tt('已生成 {n} 行示例数据（{ms} ms）',
      { n: n.toLocaleString(), ms: Math.round(performance.now() - t0) }));
  }
}

/** 公式少写的右括号自动补上（忽略字符串里的括号）。 */
function closeParens(f) {
  let depth = 0, inStr = false;
  for (const ch of f) {
    if (ch === '"') inStr = !inStr;
    else if (!inStr && ch === '(') depth++;
    else if (!inStr && ch === ')') depth = Math.max(0, depth - 1);
  }
  return depth > 0 && !inStr ? f + ')'.repeat(depth) : f;
}

function inBox(b, x, y) { return !!b && x >= b.x && x <= b.x + b.w && y >= b.y && y <= b.y + b.h; }
function round(n) { return Math.round(n * 1e6) / 1e6; }
function norm(t) { return String(t).replace(/\r/g, '').replace(/\n+$/, ''); }

function isMobile() {
  try {
    return !!globalThis.matchMedia?.('(pointer: coarse)').matches && Math.min(screen.width, screen.height) < 768;
  } catch { return false; }
}

function shortName(email) {
  const s = String(email ?? '');
  const at = s.indexOf('@');
  return at > 0 ? s.slice(0, at) : s || tt('协作者');
}

/**
 * 公式提交时统一大小写：函数名与单元格引用转大写，字符串字面量原样保留。
 * =sum(b2:b5) → =SUM(B2:B5)，与 Excel 一致。
 * @param {string} f
 */
function upperFormula(f) {
  return f.replace(/("(?:[^"]|"")*")|([A-Za-z_][A-Za-z0-9_.]*)(?=\s*\()|(\$?[A-Za-z]{1,3}\$?\d+)(?![A-Za-z0-9_(!])|(?<![A-Za-z0-9_$.])(?:[Tt][Rr][Uu][Ee]|[Ff][Aa][Ll][Ss][Ee])(?![A-Za-z0-9_(])/g,
    (m, str) => str ?? m.toUpperCase());
}
