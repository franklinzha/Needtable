/**
 * 会话 Cookie。
 *
 * 刻意**没有** sessions 表。原因是额度：D1 免费套餐 100K 行写/天，而每次登录、
 * 每次滑动续期都写一行的话，这笔开销完全是白花的 —— 签名 Cookie 本身就是
 * 自校验的，服务端不需要记住它。
 *
 * 那怎么吊销？用户行上有个 session_epoch 计数器：禁用账号、重置口令、
 * 「登出所有设备」都只是把它 +1，所有旧 Cookie 立刻失效。一次 UPDATE 顶一张表。
 *
 * Cookie 属性逐条都有理由：
 *   __Host- 前缀  浏览器强制要求 Secure + Path=/ + 无 Domain，子域写不进来
 *   HttpOnly     XSS 拿不到会话（CSP 已经很紧了，但不该只靠一层）
 *   SameSite=Strict  跨站请求一律不带 Cookie，等于免疫 CSRF
 *   Secure       只走 https；本地 http 调试时降级（见 cookieName）
 */

import { bytesToB64url, b64urlToBytes, jsonToB64url, b64urlToJson } from '../../public/shared/util/b64.js';

/** 绝对有效期。到点必须重新输口令 + 动态码。 */
export const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
/** 距上次签发超过这么久就顺手换一张新的，避免用户干到一半被踢。 */
export const SESSION_RENEW_AFTER_MS = 60 * 60 * 1000;

const enc = new TextEncoder();

/** @type {Map<string, Promise<CryptoKey>>} */
const keyCache = new Map();

/** @param {any} env @returns {Promise<CryptoKey>} */
function sessionKey(env) {
  const secret = env.SESSION_SECRET;
  if (!secret) throw new Error('SESSION_SECRET 未配置');
  let p = keyCache.get(secret);
  if (!p) {
    p = crypto.subtle.importKey(
      'raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify'],
    );
    keyCache.set(secret, p);
  }
  return p;
}

/**
 * https 下用 __Host- 前缀；本地 http 调试用不了（前缀强制要求 Secure）。
 * @param {URL} url
 */
export const cookieName = (url) =>
  url.protocol === 'https:' ? '__Host-tbl_sess' : 'tbl_sess';

/**
 * @typedef {object} SessionPayload
 * @property {string} uid
 * @property {string} email
 * @property {number} epoch
 * @property {number} iat 毫秒
 * @property {number} exp 毫秒
 */

/**
 * @param {{ id: string, email: string, session_epoch?: number }} user
 * @param {any} env @param {number} [nowMs]
 * @returns {Promise<string>}
 */
export async function signSession(user, env, nowMs = Date.now()) {
  /** @type {SessionPayload} */
  const payload = {
    uid: user.id,
    email: user.email,
    epoch: Number(user.session_epoch ?? 1),
    iat: nowMs,
    exp: nowMs + SESSION_TTL_MS,
  };
  const body = jsonToB64url(payload);
  const sig = await crypto.subtle.sign('HMAC', await sessionKey(env), enc.encode(body));
  return body + '.' + bytesToB64url(sig);
}

/**
 * 验签 + 查有效期。**不**查 session_epoch —— 那要读用户行，放在 rbac 里做。
 * @param {string} token @param {any} env @param {number} [nowMs]
 * @returns {Promise<SessionPayload | null>}
 */
export async function verifySession(token, env, nowMs = Date.now()) {
  const dot = token.indexOf('.');
  if (dot <= 0 || dot === token.length - 1) return null;
  const body = token.slice(0, dot);

  let ok = false;
  try {
    ok = await crypto.subtle.verify(
      'HMAC', await sessionKey(env), b64urlToBytes(token.slice(dot + 1)), enc.encode(body),
    );
  } catch { return null; }
  if (!ok) return null;

  /** @type {any} */ let payload;
  try { payload = b64urlToJson(body); } catch { return null; }

  if (typeof payload?.uid !== 'string' || typeof payload.email !== 'string') return null;
  if (typeof payload.exp !== 'number' || payload.exp <= nowMs) return null;
  if (typeof payload.epoch !== 'number' || typeof payload.iat !== 'number') return null;

  return /** @type {SessionPayload} */ (payload);
}

/** 从请求头里取出会话 Cookie 的值。 @param {Request} request @param {URL} url */
export function readSessionCookie(request, url) {
  const header = request.headers.get('cookie');
  if (!header) return null;
  const want = cookieName(url);
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() === want) return part.slice(eq + 1).trim();
  }
  return null;
}

/** @param {string} token @param {URL} url @returns {string} */
export function sessionCookieHeader(token, url) {
  const attrs = [
    cookieName(url) + '=' + token,
    'Path=/',
    'HttpOnly',
    'SameSite=Strict',
    'Max-Age=' + Math.floor(SESSION_TTL_MS / 1000),
  ];
  if (url.protocol === 'https:') attrs.push('Secure');
  return attrs.join('; ');
}

/** 登出：把 Cookie 立刻过期。 @param {URL} url */
export function clearCookieHeader(url) {
  const attrs = [cookieName(url) + '=', 'Path=/', 'HttpOnly', 'SameSite=Strict', 'Max-Age=0'];
  if (url.protocol === 'https:') attrs.push('Secure');
  return attrs.join('; ');
}

/** @param {Response} response @param {string} cookie @returns {Response} */
export function withCookie(response, cookie) {
  const headers = new Headers(response.headers);
  headers.append('set-cookie', cookie);
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}
