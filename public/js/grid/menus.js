/**
 * 右键菜单：单元格区域 / 列标 / 行号三套。每一项都只是 cmd.run(id) 的一个入口，
 * 所以与功能区、快捷键的行为完全一致（可撤销、会同步、只读时自动禁用）。
 */

import { openMenu } from '../ui/menu.js';
import { CF_TYPES } from './calc.js';
import { INSERT_CHARTS } from './dialogs.js';
import { NO_COPY } from './commands.js';
import { t as tt } from '../../shared/i18n/i18n.js';

/** 只读用户也能用的命令 */
const RO_OK = new Set(['viewFiles', 'copy', 'find', 'selectRegion', 'showFormulas', 'freeze', 'freezeRow', 'freezeCol', 'freezeHere', 'unfreeze', 'exportCsv', 'exportXlsx']);

function item(g, label, id, extra = {}) {
  const ro = (g.readonly && !RO_OK.has(id)) || (g.noCopy && NO_COPY.has(id));
  return { label, action: () => g.cmd.run(id, extra.arg), disabled: ro || !!extra.disabled, shortcut: extra.key, checked: extra.checked, danger: extra.danger, icon: extra.icon };
}

function pasteSpecial(g) {
  return [
    item(g, tt('粘贴'), 'paste', { key: 'Ctrl+V' }),
    item(g, tt('只粘贴值'), 'pasteValues'),
    item(g, tt('只粘贴格式'), 'pasteFormats'),
    item(g, tt('只粘贴公式'), 'pasteFormulas'),
    item(g, tt('转置粘贴'), 'pasteTranspose'),
  ];
}

function sortFilter(g) {
  const on = !!g.model.props.filter;
  return [
    item(g, tt('升序 A→Z'), 'sortAsc', { icon: '↑' }),
    item(g, tt('降序 Z→A'), 'sortDesc', { icon: '↓' }),
    item(g, tt('自定义排序…'), 'sortDialog'),
    { sep: true },
    item(g, on ? tt('取消筛选') : tt('筛选'), 'toggleFilter', { key: 'Ctrl+Shift+L', checked: on }),
    item(g, tt('清除筛选条件'), 'clearFilter', { disabled: !on }),
  ];
}

function cfMenu(g) {
  return [
    ...CF_TYPES.filter(([t]) => t !== 'bar' && t !== 'scale').map(([t, label]) => item(g, label + '…', 'cf', { arg: t })),
    { sep: true },
    { label: tt('数据条'), submenu: [['#638ec6', tt('蓝色数据条')], ['#63be7b', tt('绿色数据条')], ['#f8696b', tt('红色数据条')], ['#ffb628', tt('橙色数据条')]].map(([c, n]) => item(g, n, 'cfBar', { arg: c })) },
    { label: tt('色阶'), submenu: [
      item(g, tt('红 - 黄 - 绿'), 'cfScale', { arg: ['#f8696b', '#ffeb84', '#63be7b'] }),
      item(g, tt('绿 - 黄 - 红'), 'cfScale', { arg: ['#63be7b', '#ffeb84', '#f8696b'] }),
      item(g, tt('白 - 蓝'), 'cfScale', { arg: ['#ffffff', '#5a8ac6'] }),
      item(g, tt('白 - 红'), 'cfScale', { arg: ['#ffffff', '#f8696b'] }),
    ] },
    { sep: true },
    item(g, tt('管理规则…'), 'cfManage'),
    item(g, tt('清除所选单元格的规则'), 'cfClear', { arg: 'sel' }),
    item(g, tt('清除整个工作表的规则'), 'cfClear', { arg: 'all' }),
  ];
}

