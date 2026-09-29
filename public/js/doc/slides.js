/**
 * 幻灯片（kind = 'slides'）：类似 PPT。
 *
 * 存储：props.slides = { ratio:'16:9', theme?, slides:[{ id, bg, notes?, els:[元素…] }] }
 *   元素 { id, t, x, y, w, h, … }，坐标是 960×540 的逻辑像素，画面用 transform 缩放。
 *     text   runs, size, color, align, b, fill?, role?（title / sub / body，换主题时按它重新上色）
 *     shape  shape（themes.js 的 SHAPES）, fill（颜色或 'none'）, stroke?, sw?；deco = 主题装饰，不能选中
 *     img    img（附件编号）
 *     embed  src, kind, range | cfg, fields, title（本内容里某张表的区域 / 图表 / 透视表，活数据）
 *
 * 和文档一样整份存一个 prop；本地有未保存改动时收到别人的版本，按页、再按元素三方合并。
 * 正在打字或拖动时先不重画，结束后再补上。
 */

import { h } from '../ui/dom.js';
import { openMenu } from '../ui/menu.js';
import { uid } from '../../shared/util/uid.js';
import { t as tt } from '../../shared/i18n/i18n.js';
import { mergeSlides } from '../../shared/model/docmerge.js';
import { EmbedHost, pickEmbed } from './embed.js';
import { renderRuns, readRuns, runsText, exec, placeCaret, isHex } from './runs.js';
import { shell, tbtn, colorBtn, popover, card } from './docview.js';
import {
  SHAPES, SHAPE_BY_ID, SLIDE_THEMES, FONTS, LAYOUTS, DECK_TEMPLATES, strokeWidth,
  layout, slideTheme, isSlideTheme, themeDeco, applyTheme, deckFromTemplate,
} from './themes.js';

export { layout };

export const W = 960, H = 540;
const SAVE_MS = 600;
const MAX_BYTES = 256 * 1024;
const MAX_SLIDES = 300;
const MAX_ELS = 80;
const SIZES = [14, 18, 22, 28, 36, 48, 64, 80];
const STATE_LABEL = { loading: tt('载入中…'), connecting: tt('连接中…'), syncing: tt('同步中…'), online: tt('已同步'), offline: tt('离线'), readonly: tt('只读') };
/** @param {string} s */
const connTone = (s) => (s === 'online' ? 'ok' : s === 'offline' ? 'bad' : s === 'readonly' ? 'muted' : 'wait');
const THUMB_W = 136;

/** @param {number} v @param {number} lo @param {number} hi */
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

/** 数据清洗：坐标取整、夹在画布附近，不认识的元素丢掉。 @param {any} d */
export function normDeck(d) {
  const slides = [];
  for (const s of Array.isArray(d?.slides) ? d.slides.slice(0, MAX_SLIDES) : []) {
    if (!s || typeof s.id !== 'string') continue;
    const els = [];
    for (const e of Array.isArray(s.els) ? s.els.slice(0, MAX_ELS) : []) {
      if (!e || typeof e.id !== 'string' || !['text', 'shape', 'img', 'embed'].includes(e.t)) continue;
      const w = clamp(Math.round(Number(e.w) || 100), 10, W * 2), hh = clamp(Math.round(Number(e.h) || 60), 10, H * 2);
      const o = { ...e, x: clamp(Math.round(Number(e.x) || 0), -w + 10, W - 10), y: clamp(Math.round(Number(e.y) || 0), -hh + 10, H - 10), w, h: hh };
      if (e.t === 'shape') {
        if (!SHAPE_BY_ID.has(o.shape)) o.shape = 'rect';
        if (o.fill !== 'none' && !isHex(o.fill)) delete o.fill;
        if (!isHex(o.stroke)) delete o.stroke;
        if (o.sw !== undefined) o.sw = strokeWidth(o.sw);
      }
      els.push(o);
    }
    slides.push({ ...s, bg: isHex(s.bg) ? s.bg : '#ffffff', els });
  }
  return isSlideTheme(d?.theme) ? { ratio: '16:9', theme: d.theme, slides } : { ratio: '16:9', slides };
}

export class SlidesView {
  /**
   * @param {HTMLElement} host
   * @param {{
   *   tableId: string, model: any, name: string,
   *   extPath?: string, publicMode?: boolean,
   *   tables?: () => any[], onShare?: () => void,
   *   onStatus?: (msg: string, kind?: string) => void,
   * }} opts
   */
  constructor(host, opts) {
    this.opts = opts;
    this.model = opts.model;
    this.tableId = opts.tableId;
    this.readonly = true;
    this.loaded = false;
    this.dirty = false;
    this._timer = 0;
    this.base = normDeck(null);
    this.data = normDeck(null);
    this.lastJson = '';
    /** 自己保存的那版还没等到回声 */ this.unacked = false;
    /** 当前页的下标 */ this.cur = 0;
    /** @type {string | null} 选中的元素 */ this.sel = null;
    /** @type {string | null} 正在打字的文本框 */ this.editing = null;
    this.dragging = false;
    this.pending = false;
    /** @type {any} 元素剪贴板（本页面内） */ this._clip = null;
    this.embeds = new EmbedHost(this.tableId, { path: opts.extPath, onError: (m) => opts.onStatus?.(m, 'error') });

    const s = shell(host, opts.name, 'sl-body');
    Object.assign(this, { root: s.root, nameEl: s.nameEl, statConn: s.conn, statInfo: s.stat, roNote: s.ro });
    this.rail = h('div', { class: 'sl-rail', attrs: { 'aria-label': tt('幻灯片列表') } });
    this.wrap = h('div', { class: 'sl-stagewrap' });
    this.notes = /** @type {HTMLTextAreaElement} */ (h('textarea', { placeholder: tt('演讲者备注（只有编辑者能看到）'), attrs: { 'aria-label': tt('演讲者备注') } }));
    this.notesBox = h('div', { class: 'sl-notes' }, this.notes);
    this.printBox = h('div', { class: 'sl-print' });
    s.body.append(this.rail, h('div', { class: 'sl-main' }, this.wrap, this.notesBox), this.printBox);
    this._buildTools(s.tools);

    this.notes.addEventListener('input', () => {
      const sl = this._slide();
      if (!sl || this.readonly) return;
      sl.notes = this.notes.value.slice(0, 2000) || undefined;
      this._changed(false);
    });
    this.wrap.addEventListener('pointerdown', (e) => {
      if (e.target === this.wrap || e.target === this.stageSlide) { this._stopEdit(); this._select(null); }
    });
    this._onKey = (/** @type {KeyboardEvent} */ e) => this._key(e);
    document.addEventListener('keydown', this._onKey);
    this._onPaste = (/** @type {ClipboardEvent} */ e) => this._paste(e);
    document.addEventListener('paste', this._onPaste);
    this._onPrint = () => this._fillPrint();
    window.addEventListener('beforeprint', this._onPrint);
    this._ro = new ResizeObserver(() => this._fit());
    this._ro.observe(this.wrap);

    this._unsub = this.model.subscribe((/** @type {any[]} */ ops, /** @type {{local: boolean}} */ meta) => {
      if (meta.local) return;
      if (!ops.some((o) => o.t === 'bulk' || (o.t === 'setProp' && o.key === 'slides'))) return;
      this._remote();
    });
    this.data = normDeck(this.model.props?.slides);
    this.base = structuredClone(this.data);
    this._setEditable();
    this._render();
  }

  // ── 外部接口（与 Grid 同名） ───────────────────────────────────────────────

  /** @param {string} name */
  setName(name) { this.nameEl.textContent = name; }

  /** @param {any} sync */
  attachSync(sync) {
    this.sync = sync;
    this.setConnState(sync.state ?? 'loading');
  }

