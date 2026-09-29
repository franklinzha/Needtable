/**
 * 认证三块基石的单元测试：TOTP、口令哈希、会话 Cookie。
 *
 * TOTP 那部分对着 RFC 6238 附录 B 的官方向量跑 —— 自己实现的 OTP 如果只和
 * 自己对得上，那等于没测：用户手机上的 Google Authenticator 才是真正的对端。
 * 官方向量给的是 8 位码，6 位取末 6 位（RFC 6238 §1.2 的截断规则）。
 */

import assert from 'node:assert/strict';

import {
  TOTP, newTotpSecret, totpCode, currentStep, verifyTotp, normalizeCode,
  otpauthUri, encryptSecret, decryptSecret, base32ToBytes,
} from './totp.js';
import {
  PW_VERSION, newServerSalt, hashLoginKey, verifyLoginKey, dummyVerify, parseDk,
} from './password.js';
import {
  SESSION_TTL_MS, cookieName, signSession, verifySession,
  readSessionCookie, sessionCookieHeader, clearCookieHeader, withCookie,
} from './session.js';
import { KDF, deriveLoginKey } from '../../public/shared/util/kdf.js';
import { bytesToB64url } from '../../public/shared/util/b64.js';

const env = { AUTH_PEPPER: 'pepper-for-tests-only-0123456789', SESSION_SECRET: 'session-secret-for-tests' };

let failures = 0;
/** @param {string} name @param {() => any} fn */
async function test(name, fn) {
  try { await fn(); console.log('  ok   ' + name); }
  catch (err) { failures++; console.error('  FAIL ' + name + '\n       ' + err.message); }
}

// ── TOTP ────────────────────────────────────────────────────────────────────

// RFC 6238 附录 B 的种子："12345678901234567890"（ASCII），HMAC-SHA1
const RFC_SEED = new TextEncoder().encode('12345678901234567890');

await test('RFC 6238 官方向量（取 6 位）', async () => {
  /** @type {[number, string][]} T(秒) → 期望码 */
  const vectors = [
    [59, '287082'],           // 8 位原值 94287082
    [1111111109, '081804'],   // 07081804
    [1111111111, '050471'],   // 14050471
    [1234567890, '005924'],   // 89005924
    [2000000000, '279037'],   // 69279037
    [20000000000, '353130'],  // 65353130 —— 这一条超过 32 位，专门验 BigInt 计数器
  ];
  for (const [t, want] of vectors) {
    const step = Math.floor(t / TOTP.stepSeconds);
    assert.equal(await totpCode(RFC_SEED, step), want, 'T=' + t);
  }
});

await test('currentStep 与 RFC 的 T 定义一致', () => {
  assert.equal(currentStep(59_000), Math.floor(59 / 30));
  assert.equal(currentStep(0), 0);
});

await test('±1 个时间窗容错，±2 就不认了', async () => {
  const secret = newTotpSecret();
  const now = Date.now();
  const step = currentStep(now);
  for (const d of [-1, 0, 1]) {
    const code = await totpCode(secret, step + d);
    const r = await verifyTotp(secret, code, { nowMs: now });
    assert.ok(r.ok, '偏移 ' + d + ' 应通过');
  }
  for (const d of [-2, 2]) {
    const code = await totpCode(secret, step + d);
    const r = await verifyTotp(secret, code, { nowMs: now });
    assert.equal(r.ok, false, '偏移 ' + d + ' 不该通过');
  }
});

await test('同一个码不能用第二次（30 秒内的重放）', async () => {
  const secret = newTotpSecret();
  const now = Date.now();
  const code = await totpCode(secret, currentStep(now));

  const first = await verifyTotp(secret, code, { nowMs: now, lastStep: 0 });
  assert.ok(first.ok);
  const again = await verifyTotp(secret, code, { nowMs: now, lastStep: first.step });
  assert.equal(again.ok, false);
  assert.equal(again.reason, 'replay');
});

await test('上一个窗口的码在记过 lastStep 之后也不认', async () => {
  const secret = newTotpSecret();
  const now = Date.now();
  const step = currentStep(now);
  const older = await totpCode(secret, step - 1);
  const r = await verifyTotp(secret, older, { nowMs: now, lastStep: step });
  assert.equal(r.ok, false, 'hit <= lastStep 必须拒绝');
});

await test('动态码格式清洗：空格、连字符可以，字母不行', () => {
  assert.equal(normalizeCode('123 456'), '123456');
  assert.equal(normalizeCode('123-456'), '123456');
  assert.equal(normalizeCode(' 000000 '), '000000');
  assert.equal(normalizeCode('12345'), null);
  assert.equal(normalizeCode('1234567'), null);
  assert.equal(normalizeCode('12345a'), null);
  assert.equal(normalizeCode(null), null);
  assert.equal(normalizeCode(undefined), null);
});

