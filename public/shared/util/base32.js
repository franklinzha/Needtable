/**
 * RFC 4648 Base32（大写字母 + 2-7，不带 padding）。
 *
 * 只为 TOTP 而存在：authenticator 应用交换密钥用的就是这个编码，
 * 「手动输入设置密钥」那一栏里粘的也是它。浏览器、Worker、管理 CLI 三边共用。
 */

import { t } from '../i18n/i18n.js';

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

/** @param {Uint8Array} bytes @returns {string} */
export function bytesToBase32(bytes) {
  let out = '';
  let bits = 0;
  let value = 0;
  for (const b of bytes) {
    value = (value << 8) | b;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

/**
 * 宽容解码：忽略空格、连字符与 padding，小写自动转大写 —— 用户从手机上
 * 抄密钥时这几样都可能混进来。出现字母表以外的字符才报错。
 * @param {string} s @returns {Uint8Array}
 */
export function base32ToBytes(s) {
  const clean = s.replace(/[\s-]/g, '').replace(/=+$/, '').toUpperCase();
  const out = [];
  let bits = 0;
  let value = 0;
  for (const ch of clean) {
    const idx = ALPHABET.indexOf(ch);
    if (idx < 0) throw new Error(t('不是合法的 Base32 字符：{ch}', { ch }));
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return new Uint8Array(out);
}