  /** @param {string} s @param {string} [detail] */
  setConnState(s, detail) {
    this.statConn.className = 'grid__conn grid__conn--' + connTone(s);
    this.statConn.textContent = /** @type {any} */ (STATE_LABEL)[s] ?? s;
    this.statConn.title = detail ?? '';
    if (s === 'online' || s === 'readonly') this.loaded = true;
    if (this.sync?.readonly && !this.opts.publicMode) this.setReadonlyReason(tt('只读权限：你可以查看和放映，但不能修改'));
    this._setEditable();
  }

  /** @param {string} msg */
  setReadonlyReason(msg) {
    this.roNote.textContent = msg;
    this.roNote.hidden = false;
    this._forceRo = true;
    this._setEditable();
  }

  setPeers() {}
  setScope() {}

  destroy() {
    if (this.dirty) this._save();
    clearTimeout(this._timer);
    this._unsub?.();
    this._ro.disconnect();
    document.removeEventListener('keydown', this._onKey);
    document.removeEventListener('paste', this._onPaste);
    window.removeEventListener('beforeprint', this._onPrint);
    this._show?.close();
    this.embeds.dispose();
    this.root.remove();
  }

  // ── 工具条 ────────────────────────────────────────────────────────────────

  /** @param {HTMLElement} bar */
  _buildTools(bar) {
    const newBtn = tbtn(tt('＋ 新页'), tt('新建幻灯片'), (e) => {
      const r = /** @type {HTMLElement} */ (/** @type {Event} */ (e).currentTarget).getBoundingClientRect();
      openMenu(LAYOUTS.map(([kind, label, icon]) => ({ label, icon, action: () => this._addSlide(kind) })), { x: r.left, y: r.bottom + 2 });
    });
    const shapeBtn = tbtn(tt('◆ 形状'), tt('插入形状（30 多种）'), () => this._shapePop(shapeBtn));
    const themeBtn = tbtn(tt('🎨 主题'), tt('主题与模板：一键换整份的配色、字体和装饰'), () => this._themePop(themeBtn));
    this.editTools = h('div', { class: 'dc-group' },
      newBtn,
      tbtn(tt('𝐓 文本框'), tt('插入文本框'), () => this._addEl({ t: 'text', runs: [], size: 28, color: this._theme().text, align: 'left', x: 280, y: 220, w: 400, h: 90, ph: tt('输入文字'), role: 'body' }, true)),
      shapeBtn,
      tbtn(tt('🖼 图片'), tt('插入图片（也可以直接粘贴）'), () => this._pickImage()),
      tbtn(tt('📊 表格内容'), tt('插入本内容里某张表的区域、图表或透视表（活数据）'), () => void this._pickEmbed()),
      colorBtn(tt('背景'), tt('本页背景色'), '#ffffff', (c) => { const sl = this._slide(); if (sl && !this.readonly) { sl.bg = c; this._changed(); } }),
      themeBtn);
    this.selTools = h('div', { class: 'dc-group' });
    const exportBtn = tbtn(tt('📤 导出'), tt('导出为 PowerPoint（.pptx）或 PDF'), () => {
      const r = exportBtn.getBoundingClientRect();
      openMenu([
        { label: 'PowerPoint（.pptx）', icon: '📊', action: () => void this._export() },
        { label: tt('PDF（打印 → 另存为 PDF）'), icon: '🖨', action: () => { this._fillPrint(); window.print(); } },
      ], { x: r.left, y: r.bottom + 2 });
    });
    const right = h('div', { class: 'dc-group dc-group--right' },
      tbtn(tt('▶ 放映'), tt('从当前页开始放映（F5 从头，Shift+F5 从当前页）'), () => this.present(this.cur)),
      this.opts.publicMode ? null : (this.importBtn = tbtn(tt('📥 导入'), tt('导入 PowerPoint（.pptx）或 Keynote（.key）：没有幻灯片时替换，否则接在最后'), () => void this._import())),
      this.opts.publicMode ? null : exportBtn,
      this.opts.onShare ? tbtn(tt('👥 分享'), tt('分享这份幻灯片（权限与表格相同）'), () => this.opts.onShare?.()) : null);
    bar.append(this.editTools, this.selTools, h('div', { class: 'grid__spacer' }), right);
  }

  /** 选中元素后出现的那一组按钮。 */
  _syncSelTools() {
    this.selTools.replaceChildren();
    const e = this._el(this.sel);
    if (!e || this.readonly) return;
    if (e.t === 'text') {
      const size = /** @type {HTMLSelectElement} */ (h('select', { class: 'dc-select', title: tt('字号'), attrs: { 'aria-label': tt('字号') } }));
      for (const n of SIZES) size.append(h('option', { value: String(n), text: String(n) }));
      if (!SIZES.includes(e.size)) size.append(h('option', { value: String(e.size ?? 22), text: String(e.size ?? 22) }));
      size.value = String(e.size ?? 22);
      size.addEventListener('change', () => this._patch({ size: Number(size.value) }));
      // 正在打字时加粗等作用于选中的字；没在打字时作用于整个文本框
      const mark = (/** @type {string} */ cmd, /** @type {string} */ key) => () => {
        if (this.editing === e.id) { exec(cmd); this._readEditing(); }
        else this._patch({ [key]: e[key] ? undefined : 1 });
      };
      this.selTools.append(size,
        tbtn('B', tt('加粗'), mark('bold', 'b'), 'dc-b'),
        tbtn('I', tt('斜体'), mark('italic', 'i'), 'dc-i'),
        tbtn('U', tt('下划线'), mark('underline', 'u'), 'dc-u'),
        colorBtn('A', tt('文字颜色'), isHex(e.color) ? e.color : '#1f2328', (c) => this._patch({ color: c })),
        tbtn('⇤', tt('左对齐'), () => this._patch({ align: 'left' })),
        tbtn('↔', tt('居中'), () => this._patch({ align: 'center' })),
        tbtn('⇥', tt('右对齐'), () => this._patch({ align: 'right' })),
        colorBtn(tt('底'), tt('文本框底色'), isHex(e.fill) ? e.fill : '#ffffff', (c) => this._patch({ fill: c })));
    }
    if (e.t === 'shape') {
      const line = !!SHAPE_BY_ID.get(e.shape)?.line;
      const sw = /** @type {HTMLSelectElement} */ (h('select', { class: 'dc-select', title: line ? tt('线条粗细') : tt('边框粗细'), attrs: { 'aria-label': tt('线条粗细') } }));
      const widths = line ? [1, 2, 3, 4, 6, 8, 12] : [0, 1, 2, 3, 4, 6, 8];
      const cur = strokeWidth(e.sw ?? (line ? 3 : 0));
      if (!widths.includes(cur)) widths.push(cur);
      for (const n of widths) sw.append(h('option', { value: String(n), text: n ? tt('{n} 像素', { n }) : tt('无边框') }));
      sw.value = String(cur);
      sw.addEventListener('change', () => this._patch({ sw: Number(sw.value), stroke: e.stroke ?? (line ? undefined : '#1f2328') }));
      if (!line) {
        this.selTools.append(
          colorBtn(tt('填充'), tt('填充色'), isHex(e.fill) ? e.fill : '#a5d8ff', (c) => this._patch({ fill: c })),
          tbtn('⊘', tt('无填充（只留边框）'), () => this._patch({ fill: 'none', sw: e.sw || 3, stroke: e.stroke ?? '#1f2328' })));
      }
      this.selTools.append(
        colorBtn(line ? tt('颜色') : tt('边框'), line ? tt('线条颜色') : tt('边框颜色'), isHex(e.stroke) ? e.stroke : '#1f2328',
          (c) => this._patch(line ? { stroke: c } : { stroke: c, sw: e.sw || 2 })),
        sw);
    }
    this.selTools.append(
      tbtn('⬆', tt('置于顶层'), () => this._order(1)),
      tbtn('⬇', tt('置于底层'), () => this._order(-1)),
      tbtn('⧉', tt('复制一份（Ctrl+D）'), () => this._dupEl()),
      tbtn('✕', tt('删除（Delete）'), () => this._delEl()));
  }