await test('otpauth URI 能被标准解析，且密钥可还原', () => {
  const secret = newTotpSecret();
  const uri = otpauthUri({ issuer: 'Table', email: 'a@b.com', secret });
  const u = new URL(uri);
  assert.equal(u.protocol, 'otpauth:');
  assert.equal(u.searchParams.get('algorithm'), 'SHA1');
  assert.equal(u.searchParams.get('digits'), '6');
  assert.equal(u.searchParams.get('period'), '30');
  assert.equal(u.searchParams.get('issuer'), 'Table');
  assert.deepEqual([...base32ToBytes(u.searchParams.get('secret'))], [...secret]);
  assert.ok(uri.includes('Table%3Aa%40b.com') || uri.includes('Table:a%40b.com'), 'label 应带 issuer 前缀');
});

await test('TOTP 密钥在库里是密文，换了 pepper 就解不开', async () => {
  const secret = newTotpSecret();
  const stored = await encryptSecret(secret, env);
  assert.ok(!stored.includes(bytesToB64url(secret)), '密文里不该出现明文密钥');
  assert.deepEqual([...(await decryptSecret(stored, env))], [...secret]);

  assert.equal(await decryptSecret(stored, { AUTH_PEPPER: 'another-pepper' }), null);
  assert.equal(await decryptSecret('不是合法的密文', env), null);
  assert.equal(await decryptSecret('AAAA', env), null);
});

// ── 口令 ────────────────────────────────────────────────────────────────────

await test('口令哈希：对的过、错的不过', async () => {
  const dk = crypto.getRandomValues(new Uint8Array(32));
  const salt = newServerSalt();
  const hash = await hashLoginKey(dk, salt, env);

  assert.equal(await verifyLoginKey(dk, salt, hash, env), true);

  const wrong = Uint8Array.from(dk); wrong[0] ^= 1;
  assert.equal(await verifyLoginKey(wrong, salt, hash, env), false, '差一位就该失败');
  assert.equal(await verifyLoginKey(dk, newServerSalt(), hash, env), false, '换盐应失败');
  assert.equal(await verifyLoginKey(dk, salt, hash, { AUTH_PEPPER: 'x' }), false, '换 pepper 应失败');
});

await test('同样的口令，两个账号入库的哈希不同', async () => {
  const dk = crypto.getRandomValues(new Uint8Array(32));
  const a = await hashLoginKey(dk, newServerSalt(), env);
  const b = await hashLoginKey(dk, newServerSalt(), env);
  assert.notEqual(a, b, '每用户随机盐必须起作用');
});

await test('哈希字段损坏时返回 false 而不是抛异常', async () => {
  const dk = crypto.getRandomValues(new Uint8Array(32));
  const salt = newServerSalt();
  for (const broken of ['', '!!!', 'AAAA', 'x'.repeat(200)]) {
    assert.equal(await verifyLoginKey(dk, salt, broken, env), false, JSON.stringify(broken));
  }
});

await test('没配 AUTH_PEPPER 就抛错，不能静默降级', async () => {
  await assert.rejects(() => hashLoginKey(new Uint8Array(32), newServerSalt(), {}));
});

await test('dummyVerify 不抛错（账号不存在时要走这条路）', async () => {
  assert.equal(await dummyVerify(env), false);
});

await test('parseDk 只接受精确 32 字节的 base64url', () => {
  assert.equal(parseDk(bytesToB64url(new Uint8Array(32)))?.length, 32);
  assert.equal(parseDk(bytesToB64url(new Uint8Array(31))), null);
  assert.equal(parseDk(bytesToB64url(new Uint8Array(33))), null);
  assert.equal(parseDk(''), null);
  assert.equal(parseDk(null), null);
  assert.equal(parseDk(123), null);
  assert.equal(parseDk('A'.repeat(200)), null, '过长的输入直接拒，别先去解码');
});

await test('客户端 KDF 与服务端版本号对齐', () => {
  assert.equal(KDF.version, PW_VERSION, 'kdf.js 与 password.js 的版本必须一致');
  assert.equal(KDF.dkBytes, 32);
  assert.ok(KDF.iterations >= 600_000, '迭代数不能降到 OWASP 建议值以下');
});

await test('端到端：浏览器派生 → 服务端入库 → 再次登录校验通过', async () => {
  // 迭代数调低只为测试跑得快；算法路径与线上完全一致。
  const dk1 = await deriveLoginKey('correct horse battery staple', 'A@Example.com ', 1000);
  const salt = newServerSalt();
  const stored = await hashLoginKey(dk1, salt, env);

  // 下次登录时邮箱大小写、空格都可能不一样 —— 盐是规范化之后派生的，应当仍然对得上
  const dk2 = await deriveLoginKey('correct horse battery staple', 'a@example.com', 1000);
  assert.equal(await verifyLoginKey(dk2, salt, stored, env), true);

  const dk3 = await deriveLoginKey('correct horse battery stapl', 'a@example.com', 1000);
  assert.equal(await verifyLoginKey(dk3, salt, stored, env), false);
});

