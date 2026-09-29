/**
 * 文档（kind = 'doc'）：类似 Word 的富文本编辑器。
 *
 * 存储：整份文档是表属性 props.doc（setProp，走同一套 SyncEngine / DO / 权限 / 公开链接）。
 *   { blocks: [{ id, t, runs?, align?, indent?, checked?, img?, w?, cap?, src?, kind?, range?, cfg?, fields?, title? }] }
 *   t：p h1 h2 h3 quote code ul ol todo（文字块）· hr img embed（整块，不可在里面打字）
 *
 * 编辑器是一整个 contenteditable，每个块是它的一个直接子元素（带 data-id / data-t）。
 * 打字交给浏览器，停手 0.6 秒后把 DOM 读回成 blocks 保存。别人改了：本地没有未保存的改动就直接重画；
 * 有的话按块三方合并（docmerge.js），合并结果重画并立即保存。
 */

import { h } from '../ui/dom.js';
import { t as tt } from '../../shared/i18n/i18n.js';
import { openMenu } from '../ui/menu.js';
import { uid } from '../../shared/util/uid.js';
import { mergeDoc } from '../../shared/model/docmerge.js';
import { EmbedHost, pickEmbed } from './embed.js';
import {
  renderRuns, readRuns, runsText, exec, rangeIn, wrapSelection, caretOffset, placeCaret, safeHref, isHex,
} from './runs.js';
import { DOC_THEMES, DOC_TEMPLATES, DOC_VARS, docThemeVars, docFromTemplate, isDocTheme } from './themes.js';

const SAVE_MS = 600;
/** 与 ops.js 的 MAX_PROP_BYTES 一致 */
const MAX_BYTES = 256 * 1024;
const TEXT_TYPES = new Set(['p', 'h1', 'h2', 'h3', 'quote', 'code', 'ul', 'ol', 'todo']);
const LIST_TYPES = new Set(['ul', 'ol', 'todo']);
const TAG = { p: 'p', h1: 'h1', h2: 'h2', h3: 'h3', quote: 'blockquote', code: 'pre', ul: 'div', ol: 'div', todo: 'div' };
const BLOCK_MENU = [['p', tt('正文')], ['h1', tt('标题 1')], ['h2', tt('标题 2')], ['h3', tt('标题 3')], ['quote', tt('引用')], ['code', tt('代码块')],
  ['ul', tt('• 无序列表')], ['ol', tt('1. 有序列表')], ['todo', tt('☐ 待办')]];
const STATE_LABEL = { loading: tt('载入中…'), connecting: tt('连接中…'), syncing: tt('同步中…'), online: tt('已同步'), offline: tt('离线'), readonly: tt('只读') };

/** @param {string} s */
const connTone = (s) => (s === 'online' ? 'ok' : s === 'offline' ? 'bad' : s === 'readonly' ? 'muted' : 'wait');

/**
 * 文档和幻灯片共用的外框：顶部工具条 + 中间 + 底部状态栏，和表格长得一样。
 * @param {HTMLElement} host @param {string} name @param {string} cls
 */
export function shell(host, name, cls) {
  host.replaceChildren();
  const nameEl = h('div', { class: 'grid__name', text: name });
  const tools = h('div', { class: 'dc-tools' });
  const bar = h('div', { class: 'grid__toolbar' }, nameEl, tools);
  const conn = h('div', { class: 'grid__conn' });
  const stat = h('div', { class: 'grid__stat' });
  const ro = h('div', { class: 'grid__stat grid__ro' });
  ro.hidden = true;
  const status = h('div', { class: 'grid__status' }, conn, stat, h('div', { class: 'grid__spacer' }), ro);
  const body = h('div', { class: cls });
  const root = h('div', { class: 'grid dc-shell' }, bar, body, status);
  host.append(root);
  return { root, nameEl, tools, body, conn, stat, ro };
}

/** 工具条按钮。 @param {string} text @param {string} title @param {() => void} fn @param {string} [cls] */
export function tbtn(text, title, fn, cls = '') {
  const b = h('button', { class: 'grid__btn dc-btn ' + cls, type: 'button', text, title, attrs: { 'aria-label': title } });
  // 按下时不抢焦点，选区还留在编辑区里
  b.addEventListener('mousedown', (/** @type {MouseEvent} */ e) => e.preventDefault());
  b.addEventListener('click', fn);
  return b;
}

/** 取色按钮：一个小色块 + 隐藏的 <input type=color>。 @param {string} label @param {string} title @param {string} init @param {(c: string) => void} fn */
export function colorBtn(label, title, init, fn) {
  const input = /** @type {HTMLInputElement} */ (h('input', { type: 'color', class: 'dc-color__in', value: init, attrs: { 'aria-label': title } }));
  const sw = h('span', { class: 'dc-color__sw' });
  sw.style.setProperty('background', init);
  const wrap = h('label', { class: 'grid__btn dc-btn dc-color', title }, h('span', { text: label }), sw, input);
  wrap.addEventListener('mousedown', () => { /* 让 input 自己弹出 */ });
  input.addEventListener('change', () => { sw.style.setProperty('background', input.value); fn(input.value); });
  return wrap;
}

/** @type {(() => void) | null} 当前打开的弹层 */
let closePop = null;

/**
 * 工具条按钮下面弹出的面板（主题、模板、形状）。点外面或按 Esc 关闭；再点同一个按钮也关闭。
 * @param {HTMLElement} anchor @param {HTMLElement} content @param {string} [cls]
 */