/** @param {any} g @param {{x:number,y:number}} at */
export function openCellMenu(g, at) {
  const { r, c } = g.sel.active;
  const s = g.sel.rect;
  const multi = s.r0 !== s.r1 || s.c0 !== s.c1;
  const merged = !!g.calc.mergeAt?.(r, c);
  const note = g.calc.noteAt?.(r, c);
  const nFiles = g.calc.filesAt?.(r, c)?.length ?? 0;
  const hasClip = !!g._clip;
  const items = [
    item(g, tt('剪切'), 'cut', { key: 'Ctrl+X', icon: '✂' }),
    item(g, tt('复制'), 'copy', { key: 'Ctrl+C' }),
    item(g, tt('粘贴'), 'paste', { key: 'Ctrl+V' }),
    { label: tt('选择性粘贴'), submenu: pasteSpecial(g), disabled: g.readonly || !hasClip && !navigator.clipboard?.readText },
    item(g, tt('格式刷'), 'painter', { checked: !!g.painter }),
    { sep: true },
    { label: tt('插入'), disabled: g.readonly, submenu: [
      item(g, tt('在上方插入行'), 'insertRowsAbove'),
      item(g, tt('在下方插入行'), 'insertRowsBelow'),
      item(g, tt('在左侧插入列'), 'insertColsLeft'),
      item(g, tt('在右侧插入列'), 'insertColsRight'),
      { sep: true },
      item(g, tt('活动单元格下移'), 'shiftDown'),
      item(g, tt('活动单元格右移'), 'shiftRight'),
      item(g, tt('插入…'), 'insertDialog', { key: 'Ctrl++' }),
    ] },
    { label: tt('删除'), disabled: g.readonly, submenu: [
      item(g, tt('删除整行'), 'deleteRows'),
      item(g, tt('删除整列'), 'deleteCols'),
      { sep: true },
      item(g, tt('下方单元格上移'), 'shiftUp'),
      item(g, tt('右侧单元格左移'), 'shiftLeft'),
      item(g, tt('删除…'), 'deleteDialog', { key: 'Ctrl+-' }),
    ] },
    { label: tt('清除'), disabled: g.readonly, submenu: [
      item(g, tt('清除内容'), 'clearContent', { key: 'Delete' }),
      item(g, tt('清除格式'), 'clearFormat'),
      item(g, tt('清除批注'), 'clearNotes'),
      item(g, tt('清除附件'), 'clearFiles'),
      item(g, tt('清除数据验证'), 'clearValidation'),
      item(g, tt('全部清除'), 'clearAll', { danger: true }),
    ] },
    { sep: true },
    { label: tt('排序和筛选'), submenu: sortFilter(g) },
    { label: tt('填充'), disabled: g.readonly, submenu: [
      item(g, tt('向下填充'), 'fillDown', { key: 'Ctrl+D' }),
      item(g, tt('向右填充'), 'fillRight', { key: 'Ctrl+R' }),
      item(g, tt('填充到数据末尾'), 'fillToEnd'),
    ] },
    { sep: true },
    item(g, tt('设置单元格格式…'), 'formatCells', { key: 'Ctrl+1' }),
    { label: tt('条件格式'), disabled: g.readonly, submenu: cfMenu(g) },
    { label: tt('合并单元格'), disabled: g.readonly, submenu: [
      item(g, tt('合并后居中'), 'mergeCenter', { disabled: !multi }),
      item(g, tt('合并单元格'), 'merge', { disabled: !multi }),
      item(g, tt('跨越合并'), 'mergeAcross', { disabled: !multi }),
      item(g, tt('取消合并'), 'unmerge', { disabled: !merged && !multi }),
    ] },
    { label: tt('数据工具'), disabled: g.readonly, submenu: [
      item(g, tt('分列…'), 'splitText'),
      item(g, tt('删除重复项…'), 'dedupe'),
      item(g, tt('数据验证…'), 'validation'),
      item(g, tt('下拉列表…'), 'insertDropdown'),
      item(g, tt('多级下拉…'), 'insertCascade'),
      item(g, tt('复选框'), 'insertCheckbox'),
      { sep: true },
      item(g, tt('公式转为值'), 'toValues'),
      item(g, tt('转大写'), 'upper'),
      item(g, tt('转小写'), 'lower'),
      item(g, tt('首字母大写'), 'proper'),
      item(g, tt('去除多余空格'), 'trim'),
    ] },
    { sep: true },
    note ? item(g, tt('编辑批注…'), 'insertNote') : item(g, tt('插入批注…'), 'insertNote', { key: 'Shift+F2' }),
    ...(note ? [item(g, tt('删除批注'), 'deleteNote')] : []),
    ...(nFiles ? [item(g, tt('查看附件（{n}）…', { n: nFiles }), 'viewFiles', { icon: '📎' })] : []),
    item(g, tt('插入附件…'), 'insertFile', { icon: nFiles ? undefined : '📎' }),
    { label: tt('插入图表'), disabled: g.readonly, submenu: INSERT_CHARTS.map(([t, label]) => item(g, label, 'insertChart', { arg: t })) },
    item(g, tt('插入透视表…'), 'insertPivot', { icon: '⊞' }),
    item(g, tt('插入函数…'), 'insertFunction', { key: 'Shift+F3' }),
    { sep: true },
    item(g, tt('行高…'), 'rowHeight'),
    item(g, tt('列宽…'), 'colWidth'),
    { label: tt('冻结窗格'), submenu: freezeMenu(g) },
    item(g, tt('查找和替换…'), 'replace', { key: 'Ctrl+H' }),
  ];
  openMenu(items, at, { onClose: () => g.scroll.focus?.({ preventScroll: true }) });
}

