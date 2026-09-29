/**
 * 「主题配色」面板，从顶栏打开。
 *
 *   · 所有人：挑一套配色（只影响自己），或者跟随系统默认
 *   · 管理员：设系统默认配色；新增 / 删除自定义配色（名字 + 5 个颜色）
 *
 * 5 个颜色怎么变成整套界面颜色，见 shared/theme.js；贴到页面上见 core/theme.js。
 */

import { api } from '../core/api.js';
import { toast } from './toast.js';
import { h, openPanel } from './panel.js';
import { PALETTES, DEFAULT_THEME, MAX_CUSTOM_THEMES, findTheme } from '../../shared/theme.js';
import { applyTheme, effectiveTheme } from '../core/theme.js';
import { t as tt } from '../../shared/i18n/i18n.js';

/** @typedef {import('../../shared/theme.js').Theme} Theme */
/** @typedef {import('../core/theme.js').ThemeInfo} ThemeInfo */

/** 5 个色块排成一条。 @param {string[]} colors */
function strip(colors) {
  const el = h('span', 'th-strip');
  for (const c of colors) {
    const s = h('span', 'th-strip__c');
    s.style.setProperty('background', c);
    el.append(s);
  }
  return el;
}

/** @param {{ user: { role: string }, theme?: ThemeInfo }} state */
export function openThemePanel(state) {
  const { body } = openPanel(tt('主题配色'), { wide: true });

  /** @param {ThemeInfo} info */
  const update = (info) => {
    state.theme = info;
    applyTheme(effectiveTheme(info), info.custom);
    render();
  };

  const render = () => {
    const info = state.theme ?? { mine: null, def: DEFAULT_THEME, custom: [] };
    body.replaceChildren(mineSection(info, update));
    if (state.user.role === 'admin') body.append(adminSection(info, update));
  };
  render();
}

/** @param {ThemeInfo} info @param {(i: ThemeInfo) => void} update */
function mineSection(info, update) {
  const sec = h('section', 'sec-section');
  sec.append(h('h3', 'sec-subtitle', tt('我的配色')));
  sec.append(h('p', 'sec-muted', tt('只影响你自己看到的界面，换了立即生效，其他设备登录后同步。深色模式跟随系统，每套配色都有对应的深色版本。')));
  const all = [...PALETTES, ...info.custom];
  const def = findTheme(info.def, info.custom) ?? PALETTES[0];

  const grid = h('div', 'th-grid');
  /** @param {string | null} id @param {Theme} t @param {string} label */
  const card = (id, t, label) => {
    const on = info.mine === id;
    const b = /** @type {HTMLButtonElement} */ (h('button', 'th-card' + (on ? ' th-card--on' : '')));
    b.type = 'button';
    b.setAttribute('aria-pressed', String(on));
    const name = h('span', 'th-card__name', label);
    if (id !== null && t.id === info.def) name.append(h('span', 'th-badge', tt('系统默认')));
    if (t.custom) name.append(h('span', 'th-badge th-badge--soft', tt('自定义')));
    b.append(strip(t.colors), name);
    b.addEventListener('click', async () => {
      if (on) return;
      grid.querySelectorAll('button').forEach((x) => { /** @type {HTMLButtonElement} */ (x).disabled = true; });
      try {
        update(await api.put('/api/me/theme', { theme: id }));
      } catch (e) {
        toast(/** @type {Error} */ (e).message, 'error', 5000);
        grid.querySelectorAll('button').forEach((x) => { /** @type {HTMLButtonElement} */ (x).disabled = false; });
      }
    });
    return b;
  };
  grid.append(card(null, def, tt('跟随系统默认（{name}）', { name: def.name })));
  for (const t of all) grid.append(card(t.id, t, t.name));
  sec.append(grid);
  return sec;
}

