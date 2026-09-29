/** P6 导入导出：CSV 解析 / 生成、XLSX 写出再读回。 */
import assert from 'node:assert/strict';
import { GridModel } from '../public/js/grid/model.js';
import { Calc } from '../public/js/grid/calc.js';
import { toCsv, parseCsv } from '../public/js/io/csv.js';
import { toXlsx, fromXlsx } from '../public/js/io/xlsx.js';

let failures = 0;
async function test(name, fn) {
  try { await fn(); console.log('  ok   ' + name); }
  catch (err) { failures++; console.error('  FAIL ' + name + '\n       ' + (err.stack ?? err.message)); }
}

function sample() {
  const m = new GridModel();
  m.apply([{ t: 'setCells', cells: [[0, 0, '名称'], [0, 1, '数量'], [1, 0, 'a,"b"'], [1, 1, '3'], [2, 0, '多\n行'], [2, 1, '4.5'], [3, 1, '=SUM(B2:B3)'], [4, 0, 'TRUE']] }]);
  m.apply([{ t: 'setFormats', cells: [[0, 0, { b: true, bg: '#ffff00', ha: 'c' }], [3, 1, { nf: '0.00', bd: { t: '#000000' } }]] }]);
  m.apply([{ t: 'setProp', key: 'merges', value: [[5, 0, 5, 1]] }, { t: 'setProp', key: 'freeze', value: { r: 1, c: 0 } }]);
  return { m, calc: new Calc(m) };
}

await test('parseCsv：引号、转义、CRLF、BOM、自动识别分隔符', () => {
  assert.deepEqual(parseCsv('﻿a,"b,""c"""\r\n1,"x\ny"\r\n'), [['a', 'b,"c"'], ['1', 'x\ny']]);
  assert.deepEqual(parseCsv('a\tb\n1\t2'), [['a', 'b'], ['1', '2']]);
  assert.deepEqual(parseCsv('a;b;c\n1;2;3'), [['a', 'b', 'c'], ['1', '2', '3']]);
});

await test('toCsv → parseCsv 往返一致（公式导出为结果）', () => {
  const { m, calc } = sample();
  const rows = parseCsv(toCsv(m, calc));
  assert.equal(rows[1][0], 'a,"b"');
  assert.equal(rows[2][0], '多\n行');
  assert.equal(rows[3][1], '7.50');
});

await test('toXlsx → fromXlsx：值、公式、布尔往返', async () => {
  const { m, calc } = sample();
  const bytes = await toXlsx(m, calc, '测试');
  assert.equal(bytes[0], 0x50); assert.equal(bytes[1], 0x4b);
  const rows = await fromXlsx(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length));
  assert.deepEqual(rows[0], ['名称', '数量']);
  assert.deepEqual(rows[1], ['a,"b"', '3']);
  assert.equal(rows[2][0], '多\n行');
  assert.equal(rows[3][1], '=SUM(B2:B3)');
  assert.equal(rows[4][0], 'TRUE');
});

await test('toXlsx 带透视表：每个透视表一张工作表，重名加序号，数据表仍可读回', async () => {
  const { m, calc } = sample();
  const { computePivot, pivotMatrix } = await import('../public/js/grid/pivotcalc.js');
  const def = { id: 'p1', name: '透视/表', range: [0, 0, 2, 1], header: true, rows: [0], values: [{ col: 1, agg: 'sum' }] };
  const res = computePivot(def, (r, c) => calc.value(r, c), (r, c) => calc.text(r, c));
  const mat = pivotMatrix(res);
  const bytes = await toXlsx(m, calc, '数据', [{ name: '透视/表', matrix: mat }, { name: '透视 表', matrix: mat }]);
  const text = new TextDecoder().decode(bytes);   // zipStore 不压缩，直接能搜
  assert.match(text, /<sheet name="数据" sheetId="1" r:id="rId1"\/>/);
  assert.match(text, /<sheet name="透视 表" sheetId="2" r:id="rId2"\/>/);
  assert.match(text, /<sheet name="透视 表 \(2\)" sheetId="3" r:id="rId3"\/>/);
  assert.match(text, /Id="rId4"[^>]*styles/);
  assert.match(text, /xl\/worksheets\/sheet3\.xml/);
  assert.match(text, /<v>7\.5<\/v>/);   // 总计 3 + 4.5，写成数字
  const rows = await fromXlsx(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length));
  assert.deepEqual(rows[0], ['名称', '数量']);
});

await test('pdfFromJpeg：对象偏移与 xref 一致，图片按 DCTDecode 原样嵌入', async () => {
  const { pdfFromJpeg } = await import('../public/js/views/dashexport.js');
  const jpeg = new Uint8Array([0xff, 0xd8, 1, 2, 3, 0xff, 0xd9]);
  const pdf = pdfFromJpeg(jpeg, 20, 10, 15, 7.5);
  const s = Buffer.from(pdf).toString('latin1');
  assert.ok(s.startsWith('%PDF-1.4'));
  assert.ok(s.endsWith('%%EOF\n'));
  assert.match(s, /\/MediaBox \[0 0 15 7\.5\]/);
  assert.match(s, /\/Width 20 \/Height 10 .*\/Filter \/DCTDecode \/Length 7/);
  const xref = Number(/startxref\n(\d+)/.exec(s)[1]);
  assert.equal(s.slice(xref, xref + 4), 'xref');
  const offs = [...s.slice(xref).matchAll(/^(\d{10}) 00000 n $/gm)].map((x) => Number(x[1]));
  assert.equal(offs.length, 5);
  offs.forEach((o, i) => assert.equal(s.slice(o, o + String(i + 1).length + 6), (i + 1) + ' 0 obj'));
  assert.ok(s.includes(Buffer.from(jpeg).toString('latin1')));
});

await test('fromXlsx 读 deflate 压缩的包（Excel 原生产物的形态）', async () => {
  const { deflateRawSync } = await import('node:zlib');
  const { m, calc } = sample();
  const stored = await toXlsx(m, calc);
  // 把仅存储的包改写成 deflate：解析本地头后重新打包
  const files = [];
  const dv = new DataView(stored.buffer, stored.byteOffset);
  let p = 0;
  while (dv.getUint32(p, true) === 0x04034b50) {
    const size = dv.getUint32(p + 18, true), nlen = dv.getUint16(p + 26, true);
    files.push({ name: stored.subarray(p + 30, p + 30 + nlen), data: stored.subarray(p + 30 + nlen, p + 30 + nlen + size) });
    p += 30 + nlen + size;
  }
  const parts = [], central = [];
  let off = 0;
  for (const f of files) {
    const z = deflateRawSync(f.data);
    const lh = Buffer.alloc(30); lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(8, 8); lh.writeUInt32LE(z.length, 18); lh.writeUInt32LE(f.data.length, 22); lh.writeUInt16LE(f.name.length, 26);
    parts.push(lh, f.name, z);
    const ch = Buffer.alloc(46); ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(8, 10); ch.writeUInt32LE(z.length, 20); ch.writeUInt32LE(f.data.length, 24); ch.writeUInt16LE(f.name.length, 28); ch.writeUInt32LE(off, 42);
    central.push(ch, f.name);
    off += 30 + f.name.length + z.length;
  }
  const cd = Buffer.concat(central);
  const end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10); end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(off, 16);
  const all = Buffer.concat([...parts, cd, end]);
  const rows = await fromXlsx(all.buffer.slice(all.byteOffset, all.byteOffset + all.length));
  assert.equal(rows[1][1], '3');
  assert.equal(rows[3][1], '=SUM(B2:B3)');
});

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
