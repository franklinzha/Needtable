/**
 * P6 附件：存在表自己的 DO SQLite 里（不依赖 R2，免信用卡）。
 *
 * 覆盖：多块往返、权限、大小与配额、文件名清洗、下载响应头、
 * 宽限期后的垃圾回收，以及引用随插删行列移动。
 */

import assert from 'node:assert/strict';
import { installWorkerGlobals, makeDO } from './do-stub.mjs';

installWorkerGlobals();
const { TableDO, MAX_FILE_BYTES } = await import('../worker/do/TableDO.js');
const { GridModel } = await import('../public/js/grid/model.js');
const { normalizeOps } = await import('../public/shared/model/ops.js');
const { adjustProps } = await import('../public/shared/model/sheet.js');

let failures = 0;
async function test(name, fn) {
  try { await fn(); console.log('  ok   ' + name); }
  catch (err) { failures++; console.error('  FAIL ' + name + '\n       ' + (err.stack ?? err.message)); }
}

function clean(ops) {
  const r = normalizeOps(ops);
  assert.ok(Array.isArray(r) || Array.isArray(r?.ops), '被拒绝：' + JSON.stringify(r));
  return Array.isArray(r) ? r : r.ops;
}

/** @param {any} h @param {Uint8Array} bytes */
function put(h, bytes, { name = 'a.bin', type = 'application/octet-stream', role = 'editor' } = {}) {
  return h.obj.fetch(new Request('https://do/files', {
    method: 'POST',
    body: bytes,
    headers: {
      'x-user-id': 'u1', 'x-user-role': role, 'x-table-id': 't1',
      'content-length': String(bytes.length),
      'x-file-name': encodeURIComponent(name), 'x-file-type': type,
    },
  }));
}

function get(h, id) {
  return h.obj.fetch(new Request('https://do/files/' + id, {
    headers: { 'x-user-id': 'u1', 'x-user-role': 'viewer', 'x-table-id': 't1' },
  }));
}

function pattern(n) {
  const b = new Uint8Array(n);
  for (let i = 0; i < n; i++) b[i] = (i * 31 + (i >> 10)) & 255;
  return b;
}

const count = (h, q, ...binds) => Number([...h.ctx.storage.sql.exec(q, ...binds)][0].n);

await test('上传 2.5MB（3 块）后原样下载回来', async () => {
  const h = makeDO(TableDO);
  const bytes = pattern(2.5 * 1024 * 1024);
  const res = await put(h, bytes, { name: '报告.pdf', type: 'application/pdf' });
  assert.equal(res.status, 201);
  const meta = await res.json();
  assert.match(meta.id, /^f_[a-z0-9]{12,32}$/);
  assert.deepEqual({ n: meta.n, t: meta.t, s: meta.s }, { n: '报告.pdf', t: 'application/pdf', s: bytes.length });
  assert.equal(count(h, 'SELECT COUNT(*) AS n FROM file_chunks WHERE id = ?', meta.id), 3);

  const dl = await get(h, meta.id);
  assert.equal(dl.status, 200);
  const back = new Uint8Array(await dl.arrayBuffer());
  assert.equal(back.length, bytes.length);
  assert.ok(Buffer.from(back).equals(Buffer.from(bytes)), '内容不一致');
});

await test('非图片一律作为下载、octet-stream，带沙箱 CSP', async () => {
  const h = makeDO(TableDO);
  const meta = await (await put(h, pattern(100), { name: 'x.html', type: 'text/html' })).json();
  const dl = await get(h, meta.id);
  assert.equal(dl.headers.get('content-type'), 'application/octet-stream');
  assert.equal(dl.headers.get('content-disposition'), "attachment; filename*=UTF-8''x.html");
  assert.match(dl.headers.get('content-security-policy'), /sandbox/);
  assert.equal(dl.headers.get('content-length'), '100');
});

await test('白名单图片内联显示，文件名 UTF-8 编码', async () => {
  const h = makeDO(TableDO);
  const meta = await (await put(h, pattern(50), { name: '截图 1.png', type: 'image/png' })).json();
  const dl = await get(h, meta.id);
  assert.equal(dl.headers.get('content-type'), 'image/png');
  assert.equal(dl.headers.get('content-disposition'), "inline; filename*=UTF-8''" + encodeURIComponent('截图 1.png'));
  assert.match(dl.headers.get('cache-control'), /immutable/);
});

await test('只读用户上传被拒 403', async () => {
  const h = makeDO(TableDO);
  assert.equal((await put(h, pattern(10), { role: 'viewer' })).status, 403);
});

