/**
 * 网格用到的全部对话框：设置单元格格式、条件格式、数据验证、查找替换、分列、排序、
 * 删除重复项、插入图表 / 透视表 / 函数、批注、行高列宽、插入删除、按值筛选、导入。
 *
 * 对话框只负责收集参数，真正的改动都算成 op 交给 grid.exec —— 所以全部可撤销、会同步。
 */

import { openDialog, alertDialog, confirmDialog } from '../ui/dialog.js';
import { h, select, field, colorInput } from '../ui/dom.js';
import { styleOps, borderOps, splitTextOps, dedupeOps, findAll, replaceOps, clipRect } from './actions.js';
import { CF_TYPES } from './calc.js';
import { srcError, toPaths, listFromRows, cascadeOptions } from './dropdown.js';
import { api } from '../core/api.js';
import { PRESETS, formatValue } from '../../shared/formula/numfmt.js';
import { FUNCTION_NAMES, FUNCTION_HELP } from '../../shared/formula/functions.js';
import { DOCS, CATEGORIES } from '../../shared/formula/docs.js';
import { fnDetail } from './fndoc.js';
import {
  chartData, drawChart, readChartTheme, colorAt, CHART_TYPES, CHART_PRESETS, CAN_STACK, CAN_SMOOTH, HAS_AXES,
  LEGEND_POS, NUM_FORMATS, PALETTES,
} from './chartdraw.js';
import { rangeName, parseRange, parseRef, colName } from '../../shared/util/a1.js';
import { t as tt } from '../../shared/i18n/i18n.js';

export const FONTS = [
  ['', tt('默认字体')], ['Microsoft YaHei', tt('微软雅黑')], ['SimSun', tt('宋体')], ['SimHei', tt('黑体')], ['KaiTi', tt('楷体')],
  ['FangSong', tt('仿宋')], ['Arial', 'Arial'], ['Calibri', 'Calibri'], ['Times New Roman', 'Times New Roman'],
  ['Courier New', 'Courier New'], ['Georgia', 'Georgia'], ['Verdana', 'Verdana'],
];
export const FONT_SIZES = [8, 9, 10, 11, 12, 13, 14, 16, 18, 20, 22, 24, 26, 28, 36, 48, 72];

/** 条件格式的预设样式（与 Excel 的下拉一致）。 */
const CF_STYLES = [
  ['red', tt('浅红填充色深红色文本'), { bg: '#ffc7ce', fc: '#9c0006' }],
  ['yellow', tt('黄填充色深黄色文本'), { bg: '#ffeb9c', fc: '#9c5700' }],
  ['green', tt('绿填充色深绿色文本'), { bg: '#c6efce', fc: '#006100' }],
  ['lred', tt('浅红色填充'), { bg: '#ffc7ce' }],
  ['rtext', tt('红色文本'), { fc: '#ff0000' }],
  ['bold', tt('加粗'), { b: true }],
  ['custom', tt('自定义格式…'), null],
];

const sel = (g) => g.calc.expandRect(g.sel.rect);
const rectName = (s) => rangeName(s.r0, s.c0, s.r1, s.c1);
const checkbox = (label, checked, props = {}) => {
  const input = h('input', { type: 'checkbox', checked: !!checked, ...props });
  return { input, el: h('label', { class: 'ui-check' }, input, h('span', { text: label })) };
};
const radio = (name, value, label, checked) => {
  const input = h('input', { type: 'radio', name, value, checked: !!checked });
  return { input, el: h('label', { class: 'ui-check' }, input, h('span', { text: label })) };
};
const num = (value, min, max, props = {}) => h('input', { class: 'ui-input', type: 'number', value: String(value ?? ''), min, max, ...props });

/** 解析 "A1:C9" / "B3"，失败返回 null。 */
export function parseArea(text) {
  const t = String(text ?? '').trim().toUpperCase().replace(/\$/g, '').replace(/^=/, '');
  const g = parseRange(t);
  if (g) return { r0: Math.min(g.r0, g.r1), c0: Math.min(g.c0, g.c1), r1: Math.max(g.r0, g.r1), c1: Math.max(g.c0, g.c1) };
  const p = parseRef(t);
  return p ? { r0: p.r, c0: p.c, r1: p.r, c1: p.c } : null;
}

/** 选项卡容器。 @param {[string, string, Node][]} tabs [id, 标题, 面板] */
function tabbed(tabs, active) {
  const bar = h('div', { class: 'ui-tabs', attrs: { role: 'tablist' } });
  const panes = h('div', { class: 'ui-tabpanes' });
  const show = (id) => {
    for (const b of bar.children) b.setAttribute('aria-selected', String(b.dataset.id === id));
    for (const p of panes.children) p.hidden = p.dataset.id !== id;
  };
  for (const [id, label, pane] of tabs) {
    bar.append(h('button', { type: 'button', class: 'ui-tab', dataset: { id }, attrs: { role: 'tab' }, text: label, onclick: () => show(id) }));
    pane.dataset.id = id;
    panes.append(pane);
  }
  show(tabs.some((t) => t[0] === active) ? active : tabs[0][0]);
  return h('div', { class: 'ui-tabbed' }, bar, panes);
}

// ── 设置单元格格式（Ctrl+1）──────────────────────────────────────────────

export function formatCells(g, tab = 'number') {
  const s = sel(g), { r, c } = g.sel.active;
  const f = g.model.getFormat(r, c) ?? {};
  const patch = {};
  const set = (k, v) => { patch[k] = v; };
  const sample = g.calc.value(r, c);

  // 数字
  const nfInput = h('input', { class: 'ui-input', value: f.nf ?? '', placeholder: tt('常规') });
  const preview = h('div', { class: 'ui-preview' });
  const showPreview = () => {
    let t;
    try { t = formatValue(sample ?? 1234.5678, nfInput.value).text ?? ''; } catch { t = tt('（格式无效）'); }
    preview.textContent = tt('示例：{text}', { text: typeof t === 'string' ? t : String(t) });
  };
  const list = h('div', { class: 'ui-list' });
  for (const p of PRESETS) {
    list.append(h('button', {
      type: 'button', class: 'ui-list__item' + ((f.nf ?? '') === p.fmt ? ' is-active' : ''), text: p.label,
      onclick: (e) => {
        for (const b of list.children) b.classList.toggle('is-active', b === e.currentTarget);
        nfInput.value = p.fmt; set('nf', p.fmt || null); showPreview();
      },
    }));
  }
  nfInput.addEventListener('input', () => { set('nf', nfInput.value || null); showPreview(); });
  showPreview();
  const numberPane = h('div', { class: 'ui-split' }, list, h('div', { class: 'ui-stack' },
    field(tt('格式代码'), nfInput, tt('如 0.00、#,##0、0%、yyyy-mm-dd、"¥"#,##0.00')), preview));

  // 对齐
  const ha = select([['', tt('常规')], ['l', tt('靠左')], ['c', tt('居中')], ['r', tt('靠右')]], f.ha ?? '', { onchange: (e) => set('ha', e.target.value || null) });
  const va = select([['b', tt('靠下')], ['m', tt('居中')], ['t', tt('靠上')]], f.va ?? 'b', { onchange: (e) => set('va', e.target.value === 'b' ? null : e.target.value) });
  const wr = checkbox(tt('自动换行'), f.wr, { onchange: (e) => set('wr', e.target.checked || null) });
  const mergedNow = !!g.calc.mergeAt(s.r0, s.c0);
  const mg = checkbox(tt('合并单元格'), mergedNow);
  const alignPane = h('div', { class: 'ui-stack' }, field(tt('水平对齐'), ha), field(tt('垂直对齐'), va), wr.el, mg.el);

  // 字体
  const ff = select(FONTS, f.ff ?? '', { onchange: (e) => set('ff', e.target.value || null) });
  const fs = select(FONT_SIZES.map((n) => [String(n), String(n)]), String(f.fs ?? 13), { onchange: (e) => set('fs', Number(e.target.value)) });
  if (!FONT_SIZES.includes(f.fs ?? 13)) fs.append(h('option', { value: String(f.fs ?? 13), text: String(f.fs ?? 13), selected: true }));
  const bold = checkbox(tt('加粗'), f.b, { onchange: (e) => set('b', e.target.checked || null) });
  const ital = checkbox(tt('倾斜'), f.i, { onchange: (e) => set('i', e.target.checked || null) });
  const und = checkbox(tt('下划线'), f.u, { onchange: (e) => set('u', e.target.checked || null) });
  const strk = checkbox(tt('删除线'), f.s, { onchange: (e) => set('s', e.target.checked || null) });
  const fc = colorInput(f.fc ?? '#202124', { oninput: (e) => set('fc', e.target.value) });
  const fcAuto = h('button', { type: 'button', class: 'ui-btn ui-btn--sm', text: tt('自动'), onclick: () => set('fc', null) });
  const fontPane = h('div', { class: 'ui-stack' }, field(tt('字体'), ff), field(tt('字号'), fs),
    h('div', { class: 'ui-row' }, bold.el, ital.el, und.el, strk.el), field(tt('颜色'), h('div', { class: 'ui-row' }, fc, fcAuto)));

  // 边框
  let borderKind = null;
  const bc = colorInput(g.cmd.borderColor);
  const kinds = [['outer', tt('外边框')], ['inner', tt('内部')], ['all', tt('全部')], ['thick', tt('粗外框')], ['top', tt('上')], ['bottom', tt('下')], ['left', tt('左')], ['right', tt('右')], ['none', tt('无')]];
  const bRow = h('div', { class: 'ui-row ui-row--wrap' });
  for (const [k, label] of kinds) {
    bRow.append(h('button', { type: 'button', class: 'ui-btn ui-btn--sm', text: label, onclick: (e) => {
      borderKind = k;
      for (const b of bRow.children) b.classList.toggle('is-active', b === e.currentTarget);
    } }));
  }
  const borderPane = h('div', { class: 'ui-stack' }, field(tt('线条颜色'), bc), field(tt('预置'), bRow), h('p', { class: 'ui-hint', text: tt('选择一种样式后点「确定」应用到选区。') }));

  // 填充
  const bg = colorInput(f.bg ?? '#ffffff', { oninput: (e) => set('bg', e.target.value) });
  const swatches = h('div', { class: 'ui-swatches' });
  for (const col of SWATCHES) swatches.append(h('button', { type: 'button', class: 'ui-swatch', title: col, style: { background: col }, onclick: () => { bg.value = col; set('bg', col); } }));
  const noFill = h('button', { type: 'button', class: 'ui-btn ui-btn--sm', text: tt('无颜色'), onclick: () => set('bg', null) });
  const fillPane = h('div', { class: 'ui-stack' }, field(tt('背景色'), h('div', { class: 'ui-row' }, bg, noFill)), swatches);

  openDialog({
    title: tt('设置单元格格式'),
    width: 560,
    body: tabbed([['number', tt('数字'), numberPane], ['align', tt('对齐'), alignPane], ['font', tt('字体'), fontPane], ['border', tt('边框'), borderPane], ['fill', tt('填充'), fillPane]], tab),
    buttons: [
      { label: tt('取消') },
      { label: tt('确定'), primary: true, action: async () => {
        if (!g._canEdit()) return;
        try {
          if (Object.keys(patch).length) g.exec(styleOps(g.model, s, patch));
          if (borderKind) g.exec(borderOps(g.model, s, borderKind, bc.value));
          if (mg.input.checked !== mergedNow) await g.cmd.merge(mg.input.checked ? 'merge' : 'unmerge');
        } catch (err) { g.opts.onStatus?.(err.message, 'error'); }
        g._paint();
      } },
    ],
  });
}

