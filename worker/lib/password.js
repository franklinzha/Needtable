/**
 * 口令校验的服务端一半。
 *
 * ── 为什么要把 KDF 拆成两半 ───────────────────────────────────────────────
 * OWASP 对 PBKDF2-HMAC-SHA256 的建议是 600,000 次迭代。而 Workers 免费套餐
 * 每次调用只有 10ms CPU，workerd 又把 PBKDF2 的迭代数上限硬编在 100,000
 * （cloudflare/workerd#1346）。两个数字凑不到一起，而「为了塞进 CPU 额度
 * 就把口令哈希调弱」是绝对不能做的妥协。
 *
 * 所以迭代放到浏览器里做：
 *
 *   浏览器：dk = PBKDF2-SHA256(password, salt=SHA256("table|kdf|v1|"+email), 600k)
 *   服务端：stored = HMAC-SHA256(AUTH_PEPPER, serverSalt ‖ dk)      ← 几微秒
 *
 * 这么拆之后：
 *   · 服务端从头到尾看不到明文口令
 *   · 只泄露数据库 → 打不开，因为 pepper 是 wrangler secret，不在库里
 *   · pepper 和数据库一起泄露 → 每猜一次仍要付 600k 次迭代的代价
 *
 * 唯一诚实要讲清楚的代价：dk 在网线上等价于口令（拿到 dk 就能登录），
 * 安全性依赖 TLS。这一点和「直接把明文口令 POST 上去」是同一个量级的假设，
 * 而我们额外换来了服务端永不接触明文。
 *
 * 客户端那一半在 public/shared/util/kdf.js，两边的 KDF 版本号必须对齐。
 */

import { bytesToB64url, b64urlToBytes } from '../../public/shared/util/b64.js';

/** 与 public/shared/util/kdf.js 的 KDF.version 对应。换算法时 +1 并做灰度迁移。 */
export const PW_VERSION = 1;

const SALT_BYTES = 16;
const enc = new TextEncoder();

/** @type {Map<string, Promise<CryptoKey>>} */
const pepperCache = new Map();

/** @param {any} env @returns {Promise<CryptoKey>} */
function pepperKey(env) {
  const secret = env.AUTH_PEPPER;
  if (!secret) throw new Error('AUTH_PEPPER 未配置');
  let p = pepperCache.get(secret);
  if (!p) {
    p = crypto.subtle.importKey(
      'raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify'],
    );
    pepperCache.set(secret, p);
  }
  return p;
}

/** 新用户的服务端盐。即使两个人的口令与邮箱都一样，入库的哈希也不同。 */
export function newServerSalt() {
  return bytesToB64url(crypto.getRandomValues(new Uint8Array(SALT_BYTES)));
}

/** @param {string} saltB64 @param {Uint8Array} dk */
function message(saltB64, dk) {
  const salt = b64urlToBytes(saltB64);
  const out = new Uint8Array(salt.length + dk.length);
  out.set(salt, 0);
  out.set(dk, salt.length);
  return out;
}

/**
 * 算出入库的哈希。
 * @param {Uint8Array} dk 浏览器算出的派生密钥（32 字节）
 * @param {string} saltB64 @param {any} env
 * @returns {Promise<string>} base64url
 */
export async function hashLoginKey(dk, saltB64, env) {
  const sig = await crypto.subtle.sign('HMAC', await pepperKey(env), message(saltB64, dk));
  return bytesToB64url(sig);
}

/**
 * 恒定时间校验。用 subtle.verify 而不是自己比字符串 —— 后者会通过耗时泄露
 * 前缀匹配了多少位。
 * @param {Uint8Array} dk @param {string} saltB64 @param {string} hashB64 @param {any} env
 * @returns {Promise<boolean>}
 */
export async function verifyLoginKey(dk, saltB64, hashB64, env) {
  try {
    return await crypto.subtle.verify(
      'HMAC', await pepperKey(env), b64urlToBytes(hashB64), message(saltB64, dk),
    );
  } catch {
    return false;                       // 哈希字段损坏等同于校验失败，不是 500
  }
}

/**
 * 账号不存在时也走一遍同样的计算。
 * 否则「查无此人」会比「口令错误」快一截，等于送给攻击者一个邮箱枚举探针。
 * @param {any} env
 */
export async function dummyVerify(env) {
  const dk = new Uint8Array(32);
  await hashLoginKey(dk, 'AAAAAAAAAAAAAAAAAAAAAA', env);
  return false;
}

/**
 * 解析客户端送上来的 dk。长度必须精确匹配，不接受任何奇怪的输入。
 * @param {unknown} value @returns {Uint8Array | null}
 */
export function parseDk(value) {
  if (typeof value !== 'string' || value.length > 64) return null;
  /** @type {Uint8Array} */ let bytes;
  try { bytes = b64urlToBytes(value); } catch { return null; }
  return bytes.length === 32 ? bytes : null;
}
