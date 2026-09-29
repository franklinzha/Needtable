/**
 * 动态数组溢出（=A1:B3、=IMPORTRANGE(...) 的结果铺到右下方）与公式点选列标 / 行号。
 */
import assert from 'node:assert/strict';
const { Engine } = await import('../public/shared/formula/evaluate.js');
const { Ref, FErr } = await import('../public/shared/formula/values.js');
const { GridModel } = await import('../public/js/grid/model.js');
const { Calc } = await import('../public/js/grid/calc.js');

let failures = 0;
async function test(name, fn) {
  try { await fn(); console.log('  ok   ' + name); }
  catch (err) { failures++; console.error('  FAIL ' + name + '\n       ' + (err.stack ?? err.message)); }
}

/** @param {Record<string,string>} cells A1 → 原文 @param {any} [ext] */
function sheet(cells, ext) {
  const m = new GridModel({ rows: 30, cols: 10 });
  const ops = Object.entries(cells).map(([a1, v]) => {
    const c = a1.charCodeAt(0) - 65, r = Number(a1.slice(1)) - 1;
    return { t: 'setCell', r, c, v };
  });
  m.apply(ops);
  return { m, calc: new Calc(m, { tableId: 'tbl_self', ext }) };
}
const at = (a1) => [Number(a1.slice(1)) - 1, a1.charCodeAt(0) - 65];

await test('=A1:B3 从公式格往右下铺开', () => {
  const { calc } = sheet({ A1: '1', B1: 'x', A2: '2', B2: 'y', A3: '3', B3: 'z', D1: '=A1:B3' });
  assert.equal(calc.value(...at('D1')), 1);
  assert.equal(calc.value(...at('E1')), 'x');
  assert.equal(calc.value(...at('D3')), 3);
  assert.equal(calc.value(...at('E3')), 'z');
  assert.equal(calc.display(...at('E2')).text, 'y');
  assert.deepEqual(calc.spillOwner(...at('E3')), { r: 0, c: 3 });
  assert.equal(calc.spillOwner(...at('D1')), null);         // 锚点自己不算被铺
  assert.equal(calc.value(...at('D4')), null);
});

await test('SEQUENCE / SORT / UNIQUE / FILTER 返回整块并溢出', () => {
  const data = { A1: 'b', B1: '3', A2: 'a', B2: '1', A3: 'B', B3: '3', A4: 'c', B4: '2' };
  const col = (calc, a1, n) => Array.from({ length: n }, (_, i) => { const [r, c] = at(a1); return calc.value(r + i, c); });
  let { calc } = sheet({ ...data, D1: '=SEQUENCE(3, 2, 10, 5)' });
  assert.deepEqual([col(calc, 'D1', 3), col(calc, 'E1', 3)], [[10, 20, 30], [15, 25, 35]]);
  ({ calc } = sheet({ ...data, D1: '=SORT(A1:B4, 2, -1)' }));
  assert.deepEqual(col(calc, 'D1', 4), ['b', 'B', 'c', 'a'], '降序、相等保持原顺序');
  assert.deepEqual(col(calc, 'E1', 4), [3, 3, 2, 1]);
  ({ calc } = sheet({ ...data, D1: '=SORT(A1:A4)' }));
  assert.deepEqual(col(calc, 'D1', 4), ['a', 'b', 'B', 'c']);
  ({ calc } = sheet({ ...data, D1: '=UNIQUE(A1:A4)' }));
  assert.deepEqual(col(calc, 'D1', 4), ['b', 'a', 'c', null], '文本不分大小写');
  ({ calc } = sheet({ ...data, D1: '=UNIQUE(B1:B4, FALSE, TRUE)' }));
  assert.deepEqual(col(calc, 'D1', 3), [1, 2, null]);
  ({ calc } = sheet({ ...data, D1: '=FILTER(A1:B4, B1:B4>=2)' }));
  assert.deepEqual([col(calc, 'D1', 4), col(calc, 'E1', 3)], [['b', 'B', 'c', null], [3, 3, 2]]);
  ({ calc } = sheet({ ...data, D1: '=FILTER(A1:A4, B1:B4>5, "无")', E1: '=FILTER(A1:A4, B1:B4>5)', F1: '=FILTER(A1:A4, B1:B2)' }));
  assert.equal(calc.value(...at('D1')), '无');
  assert.equal(calc.value(...at('E1')).err, '#CALC!');
  assert.equal(calc.value(...at('F1')).err, '#VALUE!', '条件长度对不上');
  ({ calc } = sheet({ ...data, D1: '=SUM(FILTER(B1:B4, A1:A4="b"))', E1: '=ROWS(UNIQUE(B1:B4))' }));
  assert.equal(calc.value(...at('D1')), 6);
  assert.equal(calc.value(...at('E1')), 3);
});

await test('要铺的位置已有内容 → #SPILL!，挡住的东西不动', () => {
  const { calc } = sheet({ A1: '1', A2: '2', A3: '3', D1: '=A1:A3', D3: 'block' });
  const v = calc.value(...at('D1'));
  assert.ok(v instanceof FErr && v.err === '#SPILL!');
  assert.equal(calc.value(...at('D2')), null);
  assert.equal(calc.value(...at('D3')), 'block');
});

