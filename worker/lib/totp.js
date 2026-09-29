/**
 * TOTP（RFC 6238）—— 第二因素。
 *
 * 选它的理由很实际：纯本地算法，不需要短信通道、不需要邮件服务、不产生费用，
 * 用户那边就是 Google / Microsoft Authenticator 里多一行。在「没有信用卡、
 * 不能开 Zero Trust」这个前提下，这是唯一不花钱又真能挡住撞库的第二因素。
 *
 * 参数取业界默认值（SHA-1 / 6 位 / 30 秒），因为所有验证器 App 都认这一组。
 * SHA-1 在这里不是弱点：HOTP 用的是 HMAC-SHA1，它的安全性不依赖 SHA-1 的
 * 抗碰撞性，而 RFC 6238 至今仍以它为默认。
 *
 * 两个容易被忽略的点，这里都做了：
 *   · ±1 个时间窗容错（时钟漂移），但**用过的窗口会被记下来**（totp_last_step），
 *     否则同一个码在 30 秒内能重复用，等于给了肩窥者一个可复用的凭据。
 *   · 密钥在库里是 AES-GCM 加密的，密钥材料来自 AUTH_PEPPER。只泄露 D1
 *     的话，拿到的是一堆密文。
 */

import { bytesToBase32, base32ToBytes } from '../../public/shared/util/base32.js';
import { bytesToB64url, b64urlToBytes } from '../../public/shared/util/b64.js';

export const TOTP = Object.freeze({
  digits: 6,
  stepSeconds: 30,
  algorithm: 'SHA-1',
  window: 1,          // 前后各容忍一个 30 秒窗口
  secretBytes: 20,    // RFC 4226 建议的 160 位
});

const enc = new TextEncoder();

/** 新密钥。 @returns {Uint8Array} */
export function newTotpSecret() {
  return crypto.getRandomValues(new Uint8Array(TOTP.secretBytes));
}

/** @param {Uint8Array} secret */
export const secretToBase32 = (secret) => bytesToBase32(secret);

/**
 * 生成验证器 App 扫的 URI。
 * label 里带上 issuer 前缀是 Google Authenticator 的老约定，缺了它某些 App
 * 会把账号显示成光秃秃的邮箱，用户装了两个系统就分不清哪个是哪个。
 * @param {{ issuer: string, email: string, secret: Uint8Array }} input
 */
export function otpauthUri({ issuer, email, secret }) {
  const label = encodeURIComponent(issuer) + ':' + encodeURIComponent(email);
  const params = new URLSearchParams({
    secret: bytesToBase32(secret),
    issuer,
    algorithm: 'SHA1',
    digits: String(TOTP.digits),
    period: String(TOTP.stepSeconds),
  });
  return 'otpauth://totp/' + label + '?' + params.toString();
}

/** 当前时间落在第几个 30 秒窗口。 @param {number} [nowMs] */
export const currentStep = (nowMs = Date.now()) =>
  Math.floor(nowMs / 1000 / TOTP.stepSeconds);

/**
 * 算出某个时间窗的 6 位码。
 * @param {Uint8Array} secret @param {number} step @returns {Promise<string>}
 */
export async function totpCode(secret, step) {
  const counter = new Uint8Array(8);
  // 8 字节大端计数器。step 会超过 32 位整数范围，所以用 BigInt 而不是位运算。
  let v = BigInt(step);
  for (let i = 7; i >= 0; i--) { counter[i] = Number(v & 0xffn); v >>= 8n; }

  const key = await crypto.subtle.importKey(
    'raw', secret, { name: 'HMAC', hash: 'SHA-1' }, false, ['sign'],
  );
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, counter));

  // RFC 4226 §5.4 动态截断
  const offset = mac[mac.length - 1] & 0x0f;
  const bin = ((mac[offset] & 0x7f) << 24)
            | (mac[offset + 1] << 16)
            | (mac[offset + 2] << 8)
            | mac[offset + 3];
  return String(bin % 10 ** TOTP.digits).padStart(TOTP.digits, '0');
}

/** 6 位数字，允许用户从 App 里连空格一起粘过来。 @param {unknown} input */
export function normalizeCode(input) {
  const s = String(input ?? '').replace(/[\s-]/g, '');
  return /^[0-9]{6}$/.test(s) ? s : null;
}

/**
 * 校验一个码。
 * @param {Uint8Array} secret @param {string} code
 * @param {{ nowMs?: number, lastStep?: number }} [opts]
 * @returns {Promise<{ ok: true, step: number } | { ok: false, reason: 'format'|'mismatch'|'replay' }>}
 */
export async function verifyTotp(secret, code, opts = {}) {
  const normalized = normalizeCode(code);
  if (!normalized) return { ok: false, reason: 'format' };

  const now = currentStep(opts.nowMs ?? Date.now());
  const lastStep = Number(opts.lastStep ?? 0);

  // 恒定工作量：窗口内每个 step 都算一遍，不提前 return，
  // 否则「码对了但是在第几个窗口」会从耗时里漏出去。
  let hit = -1;
  for (let d = -TOTP.window; d <= TOTP.window; d++) {
    const step = now + d;
    const expected = await totpCode(secret, step);
    let same = expected.length === normalized.length;
    let diff = 0;
    for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ normalized.charCodeAt(i);
    if (same && diff === 0) hit = step;
  }

  if (hit < 0) return { ok: false, reason: 'mismatch' };
  // 同一个（或更早的）窗口只认一次：30 秒内重放同一个码不放行
  if (hit <= lastStep) return { ok: false, reason: 'replay' };
  return { ok: true, step: hit };
}

// ── 密钥在库里的加密存放 ────────────────────────────────────────────────────

/** @type {Map<string, Promise<CryptoKey>>} */
const aesCache = new Map();

/** @param {any} env @returns {Promise<CryptoKey>} */
async function aesKey(env) {
  const pepper = env.AUTH_PEPPER;
  if (!pepper) throw new Error('AUTH_PEPPER 未配置');
  let p = aesCache.get(pepper);
  if (!p) {
    // 与口令哈希用的是同一个 pepper，但经过不同的域分隔串派生，
    // 两处的密钥材料不会互相串用。
    p = crypto.subtle.digest('SHA-256', enc.encode('table|totp-key|v1|' + pepper))
      .then((bits) => crypto.subtle.importKey('raw', bits, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']));
    aesCache.set(pepper, p);
  }
  return p;
}

/**
 * @param {Uint8Array} secret @param {any} env @returns {Promise<string>} base64url(iv ‖ 密文)
 */
export async function encryptSecret(secret, env) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(
    await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await aesKey(env), secret),
  );
  const out = new Uint8Array(iv.length + ct.length);
  out.set(iv, 0);
  out.set(ct, iv.length);
  return bytesToB64url(out);
}

/**
 * @param {string} stored @param {any} env @returns {Promise<Uint8Array | null>}
 */
export async function decryptSecret(stored, env) {
  try {
    const raw = b64urlToBytes(stored);
    if (raw.length <= 12) return null;
    const plain = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: raw.subarray(0, 12) }, await aesKey(env), raw.subarray(12),
    );
    return new Uint8Array(plain);
  } catch {
    return null;                        // 换过 pepper / 数据损坏 —— 当作没有密钥
  }
}

/** 测试用。 */
export function resetTotpKeyCache() { aesCache.clear(); }

export { base32ToBytes };
