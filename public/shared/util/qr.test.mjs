/**
 * QR 编码器测试。
 *
 * 核心思路：不去比对「长得像不像」，而是**把生成的矩阵反着读回来**——
 * 去掩码 → 逆之字形取位 → 解交织 → 解析模式头 → 断言还原出原文。
 * 再独立验一遍 RS：每个块的校验子（在 α^0..α^(ec-1) 处求值）必须恒为 0。
 * 两条路都通过，说明编出来的东西真的是一张能扫的 QR，而不是一堆好看的黑格子。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  qrMatrix, encodeData, interleave, rsEncode, gfMul,
  byteCapacity, walkDataPositions, qrToAscii, __internals,
} from './qr.js';

const { RS_BLOCKS_M, MASKS, buildFunctionPatterns, dataCodewords, countBits, formatBits, versionBits, EXP } = __internals;

// ── 把矩阵读回来 ────────────────────────────────────────────────────────────

/** 逆交织：把码流还原成每块的 data ‖ ec。 */
function deinterleave(stream, version) {
  const [ecLen, g1, d1, g2, d2] = RS_BLOCKS_M[version];
  const sizes = [];
  for (let b = 0; b < g1; b++) sizes.push(d1);
  for (let b = 0; b < g2; b++) sizes.push(d2);

  const dataBlocks = sizes.map((n) => new Uint8Array(n));
  const ecBlocks = sizes.map(() => new Uint8Array(ecLen));

  let p = 0;
  for (let i = 0; i < Math.max(d1, d2); i++) {
    for (let b = 0; b < sizes.length; b++) if (i < sizes[b]) dataBlocks[b][i] = stream[p++];
  }
  for (let i = 0; i < ecLen; i++) {
    for (let b = 0; b < sizes.length; b++) ecBlocks[b][i] = stream[p++];
  }
  assert.equal(p, stream.length, '逆交织应当恰好消费完整条码流');
  return { dataBlocks, ecBlocks, ecLen };
}

/** 从矩阵还原出交织后的码流。 */
function readStream(modules, version, mask) {
  const size = modules.length;
  const base = buildFunctionPatterns(version);
  const bits = [];
  walkDataPositions(size, (r, c) => base[r][c] === null, (row, col) => {
    const v = modules[row][col];
    bits.push(MASKS[mask](row, col) ? !v : v);   // 去掩码
  });
  const total = Math.floor(bits.length / 8);
  const out = new Uint8Array(total);
  for (let i = 0; i < total; i++) {
    let byte = 0;
    for (let j = 0; j < 8; j++) byte = (byte << 1) | (bits[i * 8 + j] ? 1 : 0);
    out[i] = byte;
  }
  return out;
}

/** 解析字节模式的数据码字，取回原文。 */
function decodePayload(dataBlocks, version) {
  const flat = [];
  for (const b of dataBlocks) for (const byte of b) flat.push(byte);

  const bits = [];
  for (const byte of flat) for (let i = 7; i >= 0; i--) bits.push((byte >>> i) & 1);

  let p = 0;
  const take = (n) => { let v = 0; for (let i = 0; i < n; i++) v = (v << 1) | bits[p++]; return v; };

  assert.equal(take(4), 0b0100, '模式指示符应为字节模式');
  const len = take(countBits(version));
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) bytes[i] = take(8);
  return new TextDecoder().decode(bytes);
}

/** RS 校验子：码字多项式在 α^i（i < ecLen）处必须取 0。 */
function syndromes(data, ec, ecLen) {
  const cw = [...data, ...ec];
  const out = [];
  for (let i = 0; i < ecLen; i++) {
    let acc = 0;
    for (const byte of cw) acc = gfMul(acc, EXP[i]) ^ byte;   // Horner
    out.push(acc);
  }
  return out;
}

/** 完整往返：编码 → 读回 → 断言原文与 RS 都对。 */
function roundTrip(text) {
  const { modules, version, mask, size } = qrMatrix(text);
  assert.equal(size, version * 4 + 17);
  const stream = readStream(modules, version, mask);
  const { dataBlocks, ecBlocks, ecLen } = deinterleave(stream, version);

  for (let b = 0; b < dataBlocks.length; b++) {
    assert.deepEqual(
      syndromes(dataBlocks[b], ecBlocks[b], ecLen),
      new Array(ecLen).fill(0),
      `第 ${b} 块的 RS 校验子应全为 0`,
    );
  }

  assert.equal(decodePayload(dataBlocks, version), text);
  return { version, mask, modules, size };
}

// ── 用例 ────────────────────────────────────────────────────────────────────

test('GF(256) 乘法满足域公理', () => {
  assert.equal(gfMul(0, 123), 0);
  assert.equal(gfMul(1, 123), 123);
  assert.equal(gfMul(2, 0x80), 0x1d);           // 溢出后按本原多项式 0x11d 约简
  for (let a = 1; a < 256; a += 37) {
    for (let b = 1; b < 256; b += 41) {
      assert.equal(gfMul(a, b), gfMul(b, a), '交换律');
      assert.notEqual(gfMul(a, b), 0, '非零元之积非零');
      for (let c = 1; c < 256; c += 53) {
        assert.equal(gfMul(gfMul(a, b), c), gfMul(a, gfMul(b, c)), '结合律');
        assert.equal(gfMul(a, b ^ c), gfMul(a, b) ^ gfMul(a, c), '分配律');
      }
    }
  }
  // 每个非零元都有逆元
  for (let a = 1; a < 256; a += 29) {
    let inv = 0;
    for (let b = 1; b < 256; b++) if (gfMul(a, b) === 1) { inv = b; break; }
    assert.notEqual(inv, 0, `${a} 应存在逆元`);
  }
});

