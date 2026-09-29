/**
 * 极简 QR 码编码器（字节模式 · 纠错等级 M · 版本 1–10）。
 *
 * 为什么要自己写：CSP 里没有任何外域，也没有构建步骤，所以不能从 CDN 拉
 * qrcode.js。而绑定 TOTP 时让用户扫一下二维码，比让他手抄 32 位密钥现实得多。
 * 版本 1–10 在等级 M 下最多装 213 字节，otpauth:// URI 通常 140 字节上下，够用。
 *
 * 实现按 ISO/IEC 18004 来。正确性不靠「看着像」：qr.test.mjs 会把生成的矩阵
 * 反着读回来（去掩码 → 逆之字形取位 → 解交织），断言还原出原文，
 * 并用 RS 校验子恒为 0 来独立验证纠错码。
 */

// ── GF(256) ─────────────────────────────────────────────────────────────────
import { t } from '../i18n/i18n.js';

// 本原多项式 0x11D（x^8 + x^4 + x^3 + x^2 + 1），QR 规定的那一个。
const EXP = new Uint8Array(512);
const LOG = new Uint8Array(256);
{
  let x = 1;
  for (let i = 0; i < 255; i++) {
    EXP[i] = x;
    LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;
  }
  for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
}

/** @param {number} a @param {number} b */
export function gfMul(a, b) {
  if (a === 0 || b === 0) return 0;
  return EXP[LOG[a] + LOG[b]];
}

/** 生成多项式 g(x) = ∏ (x - α^i)，i = 0..degree-1。 @param {number} degree */
function rsGenerator(degree) {
  let poly = new Uint8Array([1]);
  for (let i = 0; i < degree; i++) {
    const next = new Uint8Array(poly.length + 1);
    for (let j = 0; j < poly.length; j++) {
      next[j] ^= poly[j];
      next[j + 1] ^= gfMul(poly[j], EXP[i]);
    }
    poly = next;
  }
  return poly;
}

/**
 * 算出 data 的 ecLen 个纠错码字。
 * @param {Uint8Array} data @param {number} ecLen @returns {Uint8Array}
 */
export function rsEncode(data, ecLen) {
  const gen = rsGenerator(ecLen);
  const rem = new Uint8Array(ecLen);
  for (const byte of data) {
    const factor = byte ^ rem[0];
    rem.copyWithin(0, 1);
    rem[ecLen - 1] = 0;
    for (let i = 0; i < ecLen; i++) rem[i] ^= gfMul(gen[i + 1], factor);
  }
  return rem;
}

// ── 版本表（只列纠错等级 M）─────────────────────────────────────────────────
// [每块纠错码字, 组1块数, 组1数据码字, 组2块数, 组2数据码字]
const RS_BLOCKS_M = [
  null,
  [10, 1, 16, 0, 0],   // v1
  [16, 1, 28, 0, 0],   // v2
  [26, 1, 44, 0, 0],   // v3
  [18, 2, 32, 0, 0],   // v4
  [24, 2, 43, 0, 0],   // v5
  [16, 4, 27, 0, 0],   // v6
  [18, 4, 31, 0, 0],   // v7
  [22, 2, 38, 2, 39],  // v8
  [22, 3, 36, 2, 37],  // v9
  [26, 4, 43, 1, 44],  // v10
];

/** 对齐图案中心坐标。v1 没有。 */
const ALIGN_CENTERS = [
  null, [], [6, 18], [6, 22], [6, 26], [6, 30], [6, 34],
  [6, 22, 38], [6, 24, 42], [6, 26, 46], [6, 28, 50],
];

const MAX_VERSION = 10;

/** 该版本总共能装多少数据码字。 @param {number} version */
function dataCodewords(version) {
  const [, g1, d1, g2, d2] = RS_BLOCKS_M[version];
  return g1 * d1 + g2 * d2;
}

/** 字节模式下字符计数指示符的位宽：版本 1–9 是 8 位，10 起是 16 位。 */
const countBits = (version) => (version < 10 ? 8 : 16);

