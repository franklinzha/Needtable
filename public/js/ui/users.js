/**
 * 「用户管理」页（仅管理员）：/yonghuguanli，从顶栏打开（新标签页）。
 * 做成独立页面而不是弹窗：用户多了以后要能搜索、筛选、整页滚动。
 *
 * 本站不开放注册，账号只能由管理员在这里开：
 *
 *   · 默认密码（推荐）：对方用「邮箱 + 默认密码」直接登录，第一次登录必须先改密码。
 *     dk 在这台浏览器里用默认密码算好再交给服务器（600k 次 PBKDF2，Worker 跑不动），
 *     服务器始终只见到 dk。
 *   · 开通链接：服务端生成一次性链接，对方打开后自己设密码。全站开了动态码时只能用它
 *     （默认密码登录的人没有验证器，进不来）。
 *
 * 忘了密码 / 换了手机也是同一套：「重置为默认密码」或「重置并发链接」。
 * 账号等级 admin > pro > plus > normal，含义见 worker/lib/tiers.js。
 *
 * 对自己的停用 / 降级 / 重置按钮不显示（服务端同样会拒绝）。
 */

import { api } from '../core/api.js';
import { toast } from './toast.js';
import { confirmDialog } from './dialog.js';
import { h, linkBox, errMsg } from './panel.js';
import { deriveLoginKey, normalizeEmail } from '../../shared/util/kdf.js';
import { bytesToB64url } from '../../shared/util/b64.js';
import { t, langTag } from '../../shared/i18n/i18n.js';

const STATUS = { active: t('正常'), pending: t('待开通'), disabled: t('已停用') };

/** 账号等级：值 → [名称, 说明] */
const TIERS = /** @type {const} */ ({
  normal: ['Normal', t('只能使用分配给他的工作区 / 内容 / 表，不能新建')],
  plus: ['Plus', t('可新建（最多 3 个工作区），可分享为查看 / 编辑')],
  pro: ['Pro', t('工作区不限，还可以授出「管理者」')],
  admin: [t('管理员'), t('全部权限，并能管理所有用户')],
});

/**
 * @typedef {{ totpRequired: boolean, defaultPassword: string }} Settings
 * @typedef {{ link?: string, email: string, password?: string }} Created
 */

/** 默认密码对应的 dk。和登录页一样：邮箱先规范化。 @param {string} pw @param {string} email */
export const dkFor = async (pw, email) => bytesToB64url(await deriveLoginKey(pw, normalizeEmail(email)));

/** 列表的搜索 / 筛选条件。放模块里：改完一个用户刷新列表时不会被清掉。 */
const filter = { q: '', role: '', status: '' };

/**
 * @param {HTMLElement} body
 * @param {{ id: string, name: string }[]} owned 自己是 owner 的工作区：新建账号时可「同时加入」
 * @param {string | null} wsId 默认选中的工作区（从哪个工作区点进来的）
 */
export function mountUsers(body, owned, wsId) {
  /** @param {Created} [created] 刚建好的账号：重建页面后把链接 / 默认密码接着显示出来 */
  const render = async (created) => {
    try {
      const [{ users }, settings] = await Promise.all([api.get('/api/admin/users'), api.get('/api/admin/settings')]);
      body.replaceChildren(addSection(owned, wsId, settings, render, created), listSection(users, settings, render));
    } catch (e) {
      body.replaceChildren(h('p', 'sec-error', errMsg(e)));
    }
  };
  render();
}

/**
 * @param {{ id: string, name: string }[]} owned
 * @param {string | null} wsId
 * @param {Settings} settings
 * @param {(created?: Created) => Promise<void>} refresh
 * @param {Created} [created]
 */
