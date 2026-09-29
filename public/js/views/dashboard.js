/**
 * 仪表盘：顶部一排指标卡（某列的求和 / 平均 / 计数 / 最大 / 最小），下面平铺所有图表和透视表。
 * 配置存在 props.dashboard，图表 / 透视表就是表格里插入的那些 —— 同一份定义，两处显示。
 *
 * 每一项可以拖动标题栏换位置、拖右下角改大小（宽度按网格列吸附，高度自由）、切换半宽 / 整行、隐藏。
 * 隐藏的项在原位置留一条占位，点它才恢复。
 * 布局存 props.dashboard.layout（见 dashlayout.js）；只读用户的调整只留在本地，不写回。
 */

import { h, select, plainTitle } from '../ui/dom.js';
import { lastRow, lastCol } from '../grid/commands.js';
import { chartData, drawChart, readChartTheme, WAN_LANGS } from '../grid/chartdraw.js';
import { t as tt, currentLang, langTag } from '../../shared/i18n/i18n.js';
import { MAX_PIVOTS } from '../grid/pivotcalc.js';
import { colName } from '../../shared/util/a1.js';
import { arrange, moveItem, nextLayout, resizeLayout, MIN_H, MAX_H } from './dashlayout.js';
import { pivotTable } from './pivot.js';

const AGGS = [['sum', tt('求和')], ['avg', tt('平均值')], ['count', tt('计数')], ['max', tt('最大值')], ['min', tt('最小值')]];
const AGG_LABEL = Object.fromEntries(AGGS);
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/** 1234567 → 123.46万；小数最多两位。 */
function fmt(n) {
  if (n == null || !Number.isFinite(n)) return '—';
  const a = Math.abs(n);
  if (a >= 1e5 && !WAN_LANGS.has(currentLang())) return new Intl.NumberFormat(langTag(), { notation: 'compact', maximumFractionDigits: 2 }).format(n);
  if (a >= 1e8) return tt('{n}亿', { n: (n / 1e8).toFixed(2).replace(/\.?0+$/, '') });
  if (a >= 1e5) return tt('{n}万', { n: (n / 1e4).toFixed(2).replace(/\.?0+$/, '') });
  return n.toLocaleString(langTag(), { maximumFractionDigits: 2 });
}

export class DashboardView {
  /** @param {any} grid @param {HTMLElement} host */
  constructor(grid, host) {
    this.g = grid;
    this.kpis = h('div', { class: 'db__kpis' });
    this.charts = h('div', { class: 'db__charts' });
    this.root = h('div', { class: 'db' },
      h('div', { class: 'db__bar' },
        h('h2', { class: 'db__h', text: tt('仪表盘') }),
        h('div', { class: 'grid__spacer' }),
        this.addBtn = h('button', { class: 'ui-btn ui-btn--sm', type: 'button', text: tt('＋ 指标卡'), onclick: () => this._addForm() }),
        this.chartBtn = h('button', { class: 'ui-btn ui-btn--sm', type: 'button', text: tt('＋ 图表'), onclick: () => this._addChart() }),
        this.pivotBtn = h('button', { class: 'ui-btn ui-btn--sm', type: 'button', text: tt('＋ 透视表'), onclick: () => this._addPivot() }),
        // 只读也能导出；公开只读链接里不能
        ...(grid.noCopy ? [] : [
          h('button', { class: 'ui-btn ui-btn--sm', type: 'button', text: tt('导出图片'), title: tt('把仪表盘导出为 PNG 图片'), onclick: () => void this._export('png') }),
          h('button', { class: 'ui-btn ui-btn--sm', type: 'button', text: tt('导出 PDF'), title: tt('把仪表盘导出为 PDF（一页）'), onclick: () => void this._export('pdf') }),
        ])),
      this.form = h('div', { class: 'db__form' }),
      this.kpis, this.charts);
    this.form.hidden = true;
    host.replaceChildren(this.root);
    this._raf = 0;
    /** 只读用户的本地布局 @type {any} */ this._local = null;
    /** 正在拖动的项 id @type {string | null} */ this._drag = null;
    this._onResize = () => this.refresh();
    window.addEventListener?.('resize', this._onResize);
    // 换了主题配色：图表是画在 canvas 上的，要重画
    window.addEventListener?.('themechange', this._onResize);
    this.refresh();
  }

  destroy() {
    window.removeEventListener?.('resize', this._onResize);
    window.removeEventListener?.('themechange', this._onResize);
    cancelAnimationFrame(this._raf);
    this.root.remove();
  }

