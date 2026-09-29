/**
 * 公开的 /help 帮助中心：Needtable 介绍、使用说明文章、全部函数，以及一个同时搜文章和函数的搜索框。
 * 未登录也能打开，所以只依赖下面三个模块（worker/index.js 的 PUBLIC_FILES 逐个放行）。
 *
 * 地址：
 *   /help                首页（介绍 + 文章目录）
 *   /help#share          一篇文章
 *   /help#functions      全部函数；#cat-math 某一类；#VLOOKUP（大小写都行）某个函数
 *   /help?q=透视          直接带着搜索词打开
 */

import { DOCS, CATEGORIES } from '../shared/formula/docs.js';
import { ARTICLES, GROUPS } from './help-guide.js';
import { parseMd, plainText, searchArticles, snippet, highlight, terms } from './help-md.js';
import { t as tt } from '../shared/i18n/i18n.js';
import { langSelect } from './core/lang.js';

const $ = (id) => /** @type {HTMLElement} */ (document.getElementById(id));
const view = $('view'), nav = $('nav');
const q = /** @type {HTMLInputElement} */ ($('q'));
const BRAND = 'Needtable';

// 顶栏语言选择框
const topBack = document.querySelector('.top__back');
if (topBack) topBack.after(langSelect({ className: 'top__lang' }));

/** @param {string} tag @param {string | null} [cls] @param {...(Node|string|null|undefined|false)} kids */
function el(tag, cls, ...kids) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  for (const k of kids) if (k != null && k !== false) e.append(k);
  return e;
}

/** @param {string} href @param {string | null} cls @param {...(Node|string|null)} kids */
function link(href, cls, ...kids) {
  const a = /** @type {HTMLAnchorElement} */ (el('a', cls, ...kids));
  a.href = href;
  return a;
}

// ── 数据 ───────────────────────────────────────────────────────────────────

const arts = ARTICLES.map((a) => {
  const blocks = parseMd(a.body);
  return { ...a, blocks, text: plainText(blocks) };
});
const artById = new Map(arts.map((a) => [a.id, a]));

const byCat = CATEGORIES.map(([id, label]) => ({
  id, label,
  docs: Object.values(DOCS).filter((d) => d.cat === id).sort((a, b) => a.name.localeCompare(b.name)),
})).filter((c) => c.docs.length);
const FN_COUNT = Object.keys(DOCS).length;
/** @param {any} d */
const fnText = (d) => [d.name, d.sig, d.desc, ...d.params.flat()].join(' ').toLowerCase();

// ── 渲染文章 ────────────────────────────────────────────────────────────────

/** @param {import('./help-md.js').Inline[]} c */
function inline(c) {
  const frag = document.createDocumentFragment();
  for (const x of c) {
    if (x.t === 'text') frag.append(x.v);
    else if (x.t === 'code') frag.append(el('code', null, x.v));
    else if (x.t === 'b') frag.append(el('b', null, x.v));
    else if (x.t === 'kbd') frag.append(el('kbd', null, x.v));
    else frag.append(link(x.href, null, x.v));
  }
  return frag;
}

/** @param {import('./help-md.js').Block[]} blocks */
function blocksEl(blocks) {
  const box = el('div', 'art__body');
  for (const b of blocks) {
    if (b.t === 'p') box.append(el('p', null, inline(b.c)));
    else if (b.t === 'h') box.append(el('h2', null, inline(b.c)));
    else if (b.t === 'tip') box.append(el('p', 'tip', inline(b.c)));
    else if (b.t === 'ul' || b.t === 'ol') box.append(el(b.t, null, ...b.items.map((it) => el('li', null, inline(it)))));
    else {
      const t = el('table', 'tbl');
      if (b.head) t.append(el('thead', null, el('tr', null, ...b.head.map((c) => el('th', null, inline(c))))));
      t.append(el('tbody', null, ...b.rows.map((r) => el('tr', null, ...r.map((c) => el('td', null, inline(c)))))));
      box.append(el('div', 'tbl-wrap', t));
    }
  }
  return box;
}

