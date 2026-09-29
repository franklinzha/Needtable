/**
 * 富文本的行内部分：runs ⇄ DOM，文档和幻灯片的文本框共用。
 *
 * runs = [[文本, 标记?], …]，标记 { b, i, u, s, k(行内代码), c:'#rrggbb', bg:'#rrggbb', a:'https://…' }。
 * 渲染只用 createElement + textContent + style.setProperty（CSP 不允许 style 属性字符串）；
 * 读回时既认自己画的样子，也认 execCommand 生成的 <b> <i> <u> <strike> <font color> <a>。
 */

/** 服务端 cleanJson 把字符串截到 2000，这里先切开。 */
const MAX_RUN = 2000;

/** @param {any} s */
export const isHex = (s) => typeof s === 'string' && /^#[0-9a-f]{6}$/i.test(s);

/** 只放行 http(s) / mailto 链接。 @param {any} s */
export function safeHref(s) {
  if (typeof s !== 'string') return null;
  const t = s.trim();
  if (!/^(https?:\/\/|mailto:)/i.test(t) || t.length > 1000) return null;
  try { return new URL(t).href; } catch { return null; }
}

/** 'rgb(1, 2, 3)' / '#abc' / '#aabbcc' → '#aabbcc'，认不出返回 null。 @param {string} s */
export function toHex(s) {
  if (!s) return null;
  s = s.trim().toLowerCase();
  if (isHex(s)) return s;
  let m = /^#([0-9a-f])([0-9a-f])([0-9a-f])$/.exec(s);
  if (m) return '#' + m[1] + m[1] + m[2] + m[2] + m[3] + m[3];
  m = /^rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?\)$/.exec(s);
  if (!m || (m[4] != null && Number(m[4]) === 0)) return null;
  return '#' + [m[1], m[2], m[3]].map((x) => Math.min(255, Number(x)).toString(16).padStart(2, '0')).join('');
}

/** 标记清洗成稳定的形状（键顺序固定，便于比较）。 @param {any} m */
export function cleanMarks(m) {
  if (!m || typeof m !== 'object') return null;
  /** @type {Record<string, any>} */ const o = {};
  for (const k of ['b', 'i', 'u', 's', 'k']) if (m[k]) o[k] = 1;
  if (isHex(m.c)) o.c = m.c.toLowerCase();
  if (isHex(m.bg)) o.bg = m.bg.toLowerCase();
  const a = safeHref(m.a);
  if (a) o.a = a;
  return Object.keys(o).length ? o : null;
}

/**
 * 合并相邻同标记、丢空串、切长串。
 * @param {any[]} runs @returns {any[]}
 */
export function normRuns(runs) {
  /** @type {any[]} */ const out = [];
  for (const r of Array.isArray(runs) ? runs : []) {
    const t = String(Array.isArray(r) ? r[0] ?? '' : '').replace(/[​﻿]/g, '');
    if (!t) continue;
    const m = cleanMarks(Array.isArray(r) ? r[1] : null);
    const last = out[out.length - 1];
    if (last && JSON.stringify(last[1] ?? null) === JSON.stringify(m)) last[0] += t;
    else out.push(m ? [t, m] : [t]);
  }
  /** @type {any[]} */ const cut = [];
  for (const r of out) {
    for (let i = 0; i < r[0].length; i += MAX_RUN) cut.push(r[1] ? [r[0].slice(i, i + MAX_RUN), r[1]] : [r[0].slice(i, i + MAX_RUN)]);
  }
  return cut;
}

/** 纯文本。 @param {any[]} runs */
export const runsText = (runs) => (Array.isArray(runs) ? runs.map((r) => String(r?.[0] ?? '')).join('') : '');

/**
 * 把 runs 画进 el（清空原有内容）。空内容放一个 <br>，否则光标放不进去。
 * @param {HTMLElement} el @param {any[]} runs
 */
export function renderRuns(el, runs) {
  el.replaceChildren();
  for (const r of normRuns(runs)) {
    const m = r[1];
    /** @type {Node} */ let node;
    const parts = r[0].split('\n');
    const frag = document.createDocumentFragment();
    parts.forEach((p, i) => {
      if (i) frag.append(document.createElement('br'));
      if (p) frag.append(document.createTextNode(p));
    });
    if (!m) { el.append(frag); continue; }
    /** @type {HTMLElement} */ let wrap;
    if (m.a) {
      const a = document.createElement('a');
      a.href = m.a;
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
      wrap = a;
    } else wrap = document.createElement(m.k ? 'code' : 'span');
    if (m.a && m.k) { const c = document.createElement('code'); wrap.append(c); c.append(frag); } else wrap.append(frag);
    if (m.b) wrap.style.setProperty('font-weight', '700');
    if (m.i) wrap.style.setProperty('font-style', 'italic');
    const deco = [m.u ? 'underline' : '', m.s ? 'line-through' : ''].filter(Boolean).join(' ');
    if (deco) wrap.style.setProperty('text-decoration', deco);
    if (m.c) wrap.style.setProperty('color', m.c);
    if (m.bg) wrap.style.setProperty('background-color', m.bg);
    node = wrap;
    el.append(node);
  }
  if (!el.firstChild || el.lastChild?.nodeName === 'BR') el.append(document.createElement('br'));
}

