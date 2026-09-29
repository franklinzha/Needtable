/**
 * 透视表视图：每个透视表一个视图标签，排在「仪表盘」后面。
 * 数据实时取自表格（计算后的值），表格一改这里就重算 —— 透视表本身不存任何结果。
 *
 * 和 Excel 一样：右侧「字段列表」列出数据区域的全部字段，勾选或拖到 筛选 / 列 / 行 / 值 四个区域；
 * 点区域里的字段可以改汇总方式（求和、计数、去重计数、中位数…）、值显示方式（行 / 列 / 总计的百分比）、
 * 值显示格式（数字格式和小数位）、重命名、挪位置或移除。「高级设置」管总计、分类汇总、布局、前 N 项、排序。筛选字段显示在表格上方，
 * 行 / 列字段标题上的 ▾ 也能筛选取值。每次改动都是一次 setProp，可撤销、实时同步给协作者。
 */

import { h, select, placeNear } from '../ui/dom.js';
import { openMenu } from '../ui/menu.js';
import { promptDialog } from '../ui/dialog.js';
import {
  computePivot, pivotLayout, fmtValue, validPivot, normPivot, fieldName, valueLabel, fieldValues, looksNumeric, moveField, fieldUsed,
  PIVOT_AGGS, PIVOT_SHOW, PIVOT_FMTS, PIVOT_SORTS, PIVOT_LAYOUTS, PIVOT_LIMITS, BLANK, MAX_FIELD_VALUES,
} from '../grid/pivotcalc.js';
import { rangeName, colName } from '../../shared/util/a1.js';
import { t as tt } from '../../shared/i18n/i18n.js';

const AREAS = /** @type {const} */ ([['filters', tt('筛选')], ['cols', tt('列')], ['rows', tt('行')], ['values', tt('值')]]);
/** 分组键显示：空白键（BLANK 是内部比较键）显示成当前语言 */
const disp = (k) => (k === BLANK ? tt('(空白)') : k);
const AREA_LABEL = Object.fromEntries(AREAS);
/** 表头行高（与 CSS 的 .pv__table th 一致），多行表头的 sticky 偏移用 */
const HEAD_ROW_H = 27;

/**
 * 画成一张 HTML 表。仪表盘里也用它（不带 ui，就没有 ▾ 筛选按钮）。
 * @param {any} g @param {any} p
 * @param {{onPick?: (col:number, el:HTMLElement) => void, onSort?: (v:number, col:string[]|null) => void, onLabelSort?: () => void}} [ui]
 */
