/** 文档 / 幻灯片导入导出：docx、pptx 写出再读回，iWork（Snappy + protobuf）文字提取。 */
import assert from 'node:assert/strict';
import { zipStore, unzip } from '../public/js/io/zip.js';
import { toDocx, fromDocx } from '../public/js/io/docx.js';
import { toPptx, fromPptx } from '../public/js/io/pptx.js';
import { fromMarkdown, fitSize } from '../public/js/doc/exchange.js';
import { snappy, iwaData, iwaArchives, pbFields, fromPages, fromKeynote } from '../public/js/io/iwork.js';

let failures = 0;
async function test(name, fn) {
  try { await fn(); console.log('  ok   ' + name); }
  catch (err) { failures++; console.error('  FAIL ' + name + '\n       ' + (err.stack ?? err.message)); }
}

const PNG = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3]);
const text = (/** @type {any} */ b) => (b.runs ?? []).map((/** @type {any} */ r) => r[0]).join('');

await test('zipStore → unzip 往返', async () => {
  const z = unzip(zipStore([{ name: 'a.txt', data: '你好' }, { name: 'b/c.bin', data: PNG }]));
  assert.equal(await z.get('a.txt')?.text(), '你好');
  assert.deepEqual([...(await z.get('b/c.bin')?.bytes() ?? [])], [...PNG]);
});

await test('toDocx → fromDocx：块类型、行内格式、列表、图片、题注、嵌入表格', async () => {
  const doc = { blocks: [
    { id: 'a', t: 'h1', runs: [['标题']] },
    { id: 'b', t: 'p', align: 'center', runs: [['粗', { b: 1 }], ['斜', { i: 1, c: '#ff0000' }], ['链', { a: 'https://example.com' }], ['码', { k: 1 }]] },
    { id: 'c', t: 'ul', runs: [['一']] }, { id: 'd', t: 'ul', indent: 1, runs: [['二']] },
    { id: 'e', t: 'ol', runs: [['甲']] },
    { id: 'f', t: 'todo', checked: true, runs: [['做完']] }, { id: 'g', t: 'todo', runs: [['没做']] },
    { id: 'h', t: 'hr' }, { id: 'i', t: 'img', img: 'x1', w: 50, cap: '说明' },
    { id: 'j', t: 'quote', runs: [['引']] }, { id: 'k', t: 'code', runs: [['let a = 1']] },
    { id: 'l', t: 'embed', title: '表', src: 'x' },
  ] };
  const bytes = toDocx(doc, { images: new Map([['x1', { data: PNG, type: 'image/png', w: 100, h: 50 }]]), embeds: new Map([['l', { rows: [['a', 'b'], ['1', '']] }]]), title: 'T' });
  const r = await fromDocx(bytes);
  const b = r.blocks;
  const find = (/** @type {string} */ t, /** @type {string} */ s) => b.find((x) => x.t === t && text(x).includes(s));
  assert.ok(find('h1', '标题'));
  const p = find('p', '粗');
  assert.equal(p.align, 'center');
  assert.deepEqual(p.runs.find((/** @type {any} */ x) => x[0] === '粗')[1], { b: 1 });
  assert.equal(p.runs.find((/** @type {any} */ x) => x[0] === '斜')[1].c, '#ff0000');
  assert.equal(p.runs.find((/** @type {any} */ x) => x[0] === '链')[1].a, 'https://example.com');
  assert.equal(p.runs.find((/** @type {any} */ x) => x[0] === '码')[1].k, 1);
  assert.equal(find('ul', '二').indent, 1);
  assert.ok(find('ol', '甲'));
  assert.equal(find('todo', '做完').checked, true);
  assert.ok(!find('todo', '没做').checked);
  assert.ok(b.some((x) => x.t === 'hr'));
  const img = b.find((x) => x.t === 'img');
  assert.equal(img.cap, '说明');
  assert.equal(img.w, 50);
  assert.equal(r.media.get(img.img)?.type, 'image/png');
  assert.ok(find('quote', '引'));
  assert.ok(find('code', 'let a = 1'));
  assert.equal(text(find('p', 'a')), 'a │ b');
  assert.equal(text(find('p', '1')), '1', '末尾空单元格不留分隔符');
});