export const SWATCHES = [
  '#ffffff', '#f2f2f2', '#d9d9d9', '#bfbfbf', '#808080', '#404040', '#000000',
  '#ffc7ce', '#ffeb9c', '#c6efce', '#ddebf7', '#fce4d6', '#e2efda', '#fff2cc',
  '#ff0000', '#ffc000', '#ffff00', '#92d050', '#00b050', '#00b0f0', '#0070c0',
  '#002060', '#7030a0', '#c00000', '#d93025', '#1a73e8', '#188038', '#f9ab00',
];

// ── 条件格式 ──────────────────────────────────────────────────────────────

const NEEDS_V1 = new Set(['gt', 'lt', 'ge', 'le', 'eq', 'ne', 'between', 'contains', 'notContains', 'top', 'bottom', 'formula']);

export function cfRule(g, type, onAdd, existing = null) {
  const s = sel(g);
  const rangeIn = h('input', { class: 'ui-input', value: existing ? rangeName(...existing.range) : rectName(s) });
  const typeSel = select(CF_TYPES, existing?.type ?? type);
  const v1 = h('input', { class: 'ui-input', value: existing?.v1 ?? (type === 'top' || type === 'bottom' ? '10' : '') });
  const v2 = h('input', { class: 'ui-input', value: existing?.v2 ?? '' });
  const v2Row = field(tt('与'), v2);
  const v1Row = field(tt('值'), v1);
  const styleSel = select(CF_STYLES.map(([id, label]) => [id, label]), 'red');
  const bgIn = colorInput(existing?.style?.bg ?? '#ffc7ce');
  const fcIn = colorInput(existing?.style?.fc ?? '#9c0006');
  const bIn = checkbox(tt('加粗'), existing?.style?.b);
  const custom = h('div', { class: 'ui-row' }, h('span', { text: tt('填充') }), bgIn, h('span', { text: tt('文字') }), fcIn, bIn.el);
  const styleRow = h('div', { class: 'ui-stack' }, field(tt('设置为'), styleSel), custom);
  const barColor = colorInput(existing?.color ?? '#638ec6');
  const barRow = field(tt('数据条颜色'), barColor);
  const scaleSel = select([['3', tt('红-黄-绿 三色刻度')], ['3r', tt('绿-黄-红 三色刻度')], ['2', tt('白-绿 双色刻度')], ['2b', tt('白-蓝 双色刻度')]], '3');
  const scaleRow = field(tt('色阶'), scaleSel);
  const hint = h('p', { class: 'ui-hint' });
  if (existing?.style) styleSel.value = 'custom';

  const sync = () => {
    const t = typeSel.value;
    v1Row.hidden = !NEEDS_V1.has(t);
    v2Row.hidden = t !== 'between';
    barRow.hidden = t !== 'bar';
    scaleRow.hidden = t !== 'scale';
    styleRow.hidden = t === 'bar' || t === 'scale';
    custom.hidden = styleSel.value !== 'custom';
    v1Row.firstChild.textContent = t === 'formula' ? tt('公式') : t === 'top' || t === 'bottom' ? tt('项数') : t.includes('ontains') ? tt('文本') : tt('值');
    hint.textContent = t === 'formula' ? tt('以选区左上角为基准书写，例如 =$C2>100 或 =MOD(ROW(),2)=0；公式会随每个单元格相对偏移。') : '';
  };
  typeSel.addEventListener('change', sync);
  styleSel.addEventListener('change', sync);
  sync();

  openDialog({
    title: existing ? tt('编辑格式规则') : tt('新建格式规则'),
    width: 480,
    body: [field(tt('应用于'), rangeIn), field(tt('规则类型'), typeSel), v1Row, v2Row, barRow, scaleRow, styleRow, hint],
    buttons: [
      { label: tt('取消') },
      { label: tt('确定'), primary: true, action: () => {
        const area = parseArea(rangeIn.value);
        if (!area) { hint.textContent = tt('无法识别的区域：{range}', { range: rangeIn.value }); return false; }
        const t = typeSel.value;
        if (NEEDS_V1.has(t) && !v1.value.trim()) { hint.textContent = tt('请填写条件值'); return false; }
        if (t === 'formula' && !v1.value.trim().startsWith('=')) v1.value = '=' + v1.value.trim();
        const rule = { range: [area.r0, area.c0, area.r1, area.c1], type: t };
        if (NEEDS_V1.has(t)) rule.v1 = v1.value.trim();
        if (t === 'between') rule.v2 = v2.value.trim();
        if (t === 'bar') rule.color = barColor.value;
        else if (t === 'scale') rule.colors = { 3: ['#f8696b', '#ffeb84', '#63be7b'], '3r': ['#63be7b', '#ffeb84', '#f8696b'], 2: ['#ffffff', '#63be7b'], '2b': ['#ffffff', '#5a8ac6'] }[scaleSel.value];
        else {
          const preset = CF_STYLES.find((x) => x[0] === styleSel.value);
          rule.style = preset?.[2] ?? { bg: bgIn.value, fc: fcIn.value, ...(bIn.input.checked ? { b: true } : {}) };
        }
        onAdd(rule);
      } },
    ],
  });
}