/** 该版本字节模式最多能装多少字节。 @param {number} version */
export function byteCapacity(version) {
  return Math.floor((dataCodewords(version) * 8 - 4 - countBits(version)) / 8);
}

// ── BCH（格式信息 / 版本信息）──────────────────────────────────────────────

/** @param {number} n */
function bitLength(n) {
  let len = 0;
  while (n !== 0) { len++; n >>>= 1; }
  return len;
}

/** @param {number} value @param {number} poly @param {number} polyBits */
function bchRemainder(value, poly, polyBits) {
  let v = value;
  while (bitLength(v) >= polyBits) v ^= poly << (bitLength(v) - polyBits);
  return v;
}

/** 15 位格式信息。等级 M 的 2 位指示符是 00，所以 data 就等于掩码号。 @param {number} mask */
function formatBits(mask) {
  const data = mask;                                  // (M = 0b00) << 3 | mask
  return ((data << 10) | bchRemainder(data << 10, 0x537, 11)) ^ 0x5412;
}

/** 18 位版本信息，仅版本 ≥ 7 需要。 @param {number} version */
function versionBits(version) {
  return (version << 12) | bchRemainder(version << 12, 0x1f25, 13);
}

// ── 掩码 ────────────────────────────────────────────────────────────────────
const MASKS = [
  (i, j) => (i + j) % 2 === 0,
  (i, j) => i % 2 === 0,
  (i, j) => j % 3 === 0,
  (i, j) => (i + j) % 3 === 0,
  (i, j) => (Math.floor(i / 2) + Math.floor(j / 3)) % 2 === 0,
  (i, j) => ((i * j) % 2) + ((i * j) % 3) === 0,
  (i, j) => ((((i * j) % 2) + ((i * j) % 3)) % 2) === 0,
  (i, j) => ((((i + j) % 2) + ((i * j) % 3)) % 2) === 0,
];

// ── 组装 ────────────────────────────────────────────────────────────────────

/**
 * 把数据码字按块切分、逐块算纠错码、再按 QR 规定的顺序交织回一条序列。
 * @param {Uint8Array} data @param {number} version @returns {Uint8Array}
 */
export function interleave(data, version) {
  const [ecLen, g1, d1, g2, d2] = RS_BLOCKS_M[version];
  /** @type {Uint8Array[]} */ const dataBlocks = [];
  /** @type {Uint8Array[]} */ const ecBlocks = [];

  let offset = 0;
  for (const [count, size] of [[g1, d1], [g2, d2]]) {
    for (let b = 0; b < count; b++) {
      const block = data.subarray(offset, offset + size);
      offset += size;
      dataBlocks.push(block);
      ecBlocks.push(rsEncode(block, ecLen));
    }
  }

  const out = [];
  const maxData = Math.max(d1, d2);
  for (let i = 0; i < maxData; i++) {
    for (const block of dataBlocks) if (i < block.length) out.push(block[i]);
  }
  for (let i = 0; i < ecLen; i++) {
    for (const block of ecBlocks) out.push(block[i]);
  }
  return new Uint8Array(out);
}

/**
 * 把文本编成数据码字（含模式头、长度、终止符与填充）。
 * @param {string} text @returns {{ version: number, codewords: Uint8Array }}
 */