// ── 会话 ────────────────────────────────────────────────────────────────────

const user = { id: 'usr_1', email: 'a@b.com', session_epoch: 3 };

await test('会话签发与验签', async () => {
  const now = Date.now();
  const token = await signSession(user, env, now);
  const s = await verifySession(token, env, now);
  assert.ok(s);
  assert.equal(s.uid, 'usr_1');
  assert.equal(s.email, 'a@b.com');
  assert.equal(s.epoch, 3);
  assert.equal(s.iat, now);
  assert.equal(s.exp, now + SESSION_TTL_MS);
});

await test('改一个字节就验不过（载荷、签名都试）', async () => {
  const token = await signSession(user, env, Date.now());
  const [body, sig] = token.split('.');

  const tamperedBody = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(body, 'base64url').toString()), epoch: 99 }))
    .toString('base64url');
  assert.equal(await verifySession(tamperedBody + '.' + sig, env), null, '改 epoch 应失败');

  assert.equal(await verifySession(body + '.' + sig.slice(0, -2) + 'AA', env), null, '改签名应失败');
  assert.equal(await verifySession(body, env), null, '没有签名段');
  assert.equal(await verifySession('.' + sig, env), null, '没有载荷段');
  assert.equal(await verifySession('', env), null);
});

await test('换了 SESSION_SECRET，旧 Cookie 全部作废', async () => {
  const token = await signSession(user, env, Date.now());
  assert.equal(await verifySession(token, { SESSION_SECRET: 'rotated' }), null);
});

await test('过期即失效', async () => {
  const now = Date.now();
  const token = await signSession(user, env, now);
  assert.ok(await verifySession(token, env, now + SESSION_TTL_MS - 1000));
  assert.equal(await verifySession(token, env, now + SESSION_TTL_MS + 1), null);
});

await test('Cookie 属性：https 用 __Host- 前缀且必须 Secure', () => {
  const https = new URL('https://table.example.com/x');
  const http = new URL('http://localhost:8787/x');

  assert.equal(cookieName(https), '__Host-tbl_sess');
  assert.equal(cookieName(http), 'tbl_sess', '本地 http 下用不了 __Host-（它强制要求 Secure）');

  const h = sessionCookieHeader('tok', https);
  assert.ok(h.startsWith('__Host-tbl_sess=tok'));
  assert.ok(h.includes('Secure'), '__Host- 前缀要求 Secure');
  assert.ok(h.includes('Path=/'), '__Host- 前缀要求 Path=/');
  assert.ok(!h.includes('Domain='), '__Host- 前缀不允许 Domain');
  assert.ok(h.includes('HttpOnly'), 'XSS 不该拿得到会话');
  assert.ok(h.includes('SameSite=Strict'), 'CSRF 防护靠它');

  assert.ok(!sessionCookieHeader('tok', http).includes('Secure'), '本地 http 不能带 Secure，否则存不下');
});

await test('登出用的 Cookie 立刻过期', () => {
  const h = clearCookieHeader(new URL('https://table.example.com/'));
  assert.ok(h.includes('Max-Age=0'));
  assert.ok(h.startsWith('__Host-tbl_sess='));
});

await test('从一堆 Cookie 里挑出自己那个', () => {
  const url = new URL('https://table.example.com/');
  const request = new Request(url, {
    headers: { cookie: 'other=1; __Host-tbl_sess=the-token; another=2' },
  });
  assert.equal(readSessionCookie(request, url), 'the-token');

  assert.equal(readSessionCookie(new Request(url), url), null);
  // 名字只差前缀的不能误认 —— http 下的 tbl_sess 不该被 https 请求当成自己的
  assert.equal(
    readSessionCookie(new Request(url, { headers: { cookie: 'tbl_sess=wrong' } }), url),
    null,
  );
});

await test('withCookie 保留原响应的状态与响应体', async () => {
  const res = withCookie(new Response('hi', { status: 302, headers: { location: '/login' } }), 'a=b');
  assert.equal(res.status, 302);
  assert.equal(res.headers.get('location'), '/login');
  assert.equal(res.headers.get('set-cookie'), 'a=b');
  assert.equal(await res.text(), 'hi');
});

console.log(failures === 0 ? '\nALL PASS' : '\n' + failures + ' FAILED');
if (failures > 0) process.exit(1);
