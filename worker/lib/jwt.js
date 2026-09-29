/**
 * Cloudflare Access JWT 校验。
 *
 * 只认 `Cf-Access-Jwt-Assertion` 请求头，不认 `CF_Authorization` cookie ——
 * Cloudflare 文档明确说 cookie 不保证透传到源站，而这个请求头保证有。
 *
 * 校验项一个都不能省：签名、alg、iss、aud、exp、nbf、iat。
 * 其中 aud 尤其关键：少了它，同一个 Zero Trust 团队下**任何**一个 Access 应用
 * 签出的 token 都能进本站。
 */

import { getSigningKey } from './jwks.js';
import { b64urlToBytes, b64urlToJson } from '../../public/shared/util/b64.js';

const enc = new TextEncoder();
/** 允许的时钟偏移（秒） */
const SKEW = 60;

/**
 * @typedef {object} AccessClaims
 * @property {string} email
 * @property {string} sub
 * @property {string[] | string} aud
 * @property {string} iss
 * @property {number} exp
 * @property {number} [iat]
 * @property {string} [name]
 * @property {string} [common_name]
 */

/**
 * @param {string} token
 * @param {any} env
 * @returns {Promise<AccessClaims | null>} 校验通过返回 claims；任何一步失败都返回 null
 */
export async function verifyAccessJwt(token, env) {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [rawHeader, rawPayload, rawSig] = parts;

  /** @type {any} */ let header;
  /** @type {any} */ let payload;
  try {
    header = b64urlToJson(rawHeader);
    payload = b64urlToJson(rawPayload);
  } catch {
    return null;
  }

  // 只接受 RS256。放行 alg 为 none 或 HS256 会让攻击者拿公钥当 HMAC 密钥自签 token。
  if (header?.alg !== 'RS256' || typeof header.kid !== 'string') return null;

  const key = await getSigningKey(header.kid, env);
  if (!key) return null;

  const valid = await crypto.subtle.verify(
    'RSASSA-PKCS1-v1_5',
    key,
    b64urlToBytes(rawSig),
    enc.encode(rawHeader + '.' + rawPayload),
  );
  if (!valid) return null;

  const now = Math.floor(Date.now() / 1000);
  if (typeof payload?.exp !== 'number' || payload.exp + SKEW <= now) return null;
  if (typeof payload.nbf === 'number' && payload.nbf - SKEW > now) return null;
  if (typeof payload.iat === 'number' && payload.iat - SKEW > now) return null;

  if (payload.iss !== 'https://' + env.ACCESS_TEAM_DOMAIN) return null;

  const aud = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  if (!aud.includes(env.ACCESS_AUD)) return null;

  // 人类用户走 email；service token 走 common_name，本项目不接受后者访问 UI。
  if (typeof payload.email !== 'string' || payload.email.length === 0) return null;

  return /** @type {AccessClaims} */ (payload);
}