function addSection(owned, wsId, settings, refresh, created) {
  const sec = h('section', 'sec-section');
  sec.append(h('h3', 'sec-subtitle', t('添加用户')));

  const form = h('form', 'sec-form');
  const email = /** @type {HTMLInputElement} */ (h('input', 'sec-input'));
  email.type = 'email'; email.required = true; email.placeholder = t('邮箱'); email.autocomplete = 'off';
  const name = /** @type {HTMLInputElement} */ (h('input', 'sec-input'));
  name.placeholder = t('名字（可不填）'); name.maxLength = 80;

  const tier = tierSelect('plus');
  const tierRow = h('label', 'sec-switch');
  const tierHint = h('span', 'sec-muted');
  const syncHint = () => { tierHint.textContent = TIERS[/** @type {keyof TIERS} */ (tier.value)][1]; };
  tier.addEventListener('change', syncHint); syncHint();
  tierRow.append(h('span', '', t('账号等级')), tier, tierHint);

  // 开户方式：默认密码 / 开通链接。全站开了动态码只能发链接。
  const modeRow = h('div', 'sec-switch');
  const viaPw = radio('mode', t('默认密码（首次登录强制修改）'), !settings.totpRequired);
  const viaLink = radio('mode', t('发开通链接'), settings.totpRequired);
  viaPw.box.disabled = settings.totpRequired;
  modeRow.append(viaPw.row, viaLink.row);
  form.append(email, name, tierRow, modeRow);
  if (settings.totpRequired) form.append(h('p', 'sec-muted', t('全站已开启动态码：只能发开通链接，让对方打开后绑定验证器。')));

  /** @type {{ box: HTMLInputElement } | null} */ let share = null;
  const shareRole = /** @type {HTMLSelectElement} */ (h('select', 'sec-select'));
  const shareWs = /** @type {HTMLSelectElement} */ (h('select', 'sec-select'));
  if (owned.length) {
    share = checkbox(t('同时加入工作区'));
    share.box.checked = !!wsId && owned.some((w) => w.id === wsId);
    for (const w of owned) shareWs.append(new Option(w.name, w.id));
    if (share.box.checked) shareWs.value = /** @type {string} */ (wsId);
    shareRole.append(new Option(t('可编辑'), 'editor'), new Option(t('只读'), 'viewer'));
    share.row.append(shareWs, h('span', '', t('权限')), shareRole);
    form.append(share.row);
  }

  const ok = /** @type {HTMLButtonElement} */ (h('button', 'sec-btn', t('创建账号')));
  ok.type = 'submit';
  form.append(ok);
  sec.append(form);
  if (created?.link) sec.append(linkBox(created.link, created.email));
  if (created?.password) sec.append(passwordBox(created.email, created.password));
  sec.append(h('p', 'sec-muted', t('Plus 及以上的新用户会自动得到一个自己的工作区；Normal 没有，只能看到分配给他的内容。要让他看到你的表，勾选上面的「同时加入」，或之后在「分享」里按邮箱添加。')));

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    ok.disabled = true;
    try {
      const usePw = viaPw.box.checked && !settings.totpRequired;
      if (usePw) ok.textContent = t('正在计算…');
      const res = await api.post('/api/admin/users', {
        email: email.value, name: name.value, role: tier.value,
        ...(usePw ? { dk: await dkFor(settings.defaultPassword, email.value) } : {}),
        ...(share?.box.checked ? { shareWorkspaceId: shareWs.value, shareRole: shareRole.value } : {}),
      });
      toast(t('已创建 {email}', { email: res.user.email }), 'success');
      await refresh(usePw
        ? { email: res.user.email, password: settings.defaultPassword }
        : { link: res.link, email: res.user.email });
    } catch (err) {
      ok.disabled = false;
      ok.textContent = t('创建账号');
      toast(errMsg(err), 'error', 5000);
    }
  });
  if (!created) queueMicrotask(() => email.focus());
  return sec;
}

