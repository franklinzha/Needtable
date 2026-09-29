/**
 * 功能区（仿 Excel Ribbon）：开始 / 插入 / 公式 / 数据 / 视图 / 文件 六个页签。
 *
 * 每个按钮只是 cmd.run(id) 的入口，不含任何业务逻辑。refresh() 在每一帧绘制后被调用，
 * 所以只做 O(按钮数) 的属性比对，绝不重建 DOM。
 */

import { h, select } from '../ui/dom.js';
import { openMenu } from '../ui/menu.js';
import { BORDER_KINDS, NO_COPY } from './commands.js';
import { FONTS, FONT_SIZES, SWATCHES, CHART_TYPES, INSERT_CHARTS } from './dialogs.js';
import { CF_TYPES } from './calc.js';
import { getAI } from '../ai/index.js';
import { PRESETS } from '../../shared/formula/numfmt.js';
import { t as tt } from '../../shared/i18n/i18n.js';

const TABS = [['home', tt('开始')], ['insert', tt('插入')], ['formula', tt('公式')], ['data', tt('数据')], ['view', tt('视图')], ['file', tt('文件')]];
/** 只读 / 非网格视图下仍可用的按钮 */
const ALWAYS = new Set(['exportCsv', 'exportXlsx', 'find', 'copy', 'showFormulas', 'freeze', 'viewFiles', 'help', 'ai']);

export class Ribbon {
  /** @param {any} grid @param {HTMLElement} host */
  constructor(grid, host) {
    this.g = grid;
    this.host = host;
    /** @type {Map<string, any>} 需要显示按下状态的按钮 */ this.toggles = new Map();
    /** @type {any[]} 可写才可用的控件 */ this.editOnly = [];
    this.tab = 'home';
    this._last = '';

    this.tabBar = h('div', { class: 'rb__tabs', attrs: { role: 'tablist' } });
    this.panes = h('div', { class: 'rb__panes' });
    this.tabBtns = new Map();
    this.paneEls = new Map();
    for (const [id, label] of TABS) {
      const b = h('button', { class: 'rb__tab', type: 'button', text: label, attrs: { role: 'tab', 'aria-selected': id === this.tab ? 'true' : 'false' },
        onclick: () => this.show(id) });
      this.tabBtns.set(id, b);
      this.tabBar.append(b);
      const pane = h('div', { class: 'rb__pane', attrs: { role: 'tabpanel' } });
      pane.hidden = id !== this.tab;
      this.paneEls.set(id, pane);
      this.panes.append(pane);
    }
    this.quickUndo = this._btn('undo', '↶', tt('撤销 (Ctrl+Z)'), { cls: 'rb__quick' });
    this.quickRedo = this._btn('redo', '↷', tt('重做 (Ctrl+Y)'), { cls: 'rb__quick' });
    this.collapse = h('button', { class: 'rb__quick rb__collapse', type: 'button', text: '︿', title: tt('折叠功能区'),
      onclick: () => this._toggleCollapse() });
    this.tabBar.append(h('div', { class: 'rb__spacer' }), this.quickUndo, this.quickRedo, this.collapse);
    host.append(this.tabBar, this.panes);

    this._home(this.paneEls.get('home'));
    this._insert(this.paneEls.get('insert'));
    this._formula(this.paneEls.get('formula'));
    this._data(this.paneEls.get('data'));
    this._view(this.paneEls.get('view'));
    this._file(this.paneEls.get('file'));
    this.refresh();
  }

  show(id) {
    if (this.host.classList.contains('is-collapsed')) this.host.classList.remove('is-collapsed');
    this.tab = id;
    for (const [k, b] of this.tabBtns) b.setAttribute('aria-selected', k === id ? 'true' : 'false');
    for (const [k, p] of this.paneEls) p.hidden = k !== id;
  }

  _toggleCollapse() {
    const on = this.host.classList.toggle('is-collapsed');
    this.collapse.textContent = on ? '﹀' : '︿';
    this.collapse.title = on ? tt('展开功能区') : tt('折叠功能区');
    this.g._measure?.();
    this.g._paint?.();
  }

  // ── 控件工厂 ──────────────────────────────────────────────────────────