export function encodeData(text) {
  const bytes = new TextEncoder().encode(text);

  let version = 0;
  for (let v = 1; v <= MAX_VERSION; v++) {
    if (bytes.length <= byteCapacity(v)) { version = v; break; }
  }
  if (!version) {
    throw new Error(t('内容 {bytes} 字节，超过版本 {version} 在等级 M 下的 {max} 字节上限', { bytes: bytes.length, version: MAX_VERSION, max: byteCapacity(MAX_VERSION) }));
  }

  /** @type {number[]} */ const bits = [];
  const push = (value, width) => {
    for (let i = width - 1; i >= 0; i--) bits.push((value >>> i) & 1);
  };

  push(0b0100, 4);                       // 字节模式
  push(bytes.length, countBits(version));
  for (const b of bytes) push(b, 8);

  const capacityBits = dataCodewords(version) * 8;
  for (let i = 0; i < 4 && bits.length < capacityBits; i++) bits.push(0);   // 终止符
  while (bits.length % 8 !== 0) bits.push(0);                               // 补齐到字节

  const codewords = new Uint8Array(dataCodewords(version));
  for (let i = 0; i < bits.length; i += 8) {
    let byte = 0;
    for (let j = 0; j < 8; j++) byte = (byte << 1) | bits[i + j];
    codewords[i / 8] = byte;
  }
  // 规范指定的两个填充字节，交替出现
  for (let i = bits.length / 8, alt = 0; i < codewords.length; i++, alt++) {
    codewords[i] = alt % 2 === 0 ? 0xec : 0x11;
  }

  return { version, codewords };
}

/**
 * 铺功能图案（定位、分隔、定时、对齐），并把格式/版本信息区占位。
 * 返回的矩阵里 null 表示「这一格还能放数据」。
 * @param {number} version @returns {(boolean|null)[][]}
 */
function buildFunctionPatterns(version) {
  const size = version * 4 + 17;
  /** @type {(boolean|null)[][]} */
  const m = Array.from({ length: size }, () => new Array(size).fill(null));

  // 定位图案 + 分隔符（7×7 外加一圈留白）
  for (const [top, left] of [[0, 0], [0, size - 7], [size - 7, 0]]) {
    for (let r = -1; r <= 7; r++) {
      for (let c = -1; c <= 7; c++) {
        const y = top + r; const x = left + c;
        if (y < 0 || y >= size || x < 0 || x >= size) continue;
        const inner = r >= 0 && r <= 6 && c >= 0 && c <= 6;
        m[y][x] = inner && (r === 0 || r === 6 || c === 0 || c === 6
                            || (r >= 2 && r <= 4 && c >= 2 && c <= 4));
      }
    }
  }

  // 定时图案
  for (let i = 8; i < size - 8; i++) {
    const on = i % 2 === 0;
    if (m[6][i] === null) m[6][i] = on;
    if (m[i][6] === null) m[i][6] = on;
  }

  // 对齐图案。只跳过与三个定位图案重叠的那三个角落组合 —— 注意不能写成
  // 「该格已被占用就跳过」：中心落在定时图案上的对齐图案是要照画的，
  // 它会覆盖掉定时图案的 5 格，这是规范要求的行为。v7 起才会出现这种情况。
  const centers = ALIGN_CENTERS[version];
  const last = centers.length - 1;
  for (let a = 0; a < centers.length; a++) {
    for (let b = 0; b < centers.length; b++) {
      if ((a === 0 && b === 0) || (a === 0 && b === last) || (a === last && b === 0)) continue;
      const cy = centers[a]; const cx = centers[b];
      for (let r = -2; r <= 2; r++) {
        for (let c = -2; c <= 2; c++) {
          m[cy + r][cx + c] = Math.max(Math.abs(r), Math.abs(c)) !== 1;
        }
      }
    }
  }

  // 格式信息区先占位（值稍后写），否则会被数据占掉
  for (let i = 0; i < 9; i++) {
    if (m[i][8] === null) m[i][8] = false;
    if (m[8][i] === null) m[8][i] = false;
  }
  for (let i = 0; i < 8; i++) {
    if (m[size - 1 - i][8] === null) m[size - 1 - i][8] = false;
    if (m[8][size - 1 - i] === null) m[8][size - 1 - i] = false;
  }
  m[size - 8][8] = true;                    // 固定的那个黑点

  // 版本信息区（两块 6×3），同样先占位
  if (version >= 7) {
    for (let i = 0; i < 18; i++) {
      m[Math.floor(i / 3)][(i % 3) + size - 11] = false;
      m[(i % 3) + size - 11][Math.floor(i / 3)] = false;
    }
  }

  return m;
}

