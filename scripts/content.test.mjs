/**
 * 文档 / 幻灯片的纯逻辑（合并、清洗、setProp 校验）与帮助中心（文章标记、搜索、站内链接）。
 */

import assert from 'node:assert/strict';
import { installDom } from './dom-stub.mjs';

installDom();
const { mergeById, mergeDoc, mergeSlides } = await import('../public/shared/model/docmerge.js');
const { normRuns, cleanMarks, safeHref, toHex, runsText } = await import('../public/js/doc/runs.js');
const { normDeck, layout, W, H } = await import('../public/js/doc/slides.js');
const T = await import('../public/js/doc/themes.js');
const { normalizeOp } = await import('../public/shared/model/ops.js');
const { ARTICLES, GROUPS } = await import('../public/js/help-guide.js');
const M = await import('../public/js/help-md.js');
const { DOCS } = await import('../public/shared/formula/docs.js');

let failures = 0;
async function test(name, fn) {
  try { await fn(); console.log('  ok   ' + name); }
  catch (err) { failures++; console.error('  FAIL ' + name + '\n       ' + (err.stack ?? err.message)); }
}

// ── 三方合并 ────────────────────────────────────────────────────────────────

const ids = (xs) => xs.map((x) => x.id + (x.v ?? '')).join(',');

await test('mergeById：各改各的都保留，顺序以远端为准', () => {
  const base = [{ id: 'a', v: 1 }, { id: 'b', v: 1 }, { id: 'c', v: 1 }];
  const mine = [{ id: 'a', v: 2 }, { id: 'b', v: 1 }, { id: 'c', v: 1 }];
  const theirs = [{ id: 'c', v: 1 }, { id: 'b', v: 3 }, { id: 'a', v: 1 }];
  assert.equal(ids(mergeById(base, mine, theirs)), 'c1,b3,a2');
});

await test('mergeById：我删的删掉；他们删而我没动的删掉；他们删而我改过的保留', () => {
  const base = [{ id: 'a', v: 1 }, { id: 'b', v: 1 }, { id: 'c', v: 1 }];
  const mine = [{ id: 'b', v: 1 }, { id: 'c', v: 2 }];
  const theirs = [{ id: 'a', v: 1 }];
  assert.equal(ids(mergeById(base, mine, theirs)), 'c2');
});

await test('mergeById：我新增的插在原来的前一项后面', () => {
  const base = [{ id: 'a' }, { id: 'b' }];
  const mine = [{ id: 'a' }, { id: 'n' }, { id: 'b' }];
  const theirs = [{ id: 'z' }, { id: 'a' }, { id: 'b' }];
  assert.equal(ids(mergeById(base, mine, theirs)), 'z,a,n,b');
  assert.equal(ids(mergeById([], [{ id: 'x' }], [{ id: 'y' }])), 'x,y');
});

await test('mergeDoc：两人改不同段落不互相覆盖', () => {
  const base = { blocks: [{ id: 'p1', t: 'p', runs: [['一']] }, { id: 'p2', t: 'p', runs: [['二']] }] };
  const mine = { blocks: [{ id: 'p1', t: 'p', runs: [['一改']] }, base.blocks[1]] };
  const theirs = { blocks: [base.blocks[0], { id: 'p2', t: 'p', runs: [['二改']] }] };
  const out = mergeDoc(base, mine, theirs);
  assert.deepEqual(out.blocks.map((b) => runsText(b.runs)), ['一改', '二改']);
});

await test('mergeSlides：同一页两边都改了，按元素再合并；背景各自保留', () => {
  const s = (els, bg = '#ffffff') => ({ slides: [{ id: 's1', bg, els }] });
  const e = (id, x) => ({ id, t: 'shape', x, y: 0, w: 10, h: 10 });
  const base = s([e('a', 0), e('b', 0)]);
  const mine = s([e('a', 50), e('b', 0)], '#000000');
  const theirs = s([e('a', 0), e('b', 70), e('c', 1)]);
  const out = mergeSlides(base, mine, theirs);
  assert.equal(out.slides[0].bg, '#000000');
  assert.deepEqual(out.slides[0].els.map((x) => x.id + x.x), ['a50', 'b70', 'c1']);
});

