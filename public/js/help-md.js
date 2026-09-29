/**
 * 帮助文章的小标记（格式见 help-guide.js 顶部）→ 结构化的块，以及全文搜索。
 * 纯函数、不碰 DOM，Node 里可以直接测（scripts/help.test.mjs）。
 */

/**
 * @typedef {{ t: 'text' | 'code' | 'b' | 'kbd', v: string } | { t: 'link', v: string, href: string }} Inline
 * @typedef {{ t: 'p' | 'h' | 'tip', c: Inline[] }
 *   | { t: 'ul' | 'ol', items: Inline[][] }
 *   | { t: 'table', head: Inline[][] | null, rows: Inline[][][] }} Block
 */

const INLINE_RE = /`([^`]+)`|\*\*([^*]+)\*\*|\[\[([^\]]+)\]\]|\[([^\]]+)\]\((#[\w-]+)\)/g;

/** @param {string} s @returns {Inline[]} */
export function parseInline(s) {
  /** @type {Inline[]} */ const out = [];
  let last = 0;
  for (const m of s.matchAll(INLINE_RE)) {
    const i = /** @type {number} */ (m.index);
    if (i > last) out.push({ t: 'text', v: s.slice(last, i) });
    if (m[1] != null) out.push({ t: 'code', v: m[1] });
    else if (m[2] != null) out.push({ t: 'b', v: m[2] });
    else if (m[3] != null) out.push({ t: 'kbd', v: m[3] });
    else out.push({ t: 'link', v: m[4], href: m[5] });
    last = i + m[0].length;
  }
  if (last < s.length) out.push({ t: 'text', v: s.slice(last) });
  return out;
}

/** 表格的一行：| a | b | → ['a', 'b']。 @param {string} line */
const cells = (line) => line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());
const isRule = (/** @type {string} */ line) => /^\|[\s:|-]+\|$/.test(line.trim()) && line.includes('-');

/** @param {string} body @returns {Block[]} */
export function parseMd(body) {
  const lines = body.replace(/\r\n?/g, '\n').split('\n');
  /** @type {Block[]} */ const out = [];
  /** @type {string[]} */ let para = [];
  const flush = () => {
    if (para.length) out.push({ t: 'p', c: parseInline(para.join('')) });
    para = [];
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trimEnd();
    const tl = line.trim();
    if (!tl) { flush(); continue; }
    if (tl.startsWith('## ')) { flush(); out.push({ t: 'h', c: parseInline(tl.slice(3)) }); continue; }
    if (tl.startsWith('> ')) { flush(); out.push({ t: 'tip', c: parseInline(tl.slice(2)) }); continue; }
    const li = /^(-|\d+\.)\s+(.*)$/.exec(tl);
    if (li) {
      flush();
      const kind = li[1] === '-' ? 'ul' : 'ol';
      const prev = out[out.length - 1];
      const item = parseInline(li[2]);
      // 同类列表项连着写就是同一个列表
      if (prev && prev.t === kind && lines[i - 1]?.trim()) prev.items.push(item);
      else out.push({ t: kind, items: [item] });
      continue;
    }
    if (tl.startsWith('|')) {
      flush();
      /** @type {string[]} */ const rows = [];
      while (i < lines.length && lines[i].trim().startsWith('|')) rows.push(lines[i++]);
      i--;
      const hasHead = rows.length > 1 && isRule(rows[1]);
      out.push({
        t: 'table',
        head: hasHead ? cells(rows[0]).map(parseInline) : null,
        rows: rows.slice(hasHead ? 2 : 0).filter((r) => !isRule(r)).map((r) => cells(r).map(parseInline)),
      });
      continue;
    }
    para.push(tl);
  }
  flush();
  return out;
}

/** 行内片段 → 纯文本。 @param {Inline[]} c */
const inlineText = (c) => c.map((x) => x.v).join('');

/** 整篇的纯文本（搜索和摘要用）。 @param {Block[]} blocks */
export function plainText(blocks) {
  /** @type {string[]} */ const out = [];
  for (const b of blocks) {
    if (b.t === 'ul' || b.t === 'ol') for (const it of b.items) out.push(inlineText(it));
    else if (b.t === 'table') for (const r of [...(b.head ? [b.head] : []), ...b.rows]) out.push(r.map(inlineText).join(' '));
    else out.push(inlineText(b.c));
  }
  return out.join('\n');
}

/** 搜索词：空格分开，全部小写。 @param {string} q */
export const terms = (q) => q.trim().toLowerCase().split(/\s+/).filter(Boolean);

/**
 * 文章搜索：每个词都要出现（标题、摘要、关键词或正文里）。
 * 分数：标题命中 10，关键词 / 摘要 4，正文每处 1（封顶 5）。
 * @template {{ title: string, summary: string, keywords?: string, text: string }} A
 * @param {A[]} arts 带 text（plainText 的结果）的文章 @param {string} q
 * @returns {{ a: A, score: number }[]}
 */
export function searchArticles(arts, q) {
  const ws = terms(q);
  if (!ws.length) return [];
  /** @type {{ a: A, score: number }[]} */ const hits = [];
  for (const a of arts) {
    const title = a.title.toLowerCase(), meta = (a.summary + ' ' + (a.keywords ?? '')).toLowerCase(), text = a.text.toLowerCase();
    let score = 0;
    let ok = true;
    for (const w of ws) {
      const inTitle = title.includes(w), inMeta = meta.includes(w);
      const n = Math.min(5, count(text, w));
      if (!inTitle && !inMeta && !n) { ok = false; break; }
      score += (inTitle ? 10 : 0) + (inMeta ? 4 : 0) + n;
    }
    if (ok) hits.push({ a, score });
  }
  return hits.sort((x, y) => y.score - x.score);
}

/** @param {string} s @param {string} w */
function count(s, w) {
  let n = 0;
  for (let i = s.indexOf(w); i >= 0 && n < 50; i = s.indexOf(w, i + w.length)) n++;
  return n;
}

/**
 * 正文里第一处命中附近的一小段，用来在结果里展示；没有命中就取开头。
 * @param {string} text @param {string} q @param {number} [span] 前后各取多少字
 */
export function snippet(text, q, span = 36) {
  const flat = text.replace(/\s+/g, ' ').trim();
  const low = flat.toLowerCase();
  let at = -1;
  for (const w of terms(q)) { const i = low.indexOf(w); if (i >= 0 && (at < 0 || i < at)) at = i; }
  if (at < 0) return flat.slice(0, span * 2) + (flat.length > span * 2 ? '…' : '');
  const s = Math.max(0, at - span), e = Math.min(flat.length, at + span * 2);
  return (s > 0 ? '…' : '') + flat.slice(s, e) + (e < flat.length ? '…' : '');
}

/**
 * 把一段文字按搜索词切开，标出命中部分（渲染时包 <mark>）。
 * @param {string} s @param {string} q @returns {[string, boolean][]}
 */
export function highlight(s, q) {
  const ws = terms(q);
  if (!ws.length) return [[s, false]];
  const low = s.toLowerCase();
  /** @type {boolean[]} */ const on = new Array(s.length).fill(false);
  for (const w of ws) for (let i = low.indexOf(w); i >= 0; i = low.indexOf(w, i + 1)) on.fill(true, i, i + w.length);
  /** @type {[string, boolean][]} */ const out = [];
  for (let i = 0; i < s.length; i++) {
    const last = out[out.length - 1];
    if (last && last[1] === on[i]) last[0] += s[i];
    else out.push([s[i], on[i]]);
  }
  return out;
}