  /** 普通按钮。opts.big = 大图标按钮；opts.toggle = 记下来以便 refresh 同步按下状态。 */
  _btn(id, icon, title, opts = {}) {
    const cls = 'rb__btn' + (opts.big ? ' rb__btn--big' : '') + (opts.cls ? ' ' + opts.cls : '');
    const b = h('button', { class: cls, type: 'button', title, onclick: () => this.g.cmd.run(id, opts.arg) },
      h('span', { class: 'rb__icon' + (opts.iconCls ? ' ' + opts.iconCls : ''), text: icon }),
      opts.label ? h('span', { class: 'rb__label', text: opts.label }) : null);
    if (opts.toggle) { b.setAttribute('aria-pressed', 'false'); this._tog(opts.toggle, b); }
    if (!ALWAYS.has(id) && id !== 'undo' && id !== 'redo') this.editOnly.push(b);
    if (this.g.noCopy && NO_COPY.has(id)) b.hidden = true;
    return b;
  }

  /** 带下拉箭头的按钮：点击弹出菜单。items 可以是函数（每次打开时现算，反映当前状态）。 */
  _drop(icon, label, title, items, opts = {}) {
    const b = h('button', { class: 'rb__btn rb__drop' + (opts.big ? ' rb__btn--big' : ''), type: 'button', title },
      h('span', { class: 'rb__icon', text: icon }),
      label ? h('span', { class: 'rb__label', text: label }) : null,
      h('span', { class: 'rb__caret', text: '▾' }));
    b.addEventListener('click', () => this._menuAt(b, typeof items === 'function' ? items() : items));
    if (!opts.always) this.editOnly.push(b);
    return b;
  }

  /** 分体按钮：左边执行上次的动作，右边箭头打开菜单。 */
  _split(main, items, opts = {}) {
    const arrow = h('button', { class: 'rb__btn rb__arrow', type: 'button', title: opts.title ?? tt('更多选项'), text: '▾' });
    arrow.addEventListener('click', () => this._menuAt(main, typeof items === 'function' ? items() : items));
    if (!opts.always) this.editOnly.push(arrow);
    return h('span', { class: 'rb__splitbtn' + (opts.big ? ' rb__splitbtn--big' : '') }, main, arrow);
  }

  _menuAt(el, items) {
    const r = el.getBoundingClientRect();
    openMenu(items, { x: r.left, y: r.bottom + 2 }, { onClose: () => this.g.scroll.focus?.({ preventScroll: true }) });
  }

  _group(label, ...kids) {
    return h('div', { class: 'rb__group' }, h('div', { class: 'rb__items' }, ...kids), h('div', { class: 'rb__glabel', text: label }));
  }

  _col(...kids) { return h('div', { class: 'rb__col' }, ...kids); }
  _row(...kids) { return h('div', { class: 'rb__row' }, ...kids); }

  _mi(label, id, arg, extra = {}) { return { label, action: () => this.g.cmd.run(id, arg), ...extra }; }

  /** 字体颜色 / 填充色：主按钮用上次的颜色，箭头弹出色板。 @param {'fontColor'|'fillColor'} id */
  _colorBtn(id, icon, title) {
    const bar = h('span', { class: 'rb__bar' });
    const main = h('button', { class: 'rb__btn rb__color', type: 'button', title, onclick: () => this.g.cmd.run(id) },
      h('span', { class: 'rb__icon', text: icon }), bar);
    this.editOnly.push(main);
    const paint = () => { bar.style.background = this.g.cmd[id]; };
    paint();
    const arrow = h('button', { class: 'rb__btn rb__arrow', type: 'button', title: tt('{name}：选择颜色', { name: title }), text: '▾' });
    arrow.addEventListener('click', () => this._palette(main, id === 'fillColor' ? tt('无填充') : tt('自动（默认颜色）'), (c) => {
      this.g.cmd.run(id, c);
      paint();
    }));
    this.editOnly.push(arrow);
    return h('span', { class: 'rb__splitbtn' }, main, arrow);
  }