export function cfManager(g) {
  const list = h('div', { class: 'ui-rules' });
  const label = (t) => (CF_TYPES.find((x) => x[0] === t) ?? [t, t])[1];
  const save = (rules) => { if (g._canEdit()) g.exec([{ t: 'setProp', key: 'cf', value: rules.length ? rules : null }]); render(); };
  const render = () => {
    const rules = (g.model.props.cf ?? []).slice();
    list.replaceChildren();
    if (!rules.length) { list.append(h('p', { class: 'ui-hint', text: tt('当前工作表没有条件格式规则。') })); return; }
    rules.forEach((rule, i) => {
      const sw = h('span', { class: 'ui-rule__swatch', text: 'AaBb' });
      if (rule.style?.bg) sw.style.background = rule.style.bg;
      if (rule.style?.fc) sw.style.color = rule.style.fc;
      if (rule.type === 'bar') sw.style.background = 'linear-gradient(90deg,' + rule.color + ' 60%, transparent 60%)';
      if (rule.type === 'scale') sw.style.background = 'linear-gradient(90deg,' + rule.colors.join(',') + ')';
      const desc = label(rule.type) + (rule.v1 != null ? ' ' + rule.v1 : '') + (rule.v2 != null ? ' ~ ' + rule.v2 : '');
      list.append(h('div', { class: 'ui-rule' },
        sw,
        h('span', { class: 'ui-rule__desc', text: desc }),
        h('span', { class: 'ui-rule__range', text: rangeName(...rule.range) }),
        h('button', { type: 'button', class: 'ui-btn ui-btn--sm', text: '↑', title: tt('提高优先级'), disabled: i === 0, onclick: () => { [rules[i - 1], rules[i]] = [rules[i], rules[i - 1]]; save(rules); } }),
        h('button', { type: 'button', class: 'ui-btn ui-btn--sm', text: '↓', title: tt('降低优先级'), disabled: i === rules.length - 1, onclick: () => { [rules[i + 1], rules[i]] = [rules[i], rules[i + 1]]; save(rules); } }),
        h('button', { type: 'button', class: 'ui-btn ui-btn--sm', text: tt('编辑'), onclick: () => cfRule(g, rule.type, (nr) => { rules[i] = { ...nr, id: rule.id }; save(rules); }, rule) }),
        h('button', { type: 'button', class: 'ui-btn ui-btn--sm ui-btn--danger', text: tt('删除'), onclick: () => { rules.splice(i, 1); save(rules); } }),
      ));
    });
  };
  render();
  openDialog({
    title: tt('条件格式规则管理器'),
    width: 640,
    body: [list],
    buttons: [
      { label: tt('新建规则…'), action: () => { cfRule(g, 'gt', (rule) => g.cmd.addCf(rule)); } },
      { label: tt('关闭'), primary: true },
    ],
  });
}

// ── 数据验证 ──────────────────────────────────────────────────────────────

export function validation(g, rect, onSave, preset) {
  const cur = g.calc.validationAt(rect.r0, rect.c0);
  const canRef = !!g.ext;   // 离线网格 / 公开链接没有跨表引用
  const typeSel = select([['list', tt('序列（下拉列表）')], ['cascade', tt('多级下拉（联动）')], ['int', tt('整数')], ['decimal', tt('小数')], ['textLen', tt('文本长度')], ['date', tt('日期')], ['checkbox', tt('复选框')]], preset ?? cur?.type ?? 'list');
  // 旧写法「=H1:H10」当作引用本表区域
  const legacy = typeof cur?.list === 'string' && /^=/.test(cur.list) ? { range: cur.list.slice(1) } : null;
  const src0 = cur?.src ?? legacy;
  const modeSel = select([['manual', tt('手动输入选项')], ['ref', tt('引用表格里的区域（选项跟着区域实时变）')]], src0 ? 'ref' : 'manual');
  const listIn = h('textarea', { class: 'ui-input ui-input--area', value: Array.isArray(cur?.list) ? cur.list.join('\n') : legacy ? '' : cur?.list ?? '', placeholder: tt('每行一个选项，或用逗号分隔') });
  const tableSel = select([['', tt('本表')]], src0?.table ?? '');
  const rangeIn = h('input', { class: 'ui-input', value: (src0?.range ?? '').replace(/\$/g, ''), placeholder: tt('如 A2:A100 或 A:A') });
  const header = checkbox(tt('区域第一行是标题（不当选项）'), src0?.header);
  const preview = h('p', { class: 'ui-hint' });
  const minIn = h('input', { class: 'ui-input', value: cur?.min ?? '' });
  const maxIn = h('input', { class: 'ui-input', value: cur?.max ?? '' });
  const warn = checkbox(tt('仅提示警告（仍允许输入其他值）'), cur?.warn);
  const modeRow = field(tt('选项来源'), modeSel);
  const listRow = field(tt('选项'), listIn);
  const refRow = h('div', { class: 'ui-col' },
    h('div', { class: 'ui-row' }, field(tt('数据所在的表'), tableSel), field(tt('区域'), rangeIn)),
    header.el,
    h('div', { class: 'ui-row' }, h('button', { type: 'button', class: 'ui-btn ui-btn--sm', text: tt('预览选项'), onclick: () => void showPreview() }), preview));
  const rangeRow = h('div', { class: 'ui-row' }, field(tt('最小值'), minIn), field(tt('最大值'), maxIn));
  const levels = rect.c1 - rect.c0 + 1;
  const guide = h('details', { class: 'ui-guide' },
    h('summary', { text: tt('如何设置多级下拉？') }),
    h('p', { class: 'ui-hint', text: tt('① 先准备数据源（可以放在本表的空白列，也可以单独建一张表）：每一行写一条完整的路径，第 1 列是一级，第 2 列是二级，第 3 列是三级……') }),
    h('pre', { class: 'ui-code', text: tt('省份 | 城市 | 区县\n浙江 | 杭州 | 西湖区\n     | 杭州 | 滨江区   ← 上级留空 = 同上一行\n     | 宁波 | 海曙区\n江苏 | 南京 | 玄武区') }),
    h('p', { class: 'ui-hint', text: tt('② 选中要填写的几列（例如 B2:D100，三列 = 三级），打开本对话框，允许选「多级下拉」，区域填数据源的范围（如 A:C，有标题就勾上「第一行是标题」）。') }),
    h('p', { class: 'ui-hint', text: tt('③ 填写时先选第一列，第二列只会出现属于它的选项；改了上一级，对不上的下级会自动清空。最多 6 级，数据源最多读 5000 行。') }),
    h('p', { class: 'ui-hint', text: tt('数据源在别的表时，需要你能查看那张表；设置好之后，能编辑本表的人都能用这个下拉。') }));
  const hint = h('p', { class: 'ui-hint' });
  const sync = () => {
    const t = typeSel.value;
    const dd = t === 'list' || t === 'cascade';
    modeRow.hidden = t !== 'list';
    listRow.hidden = t !== 'list' || modeSel.value !== 'manual';
    refRow.hidden = !(t === 'cascade' || (t === 'list' && modeSel.value === 'ref'));
    guide.hidden = t !== 'cascade';
    rangeRow.hidden = dd || t === 'checkbox' || t === 'date';
    rangeIn.placeholder = t === 'cascade' ? tt('如 A2:C500（几列 = 几级）') : tt('如 A2:A100 或 A:A');
    hint.textContent = t === 'cascade' ? (levels < 2 ? tt('当前选区横跨 {n} 列 = {n} 级（至少要选两列）', { n: levels }) : tt('当前选区横跨 {n} 列 = {n} 级', { n: levels })) : '';
  };
  typeSel.addEventListener('change', sync);
  modeSel.addEventListener('change', sync);
  sync();

  // 表格列表：从主页的树里取，只列出别的表
  if (canRef) {
    void api.get('/api/home').then((home) => {
      const opts = [['', tt('本表')]];
      for (const ws of [...(home.workspaces ?? []), ...(home.monitor ?? [])]) {
        for (const base of ws.bases ?? []) {
          for (const t of base.tables ?? []) if (t.id !== g.ext?.tableId) opts.push([t.id, ws.name + ' / ' + base.name + ' / ' + t.name]);
        }
      }
      const keep = tableSel.value;
      if (keep && !opts.some(([id]) => id === keep)) opts.push([keep, tt('{id}（无权查看或已删除）', { id: keep })]);
      tableSel.replaceChildren(...opts.map(([v, l]) => h('option', { value: v, text: l })));
      tableSel.value = keep;
    }).catch(() => {});
  } else tableSel.disabled = true;

  const readSrc = () => ({ ...(tableSel.value ? { table: tableSel.value } : {}), range: rangeIn.value.trim().replace(/^=/, '').replace(/\$/g, '').toUpperCase(), ...(header.input.checked ? { header: true } : {}) });
  /** 别的表：先登记引用（服务端校验权限），之后编辑本表的人都能读 */
  const register = (/** @type {any} */ src) => (src.table && g.ext ? g.ext.register(['=' + src.table + '!' + src.range]) : Promise.resolve());
  const showPreview = async () => {
    const t = typeSel.value === 'cascade' ? 'cascade' : 'list';
    const src = readSrc();
    const bad = srcError(src, t);
    if (bad) { preview.textContent = bad; return; }
    preview.textContent = tt('读取中…');
    await register(src);
    let res = g.calc.sourceRows(src);
    for (let i = 0; res.loading && i < 25; i++) { await new Promise((ok) => setTimeout(ok, 200)); res = g.calc.sourceRows(src); }
    if (res.loading) { preview.textContent = tt('还没取到数据，请稍后再点一次'); return; }
    if (res.error) { preview.textContent = res.error; return; }
    if (t === 'list') {
      const o = listFromRows(res.rows, !!src.header);
      preview.textContent = o.length ? tt('共 {n} 个选项：{items}', { n: o.length, items: o.slice(0, 12).join(tt('、')) + (o.length > 12 ? '…' : '') }) : tt('区域里没有内容');
      return;
    }
    const paths = toPaths(res.rows, !!src.header, true);
    const top = cascadeOptions(paths, []);
    const first = top[0];
    const sub = first ? cascadeOptions(paths, [first]) : [];
    preview.textContent = paths.length
      ? tt('{paths} 条路径，{levels} 级。一级：{top}', { paths: paths.length, levels: res.rows[0]?.length ?? 0, top: top.slice(0, 8).join(tt('、')) + (top.length > 8 ? '…' : '') })
        + (first ? tt('；「{first}」下的二级：{sub}', { first, sub: sub.slice(0, 8).join(tt('、')) }) : '')
      : tt('区域里没有内容');
  };

  openDialog({
    title: tt('数据验证 — {range}', { range: rectName(rect) }),
    width: 540,
    body: [field(tt('允许'), typeSel), modeRow, listRow, refRow, guide, rangeRow, warn.el, hint],
    buttons: [
      { label: tt('全部清除'), danger: true, action: () => { g.cmd.clearValidation(); } },
      { label: tt('取消') },
      { label: tt('确定'), primary: true, action: () => {
        const t = typeSel.value;
        const rule = { range: [rect.r0, rect.c0, rect.r1, rect.c1], type: t };
        if (!refRow.hidden) {
          const src = readSrc();
          const bad = srcError(src, t === 'cascade' ? 'cascade' : 'list');
          if (bad) { hint.textContent = bad; return false; }
          if (t === 'cascade' && levels < 2) { hint.textContent = tt('多级下拉要选中至少两列（每列一级），再打开本对话框'); return false; }
          rule.src = src;
          void register(src);
        } else if (t === 'list') {
          const text = listIn.value.trim();
          // 手动模式也兼容「=H1:H10」：当作引用本表区域
          if (/^=/.test(text)) {
            const src = { range: text.slice(1).replace(/\$/g, '').toUpperCase() };
            const bad = srcError(src, 'list');
            if (bad) { hint.textContent = bad; return false; }
            rule.src = src;
          } else {
            const items = [...new Set(text.split(/[,，\n]/).map((x) => x.trim()).filter(Boolean))];
            if (!items.length) { hint.textContent = tt('请至少填写一个选项'); return false; }
            rule.list = items.slice(0, 500);
          }
        }
        if (!rangeRow.hidden) {
          if (minIn.value.trim() !== '') rule.min = Number(minIn.value);
          if (maxIn.value.trim() !== '') rule.max = Number(maxIn.value);
          if (Number.isNaN(rule.min) || Number.isNaN(rule.max)) { hint.textContent = tt('最小值 / 最大值必须是数字'); return false; }
        }
        if (warn.input.checked) rule.warn = true;
        onSave(rule);
      } },
    ],
  });
}

