/**
 * 右键菜单 / 下拉菜单。一次只开一个，点外面、Esc、窗口失焦都会关。
 *
 * 菜单项：{ label, shortcut?, action?, disabled?, checked?, submenu?: Item[], sep?: true, danger? }
 * 键盘：上下移动，右键头展开子菜单，左键头收回，Enter 执行，Esc 关闭。
 */

import { h, placeNear } from './dom.js';

/** @typedef {{label?:string, shortcut?:string, action?:()=>void, disabled?:boolean, checked?:boolean, submenu?:Item[], sep?:boolean, danger?:boolean, icon?:string}} Item */

/** @type {{close:()=>void} | null} */
let current = null;

export function closeMenu() { current?.close(); }

/**
 * @param {Item[]} items
 * @param {{x:number, y:number}} at 屏幕坐标
 * @param {{onClose?:()=>void}} [opts]
 */
export function openMenu(items, at, opts = {}) {
  closeMenu();
  /** @type {any[]} */ const stack = [];

  const trim = (level) => { while (stack.length > level) stack.pop().remove(); };

  const close = () => {
    trim(0);
    document.removeEventListener('pointerdown', onDown, true);
    document.removeEventListener('keydown', onKey, true);
    window.removeEventListener('blur', close);
    window.removeEventListener('resize', close);
    if (current === handle) current = null;
    opts.onClose?.();
  };
  const handle = { close };
  current = handle;

  const focusRow = (menu, row) => {
    if (menu._active) menu._active.classList.remove('is-active');
    if (row) row.classList.add('is-active');
    menu._active = row;
  };

  const build = (list, x, y, level) => {
    trim(level);
    const menu = h('div', { class: 'ui-menu', attrs: { role: 'menu' } });
    menu._rows = [];
    for (const it of list) {
      if (it.sep) { menu.append(h('div', { class: 'ui-menu__sep' })); continue; }
      const cls = 'ui-menu__item' + (it.disabled ? ' is-disabled' : '') + (it.danger ? ' is-danger' : '');
      const row = h('div', { class: cls, attrs: { role: 'menuitem' } },
        h('span', { class: 'ui-menu__check', text: it.checked ? '✓' : (it.icon || '') }),
        h('span', { class: 'ui-menu__label', text: it.label ?? '' }),
        h('span', { class: 'ui-menu__key', text: it.submenu ? '›' : (it.shortcut || '') }));
      row._item = it;
      if (!it.disabled) menu._rows.push(row);
      row.addEventListener('pointerenter', () => {
        focusRow(menu, row);
        if (it.submenu && !it.disabled) openSub(row, it, level);
        else trim(level + 1);
      });
      row.addEventListener('click', (e) => {
        e.stopPropagation();
        if (it.disabled) return;
        if (it.submenu) { openSub(row, it, level); return; }
        close();
        it.action?.();
      });
      menu.append(row);
    }
    document.body.append(menu);
    placeNear(menu, x, y);
    stack.push(menu);
    return menu;
  };

  const openSub = (row, it, level) => {
    if (stack[level + 1] && stack[level + 1]._owner === row) return stack[level + 1];
    const r = row.getBoundingClientRect();
    const sub = build(it.submenu ?? [], r.right - 2, r.top - 4, level + 1);
    sub._owner = row;
    const sr = sub.getBoundingClientRect();
    if (sr.left < r.right - 10) sub.style.left = Math.max(4, r.left - sr.width + 2) + 'px';
    return sub;
  };

  const onDown = (e) => {
    if (stack.some((m) => m.contains(e.target))) return;
    close();
  };

  const onKey = (e) => {
    const menu = stack[stack.length - 1];
    if (!menu) return;
    e.stopPropagation();
    e.preventDefault();
    const rows = menu._rows;
    const idx = rows.indexOf(menu._active);
    switch (e.key) {
      case 'Escape':
        if (stack.length > 1) trim(stack.length - 1); else close();
        return;
      case 'ArrowDown': case 'ArrowUp': {
        const n = rows.length;
        if (!n) return;
        focusRow(menu, rows[e.key === 'ArrowDown' ? (idx + 1) % n : (idx - 1 + n) % n]);
        return;
      }
      case 'ArrowRight':
        if (menu._active && menu._active._item.submenu) {
          const sub = openSub(menu._active, menu._active._item, stack.length - 1);
          if (sub._rows[0]) focusRow(sub, sub._rows[0]);
        }
        return;
      case 'ArrowLeft':
        if (stack.length > 1) trim(stack.length - 1);
        return;
      case 'Enter':
        if (menu._active) menu._active.click();
        return;
    }
  };

  build(items, at.x, at.y, 0);
  setTimeout(() => {
    if (current !== handle) return;
    document.addEventListener('pointerdown', onDown, true);
    window.addEventListener('blur', close);
    window.addEventListener('resize', close);
  }, 0);
  document.addEventListener('keydown', onKey, true);
  return handle;
}