/** @param {typeof arts[number]} a */
function articleView(a) {
  const i = arts.indexOf(a);
  const prev = arts[i - 1], next = arts[i + 1];
  const group = GROUPS.find(([id]) => id === a.group)?.[1] ?? '';
  return el('article', 'art',
    el('div', 'crumbs', link('#', null, tt('帮助中心')), ' / ', group),
    el('h1', null, el('span', 'art__icon', a.icon), a.title),
    el('p', 'art__lead', a.summary),
    blocksEl(a.blocks),
    el('nav', 'pager',
      prev ? link('#' + prev.id, 'pager__a', el('small', null, tt('上一篇')), prev.title) : el('span'),
      next ? link('#' + next.id, 'pager__a pager__a--next', el('small', null, tt('下一篇')), next.title) : link('#functions', 'pager__a pager__a--next', el('small', null, tt('下一篇')), tt('函数参考'))));
}

// ── 首页 ───────────────────────────────────────────────────────────────────

function homeView() {
  const box = el('div', 'home');
  const heroMuted = el('p', 'muted');
  heroMuted.innerHTML = tt('在上面的搜索框里输入关键词，同时搜索文章和函数。按 <kbd>/</kbd> 可以随时跳到搜索框。');
  const hero = el('section', 'hero',
    el('h1', null, BRAND + ' ' + tt('帮助中心')),
    el('p', null, tt('表格、文档、幻灯片放在一起的在线协作平台。这里有每个功能的用法，以及全部 {n} 个函数的说明。', { n: FN_COUNT })),
    heroMuted);
  box.append(hero);
  const intro = artById.get('intro');
  if (intro) box.append(el('section', 'home__intro', blocksEl(intro.blocks)));
  for (const [gid, glabel] of GROUPS) {
    const list = arts.filter((a) => a.group === gid && a.id !== 'intro');
    if (!list.length) continue;
    box.append(el('h2', 'home__h', glabel), el('div', 'cards', ...list.map(cardFor)));
  }
  box.append(el('h2', 'home__h', tt('函数参考')),
    el('div', 'cards', ...byCat.map((c) => link('#cat-' + c.id, 'card',
      el('span', 'card__icon', 'ƒ'),
      el('span', 'card__t', c.label),
      el('span', 'card__s', tt('{n} 个函数：{names}', { n: c.docs.length, names: c.docs.slice(0, 5).map((d) => d.name).join('、') + (c.docs.length > 5 ? '…' : '') }))))));
  return box;
}

/** @param {typeof arts[number]} a */
const cardFor = (a) => link('#' + a.id, 'card', el('span', 'card__icon', a.icon), el('span', 'card__t', a.title), el('span', 'card__s', a.summary));

// ── 函数 ───────────────────────────────────────────────────────────────────

/** 每个函数一张卡片。 @param {any} d */
function fnCard(d) {
  const c = el('article', 'fn');
  c.id = d.name;
  const anchor = link('#' + d.name, 'fn__anchor', '#');
  anchor.title = tt('复制这个函数的链接');
  anchor.addEventListener('click', () => {
    navigator.clipboard?.writeText(location.origin + '/help#' + d.name).catch(() => {});
  });
  c.append(el('h3', 'fn__name', d.name, anchor), el('code', 'fn__sig', d.sig), el('p', 'fn__desc', d.desc));
  if (d.params.length) {
    const dl = el('dl', 'fn__params');
    for (const [p, pdesc] of d.params) dl.append(el('dt', null, p), el('dd', null, pdesc));
    c.append(dl);
  }
  c.append(el('div', 'fn__ex', el('span', 'fn__label', tt('示例')), el('code', null, d.example),
    d.result !== '' ? el('span', 'fn__res', '→ ' + d.result) : null));
  return c;
}

