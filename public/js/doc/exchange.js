/**
 * 文档 / 幻灯片的导入导出（界面这一层）：选文件、解析、上传图片、导出时收集图片和嵌入快照、触发下载。
 * 格式本身在 io/docx.js、io/pptx.js、io/iwork.js；这里只做浏览器里才有的事。
 *
 * 导入：Word（.docx）、Pages（.pages，只有文字）、Markdown / 纯文本 → 文档；PowerPoint（.pptx）、Keynote（.key，只有文字）→ 幻灯片。
 * 导出：.docx / .pptx；PDF 走浏览器的打印对话框（“另存为 PDF”），排版和屏幕上一样。
 */

import { h, plainTitle } from '../ui/dom.js';
import { uid } from '../../shared/util/uid.js';
import { normRuns } from './runs.js';
import { t } from '../../shared/i18n/i18n.js';

/** 选文件时最大接受多大（图片多的演示文稿可能很大；解析在本机做） */
const MAX_FILE = 80 * 1024 * 1024;
/** 一次导入最多上传多少张图片 */
const MAX_MEDIA = 60;
/** 与 ops.js 的 MAX_PROP_BYTES 一致，留点余量 */
const MAX_JSON = 250 * 1024;

/** 选一个文件。 @param {string} accept @returns {Promise<File | null>} */
export function pickFile(accept) {
  return new Promise((resolve) => {
    const input = /** @type {HTMLInputElement} */ (h('input', { type: 'file', accept }));
    input.addEventListener('change', () => resolve(input.files?.[0] ?? null));
    input.click();
  });
}