export function pivotTable(g, p, ui = {}) {
  if (!validPivot(p)) return h('div', { class: 'pv__empty', text: tt('这个透视表的数据区域已失效，请点「更改数据源」重新设置。') });
  const res = computePivot(p, (r, c) => g.calc.value(r, c), (r, c) => g.calc.text(r, c), (c) => g.model.colTitle(c));
  if (res.error) return h('div', { class: 'pv__empty', text: res.error });
  const hide = normPivot(p).hide;
  const o = res.opts;
  const nv = res.valueLabels.length;
  const ncf = res.colFields.length;
  const depth = res.rowFields.length;
  const lay = pivotLayout(res);
  const rowSpan = lay.keyCols;
  const nk = res.colKeys.length;
  const totalCol = ncf > 0 && o.rowTotals;
  const th = (text, props = {}) => h('th', { text, ...props });
  const span = (n) => (n > 1 ? String(n) : null);
  const fmt = (n, i) => fmtValue(res, n, i);
  const td = (n, i) => h('td', { class: 'pv__num', text: fmt(n, i) });
  const sk = res.sortKey;
  const same = (a, b) => (a == null ? b == null : b != null && a.every((x, i) => x === b[i]));
  /** 值列标题：点击按这一列排序（降序 → 升序 → 恢复按标签），当前排序列带箭头 */
  const sortHead = (text, v, col, props = {}) => {
    const cell = th(text, props);
    if (!ui.onSort) return cell;
    const on = sk && sk.v === v && same(sk.col, col);
    cell.classList.add('pv__sortable');
    if (on) { cell.classList.add('is-sorted'); cell.append(h('span', { class: 'pv__arrow', text: sk.dir === 'desc' ? ' ↓' : ' ↑' })); }
    cell.title = on ? (sk.dir === 'desc' ? tt('已按此列降序 · 点击改为升序') : tt('已按此列升序 · 点击恢复按标签排序')) : tt('点击按此列降序排序');
    cell.addEventListener('click', () => ui.onSort?.(v, col));
    return cell;
  };

  /** 字段标题：名字 + ▾（筛选过的高亮） */
  const fieldHead = (name, col, props = {}) => {
    const label = h('span', { text: name });
    const cell = h('th', { class: 'pv__field', ...props }, label);
    if (ui.onLabelSort && res.rowCols.includes(col)) {
      const desc = o.sort === 'desc';
      label.classList.add('pv__sortable');
      label.title = sk ? tt('点击按标签升序排序') : desc ? tt('按标签降序 · 点击改为升序') : tt('按标签升序 · 点击改为降序');
      if (!sk) label.append(h('span', { class: 'pv__arrow', text: desc ? ' ↓' : ' ↑' }));
      label.addEventListener('click', () => ui.onLabelSort?.());
    }
    if (ui.onPick) {
      const on = !!hide[col]?.length;
      const b = h('button', { class: 'pv__dd' + (on ? ' is-on' : ''), type: 'button', text: on ? '⏷' : '▾',
        title: on ? tt('已筛选 · 点击修改') : tt('筛选「{name}」的取值', { name }) });
      b.addEventListener('click', (e) => { e.stopPropagation(); ui.onPick?.(col, b); });
      cell.append(b);
    }
    return cell;
  };
  const rowHeads = () => {
    if (!depth) return [th('', { class: 'pv__corner' })];
    if (!lay.compact) return res.rowFields.map((f, i) => fieldHead(f, res.rowCols[i]));
    // 压缩形式：所有行字段挤在一格表头里
    const cell = h('th', { class: 'pv__field' });
    res.rowFields.forEach((f, i) => {
      cell.append(...fieldHead(f, res.rowCols[i]).childNodes);
      if (i < depth - 1) cell.append(h('span', { class: 'pv__sep', text: ' / ' }));
    });
    return [cell];
  };

  /** @type {HTMLElement[]} */ const head = [];
  if (ncf) {
    // 第一行：角落 + 列字段名；接着每一层列字段一行（相同前缀合并）；多个值字段再加一行值标题
    const corner = nv === 1 ? res.valueLabels[0] : nv ? tt('值') : '';
    const top = h('tr', null, th(corner, { class: 'pv__corner', attrs: { colspan: span(rowSpan) } }));
    const fields = h('th', { class: 'pv__field pv__cfields', attrs: { colspan: span(nk * Math.max(1, nv)) } });
    res.colFields.forEach((f, i) => {
      const x = fieldHead(f, res.colCols[i]);
      fields.append(...x.childNodes);
      if (i < ncf - 1) fields.append(h('span', { class: 'pv__sep', text: ' / ' }));
    });
    top.append(fields);
    if (totalCol) {
      const tp = { class: 'pv__tcol', attrs: { colspan: span(Math.max(1, nv)), rowspan: span(ncf + 1) } };
      top.append(nv === 1 ? sortHead(tt('总计'), 0, null, tp) : th(tt('总计'), tp));
    }
    head.push(top);
    for (let l = 0; l < ncf; l++) {
      const isLast = l === ncf - 1 && nv <= 1;
      const tr = h('tr', null, ...(isLast ? rowHeads() : [th('', { attrs: { colspan: span(rowSpan) } })]));
      for (let k = 0; k < nk;) {
        let j = k + 1;
        while (j < nk && res.colKeys[j].slice(0, l + 1).every((x, t) => x === res.colKeys[k][t])) j++;
        const cp = { attrs: { colspan: span((j - k) * Math.max(1, nv)) } };
        tr.append(isLast && nv === 1 ? sortHead(disp(res.colKeys[k][l]), 0, res.colKeys[k], cp) : th(disp(res.colKeys[k][l]), cp));
        k = j;
      }
      head.push(tr);
    }
    if (nv > 1) {
      const tr = h('tr', null, ...rowHeads());
      for (let k = 0; k < nk + (totalCol ? 1 : 0); k++) {
        tr.append(...res.valueLabels.map((l, i) => sortHead(l, i, k < nk ? res.colKeys[k] : null, { class: 'pv__vl' })));
      }
      head.push(tr);
    }
  } else {
    head.push(h('tr', null, ...rowHeads(), ...res.valueLabels.map((l, i) => sortHead(l, i, null))));
  }
  head.forEach((tr, i) => { for (const c of tr.children) /** @type {HTMLElement} */ (c).style.top = i * HEAD_ROW_H + 'px'; });

  const dataCells = (row) => {
    if (!ncf) return row.total.map(td);
    const out = row.cells.map((n, j) => td(n, j % Math.max(1, nv)));
    if (totalCol) out.push(...row.total.map((n, i) => h('td', { class: 'pv__num pv__tc', text: fmt(n, i) })));
    return out;
  };

  /** @type {HTMLElement[]} */ const body = [];
  // 行区域按报表布局排好（pivotLayout）；合并的外层标签用 rowspan，被合并的格子不画
  const rowspan = new Map(lay.merges.map(([r, c, n]) => [r + ':' + c, n]));
  const covered = new Set(lay.merges.flatMap(([r, c, n]) => Array.from({ length: n - 1 }, (_, i) => (r + 1 + i) + ':' + c)));
  const width = rowSpan + (ncf ? nk * Math.max(1, nv) + (totalCol ? Math.max(1, nv) : 0) : nv);
  lay.lines.forEach((line, i) => {
    if (line.kind === 'blank') { body.push(h('tr', { class: 'pv__blank' }, h('td', { attrs: { colspan: span(width) } }))); return; }
    const keys = [];
    line.keys.forEach((k, d) => {
      if (covered.has(i + ':' + d)) return;
      const n = rowspan.get(i + ':' + d);
      const cell = h('td', { class: 'pv__key' + (n ? ' pv__merged' : ''), text: disp(k), attrs: { rowspan: n ? String(n) : null } });
      if (line.indent) cell.style.paddingLeft = (10 + line.indent * 16) + 'px';
      keys.push(cell);
    });
    const cls = line.kind === 'sub' ? 'pv__sub' : line.kind === 'group' ? 'pv__group' : null;
    body.push(h('tr', { class: cls }, ...keys, ...dataCells(line.row)));
  });
  if (o.colTotals || !depth) {
    body.push(h('tr', { class: 'pv__total' },
      h('td', { class: 'pv__key', text: tt('总计'), attrs: { colspan: span(rowSpan) } }), ...dataCells(res.total)));
  }

  const table = h('table', { class: 'pv__table' }, h('thead', null, ...head), h('tbody', null, ...body));
  const wrap = h('div', { class: 'pv__scroll' }, table);
  if (res.topHidden) {
    const ti = res.topInfo;
    const text = ti?.by
      ? tt(ti.dir === 'min' ? '只显示了「{field}」中「{by}」最小的 {top} 项，另有 {hidden} 项未显示（高级设置 →「只显示前 N 项」）。' : '只显示了「{field}」中「{by}」最大的 {top} 项，另有 {hidden} 项未显示（高级设置 →「只显示前 N 项」）。',
        { field: ti.field, by: ti.by, top: o.top, hidden: res.topHidden })
      : tt('只显示了前 {top} 项，另有 {hidden} 项未显示（高级设置 →「只显示前 N 项」）。', { top: o.top, hidden: res.topHidden });
    wrap.append(h('p', { class: 'pv__note', text }));
  }
  if (res.truncated) wrap.append(h('p', { class: 'pv__note', text: tt('分组太多，只显示了前面一部分。可以换一个取值更少的字段来分组，或用筛选缩小范围。') }));
  return wrap;
}