await test('toPptx → fromPptx：位置、文字格式、形状、线条、图片、表格、备注', async () => {
  const deck = { slides: [
    { id: 's1', bg: '#112233', notes: '备注', els: [
      { id: 'a', t: 'text', x: 60, y: 36, w: 840, h: 80, size: 36, b: 1, color: '#ffffff', align: 'center', runs: [['大标题'], ['红', { c: '#ff0000', i: 1 }]] },
      { id: 'b', t: 'shape', shape: 'star', x: 10, y: 20, w: 100, h: 100, fill: '#ff8800', stroke: '#000000', sw: 3 },
      { id: 'c', t: 'shape', shape: 'line', x: 10, y: 300, w: 300, h: 20 },
      { id: 'd', t: 'shape', shape: 'diag', x: 400, y: 300, w: 100, h: 100, flip: true },
      { id: 'e', t: 'img', img: 'i1', x: 500, y: 100, w: 200, h: 200 },
      { id: 'f', t: 'embed', x: 100, y: 400, w: 400, h: 100, title: '区域' },
    ] },
    { id: 's2', bg: '#ffffff', els: [] },
  ] };
  const bytes = toPptx(deck, { images: new Map([['i1', { data: PNG, type: 'image/png', w: 200, h: 100 }]]), embeds: new Map([['f', { rows: [['a', 'b'], ['1', '2']] }]]), font: 'serif' });
  const r = await fromPptx(bytes);
  assert.equal(r.slides.length, 2);
  const [s] = r.slides;
  assert.equal(s.bg, '#112233');
  assert.equal(s.notes, '备注');
  const t = s.els.find((/** @type {any} */ e) => e.t === 'text' && text(e).startsWith('大标题'));
  assert.deepEqual([t.x, t.y, t.w, t.h, t.size, t.align, t.color], [60, 36, 840, 80, 36, 'center', '#ffffff']);
  assert.ok(t.runs.every((/** @type {any} */ x) => x[1]?.b), '整框加粗');
  assert.deepEqual(t.runs.find((/** @type {any} */ x) => x[0] === '红')[1], { b: 1, c: '#ff0000', i: 1 });
  const star = s.els.find((/** @type {any} */ e) => e.shape === 'star');
  assert.deepEqual([star.x, star.y, star.w, star.h, star.fill, star.stroke, star.sw], [10, 20, 100, 100, '#ff8800', '#000000', 3]);
  const line = s.els.find((/** @type {any} */ e) => e.shape === 'line');
  assert.equal(line.x, 10); assert.equal(line.w, 300);
  assert.ok(s.els.find((/** @type {any} */ e) => e.shape === 'diag').flip);
  const img = s.els.find((/** @type {any} */ e) => e.t === 'img');
  assert.deepEqual([img.x, img.y, img.w, img.h], [500, 150, 200, 100], '图片按比例放进框里');
  assert.equal(r.media.get(img.img)?.type, 'image/png');
  assert.ok(s.els.some((/** @type {any} */ e) => e.t === 'text' && text(e).includes('a │ b')));
});

// ── iWork ──────────────────────────────────────────────────────────────

