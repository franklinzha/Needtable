/** WS ticket 的签发与校验。这是实时通道唯一的闸门，所以每种伪造方式都要试一遍。 */

import assert from 'node:assert/strict';
import { signTicket, verifyTicket } from './ticket.js';

const SECRET = 'test-secret-' + 'x'.repeat(24);
const base = { uid: 'usr_1', email: 'a@b.com', tableId: 'tbl_1', role: 'editor' };

let failures = 0;
async function test(name, fn) {
  try { await fn(); console.log('  ok   ' + name); }
  catch (err) { failures++; console.error('  FAIL ' + name + '\n       ' + err.message); }
}

await test('签发的票能通过校验，身份原样带出', async () => {
  const t = await signTicket(base, SECRET);
  const p = await verifyTicket(t, SECRET);
  assert.ok(p);
  assert.equal(p.uid, 'usr_1');
  assert.equal(p.tableId, 'tbl_1');
  assert.equal(p.role, 'editor');
  assert.ok(p.nonce.length >= 12, 'nonce 应足够长');
});

await test('每次签发的 nonce 都不同（否则防重放形同虚设）', async () => {
  const a = await verifyTicket(await signTicket(base, SECRET), SECRET);
  const b = await verifyTicket(await signTicket(base, SECRET), SECRET);
  assert.notEqual(a.nonce, b.nonce);
});

await test('换密钥验不过', async () => {
  const t = await signTicket(base, SECRET);
  assert.equal(await verifyTicket(t, SECRET + '!'), null);
});

await test('改 payload 后验不过（提权尝试）', async () => {
  const t = await signTicket({ ...base, role: 'viewer' }, SECRET);
  const [body, sig] = t.split('.');
  const p = JSON.parse(Buffer.from(body, 'base64url').toString());
  p.role = 'owner';
  const forged = Buffer.from(JSON.stringify(p)).toString('base64url') + '.' + sig;
  assert.equal(await verifyTicket(forged, SECRET), null);
});

await test('过期票验不过', async () => {
  const t = await signTicket({ ...base, ttlSeconds: -1 }, SECRET);
  assert.equal(await verifyTicket(t, SECRET), null);
});

await test('畸形输入不抛异常，一律返回 null', async () => {
  for (const bad of ['', '.', 'abc', 'abc.', '.abc', 'a.b.c', 'Zm9v.!!!']) {
    assert.equal(await verifyTicket(bad, SECRET), null, JSON.stringify(bad));
  }
});

console.log(failures === 0 ? '\nALL PASS' : '\n' + failures + ' FAILED');
if (failures > 0) process.exit(1);