// ── 查找与替换 ────────────────────────────────────────────────────────────

export function findReplace(g, tab = 'find') {
  const q = h('input', { class: 'ui-input', placeholder: tt('查找内容') });
  const rep = h('input', { class: 'ui-input', placeholder: tt('替换为') });
  const repRow = field(tt('替换为'), rep);
  const mc = checkbox(tt('区分大小写'), false), wh = checkbox(tt('单元格匹配'), false), inF = checkbox(tt('查找公式'), false), rx = checkbox(tt('正则表达式'), false);
  const scope = select([['sheet', tt('工作表')], ['sel', tt('选区')]], 'sheet');
  const results = h('div', { class: 'ui-results' });
  const msg = h('p', { class: 'ui-hint' });
  const selAtOpen = sel(g);
  const single = selAtOpen.r0 === selAtOpen.r1 && selAtOpen.c0 === selAtOpen.c1;
  let idx = -1;
  const opts = () => ({ q: q.value, matchCase: mc.input.checked, whole: wh.input.checked, inFormulas: inF.input.checked, regex: rx.input.checked });
  const hits = () => findAll(g.model, (r, c) => g.calc.text(r, c), opts(), scope.value === 'sel' && !single ? selAtOpen : null);
  const go = (hit) => { g.sel.set(hit.r, hit.c); g._reveal(); g._paint(); };
  const next = () => {
    const list = hits();
    if (!list.length) { msg.textContent = tt('找不到“{q}”', { q: q.value }); return; }
    const { r, c } = g.sel.active;
    idx = list.findIndex((x) => x.r > r || (x.r === r && x.c > c));
    if (idx < 0) idx = 0;
    go(list[idx]);
    msg.textContent = tt('第 {i} / {n} 个', { i: idx + 1, n: list.length });
  };
  const all = () => {
    const list = hits();
    results.replaceChildren();
    msg.textContent = list.length ? tt('找到 {n} 个单元格', { n: list.length }) : tt('找不到“{q}”', { q: q.value });
    for (const hit of list.slice(0, 300)) {
      results.append(h('button', { type: 'button', class: 'ui-results__item', onclick: () => go(hit) },
        h('span', { class: 'ui-results__ref', text: colName(hit.c) + (hit.r + 1) }), h('span', { text: g.calc.text(hit.r, hit.c) })));
    }
  };
  const replaceOne = () => {
    if (!g._canEdit()) return;
    const { r, c } = g.sel.active;
    const list = hits();
    if (list.some((x) => x.r === r && x.c === c)) g.exec(replaceOps(g.model, [{ r, c }], opts(), rep.value));
    next();
  };
  const replaceAll = () => {
    if (!g._canEdit()) return;
    const list = hits();
    const ops = replaceOps(g.model, list, opts(), rep.value);
    if (ops.length) g.exec(ops);
    msg.textContent = tt('已完成 {n} 处替换', { n: ops[0]?.cells.length ?? 0 });
    results.replaceChildren();
  };
  const replacing = tab === 'replace';
  repRow.hidden = !replacing;
  const buttons = [{ label: tt('查找全部'), action: () => { all(); return false; } }, { label: tt('查找下一个'), primary: true, action: () => { next(); return false; } }];
  if (replacing) buttons.push({ label: tt('替换'), action: () => { replaceOne(); return false; } }, { label: tt('全部替换'), action: () => { replaceAll(); return false; } });
  buttons.push({ label: tt('关闭') });
  openDialog({
    title: replacing ? tt('替换') : tt('查找'),
    width: 520,
    body: [field(tt('查找内容'), q), repRow, h('div', { class: 'ui-row ui-row--wrap' }, field(tt('范围'), scope), mc.el, wh.el, inF.el, rx.el), msg, results],
    buttons,
  });
}

// ── 分列 ──────────────────────────────────────────────────────────────────

