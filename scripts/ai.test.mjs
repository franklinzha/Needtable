/**
 * AI 前端占位（public/js/ai/index.js）：
 *   · 服务端未启用 → NullProvider，调用抛 AIDisabledError，不发请求
 *   · 服务端启用 → RemoteProvider，按功能转发到 /api/ai/*
 *   · capabilities 请求失败也当作未启用
 */

import assert from 'node:assert/strict';

let failures = 0;
async function test(name, fn) {
  try { await fn(); console.log('  ok   ' + name); }
  catch (err) { failures++; console.error('  FAIL ' + name + '\n       ' + (err.stack ?? err.message)); }
}

/** 每个用例重新 import 一份模块，避开 getAI 的页面级缓存 */
let n = 0;
const load = () => import('../public/js/ai/index.js?v=' + (++n));

/** @param {(path: string, init: any) => [number, unknown]} route */
function fakeFetch(route) {
  const calls = [];
  globalThis.fetch = async (path, init) => {
    calls.push([path, init?.method ?? 'GET', init?.body ? JSON.parse(init.body) : null]);
    const [status, body] = route(path, init);
    return { status, ok: status < 400, text: async () => JSON.stringify(body) };
  };
  return calls;
}

await test('未启用：NullProvider，调用直接报未启用', async () => {
  const calls = fakeFetch(() => [200, { enabled: false, providers: [] }]);
  const { getAI, NullProvider, AIDisabledError } = await load();
  const ai = await getAI();
  assert.ok(ai instanceof NullProvider);
  assert.equal(ai.enabled, false);
  assert.equal(ai.supports('formula'), false);
  await assert.rejects(ai.formula('求和'), AIDisabledError);
  await assert.rejects(ai.complete('hi'), AIDisabledError);
  assert.equal(calls.length, 1, '只问了一次 capabilities');
  await getAI();
  assert.equal(calls.length, 1, '结果被缓存');
});

await test('启用后：按功能转发到服务端', async () => {
  const calls = fakeFetch((path) => path === '/api/ai/capabilities'
    ? [200, { enabled: true, providers: [{ id: 'x', name: 'X', features: ['formula'] }] }]
    : [200, { formula: '=SUM(A1:A3)', explanation: '求和' }]);
  const { getAI, RemoteProvider, AIDisabledError } = await load();
  const ai = await getAI();
  assert.ok(ai instanceof RemoteProvider);
  assert.equal(ai.supports('formula'), true);
  assert.deepEqual(await ai.formula('A1 到 A3 求和', { range: 'A1:A3' }), { formula: '=SUM(A1:A3)', explanation: '求和' });
  assert.deepEqual(calls.at(-1), ['/api/ai/formula', 'POST', { question: 'A1 到 A3 求和', range: 'A1:A3' }]);
  await assert.rejects(ai.complete('hi'), AIDisabledError, '没登记 complete 的提供方');
});

await test('capabilities 出错也当作未启用', async () => {
  fakeFetch(() => [500, { error: { code: 'internal_error', message: 'x' } }]);
  const { getAI, NullProvider } = await load();
  assert.ok((await getAI()) instanceof NullProvider);
});

if (failures) { console.error(`\n${failures} 个 AI 测试失败`); process.exit(1); }
console.log('\nAI 占位测试全部通过');