function functionsView() {
  const box = el('div', 'fns');
  const introSec = el('section', 'intro', el('h1', null, tt('函数参考')));
  const fnIntroP1 = el('p');
  fnIntroP1.innerHTML = tt('在单元格里输入 <code>=</code> 开始写公式。输入函数名的前几个字母会弹出候选，按 <kbd>Tab</kbd> 或 <kbd>Enter</kbd> 选中；提示条右边的 <b class="q">?</b> 可以展开参数说明和示例。也可以按 <kbd>Shift</kbd>+<kbd>F3</kbd> 打开「插入函数」按分类挑选。');
  const fnIntroP2 = el('p', 'muted');
  fnIntroP2.innerHTML = tt('共 {n} 个函数，分 {cats} 类。写法入门见 <a href="#formulas">公式入门</a>，引用其它表见 <a href="#cross-table">跨表引用</a>。', { n: FN_COUNT, cats: byCat.length });
  introSec.append(fnIntroP1, fnIntroP2);
  box.append(introSec);
  for (const cat of byCat) {
    const sec = el('section', 'cat');
    sec.id = 'cat-' + cat.id;
    sec.append(el('h2', null, cat.label, el('span', 'cat__n', String(cat.docs.length))), el('div', 'cat__list', ...cat.docs.map(fnCard)));
    box.append(sec);
  }
  return box;
}

// ── 搜索 ───────────────────────────────────────────────────────────────────

/** @param {string} s @param {string} query */
function marked(s, query) {
  const frag = document.createDocumentFragment();
  for (const [t, on] of highlight(s, query)) frag.append(on ? el('mark', null, t) : t);
  return frag;
}

/** @param {string} query */
function searchView(query) {
  const ws = terms(query);
  const hits = searchArticles(arts, query);
  const fns = Object.values(DOCS)
    .filter((d) => { const t = fnText(d); return ws.every((w) => t.includes(w)); })
    .sort((a, b) => rankFn(b, ws) - rankFn(a, ws) || a.name.localeCompare(b.name));
  const box = el('div', 'results');
  box.append(el('h1', null, tt('搜索「{q}」', { q: query.trim() })),
    el('p', 'muted', tt('找到 {articles} 篇文章、{fns} 个函数。按 Enter 打开第一条。', { articles: hits.length, fns: fns.length })));
  if (hits.length) {
    box.append(el('h2', 'home__h', tt('文章')));
    box.append(el('div', 'res', ...hits.map(({ a }) => link('#' + a.id, 'res__item',
      el('span', 'res__t', el('span', 'card__icon', a.icon), marked(a.title, query)),
      el('span', 'res__s', marked(snippet(a.summary + ' ' + a.text, query), query))))));
  }
  if (fns.length) {
    const MAX = 60;
    box.append(el('h2', 'home__h', tt('函数')), el('div', 'cat__list', ...fns.slice(0, MAX).map(fnCard)));
    if (fns.length > MAX) box.append(el('p', 'muted', tt('还有 {n} 个函数，换个更具体的词试试。', { n: fns.length - MAX })));
  }
  if (!hits.length && !fns.length) {
    const emptyP2 = el('p', 'muted');
    emptyP2.innerHTML = tt('可以换个说法，比如「权限」「公开」「图表」「日期」，或者 <a href="#">回到帮助中心首页</a>。');
    box.append(el('div', 'empty', el('p', null, tt('没有找到相关的文章或函数。')), emptyP2));
  }
  return box;
}

/** 函数名命中排前面。 @param {any} d @param {string[]} ws */
const rankFn = (d, ws) => ws.reduce((s, w) => s + (d.name.toLowerCase() === w ? 100 : d.name.toLowerCase().startsWith(w) ? 20 : d.name.toLowerCase().includes(w) ? 10 : 0), 0);

// ── 目录 ───────────────────────────────────────────────────────────────────

function buildNav() {
  nav.replaceChildren(link('#', 'nav__cat nav__home', tt('🏠 首页')));
  for (const [gid, glabel] of GROUPS) {
    // 「Needtable 是什么」就是首页的内容
    const list = arts.filter((a) => a.group === gid && a.id !== 'intro');
    if (!list.length) continue;
    nav.append(el('div', 'nav__group', glabel));
    for (const a of list) nav.append(link('#' + a.id, 'nav__cat', a.title));
  }
  nav.append(el('div', 'nav__group', tt('函数参考')));
  nav.append(link('#functions', 'nav__cat', tt('全部函数'), el('span', 'nav__n', String(FN_COUNT))));
  for (const c of byCat) nav.append(link('#cat-' + c.id, 'nav__cat nav__sub', c.label, el('span', 'nav__n', String(c.docs.length))));
}

