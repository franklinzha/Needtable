/**
 * 看板视图：按某一列的取值把行分组成卡片列。拖动卡片 = 改那一格的值，
 * 所以看板不是另一份数据，只是同一张表的另一种画法 —— 撤销、协作、公式全部照常。
 */

import { h, select } from '../ui/dom.js';
import { lastRow, lastCol } from '../grid/commands.js';
import { colName } from '../../shared/util/a1.js';
import { t as tt } from '../../shared/i18n/i18n.js';

const MAX_CARDS = 200;
/** 空分组的键（只在内存里用来分组 / 比较），同时也是列标题 */
const BLANK = tt('（空白）');

export class KanbanView {
  /** @param {any} grid @param {HTMLElement} host */
  constructor(grid, host) {
    this.g = grid;
    this.host = host;
    this.bar = h('div', { class: 'kb__bar' });
    this.board = h('div', { class: 'kb__board' });
    this.root = h('div', { class: 'kb' }, this.bar, this.board);
    host.replaceChildren(this.root);
    this._drag = null;
    this.refresh();
  }

  destroy() { this.root.remove(); }

  /** 当前配置，缺省时猜一个：分组取第一个"取值少且重复多"的列。 */
  _cfg() {
    const saved = this.g.model.props.kanban ?? {};
    const C = Math.max(0, lastCol(this.g.model));
    const header = saved.header !== false;
    let groupCol = saved.groupCol;
    if (!(groupCol >= 0 && groupCol <= C)) groupCol = this._guessGroup(header, C);
    const titleCol = saved.titleCol >= 0 ? saved.titleCol : groupCol === 0 ? Math.min(1, C) : 0;
    const descCol = saved.descCol >= 0 || saved.descCol === -1 ? saved.descCol : -1;
    return { header, groupCol, titleCol, descCol };
  }

  _guessGroup(header, C) {
    const m = this.g.model, calc = this.g.calc, R = Math.min(lastRow(m), 300);
    let best = 0, bestScore = -1;
    for (let c = 0; c <= C; c++) {
      const vals = new Set();
      let n = 0;
      for (let r = header ? 1 : 0; r <= R; r++) { const t = calc.text(r, c); if (t) { vals.add(t); n++; } }
      if (!n) continue;
      const score = vals.size >= 2 && vals.size <= 12 ? n / vals.size : 0;
      if (score > bestScore) { best = c; bestScore = score; }
    }
    return best;
  }

  _save(patch) {
    if (this.g.readonly) { Object.assign(this._local ??= {}, patch); this.refresh(); return; }
    const cur = { ...(this.g.model.props.kanban ?? {}), ...this._cfg(), ...patch };
    this.g.exec([{ t: 'setProp', key: 'kanban', value: cur }]);
  }

  _fieldName(c, header) {
    const t = header ? this.g.calc.text(0, c) : '';
    const title = this.g.model.colTitle(c);
    return (t || title) + (t && title !== colName(c) ? '' : '（' + colName(c) + '）');
  }

