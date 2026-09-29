/**
 * 够用的 XML 解析与拼写：读 Office 文件的 document.xml / slideN.xml 等。
 *
 * 不用 DOMParser：它在 Node（测试）里没有，而且 Office XML 很规整，一个小分词器就够了。
 * 节点 { n: 'w:p', a: { 'w:val': '1' }, k: [子节点…] }，文本节点 { n: '#', t: '…' }。
 */

/** @typedef {{ n: string, a: Record<string, string>, k: XNode[], t?: string }} XNode */

/** @param {string} s */
export const unesc = (s) => (s.indexOf('&') < 0 ? s : s.replace(/&(lt|gt|quot|apos|amp|#(\d+)|#x([0-9a-f]+));/gi, (_, e, d, x) =>
  d ? String.fromCodePoint(+d) : x ? String.fromCodePoint(parseInt(x, 16))
    : /** @type {Record<string, string>} */ ({ lt: '<', gt: '>', quot: '"', apos: "'", amp: '&' })[e.toLowerCase()]));

/** 文本转义；顺带去掉 XML 不允许的控制字符。 @param {any} s */
export const esc = (s) => String(s ?? '')
  .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f￾￿]/g, '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const ATTR = /([^\s=/>]+)\s*=\s*("([^"]*)"|'([^']*)')/g;

/** @param {string} src @returns {XNode} 虚拟根节点，真正的根是它的第一个元素子节点 */
export function parseXml(src) {
  /** @type {XNode} */ const root = { n: '#root', a: {}, k: [] };
  const stack = [root];
  let i = 0;
  const len = src.length;
  while (i < len) {
    const lt = src.indexOf('<', i);
    if (lt < 0) break;
    if (lt > i) {
      const t = src.slice(i, lt);
      if (stack.length > 1 && t) stack[stack.length - 1].k.push({ n: '#', a: {}, k: [], t: unesc(t) });
    }
    if (src.startsWith('<!--', lt)) { const e = src.indexOf('-->', lt); i = e < 0 ? len : e + 3; continue; }
    if (src.startsWith('<![CDATA[', lt)) {
      const e = src.indexOf(']]>', lt);
      stack[stack.length - 1].k.push({ n: '#', a: {}, k: [], t: src.slice(lt + 9, e < 0 ? len : e) });
      i = e < 0 ? len : e + 3;
      continue;
    }
    if (src[lt + 1] === '?' || src[lt + 1] === '!') { const e = src.indexOf('>', lt); i = e < 0 ? len : e + 1; continue; }
    const gt = src.indexOf('>', lt);
    if (gt < 0) break;
    let tag = src.slice(lt + 1, gt);
    i = gt + 1;
    if (tag[0] === '/') {
      const name = tag.slice(1).trim();
      for (let s = stack.length - 1; s > 0; s--) if (stack[s].n === name) { stack.length = s; break; }
      continue;
    }
    const self = tag.endsWith('/');
    if (self) tag = tag.slice(0, -1);
    const sp = tag.search(/\s/);
    const name = sp < 0 ? tag : tag.slice(0, sp);
    /** @type {Record<string, string>} */ const a = {};
    if (sp >= 0) {
      ATTR.lastIndex = 0;
      const rest = tag.slice(sp);
      let m;
      while ((m = ATTR.exec(rest))) a[m[1]] = unesc(m[3] ?? m[4] ?? '');
    }
    /** @type {XNode} */ const node = { n: name, a, k: [] };
    stack[stack.length - 1].k.push(node);
    if (!self) stack.push(node);
  }
  return root;
}

/** 第一个元素子节点（跳过虚拟根）。 @param {string} src */
export const xmlRoot = (src) => parseXml(src).k.find((x) => x.n !== '#') ?? { n: '', a: {}, k: [] };

/** 直接子元素里名字匹配的。 @param {XNode | undefined} x @param {string} name */
export const kids = (x, name) => (x ? x.k.filter((c) => c.n === name) : []);
/** @param {XNode | undefined} x @param {string} name */
export const kid = (x, name) => x?.k.find((c) => c.n === name);
/** 顺着路径往下走：kidPath(sp, 'p:spPr', 'a:xfrm', 'a:off')。 @param {XNode | undefined} x @param {...string} path */
export function kidPath(x, ...path) { for (const p of path) { x = kid(x, p); if (!x) return undefined; } return x; }

/** 深度优先找所有名字匹配的后代。 @param {XNode | undefined} x @param {string} name @param {XNode[]} [out] */
export function all(x, name, out = []) {
  if (!x) return out;
  for (const c of x.k) { if (c.n === name) out.push(c); else if (c.k.length) all(c, name, out); }
  return out;
}
/** @param {XNode | undefined} x @param {string} name @returns {XNode | undefined} */
export function find(x, name) {
  if (!x) return undefined;
  for (const c of x.k) {
    if (c.n === name) return c;
    const d = c.k.length ? find(c, name) : undefined;
    if (d) return d;
  }
  return undefined;
}

/** 所有文本拼起来。 @param {XNode | undefined} x @returns {string} */
export const textOf = (x) => (!x ? '' : x.n === '#' ? x.t ?? '' : x.k.map(textOf).join(''));

/** .rels 文件 → Map<rId, {target, type, external}>；target 已解析成包内绝对路径。 @param {string} src @param {string} base 所在目录，如 'word/' */
export function parseRels(src, base) {
  /** @type {Map<string, {target: string, type: string, external: boolean}>} */ const m = new Map();
  if (!src) return m;
  for (const r of kids(xmlRoot(src), 'Relationship')) {
    const external = r.a.TargetMode === 'External';
    m.set(r.a.Id, { target: external ? r.a.Target : resolvePath(base, r.a.Target), type: r.a.Type ?? '', external });
  }
  return m;
}

/** 'ppt/slides/' + '../media/a.png' → 'ppt/media/a.png'。 @param {string} base @param {string} rel */
export function resolvePath(base, rel) {
  const parts = (rel.startsWith('/') ? rel.slice(1) : base + rel).split('/');
  /** @type {string[]} */ const out = [];
  for (const p of parts) { if (p === '..') out.pop(); else if (p !== '.' && p !== '') out.push(p); }
  return out.join('/');
}

/** 某个包内文件对应的 .rels 路径。 @param {string} path */
export const relsOf = (path) => { const i = path.lastIndexOf('/'); return path.slice(0, i + 1) + '_rels/' + path.slice(i + 1) + '.rels'; };

const MIME = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', bmp: 'image/bmp' };
/** 能在浏览器里显示的图片后缀 → MIME；EMF / WMF / TIFF 这类返回 null。 @param {string} path */
export const imageMime = (path) => /** @type {Record<string, string>} */ (MIME)[path.split('.').pop()?.toLowerCase() ?? ''] ?? null;
/** 导出时的文件后缀。调用方已经把 Office 不认的格式（webp 等）转成了 PNG。 @param {string} mime */
export const mimeExt = (mime) => /** @type {Record<string, string>} */ ({ 'image/jpeg': 'jpeg', 'image/gif': 'gif' })[mime] ?? 'png';