/** @param {any[]} users @param {Settings} settings @param {() => void} refresh */
function listSection(users, settings, refresh) {
  const sec = h('section', 'sec-section');
  const title = h('h3', 'sec-subtitle');
  sec.append(title);

  // 搜索 + 筛选：用户多了以后靠它找人，只在本页过滤，不另外请求
  const bar = h('div', 'sec-row up-filter');
  const q = /** @type {HTMLInputElement} */ (h('input', 'sec-input'));
  q.type = 'search'; q.placeholder = t('搜索邮箱或名字'); q.value = filter.q; q.autocomplete = 'off';
  const role = /** @type {HTMLSelectElement} */ (h('select', 'sec-select'));
  role.append(new Option(t('全部等级'), ''));
  for (const [k, [label]] of Object.entries(TIERS)) role.append(new Option(label, k));
  role.value = filter.role;
  const status = /** @type {HTMLSelectElement} */ (h('select', 'sec-select'));
  status.append(new Option(t('全部状态'), ''));
  for (const [k, label] of Object.entries(STATUS)) status.append(new Option(label, k));
  status.value = filter.status;
  bar.append(q, role, status);
  sec.append(bar);

  const list = h('ul', 'sec-list');
  const rows = users.map((u) => {
    const li = userRow(u, settings, refresh);
    list.append(li);
    return { u, li, text: ((u.email ?? '') + ' ' + (u.name ?? '')).toLowerCase() };
  });
  const empty = h('p', 'sec-muted', t('没有符合条件的用户'));
  sec.append(list, empty);

  const apply = () => {
    filter.q = q.value.trim(); filter.role = role.value; filter.status = status.value;
    const words = filter.q.toLowerCase().split(/\s+/).filter(Boolean);
    let shown = 0;
    for (const { u, li, text } of rows) {
      const ok = (!filter.role || u.role === filter.role) && (!filter.status || u.status === filter.status)
        && words.every((w) => text.includes(w));
      li.hidden = !ok;
      if (ok) shown++;
    }
    title.textContent = shown === users.length ? t('所有用户（{n}）', { n: users.length }) : t('用户（{shown} / {n}）', { shown, n: users.length });
    empty.hidden = shown > 0;
  };
  q.addEventListener('input', apply);
  role.addEventListener('change', apply);
  status.addEventListener('change', apply);
  apply();
  return sec;
}

/** @param {any} u @param {Settings} settings @param {() => void} refresh */
function userRow(u, settings, refresh) {
  const li = h('li', 'sec-item');
  const info = h('div', 'sec-item__main');
  const title = h('div', 'sec-item__title');
  title.append(h('span', '', u.name || u.email));
  if (u.me) title.append(badge(t('我'), ''));
  title.append(badge(TIERS[/** @type {keyof TIERS} */ (u.role)]?.[0] ?? u.role, u.role === 'admin' ? 'ok' : ''));
  if (u.mustChange) title.append(badge(t('待改初始密码'), 'warn'));
  if (u.status !== 'active') title.append(badge(STATUS[/** @type {'pending'} */ (u.status)] ?? u.status, u.status === 'disabled' ? 'bad' : 'warn'));
  if (u.locked) title.append(badge(t('输错太多次，暂时锁定'), 'bad'));
  if (u.hasTotp) title.append(badge(t('动态码'), ''));
  const sub = u.email + ' · ' + (u.status === 'pending'
    ? (u.pendingInvite ? t('开通链接未使用') : t('开通链接已过期，点「重置」重新生成'))
    : t('最近活动 {when}', { when: ago(u.lastSeenAt) }));
  info.append(title, h('div', 'sec-muted sec-item__sub', sub));

  const actions = h('div', 'sec-item__actions');
  const extra = h('div', 'sec-item__extra');
  if (!u.me) {
    const tier = tierSelect(u.role);
    tier.title = t('账号等级');
    tier.addEventListener('change', async () => {
      tier.disabled = true;
      try {
        await api.patch('/api/admin/users/' + encodeURIComponent(u.id), { role: tier.value });
        toast(t('已改为 {tier}', { tier: TIERS[/** @type {keyof TIERS} */ (tier.value)][0] }), 'success');
        refresh();
      } catch (e) {
        tier.value = u.role;
        tier.disabled = false;
        toast(errMsg(e), 'error', 5000);
      }
    });
    actions.append(tier);
    if (!settings.totpRequired && u.status !== 'disabled') {
      actions.append(action(t('重置为默认密码'), t('作废他当前的密码、动态码和所有登录；之后用默认密码登录，登录后必须改密码'), async () => {
        if (!(await confirmDialog(t('重置为默认密码'), t('把 {email} 的密码重置为默认密码？他当前的密码、验证器和所有已登录的设备会立即失效。', { email: u.email }), { ok: t('重置'), danger: true }))) return;
        await api.post('/api/admin/users/' + encodeURIComponent(u.id) + '/reset', { dk: await dkFor(settings.defaultPassword, u.email) });
        extra.replaceChildren(passwordBox(u.email, settings.defaultPassword));
        toast(t('已重置为默认密码'), 'success');
      }));
    }
    actions.append(
      action(t('重置并发链接'), t('作废他当前的密码、动态码和所有登录，并生成新的开通链接'), async () => {
        if (!(await confirmDialog(t('重置并发链接'), t('重置 {email}？他当前的密码、验证器和所有已登录的设备会立即失效，需要用新链接重新设置。', { email: u.email }), { ok: t('重置'), danger: true }))) return;
        const res = await api.post('/api/admin/users/' + encodeURIComponent(u.id) + '/reset', {});
        extra.replaceChildren(linkBox(res.link, u.email));
        toast(t('已重置，请把新链接发给他'), 'success');
      }),
      action(u.status === 'disabled' ? t('启用') : t('停用'), '', async () => {
        const disabling = u.status !== 'disabled';
        if (disabling && !(await confirmDialog(t('停用用户'), t('停用 {email}？他会被立即踢下线，无法再登录。', { email: u.email }), { ok: t('停用'), danger: true }))) return;
        await api.patch('/api/admin/users/' + encodeURIComponent(u.id), { status: disabling ? 'disabled' : 'active' });
        toast(disabling ? t('已停用') : t('已启用'), 'success');
        refresh();
      }),
    );
  }
  li.append(info, actions, extra);
  return li;
}

