/**
 * 工作界面的侧边栏：← 主页、当前工作区（可切换）、内容 → 表。
 *
 * 数据是 /api/home 的树里当前那个工作区。每一行右侧有「⋯」菜单（右键也行），
 * 双击名字原地改名；菜单内容和权限判断都在 main.js，这里只负责画。
 */

import { h } from './dom.js';
import { openMenu } from './menu.js';
import { atLeast, canCreate } from '../core/perm.js';
import { t as tt } from '../../shared/i18n/i18n.js';

/** 收起的内容（按 id）。只在这次打开页面里记住。 */
const collapsed = new Set();

/**
 * @typedef {'workspace'|'base'|'table'} Level
 * @param {HTMLElement} root
 * @param {{ user: any, workspaces: any[], activeWorkspaceId: string | null, activeTableId: string | null }} state
 * @param {{
 *   go(path: string): void,
 *   menu(level: Level, obj: any, at: { x: number, y: number }): void,
 *   rename(level: Level, obj: any, labelEl: HTMLElement): void,
 *   createBase(wsId: string): void,
 *   createTable(baseId: string, kind?: string): void,
 *   createIn(baseId: string, anchor: HTMLElement): void,
 * }} on
 */
export function renderSidebar(root, state, on) {
  root.replaceChildren();
  root.append(h('a', { class: 'tree__home', href: '/', dataset: { nav: '' } }, tt('← 主页')));

  const ws = state.workspaces.find((w) => w.id === state.activeWorkspaceId)
    ?? state.monitor?.find((/** @type {any} */ w) => w.id === state.activeWorkspaceId);

  // ── 工作区：名字 + 切换 ──
  root.append(sectionHead(tt('工作区'), state.workspaces.length > 1 ? {
    title: tt('切换工作区'), glyph: '⇅',
    onClick: (e) => {
      const r = /** @type {HTMLElement} */ (e.currentTarget).getBoundingClientRect();
      openMenu(state.workspaces.map((w) => ({
        label: w.name, icon: w.icon || '📊', checked: w.id === state.activeWorkspaceId,
        action: () => on.go('/w/' + w.id),
      })), { x: r.left, y: r.bottom + 4 });
    },
  } : undefined));
  if (!ws) {
    root.append(empty(tt('找不到这个工作区')));
    return;
  }
  root.append(h('ul', null, row({
    level: 'workspace', obj: ws, on,
    icon: ws.icon || '📊', label: ws.name,
    current: !state.activeTableId,
    title: ws.partial ? tt('只分享给你其中一部分') : undefined,
    // 已经在这一页就不再跳：跳转会重画侧边栏，双击的第二下落在新元素上，改名就触发不了
    onClick: () => { if (state.activeTableId) on.go('/w/' + ws.id); },
  })));
  if (ws.partial) root.append(h('div', { class: 'tree__note', text: tt('部分共享：只显示分享给你的内容和表') }));

  // ── 内容 + 表 ──
  const mayCreateBase = canCreate(state.user) && atLeast(ws.role, 'editor');
  root.append(sectionHead(tt('内容'), mayCreateBase ? { title: tt('新建内容'), onClick: () => on.createBase(ws.id) } : undefined));

  if (ws.bases.length === 0) {
    root.append(empty(mayCreateBase ? tt('还没有内容，点上面的 + 新建一个') : tt('还没有内容')));
    return;
  }

  const tree = h('ul', null);
  for (const base of ws.bases) {
    const kids = h('ul', { class: 'tree__kids', hidden: collapsed.has(base.id) });
    const mayCreateTable = canCreate(state.user) && atLeast(base.role, 'editor');
    const baseRow = row({
      level: 'base', obj: base, on,
      icon: collapsed.has(base.id) ? '📁' : '📂', label: base.name,
      title: base.via === 'container' ? tt('这个内容里只有部分表分享给你') : tt('点击收起 / 展开'),
      onClick: () => {
        if (collapsed.has(base.id)) collapsed.delete(base.id); else collapsed.add(base.id);
        kids.hidden = collapsed.has(base.id);
        const icon = baseRow.querySelector('.tree__icon');
        if (icon) icon.textContent = kids.hidden ? '📁' : '📂';
      },
      extra: mayCreateTable
        ? h('button', { class: 'tree__more', type: 'button', text: '+', title: tt('在此内容下新建表、文档或幻灯片'),
          onclick: (/** @type {MouseEvent} */ e) => { e.stopPropagation(); on.createIn(base.id, /** @type {HTMLElement} */ (e.currentTarget)); } })
        : null,
    });
    tree.append(h('li', null, baseRow, kids));

    if (base.tables.length === 0) {
      kids.append(h('li', null, empty(tt('（空）'), true)));
      continue;
    }
    for (const t of base.tables) {
      kids.append(h('li', null, row({
        level: 'table', obj: t, on, nested: true,
        icon: t.icon || ({ sheet: '🧮', doc: '📝', slides: '📽️' }[/** @type {'sheet'} */ (t.kind)] ?? '📄'), label: t.name,
        title: t.name + ' · ' + t.id,
        current: t.id === state.activeTableId,
        onClick: () => { if (t.id !== state.activeTableId) on.go('/t/' + t.id); },
      })));
    }
  }
  root.append(tree);
}

/**
 * @param {string} text
 * @param {{ title: string, glyph?: string, onClick: (e: MouseEvent) => void }} [action]
 */
function sectionHead(text, action) {
  return h('div', { class: 'tree__section-head' },
    h('span', { text }),
    action ? h('button', { class: 'icon-btn', type: 'button', text: action.glyph ?? '+', title: action.title,
      attrs: { 'aria-label': action.title }, onclick: action.onClick }) : null);
}

/**
 * 一行：主按钮（图标 + 名字）+ 可选的额外按钮 + 「⋯」。
 * 按钮里不能再套按钮，所以外面包一层 div。
 * @param {{ level: Level, obj: any, on: any, icon: string, label: string, nested?: boolean,
 *           current?: boolean, title?: string, onClick: () => void, extra?: HTMLElement | null }} o
 */
function row(o) {
  const label = h('span', { class: 'tree__label', text: o.label });   // textContent：名字是用户输入
  const main = h('button', {
    type: 'button', class: 'tree__item', title: o.title,
    attrs: { 'aria-current': o.current ? 'true' : null },
    onclick: o.onClick,
    ondblclick: () => o.on.rename(o.level, o.obj, label),
  }, h('span', { class: 'tree__icon', text: o.icon, attrs: { 'aria-hidden': 'true' } }), label);
  /** @param {{ x: number, y: number }} at */
  const menu = (at) => o.on.menu(o.level, o.obj, at);
  const more = h('button', { class: 'tree__more', type: 'button', text: '⋯', title: tt('更多操作'),
    attrs: { 'aria-label': tt('更多操作') },
    onclick: (/** @type {MouseEvent} */ e) => {
      const r = /** @type {HTMLElement} */ (e.currentTarget).getBoundingClientRect();
      menu({ x: r.left, y: r.bottom + 4 });
    } });
  const wrap = h('div', { class: 'tree__row' + (o.nested ? ' tree__row--nested' : '') + (o.current ? ' is-current' : '') },
    main, o.extra ?? null, more);
  wrap.addEventListener('contextmenu', (e) => { e.preventDefault(); menu({ x: e.clientX, y: e.clientY }); });
  return wrap;
}

/** @param {string} text @param {boolean} [nested] */
function empty(text, nested) {
  return h('div', { class: 'tree__empty' + (nested ? ' tree__empty--nested' : ''), text });
}
