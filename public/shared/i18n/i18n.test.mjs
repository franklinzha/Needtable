/** 界面多语言：t() 占位符、漏翻回退中文、tr() 按模板翻译服务端拼好的消息；词典完整性交给 scripts/i18n.mjs check。 */

import assert from 'node:assert/strict';
import { t, tr, setDict, currentLang, langTag, isLang, LANGS } from './i18n.js';
import { check } from '../../../scripts/i18n.mjs';

let failures = 0;
async function test(name, fn) {
  try { await fn(); console.log('  ok   ' + name); }
  catch (err) { failures++; console.error('  FAIL ' + name + '\n       ' + err.message); }
}

await test('没设词典（worker / 中文）时 t() 返回填好的中文，tr() 原样返回', () => {
  setDict('zh', null);
  assert.equal(t('已选 {n} 行', { n: 3 }), '已选 3 行');
  assert.equal(t('保存'), '保存');
  assert.equal(tr('已选 3 行'), '已选 3 行');
  assert.equal(currentLang(), 'zh');
  assert.equal(langTag(), 'zh-CN');
});

await test('有词典时翻译，占位符可换顺序，查不到的回退中文', () => {
  setDict('en', { '保存': 'Save', '{a} 到 {b}': 'from {a} to {b}', '已选 {n} 行': '{n} rows selected' });
  assert.equal(t('保存'), 'Save');
  assert.equal(t('{a} 到 {b}', { b: 2, a: 1 }), 'from 1 to 2');
  assert.equal(t('没翻译的'), '没翻译的');
  assert.equal(t('缺参数 {x}'), '缺参数 {x}');
  assert.equal(langTag(), 'en');
});

await test('tr() 先整句查，再拿带占位符的词条当模板', () => {
  setDict('en', { '保存': 'Save', '已选 {n} 行': '{n} rows selected', '「{name}」已删除': '"{name}" deleted' });
  assert.equal(tr('保存'), 'Save');
  assert.equal(tr('已选 12 行'), '12 rows selected');
  assert.equal(tr('「销售 (2026)」已删除'), '"销售 (2026)" deleted');
  assert.equal(tr('别的消息'), '别的消息');
  setDict('en', { '管理员': 'Admin', '{label} 账号最多 {n} 个': '{label} accounts: up to {n}' });
  assert.equal(tr('管理员 账号最多 5 个'), 'Admin accounts: up to 5');   // 填进去的值本身是词条也翻译
  assert.equal(tr(''), '');
});

await test('非法语言 id 当中文处理', () => {
  setDict('xx', { '保存': 'Save' });
  assert.equal(currentLang(), 'zh');
  assert.equal(t('保存'), '保存');
  assert.equal(isLang('es'), true);
  assert.equal(isLang('de'), false);
  assert.deepEqual(LANGS.map((l) => l.id), ['zh', 'en', 'ja', 'ko', 'es', 'fr']);
  setDict('zh', null);
});

await test('每个 t() 的键在 5 种语言的词典里都有译文、占位符一致，登录页词典是最新的', async () => {
  const { keys, problems } = await check();
  assert.ok(keys > 100, '键太少：' + keys);
  assert.deepEqual(problems.slice(0, 10), []);
});

if (failures) { console.error(`\n${failures} 项失败`); process.exit(1); }
console.log('\n多语言全部通过');
