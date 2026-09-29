/**
 * 图表层：把 props.charts 画成浮在网格上的卡片，跟着滚动走，可拖动、可缩放，悬停显示数值。
 *
 * 数据每次重绘时现从单元格里取，所以改了源数据图表立刻跟着变。
 * 每个图表自带一块小 canvas —— 与主画布完全隔离，不影响网格的每帧绘制计数。
 * 取数与绘制在 chartdraw.js（仪表盘、插入图表对话框的预览也用它）。
 */

import { h } from '../ui/dom.js';
import { t as tt } from '../../shared/i18n/i18n.js';
import { openMenu } from '../ui/menu.js';
import * as D from './dialogs.js';
import { chartData, drawChart, hitTest, readChartTheme, CHART_TYPES } from './chartdraw.js';

export class ChartLayer {
  /** @param {any} grid @param {HTMLElement} host */
  constructor(grid, host) {
    this.g = grid;
    this.host = host;
    /** @type {Map<string, any>} */ this.boxes = new Map();
    this._raf = 0;
  }

  /** 模型变了：合到下一帧再重画（多次改动只画一次）。 */
  refresh() {
    if (this._raf) return;
    this._raf = requestAnimationFrame(() => { this._raf = 0; this._sync(); });
  }

  /** 滚动 / 调整大小：只挪位置，不重画内容。 */
  position() {
    const vp = this.g.vp;
    for (const b of this.boxes.values()) {
      const c = b.drag?.live ?? b.chart;
      b.el.style.left = (c.x - vp.scrollX) + 'px';
      b.el.style.top = (c.y - vp.scrollY) + 'px';
      b.el.style.width = c.w + 'px';
      b.el.style.height = c.h + 'px';
    }
  }

  _sync() {
    const list = Array.isArray(this.g.model.props.charts) ? this.g.model.props.charts : [];
    const seen = new Set();
    const theme = readChartTheme(this.host);
    for (const chart of list) {
      if (!chart?.id) continue;
      seen.add(chart.id);
      let b = this.boxes.get(chart.id);
      if (!b) { b = this._create(chart); this.boxes.set(chart.id, b); }
      if (b.drag) continue;
      b.chart = chart;
      this._draw(b, theme);
    }
    for (const [id, b] of this.boxes) if (!seen.has(id)) { b.el.remove(); this.boxes.delete(id); }
    this.position();
  }

  _draw(b, theme) {
    const c = b.chart, dpr = window.devicePixelRatio || 1;
    const w = Math.max(80, c.w), hh = Math.max(60, c.h);
    if (b.canvas.width !== Math.round(w * dpr)) b.canvas.width = Math.round(w * dpr);
    if (b.canvas.height !== Math.round(hh * dpr)) b.canvas.height = Math.round(hh * dpr);
    b.canvas.style.width = w + 'px';
    b.canvas.style.height = hh + 'px';
    const ctx = b.canvas.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    try { b.hits = drawChart(ctx, w, hh, c, chartData(this.g, c), theme); } catch (err) { b.hits = []; console.warn('chart', err); }
  }

  _create(chart) {
    const canvas = h('canvas', { class: 'chart__canvas' });
    const more = h('button', { class: 'chart__more', type: 'button', text: '⋯', title: tt('图表选项') });
    const grip = h('div', { class: 'chart__grip', title: tt('拖动调整大小') });
    const tip = h('div', { class: 'chart__tip', hidden: true });
    const el = h('div', { class: 'chart', attrs: { role: 'img', 'aria-label': chart.title || tt('图表') } }, canvas, more, grip, tip);
    this.host.append(el);
    const b = { el, canvas, tip, chart, drag: null, hits: [] };
    more.addEventListener('pointerdown', (e) => e.stopPropagation());
    more.addEventListener('click', (e) => { e.stopPropagation(); this._menu(b, { x: e.clientX, y: e.clientY }); });
    el.addEventListener('contextmenu', (e) => { e.preventDefault(); this._menu(b, { x: e.clientX, y: e.clientY }); });
    el.addEventListener('dblclick', () => { if (!this.g.readonly) D.chart(this.g, b.chart.type, b.chart); });
    el.addEventListener('wheel', (e) => { this.g.scroll.scrollTop += e.deltaY; this.g.scroll.scrollLeft += e.deltaX; e.preventDefault(); }, { passive: false });
    el.addEventListener('pointerdown', (e) => this._start(b, e, 'move'));
    grip.addEventListener('pointerdown', (e) => { e.stopPropagation(); this._start(b, e, 'size'); });
    el.addEventListener('pointermove', (e) => this._move(b, e));
    el.addEventListener('pointerup', (e) => this._end(b, e));
    el.addEventListener('pointerleave', () => { b.tip.hidden = true; });
    grip.addEventListener('pointermove', (e) => this._move(b, e));
    grip.addEventListener('pointerup', (e) => this._end(b, e));
    return b;
  }