await test('其他公式能引用铺出来的格子', () => {
  const { calc } = sheet({ A1: '1', A2: '2', A3: '3', C1: '=A1:A3*10', E1: '=SUM(C1:C3)', E2: '=C3+1' });
  assert.equal(calc.value(...at('C2')), 20);
  assert.equal(calc.value(...at('E1')), 60);
  assert.equal(calc.value(...at('E2')), 31);
});

await test('聚合函数照常返回一个值，不铺开', () => {
  const { calc } = sheet({ A1: '1', A2: '2', A3: '3', C1: '=SUM(A1:A3)', D1: '=COUNTIF(A1:A3,">1")' });
  assert.equal(calc.value(...at('C1')), 6);
  assert.equal(calc.value(...at('D1')), 2);
  assert.equal(calc.spillOwner(...at('C2')), null);
});

await test('铺开的范围又回头引用自己 → #CIRC!，不死循环', () => {
  const { calc } = sheet({ A1: '=A1:A3' });
  const v = calc.value(...at('A2'));
  assert.ok(v == null || v instanceof FErr);
});

await test('末尾整行空白裁掉：=A:B 只铺到有数据的最后一行', () => {
  const { calc } = sheet({ A1: '1', B1: '2', A2: '3', D1: '=A:B' });
  assert.equal(calc.value(...at('D2')), 3);
  assert.equal(calc.spillOwner(...at('D3')), null);
});

await test('IMPORTRANGE 外表区域整块铺开；SUM / COUNTIF 套在外面照常聚合', () => {
  const data = [['名称', '数量'], ['a', 5], ['b', 7], [null, null]];
  const src = { cell: (r, c) => data[r]?.[c] ?? null };
  const ext = (table, range) => (table === 'tbl_other' ? new Ref(src, 0, 0, 3, 1) : null);
  const { calc } = sheet({
    D1: '=IMPORTRANGE("tbl_other","A:B")',
    A1: '=SUM(IMPORTRANGE("tbl_other","A:B"))',
    B1: '=COUNTIF(IMPORTRANGE("tbl_other","A:B"),">5")',
  }, ext);
  assert.equal(calc.value(...at('D1')), '名称');
  assert.equal(calc.value(...at('E1')), '数量');
  assert.equal(calc.value(...at('D3')), 'b');
  assert.equal(calc.value(...at('E3')), 7);
  assert.equal(calc.spillOwner(...at('D4')), null);          // 末尾空行不铺
  assert.equal(calc.value(...at('A1')), 12);
  assert.equal(calc.value(...at('B1')), 1);
});

await test('改了数据后溢出跟着变', () => {
  const { m, calc } = sheet({ A1: '1', A2: '2', C1: '=A1:A2' });
  assert.equal(calc.value(...at('C2')), 2);
  m.apply([{ t: 'setCell', r: 2, c: 0, v: '9' }, { t: 'setCell', r: 0, c: 2, v: '=A1:A3' }]);
  assert.equal(calc.value(...at('C3')), 9);
  m.apply([{ t: 'setCell', r: 1, c: 2, v: 'x' }]);
  assert.equal(calc.value(...at('C1')).err, '#SPILL!');
});

await test('没有 formulas 的宿主（服务端）不溢出，取左上角', () => {
  const raw = { '0:0': '5', '1:0': '6', '0:2': '=A1:A2' };
  const eng = new Engine({ raw: (r, c) => raw[r + ':' + c] ?? '', rows: () => 10, cols: () => 5 });
  assert.equal(eng.value(0, 2), 5);
  assert.equal(eng.value(1, 2), null);
});

// ── 公式点选：列标 / 行号 ────────────────────────────────────────────────
globalThis.document ??= /** @type {any} */ ({ body: { append() {} } });
const { FormulaAssist } = await import('../public/js/grid/assist.js');
/** 不建 DOM，只借 pick 的逻辑跑一遍 */
function fakeAssist(text) {
  const el = { value: text, selectionStart: text.length, setSelectionRange(a) { this.selectionStart = a; }, focus() {} };
  const self = Object.create(FormulaAssist.prototype);
  Object.assign(self, { target: el, lastPick: null, g: { editor: { el }, fx: {} }, update() {}, _hide() {} });
  return { self, el };
}

await test('点列标插入 A:A，拖到 C 列变 A:C', () => {
  const { self, el } = fakeAssist('=COUNTIF(');
  self.pick(0, 0, 0, 0, 'col');
  assert.equal(el.value, '=COUNTIF(A:A');
  self.pick(0, 0, 0, 2, 'col');
  assert.equal(el.value, '=COUNTIF(A:C');
});

await test('点行号插入 1:1，拖动变 2:5；普通格子不变', () => {
  const { self, el } = fakeAssist('=SUM(');
  self.pick(1, 0, 1, 0, 'row');
  assert.equal(el.value, '=SUM(2:2');
  self.pick(1, 0, 4, 0, 'row');
  assert.equal(el.value, '=SUM(2:5');
  const b = fakeAssist('=SUM(');
  b.self.pick(0, 1, 2, 1);
  assert.equal(b.el.value, '=SUM(B1:B3');
});

if (failures) { console.error(`\n${failures} 个溢出测试失败`); process.exit(1); }
console.log('\n动态数组溢出 / 列标点选测试全部通过');