export function splitText(g, rect) {
  const src = { ...rect, c1: rect.c0 };
  const mode = select([['comma', tt('逗号 ,')], ['tab', tt('Tab 键')], ['semicolon', tt('分号 ;')], ['space', tt('空格')], ['other', tt('其他字符')], ['fixed', tt('固定宽度')]], guessDelim(g, src));
  const other = h('input', { class: 'ui-input', placeholder: tt('如 | 或 -'), maxLength: 5 });
  const widths = h('input', { class: 'ui-input', placeholder: tt('每段字符数，如 4,2,2') });
  const rep = checkbox(tt('连续分隔符视为单个处理'), false);
  const otherRow = field(tt('分隔符'), other), widthRow = field(tt('字段宽度'), widths);
  const preview = h('table', { class: 'ui-table' });
  const hint = h('p', { class: 'ui-hint', text: tt('将 {col} 列（{n} 行）的文本拆分到右侧各列。', { col: colName(rect.c0), n: rect.r1 - rect.r0 + 1 }) });
  const opts = () => {
    const m = mode.value;
    if (m === 'fixed') return { widths: widths.value.split(/[,，\s]+/).map(Number).filter((n) => n > 0) };
    return { delim: m === 'other' ? other.value || ',' : m, mergeRepeat: rep.input.checked };
  };
  const render = () => {
    otherRow.hidden = mode.value !== 'other';
    widthRow.hidden = mode.value !== 'fixed';
    preview.replaceChildren();
    const pv = { ...src, r1: Math.min(src.r1, src.r0 + 5) };
    let res;
    try { res = splitTextOps(g.model, pv, opts()); } catch { return; }
    const grid = new Map();
    for (const op of res.ops) for (const [r, c, v] of op.cells ?? []) grid.set(r + ':' + c, v);
    for (let r = pv.r0; r <= pv.r1; r++) {
      const tr = h('tr');
      for (let c = src.c0; c < src.c0 + Math.max(1, res.cols); c++) tr.append(h('td', { text: grid.get(r + ':' + c) ?? (c === src.c0 ? g.model.getCell(r, c) : '') }));
      preview.append(tr);
    }
  };
  for (const el of [mode, other, widths, rep.input]) el.addEventListener('input', render);
  mode.addEventListener('change', render);
  render();
  openDialog({
    title: tt('文本分列'),
    width: 560,
    body: [hint, field(tt('分隔方式'), mode), otherRow, widthRow, rep.el, h('div', { class: 'ui-scroll' }, preview)],
    buttons: [
      { label: tt('取消') },
      { label: tt('完成'), primary: true, action: async () => {
        let res;
        try { res = splitTextOps(g.model, src, opts()); } catch (err) { hint.textContent = err.message; return false; }
        if (!res.ops.length) { hint.textContent = tt('没有可拆分的内容'); return false; }
        if (res.overwrite > 0 && !(await confirmDialog(tt('文本分列'), tt('此处已有数据（{n} 个单元格）。是否替换它？', { n: res.overwrite })))) return false;
        if (g._canEdit()) g.exec(res.ops);
      } },
    ],
  });
}

function guessDelim(g, s) {
  const v = g.model.getCell(s.r0, s.c0) + g.model.getCell(s.r0 + 1, s.c0);
  if (v.includes('\t')) return 'tab';
  if (/[,，]/.test(v)) return 'comma';
  if (/[;；]/.test(v)) return 'semicolon';
  if (v.includes(' ')) return 'space';
  return 'comma';
}

// ── 排序 ──────────────────────────────────────────────────────────────────

export function sort(g, region, header, onSort) {
  const hdr = checkbox(tt('数据包含标题'), header);
  const levels = h('div', { class: 'ui-stack' });
  const colOpts = () => {
    const out = [];
    for (let c = region.c0; c <= region.c1; c++) out.push([String(c), hdr.input.checked ? (g.calc.text(region.r0, c) || tt('列 {col}', { col: colName(c) })) : tt('列 {col}', { col: colName(c) })]);
    return out;
  };
  const addLevel = (c = region.c0, desc = false) => {
    if (levels.children.length >= 5) return;
    const cs = select(colOpts(), String(c));
    const ds = select([['0', tt('升序（A→Z，小→大）')], ['1', tt('降序（Z→A，大→小）')]], desc ? '1' : '0');
    const rm = h('button', { type: 'button', class: 'ui-btn ui-btn--sm', text: tt('删除'), onclick: () => { if (levels.children.length > 1) row.remove(); } });
    const row = h('div', { class: 'ui-row' }, h('span', { class: 'ui-row__label', text: levels.children.length ? tt('次要关键字') : tt('主要关键字') }), cs, ds, rm);
    levels.append(row);
  };
  hdr.input.addEventListener('change', () => {
    for (const row of levels.children) { const cs = row.children[1]; const v = cs.value; cs.replaceChildren(...colOpts().map(([val, label]) => h('option', { value: val, text: label }))); cs.value = v; }
  });
  addLevel(g.sel.active.c >= region.c0 && g.sel.active.c <= region.c1 ? g.sel.active.c : region.c0);
  openDialog({
    title: tt('排序 — {range}', { range: rectName(region) }),
    width: 520,
    body: [hdr.el, levels, h('button', { type: 'button', class: 'ui-btn ui-btn--sm', text: tt('+ 添加条件'), onclick: () => addLevel() })],
    buttons: [
      { label: tt('取消') },
      { label: tt('确定'), primary: true, action: () => {
        const keys = [...levels.children].map((row) => ({ c: Number(row.children[1].value), desc: row.children[2].value === '1' }));
        onSort(keys, hdr.input.checked);
      } },
    ],
  });
}

// ── 删除重复值 ────────────────────────────────────────────────────────────

export function dedupe(g, region, header) {
  const hdr = checkbox(tt('数据包含标题'), header);
  const box = h('div', { class: 'ui-checklist' });
  const items = [];
  const render = () => {
    box.replaceChildren();
    items.length = 0;
    for (let c = region.c0; c <= region.c1; c++) {
      const cb = checkbox(hdr.input.checked ? (g.calc.text(region.r0, c) || tt('列 {col}', { col: colName(c) })) : tt('列 {col}', { col: colName(c) }), true);
      items.push([c, cb.input]);
      box.append(cb.el);
    }
  };
  hdr.input.addEventListener('change', render);
  render();
  const all = h('button', { type: 'button', class: 'ui-btn ui-btn--sm', text: tt('全选'), onclick: () => items.forEach(([, i]) => { i.checked = true; }) });
  const none = h('button', { type: 'button', class: 'ui-btn ui-btn--sm', text: tt('取消全选'), onclick: () => items.forEach(([, i]) => { i.checked = false; }) });
  openDialog({
    title: tt('删除重复值 — {range}', { range: rectName(region) }),
    width: 440,
    body: [h('p', { class: 'ui-hint', text: tt('若要删除重复值，请选择一个或多个包含重复值的列。') }), h('div', { class: 'ui-row' }, all, none, hdr.el), box],
    buttons: [
      { label: tt('取消') },
      { label: tt('确定'), primary: true, action: () => {
        const cols = items.filter(([, i]) => i.checked).map(([c]) => c);
        if (!cols.length) return false;
        const { ops, removed } = dedupeOps(g.model, g.calc, region, cols, hdr.input.checked);
        if (ops.length && g._canEdit()) g.exec(ops);
        const total = region.r1 - region.r0 + 1 - (hdr.input.checked ? 1 : 0);
        setTimeout(() => alertDialog(tt('删除重复值'), removed ? tt('发现了 {removed} 个重复值，已将其删除；保留了 {kept} 个唯一值。', { removed, kept: total - removed }) : tt('未发现重复值。')), 0);
      } },
    ],
  });
}

// ── 插入图表 ──────────────────────────────────────────────────────────────

export { CHART_TYPES, INSERT_CHARTS } from './chartdraw.js';

const NO_AXES_HINT = tt('饼图、圆环图、漏斗图没有坐标轴，这一页只有「数字格式」对它们有效。');

/**
 * 插入 / 编辑图表：左边实时预览，右边「数据 / 样式 / 坐标轴」三个选项卡。
 * type 可以是基本类型，也可以是 CHART_PRESETS 里的快捷项（如堆积柱形图）。
 */
