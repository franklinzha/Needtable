/**
 * WebSocket 用的短期签名 ticket。
 *
 * 为什么不让 WS 直接依赖 Access：Worker 级 Access 策略会把 WS upgrade 请求 403 掉。
 * 本项目用的是 hostname 型应用（table.example.com），Access 能正常代理 WS，
 * 但把实时层的鉴权建立在自己签的 ticket 上更稳 —— 以后换域名、调整 Access
 * 拓扑，实时功能都不会跟着塌。
 *
 * 流程：
 *   1. 客户端 POST /api/realtime/ticket（走 Access，已鉴权）
 *   2. 服务端校验该用户对目标表的权限，签一张 30 秒有效的 ticket
 *   3. 客户端用 ticket 连 WS，服务端验签后把身份绑定到该连接
 *
 * 防重放由 TableDO 在自己的 SQLite 里记 nonce 完成。不用 KV：免费额度只有
 * 1000 写/天，每次连接写一条会瞬间打满。
 */

import { bytesToB64url, b64urlToBytes, jsonToB64url, b64urlToJson } from '../../public/shared/util/b64.js';

const enc = new TextEncoder();
/** @type {Map<string, Promise<CryptoKey>>} */
const keyCache = new Map();

/** @param {string} secret @returns {Promise<CryptoKey>} */
function hmacKey(secret) {
  let p = keyCache.get(secret);
  if (!p) {
    p = crypto.subtle.importKey(
      'raw',
      enc.encode(secret),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign', 'verify'],
    );
    keyCache.set(secret, p);
  }
  return p;
}

/**
 * @typedef {object} TicketPayload
 * @property {string} uid
 * @property {string} email
 * @property {string} tableId
 * @property {string} role
 * @property {string} [name]   显示名（在线头像、选区名牌用）
 * @property {string | null} [scope]  可见视图，null = 全部
 * @property {number} exp
 * @property {string} nonce
 */

/**
 * @param {{ uid: string, email: string, tableId: string, role: string, name?: string, scope?: string | null, ttlSeconds?: number }} input
 * @param {string} secret
 * @returns {Promise<string>}
 */
export async function signTicket(input, secret) {
  const { ttlSeconds = 30, ...rest } = input;
  /** @type {TicketPayload} */
  const payload = {
    ...rest,
    exp: Math.floor(Date.now() / 1000) + ttlSeconds,
    nonce: bytesToB64url(crypto.getRandomValues(new Uint8Array(12))),
  };
  const body = jsonToB64url(payload);
  const sig = await crypto.subtle.sign('HMAC', await hmacKey(secret), enc.encode(body));
  return body + '.' + bytesToB64url(sig);
}

/**
 * @param {string} token
 * @param {string} secret
 * @returns {Promise<TicketPayload | null>}
 */
export async function verifyTicket(token, secret) {
  const dot = token.indexOf('.');
  if (dot <= 0 || dot === token.length - 1) return null;
  const body = token.slice(0, dot);
  const sig = token.slice(dot + 1);

  let ok = false;
  try {
    // subtle.verify 是恒定时间比较，不会通过耗时泄露签名内容
    ok = await crypto.subtle.verify('HMAC', await hmacKey(secret), b64urlToBytes(sig), enc.encode(body));
  } catch {
    return null;
  }
  if (!ok) return null;

  /** @type {any} */ let payload;
  try { payload = b64urlToJson(body); } catch { return null; }

  if (typeof payload?.exp !== 'number' || payload.exp * 1000 <= Date.now()) return null;
  if (typeof payload.uid !== 'string' || typeof payload.tableId !== 'string') return null;
  if (typeof payload.nonce !== 'string') return null;

  return /** @type {TicketPayload} */ (payload);
}