/** 触发浏览器下载。 @param {Blob} blob @param {string} name */
export function download(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

/** 文件名里不能有的字符。 @param {string} s */
export const safeName = (s) => (plainTitle(s) || t('未命名')).replace(/[\\/:*?"<>|]/g, '_').trim().slice(0, 100) || t('未命名');

const ext = (/** @type {string} */ name) => (name.split('.').pop() ?? '').toLowerCase();

/** @param {File} f */
function checkFile(f) {
  if (f.size > MAX_FILE) throw new Error(t('文件太大了（最大 80MB）'));
  const e = ext(f.name);
  if (e === 'doc' || e === 'ppt' || e === 'wps' || e === 'dps') throw new Error(t('这是旧版 Office 格式，请先用 Word / PowerPoint / WPS 另存为 .{ext} 再导入', { ext: e === 'doc' || e === 'wps' ? 'docx' : 'pptx' }));
  return e;
}

/**
 * 把解析出来的图片传上去，返回 '@key' → 附件 id。失败的、太多的就不要了。
 * @param {string} tableId @param {Map<string, {data: Uint8Array, type: string, name?: string}>} media @param {Set<string>} used
 * @param {(msg: string) => void} status @param {string[]} notes
 */
async function uploadMedia(tableId, media, used, status, notes) {
  const { upload, prepare, MAX_BYTES } = await import('../io/attach.js');
  /** @type {Map<string, string>} */ const ids = new Map();
  const keys = [...used].filter((k) => media.has(k));
  if (keys.length > MAX_MEDIA) notes.push(t('图片太多，只导入了前 {n} 张', { n: MAX_MEDIA }));
  let n = 0, failed = 0;
  for (const k of keys.slice(0, MAX_MEDIA)) {
    const m = /** @type {any} */ (media.get(k));
    status(t('正在上传图片 {i} / {n}…', { i: ++n, n: Math.min(keys.length, MAX_MEDIA) }));
    try {
      const f = await prepare(new File([m.data], m.name || 'image.' + (m.type.split('/')[1] || 'png'), { type: m.type }));
      if (f.size > MAX_BYTES) { failed++; continue; }
      ids.set(k, (await upload(tableId, f)).id);
    } catch { failed++; }
  }
  if (failed) notes.push(t('{n} 张图片上传失败，已跳过', { n: failed }));
  return ids;
}

// ── Markdown / 纯文本 ─────────────────────────────────────────────────────

/** **粗** *斜* `码` ~~删~~ [字](链接) → runs。 @param {string} s */
function mdInline(s) {
  /** @type {any[]} */ const out = [];
  // 下划线形式要求两侧不是字母数字，snake_case 这类标识符不会被当成斜体 / 粗体
  const re = /\*\*(.+?)\*\*|(?<![\p{L}\p{N}_])__(.+?)__(?![\p{L}\p{N}_])|\*(?!\s)(.+?)\*|(?<![\p{L}\p{N}_])_(?!\s)(.+?)_(?![\p{L}\p{N}_])|`([^`]+)`|~~(.+?)~~|\[([^\]]+)\]\(([^)\s]+)\)/gu;
  let last = 0, m;
  while ((m = re.exec(s))) {
    if (m.index > last) out.push([s.slice(last, m.index)]);
    if (m[1] || m[2]) out.push([m[1] || m[2], { b: 1 }]);
    else if (m[3] || m[4]) out.push([m[3] || m[4], { i: 1 }]);
    else if (m[5]) out.push([m[5], { k: 1 }]);
    else if (m[6]) out.push([m[6], { s: 1 }]);
    else out.push([m[7], { a: m[8] }]);
    last = re.lastIndex;
  }
  if (last < s.length) out.push([s.slice(last)]);
  return out;
}

/** Markdown（纯文本也按它走，普通段落不受影响）→ 文档块。 @param {string} src */
export function fromMarkdown(src) {
  /** @type {any[]} */ const blocks = [];
  const lines = src.replace(/^\ufeff/, '').replace(/\r\n?/g, '\n').split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^\s*```/.test(line)) {
      const code = [];
      while (++i < lines.length && !/^\s*```/.test(lines[i])) code.push(lines[i]);
      blocks.push({ id: uid('b'), t: 'code', runs: [[code.join('\n')]] });
      continue;
    }
    if (!line.trim()) continue;
    const ind = Math.min(4, Math.floor((line.match(/^\s*/)?.[0].replace(/\t/g, '    ').length ?? 0) / 2));
    let m;
    if ((m = line.match(/^(#{1,6})\s+(.*)$/))) blocks.push({ id: uid('b'), t: 'h' + Math.min(3, m[1].length), runs: mdInline(m[2]) });
    else if (/^\s*([-*_])\s*\1\s*\1[\s\-*_]*$/.test(line)) blocks.push({ id: uid('b'), t: 'hr' });
    else if ((m = line.match(/^\s*[-*+]\s+\[([ xX])\]\s+(.*)$/))) blocks.push({ id: uid('b'), t: 'todo', checked: m[1] !== ' ', runs: mdInline(m[2]) });
    else if ((m = line.match(/^\s*[-*+]\s+(.*)$/))) blocks.push({ id: uid('b'), t: 'ul', indent: ind, runs: mdInline(m[1]) });
    else if ((m = line.match(/^\s*\d+[.)]\s+(.*)$/))) blocks.push({ id: uid('b'), t: 'ol', indent: ind, runs: mdInline(m[1]) });
    else if ((m = line.match(/^>\s?(.*)$/))) blocks.push({ id: uid('b'), t: 'quote', runs: mdInline(m[1]) });
    else blocks.push({ id: uid('b'), t: 'p', runs: mdInline(line) });
  }
  return blocks;
}

// ── 导入 ─────────────────────────────────────────────────────────────────

/**
 * 读一个文件 → 文档块（图片已上传，img 是附件 id）。
 * @param {File} file @param {string} tableId @param {(msg: string) => void} status
 * @returns {Promise<{ blocks: any[], notes: string[] }>}
 */
export async function importDocFile(file, tableId, status) {
  const e = checkFile(file);
  status(t('正在读取 {name}…', { name: file.name }));
  /** @type {{ blocks: any[], media: Map<string, any>, notes: string[] }} */ let r;
  if (e === 'docx' || e === 'docm' || e === 'dotx') r = await (await import('../io/docx.js')).fromDocx(await file.arrayBuffer());
  else if (e === 'pages') r = await (await import('../io/iwork.js')).fromPages(await file.arrayBuffer());
  else if (e === 'md' || e === 'markdown' || e === 'txt' || e === 'text' || !e) r = { blocks: fromMarkdown(await file.text()), media: new Map(), notes: [] };
  else throw new Error(t('不支持 .{ext} 文件。文档可以导入 Word（.docx）、Pages（.pages）、Markdown 和纯文本', { ext: e }));
  const notes = [...r.notes];
  const used = new Set(r.blocks.filter((b) => b.t === 'img' && typeof b.img === 'string' && b.img.startsWith('@')).map((b) => b.img));
  const ids = used.size ? await uploadMedia(tableId, r.media, used, status, notes) : new Map();
  /** @type {any[]} */ const blocks = [];
  for (const b of r.blocks) {
    if (b.t === 'img') {
      const id = ids.get(b.img);
      if (id) blocks.push({ ...b, img: id });
      continue;
    }
    if (b.runs) b.runs = normRuns(b.runs);
    blocks.push(b);
  }
  return { blocks, notes };
}

/**
 * 读一个文件 → 幻灯片（已 normDeck 前的原始页；图片已上传）。
 * @param {File} file @param {string} tableId @param {(msg: string) => void} status
 * @returns {Promise<{ slides: any[], notes: string[], size: { w: number, h: number } }>}
 */
export async function importSlidesFile(file, tableId, status) {
  const e = checkFile(file);
  status(t('正在读取 {name}…', { name: file.name }));
  /** @type {{ slides: any[], media: Map<string, any>, notes: string[], size?: { w: number, h: number } }} */ let r;
  if (e === 'pptx' || e === 'pptm' || e === 'ppsx' || e === 'potx') r = await (await import('../io/pptx.js')).fromPptx(await file.arrayBuffer());
  else if (e === 'key') r = await (await import('../io/iwork.js')).fromKeynote(await file.arrayBuffer());
  else throw new Error(t('不支持 .{ext} 文件。幻灯片可以导入 PowerPoint（.pptx）和 Keynote（.key）', { ext: e }));
  const notes = [...r.notes];
  const used = new Set();
  for (const s of r.slides) for (const el of s.els) if (el.t === 'img' && String(el.img).startsWith('@')) used.add(el.img);
  const ids = used.size ? await uploadMedia(tableId, r.media, used, status, notes) : new Map();
  for (const s of r.slides) {
    s.els = s.els.filter((/** @type {any} */ el) => el.t !== 'img' || ids.has(el.img)).map((/** @type {any} */ el) => {
      if (el.t === 'img') return { ...el, img: ids.get(el.img) };
      if (el.runs) el.runs = normRuns(el.runs);
      return el;
    });
  }
  return { slides: r.slides, notes, size: r.size ?? { w: 960, h: 540 } };
}

/** 超过属性大小上限就从后面砍。 @template T @param {T[]} list @param {(l: T[]) => any} wrap @param {string[]} notes @param {string} unit */
export function fitSize(list, wrap, notes, unit) {
  const size = (/** @type {T[]} */ l) => new TextEncoder().encode(JSON.stringify(wrap(l))).length;
  if (size(list) <= MAX_JSON) return list;
  let lo = 0, hi = list.length;
  while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (size(list.slice(0, mid)) <= MAX_JSON) lo = mid; else hi = mid - 1; }
  notes.push(t('内容超过单份 256KB 的上限，只导入了前 {n} {unit}（共 {total}）', { n: lo, unit, total: list.length }));
  return list.slice(0, lo);
}

// ── 导出 ─────────────────────────────────────────────────────────────────

const OFFICE_IMG = new Set(['image/png', 'image/jpeg', 'image/gif']);

/** Blob → Office 认得的图片（WebP / AVIF / BMP 转 PNG），带原始尺寸。 @param {Blob} blob */
async function officePic(blob) {
  const bmp = await createImageBitmap(blob);
  const w = bmp.width, hh = bmp.height;
  if (OFFICE_IMG.has(blob.type)) { bmp.close?.(); return { data: new Uint8Array(await blob.arrayBuffer()), type: blob.type, w, h: hh }; }
  const cv = document.createElement('canvas');
  cv.width = w; cv.height = hh;
  /** @type {CanvasRenderingContext2D} */ (cv.getContext('2d')).drawImage(bmp, 0, 0);
  bmp.close?.();
  return canvasPic(cv);
}

/** @param {HTMLCanvasElement} cv */
async function canvasPic(cv) {
  const blob = await new Promise((res) => cv.toBlob(res, 'image/png'));
  if (!blob) throw new Error(t('图片转换失败'));
  return { data: new Uint8Array(await /** @type {Blob} */ (blob).arrayBuffer()), type: 'image/png', w: cv.width, h: cv.height };
}

/** 附件 id → Pic。拿不到的跳过（导出里会少这张图）。 @param {string} tableId @param {Iterable<string>} ids */
export async function collectImages(tableId, ids) {
  const { fileUrl } = await import('../io/attach.js');
  /** @type {Map<string, any>} */ const out = new Map();
  await Promise.all([...new Set(ids)].map(async (id) => {
    try {
      const res = await fetch(fileUrl(tableId, id), { credentials: 'same-origin' });
      if (res.ok) out.set(id, await officePic(await res.blob()));
    } catch { /* 跳过 */ }
  }));
  return out;
}

/**
 * 嵌入块的当前画面 → 快照：表格 / 透视表取文字，图表取图片。
 * @param {Element | null | undefined} host 包着 .emb 的元素
 * @returns {Promise<{ rows?: string[][], pic?: any } | null>}
 */
export async function snapEmbed(host) {
  const emb = host?.querySelector('.emb');
  if (!emb) return null;
  const canvas = /** @type {HTMLCanvasElement | null} */ (emb.querySelector('canvas'));
  if (canvas && canvas.width && canvas.height) {
    try { return { pic: await canvasPic(canvas) }; } catch { return null; }
  }
  const table = emb.querySelector('table');
  if (!table) return null;
  const grid = table.classList.contains('emb__table');
  /** @type {string[][]} */ const rows = [];
  for (const tr of table.querySelectorAll('tr')) {
    // 区域表格：去掉列字母那一行和行号那一列
    if (grid && tr.parentElement?.tagName === 'THEAD') continue;
    const cells = [...tr.children].map((c) => (c.textContent ?? '').trim());
    rows.push(grid ? cells.slice(1) : cells);
  }
  return rows.length ? { rows } : null;
}

/** 等嵌入的数据都载入（最多等一会儿）。 @param {Element} root */
export async function embedsSettled(root) {
  for (let i = 0; i < 20; i++) {
    const busy = [...root.querySelectorAll('.emb__msg')].some((m) => (m.textContent ?? '').startsWith(t('载入中…')));
    if (!busy) return;
    await new Promise((r) => setTimeout(r, 150));
  }
}

export const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
export const PPTX_MIME = 'application/vnd.openxmlformats-officedocument.presentationml.presentation';