export function chart(g, type, existing = null) {
  let s = sel(g);
  if (!existing && s.r0 === s.r1 && s.c0 === s.c1) s = g.cmd.region();
  s = clipRect(g.model, s);
  /** @type {any} 正在编辑的图表（不含位置）；控件一变就读回这里、重画预览 */
  const cur = existing ? { ...existing } : {
    ...(CHART_PRESETS[type] ?? { type: type || 'column' }),
    header: g.cmd.looksLikeHeader(s) || typeof g.calc.value(s.r0, s.c1) === 'string',
  };
  cur.colors = Array.isArray(cur.colors) ? cur.colors.slice() : [];

  // ── 数据
  const typeSel = select(CHART_TYPES, cur.type);
  const rangeIn = h('input', { class: 'ui-input', value: existing ? rangeName(...existing.range) : rectName(s) });
  const byCols = radio('chd-series', 'cols', tt('列'), cur.seriesIn !== 'rows');
  const byRows = radio('chd-series', 'rows', tt('行'), cur.seriesIn === 'rows');
  const swap = h('button', { type: 'button', class: 'ui-btn ui-btn--sm', text: tt('⇄ 切换行 / 列'), title: tt('把横轴上的分类和图例里的系列对调'),
    onclick: () => { (byRows.input.checked ? byCols : byRows).input.checked = true; draw(); } });
  const hdr = checkbox(tt('首行为系列名称'), cur.header !== false);
  const hint = h('p', { class: 'ui-hint' });
  const dataPane = h('div', { class: 'chd__pane' },
    field(tt('图表类型'), typeSel), field(tt('数据区域'), rangeIn),
    h('div', { class: 'ui-field' }, h('span', { class: 'ui-field__label', text: tt('系列产生在') }), h('div', { class: 'ui-row' }, byCols.el, byRows.el, swap)),
    hdr.el, hint);

  // ── 样式
  const titleIn = h('input', { class: 'ui-input', value: cur.title ?? '', placeholder: tt('图表标题（可选）') });
  const subIn = h('input', { class: 'ui-input', value: cur.subtitle ?? '', placeholder: tt('副标题（可选）') });
  const legendSel = select(LEGEND_POS, cur.legend ?? 'bottom');
  const labelsCb = checkbox(tt('显示数值标签'), cur.labels);
  const smoothCb = checkbox(tt('平滑曲线'), cur.smooth);
  const stackCb = checkbox(tt('堆积'), cur.stacked);
  const palBox = h('div', { class: 'chd__palettes' });
  const colorBox = h('div', { class: 'chd__colors' });
  let colorKey = '';
  const renderPalettes = () => {
    palBox.replaceChildren(...PALETTES.map(([id, label, cols]) => h('button', {
      type: 'button', class: 'chd__pal', title: label, attrs: { 'aria-pressed': String((cur.palette ?? 'office') === id) },
      onclick: () => { cur.palette = id; cur.colors = []; renderPalettes(); colorKey = ''; draw(); },
    }, ...cols.slice(0, 5).map((c) => h('i', { style: { background: c } })), h('b', { text: label }))));
  };
  renderPalettes();
  /** 每个系列（饼图是每个扇区）一个取色器；系列没变就不重建，免得拖动取色器时被打断。 */
  const renderColors = (names) => {
    const key = (cur.palette ?? '') + '|' + names.join('|');
    if (key === colorKey) return;
    colorKey = key;
    colorBox.replaceChildren(...names.map((name, i) => {
      const inp = colorInput(colorAt(cur, i), { title: name, oninput: () => { cur.colors[i] = inp.value; } });
      return h('label', { class: 'chd__swatch' }, inp, h('span', { text: name }));
    }), names.length ? h('button', { type: 'button', class: 'ui-btn ui-btn--sm', text: tt('恢复配色'),
      onclick: () => { cur.colors = []; colorKey = ''; draw(); } }) : '');
  };
  const stylePane = h('div', { class: 'chd__pane' },
    field(tt('标题'), titleIn), field(tt('副标题'), subIn), field(tt('图例'), legendSel),
    h('div', { class: 'ui-row' }, labelsCb.el, smoothCb.el, stackCb.el),
    h('div', { class: 'ui-field' }, h('span', { class: 'ui-field__label', text: tt('配色方案') }), palBox),
    h('div', { class: 'ui-field' }, h('span', { class: 'ui-field__label', text: tt('单独设置颜色') }), colorBox));

  // ── 坐标轴
  const xTitleIn = h('input', { class: 'ui-input', value: cur.xTitle ?? '', placeholder: tt('横轴标题（可选）') });
  const yTitleIn = h('input', { class: 'ui-input', value: cur.yTitle ?? '', placeholder: tt('纵轴标题（可选）') });
  const yMinIn = num(cur.yMin ?? '', undefined, undefined, { placeholder: tt('自动'), step: 'any' });
  const yMaxIn = num(cur.yMax ?? '', undefined, undefined, { placeholder: tt('自动'), step: 'any' });
  const gridCb = checkbox(tt('显示网格线'), cur.gridlines !== false);
  const fmtSel = select(NUM_FORMATS, cur.numfmt ?? '');
  const axisHint = h('p', { class: 'ui-hint', text: NO_AXES_HINT });
  const axisFields = [xTitleIn, yTitleIn, yMinIn, yMaxIn, gridCb.input];
  const axisPane = h('div', { class: 'chd__pane' },
    axisHint,
    field(tt('横轴标题'), xTitleIn), field(tt('纵轴标题'), yTitleIn),
    h('div', { class: 'chd__row' }, field(tt('数值轴最小值'), yMinIn), field(tt('数值轴最大值'), yMaxIn)),
    gridCb.el, field(tt('数字格式'), fmtSel, tt('影响坐标轴刻度、数值标签和悬停提示')));

  const canvas = h('canvas', { class: 'chd__canvas' });
  const optNum = (el) => { const v = el.value.trim(); return v === '' || !Number.isFinite(Number(v)) ? null : Number(v); };

  /** 控件 → cur，顺带返回解析出的区域（无效时 null）。 */
  const read = () => {
    Object.assign(cur, {
      type: typeSel.value, seriesIn: byRows.input.checked ? 'rows' : 'cols', header: hdr.input.checked,
      title: titleIn.value.trim(), subtitle: subIn.value.trim(), legend: legendSel.value,
      labels: labelsCb.input.checked, smooth: smoothCb.input.checked, stacked: stackCb.input.checked,
      xTitle: xTitleIn.value.trim(), yTitle: yTitleIn.value.trim(), yMin: optNum(yMinIn), yMax: optNum(yMaxIn),
      gridlines: gridCb.input.checked, numfmt: fmtSel.value,
    });
    return parseArea(rangeIn.value);
  };
  const tooBig = (a) => (a.r1 - a.r0 + 1) * (a.c1 - a.c0 + 1) > 20000;

  function draw() {
    const area = read();
    const ok = !!area && !tooBig(area);
    const rows = cur.seriesIn === 'rows';
    hdr.el.lastChild.textContent = rows ? tt('首列为系列名称') : tt('首行为系列名称');
    hint.textContent = !area ? tt('无法识别的区域：{range}', { range: rangeIn.value })
      : !ok ? tt('数据区域过大（最多 2 万个单元格）')
      : rows ? tt('首行作为分类（横轴），其余每一行各成一个系列。') : tt('首列作为分类（横轴），其余每一列各成一个系列。');
    smoothCb.input.disabled = !CAN_SMOOTH.has(cur.type);
    stackCb.input.disabled = !CAN_STACK.has(cur.type);
    const axes = HAS_AXES.has(cur.type);
    axisHint.hidden = axes;
    for (const el of axisFields) el.disabled = !axes;

    const dpr = window.devicePixelRatio || 1;
    const w = canvas.clientWidth || 440, hh = canvas.clientHeight || 280;
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(hh * dpr);
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const c = { ...cur, range: ok ? [area.r0, area.c0, area.r1, area.c1] : [0, 0, -1, -1] };
    const data = ok ? chartData(g, c) : { labels: [], series: [], xs: null };
    try { drawChart(ctx, w, hh, c, data, readChartTheme(canvas)); } catch (err) { console.warn('chart preview', err); }
    const perPoint = cur.type === 'pie' || cur.type === 'doughnut' || cur.type === 'funnel';
    renderColors((perPoint ? data.labels : data.series.map((x) => x.name)).slice(0, 10).map(String));
  }

  const body = h('div', { class: 'chd' },
    h('div', { class: 'chd__preview' }, canvas),
    tabbed([['data', tt('数据'), dataPane], ['style', tt('样式'), stylePane], ['axis', tt('坐标轴'), axisPane]], 'data'));
  body.addEventListener('input', draw);
  body.addEventListener('change', draw);

  openDialog({
    title: existing ? tt('编辑图表') : tt('插入图表'),
    width: 820,
    body,
    buttons: [
      { label: tt('取消') },
      { label: tt('确定'), primary: true, action: () => {
        const area = read();
        if (!area || tooBig(area)) { draw(); return false; }
        const list = (g.model.props.charts ?? []).slice();
        // 新图表放在数据右侧（和 Excel 一样不挡数据）；右侧放不下才退回视口左上
        let pos = { x: Math.round(g.vp.scrollX + 60), y: Math.round(g.vp.scrollY + 40) };
        let lc = area.c1;
        for (const k of g.model.cells.keys()) {
          const i = k.indexOf(':'), r = +k.slice(0, i), c = +k.slice(i + 1);
          if (c > lc && r >= area.r0 - 1 && r <= area.r1) lc = c;
        }
        const rx = g.vp.cols.offsetOf(lc + 1) + 24, ry = g.vp.rows.offsetOf(area.r0);
        if (rx + 240 < g.vp.scrollX + g.vp.bodyW && ry >= g.vp.scrollY && ry < g.vp.scrollY + g.vp.bodyH - 120) pos = { x: rx, y: ry };
        const base = existing ?? { id: 'ch' + Date.now().toString(36), ...pos, w: 480, h: 300 };
        const next = { ...base, ...cur, range: [area.r0, area.c0, area.r1, area.c1] };
        if (!next.colors.some(Boolean)) delete next.colors;
        const i = list.findIndex((c) => c.id === next.id);
        if (i >= 0) list[i] = next; else list.push(next);
        if (g._canEdit()) g.exec([{ t: 'setProp', key: 'charts', value: list }]);
      } },
    ],
  });
  draw();
}

// ── 透视表 ────────────────────────────────────────────────────────────────