await test('超过 10MB 被拒 413，空文件 400，都不落库', async () => {
  const h = makeDO(TableDO);
  assert.equal((await put(h, new Uint8Array(MAX_FILE_BYTES + 1))).status, 413);
  assert.equal((await put(h, new Uint8Array(0))).status, 400);
  assert.equal(count(h, 'SELECT COUNT(*) AS n FROM files'), 0);
});

await test('单表 200MB 配额：用满后再传被拒', async () => {
  const h = makeDO(TableDO);
  h.ctx.storage.sql.exec("INSERT INTO files (id, name, type, size, chunks, created_by, created_at) VALUES ('f_big', 'big', 'x/y', ?, 0, 'u1', ?)",
    199 * 1024 * 1024, Date.now());
  assert.equal((await put(h, pattern(512 * 1024))).status, 201);
  const res = await put(h, pattern(1024 * 1024));
  assert.equal(res.status, 413);
  assert.match((await res.json()).error.message, /上限/);
});

await test('文件名去掉路径与控制字符，非法类型退回 octet-stream', async () => {
  const h = makeDO(TableDO);
  const m1 = await (await put(h, pattern(5), { name: 'C:\\dir\\a"b\u0007.txt', type: 'Text/Plain' })).json();
  assert.equal(m1.n, 'ab.txt');
  assert.equal(m1.t, 'text/plain');
  const m2 = await (await put(h, pattern(5), { name: '../../etc/passwd', type: 'not a type' })).json();
  assert.equal(m2.n, 'passwd');
  assert.equal(m2.t, 'application/octet-stream');
  const m3 = await (await put(h, pattern(5), { name: '' })).json();
  assert.equal(m3.n, '附件');
});

await test('不存在的附件 404', async () => {
  const h = makeDO(TableDO);
  assert.equal((await get(h, 'f_00000000000000000000')).status, 404);
});

await test('垃圾回收：过了宽限期且没人引用的才删', async () => {
  const h = makeDO(TableDO);
  const sql = h.ctx.storage.sql;
  const keep = await (await put(h, pattern(10))).json();
  const drop = await (await put(h, pattern(10))).json();
  const fresh = await (await put(h, pattern(10))).json();
  const res = h.obj.applyOps(clean([{ t: 'setProp', key: 'files', value: [[0, 0, [keep]]] }]), 'u1');
  assert.ok(!('error' in res), JSON.stringify(res));
  const old = Date.now() - 4 * 24 * 3600 * 1000;
  sql.exec('UPDATE files SET created_at = ? WHERE id IN (?, ?)', old, keep.id, drop.id);
  await h.obj.alarm();
  const left = [...sql.exec('SELECT id FROM files')].map((r) => r.id).sort();
  assert.deepEqual(left, [keep.id, fresh.id].sort());
  assert.equal(count(h, 'SELECT COUNT(*) AS n FROM file_chunks WHERE id = ?', drop.id), 0);
  assert.equal((await get(h, drop.id)).status, 404);
  assert.equal((await get(h, keep.id)).status, 200);
  await h.settle();
});

await test('引用随插入行 / 删除列移动，被删格子的引用消失', () => {
  const f = [{ id: 'f_a', n: 'a', t: 'x/y', s: 1 }];
  const out = adjustProps({ files: [[2, 1, f], [0, 3, f]] }, 'row', 1, 2);
  assert.deepEqual(out.files, [[4, 1, f], [0, 3, f]]);
  const out2 = adjustProps({ files: [[2, 1, f], [0, 3, f]] }, 'col', 1, -1);
  assert.deepEqual(out2.files, [[0, 2, f]]);
});

await test('浏览器模型与 DO 对附件引用的结构变化一致，撤销能恢复', async () => {
  const h = makeDO(TableDO);
  const m = new GridModel();
  m.loadSnapshot(await h.state());
  const f = [{ id: 'f_a', n: 'a.png', t: 'image/png', s: 9 }];
  const steps = [
    [{ t: 'setProp', key: 'files', value: [[3, 2, f]] }],
    [{ t: 'insertRows', at: 0, n: 1 }],
    [{ t: 'deleteCols', at: 0, n: 1 }],
  ];
  let inv = null;
  for (const s of steps) {
    const c = clean(s);
    const res = h.obj.applyOps(c, 'u1');
    assert.ok(!('error' in res), JSON.stringify(res));
    inv = m.apply(c);
  }
  assert.deepEqual(m.props.files, [[4, 1, f]]);
  assert.deepEqual((await h.state()).props.files, [[4, 1, f]]);
  m.apply(inv);
  assert.deepEqual(m.props.files, [[4, 2, f]]);
  await h.settle();
});

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
