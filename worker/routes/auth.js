/**
 * 登录、登出、开通账号。
 *
 * 这几个端点是整个站点上**唯一**不需要会话就能访问的东西，所以每一条都得
 * 自己扛住攻击面。设计时盯着三件事：
 *
 * ① 不泄露「这个邮箱存不存在」
 *    登录表单一次性收齐 邮箱 + 口令（+ 动态码，若管理员开了），不做「先验口令再问
 *    动态码」的两步；失败一律回同一句话、同一个 code；账号不存在时照样跑一遍哈希运算。
 *
 *    动态码是全站开关（lib/settings.js），默认关：先让人进得来，再由管理员决定
 *    要不要加第二因素。关着的时候，库里有没有 TOTP 密钥都不看、也不要求。
 *
 * ② 不被撞库刷爆 D1 的写额度
 *    失败计数是要写 D1 的。免费套餐 100K 行写/天，一个脚本几分钟就能刷完。
 *    所以写之前先过一道**内存**限流（按 IP），限流拦下的请求一行都不写。
 *
 * ③ 管理员不掌握用户的凭据
 *    CLI 只签发一次性邀请令牌（库里存 sha256），口令与 TOTP 密钥都在
 *    「用户点开链接」这一刻才产生。管理员既不知道口令，也不知道 TOTP 密钥。
 */

import { json, badRequest, unauthorized, notFound, tooManyRequests } from '../lib/response.js';
import { t } from '../../public/shared/i18n/i18n.js';
import { consume } from '../middleware/ratelimit.js';
import {
  hashLoginKey, verifyLoginKey, dummyVerify, newServerSalt, parseDk, PW_VERSION,
} from '../lib/password.js';
import {
  newTotpSecret, otpauthUri, verifyTotp, encryptSecret, decryptSecret, normalizeCode,
} from '../lib/totp.js';
import {
  signSession, sessionCookieHeader, clearCookieHeader, withCookie,
} from '../lib/session.js';
import { KDF } from '../../public/shared/util/kdf.js';
import { authMode } from '../middleware/auth.js';
import { totpRequired } from '../lib/settings.js';

/** 连续失败多少次锁定，锁多久。 */
const MAX_FAILURES = 8;
const LOCK_MS = 15 * 60 * 1000;
const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** 对外只有这一句。多说一个字都是在帮攻击者做信息收集。 */
const LOGIN_FAILED = () => unauthorized(t('邮箱、密码或动态码不正确'));
const LOGIN_FAILED_PW = () => unauthorized(t('邮箱或密码不正确'));

/** @param {Request} request */
const clientIp = (request) =>
  request.headers.get('cf-connecting-ip') || request.headers.get('x-forwarded-for') || 'unknown';

/** @param {unknown} v */
const normalizeEmail = (v) => String(v ?? '').trim().toLowerCase();