/**
 * 新建透视表 / 更改数据源。字段（筛选 / 行 / 列 / 值）在透视表视图右侧的「字段列表」里设置。
 * onSave 拿到 { name, range, header }；新建时另外猜一组默认字段 rows / values（第一个文本列、第一个数字列）。
 * @param {any} g @param {any} existing null 表示新建 @param {string} defName @param {(spec: any) => void} onSave
 */
export function pivot(g, existing, defName, onSave) {
  let s = existing ? { r0: existing.range[0], c0: existing.range[1], r1: existing.range[2], c1: existing.range[3] } : sel(g);
  if (!existing) { if (s.r0 === s.r1 && s.c0 === s.c1) s = g.cmd.region(); s = clipRect(g.model, s); }
  const nameIn = h('input', { class: 'ui-input', value: existing?.name ?? defName, maxLength: 30 });
  const rangeIn = h('input', { class: 'ui-input', value: rectName(s) });
  const hdr = checkbox(tt('首行为字段名（表头）'), existing ? existing.header !== false : g.cmd.looksLikeHeader(s) || typeof g.calc.value(s.r0, s.c0) === 'string');
  const hint = h('p', { class: 'ui-hint' });
  const area = () => parseArea(rangeIn.value);
  const info = () => {
    const a = area();
    hint.textContent = a ? tt('{rows} 行 × {cols} 列数据', { rows: a.r1 - a.r0 + (hdr.input.checked ? 0 : 1), cols: a.c1 - a.c0 + 1 }) + (existing ? '' : tt(' · 插入后在右侧「字段列表」里拖动字段到 筛选 / 行 / 列 / 值')) : tt('数据区域无效，例如 A1:D20');
  };
  rangeIn.addEventListener('input', info);
  hdr.input.addEventListener('change', info);
  info();

  openDialog({
    title: existing ? tt('更改透视表数据源') : tt('插入透视表'),
    width: 460,
    body: [field(tt('名称'), nameIn), field(tt('数据区域'), rangeIn), hdr.el, hint],
    buttons: [
      { label: tt('取消') },
      { label: existing ? tt('确定') : tt('插入'), primary: true, action: () => {
        const a = area();
        if (!a || a.r1 <= a.r0) { hint.textContent = tt('数据区域至少要有两行'); return false; }
        if ((a.r1 - a.r0 + 1) * (a.c1 - a.c0 + 1) > 500000) { hint.textContent = tt('数据区域太大（上限 50 万格）'); return false; }
        /** @type {any} */ const spec = { name: nameIn.value, range: [a.r0, a.c0, a.r1, a.c1], header: hdr.input.checked };
        if (!existing) {
          // 默认：第一个文本列做行，第一个数字列求和
          const top = spec.header ? a.r0 + 1 : a.r0;
          let textCol = -1, numCol = -1;
          for (let c = a.c0; c <= a.c1; c++) {
            const v = g.calc.value(top, c);
            if (textCol < 0 && typeof v === 'string') textCol = c;
            if (numCol < 0 && typeof v === 'number') numCol = c;
          }
          spec.rows = textCol >= 0 ? [textCol] : [];
          spec.values = numCol >= 0 ? [{ col: numCol, agg: 'sum' }] : [];
        }
        onSave(spec);
      } },
    ],
  });
  nameIn.select?.();
}

/** 透视表改名。 @param {string} name @param {(name: string) => void} onSave */
export function renamePivot(name, onSave) {
  const input = h('input', { class: 'ui-input', value: name, maxLength: 30 });
  const hint = h('p', { class: 'ui-hint' });
  openDialog({
    title: tt('重命名透视表'),
    width: 360,
    body: [field(tt('名称'), input), hint],
    buttons: [
      { label: tt('取消') },
      { label: tt('确定'), primary: true, action: () => {
        if (!input.value.trim()) { hint.textContent = tt('名称不能为空'); return false; }
        onSave(input.value);
      } },
    ],
  });
  input.select?.();
}

// ── 插入函数 ──────────────────────────────────────────────────────────────

/** @type {[string, string, string[]|null][]} 常用 + docs.js 的分类 + 全部 */
const FN_CATS = [
  ['common', tt('常用'), ['SUM', 'AVERAGE', 'COUNT', 'COUNTA', 'MAX', 'MIN', 'IF', 'IFERROR', 'VLOOKUP', 'XLOOKUP', 'SUMIF', 'COUNTIF', 'ROUND', 'TODAY', 'CONCAT', 'TEXT']],
  ...CATEGORIES.map(([id, label]) => /** @type {[string, string, string[]]} */ ([id, label, FUNCTION_NAMES.filter((n) => DOCS[n]?.cat === id)])),
  ['all', tt('全部'), null],
];

export function insertFunction(g, preset) {
  const search = h('input', { class: 'ui-input', placeholder: tt('搜索函数，如 sum、查找、日期') });
  const cat = select(FN_CATS.map(([id, label]) => [id, label]), 'common');
  const list = h('div', { class: 'ui-list ui-list--tall' });
  const help = h('div', { class: 'ui-fnhelp' });
  let chosen = preset && FUNCTION_NAMES.includes(preset) ? preset : 'SUM';
  const showHelp = () => {
    const [sig, desc] = splitHelp(chosen);
    help.replaceChildren(h('code', { text: sig }), h('p', { text: desc || '' }), fnDetail(chosen));
  };
  const render = () => {
    const q = search.value.trim().toLowerCase();
    let names = q ? FUNCTION_NAMES : FN_CATS.find((c) => c[0] === cat.value)?.[2] ?? FUNCTION_NAMES;
    if (q) names = names.filter((n) => n.toLowerCase().includes(q) || splitHelp(n).join(' ').toLowerCase().includes(q));
    names = names.filter((n) => FUNCTION_NAMES.includes(n));
    list.replaceChildren(...names.slice(0, 400).map((n) => h('button', {
      type: 'button', class: 'ui-list__item' + (n === chosen ? ' is-active' : ''), text: n,
      onclick: (e) => { chosen = n; for (const b of list.children) b.classList.toggle('is-active', b === e.currentTarget); showHelp(); },
      ondblclick: () => { insert(); dlg.close(); },
    })));
  };
  // 编辑中打开：先记下内容与光标并收起编辑器（对话框抢焦点会触发提交），插入后再原样打开
  const ed = g.editor;
  const pending = ed.open ? { v: ed.el.value, s: ed.el.selectionStart ?? ed.el.value.length, e: ed.el.selectionEnd ?? ed.el.value.length } : null;
  if (pending) ed.cancel();
  const insert = () => {
    if (!g._canEdit()) return;
    const text = chosen + '(';
    inserted = true;
    // 等对话框关掉、焦点归还之后再进编辑，否则归还焦点会让编辑器立刻失焦提交
    setTimeout(() => begin(text), 0);
  };
  const begin = (text) => {
    if (pending) {
      const prefix = pending.v.startsWith('=') ? '' : '=';
      const v = prefix + pending.v.slice(0, pending.s) + text + pending.v.slice(pending.e);
      g._beginEdit(false, v);
      const pos = prefix.length + pending.s + text.length;
      ed.el.setSelectionRange?.(pos, pos);
    } else {
      g._beginEdit(false, '=' + text);
    }
  };
  let inserted = false;
  search.addEventListener('input', render);
  cat.addEventListener('change', render);
  render();
  showHelp();
  const dlg = openDialog({
    title: tt('插入函数'),
    width: 560,
    body: [h('div', { class: 'ui-row' }, search, cat), list, help],
    buttons: [{ label: tt('取消') }, { label: tt('插入'), primary: true, action: () => insert() }],
    onClose: () => { if (pending && !inserted) setTimeout(() => g._beginEdit(false, pending.v), 0); },
  });
}

// ── 小对话框 ──────────────────────────────────────────────────────────────

export function note(g, r, c, text, onSave) {
  const ta = h('textarea', { class: 'ui-input ui-input--area', value: text, placeholder: tt('输入批注…'), maxLength: 2000 });
  openDialog({
    title: tt('批注 — {cell}', { cell: colName(c) + (r + 1) }),
    width: 420,
    body: [ta],
    buttons: [
      ...(text ? [{ label: tt('删除批注'), danger: true, action: () => onSave('') }] : []),
      { label: tt('取消') },
      { label: tt('保存'), primary: true, action: () => onSave(ta.value.trim()) },
    ],
  });
}

