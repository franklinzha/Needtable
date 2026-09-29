/**
 * 界面语言偏好：和主题配色一样存在 users 上，换设备也跟着走。
 * 可选的语言列表在 public/shared/i18n/i18n.js，前后端共用。
 */

import { json, badRequest } from '../lib/response.js';
import { t, isLang } from '../../public/shared/i18n/i18n.js';

/** 自己选的语言。users.lang 列还没迁移时当作没选。 @param {any} env @param {string} userId */
export async function myLang(env, userId) {
  try {
    const row = await env.DB.prepare('SELECT lang FROM users WHERE id = ?').bind(userId).first();
    return isLang(row?.lang) ? row.lang : null;
  } catch { return null; }
}

/** PUT /api/me/lang — body: { lang: 'en' | … } */
export async function putMyLang(/** @type {Request} */ request, /** @type {any} */ c) {
  let body = null;
  try { body = await request.json(); } catch { /* 下面统一报错 */ }
  const id = body?.lang;
  if (!isLang(id)) return badRequest(t('不支持这种语言'));
  await c.env.DB.prepare('UPDATE users SET lang = ? WHERE id = ?').bind(id, c.user.id).run();
  return json({ lang: id });
}
