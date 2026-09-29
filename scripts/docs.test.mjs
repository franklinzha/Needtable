/**
 * 函数文档（public/shared/formula/docs.js）：
 *   · 每个 FUNCTION_NAMES 里的函数都有文档，文档里也没有引擎不认的函数
 *   · 分类都在 CATEGORIES 里，签名以函数名开头
 *   · 不含单元格引用、结果不是中文描述的示例，拿引擎真算一遍，和文档写的结果比对
 */

import assert from 'node:assert/strict';

const { DOCS, CATEGORIES, brief, helpUrl } = await import('../public/shared/formula/docs.js');
const { FUNCTION_NAMES } = await import('../public/shared/formula/functions.js');
const { Engine } = await import('../public/shared/formula/evaluate.js');
const { FErr } = await import('../public/shared/formula/values.js');

let failures = 0;
async function test(name, fn) {
  try { await fn(); console.log('  ok   ' + name); }
  catch (err) { failures++; console.error('  FAIL ' + name + '\n       ' + (err.stack ?? err.message)); }
}

const names = [...FUNCTION_NAMES];

await test('每个函数都有文档，文档里没有多余的函数', () => {
  const missing = names.filter((n) => !DOCS[n]);
  assert.deepEqual(missing, [], '缺文档：' + missing.join(', '));
  const extra = Object.keys(DOCS).filter((n) => !names.includes(n));
  assert.deepEqual(extra, [], '引擎没有这些函数：' + extra.join(', '));
});

await test('字段齐全：分类合法、签名以函数名开头、有说明和示例', () => {
  const cats = new Set(CATEGORIES.map(([id]) => id));
  for (const d of Object.values(DOCS)) {
    assert.ok(cats.has(d.cat), d.name + ' 分类 ' + d.cat);
    assert.ok(d.sig.startsWith(d.name + '('), d.name + ' 签名 ' + d.sig);
    assert.ok(d.desc, d.name + ' 缺说明');
    assert.ok(d.example.startsWith('='), d.name + ' 示例要以 = 开头');
    for (const [p, t] of d.params) assert.ok(p && t, d.name + ' 参数格式不对');
  }
  assert.deepEqual(brief('SUM'), [DOCS.SUM.sig, DOCS.SUM.desc]);
  assert.deepEqual(brief('NOPE'), ['NOPE()', '']);
  assert.equal(helpUrl('CEILING.MATH'), '/help#CEILING.MATH');
});

/** 在空表的 A1 里算一条公式。 */
function calc(formula) {
  const eng = new Engine({ raw: (r, c) => (r === 0 && c === 0 ? formula : ''), rows: () => 5, cols: () => 5 });
  return eng.value(0, 0);
}

const HAS_REF = /(^|[^A-Za-z_."])\$?[A-Z]{1,3}\$?\d+\b/;
const DESCRIPTIVE = /[一-鿿]/;

await test('示例的结果和引擎算出来的一致', () => {
  const bad = [];
  let checked = 0;
  for (const d of Object.values(DOCS)) {
    // 带引用的（没数据可算）、结果是中文描述的、随时间/随机变化的，跳过
    if (HAS_REF.test(d.example.replace(/"[^"]*"/g, '""')) || DESCRIPTIVE.test(d.result)) continue;
    const got = calc(d.example);
    const shown = got instanceof FErr ? got.err
      : typeof got === 'boolean' ? (got ? 'TRUE' : 'FALSE')
      : got == null ? '' : got;
    const want = /^-?\d+(\.\d+)?$/.test(d.result) ? Number(d.result) : d.result;
    const same = typeof want === 'number' && typeof shown === 'number'
      ? Math.abs(shown - want) < 1e-9 * Math.max(1, Math.abs(want))
      : String(shown) === String(want);
    if (!same) bad.push(`${d.name}: ${d.example} → ${JSON.stringify(shown)}，文档写 ${JSON.stringify(d.result)}`);
    checked++;
  }
  assert.deepEqual(bad, []);
  assert.ok(checked >= 110, '只校验了 ' + checked + ' 条示例');
});

await test('文档里写的可选参数，引擎都认', () => {
  const eq = (f, want) => {
    const got = calc(f);
    if (typeof want === 'number') assert.ok(Math.abs(got - want) < 1e-9, f + ' → ' + got);
    else assert.deepEqual(got instanceof FErr ? got.err : got, want, f);
  };
  eq('=TEXTAFTER("a-b-c", "-", -1)', 'c');
  eq('=TEXTBEFORE("a-b-c", "-", 2)', 'a-b');
  eq('=TEXTAFTER("a-b", "-", 3)', '#N/A');
  eq('=TEXTAFTER("a-b", "-", 0)', '#VALUE!');
  eq('=NUMBERVALUE("12,5%", ",", ".")', 0.125);
  eq('=NUMBERVALUE("1,2,3", ",", ".")', '#VALUE!');
  eq('=YEARFRAC(DATE(2024,1,31), DATE(2024,3,31))', 1 / 6);
  eq('=YEARFRAC(DATE(2023,1,1), DATE(2023,7,2), 1)', 182 / 365);
  eq('=YEARFRAC(DATE(2024,1,1), DATE(2024,1,31), 2)', 30 / 360);
  eq('=YEARFRAC(DATE(2024,1,1), DATE(2024,1,31), 9)', '#NUM!');
  eq('=CEILING.MATH(-2.5)', -2);
  eq('=CEILING.MATH(-2.5, 1, 1)', -3);
  eq('=CEILING.MATH(7, -5)', 10);
  eq('=FLOOR.MATH(-2.5)', -3);
  eq('=FLOOR.MATH(-2.5, 1, 1)', -2);
});

if (failures) { console.error(`\n${failures} 个用例失败`); process.exit(1); }
console.log('\n函数文档：全部通过');
