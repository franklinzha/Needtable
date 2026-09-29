/**
 * 主题配色：24 套内置配色推导出的界面颜色都够清楚（WCAG 对比度 ≥ 4.5），
 * 以及「自己选配色 / 管理员设默认、增删配色」的接口。接口测试用 node:sqlite + 真实迁移顶替 D1。
 */

import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { installWorkerGlobals } from './do-stub.mjs';

installWorkerGlobals();
const T = await import('../public/shared/theme.js');
const { DatabaseSync } = await import('node:sqlite');
const { getMe } = await import('../worker/routes/me.js');
const { putMyTheme, putAdminTheme } = await import('../worker/routes/theme.js');
const { putMyLang } = await import('../worker/routes/lang.js');

let failures = 0;
async function test(name, fn) {
  try { await fn(); console.log('  ok   ' + name); }
  catch (err) { failures++; console.error('  FAIL ' + name + '\n       ' + (err.stack ?? err.message)); }
}

await test('24 套内置配色，编号唯一，默认是 Pastel Dreams（马卡龙）', () => {
  assert.equal(T.PALETTES.length, 24);
  assert.equal(new Set(T.PALETTES.map((p) => p.id)).size, 24);
  assert.equal(T.PALETTES[0].id, T.DEFAULT_THEME);
  assert.deepEqual(T.PALETTES[0].colors, ['#ff99c8', '#fcf6bd', '#d0f4de', '#a9def9', '#e4c1f9']);
  for (const p of T.PALETTES) assert.ok(p.colors.length === 5 && p.colors.every(T.isHex), p.name);
});

await test('每套配色推导出的文字 / 强调色在亮色、暗色下对比度都 ≥ 4.5', () => {
  const bad = [];
  const need = (p, what, a, b) => { const k = T.contrast(a, b); if (k < 4.5) bad.push(p.name + ' ' + what + ' ' + k.toFixed(2)); };
  for (const p of T.PALETTES) {
    const { light: L, dark: D } = T.themeVars(p.colors);
    need(p, '亮 正文/背景', L['--c-text'], L['--c-bg']);
    need(p, '亮 强调色/背景', L['--c-accent'], L['--c-bg']);
    need(p, '亮 强调色/浅强调底', L['--c-accent'], L['--c-accent-soft']);
    need(p, '亮 按钮文字', L['--c-on-accent'], L['--c-accent']);
    need(p, '亮 次要文字', L['--c-text-muted'], L['--c-bg-subtle']);
    need(p, '暗 正文/背景', D['--c-text'], D['--c-bg']);
    need(p, '暗 强调色/卡片', D['--c-accent'], D['--c-surface']);
    need(p, '暗 强调色/浅强调底', D['--c-accent'], D['--c-accent-soft']);
    need(p, '暗 按钮文字', D['--c-on-accent'], D['--c-accent']);
    need(p, '暗 次要文字', D['--c-text-muted'], D['--c-surface']);
  }
  assert.deepEqual(bad, []);
});

await test('cleanTheme：名字、5 个 #rrggbb、编号格式', () => {
  const ok = T.cleanTheme({ id: 'c_abcd1234', name: '  春日  樱花 ', colors: ['#FFCAD4', '#f4acb7', '#9d8189', '#d8e2dc', '#ffe5d9'] });
  assert.deepEqual(ok, { id: 'c_abcd1234', name: '春日 樱花', colors: ['#ffcad4', '#f4acb7', '#9d8189', '#d8e2dc', '#ffe5d9'], custom: true });
  assert.equal(T.cleanTheme({ id: 'c_abcd1234', name: '', colors: ok.colors }), null);
  assert.equal(T.cleanTheme({ id: 'c_abcd1234', name: 'x', colors: ok.colors.slice(0, 4) }), null);
  assert.equal(T.cleanTheme({ id: 'c_abcd1234', name: 'x', colors: [...ok.colors.slice(0, 4), 'red'] }), null);
  assert.equal(T.cleanTheme({ id: 'pastel-dreams', name: 'x', colors: ok.colors }), null);
  assert.equal(T.findTheme('soft-sand')?.name, 'Soft Sand');
  assert.equal(T.findTheme('c_abcd1234', [ok])?.name, '春日 樱花');
  assert.equal(T.findTheme('nope'), null);
});

// ── 接口 ────────────────────────────────────────────────────────────────────

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const MIGRATIONS = readdirSync(join(ROOT, 'migrations')).filter((f) => f.endsWith('.sql')).sort()
  .map((f) => readFileSync(join(ROOT, 'migrations', f), 'utf8'));