  /** 色板弹层：常用色 + 清除 + 自定义取色器。 */
  _palette(anchor, noneLabel, onPick) {
    this._closePop();
    const pop = h('div', { class: 'rb-pop', attrs: { role: 'dialog' } });
    const done = (c) => { this._closePop(); onPick(c); };
    pop.append(h('button', { class: 'rb-pop__none', type: 'button', text: noneLabel, onclick: () => done(null) }));
    const grid = h('div', { class: 'rb-pop__swatches' });
    for (const c of SWATCHES) {
      grid.append(h('button', { class: 'ui-swatch', type: 'button', title: c, style: { background: c }, onclick: () => done(c) }));
    }
    pop.append(grid);
    const custom = h('input', { type: 'color', class: 'ui-color', value: '#000000' });
    custom.addEventListener('change', () => done(custom.value));
    pop.append(h('label', { class: 'rb-pop__custom' }, h('span', { text: tt('其他颜色…') }), custom));
    document.body.append(pop);
    const r = anchor.getBoundingClientRect();
    pop.style.left = Math.max(4, Math.min(r.left, (window.innerWidth || 1280) - 236)) + 'px';
    pop.style.top = (r.bottom + 2) + 'px';
    const onDown = (e) => { if (!pop.contains(e.target)) this._closePop(); };
    const onKey = (e) => { if (e.key === 'Escape') this._closePop(); };
    setTimeout(() => document.addEventListener('pointerdown', onDown, true));
    document.addEventListener('keydown', onKey, true);
    this._pop = { el: pop, off: () => { document.removeEventListener('pointerdown', onDown, true); document.removeEventListener('keydown', onKey, true); } };
  }

  _closePop() {
    if (!this._pop) return;
    this._pop.off();
    this._pop.el.remove();
    this._pop = null;
  }

  // ── 开始 ──────────────────────────────────────────────────────────────

  _home(pane) {
    const run = (id, arg) => this.g.cmd.run(id, arg);
    const pasteMain = this._btn('paste', '📋', tt('粘贴 (Ctrl+V)'), { big: true, label: tt('粘贴') });
    const painter = this._btn('painter', '🖌', tt('格式刷：单击刷一次，双击连续使用'), { label: tt('格式刷'), toggle: 'painter' });
    painter.addEventListener('dblclick', () => run('painterSticky'));
    pane.append(this._group(tt('剪贴板'),
      this._split(pasteMain, () => [
        this._mi(tt('粘贴'), 'paste'), this._mi(tt('只粘贴值'), 'pasteValues'), this._mi(tt('只粘贴格式'), 'pasteFormats'),
        this._mi(tt('只粘贴公式'), 'pasteFormulas'), this._mi(tt('转置'), 'pasteTranspose'),
      ], { big: true }),
      this._col(this._btn('cut', '✂', tt('剪切 (Ctrl+X)'), { label: tt('剪切') }), this._btn('copy', '⧉', tt('复制 (Ctrl+C)'), { label: tt('复制') }), painter)));

    this.fontSel = select(FONTS, '', { class: 'rb__select rb__select--font', title: tt('字体'), onchange: (e) => run('fontFamily', e.target.value) });
    this.sizeSel = select(FONT_SIZES.map((n) => [String(n), String(n)]), '13', { class: 'rb__select rb__select--size', title: tt('字号'), onchange: (e) => run('fontSize', e.target.value) });
    this.editOnly.push(this.fontSel, this.sizeSel);
    pane.append(this._group(tt('字体'),
      this._col(
        this._row(this.fontSel, this.sizeSel,
          this._btn('growFont', 'A⁺', tt('增大字号')), this._btn('shrinkFont', 'A⁻', tt('减小字号'))),
        this._row(
          this._btn('bold', 'B', tt('加粗 (Ctrl+B)'), { toggle: 'b', iconCls: 'is-b' }),
          this._btn('italic', 'I', tt('倾斜 (Ctrl+I)'), { toggle: 'i', iconCls: 'is-i' }),
          this._btn('underline', 'U', tt('下划线 (Ctrl+U)'), { toggle: 'u', iconCls: 'is-u' }),
          this._btn('strike', 'S', tt('删除线 (Ctrl+5)'), { toggle: 's', iconCls: 'is-s' }),
          this._split(this._btn('border', '▦', tt('边框'), { arg: 'all' }), () => [
            ...BORDER_KINDS.map(([k, label]) => this._mi(label, 'border', k)),
            { sep: true },
            { label: tt('线条颜色'), submenu: [['#000000', tt('黑色')], ['#5f6368', tt('灰色')], ['#d93025', tt('红色')], ['#1a73e8', tt('蓝色')], ['#188038', tt('绿色')]]
              .map(([c, n]) => ({ label: n, checked: this.g.cmd.borderColor === c, action: () => run('borderColor', c) })) },
            { sep: true },
            this._mi(tt('更多边框…'), 'formatCells', 'border'),
          ], { title: tt('边框样式') }),
          this._colorBtn('fillColor', '🪣', tt('填充颜色')),
          this._colorBtn('fontColor', 'A', tt('字体颜色'))))));

    pane.append(this._group(tt('对齐方式'),
      this._col(
        this._row(
          this._btn('valignT', '⤒', tt('顶端对齐'), { toggle: 'va:t' }),
          this._btn('valignM', '⇕', tt('垂直居中'), { toggle: 'va:m' }),
          this._btn('valignB', '⤓', tt('底端对齐'), { toggle: 'va:b' }),
          this._btn('wrap', '↵', tt('自动换行'), { toggle: 'wr', label: tt('自动换行') })),
        this._row(
          this._btn('alignL', '⫷', tt('左对齐'), { toggle: 'ha:l', iconCls: 'is-al' }),
          this._btn('alignC', '☰', tt('居中'), { toggle: 'ha:c' }),
          this._btn('alignR', '⫸', tt('右对齐'), { toggle: 'ha:r', iconCls: 'is-ar' }),
          this._split(this._btn('mergeCenter', '⊞', tt('合并后居中'), { label: tt('合并后居中') }), () => [
            this._mi(tt('合并后居中'), 'mergeCenter'), this._mi(tt('跨越合并'), 'mergeAcross'),
            this._mi(tt('合并单元格'), 'merge'), this._mi(tt('取消单元格合并'), 'unmerge'),
          ])))));
    this._homeRest(pane, run);
  }

