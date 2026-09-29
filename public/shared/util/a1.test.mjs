/** A1 表示法。26 进制无 0 这件事经常写错，且一错就是整列引用错位，所以单独测。 */

import assert from 'node:assert/strict';
import { colName, colIndex, cellRef, parseRef, parseRange, rangeName } from './a1.js';

let failures = 0;
function test(name, fn) {
  try { fn(); console.log('  ok   ' + name); }
  catch (err) { failures++; console.error('  FAIL ' + name + '\n       ' + err.message); }
}

test('列名边界：Z→AA、ZZ→AAA 这两处最容易差一位', () => {
  assert.equal(colName(0), 'A');
  assert.equal(colName(25), 'Z');
  assert.equal(colName(26), 'AA');
  assert.equal(colName(51), 'AZ');
  assert.equal(colName(52), 'BA');
  assert.equal(colName(701), 'ZZ');
  assert.equal(colName(702), 'AAA');
  assert.equal(colName(16383), 'XFD');          // Excel 的最后一列
});

test('列名与列号互逆', () => {
  for (let i = 0; i < 20000; i++) assert.equal(colIndex(colName(i)), i, '第 ' + i + ' 列');
});

test('列名大小写不敏感，非法输入返回 -1', () => {
  assert.equal(colIndex('ab'), colIndex('AB'));
  for (const bad of ['', '1', 'A1', 'A B', '?', 'ABCDEFGH']) assert.equal(colIndex(bad), -1, bad);
});

test('单引用解析带 $ 锚点', () => {
  assert.deepEqual(parseRef('B3'), { row: 2, col: 1, absRow: false, absCol: false });
  assert.deepEqual(parseRef('$B$3'), { row: 2, col: 1, absRow: true, absCol: true });
  assert.deepEqual(parseRef('  a1 '), { row: 0, col: 0, absRow: false, absCol: false });
  for (const bad of ['A0', 'A', '1', '', 'A1:B2', '$', 'AAAAAAAA1']) {
    assert.equal(parseRef(bad), null, bad);
  }
});

test('区域解析会规范化到左上-右下', () => {
  assert.deepEqual(parseRange('A1:C9'), { r0: 0, c0: 0, r1: 8, c1: 2 });
  assert.deepEqual(parseRange('C9:A1'), { r0: 0, c0: 0, r1: 8, c1: 2 });
  assert.deepEqual(parseRange('B2'), { r0: 1, c0: 1, r1: 1, c1: 1 });
  assert.equal(parseRange('A1:B2:C3'), null);
});

test('rangeName 与 cellRef 往返', () => {
  assert.equal(cellRef(0, 0), 'A1');
  assert.equal(rangeName(0, 0, 0, 0), 'A1');
  assert.equal(rangeName(0, 0, 8, 2), 'A1:C9');
  assert.deepEqual(parseRange(rangeName(3, 4, 99, 30)), { r0: 3, c0: 4, r1: 99, c1: 30 });
});

console.log(failures === 0 ? '\nALL PASS' : '\n' + failures + ' FAILED');
if (failures > 0) process.exit(1);