/**
 * 从 DOM 读回 runs。contenteditable=false 的子节点跳过；块末尾那个占位 <br> 不算换行。
 * @param {Node} el @returns {any[]}
 */
export function readRuns(el) {
  /** @type {any[]} */ const out = [];
  /** @param {Node} n @param {Record<string, any>} marks */
  const walk = (n, marks) => {
    if (n.nodeType === 3) { out.push([n.nodeValue ?? '', marks]); return; }
    if (n.nodeType !== 1) return;
    const e = /** @type {HTMLElement} */ (n);
    if (e.getAttribute('contenteditable') === 'false') return;
    const tag = e.tagName;
    if (tag === 'BR') { out.push(['\n', marks]); return; }
    if (tag === 'STYLE' || tag === 'SCRIPT') return;
    const m = { ...marks };
    if (tag === 'B' || tag === 'STRONG') m.b = 1;
    if (tag === 'I' || tag === 'EM') m.i = 1;
    if (tag === 'U' || tag === 'INS') m.u = 1;
    if (tag === 'S' || tag === 'STRIKE' || tag === 'DEL') m.s = 1;
    if (tag === 'CODE') m.k = 1;
    if (tag === 'A') { const a = safeHref(e.getAttribute('href')); if (a) m.a = a; }
    if (tag === 'FONT') { const c = toHex(e.getAttribute('color') ?? ''); if (c) m.c = c; }
    const st = e.style;
    if (st) {
      const fw = st.fontWeight;
      if (fw === 'bold' || fw === 'bolder' || Number(fw) >= 600) m.b = 1;
      else if (fw === 'normal' || (Number(fw) > 0 && Number(fw) < 600)) delete m.b;
      if (st.fontStyle === 'italic') m.i = 1;
      const deco = st.textDecorationLine || st.textDecoration || '';
      if (deco.includes('underline')) m.u = 1;
      if (deco.includes('line-through')) m.s = 1;
      const c = toHex(st.color);
      if (c) m.c = c;
      const bg = toHex(st.backgroundColor);
      if (bg) m.bg = bg;
    }
    for (const k of e.childNodes) walk(k, m);
  };
  for (const k of el.childNodes) walk(k, {});
  // 块末尾的 <br> 只是占位
  while (out.length && out[out.length - 1][0] === '\n') out.pop();
  return normRuns(out);
}

// ── 编辑命令（选区在 contenteditable 里时调用） ───────────────────────────────

/** @param {string} cmd @param {string} [v] */
export function exec(cmd, v) {
  try { document.execCommand('styleWithCSS', false, 'false'); } catch { /* 老浏览器 */ }
  document.execCommand(cmd, false, v);
}

/** 当前选区（必须在 root 里）。 @param {Node} root */
export function rangeIn(root) {
  const sel = window.getSelection();
  if (!sel || !sel.rangeCount) return null;
  const r = sel.getRangeAt(0);
  return root.contains(r.commonAncestorContainer) ? r : null;
}

/**
 * 把选中的文字包进一个元素（高亮、行内代码）。只处理同一个块里的选区。
 * @param {HTMLElement} block 选区所在的块 @param {() => HTMLElement} make
 */
export function wrapSelection(block, make) {
  const r = rangeIn(block);
  if (!r || r.collapsed) return false;
  const el = make();
  el.append(r.extractContents());
  r.insertNode(el);
  const sel = window.getSelection();
  const nr = document.createRange();
  nr.selectNodeContents(el);
  sel?.removeAllRanges();
  sel?.addRange(nr);
  return true;
}

/** 光标到块开头的文字长度（恢复光标用）。 @param {HTMLElement} block */
export function caretOffset(block) {
  const r = rangeIn(block);
  if (!r) return -1;
  const pre = document.createRange();
  pre.selectNodeContents(block);
  pre.setEnd(r.startContainer, r.startOffset);
  return pre.toString().length;
}

/** 把光标放到块里第 n 个字符处（超出就放末尾）。 @param {HTMLElement} block @param {number} n */
export function placeCaret(block, n) {
  const sel = window.getSelection();
  if (!sel) return;
  const r = document.createRange();
  const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT);
  let left = Math.max(0, n);
  /** @type {Node | null} */ let t;
  while ((t = walker.nextNode())) {
    const len = t.nodeValue?.length ?? 0;
    if (left <= len) { r.setStart(t, left); r.collapse(true); sel.removeAllRanges(); sel.addRange(r); return; }
    left -= len;
  }
  r.selectNodeContents(block);
  r.collapse(false);
  sel.removeAllRanges();
  sel.addRange(r);
}