export function popover(anchor, content, cls = '') {
  const again = closePop && anchor.dataset.popOpen === '1';
  closePop?.();
  if (again) return null;
  const box = h('div', { class: 'dc-pop ' + cls, attrs: { role: 'dialog' } }, content);
  document.body.append(box);
  const r = anchor.getBoundingClientRect();
  const w = box.offsetWidth, hh = box.offsetHeight;
  box.style.setProperty('left', Math.max(8, Math.min(r.left, window.innerWidth - w - 8)) + 'px');
  box.style.setProperty('top', Math.max(8, Math.min(r.bottom + 4, window.innerHeight - hh - 8)) + 'px');
  anchor.dataset.popOpen = '1';
  const out = (/** @type {Event} */ e) => { if (!box.contains(/** @type {Node} */ (e.target)) && !anchor.contains(/** @type {Node} */ (e.target))) close(); };
  const key = (/** @type {KeyboardEvent} */ e) => { if (e.key === 'Escape') { e.stopPropagation(); close(); } };
  const close = () => {
    document.removeEventListener('pointerdown', out, true);
    document.removeEventListener('keydown', key, true);
    delete anchor.dataset.popOpen;
    box.remove();
    if (closePop === close) closePop = null;
  };
  document.addEventListener('pointerdown', out, true);
  document.addEventListener('keydown', key, true);
  closePop = close;
  return close;
}

/** 弹层里的一张卡片按钮。 @param {string} cls @param {() => void} fn @param {...any} kids */
export function card(cls, fn, ...kids) {
  const b = h('button', { class: cls, type: 'button' }, ...kids);
  b.addEventListener('mousedown', (/** @type {MouseEvent} */ e) => e.preventDefault());
  b.addEventListener('click', fn);
  return b;
}

export class DocView {
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
    this.readonly = true;          // 连上、确认有编辑权限之后才打开
    this.loaded = false;
    this.dirty = false;
    this._timer = 0;
    /** 上次同步到的版本（合并的 base） */ this.base = /** @type {any} */ ({ blocks: [] });
    /** 上次发出去的 JSON：自己的回声不用重画 */ this.lastJson = '';
    /** 自己保存的那版还没等到回声（这期间收到的别人的版本不含我的改动，要合并） */ this.unacked = false;
    /** @type {Map<string, any>} 整块（hr / img / embed）的数据 */ this.solid = new Map();
    this.embeds = new EmbedHost(this.tableId, { path: opts.extPath, onError: (m) => opts.onStatus?.(m, 'error') });

    const s = shell(host, opts.name, 'dc-body');
    Object.assign(this, { root: s.root, nameEl: s.nameEl, statConn: s.conn, statInfo: s.stat, roNote: s.ro });
    this.page = h('div', { class: 'dc-page' });
    this.ed = h('div', { class: 'dc-ed', attrs: { spellcheck: 'false', role: 'textbox', 'aria-multiline': 'true', 'aria-label': tt('文档内容') } });
    /** 文档是空的时候，编辑区下面给一排模板 */
    this.startBox = h('div', { class: 'dc-start' });
    this.startBox.hidden = true;
    this.page.append(this.ed, this.startBox);
    s.body.append(this.page);
    /** @type {string | undefined} 文档主题 */ this.theme = undefined;
    this._buildTools(s.tools);

    this.ed.addEventListener('input', () => this._changed());
    this.ed.addEventListener('keydown', (e) => this._key(e));
    this.ed.addEventListener('paste', (e) => this._paste(e));
    this.ed.addEventListener('drop', (e) => this._drop(e));
    this.ed.addEventListener('click', (e) => this._click(e));
    this._onSel = () => this._syncTools();
    document.addEventListener('selectionchange', this._onSel);
    this._ro = new ResizeObserver(() => this.embeds.redrawCharts());
    this._ro.observe(this.page);