  /** 表头行 + 数据行范围。首行在数字列里是文本 → 视为表头。 */
  _range() {
    const m = this.g.model, calc = this.g.calc;
    const R = lastRow(m), C = Math.max(0, lastCol(m));
    let header = false;
    for (let c = 0; c <= C && !header; c++) {
      if (typeof calc.value(0, c) === 'string' && num(calc.value(1, c)) != null) header = true;
    }
    // 末尾的"合计"行（整行都是 SUM/SUBTOTAL 之类的汇总公式或文本）不计入指标，否则求和翻倍
    let end = R;
    while (end > (header ? 1 : 0) && this._isTotalRow(end, C)) end--;
    return { top: header ? 1 : 0, R: end, C, header };
  }

  /** @param {number} r @param {number} C */
  _isTotalRow(r, C) {
    let agg = false;
    for (let c = 0; c <= C; c++) {
      const raw = this.g.model.getCell(r, c);
      if (!raw) continue;
      if (/^=\s*(SUM|SUBTOTAL|AGGREGATE|AVERAGE|COUNTA?|MAX|MIN)\s*\(/i.test(raw)) agg = true;
      else if (raw.startsWith('=') || num(this.g.calc.value(r, c)) != null) return false;
    }
    return agg;
  }

  _name(c, header) {
    const t = header ? this.g.calc.text(0, c) : '';
    return t || this.g.model.colTitle(c);
  }

  _agg(col, agg, top, R) {
    const calc = this.g.calc;
    let sum = 0, n = 0, cnt = 0, max = -Infinity, min = Infinity;
    for (let r = top; r <= R; r++) {
      const v = calc.value(r, col);
      if (v != null && v !== '') cnt++;
      const x = num(v);
      if (x == null) continue;
      sum += x; n++;
      if (x > max) max = x;
      if (x < min) min = x;
    }
    switch (agg) {
      case 'avg': return n ? sum / n : null;
      case 'count': return cnt;
      case 'max': return n ? max : null;
      case 'min': return n ? min : null;
      default: return sum;
    }
  }

  /** 没配置过就给数字列各一张求和卡，外加总行数。 */
  _kpiList(rng) {
    const saved = this.g.model.props.dashboard?.kpis;
    if (Array.isArray(saved)) return saved;
    const out = [{ col: 0, agg: 'count', auto: true }];
    for (let c = 0; c <= rng.C && out.length < 5; c++) {
      if (num(this.g.calc.value(rng.top, c)) != null) out.push({ col: c, agg: 'sum', auto: true });
    }
    return out;
  }

  _saveKpis(list) {
    if (this.g.readonly) return;
    // 自动生成的「数据行数」卡存下来就没有 auto 标记了，标题一起存上，免得变成「地区 · 计数」
    const clean = list.map(({ col, agg, label, auto }) => {
      const l = label || (auto && agg === 'count' ? tt('数据行数') : '');
      return l ? { col, agg, label: l } : { col, agg };
    });
    this.g.exec([{ t: 'setProp', key: 'dashboard', value: { ...(this.g.model.props.dashboard ?? {}), kpis: clean } }]);
  }

  _addForm() {
    if (this.g.readonly) return;
    const rng = this._range();
    const cols = [];
    for (let c = 0; c <= rng.C; c++) cols.push([String(c), this._name(c, rng.header) + '（' + colName(c) + '）']);
    const colSel = select(cols, '0', { class: 'ui-input' });
    const aggSel = select(AGGS, 'sum', { class: 'ui-input' });
    const label = h('input', { class: 'ui-input', type: 'text', placeholder: tt('标题（可选）') });
    const add = () => {
      const list = this._kpiList(rng).filter((k) => !k.auto || !this.g.model.props.dashboard?.kpis);
      list.push({ col: Number(colSel.value), agg: aggSel.value, label: label.value.trim() || undefined });
      this.form.hidden = true;
      this._saveKpis(list);
    };
    this.form.replaceChildren(colSel, aggSel, label,
      h('button', { class: 'ui-btn ui-btn--primary ui-btn--sm', type: 'button', text: tt('添加'), onclick: add }),
      h('button', { class: 'ui-btn ui-btn--sm', type: 'button', text: tt('取消'), onclick: () => { this.form.hidden = true; } }));
    this.form.hidden = false;
    colSel.focus();
  }

  async _addChart() {
    await this.g.setView('grid');
    this.g.cmd.run('insertChart', 'column');
  }

  async _addPivot() {
    await this.g.setView('grid');
    this.g.cmd.run('insertPivot');
  }

  _layout() {
    const saved = this.g.model.props.dashboard?.layout;
    return this.g.readonly ? (this._local ?? saved) : saved;
  }

  /** @param {{order:string[], hidden:string[], wide:string[], sizes?:any}} layout */
  _saveLayout(layout) {
    if (this.g.readonly) { this._local = layout; this.refresh(); return; }
    this.g.exec([{ t: 'setProp', key: 'dashboard', value: { ...(this.g.model.props.dashboard ?? {}), layout } }]);
  }

  refresh() {
    cancelAnimationFrame(this._raf);
    this._raf = requestAnimationFrame(() => this._render());
  }

  _render() {
    const g = this.g, rng = this._range();
    this.addBtn.disabled = g.readonly;
    this.chartBtn.disabled = g.readonly;

    const list = this._kpiList(rng);
    const cards = list.map((k, i) => {
      const val = k.col <= rng.C || k.agg === 'count' ? this._agg(k.col, k.agg, rng.top, rng.R) : null;
      const title = k.label || (k.agg === 'count' && k.auto ? tt('数据行数') : tt('{name} · {agg}', { name: this._name(k.col, rng.header), agg: AGG_LABEL[k.agg] }));
      const del = g.readonly ? null : h('button', { class: 'db__x', type: 'button', text: '×', title: tt('移除'),
        onclick: () => this._saveKpis(list.filter((_, j) => j !== i)) });
      return h('div', { class: 'db__kpi' }, h('div', { class: 'db__klabel', text: title }), h('div', { class: 'db__kval', text: fmt(val) }), del);
    });
    this.kpis.replaceChildren(...cards);

    // 图表：已插入的全部画出来；一个都没有就按数据猜一张（不保存）
    let charts = Array.isArray(g.model.props.charts) ? g.model.props.charts.filter((c) => c?.range) : [];
    let guessed = false;
    if (!charts.length && rng.R > rng.top) {
      const labelCol = typeof g.calc.value(rng.top, 0) === 'string' ? 0 : -1;
      let valCol = -1;
      for (let c = 0; c <= rng.C && valCol < 0; c++) if (c !== labelCol && num(g.calc.value(rng.top, c)) != null) valCol = c;
      if (valCol >= 0) {
        guessed = true;
        charts = [{ id: '_auto', type: 'column', title: this._name(valCol, rng.header),
          range: labelCol >= 0 ? [0, 0, rng.R, valCol] : [0, valCol, rng.R, valCol], header: rng.header }];
        if (labelCol >= 0 && valCol > 1) charts[0].cols = [0, valCol];
      }
    }
    const pivots = Array.isArray(g.model.props.pivots) ? g.model.props.pivots.filter((p) => p?.id) : [];
    this.pivotBtn.disabled = g.readonly || pivots.length >= MAX_PIVOTS;
    this.pivotBtn.title = pivots.length >= MAX_PIVOTS ? tt('每张表最多 {n} 个透视表', { n: MAX_PIVOTS }) : tt('在表格中选中数据区域，插入透视表');
    /** @type {Map<string, any>} */ const src = new Map();
    for (const c of charts) src.set('c:' + (c.id ?? ''), { kind: 'chart', c, title: c.title || tt('图表') });
    for (const p of pivots) src.set('p:' + p.id, { kind: 'pivot', p, title: p.name || tt('透视表') });
    if (!src.size) {
      this.charts.replaceChildren(h('div', { class: 'db__empty', text: tt('还没有图表或透视表。点击右上角「＋ 图表」或「＋ 透视表」，选中数据区域即可插入。') }));
      return;
    }

    const items = arrange([...src.keys()], this._layout());
    const theme = readChartTheme(this.root);
    /** @type {{canvas: HTMLCanvasElement, c: any}[]} */ const toDraw = [];
    /** @type {{box: HTMLElement, it: any}[]} */ const sized = [];
    const nodes = items.map((it) => {
      const s = src.get(it.id);
      if (it.hidden) {
        // 隐藏后只在原位置留一条占位，点它恢复
        const ph = h('button', { class: 'db__ph' + (it.wide ? ' db__item--wide' : ''), type: 'button',
          text: tt('已隐藏：{title} · 点击显示', { title: s.title }), title: tt('点击恢复显示（也可以拖动调整位置）'),
          onclick: () => this._saveLayout(nextLayout(items, 'hidden', it.id)) });
        this._dnd(ph, it.id, items);
        return ph;
      }
      const btn = (text, tip, fn) => h('button', { class: 'db__ibtn', type: 'button', text, title: tip, onclick: fn });
      const head = h('div', { class: 'db__ihead', title: tt('按住拖动可调整位置') },
        h('span', { class: 'db__grip', text: '⠿', attrs: { 'aria-hidden': 'true' } }),
        h('span', { class: 'db__ititle', text: s.title }),
        s.kind === 'pivot' ? btn('↗', tt('打开透视表'), () => { void g.setView('pivot:' + s.p.id); }) : null,
        btn(it.wide ? '⇲' : '⤢', it.wide ? tt('改为半宽') : tt('占满一行'), () => this._saveLayout(nextLayout(items, 'wide', it.id))),
        btn(tt('隐藏'), tt('隐藏这一项（原位置会留一条占位，点它恢复）'), () => this._saveLayout(nextLayout(items, 'hidden', it.id))));
      let body;
      if (s.kind === 'pivot') {
        body = h('div', { class: 'db__pv' }, pivotTable(g, s.p));
      } else {
        body = h('canvas', { class: 'db__canvas' });
        toDraw.push({ canvas: body, c: s.c });
      }
      const grip = h('div', { class: 'db__rsz', title: tt('拖动调整大小'), attrs: { 'aria-hidden': 'true' } });
      const box = h('figure', { class: 'db__chart db__item' + (it.wide ? ' db__item--wide' : '') + (it.size?.h ? ' db__item--sized' : '') },
        head, body,
        s.kind === 'chart' && guessed ? h('figcaption', { class: 'db__cap', text: tt('根据数据自动生成 · 在表格视图中插入图表后会显示在这里') }) : null,
        grip);
      if (it.size?.h) box.style.height = it.size.h + 'px';
      if (s.kind === 'pivot') box.dataset.pivot = s.p.id;
      if (it.size) sized.push({ box, it });
      this._dnd(box, it.id, items, head);
      this._resizer(grip, box, it.id, items, s.kind === 'chart' ? () => this._draw(/** @type {any} */ (body), s.c, theme, rng) : null);
      return box;
    });
    this.charts.replaceChildren(...nodes);
    // 拖出来的宽度按当前实际列数截断：列数比保存时少（窄屏）不能撑出隐式列
    const ncols = this._cols();
    for (const { box, it } of sized) {
      if (!it.wide && it.size.w && ncols > 1) box.style.gridColumn = 'span ' + Math.min(it.size.w, ncols);
    }
    for (const { canvas, c } of toDraw) this._draw(canvas, c, theme, rng);
  }

  /** 导出为图片 / PDF：按页面上的实际排布重画一张（见 dashexport.js）。 @param {'png'|'pdf'} kind */
  async _export(kind) {
    const g = this.g;
    if (g.noCopy) return;
    const { renderDashboard, canvasBlob, pdfFromJpeg } = await import('./dashexport.js');
    const { download } = await import('../grid/commands.js');
    const table = plainTitle(g.nameEl?.textContent) || tt('表格');
    const name = tt('{table} 仪表盘', { table }).replace(/[\/:*?"<>|]/g, '_');
    const d = new Date(), pad = (/** @type {number} */ n) => String(n).padStart(2, '0');
    const stamp = d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
    try {
      const canvas = renderDashboard(this, { title: tt('{table} · 仪表盘', { table }), sub: tt('导出于 {time}', { time: stamp }), theme: readChartTheme(this.root) });
      if (kind === 'png') {
        download(await canvasBlob(canvas, 'image/png'), name + '.png');
      } else {
        const jpeg = new Uint8Array(await (await canvasBlob(canvas, 'image/jpeg', 0.92)).arrayBuffer());
        // 画布是 2 倍图：页面尺寸按 CSS 像素算（1px = 0.75pt）
        const pdf = pdfFromJpeg(jpeg, canvas.width, canvas.height, canvas.width / 2 * 0.75, canvas.height / 2 * 0.75);
        download(new Blob([pdf], { type: 'application/pdf' }), name + '.pdf');
      }
      g.opts.onStatus?.(tt('已导出 {name}', { name: name + '.' + kind }), 'ok');
    } catch (err) {
      g.opts.onStatus?.(err instanceof Error ? err.message : tt('导出失败'), 'error');
    }
  }

  /** 画一张图表，大小取画布当前的 CSS 尺寸。 */
  _draw(canvas, c, theme, rng) {
    const dpr = window.devicePixelRatio || 1;
    const w = Math.max(160, canvas.clientWidth || 480), hh = Math.max(100, canvas.clientHeight || 300);
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(hh * dpr);
    const ctx = canvas.getContext?.('2d');
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    let data = chartData(this.g, c);
    if (c.cols) { const want = this._name(c.cols[1], rng.header); const one = data.series.find((s) => s.name === want) ?? data.series[0]; data = { ...data, series: one ? [one] : [] }; }
    try { drawChart(ctx, w, hh, c, data, theme); } catch (err) { console.warn('dashboard chart', err); }
  }

  /** 网格当前有几列（auto-fill 随宽度变）。 */
  _cols() {
    const t = getComputedStyle(this.charts).gridTemplateColumns;
    return t && t !== 'none' ? t.split(' ').filter(Boolean).length : 1;
  }

  /**
   * 右下角拖动改大小：高度跟手，宽度吸附到网格列。松手才保存（一次撤销）。
   * @param {HTMLElement} grip @param {HTMLElement} box @param {string} id @param {any[]} items @param {(() => void) | null} redraw
   */
  _resizer(grip, box, id, items, redraw) {
    grip.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      e.stopPropagation();
      const start = box.getBoundingClientRect();
      const x0 = e.clientX, y0 = e.clientY;
      const ncols = this._cols();
      const cs = getComputedStyle(this.charts);
      const gap = parseFloat(cs.columnGap) || 0;
      const colW = (this.charts.clientWidth + gap) / ncols;
      let span = Math.max(1, Math.round((start.width + gap) / colW)), hh = start.height, raf = 0;
      grip.setPointerCapture?.(e.pointerId);
      box.classList.add('is-resizing', 'db__item--sized');
      const move = (ev) => {
        hh = Math.round(Math.max(MIN_H, Math.min(MAX_H, start.height + ev.clientY - y0)));
        span = Math.max(1, Math.min(ncols, Math.round((start.width + ev.clientX - x0 + gap) / colW)));
        box.style.height = hh + 'px';
        box.style.gridColumn = span >= ncols ? '1 / -1' : 'span ' + span;
        if (redraw && !raf) raf = requestAnimationFrame(() => { raf = 0; redraw(); });
      };
      const up = () => {
        grip.removeEventListener('pointermove', move);
        grip.removeEventListener('pointerup', up);
        grip.removeEventListener('pointercancel', up);
        cancelAnimationFrame(raf);
        box.classList.remove('is-resizing');
        this._saveLayout(resizeLayout(items, id, { span, cols: ncols, h: hh }));
      };
      grip.addEventListener('pointermove', move);
      grip.addEventListener('pointerup', up);
      grip.addEventListener('pointercancel', up);
    });
  }

  /**
   * 拖放：handle（标题栏 / 占位条本身）可拖，整块都是放置目标。
   * 落在目标的左半（整行项看上半）→ 插到它前面，否则后面。
   * @param {HTMLElement} el @param {string} id @param {{id:string, hidden:boolean, wide:boolean}[]} items @param {HTMLElement} [handle]
   */
  _dnd(el, id, items, handle = el) {
    handle.draggable = true;
    const clear = (n) => n.classList.remove('db__drop-before', 'db__drop-after');
    handle.addEventListener('dragstart', (e) => {
      this._drag = id;
      el.classList.add('is-dragging');
      e.dataTransfer?.setData('text/plain', id);
      if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move';
    });
    handle.addEventListener('dragend', () => {
      this._drag = null;
      el.classList.remove('is-dragging');
      for (const n of this.charts.querySelectorAll('.db__drop-before, .db__drop-after')) clear(n);
    });
    const after = (e) => {
      const r = el.getBoundingClientRect();
      const fullRow = r.width > this.charts.clientWidth * 0.75;
      return fullRow ? e.clientY > r.top + r.height / 2 : e.clientX > r.left + r.width / 2;
    };
    el.addEventListener('dragover', (e) => {
      if (this._drag == null || this._drag === id) return;
      e.preventDefault();
      const a = after(e);
      el.classList.toggle('db__drop-after', a);
      el.classList.toggle('db__drop-before', !a);
    });
    el.addEventListener('dragleave', (e) => { if (!el.contains(/** @type {any} */ (e.relatedTarget))) clear(el); });
    el.addEventListener('drop', (e) => {
      e.preventDefault();
      clear(el);
      const from = this._drag;
      this._drag = null;
      if (from == null) return;
      const order = moveItem(items.map((x) => x.id), from, id, after(e));
      if (order) this._saveLayout(nextLayout(items, null, undefined, order));
    });
  }
}