function setup() {
  const db = new DatabaseSync(':memory:');
  for (const m of MIGRATIONS) db.exec(m);
  const DB = {
    prepare: (sql) => {
      let args = [];
      const s = {
        bind: (...a) => { args = a; return s; },
        first: async () => db.prepare(sql).get(...args) ?? null,
        all: async () => ({ results: db.prepare(sql).all(...args) }),
        run: async () => { db.prepare(sql).run(...args); return { success: true }; },
      };
      return s;
    },
  };
  const now = Date.now();
  for (const [id, role] of [['usr_admin', 'admin'], ['usr_bob', 'pro']]) {
    db.prepare("INSERT INTO users (id, email, name, role, created_at, last_seen_at, status, session_epoch) VALUES (?,?,?,?,?,?,'active',1)")
      .run(id, id + '@x.com', id, role, now, now);
  }
  const env = { DB };
  const url = new URL('https://table.example.com/api/x');
  const call = async (fn, who, body) => {
    const request = new Request(url, body === undefined ? { method: 'GET' } : { method: 'PUT', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } });
    const res = await fn(request, { env, url, params: {}, user: { id: who, email: who + '@x.com', name: who, role: who === 'usr_admin' ? 'admin' : 'pro' }, identity: { via: 'password' } });
    return { status: res.status, body: await res.json() };
  };
  return { call };
}

await test('/api/me 带主题信息；自己选配色、选回跟随默认', async () => {
  const { call } = setup();
  let me = await call(getMe, 'usr_bob');
  assert.deepEqual(me.body.theme, { mine: null, def: 'pastel-dreams', custom: [] });
  const r = await call(putMyTheme, 'usr_bob', { theme: 'soft-sand' });
  assert.equal(r.status, 200);
  assert.equal(r.body.mine, 'soft-sand');
  me = await call(getMe, 'usr_bob');
  assert.equal(me.body.theme.mine, 'soft-sand');
  assert.equal((await call(getMe, 'usr_admin')).body.theme.mine, null);   // 只影响自己
  assert.equal((await call(putMyTheme, 'usr_bob', { theme: 'no-such' })).status, 400);
  assert.equal((await call(putMyTheme, 'usr_bob', { theme: null })).body.mine, null);
});

await test('管理员：加配色、设系统默认、删掉默认那套退回马卡龙；普通用户不能改', async () => {
  const { call } = setup();
  const mine = { id: 'c_sakura01', name: '春日樱花', colors: ['#ffcad4', '#f4acb7', '#9d8189', '#d8e2dc', '#ffe5d9'] };
  assert.equal((await call(putAdminTheme, 'usr_bob', { def: 'soft-sand' })).status, 403);
  let r = await call(putAdminTheme, 'usr_admin', { custom: [mine] });
  assert.equal(r.status, 200);
  assert.equal(r.body.custom[0].name, '春日樱花');
  r = await call(putAdminTheme, 'usr_admin', { def: 'c_sakura01' });
  assert.equal(r.body.def, 'c_sakura01');
  // 别人没选过 → 看到的就是新默认；也能选这套自定义配色
  assert.equal((await call(getMe, 'usr_bob')).body.theme.def, 'c_sakura01');
  assert.equal((await call(putMyTheme, 'usr_bob', { theme: 'c_sakura01' })).body.mine, 'c_sakura01');
  // 删掉：默认退回马卡龙，选过它的人当作没选
  r = await call(putAdminTheme, 'usr_admin', { custom: [] });
  assert.equal(r.body.def, 'pastel-dreams');
  const bob = (await call(getMe, 'usr_bob')).body.theme;
  assert.deepEqual([bob.mine, bob.def], [null, 'pastel-dreams']);
  // 校验
  assert.equal((await call(putAdminTheme, 'usr_admin', { def: 'no-such' })).status, 400);
  assert.equal((await call(putAdminTheme, 'usr_admin', { custom: [{ ...mine, colors: ['#fff'] }] })).status, 400);
  assert.equal((await call(putAdminTheme, 'usr_admin', { custom: [mine, mine] })).status, 400);
  assert.equal((await call(putAdminTheme, 'usr_admin', {})).status, 400);
  const many = Array.from({ length: T.MAX_CUSTOM_THEMES + 1 }, (_, i) => ({ ...mine, id: 'c_many' + String(i).padStart(4, '0') }));
  assert.equal((await call(putAdminTheme, 'usr_admin', { custom: many })).status, 400);
});

await test('界面语言偏好：/api/me 带 lang，自己选、只影响自己，不认识的语言 400', async () => {
  const { call } = setup();
  assert.equal((await call(getMe, 'usr_bob')).body.lang, null);
  const r = await call(putMyLang, 'usr_bob', { lang: 'ja' });
  assert.equal(r.status, 200);
  assert.equal(r.body.lang, 'ja');
  assert.equal((await call(getMe, 'usr_bob')).body.lang, 'ja');
  assert.equal((await call(getMe, 'usr_admin')).body.lang, null);   // 只影响自己
  assert.equal((await call(putMyLang, 'usr_bob', { lang: 'de' })).status, 400);
  assert.equal((await call(putMyLang, 'usr_bob', {})).status, 400);
  assert.equal((await call(getMe, 'usr_bob')).body.lang, 'ja');
});

if (failures) { console.error(`\n${failures} 个主题配色测试失败`); process.exit(1); }
console.log('\n主题配色测试全部通过');