/** Snappy 编码（全字面量，再加一段回溯复制考一下解码器）。 @param {Uint8Array} b */
function snappyEncode(b) {
  const out = [];
  let n = b.length;
  do { out.push((n & 0x7f) | (n > 0x7f ? 0x80 : 0)); n >>>= 7; } while (n);
  for (let p = 0; p < b.length; p += 60) {
    const c = b.subarray(p, p + 60);
    out.push((c.length - 1) << 2, ...c);
  }
  return new Uint8Array(out);
}
const varint = (/** @type {number} */ n) => { const o = []; do { o.push((n & 0x7f) | (n > 0x7f ? 0x80 : 0)); n = Math.floor(n / 128); } while (n); return o; };
const pbLen = (/** @type {number} */ f, /** @type {number[] | Uint8Array} */ b) => [...varint(f * 8 + 2), ...varint(b.length), ...b];
const pbInt = (/** @type {number} */ f, /** @type {number} */ v) => [...varint(f * 8), ...varint(v)];
const utf8 = (/** @type {string} */ s) => [...new TextEncoder().encode(s)];
/** 一条归档：ArchiveInfo + 正文。 */
function archive(/** @type {number} */ id, /** @type {number} */ type, /** @type {number[]} */ body) {
  const info = [...pbInt(1, id), ...pbLen(2, [...pbInt(1, type), ...pbInt(3, body.length)])];
  return [...varint(info.length), ...info, ...body];
}
const storage = (/** @type {number} */ kind, /** @type {string} */ s) => [...pbInt(1, kind), ...pbLen(3, utf8(s))];
/** 解压后的数据 → IWA 文件（拆两块，考多块拼接）。 @param {number[]} data */
function iwa(data) {
  const out = [];
  const half = Math.ceil(data.length / 2);
  for (const part of [data.slice(0, half), data.slice(half)]) {
    const c = snappyEncode(new Uint8Array(part));
    out.push(0, c.length & 0xff, (c.length >> 8) & 0xff, c.length >> 16, ...c);
  }
  return new Uint8Array(out);
}

await test('页面大小：pptx 按 deck.size 导出、导入带回 size；docx 纸张大小', async () => {
  const deck = { size: { w: 960, h: 720 }, slides: [{ id: 's', bg: '#ffffff', els: [{ id: 'e', t: 'shape', shape: 'rect', x: 0, y: 600, w: 960, h: 120, fill: '#ff0000' }] }] };
  const r = await fromPptx(toPptx(deck));
  assert.deepEqual(r.size, { w: 960, h: 720 });
  const el = r.slides[0].els.find((/** @type {any} */ e) => e.t === 'shape');
  assert.deepEqual([el.x, el.y, el.w, el.h], [0, 600, 960, 120]);
  assert.deepEqual((await fromPptx(toPptx({ slides: deck.slides }))).size, { w: 960, h: 540 });
  const xml = async (/** @type {any} */ doc) => unzip(toDocx(doc)).get('word/document.xml')?.text();
  assert.match(await xml({ blocks: [], size: { w: 1123, h: 794 } }), /<w:pgSz w:w="16845" w:h="11910" w:orient="landscape"\/>/);
  assert.match(await xml({ blocks: [], size: { w: 820, h: 0 } }), /<w:pgSz w:w="11906" w:h="16838"\/>/);
});

await test('Snappy：字面量、长字面量、重叠回溯复制', () => {
  const src = new TextEncoder().encode('x'.repeat(100) + '你好');
  assert.deepEqual(snappy(snappyEncode(src)), src);
  // 'ab' 后接 offset=2 len=6 的复制（type 1），得到 'abababab'
  assert.equal(new TextDecoder().decode(snappy(new Uint8Array([8, 1 << 2, 97, 98, (2 << 2) | 1, 2]))), 'abababab');
  assert.throws(() => snappy(new Uint8Array([4, (3 << 2) | 1, 9])), /损坏/);
});

await test('protobuf / IWA 归档解析', () => {
  const f = pbFields(new Uint8Array([...pbInt(1, 300), ...pbLen(3, utf8('hi'))]));
  assert.equal(f[0].v, 300);
  assert.equal(new TextDecoder().decode(f[1].v), 'hi');
  const arcs = iwaArchives(iwaData(iwa([...archive(7, 2001, storage(0, 'A')), ...archive(8, 1, [])])));
  assert.deepEqual(arcs.map((a) => [a.id, a.type]), [[7, 2001], [8, 1]]);
});