// ── 富文本与幻灯片数据清洗 ──────────────────────────────────────────────────

await test('runs：合并相邻同样式、丢空串、链接只放行 http(s)/mailto', () => {
  assert.deepEqual(normRuns([['a', { b: 1 }], ['b', { b: true }], [''], ['c']]), [['ab', { b: 1 }], ['c']]);
  assert.equal(safeHref('javascript:alert(1)'), null);
  assert.equal(safeHref(' https://example.com/x '), 'https://example.com/x');
  assert.equal(safeHref('mailto:a@b.c'), 'mailto:a@b.c');
  assert.deepEqual(cleanMarks({ i: 1, c: '#FF0000', a: 'data:text/html,x', zz: 1 }), { i: 1, c: '#ff0000' });
  assert.equal(cleanMarks({ c: 'red' }), null);
  assert.equal(toHex('rgb(255, 0, 16)'), '#ff0010');
  assert.equal(toHex('#abc'), '#aabbcc');
  assert.equal(toHex('rgba(0, 0, 0, 0)'), null);
  assert.equal(normRuns([['x'.repeat(4500)]]).length, 3);
});

await test('幻灯片：版式、坐标夹紧、未知元素丢弃、背景色校验', () => {
  assert.equal(layout('title').length, 2);
  assert.equal(layout('content').length, 2);
  assert.equal(layout('blank').length, 0);
  assert.ok(layout('title').every((e) => e.t === 'text' && e.ph));
  const d = normDeck({ slides: [
    { id: 's1', bg: 'url(x)', els: [{ id: 'a', t: 'text', x: 99999, y: -99999, w: 5, h: 1e9 }, { id: 'b', t: 'script' }, { t: 'text' }] },
    { bg: '#000000' },
  ] });
  assert.equal(d.slides.length, 1);
  assert.equal(d.slides[0].bg, '#ffffff');
  assert.equal(d.slides[0].els.length, 1);
  const a = d.slides[0].els[0];
  assert.deepEqual([a.x, a.w, a.h], [W - 10, 10, H * 2]);
  assert.ok(a.y >= -a.h + 10);
  assert.equal(normDeck({ slides: Array.from({ length: 400 }, (_, i) => ({ id: 's' + i })) }).slides.length, 300);
});

await test('setProp：doc / slides 被接受，嵌套够深；超过 256KB 被拒', () => {
  const deck = normDeck({ slides: [{ id: 's1', els: [{ id: 'e', t: 'text', x: 0, y: 0, w: 100, h: 50, runs: [['粗', { b: 1, c: '#ff0000' }]] }] }] });
  const op = normalizeOp({ t: 'setProp', key: 'slides', value: deck });
  assert.ok(op);
  assert.deepEqual(op.value.slides[0].els[0].runs, [['粗', { b: 1, c: '#ff0000' }]]);
  assert.ok(normalizeOp({ t: 'setProp', key: 'doc', value: { blocks: [{ id: 'p', t: 'p', runs: [['hi']] }] } }));
  const big = { blocks: Array.from({ length: 200 }, (_, i) => ({ id: 'p' + i, t: 'p', runs: [['字'.repeat(1900)]] })) };
  assert.equal(normalizeOp({ t: 'setProp', key: 'doc', value: big }), null);
});

// ── 主题、模板、形状 ────────────────────────────────────────────────────────

