/**
 * 「安全设置」面板，从顶栏打开。
 *
 *   · 所有人：给自己绑定 / 重新绑定验证器 App
 *   · 管理员：全站开关「登录需要 6 位动态码」，默认关
 *
 * 开关打开之后，没绑验证器的人就登录不了了。所以面板会把这些人列出来，
 * 服务端也不允许一个自己都没绑的管理员去开它（见 worker/routes/security.js）。
 */

import { api } from '../core/api.js';
import { toast } from './toast.js';
import { drawQr } from '../../shared/util/qr.js';
import { h, openPanel } from './panel.js';
import { t, langTag } from '../../shared/i18n/i18n.js';

/** @param {{ role: string }} user */
export function openSecurityPanel(user) {
  const { body } = openPanel(t('安全设置'));

  const render = async () => {
    try {
      const mine = await api.get('/api/me/security');
      const admin = user.role === 'admin' ? await api.get('/api/admin/settings') : null;
      body.replaceChildren();
      if (admin) body.append(adminSection(admin, render));
      body.append(totpSection(mine, render));
    } catch (e) {
      body.replaceChildren(h('p', 'sec-error', /** @type {Error} */ (e).message));
    }
  };
  render();
}

/**
 * @param {{ totpRequired: boolean, defaultPassword: string, meHasTotp: boolean, withoutTotp: string[], doUsage?: { rows: number, limit: number } }} s
 * @param {() => void} refresh
 */
function adminSection(s, refresh) {
  const sec = h('section', 'sec-section');
  sec.append(h('h3', 'sec-subtitle', t('全站登录方式（管理员）')));

  const row = h('label', 'sec-switch');
  const box = /** @type {HTMLInputElement} */ (h('input'));
  box.type = 'checkbox';
  box.checked = s.totpRequired;
  row.append(box, h('span', '', t('登录需要 6 位动态码')));
  sec.append(row);

  sec.append(h('p', 'sec-muted', s.totpRequired
    ? t('已开启：登录要输入 邮箱 + 密码 + 验证器上的 6 位动态码。')
    : t('已关闭：登录只要 邮箱 + 密码。')));

  if (!s.totpRequired && s.withoutTotp.length) {
    sec.append(h('p', 'sec-warn',
      t('以下账号还没绑定验证器，开启后将无法登录：{list}', { list: s.withoutTotp.join(t('、')) })));
  }
  if (!s.meHasTotp) {
    sec.append(h('p', 'sec-muted', t('你自己还没绑定验证器 —— 先在下面绑定，才能开启这个开关。')));
  }

  box.addEventListener('change', async () => {
    box.disabled = true;
    try {
      await api.put('/api/admin/settings', { totpRequired: box.checked });
      toast(box.checked ? t('已开启：登录需要动态码') : t('已关闭：登录只要邮箱和密码'), 'success');
      refresh();
    } catch (e) {
      box.checked = !box.checked;
      box.disabled = false;
      toast(/** @type {Error} */ (e).message, 'error', 5000);
    }
  });

  // Cloudflare 免费额度：Durable Object 每天 10 万行写入，全账号共用；超了当天所有表都写不进去。
  if (s.doUsage) {
    const { rows, limit } = s.doUsage;
    sec.append(h('h3', 'sec-subtitle', t('今日数据写入量')));
    sec.append(h('p', rows > limit * 0.8 ? 'sec-warn' : 'sec-muted',
      t('今天已用 {rows} / {limit} 行（估算，UTC 0 点 = 北京 08:00 重置）。', { rows: rows.toLocaleString(langTag()), limit: limit.toLocaleString(langTag()) })
      + (rows > limit * 0.95 ? t('接近上限，大批量粘贴 / 导入会被暂时拒绝。') : '')));
  }

  // 管理员开户 / 重置时用的默认密码。只影响之后的开户，已经发出去的不变。
  sec.append(h('h3', 'sec-subtitle', t('新账号的默认密码')));
  const form = h('form', 'sec-row');
  const pw = /** @type {HTMLInputElement} */ (h('input', 'sec-input sec-input--mono'));
  pw.value = s.defaultPassword; pw.minLength = 8; pw.maxLength = 128; pw.autocomplete = 'off'; pw.spellcheck = false;
  const save = /** @type {HTMLButtonElement} */ (h('button', 'sec-btn', t('保存')));
  save.type = 'submit';
  form.append(pw, save);
  sec.append(form, h('p', 'sec-muted', t('用默认密码开户或重置的人，第一次登录后必须改成自己的密码。')));
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    save.disabled = true;
    try {
      await api.put('/api/admin/settings', { defaultPassword: pw.value });
      toast(t('默认密码已更新'), 'success');
      refresh();
    } catch (err) {
      save.disabled = false;
      toast(/** @type {Error} */ (err).message, 'error', 5000);
    }
  });
  return sec;
}

/**
 * @param {{ hasTotp: boolean, totpRequired: boolean }} mine
 * @param {() => void} refresh
 */
function totpSection(mine, refresh) {
  const sec = h('section', 'sec-section');
  sec.append(h('h3', 'sec-subtitle', t('我的验证器')));
  sec.append(h('p', 'sec-muted', mine.hasTotp
    ? t('已绑定。重新绑定后，旧的验证器条目就不能用了。')
    : t('未绑定。用 Google / Microsoft Authenticator 等 App 扫码即可。')));

  const start = h('button', 'sec-btn', mine.hasTotp ? t('重新绑定') : t('绑定验证器'));
  sec.append(start);

  start.addEventListener('click', async () => {
    /** @type {HTMLButtonElement} */ (start).disabled = true;
    try {
      const b = await api.post('/api/me/totp/begin', {});
      start.remove();
      sec.append(bindForm(b, refresh));
    } catch (e) {
      /** @type {HTMLButtonElement} */ (start).disabled = false;
      toast(/** @type {Error} */ (e).message, 'error', 5000);
    }
  });
  return sec;
}

/**
 * @param {{ otpauth: string, secret: string, pending: string }} b
 * @param {() => void} refresh
 */
function bindForm(b, refresh) {
  const form = h('form', 'sec-bind');
  const canvas = /** @type {HTMLCanvasElement} */ (h('canvas', 'sec-qr'));
  drawQr(canvas, b.otpauth, { scale: 4 });

  const secret = h('p', 'sec-muted');
  secret.append(t('扫不了就手动输入密钥：'));
  secret.append(h('code', 'sec-code', b.secret.replace(/(.{4})/g, '$1 ').trim()));

  const input = /** @type {HTMLInputElement} */ (h('input', 'sec-input'));
  input.inputMode = 'numeric';
  input.autocomplete = 'one-time-code';
  input.maxLength = 7;
  input.placeholder = t('App 上显示的 6 位数字');

  const ok = /** @type {HTMLButtonElement} */ (h('button', 'sec-btn', t('确认绑定')));
  ok.type = 'submit';
  form.append(canvas, secret, input, ok);

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const code = input.value.replace(/[ -]/g, '');
    if (!/^[0-9]{6}$/.test(code)) { toast(t('请输入 6 位数字'), 'error'); return; }
    ok.disabled = true;
    try {
      await api.post('/api/me/totp/confirm', { pending: b.pending, code });
      toast(t('验证器已绑定'), 'success');
      refresh();
    } catch (err) {
      ok.disabled = false;
      toast(/** @type {Error} */ (err).message, 'error', 5000);
    }
  });
  queueMicrotask(() => input.focus());
  return form;
}
