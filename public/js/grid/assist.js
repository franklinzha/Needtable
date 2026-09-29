/**
 * 公式输入助手：函数名自动完成、参数提示、引用着色、编辑中点格子插入引用。
 *
 * 同时服务单元格编辑器与编辑栏两个输入框 —— 谁在输入就跟着谁（this.target）。
 * 弹层吃掉 mousedown，焦点始终留在输入框里，所以点选候选项不会触发失焦提交。
 */

import { h } from '../ui/dom.js';
import { t as tt } from '../../shared/i18n/i18n.js';
import { FUNCTION_NAMES } from '../../shared/formula/functions.js';
import { refsIn } from '../../shared/formula/parse.js';
import { colName } from '../../shared/util/a1.js';
import { splitHelp } from './dialogs.js';
import { fnDetail } from './fndoc.js';
import { DOCS } from '../../shared/formula/docs.js';

const COLORS = ['#2f6feb', '#d93025', '#188038', '#9334e6', '#e37400', '#12a4af', '#b31412', '#5f6368'];
/** 光标前是这些字符时，点格子 = 插入引用（Excel 的"点选模式"）。 */
const PICK_AFTER = /[(,=+\-*/^&<>;:%]\s*$/;
const MAX_ITEMS = 12;
/** 提示条的「?」展开状态记在这里（默认收起）。 */
const DETAIL_KEY = 'nt.fnhelp.open';
const loadOpen = () => { try { return localStorage.getItem(DETAIL_KEY) === '1'; } catch { return false; } };

export class FormulaAssist {
  /** @param {any} grid */
  constructor(grid) {
    this.g = grid;
    /** @type {any} */ this.target = null;
    /** @type {string[]} */ this.items = [];
    this.idx = 0;
    /** 正在输入的函数名片段在文本里的位置 @type {{s:number,e:number}|null} */
    this.word = null;
    /** 上一次点选插入的引用位置（拖动时原地替换） @type {{s:number,e:number}|null} */
    this.lastPick = null;
    /** 提示条是否展开参数说明 */
    this.detailOpen = loadOpen();
    /** 提示条当前显示的函数与参数序号 @type {{fn:string, arg:number}|null} */
    this.shown = null;

    this.list = h('div', { class: 'fa-list', attrs: { role: 'listbox' } });
    this.hint = h('div', { class: 'fa-hint' });
    this.pop = h('div', { class: 'fa-pop' }, this.list, this.hint);
    this.pop.hidden = true;
    this.pop.addEventListener('mousedown', (e) => e.preventDefault());
    this.pop.addEventListener('pointerdown', (e) => e.preventDefault());
    document.body.append(this.pop);
  }

  /** @param {any} el */
  owns(el) { return !!el && this.pop.contains(el); }

  close() {
    this.pop.hidden = true;
    this.items = [];
    this.word = null;
    this.lastPick = null;
    if (this.g.renderer.refHighlights.length) {
      this.g.renderer.refHighlights = [];
      this.g.renderer.schedule?.();
    }
  }

  _caret(el) {
    const v = el.value ?? '';
    const p = typeof el.selectionStart === 'number' ? el.selectionStart : v.length;
    return Math.min(p, v.length);
  }

  /** 输入框内容变了：重算候选、提示与引用着色。 @param {any} el */
  update(el) {
    this.target = el;
    const v = el.value ?? '';
    const caret = this._caret(el);
    if (this.lastPick && (this.lastPick.e !== caret)) this.lastPick = null;
    this.highlight(v);
    if (!v.startsWith('=')) { this._hide(); return; }

    const before = v.slice(0, caret);
    const m = /([A-Za-z][A-Za-z0-9_.]*)$/.exec(before);
    const inString = (before.match(/"/g)?.length ?? 0) % 2 === 1;
    this.items = [];
    this.word = null;
    if (m && !inString && !/[A-Za-z0-9_.$]/.test(before[m.index - 1] ?? '')) {
      const up = m[1].toUpperCase();
      // A1 这种像引用的片段只在确实有同名前缀函数时才弹（例如 "LOG" 与 "LOG10"）
      this.items = FUNCTION_NAMES.filter((n) => n.startsWith(up)).slice(0, MAX_ITEMS);
      if (this.items.length === 1 && this.items[0] === up && v[caret] === '(') this.items = [];
      if (this.items.length) this.word = { s: m.index, e: caret };
    }
    this.idx = 0;
    this._render(before, inString);
  }

  /**
   * 找到光标所在的最内层函数调用和光标在第几个参数上，用来显示参数签名。
   * @returns {{name: string, arg: number} | null}
   */
  _currentFn(before) {
    let depth = 0, inStr = false, arg = 0;
    for (let i = before.length - 1; i >= 0; i--) {
      const ch = before[i];
      if (ch === '"') inStr = !inStr;
      if (inStr) continue;
      if (ch === ')') depth++;
      else if (ch === ',' && depth === 0) arg++;
      else if (ch === '(') {
        if (depth === 0) {
          const m = /([A-Za-z][A-Za-z0-9_.]*)$/.exec(before.slice(0, i));
          return m ? { name: m[1].toUpperCase(), arg } : null;
        }
        depth--;
      }
    }
    return null;
  }

  /** 提示条：签名 + 一句话说明 + 「?」；展开时下面是参数表和示例。 @param {string} fn @param {number} arg */
  _showHint(fn, arg) {
    this.shown = { fn, arg };
    const [sig, desc] = splitHelp(fn);
    const hasDetail = !!DOCS[fn];
    const toggle = hasDetail ? h('button', {
      type: 'button', class: 'fa-hint__toggle' + (this.detailOpen ? ' is-open' : ''), text: '?',
      title: this.detailOpen ? tt('收起参数说明') : tt('展开参数说明和示例'),
      attrs: { 'aria-expanded': String(this.detailOpen) },
      onclick: () => {
        this.detailOpen = !this.detailOpen;
        try { localStorage.setItem(DETAIL_KEY, this.detailOpen ? '1' : '0'); } catch { /* 隐私模式：只在本次生效 */ }
        if (this.shown) this._showHint(this.shown.fn, this.shown.arg);
        this._place();
      },
    }) : null;
    // 原生 replaceChildren 会把 null 当成文字「null」插进去：收起时不传第三项
    const detail = hasDetail && this.detailOpen ? fnDetail(fn, arg) : null;
    this.hint.replaceChildren(
      h('div', { class: 'fa-hint__head' }, h('code', { text: sig }), toggle),
      h('span', { text: desc }),
      ...(detail ? [detail] : []));
    this.hint.hidden = false;
  }

  _hide() { this.pop.hidden = true; this.items = []; this.word = null; }

  _render(before, inString) {
    this.list.replaceChildren();
    this.list.hidden = !this.items.length;
    this.items.forEach((name, i) => {
      const [, desc] = splitHelp(name);
      const row = h('div', { class: 'fa-item' + (i === this.idx ? ' is-active' : ''), attrs: { role: 'option' } },
        h('b', { text: name }), h('span', { text: desc }));
      row.addEventListener('click', () => { this.idx = i; this._accept(); });
      this.list.append(row);
    });

    const cur = this.items.length ? { name: this.items[this.idx], arg: -1 } : (inString ? null : this._currentFn(before));
    if (cur && FUNCTION_NAMES.includes(cur.name)) {
      this._showHint(cur.name, cur.arg);
    } else {
      this.hint.hidden = true;
      this.shown = null;
    }
    this.pop.hidden = this.list.hidden && this.hint.hidden;
    if (!this.pop.hidden) this._place();
  }

  _place() {
    const el = this.target;
    if (!el?.getBoundingClientRect) return;
    const r = el.getBoundingClientRect();
    const s = this.pop.style;
    const w = 360;
    s.left = Math.max(4, Math.min(r.left, (window.innerWidth || 1280) - w - 8)) + 'px';
    const below = r.bottom + 2;
    const room = (window.innerHeight || 800) - below;
    if (room < 180 && r.top > 200) { s.top = ''; s.bottom = ((window.innerHeight || 800) - r.top + 2) + 'px'; }
    else { s.bottom = ''; s.top = below + 'px'; }
  }

  _move(d) {
    if (!this.items.length) return;
    this.idx = (this.idx + d + this.items.length) % this.items.length;
    const rows = this.list.children;
    for (let i = 0; i < rows.length; i++) rows[i].classList.toggle('is-active', i === this.idx);
    rows[this.idx]?.scrollIntoView?.({ block: 'nearest' });
    this._showHint(this.items[this.idx], -1);
  }

  /** 选中候选：把片段替换成 "NAME(" 并把光标放进括号。 */
  _accept() {
    const el = this.target, w = this.word;
    if (!el || !w || !this.items.length) return;
    const name = this.items[this.idx];
    const v = el.value;
    const hasParen = v[w.e] === '(';
    const ins = hasParen ? name : name + '(';
    this._setText(v.slice(0, w.s) + ins + v.slice(w.e), w.s + ins.length + (hasParen ? 1 : 0));
  }

  /** 改写输入框并通知另一侧镜像（input 事件）。 */
  _setText(text, caret) {
    const el = this.target;
    el.value = text;
    el.focus?.({ preventScroll: true });
    el.setSelectionRange?.(caret, caret);
    if (el === this.g.editor.el) {
      this.g.editor._autoGrow?.();
      this.g.fx.value = text;
    } else {
      this.g.editor.el.value = text;
      this.g.editor._autoGrow?.();
    }
    this.update(el);
  }

  /** 键盘：自动完成列表打开时接管上下 / Enter / Tab / Esc。 @returns {boolean} */
  key(e) {
    if (this.pop.hidden || !this.items.length) return false;
    switch (e.key) {
      case 'ArrowDown': e.preventDefault(); this._move(1); return true;
      case 'ArrowUp': e.preventDefault(); this._move(-1); return true;
      case 'Enter': case 'Tab': e.preventDefault(); e.stopPropagation?.(); this._accept(); return true;
      case 'Escape': e.preventDefault(); e.stopPropagation?.(); this._hide(); return true;
      default: return false;
    }
  }

  /** 当前是否处在"点格子插入引用"的位置。 */
  canPick() {
    const el = this.target ?? this.g.editor.el;
    const v = el.value ?? '';
    if (!v.startsWith('=')) return false;
    const caret = this._caret(el);
    if (this.lastPick && this.lastPick.e === caret) return true;
    const before = v.slice(0, caret);
    if ((before.match(/"/g)?.length ?? 0) % 2 === 1) return false;
    return PICK_AFTER.test(before);
  }

  /**
   * 插入（或替换上一次点选的）引用。
   * mode：'col' 点的是列标（A:A、A:C），'row' 点的是行号（1:1、2:5），缺省是格子区域。
   * @param {number} r0 @param {number} c0 @param {number} r1 @param {number} c1 @param {'cell'|'col'|'row'} [mode]
   */
  pick(r0, c0, r1, c1, mode = 'cell') {
    const el = this.target ?? this.g.editor.el;
    this.target = el;
    const v = el.value ?? '';
    const caret = this._caret(el);
    const a = Math.min(r0, r1), b = Math.max(r0, r1), c = Math.min(c0, c1), d = Math.max(c0, c1);
    let ref;
    if (mode === 'col') ref = colName(c) + ':' + colName(d);
    else if (mode === 'row') ref = (a + 1) + ':' + (b + 1);
    else {
      ref = colName(c) + (a + 1);
      if (a !== b || c !== d) ref += ':' + colName(d) + (b + 1);
    }
    let s = caret, e = caret;
    if (this.lastPick && this.lastPick.e === caret) { s = this.lastPick.s; e = this.lastPick.e; }
    this.lastPick = { s, e: s + ref.length };
    const keep = this.lastPick;
    this._setText(v.slice(0, s) + ref + v.slice(e), s + ref.length);
    this.lastPick = keep;
    this._hide();
  }

  /** 拖选结束后把焦点还给输入框。 */
  refocus() {
    const el = this.target ?? this.g.editor.el;
    const keep = this.lastPick;
    el.focus?.({ preventScroll: true });
    if (keep) el.setSelectionRange?.(keep.e, keep.e);
    this.lastPick = keep;
  }

  /** 公式里的每个引用画一个彩色框，颜色与 Excel 一样按出现顺序轮换。 @param {string} value */
  highlight(value) {
    const out = [];
    if (typeof value === 'string' && value.startsWith('=')) {
      const maxR = this.g.model.rowCount - 1, maxC = this.g.model.colCount - 1;
      refsIn(value.slice(1)).forEach((t, i) => {
        const a = t.v.a, b = t.v.b ?? t.v.a;
        const r0 = a.r ?? 0, r1 = b.r ?? maxR, c0 = a.c ?? 0, c1 = b.c ?? maxC;
        out.push({ r0: Math.min(r0, r1), c0: Math.min(c0, c1), r1: Math.max(r0, r1), c1: Math.max(c0, c1), color: COLORS[i % COLORS.length] });
      });
    }
    const prev = this.g.renderer.refHighlights;
    if (prev.length || out.length) {
      this.g.renderer.refHighlights = out;
      this.g.renderer.schedule?.();
    }
  }
}