export class PivotView {
  /** @param {any} grid @param {HTMLElement} host @param {string} id */
  constructor(grid, host, id) {
    this.g = grid;
    this.id = id;
    this.title = h('h2', { class: 'db__h' });
    this.src = h('span', { class: 'pv__src' });
    this.filters = h('div', { class: 'pv__filters' });
    this.body = h('div', { class: 'pv__body' });
    this.panel = h('aside', { class: 'pvf', attrs: { 'aria-label': tt('透视表字段列表') } });
    const btn = (text, title, cmd) => h('button', { class: 'ui-btn ui-btn--sm', type: 'button', text, title,
      onclick: () => this.g.cmd.run(cmd, this.id) });
    this.toggle = h('button', { class: 'ui-btn ui-btn--sm', type: 'button', text: tt('字段列表'), title: tt('显示 / 隐藏右侧字段列表'),
      onclick: () => { this._open = !this._open; this._panelSig = ''; this.refresh(); } });
    this.btns = [
      btn(tt('更改数据源'), tt('更改数据区域和表头设置'), 'editPivot'),
      btn(tt('重命名'), tt('修改透视表名称（也可以双击上方标签）'), 'renamePivot'),
      btn(tt('删除'), tt('删除这个透视表（不影响表格数据）'), 'deletePivot'),
    ];
    // 只读也能导出；公开只读链接里不能
    const exp = this.g.noCopy ? [] : [btn(tt('导出 Excel'), tt('导出为 Excel：数据一张工作表，每个透视表各一张'), 'exportXlsx')];
    this.root = h('div', { class: 'db pv' },
      h('div', { class: 'db__bar' }, this.title, this.src, h('div', { class: 'grid__spacer' }), this.toggle, ...exp, ...this.btns),
      h('div', { class: 'pv__main' }, h('div', { class: 'pv__left' }, this.filters, this.body), this.panel));
    host.replaceChildren(this.root);
    this._raf = 0;
    /** 字段列表是否展开 */ this._open = true;
    this._panelSig = '';
    this._search = '';
    this._adv = false;
    /** 正在拖的字段 @type {{area:string, index?:number, col:number} | null} */ this._drag = null;
    /** @type {HTMLElement | null} */ this._pop = null;
    this.refresh();
  }

  destroy() { cancelAnimationFrame(this._raf); this._closePop(); this.root.remove(); }

  refresh() {
    cancelAnimationFrame(this._raf);
    this._raf = requestAnimationFrame(() => this._render());
  }

  _def() { return (this.g.model.props.pivots ?? []).find((x) => x?.id === this.id); }

  /** 保存新定义（一次 setProp，可撤销）。 @param {any} next */
  _save(next) {
    if (!next || this.g.readonly) return;
    const list = this.g.model.props.pivots ?? [];
    this.g.exec([{ t: 'setProp', key: 'pivots', value: list.map((x) => (x?.id === this.id ? next : x)) }]);
  }

  /** 点值列标题：降序 → 升序 → 恢复按标签升序。 */
  _sortBy(p, v, col) {
    const o = normPivot(p).opts;
    const cur = (o.sort === 'valDesc' || o.sort === 'valAsc') && o.sortVal === v
      && JSON.stringify(o.sortCol ?? null) === JSON.stringify(col ?? null);
    const sort = !cur ? 'valDesc' : o.sort === 'valDesc' ? 'valAsc' : 'asc';
    const opts = { ...(p.opts ?? {}), sort };
    if (sort === 'asc') { delete opts.sortVal; delete opts.sortCol; } else { opts.sortVal = v; opts.sortCol = col ?? null; }
    this._save({ ...p, opts });
  }

  /** 点行字段名：按标签升序 / 降序切换（正在按值排序时先回到升序）。 */
  _sortLabel(p) {
    const o = normPivot(p).opts;
    const opts = { ...(p.opts ?? {}), sort: o.sort === 'asc' ? 'desc' : 'asc' };
    delete opts.sortVal; delete opts.sortCol;
    this._save({ ...p, opts });
  }

  /** 字段显示名（含自定义名称）；raw = 原始名称（字段清单里用）。 */
  _name(p, c, raw = false) { return fieldName(p, c, (r, cc) => this.g.calc.text(r, cc), (cc) => this.g.model.colTitle(cc), raw); }