/**
 * 之字形走位：从右下角开始，每次两列，按码流顺序回调每一个数据格。
 * 编码与测试里的「反着读回来」共用这一份，顺序不可能对不上。
 * @param {number} size
 * @param {(row: number, col: number) => boolean} isFree
 * @param {(row: number, col: number, index: number) => void} visit
 */
export function walkDataPositions(size, isFree, visit) {
  let index = 0;
  let upward = true;
  for (let col = size - 1; col > 0; col -= 2) {
    if (col === 6) col--;                   // 第 6 列整列是定时图案，跳过
    for (let i = 0; i < size; i++) {
      const row = upward ? size - 1 - i : i;
      for (const c of [col, col - 1]) {
        if (isFree(row, c)) visit(row, c, index++);
      }
    }
    upward = !upward;
  }
}

/** 掩码惩罚分，四条规则照规范实现。 @param {boolean[][]} m */
function penalty(m) {
  const size = m.length;
  let score = 0;

  // 规则 1：同色连段 ≥ 5
  for (let i = 0; i < size; i++) {
    for (const read of [(k) => m[i][k], (k) => m[k][i]]) {
      let run = 1;
      for (let k = 1; k < size; k++) {
        if (read(k) === read(k - 1)) { run++; } else { if (run >= 5) score += run - 2; run = 1; }
      }
      if (run >= 5) score += run - 2;
    }
  }

  // 规则 2：2×2 同色块
  for (let r = 0; r < size - 1; r++) {
    for (let c = 0; c < size - 1; c++) {
      const v = m[r][c];
      if (v === m[r][c + 1] && v === m[r + 1][c] && v === m[r + 1][c + 1]) score += 3;
    }
  }

  // 规则 3：1:1:3:1:1 且一侧带 4 格留白 —— 会被扫码器误认成定位图案
  const A = [true, false, true, true, true, false, true, false, false, false, false];
  const B = [false, false, false, false, true, false, true, true, true, false, true];
  const matches = (read, k) => {
    let a = true; let b = true;
    for (let t = 0; t < 11; t++) {
      if (read(k + t) !== A[t]) a = false;
      if (read(k + t) !== B[t]) b = false;
    }
    return a || b;
  };
  for (let i = 0; i < size; i++) {
    for (let k = 0; k + 11 <= size; k++) {
      if (matches((x) => m[i][x], k)) score += 40;
      if (matches((x) => m[x][i], k)) score += 40;
    }
  }

  // 规则 4：黑点占比偏离 50%
  let dark = 0;
  for (const row of m) for (const v of row) if (v) dark++;
  const ratio = (dark * 100) / (size * size);
  score += 10 * Math.floor(Math.abs(ratio - 50) / 5);

  return score;
}

/** @param {boolean[][]} m @param {number} mask */
function writeFormat(m, mask) {
  const size = m.length;
  const bits = formatBits(mask);
  for (let i = 0; i < 15; i++) {
    const on = ((bits >> i) & 1) === 1;
    // 左上角竖排 + 左下角
    if (i < 6) m[i][8] = on;
    else if (i < 8) m[i + 1][8] = on;
    else m[size - 15 + i][8] = on;
    // 右上角 + 左上角横排
    if (i < 8) m[8][size - i - 1] = on;
    else if (i < 9) m[8][15 - i] = on;
    else m[8][14 - i] = on;
  }
  m[size - 8][8] = true;
}

/** @param {boolean[][]} m @param {number} version */
function writeVersion(m, version) {
  const size = m.length;
  const bits = versionBits(version);
  for (let i = 0; i < 18; i++) {
    const on = ((bits >> i) & 1) === 1;
    m[Math.floor(i / 3)][(i % 3) + size - 11] = on;
    m[(i % 3) + size - 11][Math.floor(i / 3)] = on;
  }
}