  _start(b, e, kind) {
    if (e.button !== 0 || this.g.readonly || this.g.view !== 'grid') return;
    e.preventDefault();
    if (this.g.editor.open) this.g.editor.commit('none');
    b.drag = { kind, x0: e.clientX, y0: e.clientY, orig: { ...b.chart }, live: { ...b.chart } };
    b.el.classList.add('is-dragging');
    b.tip.hidden = true;
    (kind === 'size' ? b.el.lastChild : b.el).setPointerCapture?.(e.pointerId);
  }

  _move(b, e) {
    const d = b.drag;
    if (!d) { this._hover(b, e); return; }
    const dx = e.clientX - d.x0, dy = e.clientY - d.y0;
    if (d.kind === 'move') { d.live.x = Math.max(0, d.orig.x + dx); d.live.y = Math.max(0, d.orig.y + dy); }
    else { d.live.w = Math.max(200, d.orig.w + dx); d.live.h = Math.max(140, d.orig.h + dy); }
    this.position();
  }

  /** 悬停提示：分类 + 系列名 + 数值，跟着鼠标走，靠近右 / 下边缘时翻到另一侧。 */
  _hover(b, e) {
    const r = b.canvas.getBoundingClientRect();
    const x = e.clientX - r.left, y = e.clientY - r.top;
    const hit = e.target === b.canvas ? hitTest(b.hits, x, y) : null;
    if (!hit) { b.tip.hidden = true; return; }
    b.tip.replaceChildren(
      h('div', { class: 'chart__tip-label', text: String(hit.label ?? '') }),
      h('div', { class: 'chart__tip-row' },
        h('span', { class: 'chart__tip-dot', style: { background: hit.color } }),
        h('span', { text: hit.name ? hit.name + '：' : '' }),
        h('b', { text: hit.text })));
    b.tip.hidden = false;
    const tw = b.tip.offsetWidth, th = b.tip.offsetHeight;
    b.tip.style.left = (x + 14 + tw > r.width ? Math.max(0, x - tw - 10) : x + 14) + 'px';
    b.tip.style.top = (y + 14 + th > r.height ? Math.max(0, y - th - 10) : y + 14) + 'px';
  }

  _end(b, e) {
    const d = b.drag;
    if (!d) return;
    b.drag = null;
    b.el.classList.remove('is-dragging');
    try { (d.kind === 'size' ? b.el.lastChild : b.el).releasePointerCapture?.(e.pointerId); } catch (err) { void err; }
    const moved = d.live.x !== d.orig.x || d.live.y !== d.orig.y || d.live.w !== d.orig.w || d.live.h !== d.orig.h;
    if (!moved) { this.position(); return; }
    const round = (n) => Math.round(n);
    this._save(b.chart.id, { x: round(d.live.x), y: round(d.live.y), w: round(d.live.w), h: round(d.live.h) });
  }

  _save(id, patch) {
    const list = (this.g.model.props.charts ?? []).map((c) => (c.id === id ? { ...c, ...patch } : c));
    this.g.exec([{ t: 'setProp', key: 'charts', value: list }]);
  }

  _menu(b, at) {
    const ro = this.g.readonly;
    const types = CHART_TYPES.map(([t, label]) => ({ label, checked: b.chart.type === t, disabled: ro, action: () => this._save(b.chart.id, { type: t }) }));
    openMenu([
      { label: tt('编辑图表…'), disabled: ro, action: () => D.chart(this.g, b.chart.type, b.chart) },
      { label: tt('更改图表类型'), submenu: types, disabled: ro },
      { label: tt('选择数据区域'), action: () => { const [r0, c0, r1, c1] = b.chart.range; this.g.cmd.selectRect({ r0, c0, r1, c1 }); } },
      { sep: true },
      { label: tt('删除图表'), danger: true, disabled: ro, action: () => {
        this.g.exec([{ t: 'setProp', key: 'charts', value: (this.g.model.props.charts ?? []).filter((c) => c.id !== b.chart.id) }]);
      } },
    ], at);
  }
}