  _render() {
    const p = this._def();
    if (!p) return;
    const ro = !!this.g.readonly;
    this.title.textContent = p.name || tt('透视表');
    this.src.textContent = validPivot(p) ? tt('数据源 {range}', { range: rangeName(...p.range) }) : '';
    for (const b of this.btns) b.disabled = ro;
    this.toggle.hidden = ro;
    this.toggle.classList.toggle('is-active', this._open);
    const ui = ro ? {} : {
      onPick: (col, el) => this._picker(p, col, el),
      onSort: (v, col) => this._sortBy(p, v, col),
      onLabelSort: () => this._sortLabel(p),
    };
    this.body.replaceChildren(pivotTable(this.g, p, ui));
    this._renderFilters(p, ro);
    const show = !ro && this._open && validPivot(p);
    this.panel.hidden = !show;
    if (!show) return;
    const [, c0, , c1] = p.range;
    const names = [];
    for (let c = c0; c <= c1; c++) names.push(this._name(p, c, true));
    const sig = JSON.stringify([p, names]);
    if (sig !== this._panelSig) { this._panelSig = sig; this._renderPanel(p, names); }
  }

  /** 表格上方的筛选字段：「地区：全部 ▾」。 */
  _renderFilters(p, ro) {
    const n = normPivot(p);
    if (!validPivot(p) || !n.filters.length) { this.filters.replaceChildren(); this.filters.hidden = true; return; }
    this.filters.hidden = false;
    this.filters.replaceChildren(...n.filters.filter((c) => c >= p.range[1] && c <= p.range[3]).map((c) => {
      const hidden = n.hide[c] ?? [];
      let state = tt('全部');
      if (hidden.length) {
        const all = fieldValues(p, c, (r, cc) => this.g.calc.text(r, cc));
        const shown = all.filter((v) => !hidden.includes(v));
        state = shown.length === 1 ? disp(shown[0]) : shown.length ? tt('（多项）') : tt('（无）');
      }
      const b = h('button', { class: 'pv__fchip' + (hidden.length ? ' is-on' : ''), type: 'button', disabled: ro,
        title: ro ? '' : tt('选择要包含的取值') },
        h('span', { class: 'pv__fname', text: tt('{name}：', { name: this._name(p, c) }) }), h('span', { text: state }), h('span', { class: 'pv__caret', text: ' ▾' }));
      b.addEventListener('click', () => this._picker(p, c, b));
      return b;
    }));
  }

  // ── 取值筛选弹窗 ────────────────────────────────────────────────────────

  _closePop() {
    if (!this._pop) return;
    this._pop.remove();
    this._pop = null;
    document.removeEventListener('pointerdown', this._popDown, true);
    document.removeEventListener('keydown', this._popKey, true);
  }

  /** 勾选要包含的取值。hide 存的是**没勾的**，所以数据里新出现的取值默认显示。 */
  _picker(p, col, anchor) {
    this._closePop();
    const all = fieldValues(p, col, (r, c) => this.g.calc.text(r, c));
    const hidden = new Set(normPivot(p).hide[col] ?? []);
    const checks = new Map();
    const search = h('input', { class: 'ui-input pvp__search', type: 'search', placeholder: tt('搜索') });
    const allBox = h('input', { type: 'checkbox' });
    const list = h('div', { class: 'pvp__list' });
    const sync = () => {
      const vis = [...checks.values()].filter((x) => !x.row.hidden);
      const n = vis.filter((x) => x.input.checked).length;
      allBox.checked = n > 0 && n === vis.length;
      allBox.indeterminate = n > 0 && n < vis.length;
    };
    for (const v of all) {
      const input = h('input', { type: 'checkbox', checked: !hidden.has(v), onchange: sync });
      const row = h('label', { class: 'pvp__item' }, input, h('span', { text: disp(v) }));
      checks.set(v, { input, row });
      list.append(row);
    }
    search.addEventListener('input', () => {
      const q = search.value.trim().toLowerCase();
      for (const [v, x] of checks) x.row.hidden = !!q && !v.toLowerCase().includes(q);
      sync();
    });
    allBox.addEventListener('change', () => {
      for (const x of checks.values()) if (!x.row.hidden) x.input.checked = allBox.checked;
      sync();
    });
    sync();
    const ok = () => {
      const hide = [...checks].filter(([, x]) => !x.input.checked).map(([v]) => v);
      if (hide.length === all.length && all.length) { note.textContent = tt('至少要勾选一项'); return; }
      const cur = this._def();
      if (!cur) return;
      const next = { ...cur, hide: { ...(normPivot(cur).hide) } };
      if (hide.length) next.hide[col] = hide; else delete next.hide[col];
      if (!Object.keys(next.hide).length) delete next.hide;
      this._closePop();
      this._save(next);
    };
    const note = h('div', { class: 'pvp__note', text: all.length >= MAX_FIELD_VALUES ? tt('取值太多，只列出前 {n} 个', { n: MAX_FIELD_VALUES }) : '' });
    const pop = h('div', { class: 'pvp', attrs: { role: 'dialog', 'aria-label': tt('筛选取值') } },
      h('div', { class: 'pvp__title', text: tt('筛选：{name}', { name: this._name(p, col) }) }),
      search,
      h('label', { class: 'pvp__item pvp__all' }, allBox, h('span', { text: tt('（全选）') })),
      list, note,
      h('div', { class: 'pvp__btns' },
        h('button', { class: 'ui-btn ui-btn--sm', type: 'button', text: tt('清除筛选'), onclick: () => { for (const x of checks.values()) x.input.checked = true; ok(); } }),
        h('div', { class: 'grid__spacer' }),
        h('button', { class: 'ui-btn ui-btn--sm', type: 'button', text: tt('取消'), onclick: () => this._closePop() }),
        h('button', { class: 'ui-btn ui-btn--sm ui-btn--primary', type: 'button', text: tt('确定'), onclick: ok })));
    document.body.append(pop);
    const r = anchor.getBoundingClientRect();
    placeNear(pop, r.left, r.bottom + 4);
    this._pop = pop;
    this._popDown = (e) => { if (!pop.contains(e.target) && e.target !== anchor) this._closePop(); };
    this._popKey = (e) => { if (e.key === 'Escape') { e.stopPropagation(); this._closePop(); } else if (e.key === 'Enter' && e.target !== search) ok(); };
    document.addEventListener('pointerdown', this._popDown, true);
    document.addEventListener('keydown', this._popKey, true);
    search.focus();
  }

