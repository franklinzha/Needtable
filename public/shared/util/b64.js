/** base64url 编解码。浏览器与 Worker 共用（JWT、ticket、二进制传输都要用）。 */

const enc = new TextEncoder();
const dec = new TextDecoder();

/** @param {string} s @returns {Uint8Array} */
export function b64urlToBytes(s) {
  const pad = s.length % 4 === 0 ? '' : '='.repeat(4 - (s.length % 4));
  const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/') + pad);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** @param {ArrayBuffer | Uint8Array} buf @returns {string} */
export function bytesToB64url(buf) {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** @param {string} s @returns {string} */
export const b64urlToText = (s) => dec.decode(b64urlToBytes(s));

/** @param {string} s @returns {string} */
export const textToB64url = (s) => bytesToB64url(enc.encode(s));

/** @param {unknown} v @returns {string} */
export const jsonToB64url = (v) => textToB64url(JSON.stringify(v));

/** @param {string} s @returns {any} */
export const b64urlToJson = (s) => JSON.parse(b64urlToText(s));