/** @param {string} text @returns {Promise<string>} 十六进制 sha256 */
async function sha256Hex(text) {
  const bits = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(bits)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** @param {Request} request */
async function readJson(request) {
  try { return await request.json(); } catch { return null; }
}

// ── GET /api/auth/config ────────────────────────────────────────────────────

/**
 * 登录页启动时拉一次。故意只暴露公开信息：应用名、认证模式、KDF 参数。
 * KDF 参数由服务端下发而不是客户端写死，这样将来提高迭代次数不需要用户清缓存。
 * @param {Request} request @param {{ env: any }} c
 */
export async function getAuthConfig(request, c) {
  return json({
    mode: authMode(c.env),
    // 登录页据此决定要不要显示动态码输入框。这是全站开关，不是按人的 ——
    // 按人返回就等于告诉别人「这个邮箱存在、而且绑了验证器」。
    totpRequired: authMode(c.env) === 'password' ? await totpRequired(c.env) : false,
    appName: c.env.APP_NAME ?? 'Needtable',
    environment: c.env.ENVIRONMENT ?? 'production',
    kdf: { version: KDF.version, hash: KDF.hash, iterations: KDF.iterations, dkBytes: KDF.dkBytes },
  });
}

// ── POST /api/auth/login ────────────────────────────────────────────────────

/**
 * body: { email, dk (base64url), code? } —— code 只在开了动态码时才看
 * @param {Request} request @param {{ env: any, url: URL }} c
 */
export async function login(request, c) {
  const { env, url } = c;

  // 先过内存限流。被拦下的请求不碰 D1 —— 这是保护写额度的那道闸。
  const gate = consume('login:' + clientIp(request), { capacity: 12, refillPerSec: 0.05 });
  if (!gate.ok) return tooManyRequests(gate.retryAfter);

  const body = await readJson(request);
  const email = normalizeEmail(body?.email);
  const dk = parseDk(body?.dk);
  const needCode = await totpRequired(env);
  const code = needCode ? normalizeCode(body?.code) : null;
  const failed = needCode ? LOGIN_FAILED : LOGIN_FAILED_PW;

  if (!email || !dk || (needCode && !code)) {
    await dummyVerify(env);                    // 保持耗时一致
    return failed();
  }

  const row = await env.DB.prepare(
    `SELECT id, email, name, role, status, pw_hash, pw_salt, totp_secret, totp_last_step,
            failed_count, locked_until, session_epoch, must_change_pw
       FROM users WHERE email = ?`,
  ).bind(email).first();

  // 账号不存在也走一遍同样的计算，否则「查无此人」会明显更快。
  // 开了动态码却还没绑验证器的人进不来 —— 管理员开开关之前，界面上会提示有几个这样的账号。
  if (!row || !row.pw_hash || !row.pw_salt || (needCode && !row.totp_secret)) {
    await dummyVerify(env);
    return failed();
  }
  if (row.status !== 'active') {
    await dummyVerify(env);
    return failed();                           // 不区分「被停用」与「不存在」
  }
  if (Number(row.locked_until ?? 0) > Date.now()) {
    await dummyVerify(env);
    return failed();
  }

  const pwOk = await verifyLoginKey(dk, row.pw_salt, row.pw_hash, env);

  let step = Number(row.totp_last_step ?? 0);
  if (needCode) {
    const secret = await decryptSecret(row.totp_secret, env);
    const totp = secret && code
      ? await verifyTotp(secret, code, { lastStep: step })
      : /** @type {const} */ ({ ok: false, reason: 'mismatch' });
    if (!pwOk || !totp.ok) {
      await recordFailure(env, row);
      return failed();
    }
    step = totp.step;
  } else if (!pwOk) {
    await recordFailure(env, row);
    return failed();
  }

  await markSuccess(env, row, step);
  return await issueSession(
    env, url,
    { id: row.id, email: row.email, session_epoch: Number(row.session_epoch ?? 1) },
    // mustChange：管理员给的默认密码，登录页要先让他设一个新的再进去
    { id: row.id, email: row.email, name: row.name, role: row.role, mustChange: Number(row.must_change_pw ?? 0) === 1 },
  );
}

/**
 * 失败计数。到阈值就锁一段时间。
 * @param {any} env @param {any} row
 */
async function recordFailure(env, row) {
  const n = Number(row.failed_count ?? 0) + 1;
  const lockedUntil = n >= MAX_FAILURES ? Date.now() + LOCK_MS : Number(row.locked_until ?? 0);
  await env.DB.prepare('UPDATE users SET failed_count = ?, locked_until = ? WHERE id = ?')
    .bind(n >= MAX_FAILURES ? 0 : n, lockedUntil, row.id).run();
}

/** @param {any} env @param {any} row @param {number} step */
async function markSuccess(env, row, step) {
  // totp_last_step 必须写，否则同一个 6 位码在 30 秒内能再用一次。
  await env.DB.prepare(
    'UPDATE users SET failed_count = 0, locked_until = 0, totp_last_step = ?, last_seen_at = ? WHERE id = ?',
  ).bind(step, Date.now(), row.id).run();
}

/**
 * @param {any} env @param {URL} url
 * @param {{ id: string, email: string, session_epoch: number }} forCookie
 * @param {{ id: string, email: string, name: string|null, role: string, mustChange?: boolean }} user
 */
async function issueSession(env, url, forCookie, user) {
  const token = await signSession(forCookie, env);
  return withCookie(json({ ok: true, user }), sessionCookieHeader(token, url));
}

// ── POST /api/auth/logout ───────────────────────────────────────────────────

/** @param {Request} request @param {{ url: URL }} c */
export function logout(request, c) {
  return withCookie(json({ ok: true }), clearCookieHeader(c.url));
}

// ── 开通账号 ────────────────────────────────────────────────────────────────

/**
 * 校验邀请令牌，顺带把过期的清掉。
 * @param {any} env @param {unknown} token
 * @returns {Promise<{ invite: any, user: any } | null>}
 */
async function lookupInvite(env, token) {
  if (typeof token !== 'string' || token.length < 20 || token.length > 200) return null;
  const hash = await sha256Hex(token);

  const invite = await env.DB.prepare(
    'SELECT token_hash, user_id, email, kind, expires_at, used_at FROM user_invites WHERE token_hash = ?',
  ).bind(hash).first();

  if (!invite) return null;
  if (invite.used_at) return null;
  if (Number(invite.expires_at) <= Date.now()) return null;

  const user = await env.DB.prepare(
    'SELECT id, email, name, role, status, totp_secret, session_epoch FROM users WHERE id = ?',
  ).bind(invite.user_id).first();

  return user ? { invite, user } : null;
}

/**
 * POST /api/auth/enroll/begin — body: { token }
 *
 * 开了动态码时：返回 TOTP 密钥与 otpauth URI，让页面画二维码。密钥在这一刻生成
 * 并加密入库，重复请求返回同一个 —— 用户刷新页面不会让已经扫进 App 的那个失效。
 * 没开时：只确认链接有效，页面直接让人设密码。
 * @param {Request} request @param {{ env: any }} c
 */
export async function enrollBegin(request, c) {
  const { env } = c;
  const gate = consume('enroll:' + clientIp(request), { capacity: 20, refillPerSec: 0.1 });
  if (!gate.ok) return tooManyRequests(gate.retryAfter);

  const body = await readJson(request);
  const found = await lookupInvite(env, body?.token);
  if (!found) return notFound(t('链接无效或已过期，请联系管理员重新签发'));

  const { user } = found;
  const kdf = { version: KDF.version, hash: KDF.hash, iterations: KDF.iterations, dkBytes: KDF.dkBytes };
  if (!(await totpRequired(env))) {
    return json({ email: user.email, name: user.name, kind: found.invite.kind, totpRequired: false, kdf });
  }

  let secret = user.totp_secret ? await decryptSecret(user.totp_secret, env) : null;
  if (!secret) {
    secret = newTotpSecret();
    await env.DB.prepare('UPDATE users SET totp_secret = ?, totp_last_step = 0 WHERE id = ?')
      .bind(await encryptSecret(secret, env), user.id).run();
  }

  const issuer = env.APP_NAME || 'Needtable';
  return json({
    email: user.email,
    name: user.name,
    kind: found.invite.kind,
    totpRequired: true,
    otpauth: otpauthUri({ issuer, email: user.email, secret }),
    kdf,
  });
}

/**
 * POST /api/auth/enroll/complete — body: { token, dk, code? }
 *
 * 一次性完成：存口令哈希、（开了动态码时）确认 TOTP 已绑定、激活账号、发会话 Cookie。
 * 要求先输一次动态码，是为了确认用户**真的**把二维码扫进去了 ——
 * 否则他下次登录就会被自己的第二因素锁在门外。
 * 没开动态码时顺手清掉库里的密钥：那是没被确认过的，留着的话，
 * 哪天管理员打开开关，这个人就会被一个他从没扫过的二维码挡在门外。
 * @param {Request} request @param {{ env: any, url: URL }} c
 */
export async function enrollComplete(request, c) {
  const { env, url } = c;
  const gate = consume('enroll:' + clientIp(request), { capacity: 20, refillPerSec: 0.1 });
  if (!gate.ok) return tooManyRequests(gate.retryAfter);

  const body = await readJson(request);
  const found = await lookupInvite(env, body?.token);
  if (!found) return notFound(t('链接无效或已过期，请联系管理员重新签发'));

  const dk = parseDk(body?.dk);
  if (!dk) return badRequest(t('口令派生数据格式不正确'));
  const { user, invite } = found;
  const needCode = await totpRequired(env);
  let step = 0;
  if (needCode) {
    const code = normalizeCode(body?.code);
    if (!code) return badRequest(t('请输入验证器上的 6 位动态码'));
    const secret = user.totp_secret ? await decryptSecret(user.totp_secret, env) : null;
    if (!secret) return badRequest(t('请先刷新页面重新获取二维码'));
    const totp = await verifyTotp(secret, code, { lastStep: 0 });
    if (!totp.ok) return badRequest(t('动态码不正确，请确认手机时间准确后重试'));
    step = totp.step;
  }

  const salt = newServerSalt();
  const hash = await hashLoginKey(dk, salt, env);
  const now = Date.now();
  // 重置口令时把 session_epoch +1：旧设备上的会话立刻失效。
  const epoch = Number(user.session_epoch ?? 1) + 1;

  await env.DB.batch([
    env.DB.prepare(
      `UPDATE users SET pw_hash = ?, pw_salt = ?, pw_version = ?, pw_updated_at = ?,
                        status = 'active', session_epoch = ?, totp_last_step = ?,
                        failed_count = 0, locked_until = 0, last_seen_at = ?, totp_secret = ?,
                        must_change_pw = 0
        WHERE id = ?`,
    ).bind(hash, salt, PW_VERSION, now, epoch, step, now, needCode ? user.totp_secret : null, user.id),

    // 令牌一次性。同一个链接不能用第二次。
    env.DB.prepare('UPDATE user_invites SET used_at = ? WHERE token_hash = ?')
      .bind(now, invite.token_hash),
  ]);

  return await issueSession(env, url, { id: user.id, email: user.email, session_epoch: epoch },
    { id: user.id, email: user.email, name: user.name, role: user.role });
}
