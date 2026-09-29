/**
 * 主页：这个人能看到的全部工作区，每个工作区下面列内容和表。
 *
 *   · 我的工作区：自己是 owner 的
 *   · 共享给我：别人的工作区。整个工作区分享进来的显示全部；只分享了某个内容 / 某张表的
 *     标「部分共享」，里面只有分享给他的那几项
 *
 * 点表进入 /t/<表编号>；点「进入」进工作区。名字双击改名，「⋯」/ 右键出菜单（main.js 里建）。
 * normal 账号不能新建，什么都没分配时显示「等待分配」。
 */

import { h } from './dom.js';
import { atLeast, canCreate, ROLE_LABEL } from '../core/perm.js';
import { t as tt } from '../../shared/i18n/i18n.js';

/**
 * @typedef {'workspace'|'base'|'table'} Level
 * @param {HTMLElement} root
 * @param {{ user: any, workspaces: any[] }} state
 * @param {{
 *   menu(level: Level, obj: any, at: { x: number, y: number }): void,
 *   rename(level: Level, obj: any, labelEl: HTMLElement): void,
 *   createWorkspace(): void,
 *   createBase(wsId: string): void,
 *   createTable(baseId: string, kind?: string): void,
 *   createIn(baseId: string, anchor: HTMLElement): void,
 * }} on
 */
export function renderHome(root, state, on) {
  const me = state.user;
  const mine = state.workspaces.filter((w) => w.owner_id === me.id);
  const shared = state.workspaces.filter((w) => w.owner_id !== me.id);
  const tableCount = state.workspaces.reduce((n, w) => n + w.bases.reduce((m, /** @type {any} */ b) => m + b.tables.length, 0), 0);

  const head = h('div', { class: 'home__head' },
    h('div', null,
      h('h1', { class: 'home__title', text: tt('你好，{name}', { name: me.name || me.email.split('@')[0] }) }),
      h('p', { class: 'home__sub', text: state.workspaces.length
        ? tt('{ws} 个工作区 · {tables} 张表', { ws: state.workspaces.length, tables: tableCount })
        : '' })),
    canCreate(me)
      ? h('button', { class: 'home__btn home__btn--primary', type: 'button', text: tt('＋ 新建工作区'), onclick: () => on.createWorkspace() })
      : null);

  const page = h('div', { class: 'home' }, head);

  if (!state.workspaces.length) {
    page.append(h('div', { class: 'home__empty' },
      h('div', { class: 'home__empty-icon', text: '🗂️' }),
      h('p', { text: canCreate(me)
        ? tt('还没有工作区。点右上角「新建工作区」开始。')
        : tt('等待管理员为你分配工作区或表格。分配之后刷新这个页面就能看到。') })));
  }
  if (mine.length) page.append(section(tt('我的工作区'), mine, state, on));
  if (shared.length) page.append(section(tt('共享给我'), shared, state, on));
  // 管理员：其余所有人的工作区，只读监控。按所有者分组看更清楚，这里已按所有者邮箱排好序
  if (state.monitor?.length) page.append(section(tt('全部工作区（管理员监控 · 只读）'), state.monitor, state, on));

  root.replaceChildren(page);
}

/** @param {string} title @param {any[]} list @param {any} state @param {any} on */
function section(title, list, state, on) {
  return h('section', { class: 'home__section' },
    h('h2', { class: 'home__h2', text: title }),
    h('div', { class: 'home__grid' }, list.map((ws) => card(ws, state, on))));
}