test('RS 编码：纠错码字长度正确且校验子为 0', () => {
  const data = new Uint8Array(16).map((_, i) => (i * 17 + 3) & 0xff);
  const ec = rsEncode(data, 10);
  assert.equal(ec.length, 10);
  assert.deepEqual(syndromes(data, ec, 10), new Array(10).fill(0));
});

test('版本容量与规范一致', () => {
  assert.equal(byteCapacity(1), 14);
  assert.equal(byteCapacity(5), 84);
  assert.equal(byteCapacity(9), 180);
  assert.equal(byteCapacity(10), 213);
  for (let v = 1; v < 10; v++) {
    assert.ok(byteCapacity(v) < byteCapacity(v + 1), `v${v} 容量应小于 v${v + 1}`);
  }
  // 每版总码字数（数据 + 纠错）必须对上规范
  const totals = [26, 44, 70, 100, 134, 172, 196, 242, 292, 346];
  for (let v = 1; v <= 10; v++) {
    const [ecLen, g1, , g2] = RS_BLOCKS_M[v];
    assert.equal(dataCodewords(v) + ecLen * (g1 + g2), totals[v - 1], `v${v} 总码字数`);
  }
});

test('BCH：格式信息与版本信息命中规范给出的值', () => {
  assert.equal(formatBits(0), 0x5412);   // 等级 M / 掩码 0
  assert.equal(formatBits(1), 0x5125);
  assert.equal(versionBits(7), 0x07c94);
  assert.equal(versionBits(10), 0x0a4d3);
});

test('往返：otpauth URI（TOTP 绑定的真实载荷）', () => {
  const uri = 'otpauth://totp/Table:someone@example.com'
    + '?secret=JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP&issuer=Table&algorithm=SHA1&digits=6&period=30';
  assert.ok(uri.length > 120 && uri.length < 180, '真实 otpauth URI 的长度区间');
  const { version } = roundTrip(uri);
  assert.ok(version >= 7 && version <= 10, `实际用到 v${version}，仍在支持范围内`);
});

test('往返：各版本边界长度', () => {
  for (let v = 1; v <= 10; v++) {
    const text = 'A'.repeat(byteCapacity(v));       // 该版本刚好装满
    const got = roundTrip(text);
    assert.equal(got.version, v, `${text.length} 字节应选中 v${v}`);
  }
});

test('往返：短文本、UTF-8、以及全字节值', () => {
  roundTrip('hi');
  roundTrip('中文也要能编码进去');
  roundTrip(Array.from({ length: 100 }, (_, i) => String.fromCharCode(32 + (i % 95))).join(''));
});

test('功能图案落位正确', () => {
  const { modules, size } = qrMatrix('hello');
  // 三个定位图案的中心 3×3 全黑、外圈第 5 圈全白
  for (const [r0, c0] of [[0, 0], [0, size - 7], [size - 7, 0]]) {
    for (let r = 2; r <= 4; r++) for (let c = 2; c <= 4; c++) {
      assert.equal(modules[r0 + r][c0 + c], true, '定位图案中心应为黑');
    }
    assert.equal(modules[r0 + 1][c0 + 1], false, '定位图案第二圈应为白');
  }
  // 定时图案交替
  for (let i = 8; i < size - 8; i++) {
    assert.equal(modules[6][i], i % 2 === 0, `横向定时图案第 ${i} 格`);
    assert.equal(modules[i][6], i % 2 === 0, `纵向定时图案第 ${i} 格`);
  }
  assert.equal(modules[size - 8][8], true, '固定黑点');
});

test('掩码从八个里择优，且选中的那个确实被写进了格式信息', () => {
  const { mask, modules } = qrMatrix('otpauth://totp/Table:a@b.com?secret=AAAA&issuer=Table');
  assert.ok(mask >= 0 && mask < 8);
  // 从矩阵左上角竖排把 15 位格式信息读回来，应等于 formatBits(mask)
  let bits = 0;
  for (let i = 0; i < 15; i++) {
    const on = i < 6 ? modules[i][8] : i < 8 ? modules[i + 1][8] : modules[modules.length - 15 + i][8];
    if (on) bits |= 1 << i;
  }
  assert.equal(bits, formatBits(mask));
});

test('超出 v10 容量时明确报错，而不是悄悄生成坏码', () => {
  assert.throws(() => encodeData('x'.repeat(byteCapacity(10) + 1)), /超过版本 10/);
});

test('交织后的码流长度等于该版本总码字数', () => {
  for (let v of [1, 5, 8, 10]) {
    const text = 'z'.repeat(byteCapacity(v));
    const { version, codewords } = encodeData(text);
    assert.equal(version, v);
    const [ecLen, g1, , g2] = RS_BLOCKS_M[v];
    assert.equal(interleave(codewords, v).length, dataCodewords(v) + ecLen * (g1 + g2));
  }
});

test('ASCII 输出可用于终端展示', () => {
  const art = qrToAscii('hi');
  const lines = art.split('\n').slice(0, -1);   // 末尾是换行造出来的空串，不是一行
  assert.ok(lines.length > 10);
  assert.ok(lines.every((l) => l.length === lines[0].length), '每行等宽');
  assert.ok(/[█▀▄]/.test(art), '应含半块字符');
});