  _setEditable() {
    const ro = !!this._forceRo || !!this.opts.publicMode || !this.loaded || !!this.sync?.readonly || !this.sync;
    const changed = ro !== this.readonly;
    this.readonly = ro;
    this.editTools.hidden = ro;
    this.notesBox.hidden = ro;
    if (this.importBtn) this.importBtn.hidden = ro;
    this.root.classList.toggle('dc-ro', ro);
    if (ro) { this._stopEdit(); this.sel = null; }
    if (changed) this._render();
  }

  // ── 数据访问 ─────────────────────────────────────────────────────────────

  _slide() { return this.data.slides[this.cur] ?? null; }

  /** @param {string | null} id */
  _el(id) { return id ? this._slide()?.els.find((/** @type {any} */ e) => e.id === id) ?? null : null; }

  // ── 渲染 ─────────────────────────────────────────────────────────────────

  /** 数据变了要重画；正在打字 / 拖动时推迟到结束。 */
  _renderSoon() {
    if (this.editing || this.dragging) { this.pending = true; return; }
    this._render();
  }

  _render() {
    this.pending = false;
    this.cur = clamp(this.cur, 0, Math.max(0, this.data.slides.length - 1));
    if (this.sel && !this._el(this.sel)) this.sel = null;
    this._renderRail();
    this._renderStage();
    this._syncSelTools();
    const sl = this._slide();
    if (document.activeElement !== this.notes) this.notes.value = sl?.notes ?? '';
    this.notes.disabled = !sl;
    this.statInfo.textContent = this.data.slides.length ? tt('第 {i} / {n} 页', { i: this.cur + 1, n: this.data.slides.length }) : tt('0 页');
    this.embeds.prune();
  }

