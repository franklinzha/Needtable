/**
 * 登录密钥派生 —— 这套方案里最需要解释的一块。
 *
 * 问题：Workers 免费版每次请求只有 10ms CPU，而 workerd 又把 PBKDF2 的迭代数
 * 硬限制在 10 万次；OWASP 对 PBKDF2-HMAC-SHA256 的建议是 60 万次。
 * 服务端硬算不可能，而把迭代数调到能算得动的水平等于自欺欺人。
 *
 * 做法：把「慢」的那一半搬到浏览器，服务端只留「快」的那一半。
 *
 *   浏览器   dk = PBKDF2-SHA256(密码, 盐=SHA256("table|kdf|v1|"+邮箱), 600000 次)
 *      │                                                    ← 几百毫秒，浏览器不限 CPU
 *      │ TLS
 *      ▼
 *   Worker   存 HMAC-SHA256(pepper, 每用户随机盐 ‖ dk)      ← 一次 HMAC，微秒级
 *
 * 换来的性质：
 *   · 服务端从不接触明文密码
 *   · pepper 是 wrangler secret，不在 D1 里 —— 数据库单独泄露无法离线爆破
 *   · 即使 pepper 与库一起泄露，攻击者每猜一个密码仍要付 60 万次 PBKDF2 的代价
 *
 * 要诚实说明的代价：dk 在链路上等价于密码，安全性依赖 TLS —— 这一点和直接
 * 提交密码相同，没有变好也没有变坏。它换来的是「服务端与数据库都不保存
 * 可离线快速爆破的凭据」。
 *
 * 盐用邮箱**确定性**派生，而不是向服务端问一次：问一次就等于送了一个
 * 「这个邮箱在不在」的探测接口。
 */

import { t } from '../i18n/i18n.js';

export const KDF = Object.freeze({
  version: 1,
  hash: 'SHA-256',
  iterations: 600_000,   // OWASP 2026 对 PBKDF2-HMAC-SHA256 的建议值
  dkBytes: 32,
});

const enc = new TextEncoder();

/** 邮箱规范化。大小写与首尾空格不该影响能不能登录。 @param {string} email */
export const normalizeEmail = (email) => String(email).trim().toLowerCase();

/**
 * 客户端盐：确定性地由邮箱派生。
 * 加 version 前缀是为了将来能整体轮换而不撞上旧盐。
 * @param {string} email @returns {Promise<ArrayBuffer>}
 */
export function clientSalt(email) {
  return crypto.subtle.digest('SHA-256', enc.encode(`table|kdf|v${KDF.version}|${normalizeEmail(email)}`));
}

/**
 * 算出要提交给服务端的登录密钥。这是浏览器上唯一耗时的一步。
 * @param {string} password
 * @param {string} email
 * @param {number} [iterations] 仅测试时调低；线上一律用 KDF.iterations
 * @returns {Promise<Uint8Array>} 32 字节
 */
export async function deriveLoginKey(password, email, iterations = KDF.iterations) {
  const key = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: KDF.hash, salt: await clientSalt(email), iterations },
    key,
    KDF.dkBytes * 8,
  );
  return new Uint8Array(bits);
}

/**
 * 密码强度下限。不玩「必须含大写+数字+符号」那一套（它逼出的是 Passw0rd!），
 * 只卡长度与明显的弱口令 —— 长度才是真正起作用的那一维。
 * @param {string} password @param {string} [email]
 * @returns {string | null} 不合格时返回一句人话，合格返回 null
 */
export function checkPasswordStrength(password, email = '') {
  const pw = String(password);
  if (pw.length < 12) return t('密码至少 12 位（长度比复杂度管用得多）');
  if (pw.length > 256) return t('密码不能超过 256 位');
  if (/^(.)\1+$/.test(pw)) return t('不能是同一个字符重复');
  const local = normalizeEmail(email).split('@')[0];
  if (local && local.length >= 3 && pw.toLowerCase().includes(local)) return t('密码里不能包含你的邮箱名');
  const weak = ['password', '123456789012', 'qwertyuiop', 'administrator', 'letmeinplease'];
  if (weak.some((w) => pw.toLowerCase().includes(w))) return t('这个密码在常见弱口令表里，换一个');
  return null;
}