/** @param {ThemeInfo} info @param {(i: ThemeInfo) => void} update */
function adminSection(info, update) {
  const sec = h('section', 'sec-section');
  sec.append(h('h3', 'sec-subtitle', tt('系统默认配色（管理员）')));
  sec.append(h('p', 'sec-muted', tt('没有自己选过配色的人（包括新注册的账号）看到的就是它。')));

  /** @param {any} body @param {string} ok */
  const save = async (body, ok) => {
    try {
      update(await api.put('/api/admin/theme', body));
      toast(ok, 'success');
    } catch (e) {
      toast(/** @type {Error} */ (e).message, 'error', 5000);
    }
  };

  const row = h('div', 'sec-row');
  const sel = /** @type {HTMLSelectElement} */ (h('select', 'sec-select th-select'));
  for (const t of [...PALETTES, ...info.custom]) {
    const o = /** @type {HTMLOptionElement} */ (h('option', '', t.custom ? tt('{name}（自定义）', { name: t.name }) : t.name));
    o.value = t.id;
    sel.append(o);
  }
  sel.value = info.def;
  const setDef = /** @type {HTMLButtonElement} */ (h('button', 'sec-btn', tt('设为系统默认')));
  setDef.type = 'button';
  setDef.addEventListener('click', () => {
    if (sel.value === info.def) { toast(tt('已经是系统默认了')); return; }
    void save({ def: sel.value }, tt('系统默认配色已改为「{name}」', { name: findTheme(sel.value, info.custom)?.name ?? '' }));
  });
  row.append(sel, setDef);
  sec.append(row);

  sec.append(h('h3', 'sec-subtitle th-gap', tt('自定义配色')));
  if (info.custom.length) {
    const list = h('ul', 'sec-list');
    for (const t of info.custom) {
      const li = h('li', 'th-item');
      const del = /** @type {HTMLButtonElement} */ (h('button', 'sec-btn sec-btn--ghost', tt('删除')));
      del.type = 'button';
      del.addEventListener('click', () => {
        // 面板里没有 confirm()：点一次变成「确认删除」，再点才删
        if (del.dataset.armed !== '1') { del.dataset.armed = '1'; del.textContent = tt('确认删除'); return; }
        void save({ custom: info.custom.filter((x) => x.id !== t.id) }, tt('已删除「{name}」', { name: t.name }));
      });
      li.append(strip(t.colors), h('span', 'th-item__name', t.id === info.def ? tt('{name}（系统默认）', { name: t.name }) : t.name), del);
      list.append(li);
    }
    sec.append(list);
  } else {
    sec.append(h('p', 'sec-muted', tt('还没有。可以在下面添加一套，添加后所有人都能选。')));
  }

  if (info.custom.length >= MAX_CUSTOM_THEMES) {
    sec.append(h('p', 'sec-muted', tt('自定义配色最多 {n} 套，删掉一些才能再加。', { n: MAX_CUSTOM_THEMES })));
    return sec;
  }

  // 新增：名字 + 5 个取色器，下面实时预览。颜色按「底色 → 点缀」随意排，强调色会自动挑最鲜艳的那个
  const form = h('form', 'sec-form th-form');
  const name = /** @type {HTMLInputElement} */ (h('input', 'sec-input'));
  name.placeholder = tt('配色名字，例如：春日樱花');
  name.maxLength = 30;
  const pickers = h('div', 'th-pickers');
  const start = ['#ffcad4', '#f4acb7', '#9d8189', '#d8e2dc', '#ffe5d9'];
  const inputs = start.map((c) => {
    const i = /** @type {HTMLInputElement} */ (h('input', 'th-picker'));
    i.type = 'color';
    i.value = c;
    pickers.append(i);
    return i;
  });
  const preview = h('div', 'th-preview');
  const paint = () => preview.replaceChildren(strip(inputs.map((i) => i.value)), h('span', 'sec-muted', tt('按钮、选中、链接等会用其中最鲜艳的颜色（自动加深到文字看得清）。')));
  inputs.forEach((i) => i.addEventListener('input', paint));
  paint();
  const add = /** @type {HTMLButtonElement} */ (h('button', 'sec-btn', tt('添加配色')));
  add.type = 'submit';
  form.append(name, pickers, preview, add);
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const n = name.value.trim();
    if (!n) { toast(tt('请给配色起个名字')); name.focus(); return; }
    const id = 'c_' + Math.random().toString(36).slice(2, 10).padEnd(8, '0');
    void save({ custom: [...info.custom, { id, name: n, colors: inputs.map((i) => i.value.toLowerCase()) }] }, tt('已添加「{name}」，所有人都能选了', { name: n }));
  });
  sec.append(form);
  return sec;
}