  _renderRail() {
    const kids = this.data.slides.map((/** @type {any} */ sl, /** @type {number} */ i) => {
      const box = h('div', { class: 'sl-thumb__box' });
      const mini = this._slideEl(sl, 'thumb');
      mini.style.setProperty('transform', 'scale(' + (THUMB_W / W) + ')');
      box.append(mini);
      const t = h('button', {
        class: 'sl-thumb' + (i === this.cur ? ' sl-thumb--on' : ''), type: 'button',
        title: tt('第 {i} 页', { i: i + 1 }), attrs: { 'aria-current': i === this.cur ? 'true' : null },
      }, h('span', { class: 'sl-thumb__n', text: String(i + 1) }), box);
      t.addEventListener('click', () => this.go(i));
      t.addEventListener('dblclick', () => this.present(i));
      t.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        this.go(i);
        if (this.readonly) return;
        openMenu([
          { label: tt('在后面新建'), icon: '＋', action: () => this._addSlide('content') },
          { label: tt('复制此页'), icon: '⧉', action: () => this._dupSlide(i) },
          { label: tt('上移'), icon: '↑', disabled: i === 0, action: () => this._moveSlide(i, i - 1) },
          { label: tt('下移'), icon: '↓', disabled: i === this.data.slides.length - 1, action: () => this._moveSlide(i, i + 1) },
          { sep: true },
          { label: tt('删除此页'), icon: '🗑', danger: true, action: () => this._delSlide(i) },
        ], { x: e.clientX, y: e.clientY });
      });
      if (!this.readonly) {
        t.draggable = true;
        t.addEventListener('dragstart', (e) => { e.dataTransfer?.setData('text/x-slide', String(i)); });
        t.addEventListener('dragover', (e) => { if (e.dataTransfer?.types.includes('text/x-slide')) { e.preventDefault(); t.classList.add('sl-thumb--drop'); } });
        t.addEventListener('dragleave', () => t.classList.remove('sl-thumb--drop'));
        t.addEventListener('drop', (e) => {
          e.preventDefault();
          t.classList.remove('sl-thumb--drop');
          const from = Number(e.dataTransfer?.getData('text/x-slide'));
          if (Number.isInteger(from) && from !== i) this._moveSlide(from, i);
        });
      }
      return t;
    });
    if (!this.readonly) kids.push(tbtn(tt('＋ 新页'), tt('新建幻灯片'), () => this._addSlide('content'), 'sl-add'));
    this.rail.replaceChildren(...kids);
    this.rail.querySelector('.sl-thumb--on')?.scrollIntoView({ block: 'nearest' });
  }

  _renderStage() {
    const sl = this._slide();
    if (!sl) {
      this.stageSlide = null;
      this.wrap.replaceChildren(this.readonly
        ? h('div', { class: 'placeholder' },
          h('div', { class: 'placeholder__title', text: tt('还没有幻灯片') }),
          h('p', { class: 'placeholder__hint', text: tt('这份幻灯片还是空的。') }))
        : this._startPanel());
      return;
    }
    const el = this._slideEl(sl, this.readonly ? 'view' : 'edit');
    el.classList.add('sl-stage');
    this.stageSlide = el;
    this.wrap.replaceChildren(el);
    this._fit();
  }

  /** 画面缩放到刚好放进中间区域。 */
  _fit() {
    const el = this.stageSlide;
    if (!el) return;
    const ww = this.wrap.clientWidth, wh = this.wrap.clientHeight;
    const s = Math.max(0.1, Math.min((ww - 48) / W, (wh - 48) / H));
    this.scale = s;
    el.style.setProperty('transform', 'translate(' + Math.round((ww - W * s) / 2) + 'px,' + Math.round((wh - H * s) / 2) + 'px) scale(' + s + ')');
  }

  /**
   * 一整页。mode：edit 可编辑；view 只读；thumb 缩略图（嵌入只显示标题）；show 放映。
   * @param {any} sl @param {'edit'|'view'|'thumb'|'show'} mode
   */
  _slideEl(sl, mode) {
    const el = h('div', { class: 'sl-slide' + (mode === 'edit' ? ' sl-edit' : '') });
    el.style.setProperty('background', isHex(sl.bg) ? sl.bg : '#ffffff');
    const font = FONTS[slideTheme(this.data.theme).font ?? 'sans'];
    if (font) el.style.setProperty('font-family', font);
    for (const e of sl.els) el.append(this._elEl(e, mode));
    return el;
  }

  /** @param {any} e @param {'edit'|'view'|'thumb'|'show'} mode */
  _elEl(e, mode) {
    const d = h('div', { class: 'sl-el sl-el--' + e.t, dataset: { id: e.id } });
    for (const [k, v] of [['left', e.x], ['top', e.y], ['width', e.w], ['height', e.h]]) d.style.setProperty(/** @type {string} */ (k), v + 'px');
    if (e.t === 'text') {
      renderRuns(d, e.runs);
      d.style.setProperty('font-size', clamp(Number(e.size) || 22, 8, 200) + 'px');
      d.style.setProperty('color', isHex(e.color) ? e.color : '#1f2328');
      d.style.setProperty('text-align', ['center', 'right'].includes(e.align) ? e.align : 'left');
      if (e.b) d.style.setProperty('font-weight', '700');
      if (e.i) d.style.setProperty('font-style', 'italic');
      if (e.u) d.style.setProperty('text-decoration', 'underline');
      if (isHex(e.fill)) d.style.setProperty('background', e.fill);
      if (mode === 'edit' && !runsText(e.runs)) { d.classList.add('sl-ph'); d.dataset.ph = e.ph ? tt(String(e.ph)) : tt('输入文字'); }
    } else if (e.t === 'shape') {
      shapeInto(d, e);
      if (e.deco) d.classList.add('sl-el--deco');
    } else if (e.t === 'img') {
      const img = h('img', { alt: tt('图片') });
      void import('../io/attach.js').then(({ fileUrl }) => { if (typeof e.img === 'string') img.src = fileUrl(this.tableId, e.img); });
      d.append(img);
    } else if (e.t === 'embed') {
      if (mode === 'thumb') d.append(h('div', { class: 'emb__msg', text: '📊 ' + (e.title ?? '') }));
      else {
        const body = this.embeds.mount(e);
        if (e.kind === 'chart') body.classList.add('emb--chart');
        d.append(body);
      }
    }
    if (mode === 'edit' && !e.deco) this._wire(d, e);
    return d;
  }

  /** 编辑态的交互：点选、拖动、单击打字、八个把手。 @param {HTMLElement} d @param {any} e */
  _wire(d, e) {
    if (e.id === this.sel) this._addHandles(d, e.id);
    d.addEventListener('pointerdown', (ev) => {
      if (this.editing === e.id) return;             // 打字时让浏览器处理选字
      if (/** @type {HTMLElement} */ (ev.target).classList.contains('sl-h')) return;
      // 第一下点击可能已经重画了元素，dblclick 不可靠，用点击次数判断双击
      if (ev.detail >= 2 && e.t === 'text' && !this.readonly) { ev.preventDefault(); this._startEdit(e.id); return; }
      this._drag(ev, e.id, 'move');
    });
    if (e.t === 'text') {
      d.addEventListener('input', () => this._readEditing());
      // 回车默认插入 <div>，readRuns 不认识，换行会丢：改成插入 <br>
      d.addEventListener('keydown', (ev) => {
        if (ev.key === 'Enter' && !ev.isComposing && this.editing === e.id) { ev.preventDefault(); exec('insertLineBreak'); }
      });
      d.addEventListener('blur', (ev) => {
        // 点工具条上的字号 / 颜色会抢走焦点，那不算结束编辑
        if (this.selTools.contains(/** @type {Node | null} */ (ev.relatedTarget))) return;
        if (this.editing === e.id) this._stopEdit();
      });
    }
  }

  /** 选中框和八个把手。 @param {HTMLElement} d @param {string} id */
  _addHandles(d, id) {
    d.classList.add('sl-el--sel');
    for (const dir of ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w']) {
      const hd = h('div', { class: 'sl-h sl-h--' + dir, attrs: { contenteditable: 'false' } });
      hd.addEventListener('pointerdown', (ev) => this._drag(/** @type {PointerEvent} */ (ev), id, dir));
      d.append(hd);
    }
  }

  /** 画面上某个元素的节点。 @param {string | null} id */
  _node(id) {
    return id ? /** @type {HTMLElement | null} */ (this.stageSlide?.querySelector('[data-id="' + CSS.escape(id) + '"]') ?? null) : null;
  }

  // ── 拖动与缩放 ─────────────────────────────────────────────────────────────

  /** @param {PointerEvent} ev @param {string} id @param {string} dir move 或把手方向 */
  _drag(ev, id, dir) {
    if (ev.button !== 0 || this.readonly) return;
    ev.preventDefault();
    ev.stopPropagation();
    if (this.editing && this.editing !== id) this._stopEdit();
    const wasSel = this.sel === id;
    if (!wasSel) this._select(id);
    const e = this._el(id);
    const d = this._node(id);
    if (!e || !d) return;
    const s = this.scale || 1;
    const x0 = ev.clientX, y0 = ev.clientY;
    const o = { x: e.x, y: e.y, w: e.w, h: e.h };
    let moved = false;
    this.dragging = true;
    const move = (/** @type {PointerEvent} */ m) => {
      const dx = (m.clientX - x0) / s, dy = (m.clientY - y0) / s;
      if (!moved && Math.abs(dx) + Math.abs(dy) < 3) return;
      moved = true;
      const snap = (/** @type {number} */ v) => (m.altKey ? Math.round(v) : Math.round(v / 4) * 4);
      if (dir === 'move') {
        e.x = clamp(snap(o.x + dx), -o.w + 10, W - 10);
        e.y = clamp(snap(o.y + dy), -o.h + 10, H - 10);
      } else {
        let { x, y, w, h: hh } = o;
        if (dir.includes('e')) w = o.w + dx;
        if (dir.includes('s')) hh = o.h + dy;
        if (dir.includes('w')) { w = o.w - dx; x = o.x + dx; }
        if (dir.includes('n')) { hh = o.h - dy; y = o.y + dy; }
        // 按住 Shift 等比缩放（图片最常用）
        if (m.shiftKey && dir.length === 2) { const r = o.w / o.h; if (w / hh > r) w = hh * r; else hh = w / r; if (dir.includes('w')) x = o.x + o.w - w; if (dir.includes('n')) y = o.y + o.h - hh; }
        if (w < 20) { if (dir.includes('w')) x -= 20 - w; w = 20; }
        if (hh < 20) { if (dir.includes('n')) y -= 20 - hh; hh = 20; }
        // 只吸附拖动的那几条边：对边不动，否则只改大小也会把元素挪开一两个像素
        const nx = dir.includes('w') ? snap(x) : o.x, ny = dir.includes('n') ? snap(y) : o.y;
        Object.assign(e, {
          x: nx, y: ny,
          w: dir.includes('w') ? o.x + o.w - nx : dir.includes('e') ? snap(w) : o.w,
          h: dir.includes('n') ? o.y + o.h - ny : dir.includes('s') ? snap(hh) : o.h,
        });
      }
      for (const [k, v] of [['left', e.x], ['top', e.y], ['width', e.w], ['height', e.h]]) d.style.setProperty(/** @type {string} */ (k), v + 'px');
    };
    const up = (/** @type {PointerEvent} */ u) => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
      this.dragging = false;
      if (moved) {
        this._changed(false);
        if (e.t === 'embed' && e.kind === 'chart') this.embeds.redrawCharts();
      }
      if (this.pending || moved) this._render();
      // 单击就能打字：已经选中的文本框再点一下，或者还空着的（标题 / 正文占位框）点一下
      if (!moved && dir === 'move' && u.type === 'pointerup' && e.t === 'text' && (wasSel || !runsText(e.runs))) {
        this._startEdit(id, { x: u.clientX, y: u.clientY });
      }
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
  }

  /** @param {string | null} id */
  _select(id) {
    if (this.sel === id) return;
    // 原地换选中框，不重画整页：重画会把刚按下的元素换成新节点，之后的点击、拖动就落空了
    const old = this._node(this.sel);
    if (old) {
      old.classList.remove('sl-el--sel');
      for (const hd of old.querySelectorAll(':scope > .sl-h')) hd.remove();
    }
    this.sel = id;
    const nd = this._node(id);
    if (nd && id) this._addHandles(nd, id);
    this._syncSelTools();
  }

  /** @param {string} id @param {{x: number, y: number}} [pt] 点击的位置，光标放在那里 */
  _startEdit(id, pt) {
    if (this.readonly) return;
    this.editing = id;
    this.sel = id;
    const d = this._node(id);
    if (!d) return;
    d.classList.remove('sl-ph');
    d.classList.add('sl-el--sel');
    for (const hd of d.querySelectorAll('.sl-h')) hd.remove();
    d.contentEditable = 'true';
    d.focus();
    if (!pt || !caretAt(d, pt.x, pt.y)) placeCaret(d, Infinity);
    this._syncSelTools();
  }

  _readEditing() {
    const e = this._el(this.editing);
    const d = this._node(this.editing);
    if (!e || !d) return;
    e.runs = readRuns(d);
    this._changed(false);
  }

  _stopEdit() {
    if (!this.editing) return;
    this._readEditing();
    this.editing = null;
    this._render();
  }

  // ── 编辑操作 ───────────────────────────────────────────────────────────────

  /** @param {boolean} [redraw] 默认重画 */
  _changed(redraw = true) {
    if (this.readonly) return;
    this.dirty = true;
    if (redraw) this._renderSoon();
    clearTimeout(this._timer);
    this._timer = setTimeout(() => this._save(), SAVE_MS);
  }

  /** @param {number} i */
  go(i) {
    if (this.editing) this._stopEdit();
    this.cur = clamp(i, 0, Math.max(0, this.data.slides.length - 1));
    this.sel = null;
    this._render();
  }

  /** 当前主题（没选过就是简洁白）。 */
  _theme() { return slideTheme(this.data.theme); }

  /** @param {string} kind 见 themes.js 的 LAYOUTS */
  _addSlide(kind) {
    if (this.readonly) return;
    if (this.data.slides.length >= MAX_SLIDES) { this.opts.onStatus?.(tt('最多 {n} 页', { n: MAX_SLIDES }), 'error'); return; }
    const th = this.data.theme ? this._theme() : null;
    // 选过主题就用主题的背景和装饰；没选过沿用上一页的背景色
    const bg = th ? th.bg : this._slide()?.bg ?? '#ffffff';
    const at = this.data.slides.length ? this.cur + 1 : 0;
    const els = layout(/** @type {any} */ (this.data.slides.length ? kind : 'title'), th);
    this.data.slides.splice(at, 0, { id: uid('s'), bg, els: th ? [...themeDeco(th), ...els] : els });
    this.cur = at;
    this.sel = null;
    this._changed();
  }

  /** @param {number} i */
  _dupSlide(i) {
    const sl = this.data.slides[i];
    if (!sl || this.readonly) return;
    const copy = structuredClone(sl);
    copy.id = uid('s');
    for (const e of copy.els) e.id = uid('e');
    this.data.slides.splice(i + 1, 0, copy);
    this.cur = i + 1;
    this._changed();
  }

  /** @param {number} from @param {number} to */
  _moveSlide(from, to) {
    if (this.readonly) return;
    const [sl] = this.data.slides.splice(from, 1);
    this.data.slides.splice(to, 0, sl);
    this.cur = to;
    this._changed();
  }

  /** @param {number} i */
  async _delSlide(i) {
    const sl = this.data.slides[i];
    if (!sl || this.readonly) return;
    if (sl.els.length) {
      const { confirmDialog } = await import('../ui/dialog.js');
      if (!(await confirmDialog(tt('删除幻灯片'), tt('确定删除第 {i} 页？', { i: i + 1 }), { ok: tt('删除'), danger: true }))) return;
    }
    const k = this.data.slides.findIndex((/** @type {any} */ s) => s.id === sl.id);
    if (k < 0) return;
    this.data.slides.splice(k, 1);
    this.cur = Math.min(k, this.data.slides.length - 1);
    this.sel = null;
    this._changed();
  }

  /** @param {any} e @param {boolean} [edit] 插入后直接开始打字 */
  _addEl(e, edit = false) {
    if (this.readonly) return;
    if (!this._slide()) this._addSlide('blank');
    const sl = this._slide();
    if (!sl) return;
    if (sl.els.length >= MAX_ELS) { this.opts.onStatus?.(tt('一页最多 {n} 个元素', { n: MAX_ELS }), 'error'); return; }
    const el = { ...e, id: uid('e') };
    sl.els.push(el);
    this.sel = el.id;
    this._stopEdit();
    this._changed();
    if (edit) this._startEdit(el.id);
    return el;
  }

  // ── 形状、主题、模板 ───────────────────────────────────────────────────────

  /** @param {HTMLElement} anchor */
  _shapePop(anchor) {
    if (this.readonly) return;
    const close = popover(anchor, h('div', null, h('div', { class: 'dc-pop__t', text: tt('形状') }),
      h('div', { class: 'sl-shapes' }, ...SHAPES.map((sh) => {
        const b = card('sl-shape', () => { close?.(); this._addShape(sh.id); }, shapeIcon(sh));
        b.title = sh.label;
        b.setAttribute('aria-label', sh.label);
        return b;
      }))));
  }

  /** @param {string} id */
  _addShape(id) {
    const sh = SHAPE_BY_ID.get(id);
    if (!sh) return;
    if (sh.line) {
      const diag = id === 'diag';
      this._addEl({ t: 'shape', shape: id, stroke: this._theme().text, sw: 3, x: 330, y: diag ? 170 : 260, w: 300, h: diag ? 200 : 20 });
      return;
    }
    const fill = this.data.theme ? this._theme().accent : '#a5d8ff';
    const [w, hh] = sh.sq ? [180, 180] : [220, 140];
    this._addEl({ t: 'shape', shape: id, fill, x: Math.round((W - w) / 2), y: Math.round((H - hh) / 2), w, h: hh });
  }

  /** 主题卡片。 @param {(id: string) => void} onPick @param {string} cur */
  _themeGrid(onPick, cur) {
    return h('div', { class: 'sl-themes' }, ...SLIDE_THEMES.map((th) => {
      const mini = h('span', { class: 'sl-theme__mini' },
        h('span', { class: 'sl-theme__t', text: 'Aa' }), h('span', { class: 'sl-theme__l' }), h('span', { class: 'sl-theme__l sl-theme__l--s' }));
      mini.style.setProperty('background', th.bg);
      mini.style.setProperty('--th-title', th.title);
      mini.style.setProperty('--th-text', th.sub);
      mini.style.setProperty('--th-accent', th.deco[0]?.fill && th.deco[0].fill !== th.bg ? th.deco[0].fill : th.accent);
      const font = FONTS[th.font ?? 'sans'];
      if (font) mini.style.setProperty('font-family', font);
      return card('sl-theme' + (th.id === cur ? ' sl-theme--on' : ''), () => onPick(th.id), mini, h('span', { class: 'sl-theme__n', text: th.name }));
    }));
  }

  /** 模板卡片。 @param {(tpl: typeof DECK_TEMPLATES[number]) => void} fn @param {boolean} [skipBlank] */
  _tplGrid(fn, skipBlank = false) {
    return h('div', { class: 'dc-tpls' }, ...DECK_TEMPLATES.filter((t) => !skipBlank || t.id !== 'blank').map((t) => card('dc-tpl', () => fn(t),
      h('span', { class: 'dc-tpl__i', text: t.icon }), h('span', { class: 'dc-tpl__n', text: t.name }),
      h('span', { class: 'dc-tpl__d', text: tt('{desc} · {n} 页', { desc: t.desc, n: t.slides.length }) }))));
  }

  /** @param {HTMLElement} anchor */
  _themePop(anchor) {
    if (this.readonly) return;
    const close = popover(anchor, h('div', null,
      h('div', { class: 'dc-pop__t', text: tt('主题（应用到全部幻灯片）') }),
      this._themeGrid((id) => { close?.(); this._applyTheme(id); }, this.data.theme ?? ''),
      h('div', { class: 'dc-pop__t', text: tt('插入模板页（接在最后，用当前主题）') }),
      this._tplGrid((t) => { close?.(); this._useTemplate(t); }, true)), 'sl-pop');
  }

  /** @param {string} id */
  _applyTheme(id) {
    if (this.readonly) return;
    this._stopEdit();
    applyTheme(this.data, id);
    this.sel = null;
    this._changed();
    this.opts.onStatus?.(tt('已应用主题「{name}」', { name: slideTheme(id).name }));
  }

  /** 空幻灯片：整份换成模板；已有内容：模板页接在最后。 @param {typeof DECK_TEMPLATES[number]} tpl @param {string} [themeId] */
  _useTemplate(tpl, themeId) {
    if (this.readonly) return;
    this._stopEdit();
    const deck = deckFromTemplate(tpl, themeId ?? this.data.theme ?? 'plain');
    if (!this.data.slides.length) {
      this.data = deck;
      this.cur = 0;
    } else {
      const room = MAX_SLIDES - this.data.slides.length;
      if (room <= 0) { this.opts.onStatus?.(tt('最多 {n} 页', { n: MAX_SLIDES }), 'error'); return; }
      this.cur = this.data.slides.length;
      this.data.slides.push(...deck.slides.slice(0, room));
    }
    this.sel = null;
    this._changed();
  }

  /** 还没有幻灯片时的起始页：先挑主题，再挑模板。 */
  _startPanel() {
    const box = h('div', { class: 'sl-start' });
    const paint = () => box.replaceChildren(
      h('div', { class: 'sl-start__h', text: tt('新建演示文稿') }),
      h('div', { class: 'sl-start__t', text: tt('① 选一个主题') }),
      this._themeGrid((id) => { this._startTheme = id; paint(); }, this._startTheme ?? 'plain'),
      h('div', { class: 'sl-start__t', text: tt('② 选一个模板开始') }),
      this._tplGrid((t) => this._useTemplate(t, this._startTheme ?? 'plain')));
    paint();
    return box;
  }

  /** @param {any} patch */
  _patch(patch) {
    const e = this._el(this.sel);
    if (!e || this.readonly) return;
    if (this.editing) this._readEditing();
    for (const [k, v] of Object.entries(patch)) { if (v === undefined) delete e[k]; else e[k] = v; }
    const keep = this.editing;
    this.editing = null;
    this._changed();
    this._render();
    if (keep) this._startEdit(keep);
  }

  /** @param {number} d 1 顶层 · -1 底层 */
  _order(d) {
    const sl = this._slide();
    const i = sl?.els.findIndex((/** @type {any} */ e) => e.id === this.sel) ?? -1;
    if (!sl || i < 0 || this.readonly) return;
    const [e] = sl.els.splice(i, 1);
    // 置于底层也要压在主题装饰上面，否则被背景块挡住
    if (d > 0) sl.els.push(e); else sl.els.splice(sl.els.filter((/** @type {any} */ x) => x.deco).length, 0, e);
    this._changed();
  }

  _dupEl() {
    const e = this._el(this.sel);
    if (!e) return;
    this._addEl({ ...structuredClone(e), id: undefined, x: e.x + 16, y: e.y + 16 });
  }

  _delEl() {
    const sl = this._slide();
    if (!sl || !this.sel || this.readonly) return;
    this.editing = null;
    sl.els = sl.els.filter((/** @type {any} */ e) => e.id !== this.sel);
    this.sel = null;
    this._changed();
  }

  // ── 导入 / 导出 ───────────────────────────────────────────────────────────

  async _import() {
    if (this.readonly) return;
    const X = await import('./exchange.js');
    const file = await X.pickFile('.pptx,.pptm,.ppsx,.potx,.key,.ppt');
    if (!file) return;
    try {
      const { slides, notes } = await X.importSlidesFile(file, this.tableId, (m) => this.opts.onStatus?.(m));
      if (this.readonly) return;
      this._stopEdit();
      if (slides.some((/** @type {any} */ sl) => sl.els.length > MAX_ELS)) notes.push(tt('有的页元素超过 {n} 个，多出来的没有导入', { n: MAX_ELS }));
      const keep = normDeck(this.data).slides;
      const room = MAX_SLIDES - keep.length;
      if (room <= 0) { this.opts.onStatus?.(tt('最多 {n} 页', { n: MAX_SLIDES }), 'error'); return; }
      if (slides.length > room) notes.push(tt('最多 {max} 页，只导入了前 {n} 页', { max: MAX_SLIDES, n: room }));
      const add = X.fitSize(normDeck({ slides: slides.slice(0, room) }).slides, (l) => ({ ...this.data, slides: [...keep, ...l] }), notes, tt('页'));
      if (!add.length) { this.opts.onStatus?.(notes.length ? tt('没有可以导入的幻灯片：{notes}', { notes: notes.join(tt('；')) }) : tt('没有可以导入的幻灯片'), 'error'); return; }
      this.cur = keep.length;
      this.data = { ...this.data, slides: [...keep, ...add] };
      this.sel = null;
      this._changed();
      this._save();
      this.opts.onStatus?.(notes.length ? tt('已导入 {name}（{n} 页）。{notes}', { name: file.name, n: add.length, notes: notes.join(tt('；')) }) : tt('已导入 {name}（{n} 页）', { name: file.name, n: add.length }));
    } catch (e) {
      this.opts.onStatus?.(/** @type {Error} */ (e).message || tt('导入失败'), 'error');
    }
  }

  async _export() {
    const X = await import('./exchange.js');
    const { toPptx } = await import('../io/pptx.js');
    if (this.editing) this._readEditing();
    const deck = normDeck(this.data);
    const name = X.safeName(this.nameEl.textContent ?? '');
    this.opts.onStatus?.(tt('正在导出…'));
    try {
      const ids = deck.slides.flatMap((/** @type {any} */ sl) => sl.els.filter((/** @type {any} */ e) => e.t === 'img' && typeof e.img === 'string').map((/** @type {any} */ e) => e.img));
      const images = await X.collectImages(this.tableId, ids);
      /** @type {Map<string, any>} */ const embeds = new Map();
      if (deck.slides.some((/** @type {any} */ sl) => sl.els.some((/** @type {any} */ e) => e.t === 'embed'))) {
        // 打印区平时是隐藏的，图表画不出尺寸：导出时先挪到屏幕外显示出来
        this.printBox.classList.add('sl-print--snap');
        try {
          this._fillPrint();
          await X.embedsSettled(this.printBox);
          this.embeds.redrawCharts();
          for (const sl of deck.slides) for (const e of sl.els) {
            if (e.t !== 'embed') continue;
            const snap = await X.snapEmbed(this.printBox.querySelector('[data-id="' + CSS.escape(e.id) + '"]'));
            if (snap) embeds.set(e.id, snap);
          }
        } finally { this.printBox.classList.remove('sl-print--snap'); }
      }
      const font = slideTheme(deck.theme).font ?? 'sans';
      X.download(new Blob([toPptx(deck, { images, embeds, title: name, font })], { type: X.PPTX_MIME }), name + '.pptx');
      this.opts.onStatus?.(tt('已导出 {name}', { name: name + '.pptx' }));
    } catch (e) {
      this.opts.onStatus?.(/** @type {Error} */ (e).message || tt('导出失败'), 'error');
    }
  }

  _pickImage() {
    if (this.readonly) return;
    const input = /** @type {HTMLInputElement} */ (h('input', { type: 'file', accept: 'image/*' }));
    input.addEventListener('change', () => { const f = input.files?.[0]; if (f) void this._uploadImage(f); });
    input.click();
  }

  /** @param {File} file */
  async _uploadImage(file) {
    if (this.readonly) return;
    const { upload, prepare, isImage, MAX_BYTES: MAX_FILE } = await import('../io/attach.js');
    if (!isImage(file.type)) { this.opts.onStatus?.(tt('只能插入图片（PNG、JPEG、GIF、WebP）'), 'error'); return; }
    const f = await prepare(file);
    if (f.size > MAX_FILE) { this.opts.onStatus?.(tt('图片太大了，最大 10MB'), 'error'); return; }
    this.opts.onStatus?.(tt('正在上传图片…'));
    try {
      const res = await upload(this.tableId, f);
      // 按图片本身的比例放，最大占画面的 60%
      const dim = await imageSize(f);
      const r = dim ? dim.w / dim.h : 4 / 3;
      let w = 480, hh = w / r;
      if (hh > 360) { hh = 360; w = hh * r; }
      this._addEl({ t: 'img', img: res.id, x: Math.round((W - w) / 2), y: Math.round((H - hh) / 2), w: Math.round(w), h: Math.round(hh) });
    } catch (e) {
      this.opts.onStatus?.(/** @type {Error} */ (e).message || tt('上传失败'), 'error');
    }
  }

  async _pickEmbed() {
    if (this.readonly) return;
    const b = await pickEmbed(this.opts.tables?.() ?? []);
    if (!b) return;
    const size = b.kind === 'chart' ? { x: 130, y: 90, w: 700, h: 400 } : { x: 80, y: 90, w: 800, h: 400 };
    const el = this._addEl({ ...b, ...size });
    if (el) this.embeds.register([el]);
  }

  // ── 键盘 / 粘贴 ────────────────────────────────────────────────────────────

  /** 焦点在别的输入框里（对话框、备注、改名）就不抢键。 */
  _mine() {
    const a = /** @type {HTMLElement | null} */ (document.activeElement);
    if (this._show) return false;
    if (a?.isContentEditable && !a.closest('.sl-stage')) return false;
    if (!this.root.isConnected || document.querySelector('.ui-dialog, .dialog')) return false;
    if (a && a !== document.body && !this.root.contains(a)) return false;
    return !(a && (a.tagName === 'INPUT' || a.tagName === 'TEXTAREA' || a.tagName === 'SELECT'));
  }

  /** @param {KeyboardEvent} e */
  _key(e) {
    if (!this._mine()) return;
    const mod = e.ctrlKey || e.metaKey;
    if (e.key === 'F5') { e.preventDefault(); this.present(e.shiftKey ? this.cur : 0); return; }
    if (this.editing) {
      if (e.key === 'Escape') { e.preventDefault(); this._stopEdit(); }
      return;
    }
    if (e.key === 'PageDown' || (!this.sel && (e.key === 'ArrowDown' || e.key === 'ArrowRight'))) { e.preventDefault(); this.go(this.cur + 1); return; }
    if (e.key === 'PageUp' || (!this.sel && (e.key === 'ArrowUp' || e.key === 'ArrowLeft'))) { e.preventDefault(); this.go(this.cur - 1); return; }
    if (this.readonly) return;
    if (mod && e.key.toLowerCase() === 'm') { e.preventDefault(); this._addSlide('content'); return; }
    if (!this.sel) {
      if ((e.key === 'Delete' || e.key === 'Backspace') && document.activeElement?.closest?.('.sl-rail')) { e.preventDefault(); void this._delSlide(this.cur); }
      if (mod && e.key.toLowerCase() === 'v' && this._clip) { e.preventDefault(); this._addEl({ ...structuredClone(this._clip), id: undefined }); }
      return;
    }
    const el = this._el(this.sel);
    if (!el) return;
    if (e.key === 'Escape') { this._select(null); return; }
    if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); this._delEl(); return; }
    if (e.key === 'Enter' && el.t === 'text') { e.preventDefault(); this._startEdit(el.id); return; }
    if (mod && e.key.toLowerCase() === 'd') { e.preventDefault(); this._dupEl(); return; }
    if (mod && e.key.toLowerCase() === 'c') { this._clip = structuredClone(el); this._clip.x += 16; this._clip.y += 16; return; }
    if (mod && e.key.toLowerCase() === 'v' && this._clip) { e.preventDefault(); this._addEl({ ...structuredClone(this._clip), id: undefined }); return; }
    const step = e.shiftKey ? 10 : 1;
    const arrows = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] };
    const mv = /** @type {any} */ (arrows)[e.key];
    if (mv) {
      e.preventDefault();
      el.x = clamp(el.x + mv[0], -el.w + 10, W - 10);
      el.y = clamp(el.y + mv[1], -el.h + 10, H - 10);
      this._changed();
    }
  }

  /** @param {ClipboardEvent} e */
  _paste(e) {
    if (this.readonly || !this.root.isConnected) return;
    const a = document.activeElement;
    if (this.editing) {
      // 文本框里只收纯文本
      e.preventDefault();
      const text = e.clipboardData?.getData('text/plain') ?? '';
      // insertText 遇到 \n 会插 <div>，readRuns 不认：逐行插入，行间用 <br>
      text.replace(/\r\n?/g, '\n').split('\n').forEach((line, k) => {
        if (k) exec('insertLineBreak');
        if (line) exec('insertText', line);
      });
      return;
    }
    if (a && a !== document.body && !this.root.contains(a)) return;
    if (a && (a.tagName === 'INPUT' || a.tagName === 'TEXTAREA')) return;
    const files = [...(e.clipboardData?.files ?? [])].filter((f) => f.type.startsWith('image/'));
    if (files.length) { e.preventDefault(); for (const f of files.slice(0, 5)) void this._uploadImage(f); return; }
    const text = (e.clipboardData?.getData('text/plain') ?? '').trim();
    if (text) {
      e.preventDefault();
      this._addEl({ t: 'text', runs: [[text.slice(0, 4000)]], size: 22, color: this._theme().text, align: 'left', x: 180, y: 160, w: 600, h: 200, role: 'body' });
    }
  }

  // ── 保存与同步 ─────────────────────────────────────────────────────────────

  _save() {
    clearTimeout(this._timer);
    if (this.readonly || !this.dirty) return;
    if (this.editing) this._readEditing();
    const deck = normDeck(this.data);
    this.dirty = false;
    const json = JSON.stringify(deck);
    if (json === this.lastJson) return;
    if (new TextEncoder().encode(json).length > MAX_BYTES) {
      this.opts.onStatus?.(tt('幻灯片太大了（超过 256KB），这次修改没有保存。可以删掉一些页，或拆成几份。'), 'error');
      return;
    }
    this.lastJson = json;
    this.unacked = true;           // base 仍是服务端上一版，等回声到了再前移
    this.model.apply([{ t: 'setProp', key: 'slides', value: deck }], { local: true });
    // 缩略图跟上刚才的打字 / 拖动
    if (!this.editing && !this.dragging) this._renderRail();
  }

  _remote() {
    const theirs = normDeck(this.model.props?.slides);
    const json = JSON.stringify(theirs);
    if (json === this.lastJson) { this.base = theirs; this.unacked = false; return; }   // 自己的回声
    const curId = this._slide()?.id;
    // 自己保存的那版还没回声：这份是服务端排在它前面的，不含我的改动，同样要合并
    if ((this.dirty || this.unacked) && !this.readonly) {
      if (this.editing) this._readEditing();
      this.data = normDeck(mergeSlides(this.base, this.data, theirs));
      this.base = theirs;
      this.lastJson = json;
      this.dirty = true;
      this._save();
    } else {
      this.data = structuredClone(theirs);
      this.base = theirs;
      this.lastJson = json;
    }
    // 还停在原来那一页（按 id 找，别人插了页也不跳）
    const k = this.data.slides.findIndex((/** @type {any} */ s) => s.id === curId);
    if (k >= 0) this.cur = k;
    this._renderSoon();
    this._show?.refresh();
  }

  // ── 放映与打印 ─────────────────────────────────────────────────────────────

  /** 全屏放映。←/→、空格、PageUp/PageDown、点击翻页，Esc 退出。 @param {number} start */
  present(start) {
    if (!this.data.slides.length) { this.opts.onStatus?.(tt('还没有幻灯片'), 'error'); return; }
    if (this.editing) this._stopEdit();
    this._show?.close();
    let i = clamp(start, 0, this.data.slides.length - 1);
    const box = h('div', { class: 'sl-show', attrs: { role: 'dialog', 'aria-label': tt('放映'), tabindex: '-1' } });
    const num = h('div', { class: 'sl-show__n' });
    const paint = () => {
      i = clamp(i, 0, this.data.slides.length - 1);
      const sl = this.data.slides[i];
      if (!sl) { close(); return; }
      const el = this._slideEl(sl, 'show');
      const s = Math.min(window.innerWidth / W, window.innerHeight / H);
      el.style.setProperty('transform', 'translate(' + Math.round((window.innerWidth - W * s) / 2) + 'px,' + Math.round((window.innerHeight - H * s) / 2) + 'px) scale(' + s + ')');
      num.textContent = (i + 1) + ' / ' + this.data.slides.length;
      box.replaceChildren(el, num);
      this.embeds.prune();
    };
    const key = (/** @type {KeyboardEvent} */ e) => {
      if (['ArrowRight', 'ArrowDown', 'PageDown', ' ', 'Enter', 'n'].includes(e.key)) { e.preventDefault(); if (i < this.data.slides.length - 1) { i++; paint(); } }
      else if (['ArrowLeft', 'ArrowUp', 'PageUp', 'Backspace', 'p'].includes(e.key)) { e.preventDefault(); if (i > 0) { i--; paint(); } }
      else if (e.key === 'Home') { e.preventDefault(); i = 0; paint(); }
      else if (e.key === 'End') { e.preventDefault(); i = this.data.slides.length - 1; paint(); }
      else if (e.key === 'Escape') { e.preventDefault(); close(); }
    };
    const onFs = () => { if (!document.fullscreenElement && this._show) close(); };
    const close = () => {
      document.removeEventListener('keydown', key, true);
      document.removeEventListener('fullscreenchange', onFs);
      window.removeEventListener('resize', paint);
      if (document.fullscreenElement) void document.exitFullscreen().catch(() => {});
      box.remove();
      this._show = null;
      this.go(i);
    };
    box.addEventListener('click', (e) => {
      if (/** @type {HTMLElement} */ (e.target).closest('a, .emb__scroll')) return;
      if (e.clientX < window.innerWidth / 4) { if (i > 0) { i--; paint(); } }
      else if (i < this.data.slides.length - 1) { i++; paint(); }
    });
    document.addEventListener('keydown', key, true);
    document.addEventListener('fullscreenchange', onFs);
    window.addEventListener('resize', paint);
    document.body.append(box);
    this._show = { close, refresh: paint };
    paint();
    box.focus();
    void box.requestFullscreen?.().catch(() => { /* 不给全屏就在窗口里放 */ });
  }

  /** 打印：每页一张。 */
  _fillPrint() {
    const scale = 0.72;
    this.printBox.replaceChildren(...this.data.slides.map((/** @type {any} */ sl) => {
      const el = this._slideEl(sl, 'show');
      el.style.setProperty('transform', 'scale(' + scale + ')');
      const cell = h('div', { class: 'sl-print__page' }, el);
      cell.style.setProperty('width', W * scale + 'px');
      cell.style.setProperty('height', H * scale + 'px');
      cell.style.setProperty('overflow', 'hidden');
      cell.style.setProperty('margin', '0 auto 16px');
      cell.style.setProperty('break-after', 'page');
      return cell;
    }));
  }
}