function freezeMenu(g) {
  const f = g.model.props.freeze;
  const any = !!(f && (f.r || f.c));
  return [
    item(g, tt('冻结至当前单元格'), 'freezeHere'),
    item(g, tt('冻结首行'), 'freezeRow'),
    item(g, tt('冻结首列'), 'freezeCol'),
    item(g, tt('取消冻结'), 'unfreeze', { disabled: !any }),
  ];
}

/** 列标 / 行号的右键菜单。 @param {any} g @param {'col'|'row'} axis @param {{x:number,y:number}} at */
export function openHeaderMenu(g, axis, at) {
  const s = g.sel.rect;
  const col = axis === 'col';
  const n = col ? s.c1 - s.c0 + 1 : s.r1 - s.r0 + 1;
  const hidden = (col ? g.model.props.hiddenCols : g.model.props.hiddenRows) ?? [];
  const lo = col ? s.c0 : s.r0, hi = col ? s.c1 : s.r1;
  const anyHidden = hidden.some((i) => i >= lo - 1 && i <= hi + 1);
  const items = [
    item(g, tt('剪切'), 'cut', { key: 'Ctrl+X' }),
    item(g, tt('复制'), 'copy', { key: 'Ctrl+C' }),
    item(g, tt('粘贴'), 'paste', { key: 'Ctrl+V' }),
    { label: tt('选择性粘贴'), submenu: pasteSpecial(g), disabled: g.readonly },
    { sep: true },
    col ? item(g, tt('在左侧插入 {n} 列', { n }), 'insertColsLeft') : item(g, tt('在上方插入 {n} 行', { n }), 'insertRowsAbove'),
    col ? item(g, tt('在右侧插入 {n} 列', { n }), 'insertColsRight') : item(g, tt('在下方插入 {n} 行', { n }), 'insertRowsBelow'),
    item(g, col ? tt('删除 {n} 列', { n }) : tt('删除 {n} 行', { n }), col ? 'deleteCols' : 'deleteRows', { danger: true }),
    item(g, tt('清除内容'), 'clearContent', { key: 'Delete' }),
    item(g, tt('清除格式'), 'clearFormat'),
    { sep: true },
    item(g, tt('设置单元格格式…'), 'formatCells', { key: 'Ctrl+1' }),
    col ? item(g, tt('列宽…'), 'colWidth') : item(g, tt('行高…'), 'rowHeight'),
    col ? item(g, tt('自动调整列宽'), 'autofit') : item(g, tt('自动调整行高'), 'autofitRow'),
    item(g, tt('隐藏'), col ? 'hideCols' : 'hideRows'),
    item(g, tt('取消隐藏'), col ? 'unhideCols' : 'unhideRows', { disabled: !anyHidden }),
    { sep: true },
    ...(col ? [
      item(g, tt('升序排序'), 'sortAsc', { icon: '↑' }),
      item(g, tt('降序排序'), 'sortDesc', { icon: '↓' }),
      item(g, tt('筛选'), 'toggleFilter', { checked: !!g.model.props.filter }),
      item(g, tt('分列…'), 'splitText'),
      item(g, tt('删除重复项…'), 'dedupe'),
      { sep: true },
    ] : []),
    { label: tt('冻结窗格'), submenu: freezeMenu(g) },
    { label: tt('条件格式'), disabled: g.readonly, submenu: cfMenu(g) },
  ];
  openMenu(items, at, { onClose: () => g.scroll.focus?.({ preventScroll: true }) });
}