export function sizeDialog(g, title, value, min, max, onOk) {
  const input = num(value, min, max);
  const hint = h('p', { class: 'ui-hint', text: tt('范围 {min} – {max} 像素', { min, max }) });
  openDialog({
    title, width: 320,
    body: [field(tt('{title}（像素）', { title }), input), hint],
    buttons: [{ label: tt('取消') }, { label: tt('确定'), primary: true, action: () => {
      const v = Math.round(Number(input.value));
      if (!Number.isFinite(v) || v < min || v > max) { hint.textContent = tt('请输入 {min} – {max} 之间的数字', { min, max }); return false; }
      onOk(v);
    } }],
  });
}

export function insertDelete(g, insert, onPick) {
  const opts = insert
    ? [['right', tt('活动单元格右移')], ['down', tt('活动单元格下移')], ['row', tt('整行')], ['col', tt('整列')]]
    : [['left', tt('右侧单元格左移')], ['up', tt('下方单元格上移')], ['row', tt('整行')], ['col', tt('整列')]];
  const s = sel(g);
  const def = s.c0 === 0 && s.c1 === g.model.colCount - 1 ? 'row' : s.r0 === 0 && s.r1 === g.model.rowCount - 1 ? 'col' : opts[insert ? 1 : 1][0];
  const radios = opts.map(([v, label]) => radio('insdel', v, label, v === def));
  openDialog({
    title: insert ? tt('插入') : tt('删除'), width: 300,
    body: [h('div', { class: 'ui-stack' }, radios.map((x) => x.el))],
    buttons: [{ label: tt('取消') }, { label: tt('确定'), primary: true, action: () => {
      const v = radios.find((x) => x.input.checked)?.input.value ?? def;
      onPick(v === 'left' ? 'right' : v === 'up' ? 'down' : v);
    } }],
  });
}

/** 函数的 [签名, 一句话说明]：优先取 docs.js，没有再拆 FUNCTION_HELP 的 "签名 说明"。 @returns {[string, string]} */
export function splitHelp(name) {
  if (DOCS[name]) return [DOCS[name].sig, DOCS[name].desc];
  const text = FUNCTION_HELP[name] ?? name + '()';
  const i = text.lastIndexOf(')');
  return i > 0 ? [text.slice(0, i + 1), text.slice(i + 1).trim()] : [text, ''];
}

// ── 按值筛选 ──────────────────────────────────────────────────────────────

export function filterValues(g, col, f, setCrit) {
  const [r0, , r1] = f.range;
  const counts = new Map();
  const end = Math.min(r1, g.model.rowCount - 1, r0 + 200000);
  for (let r = r0 + 1; r <= end; r++) {
    const t = g.calc.text(r, col);
    counts.set(t, (counts.get(t) ?? 0) + 1);
  }
  const values = [...counts.keys()].sort((a, b) => (a === '' ? 1 : b === '' ? -1 : a.localeCompare(b, 'zh-CN', { numeric: true })));
  const crit = f.crit?.[col];
  const shown = (v) => {
    if (!crit) return true;
    if (Array.isArray(crit)) return crit.includes(v);
    if (Array.isArray(crit.show)) return crit.show.includes(v);
    if (Array.isArray(crit.hide)) return !crit.hide.includes(v);
    return true;
  };
  const state = new Map(values.map((v) => [v, shown(v)]));
  const search = h('input', { class: 'ui-input', placeholder: tt('搜索') });
  const box = h('div', { class: 'ui-checklist ui-checklist--tall' });
  const allBox = checkbox(tt('（全选）'), true);
  const render = () => {
    const q = search.value.trim().toLowerCase();
    box.replaceChildren();
    let n = 0, allOn = true;
    for (const v of values) {
      if (q && !v.toLowerCase().includes(q)) continue;
      if (++n > 1000) { box.append(h('p', { class: 'ui-hint', text: tt('仅显示前 1000 项，请用搜索缩小范围') })); break; }
      const cb = checkbox((v === '' ? tt('（空白）') : v) + '  (' + counts.get(v) + ')', state.get(v), { onchange: (e) => { state.set(v, e.target.checked); syncAll(); } });
      if (!state.get(v)) allOn = false;
      box.append(cb.el);
    }
    allBox.input.checked = allOn;
  };
  const visible = () => { const q = search.value.trim().toLowerCase(); return values.filter((v) => !q || v.toLowerCase().includes(q)); };
  const syncAll = () => { allBox.input.checked = visible().every((v) => state.get(v)); };
  allBox.input.addEventListener('change', () => { for (const v of visible()) state.set(v, allBox.input.checked); render(); });
  search.addEventListener('input', render);
  render();
  openDialog({
    title: tt('筛选 — {col}', { col: g.calc.text(r0, col) || colName(col) }),
    width: 360,
    body: [search, allBox.el, box],
    buttons: [
      { label: tt('取消') },
      { label: tt('确定'), primary: true, action: () => {
        const show = values.filter((v) => state.get(v));
        const hide = values.filter((v) => !state.get(v));
        if (!hide.length) setCrit(null);
        else if (show.length <= hide.length) setCrit({ show });
        else setCrit({ hide });
      } },
    ],
  });
}

// ── 导入 ──────────────────────────────────────────────────────────────────

export function importOptions(g, name, rows, onPick) {
  const cols = rows.reduce((m, r) => Math.max(m, r.length), 0);
  const a = radio('imp', 'replace', tt('替换当前工作表的全部内容'), true);
  const b = radio('imp', 'insert', tt('从活动单元格 {cell} 开始写入', { cell: colName(g.sel.active.c) + (g.sel.active.r + 1) }), false);
  const preview = h('table', { class: 'ui-table' });
  for (const row of rows.slice(0, 6)) preview.append(h('tr', null, row.slice(0, 8).map((v) => h('td', { text: String(v ?? '') }))));
  openDialog({
    title: tt('导入 {name}', { name }),
    width: 560,
    body: [h('p', { class: 'ui-hint', text: tt('{rows} 行 × {cols} 列', { rows: rows.length.toLocaleString(), cols }) }), h('div', { class: 'ui-scroll' }, preview), h('div', { class: 'ui-stack' }, a.el, b.el)],
    buttons: [{ label: tt('取消') }, { label: tt('导入'), primary: true, action: () => onPick(a.input.checked ? 'replace' : 'insert') }],
  });
}

/** 单元格附件：缩略图 / 图标、查看或下载、移除，以及继续添加。 */
export async function files(g, r, c) {
  const A = await import('../io/attach.js');
  const tableId = g.sync?.tableId ?? '';
  const ro = g.readonly;
  const list = h('div', { class: 'file-list' });
  const hint = h('p', { class: 'ui-hint', text: ro ? '' : tt('单个文件不超过 10MB，大图会自动压缩。也可以把文件直接拖到单元格上，或粘贴截图。') });

  const row = (f) => {
    const url = A.fileUrl(tableId, f.id);
    const img = A.isImage(f.t);
    const thumb = h('a', { class: 'file-item__thumb', href: url, target: '_blank', rel: 'noopener', title: tt('在新标签页打开') },
      img ? h('img', { src: url, alt: '', loading: 'lazy' }) : h('span', { text: A.fileIcon(f.n, f.t) }));
    // 缩略图拿不到（已被清理或网络问题）时退回图标，别露出破图
    thumb.querySelector('img')?.addEventListener('error', () => thumb.replaceChildren(h('span', { text: A.fileIcon(f.n, f.t) })), { once: true });
    const open = h('a', { class: 'ui-btn ui-btn--sm', href: url, text: tt('下载'), attrs: { download: f.n } });
    const del = ro ? null : h('button', { type: 'button', class: 'ui-btn ui-btn--sm ui-btn--danger', text: tt('移除'),
      onclick: () => { g.cmd.removeFileRef(r, c, f.id); render(); } });
    return h('div', { class: 'file-item' }, thumb,
      h('div', { class: 'file-item__meta' }, h('div', { class: 'file-item__name', text: f.n, title: f.n }), h('div', { class: 'ui-hint', text: A.fmtSize(Number(f.s) || 0) })),
      open, del);
  };
  const render = () => {
    const items = g.calc.filesAt(r, c) ?? [];
    list.replaceChildren(...(items.length ? items.map(row) : [h('p', { class: 'ui-hint', text: tt('这个单元格还没有附件。') })]));
  };
  render();

  const pick = () => {
    const input = document.createElement('input');
    input.type = 'file';
    input.multiple = true;
    input.addEventListener('change', async () => {
      if (!input.files?.length) return;
      await g.cmd.uploadFiles([...input.files], r, c);
      render();
    });
    input.click();
    return false;
  };
  openDialog({
    title: tt('附件 — {cell}', { cell: colName(c) + (r + 1) }),
    width: 520,
    body: [list, hint],
    buttons: ro ? [{ label: tt('关闭'), primary: true }] : [{ label: tt('添加附件…'), action: pick }, { label: tt('关闭'), primary: true }],
  });
}