  _homeRest(pane, run) {
    this.nfSel = select([...PRESETS.map((p) => [p.fmt, p.label]), ['__more', tt('其他数字格式…')]], '', { class: 'rb__select rb__select--nf', title: tt('数字格式'),
      onchange: (e) => {
        const v = e.target.value;
        if (v === '__more') { this._last = ''; run('formatCells', 'number'); this.refresh(); return; }
        run('numFmt', v);
      } });
    this.editOnly.push(this.nfSel);
    pane.append(this._group(tt('数字'),
      this._col(
        this.nfSel,
        this._row(
          this._btn('currency', '¥', tt('会计数字格式')),
          this._btn('percent', '%', tt('百分比样式')),
          this._btn('thousands', ',', tt('千位分隔样式')),
          this._btn('incDecimals', '.0→', tt('增加小数位数')),
          this._btn('decDecimals', '←.0', tt('减少小数位数'))))));

    pane.append(this._group(tt('样式'),
      this._drop('▤', tt('条件格式'), tt('条件格式'), () => this._cfItems(), { big: true }),
      this._btn('formatCells', '⚙', tt('设置单元格格式 (Ctrl+1)'), { big: true, label: tt('单元格格式') })));

    pane.append(this._group(tt('单元格'),
      this._drop('⊕', tt('插入'), tt('插入单元格 / 行 / 列'), () => [
        this._mi(tt('插入单元格…'), 'insertDialog'), { sep: true },
        this._mi(tt('插入工作表行（上方）'), 'insertRowsAbove'), this._mi(tt('插入工作表行（下方）'), 'insertRowsBelow'),
        this._mi(tt('插入工作表列（左侧）'), 'insertColsLeft'), this._mi(tt('插入工作表列（右侧）'), 'insertColsRight'),
      ], { big: true }),
      this._drop('⊖', tt('删除'), tt('删除单元格 / 行 / 列'), () => [
        this._mi(tt('删除单元格…'), 'deleteDialog'), { sep: true },
        this._mi(tt('删除工作表行'), 'deleteRows'), this._mi(tt('删除工作表列'), 'deleteCols'),
      ], { big: true }),
      this._drop('▭', tt('格式'), tt('行高、列宽、隐藏'), () => [
        this._mi(tt('行高…'), 'rowHeight'), this._mi(tt('自动调整行高'), 'autofitRow'), { sep: true },
        this._mi(tt('列宽…'), 'colWidth'), this._mi(tt('自动调整列宽'), 'autofit'), { sep: true },
        { label: tt('隐藏和取消隐藏'), submenu: [
          this._mi(tt('隐藏行'), 'hideRows'), this._mi(tt('隐藏列'), 'hideCols'),
          this._mi(tt('取消隐藏行'), 'unhideRows'), this._mi(tt('取消隐藏列'), 'unhideCols'),
        ] },
        { sep: true }, this._mi(tt('设置单元格格式…'), 'formatCells'),
      ], { big: true })));

    pane.append(this._group(tt('编辑'),
      this._col(
        this._split(this._btn('sum', 'Σ', tt('自动求和 (Alt+=)'), { label: tt('自动求和') }), () => this._sumItems()),
        this._drop('⇩', tt('填充'), tt('填充'), () => [
          this._mi(tt('向下'), 'fillDown', undefined, { shortcut: 'Ctrl+D' }), this._mi(tt('向右'), 'fillRight', undefined, { shortcut: 'Ctrl+R' }),
          this._mi(tt('填充到数据末尾'), 'fillToEnd'),
        ]),
        this._drop('⌫', tt('清除'), tt('清除'), () => [
          this._mi(tt('全部清除'), 'clearAll'), this._mi(tt('清除格式'), 'clearFormat'), this._mi(tt('清除内容'), 'clearContent'),
          this._mi(tt('清除批注'), 'clearNotes'), this._mi(tt('清除数据验证'), 'clearValidation'),
        ])),
      this._drop('⇅', tt('排序和筛选'), tt('排序和筛选'), () => this._sortItems(), { big: true }),
      this._drop('🔍', tt('查找和选择'), tt('查找和选择'), () => [
        this._mi(tt('查找…'), 'find', undefined, { shortcut: 'Ctrl+F' }), this._mi(tt('替换…'), 'replace', undefined, { shortcut: 'Ctrl+H' }),
        this._mi(tt('选择当前区域'), 'selectRegion'),
      ], { big: true, always: true })));
  }

