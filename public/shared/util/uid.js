/**
 * 短 ID 生成。时间戳前缀 + 随机后缀，因此按字典序排列即近似按创建时间排列，
 * 调试时一眼能看出先后。浏览器与 Worker 共用同一实现，避免两端 ID 格式不一致。
 */

const ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyz';

/** @param {number} n @param {number} len */
function encodeBase36(n, len) {
  let out = '';
  for (let i = 0; i < len; i++) {
    out = ALPHABET[n % 36] + out;
    n = Math.floor(n / 36);
  }
  return out;
}

/**
 * 生成一个 17 字符的 ID：8 位时间戳（base36，够用到 5138 年）+ 9 位随机。
 * @param {string} [prefix] 可选的类型前缀，如 'tbl' / 'fld' / 'row'
 * @returns {string}
 */
export function uid(prefix) {
  const ts = encodeBase36(Date.now(), 8);
  const rand = new Uint8Array(9);
  crypto.getRandomValues(rand);
  let tail = '';
  for (const b of rand) tail += ALPHABET[b % 36];
  const id = ts + tail.slice(0, 12);
  return prefix ? `${prefix}_${id}` : id;
}

export const newWorkspaceId = () => uid('ws');
export const newBaseId = () => uid('bas');
export const newTableId = () => uid('tbl');
export const newFieldId = () => uid('fld');
export const newRowId = () => uid('row');
export const newViewId = () => uid('viw');
export const newUserId = () => uid('usr');