/** 图片的原始尺寸。 @param {Blob} f */
async function imageSize(f) {
  try {
    const bmp = await createImageBitmap(f);
    const r = { w: bmp.width, h: bmp.height };
    bmp.close?.();
    return r.w && r.h ? r : null;
  } catch {
    return null;
  }
}

const SVG = 'http://www.w3.org/2000/svg';

/** 把形状画进元素：矩形 / 圆角 / 椭圆用 CSS，其它用拉伸的 SVG 路径。 @param {HTMLElement} d @param {any} e */
function shapeInto(d, e) {
  const sh = SHAPE_BY_ID.get(e.shape) ?? SHAPES[0];
  const fill = e.fill === 'none' ? 'none' : isHex(e.fill) ? e.fill : '#a5d8ff';
  const sw = strokeWidth(e.sw ?? (sh.line ? 3 : 0));
  const stroke = isHex(e.stroke) ? e.stroke : sh.line && fill !== 'none' ? fill : '#1f2328';
  if (!sh.d) {
    d.classList.add('sl-el--' + (sh.id === 'ellipse' ? 'ellipse' : sh.id === 'round' ? 'round' : 'shape'));
    d.style.setProperty('background', fill === 'none' ? 'transparent' : fill);
    if (sw) d.style.setProperty('border', sw + 'px solid ' + stroke);
    return;
  }
  d.classList.add('sl-el--shape', 'sl-el--svg');
  if (e.flip) d.style.setProperty('transform', 'scaleX(-1)');
  const svg = document.createElementNS(SVG, 'svg');
  svg.setAttribute('class', 'sl-svg');
  svg.setAttribute('viewBox', '0 0 100 100');
  svg.setAttribute('preserveAspectRatio', 'none');
  const path = document.createElementNS(SVG, 'path');
  path.setAttribute('d', sh.d);
  path.setAttribute('fill', sh.line ? 'none' : fill);
  if (sh.rule) path.setAttribute('fill-rule', sh.rule);
  if (sw) {
    path.setAttribute('stroke', stroke);
    path.setAttribute('stroke-width', String(sw));
    path.setAttribute('vector-effect', 'non-scaling-stroke');
    path.setAttribute('stroke-linejoin', 'round');
    path.setAttribute('stroke-linecap', 'round');
  }
  svg.append(path);
  d.append(svg);
}