/** @param {string} text @param {string} title @param {() => Promise<void>} fn */
function action(text, title, fn) {
  const b = /** @type {HTMLButtonElement} */ (h('button', 'sec-btn sec-btn--ghost', text));
  b.type = 'button';
  if (title) b.title = title;
  b.addEventListener('click', async () => {
    b.disabled = true;
    try { await fn(); } catch (e) { toast(errMsg(e), 'error', 5000); }
    b.disabled = false;
  });
  return b;
}

/** @param {string} value */
function tierSelect(value) {
  const sel = /** @type {HTMLSelectElement} */ (h('select', 'sec-select'));
  for (const [k, [label]] of Object.entries(TIERS)) sel.append(new Option(label, k));
  sel.value = value in TIERS ? value : 'plus';
  return sel;
}

/** 告诉管理员怎么转告对方。默认密码本来就在安全设置里对管理员可见，这里不算泄露。 @param {string} email @param {string} pw */
export function passwordBox(email, pw) {
  const box = h('div', 'sec-link');
  const text = t('登录地址：{url}\n邮箱：{email}\n初始密码：{pw}\n（第一次登录后需要修改密码）', { url: location.origin + '/login', email, pw });
  const pre = h('pre', 'sec-input sec-input--mono sec-pre', text);
  const copy = /** @type {HTMLButtonElement} */ (h('button', 'sec-btn', t('复制')));
  copy.type = 'button';
  copy.addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(text); copy.textContent = t('已复制'); }
    catch { copy.textContent = t('复制失败，请手动选择'); }
    setTimeout(() => { copy.textContent = t('复制'); }, 1500);
  });
  const row = h('div', 'sec-row');
  row.append(pre, copy);
  box.append(row);
  return box;
}

/** @param {string} group @param {string} text @param {boolean} checked */
function radio(group, text, checked) {
  const row = h('label', 'sec-switch');
  const box = /** @type {HTMLInputElement} */ (h('input'));
  box.type = 'radio'; box.name = group; box.checked = checked;
  row.append(box, h('span', '', text));
  return { row, box };
}

/** @param {string} text */
function checkbox(text) {
  const row = h('label', 'sec-switch');
  const box = /** @type {HTMLInputElement} */ (h('input'));
  box.type = 'checkbox';
  row.append(box, h('span', '', text));
  return { row, box };
}

/** @param {string} text @param {''|'ok'|'warn'|'bad'} kind */
function badge(text, kind) {
  return h('span', 'sec-badge' + (kind ? ' sec-badge--' + kind : ''), text);
}

/** @param {number} ts */
function ago(ts) {
  if (!ts) return '—';
  const s = (Date.now() - ts) / 1000;
  if (s < 90) return t('刚刚');
  if (s < 3600) return t('{n} 分钟前', { n: Math.round(s / 60) });
  if (s < 86400) return t('{n} 小时前', { n: Math.round(s / 3600) });
  if (s < 86400 * 30) return t('{n} 天前', { n: Math.round(s / 86400) });
  return new Date(ts).toLocaleDateString(langTag());
}
