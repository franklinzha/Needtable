/**
 * 安全设置：管理员的全站动态码开关 + 每个人给自己绑定验证器。
 *
 * 两件事放一起，是因为它们互为前提：开关打开之后，没绑验证器的人就登录不了。
 * 所以绑定入口对所有已登录用户开放，开关只给管理员，而且管理员自己没绑之前不让开 ——
 * 否则点一下就把自己锁在门外，只能回命令行 reset。
 */

import { json, badRequest, forbidden, conflict } from '../lib/response.js';
import { t } from '../../public/shared/i18n/i18n.js';
import {
  newTotpSecret, secretToBase32, otpauthUri, verifyTotp, encryptSecret, decryptSecret, normalizeCode,
} from '../lib/totp.js';
import { totpRequired, setTotpRequired, defaultPassword, setDefaultPassword } from '../lib/settings.js';

/** @param {Request} request */
async function readJson(request) {
  try { return await request.json(); } catch { return null; }
}

/** @param {any} env @param {string} userId */
async function hasTotp(env, userId) {
  const row = await env.DB.prepare('SELECT totp_secret FROM users WHERE id = ?').bind(userId).first();
  return !!row?.totp_secret;
}

/**
 * 今天（UTC）所有表的 Durable Object 写入行数，由各 DO 的 alarm 累加进来（见 TableDO._reportUsage）。
 * 免费额度每天 10 万行，全账号共用。读不到就当 0，不影响面板其余部分。
 * @param {any} env
 */
async function doUsage(env) {
  const day = new Date().toISOString().slice(0, 10);
  let rows = 0;
  try {
    const row = await env.DB.prepare('SELECT value FROM app_settings WHERE key = ?').bind('do_usage:' + day).first();
    rows = Number(row?.value) || 0;
  } catch { /* 表还没有这一行 */ }
  return { day, rows, limit: 100000 };
}

/** @param {any} env */
async function settingsView(env, /** @type {string} */ userId) {
  const { results } = await env.DB.prepare(
    `SELECT email FROM users WHERE status = 'active' AND totp_secret IS NULL ORDER BY created_at`,
  ).all();
  return {
    totpRequired: await totpRequired(env),
    // 管理员页面要用它在浏览器里算出 dk 再交给服务器开户（600k 次 PBKDF2，Worker 跑不动）
    defaultPassword: await defaultPassword(env),
    meHasTotp: await hasTotp(env, userId),
    // 开关打开后会被挡在门外的人。界面上列出来，让管理员开之前心里有数。
    withoutTotp: (results ?? []).map((/** @type {any} */ r) => r.email),
    doUsage: await doUsage(env),
  };
}

/** GET /api/admin/settings @param {Request} request @param {import('../lib/router.js').RequestContext} c */
export async function getSettings(request, c) {
  if (c.user.role !== 'admin') return forbidden(t('只有管理员能查看安全设置'));
  return json(await settingsView(c.env, c.user.id));
}

/** PUT /api/admin/settings — body: { totpRequired?: boolean, defaultPassword?: string } */
export async function putSettings(/** @type {Request} */ request, /** @type {any} */ c) {
  if (c.user.role !== 'admin') return forbidden(t('只有管理员能修改安全设置'));
  const body = await readJson(request);
  const hasTotpField = body?.totpRequired !== undefined;
  const hasPwField = body?.defaultPassword !== undefined;
  if (!hasTotpField && !hasPwField) return badRequest(t('没有要修改的内容'));
  if (hasTotpField && typeof body.totpRequired !== 'boolean') return badRequest(t('totpRequired 必须是 true 或 false'));
  if (hasPwField && (typeof body.defaultPassword !== 'string' || body.defaultPassword.length < 8 || body.defaultPassword.length > 128)) {
    return badRequest(t('默认密码至少 8 位'));
  }

  if (body.totpRequired && !(await hasTotp(c.env, c.user.id))) {
    return conflict(t('请先给自己绑定验证器，再打开这个开关 —— 否则你下次就登录不了了'));
  }
  if (hasTotpField) await setTotpRequired(c.env, body.totpRequired, c.user.id);
  if (hasPwField) await setDefaultPassword(c.env, body.defaultPassword, c.user.id);
  return json(await settingsView(c.env, c.user.id));
}

/**
 * POST /api/me/totp/begin
 *
 * 生成一个新密钥，但**先不入库**：原样加密后交给浏览器（pending），等用户输对一次
 * 动态码再落库。直接写库的话，扫到一半关掉页面，旧的验证器就已经作废了。
 * pending 是 AES-GCM 密文，浏览器拿着也改不了、读不出。
 */
export async function totpBegin(/** @type {Request} */ request, /** @type {any} */ c) {
  const secret = newTotpSecret();
  return json({
    otpauth: otpauthUri({ issuer: c.env.APP_NAME || 'Needtable', email: c.user.email, secret }),
    secret: secretToBase32(secret),
    pending: await encryptSecret(secret, c.env),
  });
}

/** POST /api/me/totp/confirm — body: { pending, code } */
export async function totpConfirm(/** @type {Request} */ request, /** @type {any} */ c) {
  const body = await readJson(request);
  const code = normalizeCode(body?.code);
  if (!code) return badRequest(t('请输入验证器上的 6 位动态码'));
  const secret = typeof body?.pending === 'string' ? await decryptSecret(body.pending, c.env) : null;
  if (!secret) return badRequest(t('二维码已失效，请重新开始绑定'));

  const totp = await verifyTotp(secret, code, { lastStep: 0 });
  if (!totp.ok) return badRequest(t('动态码不正确，请确认手机时间准确后重试'));

  await c.env.DB.prepare('UPDATE users SET totp_secret = ?, totp_last_step = ? WHERE id = ?')
    .bind(body.pending, totp.step, c.user.id).run();
  return json({ ok: true });
}

/** GET /api/me/security —— 任何已登录用户：自己绑没绑验证器、全站开没开动态码。 */
export async function getMySecurity(/** @type {Request} */ request, /** @type {any} */ c) {
  return json({ hasTotp: await hasTotp(c.env, c.user.id), totpRequired: await totpRequired(c.env) });
}