  _sumItems() {
    return [['SUM', tt('求和')], ['AVERAGE', tt('平均值')], ['COUNT', tt('计数')], ['MAX', tt('最大值')], ['MIN', tt('最小值')]]
      .map(([fn, label]) => this._mi(label, 'autoSum', fn))
      .concat([{ sep: true }, this._mi(tt('其他函数…'), 'insertFunction')]);
  }

  _sortItems() {
    const on = !!this.g.model.props.filter;
    return [
      this._mi(tt('升序'), 'sortAsc', undefined, { icon: '↑' }), this._mi(tt('降序'), 'sortDesc', undefined, { icon: '↓' }),
      this._mi(tt('自定义排序…'), 'sortDialog'), { sep: true },
      this._mi(tt('筛选'), 'toggleFilter', undefined, { checked: on, shortcut: 'Ctrl+Shift+L' }),
      this._mi(tt('清除筛选条件'), 'clearFilter', undefined, { disabled: !on }),
    ];
  }

  _cfItems() {
    const pick = (types) => CF_TYPES.filter(([t]) => types.includes(t)).map(([t, label]) => this._mi(label + '…', 'cf', t));
    return [
      { label: tt('突出显示单元格规则'), submenu: pick(['gt', 'lt', 'between', 'eq', 'ne', 'ge', 'le', 'contains', 'notContains', 'blank', 'notBlank', 'dup', 'uniq']) },
      { label: tt('最前 / 最后规则'), submenu: pick(['top', 'bottom', 'aboveAvg', 'belowAvg']) },
      { label: tt('数据条'), submenu: [['#638ec6', tt('蓝色数据条')], ['#63be7b', tt('绿色数据条')], ['#f8696b', tt('红色数据条')], ['#ffb628', tt('橙色数据条')], ['#008aef', tt('浅蓝色数据条')], ['#d6007b', tt('紫色数据条')]]
        .map(([c, n]) => this._mi(n, 'cfBar', c)) },
      { label: tt('色阶'), submenu: [
        this._mi(tt('红 - 黄 - 绿'), 'cfScale', ['#f8696b', '#ffeb84', '#63be7b']),
        this._mi(tt('绿 - 黄 - 红'), 'cfScale', ['#63be7b', '#ffeb84', '#f8696b']),
        this._mi(tt('红 - 白 - 绿'), 'cfScale', ['#f8696b', '#ffffff', '#63be7b']),
        this._mi(tt('白 - 蓝'), 'cfScale', ['#ffffff', '#5a8ac6']),
        this._mi(tt('白 - 红'), 'cfScale', ['#ffffff', '#f8696b']),
      ] },
      { sep: true },
      this._mi(tt('使用公式确定格式…'), 'cf', 'formula'),
      this._mi(tt('新建规则…'), 'cf', 'gt'),
      { label: tt('清除规则'), submenu: [this._mi(tt('清除所选单元格的规则'), 'cfClear', 'sel'), this._mi(tt('清除整个工作表的规则'), 'cfClear', 'all')] },
      this._mi(tt('管理规则…'), 'cfManage'),
    ];
  }

  // ── 插入 / 公式 ────────────────────────────────────────────────────────