/** @param {any} ws @param {any} state @param {any} on */
function card(ws, state, on) {
  const me = state.user;
  const name = h('span', { class: 'home-card__name', text: ws.name, title: tt('双击改名') });
  name.addEventListener('dblclick', () => on.rename('workspace', ws, name));

  const badges = h('div', { class: 'home-card__badges' });
  if (ws.owner_id !== me.id) badges.append(badge(ws.owner_name || ws.owner_email ? tt('来自 {name}', { name: ws.owner_name || ws.owner_email }) : tt('来自他人')));
  if (ws.monitor) badges.append(badge(tt('监控 · 只读'), 'warn'));
  else if (ws.partial) badges.append(badge(tt('部分共享'), 'warn'));
  else if (ws.role) badges.append(badge(ROLE_LABEL[ws.role] ?? ws.role, ws.role === 'owner' ? 'ok' : ''));

  const cardEl = h('article', { class: 'home-card' },
    h('header', { class: 'home-card__head' },
      h('span', { class: 'home-card__icon', text: ws.icon || '📊', attrs: { 'aria-hidden': 'true' } }),
      h('div', { class: 'home-card__titles' }, name, badges),
      moreBtn('workspace', ws, on)),
  );

  const bases = h('div', { class: 'home-card__bases' });
  if (!ws.bases.length) bases.append(h('p', { class: 'home-card__empty', text: tt('还没有内容') }));
  for (const base of ws.bases) bases.append(baseBlock(base, state, on));
  cardEl.append(bases);

  const foot = h('footer', { class: 'home-card__foot' },
    h('a', { class: 'home__btn', href: '/w/' + ws.id, dataset: { nav: '' }, text: tt('进入工作区 →') }));
  if (canCreate(me) && atLeast(ws.role, 'editor')) {
    foot.append(h('button', { class: 'home__btn home__btn--ghost', type: 'button', text: tt('＋ 新建内容'), onclick: () => on.createBase(ws.id) }));
  }
  cardEl.append(foot);
  cardEl.addEventListener('contextmenu', (e) => {
    if (e.target instanceof Element && e.target.closest('.home-base')) return;
    e.preventDefault();
    on.menu('workspace', ws, { x: e.clientX, y: e.clientY });
  });
  return cardEl;
}

/** @param {any} base @param {any} state @param {any} on */
function baseBlock(base, state, on) {
  const name = h('span', { class: 'home-base__name', text: base.name, title: base.via === 'container' ? tt('这个内容里只有部分表分享给你') : tt('双击改名') });
  name.addEventListener('dblclick', () => on.rename('base', base, name));
  const head = h('div', { class: 'home-base__head' },
    h('span', { text: '📁', attrs: { 'aria-hidden': 'true' } }), name,
    canCreate(state.user) && atLeast(base.role, 'editor')
      ? h('button', { class: 'home-base__btn', type: 'button', text: '+', title: tt('新建表、文档或幻灯片'), onclick: (/** @type {MouseEvent} */ e) => on.createIn(base.id, /** @type {HTMLElement} */ (e.currentTarget)) })
      : null,
    moreBtn('base', base, on, 'home-base__btn'));

  const chips = h('div', { class: 'home-base__tables' });
  if (!base.tables.length) chips.append(h('span', { class: 'home-card__empty', text: tt('（空）') }));
  for (const t of base.tables) {
    const chip = h('a', {
      class: 'home-chip', href: '/t/' + t.id, dataset: { nav: '' },
      title: t.name + '\n' + tt('表编号 {id}', { id: t.id }) + (t.row_count ? '\n' + tt('{n} 行', { n: t.row_count }) : ''),
    }, h('span', { text: t.icon || ({ sheet: '🧮', doc: '📝', slides: '📽️' }[/** @type {'sheet'} */ (t.kind)] ?? '📄'), attrs: { 'aria-hidden': 'true' } }),
       h('span', { class: 'home-chip__name', text: t.name }));
    chip.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      e.stopPropagation();
      on.menu('table', t, { x: e.clientX, y: e.clientY });
    });
    chips.append(chip);
  }
  const block = h('div', { class: 'home-base' }, head, chips);
  block.addEventListener('contextmenu', (e) => {
    if (e.target instanceof Element && e.target.closest('.home-chip')) return;
    e.preventDefault();
    on.menu('base', base, { x: e.clientX, y: e.clientY });
  });
  return block;
}

/** @param {Level} level @param {any} obj @param {any} on @param {string} [cls] */
function moreBtn(level, obj, on, cls = 'home-card__more') {
  return h('button', {
    class: cls, type: 'button', text: '⋯', title: tt('更多操作'), attrs: { 'aria-label': tt('更多操作') },
    onclick: (/** @type {MouseEvent} */ e) => {
      const r = /** @type {HTMLElement} */ (e.currentTarget).getBoundingClientRect();
      on.menu(level, obj, { x: r.left, y: r.bottom + 4 });
    },
  });
}

/** @param {string} text @param {string} [kind] */
function badge(text, kind) {
  return h('span', { class: 'home-badge' + (kind ? ' home-badge--' + kind : ''), text });
}