  // ── 字段列表 ──────────────────────────────────────────────────────────

  /** @param {any} p @param {string[]} names 数据区域各列的字段名 */
  _renderPanel(p, names) {
    const n = normPivot(p);
    const [, c0] = p.range;
    const nameOf = (c) => this._name(p, c);
    const value = (r, c) => this.g.calc.value(r, c);

    // 字段清单：勾选 = 自动放到合适的区域；取消勾选 = 从所有区域移除
    const search = h('input', { class: 'ui-input pvf__search', type: 'search', placeholder: tt('搜索字段'), value: this._search });
    const list = h('div', { class: 'pvf__list', dataset: { area: 'list' } });
    names.forEach((name, i) => {
      const c = c0 + i;
      const used = fieldUsed(p, c);
      const input = h('input', { type: 'checkbox', checked: used, attrs: { 'aria-label': name } });
      input.addEventListener('change', () => {
        const cur = this._def();
        if (!cur) return;
        if (input.checked) {
          const to = looksNumeric(cur, c, value) ? 'values' : 'rows';
          const next = moveField(cur, { area: 'list', col: c }, { area: to })
            ?? moveField(cur, { area: 'list', col: c }, { area: to === 'rows' ? 'cols' : 'rows' });
          if (next) this._save(next); else { input.checked = false; this._flash(tt('区域已满，先移除一些字段')); }
        } else {
          this._save(removeField(cur, c));
        }
      });
      const row = h('label', { class: 'pvf__field' + (used ? ' is-used' : ''), draggable: true, title: tt('拖到下方区域，或勾选自动放置') },
        input, h('span', { class: 'pvf__fname', text: name }), h('span', { class: 'pvf__fcol', text: colName(c) }));
      row.dataset.name = name.toLowerCase();
      row.addEventListener('dragstart', (e) => this._dragStart(e, { area: 'list', col: c }, row));
      row.addEventListener('dragend', () => this._dragEnd(row));
      list.append(row);
    });
    const filterList = () => {
      const q = search.value.trim().toLowerCase();
      this._search = search.value;
      for (const el of list.children) /** @type {HTMLElement} */ (el).hidden = !!q && !/** @type {HTMLElement} */ (el).dataset.name?.includes(q);
    };
    search.addEventListener('input', filterList);
    filterList();
    this._dropZone(list, 'list');

    // 四个区域
    const areas = h('div', { class: 'pvf__areas' }, ...AREAS.map(([key, label]) => {
      const items = key === 'values' ? n.values : n[key];
      const box = h('div', { class: 'pvf__area', dataset: { area: key } },
        h('div', { class: 'pvf__ahead' }, h('span', { class: 'pvf__aicon pvf__aicon--' + key }), h('span', { text: label }),
          h('span', { class: 'pvf__acount', text: items.length + '/' + PIVOT_LIMITS[key] })));
      const zone = h('div', { class: 'pvf__chips', dataset: { area: key } });
      items.forEach((it, index) => {
        const col = key === 'values' ? it.col : it;
        const text = key === 'values' ? valueTitle(it, nameOf(col)) : nameOf(col);
        const filtered = key !== 'values' && !!n.hide[col]?.length;
        const chip = h('div', { class: 'pvf__chip' + (filtered ? ' is-filtered' : ''), draggable: true, tabIndex: 0,
          title: tt('点击设置 · 拖动调整'), dataset: { index: String(index) } },
          h('span', { class: 'pvf__ctext', text: text }),
          h('span', { class: 'pvf__cmenu', text: '▾' }),
          h('button', { class: 'pvf__cx', type: 'button', text: '×', title: tt('移除'),
            onclick: (e) => { e.stopPropagation(); const cur = this._def(); if (cur) this._save(moveField(cur, { area: key, index, col }, { area: 'remove' })); } }));
        chip.addEventListener('dragstart', (e) => this._dragStart(e, { area: key, index, col }, chip));
        chip.addEventListener('dragend', () => this._dragEnd(chip));
        const menu = () => { const r = chip.getBoundingClientRect(); this._chipMenu(key, index, col, { x: r.left, y: r.bottom + 2 }); };
        chip.addEventListener('click', menu);
        chip.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); menu(); } });
        zone.append(chip);
      });
      if (!items.length) zone.append(h('div', { class: 'pvf__hint', text: key === 'values' ? tt('拖入要汇总的字段') : tt('拖入字段') }));
      this._dropZone(zone, key);
      box.append(zone);
      return box;
    }));

    // 高级设置
    const o = n.opts;
    const setOpt = (k, v) => { const cur = this._def(); if (cur) this._save({ ...cur, opts: { ...(cur.opts ?? {}), [k]: v } }); };
    const check = (label, k, tip) => {
      const input = h('input', { type: 'checkbox', checked: !!o[k], onchange: () => setOpt(k, input.checked) });
      return h('label', { class: 'pvf__opt', title: tip ?? '' }, input, h('span', { text: label }));
    };
    const sortSel = select(PIVOT_SORTS.map(([k, l]) => [k, l]), o.sort, { class: 'ui-input ui-input--sm', onchange: (e) => setOpt('sort', e.target.value) });
    const byVal = o.sort === 'valDesc' || o.sort === 'valAsc';
    // 按值排序时选按哪个值字段（按某一列排：直接点表格里那一列的标题）
    const valSel = byVal && n.values.length > 1 ? select(n.values.map((v, i) => [String(i), valueLabel(v, this._name(p, v.col))]), String(o.sortVal),
      { class: 'ui-input ui-input--sm', onchange: (e) => { const cur = this._def(); if (cur) this._save({ ...cur, opts: { ...(cur.opts ?? {}), sortVal: Number(e.target.value), sortCol: null } }); } }) : null;
    const emptyIn = h('input', { class: 'ui-input ui-input--sm', type: 'text', value: o.empty, maxLength: 10, placeholder: tt('留空') });
    emptyIn.addEventListener('change', () => setOpt('empty', emptyIn.value));
    const layoutSel = select(PIVOT_LAYOUTS.map(([k, l]) => [k, l]), o.layout, { class: 'ui-input ui-input--sm', onchange: (e) => setOpt('layout', e.target.value) });
    const topIn = h('input', { class: 'ui-input ui-input--sm', type: 'number', min: '0', max: '1000', step: '1', value: o.top ? String(o.top) : '', placeholder: tt('全部') });
    topIn.addEventListener('change', () => { const n = Math.floor(Number(topIn.value)); setOpt('top', Number.isFinite(n) && n > 0 ? n : 0); });
    // 前 N 项：作用在最外层行字段还是最外层列字段、按哪个值、取最大还是最小
    const topOn = n.cols.length && (o.topOn === 'cols' || !n.rows.length) ? 'cols' : 'rows';
    const onOpts = [...(n.rows.length ? [['rows', tt('行：{name}', { name: this._name(p, n.rows[0]) })]] : []),
      ...(n.cols.length ? [['cols', tt('列：{name}', { name: this._name(p, n.cols[0]) })]] : [])];
    const topOnSel = onOpts.length > 1 ? select(onOpts, topOn, { class: 'ui-input ui-input--sm', onchange: (e) => setOpt('topOn', e.target.value) }) : null;
    const topValSel = n.values.length > 1 ? select(n.values.map((v, i) => [String(i), valueLabel(v, this._name(p, v.col))]), String(o.topVal),
      { class: 'ui-input ui-input--sm', onchange: (e) => setOpt('topVal', Number(e.target.value)) }) : null;
    const topDirSel = n.values.length ? select([['max', tt('最大的 N 项')], ['min', tt('最小的 N 项')]], o.topDir,
      { class: 'ui-input ui-input--sm', onchange: (e) => setOpt('topDir', e.target.value) }) : null;
    const topField = onOpts.find(([k]) => k === topOn);
    const topBy = n.values.length ? valueLabel(n.values[o.topVal] ?? n.values[0], this._name(p, (n.values[o.topVal] ?? n.values[0]).col)) : '';
    const topTip = !topField ? tt('先把字段放进「行」或「列」区域。')
      : !topBy ? tt('没有值字段，按当前排序保留「{field}」的前 N 个。', { field: this._name(p, topOn === 'cols' ? n.cols[0] : n.rows[0]) })
      : tt(o.topDir === 'min' ? '按「{by}」的总计，只保留「{field}」中最小的 N 项；内层字段和另一方向不受影响，总计只算保留的项。' : '按「{by}」的总计，只保留「{field}」中最大的 N 项；内层字段和另一方向不受影响，总计只算保留的项。',
        { by: topBy, field: this._name(p, topOn === 'cols' ? n.cols[0] : n.rows[0]) });
    const adv = h('details', { class: 'pvf__adv', open: this._adv },
      h('summary', { text: tt('高级设置') }),
      check(tt('显示每行的总计（最右列）'), 'rowTotals', tt('有列字段时，在最右侧加一列总计')),
      check(tt('显示每列的总计（底部行）'), 'colTotals'),
      check(tt('显示分类汇总'), 'subtotals', tt('行区域有两个以上字段时，每个外层分组加一行汇总')),
      o.subtotals && check(tt('分类汇总显示在组的顶部'), 'subTop', tt('默认显示在每组的底部')),
      h('div', { class: 'pvf__group', text: tt('报表布局') }),
      h('label', { class: 'pvf__opt pvf__opt--row' }, h('span', { text: tt('布局') }), layoutSel),
      h('p', { class: 'pvf__tip', text: tt('表格形式：每个行字段一列；大纲形式：外层项目单独占一行；压缩形式：所有行字段放在一列，按层缩进。行区域有两个以上字段时才有区别。') }),
      o.layout !== 'compact' && check(tt('重复所有项目标签'), 'repeat', tt('外层标签在每一行都显示，不留空（方便复制、筛选、再做表）')),
      o.layout === 'tabular' && check(tt('合并且居中排列带标签的单元格'), 'merge', tt('相同的外层标签合并成一格')),
      check(tt('在每个项目后插入空行'), 'blank', tt('每个最外层项目结束后空一行，看起来更清楚')),
      h('div', { class: 'pvf__group', text: tt('只显示前 N 项') }),
      h('label', { class: 'pvf__opt pvf__opt--row' }, h('span', { text: tt('项数 N') }), topIn),
      o.top > 0 && topOnSel && h('label', { class: 'pvf__opt pvf__opt--row' }, h('span', { text: tt('作用于') }), topOnSel),
      o.top > 0 && topValSel && h('label', { class: 'pvf__opt pvf__opt--row' }, h('span', { text: tt('依据') }), topValSel),
      o.top > 0 && topDirSel && h('label', { class: 'pvf__opt pvf__opt--row' }, h('span', { text: tt('保留') }), topDirSel),
      h('p', { class: 'pvf__tip', text: topTip }),
      h('div', { class: 'pvf__group', text: tt('排序与显示') }),
      h('label', { class: 'pvf__opt pvf__opt--row' }, h('span', { text: tt('行排序') }), sortSel),
      valSel && h('label', { class: 'pvf__opt pvf__opt--row' }, h('span', { text: tt('排序依据') }), valSel),
      h('p', { class: 'pvf__tip', text: tt('也可以直接点表格里的值列标题排序（降序 → 升序 → 恢复），点行字段名切换升降序。') }),
      h('label', { class: 'pvf__opt pvf__opt--row' }, h('span', { text: tt('空值显示为') }), emptyIn),
      h('p', { class: 'pvf__tip', text: tt('值字段的汇总方式、值显示方式、值显示格式（数字格式和小数位）和重命名：点「值」区域里的字段设置。') }));
    adv.addEventListener('toggle', () => { this._adv = adv.open; });

    this._msg = h('div', { class: 'pvf__msg', attrs: { role: 'status' } });
    const scroll = this.panel.querySelector('.pvf__list')?.scrollTop ?? 0;
    this.panel.replaceChildren(
      h('div', { class: 'pvf__head' }, h('strong', { text: tt('字段列表') }),
        h('button', { class: 'pvf__close', type: 'button', text: '×', title: tt('收起字段列表'), onclick: () => { this._open = false; this.refresh(); } })),
      h('div', { class: 'pvf__sub', text: tt('选择要添加到透视表的字段：') }),
      search, list,
      h('div', { class: 'pvf__sub', text: tt('在以下区域间拖动字段：') }),
      areas, this._msg, adv);
    list.scrollTop = scroll;
  }

  _flash(text) {
    if (!this._msg) return;
    this._msg.textContent = text;
    clearTimeout(this._msgT);
    this._msgT = setTimeout(() => { if (this._msg) this._msg.textContent = ''; }, 3000);
  }

  /** 区域里某个字段的菜单：上移 / 下移 / 挪到别的区域 / 汇总方式 / 值显示方式 / 移除。 */
  _chipMenu(area, index, col, at) {
    const cur = this._def();
    if (!cur) return;
    const n = normPivot(cur);
    const len = area === 'values' ? n.values.length : n[area].length;
    const move = (to) => {
      const next = moveField(this._def(), { area, index, col }, to);
      if (next) this._save(next); else if (to.area !== area) this._flash(tt('「{area}」区域已满或字段已在其中', { area: AREA_LABEL[to.area] }));
    };
    /** @type {any[]} */ const items = [];
    if (area === 'values') {
      const v = n.values[index];
      const setV = (patch) => {
        const c2 = this._def();
        if (!c2) return;
        const vals = normPivot(c2).values.map((x, i) => (i === index ? { ...x, ...patch } : x));
        this._save({ ...c2, values: vals });
      };
      items.push(
        { label: tt('值汇总方式'), submenu: PIVOT_AGGS.map(([k, l]) => ({ label: l, checked: v.agg === k, action: () => setV({ agg: k }) })) },
        { label: tt('值显示方式'), submenu: PIVOT_SHOW.map(([k, l]) => ({ label: l, checked: v.show === k, action: () => setV({ show: k }) })) },
        { label: tt('值显示格式'), submenu: [
          ...PIVOT_FMTS.map(([k, l]) => ({ label: l, checked: (v.fmt ?? 'auto') === k, action: () => setV({ fmt: k === 'auto' ? undefined : k }) })),
          { sep: true },
          { label: tt('小数位数'), submenu: [['', tt('自动')], ...[0, 1, 2, 3, 4].map((d) => [d, tt('{n} 位', { n: d })])].map(([d, l]) => ({
            label: /** @type {string} */ (l), checked: (v.dec ?? n.opts.dec ?? '') === d, action: () => setV({ dec: d === '' ? undefined : d }),
          })) },
        ] },
        { label: tt('重命名…'), action: () => this._rename(area, index, col) },
        { sep: true });
    } else {
      items.push({ label: tt('筛选取值…'), action: () => {
        const chip = this.panel.querySelector(`.pvf__chips[data-area="${area}"] .pvf__chip[data-index="${index}"]`);
        this._picker(cur, col, chip ?? this.panel);
      } }, { label: tt('重命名…'), action: () => this._rename(area, index, col) }, { sep: true });
    }
    items.push(
      { label: tt('上移'), disabled: index === 0, action: () => move({ area, index: index - 1 }) },
      { label: tt('下移'), disabled: index >= len - 1, action: () => move({ area, index: index + 2 }) },
      { sep: true },
      ...AREAS.filter(([k]) => k !== area).map(([k, l]) => ({ label: tt('移到「{area}」', { area: l }), action: () => move({ area: k }) })),
      { sep: true },
      { label: tt('删除字段'), danger: true, action: () => move({ area: 'remove' }) });
    openMenu(items, at);
  }

  /** 重命名区域里的字段：值字段存 name，行 / 列 / 筛选字段存 labels[列号]；清空 = 恢复默认名称。 */
  async _rename(area, index, col) {
    const cur = this._def();
    if (!cur) return;
    const n = normPivot(cur);
    const v = area === 'values' ? n.values[index] : null;
    const now = v ? valueLabel(v, this._name(cur, col)) : this._name(cur, col);
    const raw = await promptDialog(tt('重命名字段'), tt('名称（留空恢复默认）'), now);
    if (raw == null) return;
    const name = raw.replace(/\s+/g, ' ').trim().slice(0, 30);
    const c2 = this._def();
    if (!c2) return;
    if (v) {
      const vals = normPivot(c2).values.map((x, i) => {
        if (i !== index) return x;
        const y = { ...x };
        // 和默认名称一样就不存
        if (name && name !== valueLabel({ ...x, name: undefined }, this._name(c2, col))) y.name = name; else delete y.name;
        return y;
      });
      this._save({ ...c2, values: vals });
    } else {
      const labels = { ...(normPivot(c2).labels ?? {}) };
      if (name && name !== this._name(c2, col, true)) labels[col] = name; else delete labels[col];
      const next = { ...c2, labels };
      if (!Object.keys(labels).length) delete next.labels;
      this._save(next);
    }
  }

  // ── 拖放 ──────────────────────────────────────────────────────────────

  _dragStart(e, src, el) {
    this._drag = src;
    el.classList.add('is-dragging');
    this.panel.classList.add('is-dragging');
    e.dataTransfer?.setData('text/plain', 'pivot-field');
    if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move';
  }

  _dragEnd(el) {
    this._drag = null;
    el.classList.remove('is-dragging');
    this.panel.classList.remove('is-dragging');
    this._clearMarks();
  }

  _clearMarks() {
    for (const x of this.panel.querySelectorAll('.is-over, .pvf__drop-before, .pvf__drop-after')) x.classList.remove('is-over', 'pvf__drop-before', 'pvf__drop-after');
  }

  /** 放下的位置：落在哪个字段的上半 / 下半。 @returns {{index:number, mark:HTMLElement|null, after:boolean}} */
  _dropIndex(zone, e) {
    const chips = [...zone.querySelectorAll('.pvf__chip')].filter((c) => !c.classList.contains('is-dragging'));
    for (const c of chips) {
      const r = c.getBoundingClientRect();
      if (e.clientY < r.top + r.height / 2) return { index: Number(c.dataset.index), mark: c, after: false };
    }
    const last = chips[chips.length - 1];
    return { index: zone.querySelectorAll('.pvf__chip').length, mark: last ?? null, after: true };
  }

  /** @param {HTMLElement} zone @param {string} area */
  _dropZone(zone, area) {
    zone.addEventListener('dragover', (e) => {
      if (!this._drag) return;
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
      this._clearMarks();
      zone.classList.add('is-over');
      if (area !== 'list') {
        const { mark, after } = this._dropIndex(zone, e);
        mark?.classList.add(after ? 'pvf__drop-after' : 'pvf__drop-before');
      }
    });
    zone.addEventListener('dragleave', (e) => { if (!zone.contains(/** @type {any} */ (e.relatedTarget))) zone.classList.remove('is-over'); });
    zone.addEventListener('drop', (e) => {
      e.preventDefault();
      const src = this._drag;
      this._drag = null;
      this._clearMarks();
      const cur = this._def();
      if (!src || !cur) return;
      if (area === 'list') {
        // 拖回字段清单 = 从区域移除
        if (src.area !== 'list') this._save(moveField(cur, src, { area: 'remove' }));
        return;
      }
      const { index } = this._dropIndex(zone, e);
      const next = moveField(cur, src, { area, index });
      if (next) this._save(next);
      else if (src.area !== area) this._flash(tt('「{area}」区域最多 {n} 个字段', { area: AREA_LABEL[area], n: PIVOT_LIMITS[/** @type {'rows'} */ (area)] }));
    });
  }
}

/** 值字段在区域里的标题：「求和项:销量」，有显示方式时加个 %；有自定义名称就用它。 */
function valueTitle(v, name) {
  if (v.name) return v.name;
  const agg = PIVOT_AGGS.find(([k]) => k === v.agg)?.[1] ?? tt('求和');
  return tt('{agg}项:{name}', { agg, name }) + (v.show && v.show !== 'none' ? ' %' : '');
}

/** 字段从所有区域移除（取消勾选），顺带清掉它的筛选。 @param {any} def @param {number} col */
export function removeField(def, col) {
  const n = normPivot(def);
  const next = {
    ...def,
    filters: n.filters.filter((c) => c !== col),
    rows: n.rows.filter((c) => c !== col),
    cols: n.cols.filter((c) => c !== col),
    values: n.values.filter((v) => v.col !== col),
  };
  delete next.col;
  if (n.labels[col]) {
    const labels = { ...n.labels };
    delete labels[col];
    if (Object.keys(labels).length) next.labels = labels; else delete next.labels;
  }
  if (n.hide[col]) {
    const hide = { ...n.hide };
    delete hide[col];
    if (Object.keys(hide).length) next.hide = hide; else delete next.hide;
  }
  return next;
}