  _insert(pane) {
    const icons = { column: '📊', bar: '📶', line: '📈', area: '⛰', pie: '◔', doughnut: '◎', scatter: '⁘' };
    pane.append(this._group(tt('图表'),
      ...CHART_TYPES.slice(0, 5).map(([t, label]) => this._btn('insertChart', icons[t], tt('插入{name}', { name: label }), { big: true, label, arg: t })),
      this._drop('⋯', tt('更多'), tt('更多图表'), () => INSERT_CHARTS.map(([t, label]) => this._mi(label, 'insertChart', t)), { big: true })));
    pane.append(this._group(tt('表格'),
      this._btn('insertPivot', '⊞', tt('插入透视表：按所选数据分组汇总，单独放在「仪表盘」后面的标签里，不占表格位置（最多 5 个）'), { big: true, label: tt('透视表') })));
    pane.append(this._group(tt('批注'),
      this._btn('insertNote', '🗨', tt('插入 / 编辑批注 (Shift+F2)'), { big: true, label: tt('批注') }),
      this._btn('deleteNote', '🗑', tt('删除批注'), { big: true, label: tt('删除批注') })));
    pane.append(this._group(tt('附件'),
      this._btn('insertFile', '📎', tt('上传文件 / 图片到当前单元格（也可直接拖放或粘贴截图）'), { big: true, label: tt('附件') }),
      this._btn('viewFiles', '🗂', tt('查看当前单元格的附件'), { big: true, label: tt('查看附件') })));
    pane.append(this._group(tt('控件'),
      this._btn('insertCheckbox', '☑', tt('把所选单元格变成复选框'), { big: true, label: tt('复选框') }),
      this._btn('insertDropdown', '▾', tt('下拉列表（数据验证）：手动输入选项，或引用本表 / 其他表格里的区域'), { big: true, label: tt('下拉列表') }),
      this._btn('insertCascade', '⋮▾', tt('多级下拉：选中几列就是几级（如 省 / 市 / 区），下一级只显示属于上一级的选项'), { big: true, label: tt('多级下拉') })));
    pane.append(this._group(tt('数据'),
      this._col(
        this._btn('insertDate', '📅', tt('插入今天的日期 (Ctrl+;)'), { label: tt('日期') }),
        this._btn('insertTime', '🕒', tt('插入当前时间'), { label: tt('时间') }),
        this._btn('insertFunction', 'fx', tt('插入函数 (Shift+F3)'), { label: tt('函数') }))));
  }

  _formula(pane) {
    const cats = [
      [tt('数学'), '∑', ['SUM', 'SUMIF', 'SUMIFS', 'SUMPRODUCT', 'PRODUCT', 'ROUND', 'ROUNDUP', 'ROUNDDOWN', 'INT', 'MOD', 'ABS', 'POWER', 'SQRT', 'CEILING', 'FLOOR', 'RAND', 'RANDBETWEEN', 'SUBTOTAL']],
      [tt('统计'), '📐', ['AVERAGE', 'AVERAGEIF', 'AVERAGEIFS', 'COUNT', 'COUNTA', 'COUNTBLANK', 'COUNTIF', 'COUNTIFS', 'MAX', 'MIN', 'MAXIFS', 'MINIFS', 'MEDIAN', 'MODE', 'LARGE', 'SMALL', 'RANK', 'STDEV', 'VAR', 'PERCENTILE']],
      [tt('逻辑'), '⋀', ['IF', 'IFS', 'IFERROR', 'IFNA', 'AND', 'OR', 'NOT', 'XOR', 'SWITCH', 'TRUE', 'FALSE']],
      [tt('文本'), 'A', ['CONCAT', 'TEXTJOIN', 'LEFT', 'RIGHT', 'MID', 'LEN', 'FIND', 'SEARCH', 'SUBSTITUTE', 'REPLACE', 'TRIM', 'UPPER', 'LOWER', 'PROPER', 'TEXT', 'VALUE', 'REPT', 'TEXTBEFORE', 'TEXTAFTER', 'EXACT']],
      [tt('日期和时间'), '📅', ['TODAY', 'NOW', 'DATE', 'YEAR', 'MONTH', 'DAY', 'HOUR', 'MINUTE', 'SECOND', 'WEEKDAY', 'WEEKNUM', 'EDATE', 'EOMONTH', 'DATEDIF', 'DAYS', 'NETWORKDAYS', 'WORKDAY', 'YEARFRAC']],
      [tt('查找与引用'), '🔎', ['VLOOKUP', 'HLOOKUP', 'XLOOKUP', 'LOOKUP', 'INDEX', 'MATCH', 'XMATCH', 'CHOOSE', 'ROW', 'COLUMN', 'ROWS', 'COLUMNS', 'TRANSPOSE']],
      [tt('财务'), '¥', ['PMT', 'PV', 'FV', 'NPV', 'IRR']],
    ];
    pane.append(this._group(tt('函数库'),
      this._btn('insertFunction', 'fx', tt('插入函数 (Shift+F3)'), { big: true, label: tt('插入函数') }),
      this._split(this._btn('sum', 'Σ', tt('自动求和 (Alt+=)'), { big: true, label: tt('自动求和') }), () => this._sumItems(), { big: true }),
      ...cats.map(([label, icon, names]) => this._drop(icon, label, tt('{name}函数', { name: label }),
        () => names.map((n) => this._mi(n, 'insertFunction', n)), { big: true }))));
    pane.append(this._group(tt('公式审核'),
      this._btn('showFormulas', '⨍', tt('显示公式（而不是计算结果）'), { big: true, label: tt('显示公式'), toggle: 'showFormulas' }),
      this._btn('toValues', '123', tt('把所选公式转换为数值'), { big: true, label: tt('转为数值') })));
    pane.append(this._group(tt('计算'),
      this._btn('recalc', '⟳', tt('重新计算全部公式'), { big: true, label: tt('开始计算') })));
    pane.append(this._group(tt('帮助'),
      this._btn('help', '?', tt('在新标签页打开全部函数说明、跨表引用与快捷键'), { big: true, label: tt('函数帮助') })));
    // AI 只预留接口：服务端没启用时一直是灰的「即将推出」
    const ai = this._btn('ai', '✦', tt('AI 功能即将推出（接口已预留）'), { big: true, label: tt('AI（即将推出）') });
    ai.disabled = true;
    getAI().then((p) => {
      if (!p.enabled) return;
      ai.disabled = false;
      ai.title = tt('AI 助手');
      ai.querySelector('.rb__label').textContent = tt('AI 助手');
    });
    pane.append(this._group('AI', ai));
  }