/** 形状面板里的小图标。 @param {typeof SHAPES[number]} sh */
function shapeIcon(sh) {
  const svg = document.createElementNS(SVG, 'svg');
  svg.setAttribute('viewBox', '-6 -6 112 112');
  svg.setAttribute('class', 'sl-shape__ic');
  const el = document.createElementNS(SVG, sh.d ? 'path' : sh.id === 'ellipse' ? 'ellipse' : 'rect');
  if (sh.d) el.setAttribute('d', sh.d);
  else if (sh.id === 'ellipse') for (const [k, v] of [['cx', '50'], ['cy', '50'], ['rx', '50'], ['ry', '50']]) el.setAttribute(k, v);
  else {
    for (const [k, v] of [['x', '0'], ['y', '15'], ['width', '100'], ['height', '70']]) el.setAttribute(k, v);
    if (sh.id === 'round') { el.setAttribute('rx', '16'); el.setAttribute('ry', '16'); }
  }
  if (sh.rule) el.setAttribute('fill-rule', sh.rule);
  el.setAttribute('class', sh.line ? 'sl-shape__line' : 'sl-shape__fill');
  svg.append(el);
  return svg;
}

/** 把光标放到屏幕坐标处；落在 d 外面就返回 false。 @param {HTMLElement} d @param {number} x @param {number} y */
function caretAt(d, x, y) {
  /** @type {Range | null} */ let r = null;
  const doc = /** @type {any} */ (document);
  if (doc.caretPositionFromPoint) {
    const p = doc.caretPositionFromPoint(x, y);
    if (p) { r = document.createRange(); r.setStart(p.offsetNode, p.offset); }
  } else if (doc.caretRangeFromPoint) r = doc.caretRangeFromPoint(x, y);
  if (!r || !d.contains(r.startContainer)) return false;
  r.collapse(true);
  const sel = window.getSelection();
  sel?.removeAllRanges();
  sel?.addRange(r);
  return true;
}