await test('幻灯片主题：版式、换主题、形状清洗', () => {
  assert.equal(layout('section').length, 2);
  assert.equal(layout('two').length, 3);
  assert.equal(new Set(T.SHAPES.map((s) => s.id)).size, T.SHAPES.length);
  const d = normDeck({ theme: 'dark', slides: [{ id: 's1', els: [
    { id: 'a', t: 'shape', x: 0, y: 0, w: 10, h: 10, shape: 'nope', fill: 'url(x)', stroke: 'red', sw: 99 },
    { id: 'b', t: 'shape', x: 0, y: 0, w: 10, h: 10, shape: 'star', fill: 'none', stroke: '#000000', sw: 3 },
  ] }] });
  assert.equal(d.theme, 'dark');
  const [a, b] = d.slides[0].els;
  assert.equal(a.shape, 'rect');
  assert.ok(!('fill' in a) && !('stroke' in a));
  assert.equal(a.sw, 20);
  assert.deepEqual([b.shape, b.fill, b.stroke, b.sw], ['star', 'none', '#000000', 3]);
  assert.equal(normDeck({ theme: 'hack', slides: [] }).theme, undefined);

  const deck = T.deckFromTemplate(T.DECK_TEMPLATES.find((t) => t.id === 'report'), 'plain');
  const out = T.applyTheme(deck, 'dark');
  const th = T.slideTheme('dark');
  assert.equal(out.theme, 'dark');
  for (const s of out.slides) {
    assert.equal(s.bg, th.bg);
    for (const e of s.els) {
      if (e.role === 'title') assert.equal(e.runs?.[0]?.[1]?.c ?? e.c ?? th.title, th.title);
    }
    const deco = s.els.filter((e) => e.deco).length;
    assert.equal(deco, th.deco.length);
  }
});

await test('模板：每种幻灯片模板 × 主题、每种文档模板都能存盘', () => {
  for (const tpl of T.DECK_TEMPLATES) for (const th of T.SLIDE_THEMES) {
    const deck = normDeck(T.deckFromTemplate(tpl, th.id));
    assert.ok(deck.slides.length >= 1, tpl.id);
    assert.ok(normalizeOp({ t: 'setProp', key: 'slides', value: deck }), tpl.id + '/' + th.id);
  }
  for (const tpl of T.DOC_TEMPLATES) {
    const doc = { blocks: T.docFromTemplate(tpl) };
    assert.ok(doc.blocks.length > 1, tpl.id);
    assert.ok(normalizeOp({ t: 'setProp', key: 'doc', value: doc }), tpl.id);
  }
  assert.deepEqual(Object.keys(T.docThemeVars('default')), []);
  assert.ok(!T.isDocTheme('default') && T.isDocTheme('paper'));
});

await test('合并：主题谁改了听谁的', () => {
  const base = { theme: 'a', blocks: [] };
  assert.equal(mergeDoc(base, { theme: 'b', blocks: [] }, { theme: 'c', blocks: [] }).theme, 'b');
  assert.equal(mergeDoc(base, { theme: 'a', blocks: [] }, { theme: 'c', blocks: [] }).theme, 'c');
  const sb = { theme: 'blue', slides: [] };
  assert.equal(mergeSlides(sb, { theme: 'dark', slides: [] }, { theme: 'blue', slides: [] }).theme, 'dark');
  assert.equal(mergeSlides(sb, sb, { theme: 'rose', slides: [] }).theme, 'rose');
});

// ── 帮助中心 ────────────────────────────────────────────────────────────────

await test('帮助标记：标题、列表、提示、表格、行内元素', () => {
  const b = M.parseMd('第一行\n接着\n\n## 小标题\n- 甲\n- 乙\n1. 一\n> 注意 [[Ctrl]]\n| a | b |\n|---|---|\n| `x` | [链](#share) |\n**粗**');
  assert.deepEqual(b.map((x) => x.t), ['p', 'h', 'ul', 'ol', 'tip', 'table', 'p']);
  assert.deepEqual(b[0].c, [{ t: 'text', v: '第一行接着' }]);
  assert.equal(b[2].items.length, 2);
  assert.deepEqual(b[4].c[1], { t: 'kbd', v: 'Ctrl' });
  assert.equal(b[5].head.length, 2);
  assert.deepEqual(b[5].rows[0][0], [{ t: 'code', v: 'x' }]);
  assert.deepEqual(b[5].rows[0][1], [{ t: 'link', v: '链', href: '#share' }]);
  assert.deepEqual(b[6].c, [{ t: 'b', v: '粗' }]);
  const noHead = M.parseMd('| a | b |\n| c | d |');
  assert.equal(noHead[0].head, null);
  assert.equal(noHead[0].rows.length, 2);
});