/** @param {string} href */
function markNav(href) {
  for (const a of nav.querySelectorAll('a')) a.classList.toggle('nav__cat--on', a.getAttribute('href') === href);
  nav.querySelector('.nav__cat--on')?.scrollIntoView({ block: 'nearest' });
}

// ── 路由 ───────────────────────────────────────────────────────────────────

let shown = '';

/** @param {Node} node @param {string} key 同一个视图不重画 @param {string} title */
function show(node, key, title) {
  if (shown !== key) {
    view.replaceChildren(node);
    shown = key;
  }
  document.title = title + ' · ' + BRAND;
}

function route() {
  const query = q.value.trim();
  if (query) {
    show(searchView(query), 'q:' + query, tt('搜索：{q}', { q: query }));
    markNav('');
    return;
  }
  const raw = decodeURIComponent(location.hash.slice(1));
  const art = artById.get(raw) ?? artById.get(raw.toLowerCase());
  if (art && art.id !== 'intro') {
    show(articleView(art), 'a:' + art.id, art.title);
    markNav('#' + art.id);
    window.scrollTo(0, 0);
    return;
  }
  const fnName = raw.toUpperCase();
  if (raw === 'functions' || raw.startsWith('cat-') || (raw && DOCS[fnName])) {
    show(functionsView(), 'fns', tt('函数参考'));
    markNav(raw.startsWith('cat-') ? '#' + raw : '#functions');
    const target = raw === 'functions' ? null : document.getElementById(raw.startsWith('cat-') ? raw : fnName);
    document.querySelectorAll('.is-target').forEach((x) => x.classList.remove('is-target'));
    if (target) {
      target.scrollIntoView({ block: 'start' });
      if (!raw.startsWith('cat-')) target.classList.add('is-target');
    } else window.scrollTo(0, 0);
    return;
  }
  show(homeView(), 'home', tt('帮助中心'));
  markNav('#');
  window.scrollTo(0, 0);
}

buildNav();
q.value = new URLSearchParams(location.search).get('q') ?? '';
let t = 0;
q.addEventListener('input', () => {
  clearTimeout(t);
  t = window.setTimeout(() => {
    route();
    // 地址栏跟着变，复制出去别人打开也是这个搜索
    const u = new URL(location.href);
    if (q.value.trim()) u.searchParams.set('q', q.value.trim()); else u.searchParams.delete('q');
    history.replaceState(null, '', u);
  }, 120);
});
q.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') { q.value = ''; q.dispatchEvent(new Event('input')); return; }
  if (e.key !== 'Enter') return;
  const first = /** @type {HTMLAnchorElement | HTMLElement | null} */ (view.querySelector('.res__item, .fn'));
  if (!first) return;
  const hash = first instanceof HTMLAnchorElement ? first.getAttribute('href') ?? '' : '#' + first.id;
  q.value = '';
  history.replaceState(null, '', location.pathname + location.hash);
  shown = '';
  if (location.hash === hash) route(); else location.hash = hash;
});
// 点了搜索结果里的链接：清掉搜索词再跳
view.addEventListener('click', (e) => {
  const a = /** @type {HTMLElement} */ (e.target).closest('a');
  if (!a || !q.value || !a.getAttribute('href')?.startsWith('#')) return;
  q.value = '';
  history.replaceState(null, '', location.pathname + location.hash);
  if (a.getAttribute('href') === location.hash) { e.preventDefault(); shown = ''; route(); }
});
nav.addEventListener('click', (e) => {
  const a = /** @type {HTMLElement} */ (e.target).closest('a');
  if (!a || !q.value) return;
  q.value = '';
  history.replaceState(null, '', location.pathname + location.hash);
  if (a.getAttribute('href') === (location.hash || '#')) { e.preventDefault(); route(); }
});
window.addEventListener('hashchange', route);
document.addEventListener('keydown', (e) => {
  if (e.key === '/' && document.activeElement !== q) { e.preventDefault(); q.focus(); q.select(); }
});
route();