    this._unsub = this.model.subscribe((/** @type {any[]} */ ops, /** @type {{local: boolean}} */ meta) => {
      if (meta.local) return;
      if (!ops.some((o) => o.t === 'bulk' || (o.t === 'setProp' && o.key === 'doc'))) return;
      this._remote();
    });
    this.base = this._docOf();    // 空 base 会让合并把每一块都当成「我新增的」，别人的修改全被盖掉
    this._render(this.base, false);
    this._setEditable();
  }

  // ── 外部接口（与 Grid 同名，main.js 统一调用） ─────────────────────────────

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
    // 第一次同步完成之前不许打字：否则快照一到就会把刚打的字盖掉
    if (s === 'online' || s === 'readonly') this.loaded = true;
    if (this.sync?.readonly && !this.opts.publicMode) this.setReadonlyReason(tt('只读权限：你可以查看，但不能修改这份文档'));
    this._setEditable();
  }

  /** @param {string} msg */
  setReadonlyReason(msg) {
    this.roNote.textContent = msg;
    this.roNote.hidden = false;
    this._forceRo = true;
    this._setEditable();
  }

  setPeers() { /* 文档里暂不画别人的光标；在线头像由顶栏负责 */ }
  setScope() { /* 文档没有分视图 */ }

  destroy() {
    if (this.dirty) this._save();
    clearTimeout(this._timer);
    this._unsub?.();
    this._ro.disconnect();
    document.removeEventListener('selectionchange', this._onSel);
    this.embeds.dispose();
    this.root.remove();
  }

  // ── 工具条 ────────────────────────────────────────────────────────────────

  /** @param {HTMLElement} bar */
  _buildTools(bar) {
    const typeSel = /** @type {HTMLSelectElement} */ (h('select', { class: 'dc-select', title: tt('段落样式'), attrs: { 'aria-label': tt('段落样式') } }));
    for (const [v, label] of BLOCK_MENU) typeSel.append(h('option', { value: v, text: label }));
    typeSel.addEventListener('change', () => { this._setType(typeSel.value); this.ed.focus(); });
    this.typeSel = typeSel;
    const inline = (/** @type {string} */ cmd) => () => { if (this._can()) { exec(cmd); this._changed(); } };
    this.editTools = h('div', { class: 'dc-group' },
      typeSel,
      tbtn('B', tt('加粗（Ctrl+B）'), inline('bold'), 'dc-b'),
      tbtn('I', tt('斜体（Ctrl+I）'), inline('italic'), 'dc-i'),
      tbtn('U', tt('下划线（Ctrl+U）'), inline('underline'), 'dc-u'),
      tbtn('S', tt('删除线'), inline('strikeThrough'), 'dc-s'),
      tbtn('</>', tt('行内代码'), () => this._wrap('code')),
      colorBtn('A', tt('文字颜色'), '#c62f55', (c) => { if (this._restore()) { exec('foreColor', c); this._changed(); } }),
      colorBtn('▮', tt('高亮（背景色）'), '#fcf6bd', (c) => this._wrap('bg', c)),
      tbtn('🔗', tt('插入链接（Ctrl+K）'), () => void this._link()),
      tbtn('⌫', tt('清除格式'), () => { if (this._can()) { exec('removeFormat'); exec('unlink'); this._changed(); } }),
      h('span', { class: 'dc-sep' }),
      tbtn('⇤', tt('左对齐'), () => this._align(null)),
      tbtn('↔', tt('居中'), () => this._align('center')),
      tbtn('⇥', tt('右对齐'), () => this._align('right')),
      tbtn('→|', tt('增加缩进（列表里按 Tab）'), () => this._indent(1)),
      tbtn('|←', tt('减少缩进（Shift+Tab）'), () => this._indent(-1)),
      h('span', { class: 'dc-sep' }),
      tbtn(tt('— 分割线'), tt('插入分割线'), () => this._insertSolid({ t: 'hr' })),
      tbtn(tt('🖼 图片'), tt('插入图片（也可以直接粘贴或拖进来）'), () => this._pickImage()),
      tbtn(tt('📊 表格内容'), tt('插入本内容里某张表的区域、图表或透视表（活数据）'), () => void this._pickEmbed()));
    // 选区离开编辑区时记住它：取色器、对话框会把焦点拿走
    this.ed.addEventListener('blur', () => { const r = rangeIn(this.ed); if (r) this._saved = r.cloneRange(); });
    const themeBtn = tbtn(tt('🎨 主题'), tt('文档主题：配色和字体'), () => this._themePop(themeBtn));
    const tplBtn = tbtn(tt('📋 模板'), tt('用模板开始（空文档里替换，否则加在末尾）'), () => this._tplPop(tplBtn));
    this.editTools.append(h('span', { class: 'dc-sep' }), themeBtn, tplBtn);
    const exportBtn = tbtn(tt('📤 导出'), tt('导出为 Word（.docx）或 PDF'), () => {
      const r = exportBtn.getBoundingClientRect();
      openMenu([
        { label: tt('Word 文档（.docx）'), icon: '📝', action: () => void this._export() },
        { label: tt('PDF（打印 → 另存为 PDF）'), icon: '🖨', action: () => window.print() },
      ], { x: r.left, y: r.bottom + 2 });
    });
    const right = h('div', { class: 'dc-group dc-group--right' },
      this.opts.publicMode ? null : (this.importBtn = tbtn(tt('📥 导入'), tt('导入 Word（.docx）、Pages、Markdown 或纯文本：空文档里替换，否则加在末尾'), () => void this._import())),
      this.opts.publicMode ? null : exportBtn,
      this.opts.onShare ? tbtn(tt('👥 分享'), tt('分享这份文档（权限与表格相同）'), () => this.opts.onShare?.()) : null);
    bar.append(this.editTools, h('div', { class: 'grid__spacer' }), right);
  }

  _setEditable() {
    const ro = !!this._forceRo || !!this.opts.publicMode || !this.loaded || !!this.sync?.readonly || !this.sync;
    this.readonly = ro;
    this.ed.contentEditable = ro ? 'false' : 'true';
    this.editTools.hidden = ro;
    if (this.importBtn) this.importBtn.hidden = ro;
    this.root.classList.toggle('dc-ro', ro);
    this._syncStart();
  }

  // ── 主题与模板 ─────────────────────────────────────────────────────────────

  /** @param {any} id */
  _setTheme(id) {
    this.theme = isDocTheme(id) ? id : undefined;
    for (const v of DOC_VARS) this.page.style.removeProperty(v);
    for (const [k, v] of docThemeVars(this.theme)) this.page.style.setProperty(k, v);
    if (this.theme) this.page.dataset.theme = this.theme; else delete this.page.dataset.theme;
    this.embeds.redrawCharts();
  }

  /** @param {HTMLElement} anchor */
  _themePop(anchor) {
    if (!this._can()) return;
    const grid = h('div', { class: 'dc-themes' }, ...DOC_THEMES.map((t) => {
      const sw = h('span', { class: 'dc-theme__sw' },
        h('span', { class: 'dc-theme__h', text: tt('标题') }), h('span', { class: 'dc-theme__l' }), h('span', { class: 'dc-theme__l dc-theme__l--s' }));
      for (const [k, v] of docThemeVars(t.id)) sw.style.setProperty(k, v);
      return card('dc-theme' + ((this.theme ?? 'default') === t.id ? ' dc-theme--on' : ''), () => {
        this._setTheme(t.id);
        this._changed();
        close?.();
      }, sw, h('span', { class: 'dc-theme__n', text: t.name }));
    }));
    const close = popover(anchor, h('div', null, h('div', { class: 'dc-pop__t', text: tt('文档主题') }), grid));
  }

  /** @param {HTMLElement} anchor */
  _tplPop(anchor) {
    if (!this._can()) return;
    const close = popover(anchor, h('div', null, h('div', { class: 'dc-pop__t', text: tt('文档模板') }),
      h('div', { class: 'dc-tpls' }, ...DOC_TEMPLATES.map((t) => card('dc-tpl', () => { close?.(); this._useTemplate(t); },
        h('span', { class: 'dc-tpl__i', text: t.icon }), h('span', { class: 'dc-tpl__n', text: t.name }), h('span', { class: 'dc-tpl__d', text: t.desc }))))));
  }

  _isEmpty() {
    return [...this.ed.children].every((el) => TEXT_TYPES.has(/** @type {HTMLElement} */ (el).dataset.t ?? '') && !(el.textContent ?? '').trim());
  }

  /** 空文档直接换成模板；已经有内容就接在后面。 @param {typeof DOC_TEMPLATES[number]} tpl */
  _useTemplate(tpl) {
    if (!this._can()) return;
    const blocks = docFromTemplate(tpl);
    const doc = this._isEmpty() ? { blocks } : { blocks: [...this._serialize().blocks, ...blocks] };
    this._render({ ...doc, theme: this.theme }, false);
    this._changed();
    this.ed.focus();
    const first = this.ed.querySelector('[data-id="' + CSS.escape(blocks[0].id) + '"]');
    if (first) { placeCaret(/** @type {HTMLElement} */ (first), Infinity); first.scrollIntoView({ block: 'nearest' }); }
  }

  /** 空文档下面的模板条。 */
  _syncStart() {
    const show = !this.readonly && this._isEmpty();
    if (show && !this.startBox.firstChild) {
      this.startBox.append(h('div', { class: 'dc-start__t', text: tt('从模板开始，或者直接打字') }),
        h('div', { class: 'dc-tpls dc-tpls--row' }, ...DOC_TEMPLATES.map((t) => card('dc-tpl', () => this._useTemplate(t),
          h('span', { class: 'dc-tpl__i', text: t.icon }), h('span', { class: 'dc-tpl__n', text: t.name }), h('span', { class: 'dc-tpl__d', text: t.desc })))));
    }
    this.startBox.hidden = !show;
  }

  _can() {
    if (!this.readonly) return true;
    this.opts.onStatus?.(this.roNote.textContent || tt('只读，不能修改'), 'error');
    return false;
  }

  /** 焦点被拿走后把选区放回去。 */
  _restore() {
    if (!this._can()) return false;
    if (rangeIn(this.ed)) return true;
    if (!this._saved) return false;
    this.ed.focus();
    const sel = window.getSelection();
    sel?.removeAllRanges();
    sel?.addRange(this._saved);
    return true;
  }

  _syncTools() {
    const b = this._blockAt();
    if (b && this.typeSel && document.activeElement === this.ed) {
      const t = b.dataset.t ?? 'p';
      if (TEXT_TYPES.has(t)) this.typeSel.value = t;
    }
  }

  // ── 渲染 ─────────────────────────────────────────────────────────────────

  _docOf() {
    const d = this.model.props?.doc;
    return d && Array.isArray(d.blocks) ? d : { blocks: [] };
  }

  /**
   * 整份重画。keepCaret：尽量把光标放回原来的块、原来的位置。
   * @param {any} doc @param {boolean} keepCaret
   */
  _render(doc, keepCaret) {
    /** @type {{id: string, off: number} | null} */ let caret = null;
    if (keepCaret) {
      const b = this._blockAt();
      if (b?.dataset.id) caret = { id: b.dataset.id, off: caretOffset(b) };
    }
    this.solid.clear();
    this._setTheme(doc.theme);
    const els = [];
    for (const b of doc.blocks ?? []) {
      const el = this._blockEl(b);
      if (el) els.push(el);
    }
    this.ed.replaceChildren(...els);
    this._tail();
    this._number();
    this.embeds.prune();
    this.statInfo.textContent = this._countText();
    this._syncStart();
    if (caret) {
      const el = this.ed.querySelector('[data-id="' + CSS.escape(caret.id) + '"]');
      if (el && caret.off >= 0) placeCaret(/** @type {HTMLElement} */ (el), caret.off);
    }
  }

  /** @param {any} b */
  _blockEl(b) {
    if (!b || typeof b !== 'object') return null;
    const id = typeof b.id === 'string' && b.id ? b.id : uid('b');
    const t = String(b.t ?? 'p');
    if (TEXT_TYPES.has(t)) {
      const el = h(/** @type {any} */ (TAG)[t], { class: 'dc-b dc-' + t + (LIST_TYPES.has(t) ? ' dc-li' : ''), dataset: { id, t } });
      renderRuns(el, b.runs);
      this._decorate(el, b);
      return el;
    }
    if (t !== 'hr' && t !== 'img' && t !== 'embed') return null;
    const data = { ...b, id };
    this.solid.set(id, data);
    const fig = h('figure', { class: 'dc-b dc-solid dc-' + t, dataset: { id, t }, attrs: { contenteditable: 'false' } });
    if (t === 'hr') fig.append(h('hr'));
    else if (t === 'img') this._imgBody(fig, data);
    else this._embedBody(fig, data);
    if (!this.readonly || t === 'embed') fig.append(this._solidBar(fig, data));
    return fig;
  }

  /** 对齐、缩进、待办勾选。 @param {HTMLElement} el @param {any} b */
  _decorate(el, b) {
    if (b.align === 'center' || b.align === 'right') { el.dataset.align = b.align; el.style.setProperty('text-align', b.align); }
    const ind = Math.max(0, Math.min(4, b.indent | 0));
    if (ind) { el.dataset.indent = String(ind); el.style.setProperty('margin-left', (ind * 24 + (LIST_TYPES.has(b.t) ? 0 : 0)) + 'px'); }
    if (b.t === 'todo' && b.checked) el.dataset.checked = '1';
  }

  /** @param {HTMLElement} fig @param {any} b */
  async _imgBody(fig, b) {
    const { fileUrl } = await import('../io/attach.js');
    const img = h('img', { class: 'dc-img', alt: b.cap || tt('图片'), src: typeof b.img === 'string' ? fileUrl(this.tableId, b.img) : '' });
    const w = [33, 50, 66, 100].includes(b.w) ? b.w : 100;
    img.style.setProperty('width', w + '%');
    fig.prepend(img);
    if (b.cap) fig.insertBefore(h('figcaption', { class: 'dc-cap', text: String(b.cap) }), img.nextSibling);
  }

  /** @param {HTMLElement} fig @param {any} b */
  _embedBody(fig, b) {
    const label = { range: tt('区域'), chart: tt('图表'), pivot: tt('透视表') }[/** @type {'range'} */ (b.kind)] ?? tt('内容');
    fig.append(h('div', { class: 'dc-embed__head' },
      h('span', { class: 'dc-embed__badge', text: '📊 ' + label }),
      h('span', { class: 'dc-embed__title', text: String(b.title ?? '') })));
    const body = this.embeds.mount(b);
    if (b.kind === 'chart') body.classList.add('emb--chart');
    fig.append(body);
  }

  /** 整块右上角的小工具条：上移 / 下移 / 删除，图片调宽度和说明，嵌入打开源表。 @param {HTMLElement} fig @param {any} b */
  _solidBar(fig, b) {
    const bar = h('div', { class: 'dc-solid__bar' });
    const btn = (/** @type {string} */ text, /** @type {string} */ title, /** @type {() => void} */ fn) =>
      h('button', { class: 'dc-mini', type: 'button', text, title, onclick: (/** @type {Event} */ e) => { e.preventDefault(); fn(); } });
    if (b.t === 'embed' && !this.opts.publicMode) {
      const a = h('a', { class: 'dc-mini', href: '/t/' + encodeURIComponent(b.src), text: '↗', title: tt('打开源表') });
      a.dataset.nav = '';
      bar.append(a);
    }
    if (this.readonly) return bar;
    if (b.t === 'img') {
      bar.append(btn(tt('宽'), tt('切换宽度：1/3 · 1/2 · 2/3 · 整行'), () => {
        const order = [100, 66, 50, 33];
        const i = order.indexOf(b.w ?? 100);
        this._patchSolid(b.id, { w: order[(i + 1) % order.length] });
      }));
      bar.append(btn(tt('说明'), tt('图片说明文字'), async () => {
        const { promptDialog } = await import('../ui/dialog.js');
        const cap = await promptDialog(tt('图片说明'), tt('说明文字（留空则不显示）'), b.cap ?? '');
        if (cap != null) this._patchSolid(b.id, { cap: cap.trim().slice(0, 300) || undefined });
      }));
    }
    bar.append(btn('↑', tt('上移'), () => this._moveSolid(fig, -1)), btn('↓', tt('下移'), () => this._moveSolid(fig, 1)),
      btn('✕', tt('删除'), () => { fig.remove(); this._tail(); this._changed(); }));
    return bar;
  }

  /** 最后一块不是文字块时补一个空段落，否则光标放不到它后面。 */
  _tail() {
    const last = /** @type {HTMLElement | null} */ (this.ed.lastElementChild);
    if (!last || last.dataset.t === 'hr' || last.dataset.t === 'img' || last.dataset.t === 'embed' || !last.dataset.t) {
      const p = this._blockEl({ t: 'p', runs: [] });
      if (p) this.ed.append(p);
    }
  }

  /** 有序列表编号（连续的同缩进 ol 连着编号）。 */
  _number() {
    /** @type {number[]} */ let n = [];
    for (const el of /** @type {HTMLElement[]} */ ([...this.ed.children])) {
      if (el.dataset.t !== 'ol') { if (!LIST_TYPES.has(el.dataset.t ?? '')) n = []; continue; }
      const ind = Number(el.dataset.indent ?? 0);
      n.length = ind + 1;
      n[ind] = (n[ind] ?? 0) + 1;
      el.dataset.n = n[ind] + '.';
    }
  }

  _countText() {
    let chars = 0;
    for (const el of this.ed.children) if (TEXT_TYPES.has(/** @type {HTMLElement} */ (el).dataset.t ?? '')) chars += (el.textContent ?? '').replace(/\s/g, '').length;
    return tt('{n} 字', { n: chars });
  }

  // ── DOM → 数据 ─────────────────────────────────────────────────────────────

  /** 读回整份文档，顺手修 DOM：重复 / 缺失的 id、直接落在根上的文字。 */
  _serialize() {
    const seen = new Set();
    /** @type {any[]} */ const blocks = [];
    for (let node of [...this.ed.childNodes]) {
      if (node.nodeType === 3) {
        if (!(node.nodeValue ?? '').trim()) { node.remove(); continue; }
        const p = h('p', { class: 'dc-b dc-p', dataset: { t: 'p', id: uid('b') } });
        node.replaceWith(p);
        p.append(node);
        node = p;
      }
      if (node.nodeType !== 1) continue;
      const el = /** @type {HTMLElement} */ (node);
      let t = el.dataset.t;
      if (!t) t = { H1: 'h1', H2: 'h2', H3: 'h3', BLOCKQUOTE: 'quote', PRE: 'code', UL: 'ul', OL: 'ol' }[el.tagName] ?? 'p';
      let id = el.dataset.id;
      if (!id || seen.has(id)) { id = uid('b'); el.dataset.id = id; el.dataset.t = t; }
      seen.add(id);
      if (!TEXT_TYPES.has(t)) {
        const d = this.solid.get(id);
        if (d) blocks.push({ ...d, id });
        continue;
      }
      /** @type {any} */ const b = { id, t, runs: readRuns(el) };
      if (el.dataset.align) b.align = el.dataset.align;
      if (el.dataset.indent && Number(el.dataset.indent) > 0) b.indent = Number(el.dataset.indent);
      if (t === 'todo' && el.dataset.checked === '1') b.checked = true;
      blocks.push(b);
    }
    return this.theme ? { blocks, theme: this.theme } : { blocks };
  }

  // ── 保存与同步 ─────────────────────────────────────────────────────────────

  _changed() {
    if (this.readonly) return;
    this.dirty = true;
    this._number();
    this._syncStart();
    clearTimeout(this._timer);
    this._timer = setTimeout(() => this._save(), SAVE_MS);
  }

  _save() {
    clearTimeout(this._timer);
    if (this.readonly || !this.dirty) return;
    const doc = this._serialize();
    this.dirty = false;
    this.statInfo.textContent = this._countText();
    const json = JSON.stringify(doc);
    if (json === this.lastJson) return;
    if (new TextEncoder().encode(json).length > MAX_BYTES) {
      this.opts.onStatus?.(tt('文档太大了（超过 256KB），这次修改没有保存。可以把内容拆到几份文档里。'), 'error');
      return;
    }
    this.lastJson = json;
    this.unacked = true;           // base 仍是服务端上一版，等回声到了再前移
    this.model.apply([{ t: 'setProp', key: 'doc', value: doc }], { local: true });
  }

  _remote() {
    const theirs = this._docOf();
    const json = JSON.stringify(theirs);
    if (json === this.lastJson) { this.base = theirs; this.unacked = false; return; }   // 自己的回声
    if ((this.dirty || this.unacked) && !this.readonly) {
      const mine = this._serialize();
      const merged = mergeDoc(this.base, mine, theirs);
      this.base = theirs;
      this.lastJson = json;
      this._render(merged, true);
      this.dirty = true;
      this._save();
      return;
    }
    this.base = theirs;
    this.lastJson = json;
    this._render(theirs, document.activeElement === this.ed);
  }

  // ── 编辑操作 ───────────────────────────────────────────────────────────────

  /** 选区 / 光标所在的块（编辑区的直接子元素）。 @param {Node | null} [n] */
  _blockAt(n) {
    if (!n) n = rangeIn(this.ed)?.startContainer ?? null;
    while (n && n.parentNode !== this.ed) n = n.parentNode;
    return /** @type {HTMLElement | null} */ (n && n.nodeType === 1 ? n : null);
  }

  /** 选区覆盖到的所有文字块。 */
  _blocksInSel() {
    const r = rangeIn(this.ed);
    if (!r) return [];
    const a = this._blockAt(r.startContainer), b = this._blockAt(r.endContainer);
    if (!a || !b) return [];
    /** @type {HTMLElement[]} */ const out = [];
    for (let el = /** @type {HTMLElement | null} */ (a); el; el = /** @type {HTMLElement | null} */ (el.nextElementSibling)) {
      if (TEXT_TYPES.has(el.dataset.t ?? 'p')) out.push(el);
      if (el === b) break;
    }
    return out;
  }

  /** 改段落样式：换标签，保留内容和 id。 @param {string} t */
  _setType(t) {
    if (!this._restore()) return;
    const els = this._blocksInSel();
    if (!els.length) return;
    const r = rangeIn(this.ed);
    const anchor = els[0], off = caretOffset(anchor);
    let first = null;
    for (const el of els) {
      const cur = el.dataset.t ?? 'p';
      const nt = cur === t && t !== 'p' ? 'p' : t;     // 再点一次同样式 = 取消
      const b = { id: el.dataset.id, t: nt, runs: readRuns(el), align: el.dataset.align, indent: LIST_TYPES.has(nt) ? Number(el.dataset.indent ?? 0) : 0, checked: el.dataset.checked === '1' };
      const ne = this._blockEl(b);
      if (!ne) continue;
      el.replaceWith(ne);
      first ??= ne;
    }
    if (first && r) placeCaret(first, off);
    this._changed();
  }

  /** @param {'center'|'right'|null} a */
  _align(a) {
    if (!this._restore()) return;
    for (const el of this._blocksInSel()) {
      if (a) { el.dataset.align = a; el.style.setProperty('text-align', a); }
      else { delete el.dataset.align; el.style.removeProperty('text-align'); }
    }
    this._changed();
  }

  /** @param {number} d */
  _indent(d) {
    if (!this._restore()) return;
    for (const el of this._blocksInSel()) {
      const n = Math.max(0, Math.min(4, Number(el.dataset.indent ?? 0) + d));
      if (n) { el.dataset.indent = String(n); el.style.setProperty('margin-left', n * 24 + 'px'); }
      else { delete el.dataset.indent; el.style.removeProperty('margin-left'); }
    }
    this._changed();
  }

  /** 高亮 / 行内代码：execCommand 做不了（或者要写 style 属性，CSP 不许），自己包。 @param {'code'|'bg'} kind @param {string} [color] */
  _wrap(kind, color) {
    if (!this._restore()) return;
    const r = rangeIn(this.ed);
    if (!r || r.collapsed) { this.opts.onStatus?.(tt('先选中一段文字'), 'error'); return; }
    const a = this._blockAt(r.startContainer), b = this._blockAt(r.endContainer);
    if (!a || a !== b) { this.opts.onStatus?.(tt('请在同一段里选择文字'), 'error'); return; }
    wrapSelection(a, () => {
      if (kind === 'code') return h('code');
      const s = h('span');
      if (color && isHex(color)) s.style.setProperty('background-color', color);
      return s;
    });
    this._changed();
  }

  async _link() {
    if (!this._restore()) return;
    const r = rangeIn(this.ed)?.cloneRange();
    const { promptDialog } = await import('../ui/dialog.js');
    const url = (await promptDialog(tt('插入链接'), tt('链接地址（http:// 或 https:// 开头）'), 'https://'))?.trim();
    if (!url) return;
    const href = safeHref(url);
    if (!href) { this.opts.onStatus?.(tt('只支持 http、https 或 mailto 链接'), 'error'); return; }
    this.ed.focus();
    const sel = window.getSelection();
    if (r) { sel?.removeAllRanges(); sel?.addRange(r); }
    if (!r || r.collapsed) exec('insertText', href);
    // insertText 之后选区折叠在末尾：往回选中刚插进去的那段
    if (!r || r.collapsed) {
      const cur = rangeIn(this.ed);
      if (cur && cur.startContainer.nodeType === 3) {
        const nr = document.createRange();
        nr.setStart(cur.startContainer, Math.max(0, cur.startOffset - href.length));
        nr.setEnd(cur.startContainer, cur.startOffset);
        sel?.removeAllRanges();
        sel?.addRange(nr);
      }
    }
    exec('createLink', href);
    this._changed();
  }

  /** 在光标所在块后面插入一个整块，后面跟一个空段落方便继续打字。 @param {any} data */
  _insertSolid(data) {
    if (!this._can()) return;
    if (!rangeIn(this.ed) && this._saved) this._restore();
    const at = this._blockAt() ?? /** @type {HTMLElement | null} */ (this.ed.lastElementChild);
    const el = this._blockEl({ ...data, id: uid('b') });
    if (!el) return;
    const empty = at && TEXT_TYPES.has(at.dataset.t ?? '') && !(at.textContent ?? '').length;
    if (empty && at) at.replaceWith(el);
    else if (at) at.after(el);
    else this.ed.append(el);
    let next = /** @type {HTMLElement | null} */ (el.nextElementSibling);
    if (!next || !TEXT_TYPES.has(next.dataset.t ?? '')) {
      next = this._blockEl({ t: 'p', runs: [] });
      if (next) el.after(next);
    }
    this.ed.focus();
    if (next) placeCaret(next, 0);
    this._changed();
    if (data.t === 'embed') this.embeds.register([data]);
  }

  /** @param {string} id @param {any} patch */
  _patchSolid(id, patch) {
    const d = this.solid.get(id);
    const el = this.ed.querySelector('[data-id="' + CSS.escape(id) + '"]');
    if (!d || !el) return;
    const nb = { ...d, ...patch };
    for (const k of Object.keys(nb)) if (nb[k] === undefined) delete nb[k];
    const ne = this._blockEl(nb);
    if (ne) el.replaceWith(ne);
    this._changed();
  }

  /** @param {HTMLElement} fig @param {number} d */
  _moveSolid(fig, d) {
    const sib = /** @type {HTMLElement | null} */ (d < 0 ? fig.previousElementSibling : fig.nextElementSibling);
    if (!sib) return;
    if (d < 0) sib.before(fig); else sib.after(fig);
    this._tail();
    this._changed();
  }

  // ── 导入 / 导出 ───────────────────────────────────────────────────────────

  async _import() {
    if (!this._can()) return;
    const X = await import('./exchange.js');
    const file = await X.pickFile('.docx,.docm,.dotx,.pages,.md,.markdown,.txt,.doc');
    if (!file) return;
    try {
      const { blocks, notes } = await X.importDocFile(file, this.tableId, (m) => this.opts.onStatus?.(m));
      if (this.readonly) return;
      const keep = this._isEmpty() ? [] : this._serialize().blocks;
      const add = X.fitSize(blocks, (l) => ({ blocks: [...keep, ...l], theme: this.theme }), notes, tt('段'));
      if (!add.length) { this.opts.onStatus?.(notes.length ? tt('没有可以导入的内容：{notes}', { notes: notes.join(tt('；')) }) : tt('没有可以导入的内容'), 'error'); return; }
      this._render({ blocks: [...keep, ...add], theme: this.theme }, false);
      this._changed();
      this._save();
      const first = this.ed.querySelector('[data-id="' + CSS.escape(add[0].id) + '"]');
      first?.scrollIntoView({ block: 'nearest' });
      this.opts.onStatus?.(notes.length ? tt('已导入 {name}。{notes}', { name: file.name, notes: notes.join(tt('；')) }) : tt('已导入 {name}', { name: file.name }), notes.length ? 'warn' : undefined);
    } catch (e) {
      this.opts.onStatus?.(/** @type {Error} */ (e).message || tt('导入失败'), 'error');
    }
  }

  async _export() {
    const X = await import('./exchange.js');
    const { toDocx } = await import('../io/docx.js');
    const doc = this.readonly ? this._docOf() : this._serialize();
    const name = X.safeName(this.nameEl.textContent ?? '');
    this.opts.onStatus?.(tt('正在导出…'));
    try {
      const images = await X.collectImages(this.tableId, doc.blocks.filter((/** @type {any} */ b) => b.t === 'img' && typeof b.img === 'string').map((/** @type {any} */ b) => b.img));
      await X.embedsSettled(this.ed);
      /** @type {Map<string, any>} */ const embeds = new Map();
      for (const b of doc.blocks) {
        if (b.t !== 'embed') continue;
        const snap = await X.snapEmbed(this.ed.querySelector('[data-id="' + CSS.escape(b.id) + '"]'));
        if (snap) embeds.set(b.id, snap);
      }
      X.download(new Blob([toDocx(doc, { images, embeds, title: name })], { type: X.DOCX_MIME }), name + '.docx');
      this.opts.onStatus?.(tt('已导出 {name}', { name: name + '.docx' }));
    } catch (e) {
      this.opts.onStatus?.(/** @type {Error} */ (e).message || tt('导出失败'), 'error');
    }
  }

  _pickImage() {
    if (!this._can()) return;
    const input = /** @type {HTMLInputElement} */ (h('input', { type: 'file', accept: 'image/*' }));
    input.addEventListener('change', () => { const f = input.files?.[0]; if (f) void this._uploadImage(f); });
    input.click();
  }

  /** @param {File} file */
  async _uploadImage(file) {
    if (!this._can()) return;
    const { upload, prepare, isImage, MAX_BYTES: MAX_FILE } = await import('../io/attach.js');
    if (!isImage(file.type)) { this.opts.onStatus?.(tt('只能插入图片（PNG、JPEG、GIF、WebP）'), 'error'); return; }
    const f = await prepare(file);
    if (f.size > MAX_FILE) { this.opts.onStatus?.(tt('图片太大了，最大 10MB'), 'error'); return; }
    this.opts.onStatus?.(tt('正在上传图片…'));
    try {
      const res = await upload(this.tableId, f);
      this._insertSolid({ t: 'img', img: res.id, w: 100 });
    } catch (e) {
      this.opts.onStatus?.(/** @type {Error} */ (e).message || tt('上传失败'), 'error');
    }
  }

  async _pickEmbed() {
    if (!this._can()) return;
    const r = rangeIn(this.ed)?.cloneRange();
    const b = await pickEmbed(this.opts.tables?.() ?? []);
    if (!b) return;
    if (r) { this.ed.focus(); const sel = window.getSelection(); sel?.removeAllRanges(); sel?.addRange(r); }
    this._insertSolid(b);
  }

  // ── 键盘 / 粘贴 / 点击 ─────────────────────────────────────────────────────

  /** @param {KeyboardEvent} e */
  _key(e) {
    if (this.readonly) return;
    const mod = e.ctrlKey || e.metaKey;
    if (mod && e.key.toLowerCase() === 'k') { e.preventDefault(); void this._link(); return; }
    if (mod && e.key.toLowerCase() === 's') { e.preventDefault(); this._save(); return; }
    const b = this._blockAt();
    if (!b) return;
    const t = b.dataset.t ?? 'p';
    if (e.key === 'Tab') {
      e.preventDefault();
      if (LIST_TYPES.has(t)) this._indent(e.shiftKey ? -1 : 1);
      else if (!e.shiftKey) exec('insertText', '\t');
      return;
    }
    if (e.key === 'Enter' && !e.isComposing) {
      // 代码块末尾的空行再按回车：去掉这个空行，跳出到下一段（否则代码块是最后一块时光标出不去）
      if (t === 'code' && !e.shiftKey && caretOffset(b) >= (b.textContent ?? '').length) {
        const runs = readRuns(b); // 已去掉末尾换行
        if (!runsText(runs).length) { e.preventDefault(); this._setType('p'); return; }
        // 末尾是两个 <br>（一个换行 + 一个占位）＝ 光标在一个空行上
        if (b.lastChild?.nodeName === 'BR' && b.lastChild.previousSibling?.nodeName === 'BR') {
          e.preventDefault();
          const ne = this._blockEl({ id: b.dataset.id, t: 'code', runs });
          const p = this._blockEl({ t: 'p', runs: [] });
          if (ne && p) { b.replaceWith(ne); ne.after(p); placeCaret(p, 0); this._changed(); }
          return;
        }
      }
      if (e.shiftKey || t === 'code') { e.preventDefault(); exec('insertLineBreak'); return; }
      // 空列表项 / 空引用再按回车：退回普通段落
      if ((LIST_TYPES.has(t) || t === 'quote') && !(b.textContent ?? '').length) { e.preventDefault(); this._setType('p'); return; }
      // 标题末尾回车：下一段是正文
      if (/^h[123]$/.test(t) && caretOffset(b) >= (b.textContent ?? '').length) {
        e.preventDefault();
        const p = this._blockEl({ t: 'p', runs: [] });
        if (p) { b.after(p); placeCaret(p, 0); this._changed(); }
        return;
      }
      // 其余交给浏览器拆块；拆出来的新块会复制 data-id，保存时去重。新待办项不继承勾选
      setTimeout(() => {
        const nb = this._blockAt();
        if (nb && nb !== b && nb.dataset.t === 'todo') delete nb.dataset.checked;
      }, 0);
      return;
    }
    if (e.key === 'Backspace' && t !== 'p') {
      const r = rangeIn(this.ed);
      if (r?.collapsed && caretOffset(b) === 0) {
        e.preventDefault();
        if (Number(b.dataset.indent ?? 0) > 0) this._indent(-1);
        else this._setType('p');
      }
      return;
    }
    if (e.key === ' ' && t === 'p') this._markdown(b, e);
  }

  /** 段首的 Markdown 快捷写法：# ## ### - * 1. > [] ``` 。 @param {HTMLElement} b @param {KeyboardEvent} e */
  _markdown(b, e) {
    const off = caretOffset(b);
    const head = (b.textContent ?? '').slice(0, off);
    const map = { '#': 'h1', '##': 'h2', '###': 'h3', '-': 'ul', '*': 'ul', '1.': 'ol', '>': 'quote', '[]': 'todo', '```': 'code' };
    const t = /** @type {any} */ (map)[head];
    if (!t) return;
    e.preventDefault();
    const runs = readRuns(b);
    const text = runsText(runs).slice(head.length);
    const ne = this._blockEl({ id: b.dataset.id, t, runs: text ? [[text]] : [] });
    if (!ne) return;
    b.replaceWith(ne);
    placeCaret(ne, 0);
    this._changed();
  }

  /** @param {ClipboardEvent} e */
  _paste(e) {
    if (this.readonly) { e.preventDefault(); return; }
    const files = [...(e.clipboardData?.files ?? [])].filter((f) => f.type.startsWith('image/'));
    e.preventDefault();
    if (files.length) { for (const f of files.slice(0, 5)) void this._uploadImage(f); return; }
    // 只收纯文本：外面复制来的 HTML 带着各种样式和脚本，不值得冒险
    const text = e.clipboardData?.getData('text/plain') ?? '';
    if (text) exec('insertText', text.replace(/\r\n?/g, '\n'));
  }

  /** @param {DragEvent} e */
  _drop(e) {
    const files = [...(e.dataTransfer?.files ?? [])].filter((f) => f.type.startsWith('image/'));
    if (!files.length) { if (e.dataTransfer?.types.includes('text/html')) e.preventDefault(); return; }
    e.preventDefault();
    if (this.readonly) return;
    const pos = /** @type {any} */ (document).caretRangeFromPoint?.(e.clientX, e.clientY);
    if (pos) { const sel = window.getSelection(); sel?.removeAllRanges(); sel?.addRange(pos); }
    for (const f of files.slice(0, 5)) void this._uploadImage(f);
  }

  /** 待办的方框画在 ::before 上：点左边那一小块就是勾选。 @param {MouseEvent} e */
  _click(e) {
    const t = /** @type {HTMLElement} */ (e.target);
    const a = t.closest?.('a[href]');
    if (a && this.ed.contains(a) && (e.ctrlKey || e.metaKey || this.readonly) && !a.hasAttribute('data-nav')) {
      e.preventDefault();
      window.open(/** @type {HTMLAnchorElement} */ (a).href, '_blank', 'noopener');
      return;
    }
    const b = this._blockAt(t);
    if (!b || b.dataset.t !== 'todo' || this.readonly) return;
    const x = e.clientX - b.getBoundingClientRect().left - parseFloat(getComputedStyle(b).paddingLeft || '0');
    if (x > -2) return;
    if (b.dataset.checked === '1') delete b.dataset.checked; else b.dataset.checked = '1';
    this._changed();
  }
}