  // ── 数据 / 视图 / 文件 ──────────────────────────────────────────────────

  _data(pane) {
    pane.append(this._group(tt('获取数据'),
      this._btn('importFile', '📥', tt('导入 CSV / Excel 文件'), { big: true, label: tt('导入文件') })));
    pane.append(this._group(tt('排序和筛选'),
      this._col(this._btn('sortAsc', 'A↓Z', tt('升序'), { label: tt('升序') }), this._btn('sortDesc', 'Z↓A', tt('降序'), { label: tt('降序') })),
      this._btn('sortDialog', '⇅', tt('自定义排序'), { big: true, label: tt('排序') }),
      this._btn('toggleFilter', '⏷', tt('筛选 (Ctrl+Shift+L)'), { big: true, label: tt('筛选'), toggle: 'filter' }),
      this._btn('clearFilter', '✕', tt('清除筛选条件'), { big: true, label: tt('清除') })));
    pane.append(this._group(tt('数据工具'),
      this._btn('splitText', '⫼', tt('分列：按分隔符或固定宽度拆分'), { big: true, label: tt('分列') }),
      this._btn('dedupe', '⧉', tt('删除重复项'), { big: true, label: tt('删除重复项') }),
      this._split(this._btn('validation', '✔', tt('数据验证'), { big: true, label: tt('数据验证') }), () => [
        this._mi(tt('数据验证…'), 'validation'), this._mi(tt('下拉列表…'), 'insertDropdown'), this._mi(tt('多级下拉…'), 'insertCascade'), this._mi(tt('清除验证'), 'clearValidation'),
      ], { big: true }),
      this._drop('Aa', tt('文本'), tt('文本转换'), () => [
        this._mi(tt('转大写'), 'upper'), this._mi(tt('转小写'), 'lower'), this._mi(tt('首字母大写'), 'proper'), this._mi(tt('去除多余空格'), 'trim'),
      ], { big: true })));
  }

  _file(pane) {
    pane.append(this._group(tt('导入'),
      this._btn('importFile', '📥', tt('导入 CSV / Excel (.xlsx)'), { big: true, label: tt('导入') })));
    pane.append(this._group(tt('导出'),
      this._btn('exportXlsx', '📗', tt('导出为 Excel 工作簿 (.xlsx)'), { big: true, label: 'Excel' }),
      this._btn('exportCsv', '📄', tt('导出为 CSV'), { big: true, label: 'CSV' })));
    this.g.btnClear = this._btn('clearSheet', '🗑', tt('清空整张表'), { big: true, label: tt('清空工作表') });
    pane.append(this._group(tt('工作表'), this.g.btnClear));
  }