await test('fromPages：正文段落；fromKeynote：每页标题 / 正文 / 备注', async () => {
  const pages = zipStore([
    { name: 'Index/Document.iwa', data: iwa([...archive(1, 1, []), ...archive(2, 2001, storage(0, '第一段\u2029第二段\u2028换行\ufffc\n')), ...archive(3, 2001, storage(3, '文本框'))]) },
    { name: 'Metadata/Properties.plist', data: '' },
  ]);
  const d = await fromPages(pages);
  assert.deepEqual(d.blocks.map(text), ['第一段', '第二段\n换行']);
  assert.ok(d.notes[0].includes('只导入了文字'));

  const ref = (/** @type {number} */ f, /** @type {number} */ id) => pbLen(f, pbInt(1, id));
  const key = zipStore([
    // Document.iwa：节点 20/21 各指向一页，列表 30 按 21、20 的顺序排
    { name: 'Index/Document.iwa', data: iwa([...archive(20, 5, ref(1, 100)), ...archive(21, 5, ref(1, 200)), ...archive(30, 6, [...ref(2, 21), ...ref(2, 20)])]) },
    { name: 'Index/Slide.iwa', data: iwa([...archive(100, 5, []), ...archive(101, 2001, storage(3, '甲页标题')), ...archive(102, 2001, storage(3, '要点一\n要点二')), ...archive(103, 2001, storage(4, '讲者备注'))]) },
    { name: 'Index/Slide-2.iwa', data: iwa([...archive(200, 5, []), ...archive(201, 2001, storage(3, '乙页'))]) },
  ]);
  const k = await fromKeynote(key);
  assert.equal(k.slides.length, 2);
  assert.equal(text(k.slides[0].els[0]), '乙页', '按 Document 里的顺序');
  const a = k.slides[1];
  assert.equal(a.els[0].role, 'title');
  assert.equal(text(a.els[0]), '甲页标题');
  assert.equal(text(a.els[1]), '要点一\n要点二');
  assert.equal(a.notes, '讲者备注');

  // 旧版（Index.zip 套娃）
  const nested = zipStore([{ name: 'Index.zip', data: pages }]);
  assert.equal((await fromPages(nested)).blocks.length, 2);
  await assert.rejects(fromPages(zipStore([{ name: 'index.xml', data: '<x/>' }])), /旧格式/);
});

await test('Markdown 导入 / 超大内容截断', () => {
  const b = fromMarkdown(['# 标题', '段落 **粗** `码` [链](https://a.com)', '- 一', '  - 二', '1. 甲', '- [x] 完成', '> 引', '---', '```', 'let a', '```'].join('\n'));
  assert.deepEqual(b.map((x) => x.t), ['h1', 'p', 'ul', 'ul', 'ol', 'todo', 'quote', 'hr', 'code']);
  assert.deepEqual(b[1].runs, [['段落 '], ['粗', { b: 1 }], [' '], ['码', { k: 1 }], [' '], ['链', { a: 'https://a.com' }]]);
  assert.equal(b[3].indent, 1);
  assert.equal(b[5].checked, true);
  assert.deepEqual(fromMarkdown('用 my_var_name 和 _斜_ 与 __粗__')[0].runs, [['用 my_var_name 和 '], ['斜', { i: 1 }], [' 与 '], ['粗', { b: 1 }]]);
  const notes = [];
  const big = Array.from({ length: 400 }, (_, i) => ({ id: 'b' + i, t: 'p', runs: [['字'.repeat(300)]] }));
  const kept = fitSize(big, (l) => ({ blocks: l }), notes, '段');
  assert.ok(kept.length > 100 && kept.length < 400);
  assert.ok(new TextEncoder().encode(JSON.stringify({ blocks: kept })).length <= 250 * 1024);
  assert.match(notes[0], /只导入了前/);
});

if (failures) { console.error(`\n${failures} 项失败`); process.exit(1); }
console.log('\n全部通过');