  refresh() {
    const g = this.g, m = g.model, calc = g.calc;
    const cfg = { ...this._cfg(), ...(this._local ?? {}) };
    const C = Math.max(0, lastCol(m)), R = lastRow(m);
    const fields = [];
    for (let c = 0; c <= C; c++) fields.push([String(c), this._fieldName(c, cfg.header)]);

    // ── 配置栏
    const pick = (label, key, withNone) => {
      const sel = select(withNone ? [['-1', tt('（不显示）')], ...fields] : fields, String(cfg[key]), {
        class: 'ui-input kb__select', onchange: () => this._save({ [key]: Number(sel.value) }),
      });
      return h('label', { class: 'kb__field' }, h('span', { text: label }), sel);
    };
    const hdr = h('input', { type: 'checkbox', checked: cfg.header, onchange: () => this._save({ header: hdr.checked }) });
    this.bar.replaceChildren(
      pick(tt('分组依据'), 'groupCol'), pick(tt('卡片标题'), 'titleCol'), pick(tt('描述'), 'descCol', true),
      h('label', { class: 'ui-check' }, hdr, h('span', { text: tt('首行是标题') })),
      h('span', { class: 'kb__hint', text: g.readonly ? tt('只读：不能拖动卡片') : tt('拖动卡片到其他列即可修改「{field}」', { field: this._fieldName(cfg.groupCol, cfg.header) }) }),
    );

    // ── 分组
    /** @type {Map<string, number[]>} */ const groups = new Map();
    const rule = calc.validationAt(cfg.header ? 1 : 0, cfg.groupCol);
    if (rule?.type === 'list') for (const o of calc.dropdownOptions(rule, cfg.header ? 1 : 0, cfg.groupCol).options) groups.set(o, []);
    const hidden = new Set(m.props.hiddenRows ?? []);
    for (let r = cfg.header ? 1 : 0; r <= R; r++) {
      if (hidden.has(r)) continue;
      let any = false;
      for (let c = 0; c <= C && !any; c++) if (m.getCell(r, c) !== '') any = true;
      if (!any) continue;
      const key = calc.text(r, cfg.groupCol) || BLANK;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(r);
    }
    if (groups.has(BLANK)) { const b = groups.get(BLANK); groups.delete(BLANK); if (b.length) groups.set(BLANK, b); }

    const cols = [];
    for (const [key, rows] of groups) {
      const list = h('div', { class: 'kb__cards' });
      for (const r of rows.slice(0, MAX_CARDS)) list.append(this._card(r, cfg));
      if (rows.length > MAX_CARDS) list.append(h('div', { class: 'kb__more', text: tt('还有 {n} 张…', { n: rows.length - MAX_CARDS }) }));
      const col = h('section', { class: 'kb__col', dataset: { key } },
        h('header', { class: 'kb__head' }, h('span', { class: 'kb__title', text: key }), h('span', { class: 'kb__count', text: String(rows.length) })),
        list);
      this._dropTarget(col, key, cfg);
      cols.push(col);
    }
    if (!cols.length) cols.push(h('div', { class: 'kb__empty', text: tt('表格里还没有数据。回到「表格」视图输入几行，再来这里看看。') }));
    this.board.replaceChildren(...cols);
  }

  _card(r, cfg) {
    const calc = this.g.calc, C = Math.max(0, lastCol(this.g.model));
    const title = calc.text(r, cfg.titleCol) || tt('第 {n} 行', { n: r + 1 });
    const desc = cfg.descCol >= 0 ? calc.text(r, cfg.descCol) : '';
    const meta = [];
    for (let c = 0; c <= C && meta.length < 3; c++) {
      if (c === cfg.groupCol || c === cfg.titleCol || c === cfg.descCol) continue;
      const t = calc.text(r, c);
      if (t) meta.push(h('div', { class: 'kb__meta' }, h('span', { class: 'kb__mk', text: this._fieldName(c, cfg.header).replace(/（[A-Z]+）$/, '') }), h('span', { text: t })));
    }
    const card = h('article', { class: 'kb__card', tabIndex: 0, draggable: !this.g.readonly, dataset: { row: String(r) }, title: tt('双击在表格中定位') },
      h('div', { class: 'kb__ctitle', text: title }),
      desc ? h('div', { class: 'kb__desc', text: desc }) : null,
      meta,
      h('div', { class: 'kb__row', text: '#' + (r + 1) }));
    const locate = () => {
      void this.g.setView('grid').then(() => this.g.goto(colName(cfg.titleCol) + (r + 1)));
    };
    card.addEventListener('dblclick', locate);
    card.addEventListener('keydown', (e) => { if (e.key === 'Enter') locate(); });
    card.addEventListener('dragstart', (e) => {
      this._drag = r;
      card.classList.add('is-dragging');
      e.dataTransfer?.setData('text/plain', String(r));
      if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move';
    });
    card.addEventListener('dragend', () => { this._drag = null; card.classList.remove('is-dragging'); });
    return card;
  }

  _dropTarget(col, key, cfg) {
    col.addEventListener('dragover', (e) => {
      if (this._drag == null) return;
      e.preventDefault();
      col.classList.add('is-over');
    });
    col.addEventListener('dragleave', (e) => { if (!col.contains(/** @type {any} */ (e.relatedTarget))) col.classList.remove('is-over'); });
    col.addEventListener('drop', (e) => {
      e.preventDefault();
      col.classList.remove('is-over');
      const r = this._drag;
      this._drag = null;
      if (r == null || this.g.readonly) return;
      const v = key === BLANK ? '' : key;
      if (this.g.calc.text(r, cfg.groupCol) === v) return;
      const raw = this.g.model.getCell(r, cfg.groupCol);
      if (raw.startsWith('=')) { this.g.opts.onStatus?.(tt('该单元格是公式，不能通过拖动修改'), 'error'); return; }
      this.g.exec([{ t: 'setCell', r, c: cfg.groupCol, v }]);
    });
  }
}