/**
 * 生成 QR 矩阵。八个掩码全试一遍，取惩罚分最低的那个（规范要求）。
 * @param {string} text
 * @returns {{ size: number, version: number, mask: number, modules: boolean[][] }}
 *          modules[row][col] 为 true 表示黑点
 */
export function qrMatrix(text) {
  const { version, codewords } = encodeData(text);
  const stream = interleave(codewords, version);
  const size = version * 4 + 17;
  const base = buildFunctionPatterns(version);

  /** @type {{ row: number, col: number, bit: boolean }[]} */
  const dataCells = [];
  walkDataPositions(size, (r, c) => base[r][c] === null, (row, col, index) => {
    const byte = stream[index >> 3];
    // 走完码流后剩下的是「剩余位」，规范规定填 0
    const bit = byte === undefined ? false : ((byte >>> (7 - (index & 7))) & 1) === 1;
    dataCells.push({ row, col, bit });
  });

  /** @type {{ score: number, mask: number, modules: boolean[][] } | null} */
  let best = null;
  for (let mask = 0; mask < 8; mask++) {
    /** @type {boolean[][]} */
    const m = base.map((row) => row.map((v) => (v === null ? false : v)));
    for (const { row, col, bit } of dataCells) {
      m[row][col] = MASKS[mask](row, col) ? !bit : bit;
    }
    writeFormat(m, mask);
    if (version >= 7) writeVersion(m, version);
    const score = penalty(m);
    if (!best || score < best.score) best = { score, mask, modules: m };
  }

  const chosen = /** @type {{ score: number, mask: number, modules: boolean[][] }} */ (best);
  return { size, version, mask: chosen.mask, modules: chosen.modules };
}

/**
 * 画到 canvas 上。必须留静区（quiet zone），否则很多扫码器认不出来。
 * @param {HTMLCanvasElement} canvas @param {string} text
 * @param {{ scale?: number, quiet?: number }} [opts]
 */
export function drawQr(canvas, text, opts = {}) {
  const { modules, size } = qrMatrix(text);
  const scale = opts.scale ?? 5;
  const quiet = opts.quiet ?? 4;
  const px = (size + quiet * 2) * scale;

  canvas.width = px;
  canvas.height = px;
  const g = /** @type {CanvasRenderingContext2D} */ (canvas.getContext('2d'));
  // 底色写死白、点写死黑：暗色模式下反色的二维码有相当一部分扫码器读不了
  g.fillStyle = '#ffffff';
  g.fillRect(0, 0, px, px);
  g.fillStyle = '#000000';
  for (let r = 0; r < size; r++) {
    for (let c = 0; c < size; c++) {
      if (modules[r][c]) g.fillRect((c + quiet) * scale, (r + quiet) * scale, scale, scale);
    }
  }
  return { size, px };
}

/** 终端里用半块字符画出来，一行顶两行。管理 CLI 用。 @param {string} text */
export function qrToAscii(text) {
  const { modules, size } = qrMatrix(text);
  const quiet = 2;
  const n = size + quiet * 2;
  const at = (r, c) => (r >= quiet && r < quiet + size && c >= quiet && c < quiet + size)
    ? modules[r - quiet][c - quiet] : false;

  let out = '';
  for (let r = 0; r < n; r += 2) {
    for (let c = 0; c < n; c++) {
      // 黑点画成「亮」块：终端多半是深色背景，反过来扫不出来
      const top = at(r, c);
      const bottom = r + 1 < n ? at(r + 1, c) : false;
      out += top && bottom ? '█' : top ? '▀' : bottom ? '▄' : ' ';
    }
    out += '\n';
  }
  return out;
}

/** 仅供测试：把矩阵反着读回来需要这些内部件。 */
export const __internals = {
  MASKS, RS_BLOCKS_M, ALIGN_CENTERS, MAX_VERSION,
  dataCodewords, countBits, buildFunctionPatterns, formatBits, versionBits, gfMul, EXP, LOG,
};