  _view(pane) {
    const freeze = this._btn('freeze', '❄', tt('冻结窗格：冻结当前单元格上方的行和左侧的列（再点一次取消）'), { big: true, label: tt('冻结窗格'), toggle: 'freeze' });
    this.g.btnFreeze = freeze;
    pane.append(this._group(tt('窗口'),
      this._split(freeze, () => [
        this._mi(tt('冻结至当前单元格'), 'freezeHere'), this._mi(tt('冻结首行'), 'freezeRow'),
        this._mi(tt('冻结首列'), 'freezeCol'), this._mi(tt('取消冻结'), 'unfreeze'),
      ], { big: true, always: true })));
    pane.append(this._group(tt('显示'),
      this._btn('gridlines', '#', tt('显示网格线'), { big: true, label: tt('网格线'), toggle: 'gridlines' }),
      this._btn('showFormulas', '⨍', tt('显示公式'), { big: true, label: tt('显示公式'), toggle: 'showFormulas' })));
    const viewBtn = (v, icon, label) => {
      const b = h('button', { class: 'rb__btn rb__btn--big', type: 'button', title: tt('切换到{name}', { name: label }), onclick: () => this.g.setView(v) },
        h('span', { class: 'rb__icon', text: icon }), h('span', { class: 'rb__label', text: label }));
      b.setAttribute('aria-pressed', 'false');
      this._tog('view:' + v, b);
      return b;
    };
    pane.append(this._group(tt('视图'), viewBtn('grid', '▦', tt('表格')), viewBtn('kanban', '▥', tt('看板')), viewBtn('dashboard', '◫', tt('仪表盘'))));
    this.g.btnDemo = this._btn('demo', '⚡', tt('生成 10 万行示例数据（仅本地表格）'), { big: true, label: tt('示例数据'), arg: 100000 });
    this.editOnly = this.editOnly.filter((x) => x !== this.g.btnDemo);
    pane.append(this._group(tt('演示'), this.g.btnDemo));
  }

  _tog(key, b) {
    if (!this.toggles.has(key)) this.toggles.set(key, []);
    this.toggles.get(key).push(b);
  }

  // ── 状态同步 ──────────────────────────────────────────────────────────

  /** 每帧调用：只在状态真的变了时才碰 DOM。 */
  refresh() {
    const g = this.g;
    if (!g.model || !g.sel) return;
    const { r, c } = g.sel.active;
    const f = g.model.getFormat(r, c) ?? {};
    const props = g.model.props;
    const fr = props.freeze;
    const state = {
      b: !!f.b, i: !!f.i, u: !!f.u, s: !!f.s, wr: !!f.wr,
      'ha:l': f.ha === 'l', 'ha:c': f.ha === 'c', 'ha:r': f.ha === 'r',
      'va:t': f.va === 't', 'va:m': f.va === 'm', 'va:b': !f.va || f.va === 'b',
      freeze: !!(fr && (fr.r || fr.c)),
      gridlines: props.gridlines !== false,
      showFormulas: !!g.calc?.showFormulas,
      painter: !!g.painter,
      filter: !!props.filter,
      'view:grid': (g.view ?? 'grid') === 'grid', 'view:kanban': g.view === 'kanban', 'view:dashboard': g.view === 'dashboard',
    };
    const ro = !!g.readonly || (g.view ?? 'grid') !== 'grid';
    const sig = JSON.stringify(state) + '|' + ro + '|' + (f.ff ?? '') + '|' + (f.fs ?? 13) + '|' + (f.nf ?? '') + '|' + g.canUndo + g.canRedo;
    if (sig === this._last) return;
    this._last = sig;

    for (const [k, list] of this.toggles) {
      const v = state[k] ? 'true' : 'false';
      for (const b of list) if (b.getAttribute('aria-pressed') !== v) b.setAttribute('aria-pressed', v);
    }
    for (const el of this.editOnly) el.disabled = ro;
    this.quickUndo.disabled = !g.canUndo;
    this.quickRedo.disabled = !g.canRedo;
    const active = document.activeElement;
    if (active !== this.fontSel) this.fontSel.value = f.ff ?? '';
    if (active !== this.sizeSel) this.sizeSel.value = String(f.fs ?? 13);
    if (active !== this.nfSel) this.nfSel.value = PRESETS.some((p) => p.fmt === (f.nf ?? '')) ? (f.nf ?? '') : '';
  }
}