const arts = ARTICLES.map((a) => ({ ...a, text: M.plainText(M.parseMd(a.body)) }));

await test('帮助文章：编号唯一、分组有效、字段齐全', () => {
  assert.equal(new Set(ARTICLES.map((a) => a.id)).size, ARTICLES.length);
  const groups = new Set(GROUPS.map(([g]) => g));
  for (const a of ARTICLES) {
    assert.ok(groups.has(a.group), a.id);
    assert.ok(a.title && a.summary && a.icon && a.body.trim(), a.id);
    assert.ok(/^[a-z][a-z0-9-]*$/.test(a.id), a.id);
    assert.ok(!DOCS[a.id.toUpperCase()], '文章编号和函数重名：' + a.id);
  }
  for (const [g] of GROUPS) assert.ok(ARTICLES.some((a) => a.group === g), '空分组 ' + g);
  // 旧版帮助页的锚点要继续可用
  for (const id of ['cross-table', 'dropdown', 'shortcuts']) assert.ok(ARTICLES.some((a) => a.id === id), id);
});

await test('帮助文章：站内链接都指向存在的文章或函数页', () => {
  const ok = new Set([...ARTICLES.map((a) => a.id), 'functions']);
  for (const a of ARTICLES) {
    for (const blk of M.parseMd(a.body)) {
      const lines = blk.t === 'table' ? [...(blk.head ?? []), ...blk.rows.flat()] : blk.items ?? [blk.c];
      for (const x of lines.flat()) if (x.t === 'link') assert.ok(ok.has(x.href.slice(1)), a.id + ' → ' + x.href);
    }
  }
});

await test('帮助文章：覆盖文档、幻灯片、分享等主要功能', () => {
  for (const id of ['docs', 'slides', 'share', 'public-link', 'pivot', 'charts', 'dashboard', 'kanban', 'formulas']) {
    assert.ok(ARTICLES.some((a) => a.id === id), id);
  }
  const intro = arts.find((a) => a.id === 'intro');
  const n = Object.keys(DOCS).length;
  assert.match(intro.text, new RegExp(Math.floor(n / 10) * 10 + ' 多个函数'), '介绍里的函数个数跟实际对不上：' + n);
});

await test('帮助搜索：每个词都要命中，标题命中排前面', () => {
  const top = (q) => M.searchArticles(arts, q)[0]?.a.id;
  assert.equal(top('透视表'), 'pivot');
  assert.equal(top('幻灯片 放映'), 'slides');
  assert.equal(top('公开链接'), 'public-link');
  assert.equal(top('多级下拉'), 'dropdown');
  assert.equal(M.searchArticles(arts, 'PPT').length > 0, true);
  assert.deepEqual(M.searchArticles(arts, '透视表 不存在的词xyz'), []);
  assert.deepEqual(M.searchArticles(arts, '   '), []);
});

await test('帮助搜索：摘要片段与高亮', () => {
  const s = M.snippet('a'.repeat(100) + '关键词' + 'b'.repeat(100), '关键词', 10);
  assert.ok(s.startsWith('…') && s.endsWith('…') && s.includes('关键词'));
  assert.equal(M.snippet('短文本', '无'), '短文本');
  assert.deepEqual(M.highlight('Hello World', 'wor'), [['Hello ', false], ['Wor', true], ['ld', false]]);
  assert.deepEqual(M.highlight('abc', ''), [['abc', false]]);
  assert.deepEqual(M.highlight('aXbX', 'x b'), [['a', false], ['XbX', true]]);
});

if (failures) { console.error(`\n${failures} 个用例失败`); process.exit(1); }
console.log('\n文档 / 幻灯片 / 帮助中心：全部通过');
