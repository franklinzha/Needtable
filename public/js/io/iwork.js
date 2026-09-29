/**
 * 读 Pages（.pages）和 Keynote（.key）里的文字。零依赖，纯函数（见 scripts/office.test.mjs）。
 *
 * 2013 年以后的 iWork 文件是一个 ZIP，里面 Index/*.iwa 是 Apple 私有的 IWA 格式：
 *   一串块，每块 = 0x00 + 3 字节小端长度 + 一段 Snappy 压缩（不带校验）的数据；
 *   解压后是一串“归档”：varint 长度 + ArchiveInfo{1: 对象编号, 2: MessageInfo{1: 类型, 3: 长度}…} + 各消息正文（protobuf）。
 * 我们只认 TSWP.StorageArchive（类型 2001）：字段 1 是种类（0 正文 / 3 文本框 / 4 演讲者备注 / 5 表格单元格…），
 * 字段 3 是纯文本。样式、图片、表格、版式都不解析 —— 格式没有公开文档，只能做到“把字拿出来”。
 * 要完整保留格式，请在 Pages / Keynote 里用“文件 → 导出为 → Word / PowerPoint”，再导入 .docx / .pptx。
 */

import { unzip } from './zip.js';
import { uid } from '../../shared/util/uid.js';
import { t } from '../../shared/i18n/i18n.js';

const STORAGE = 2001;
const KIND_BODY = 0, KIND_TEXTBOX = 3, KIND_NOTE = 4;

/** Snappy 原始格式解压。 @param {Uint8Array} src @returns {Uint8Array} */
export function snappy(src) {
  let p = 0, len = 0, shift = 0;
  for (;;) {
    const b = src[p++];
    len |= (b & 0x7f) << shift;
    if (!(b & 0x80)) break;
    shift += 7;
    if (shift > 28) throw new Error('Snappy 长度错误');
  }
  const out = new Uint8Array(len);
  let o = 0;
  while (p < src.length) {
    const tag = src[p++];
    const type = tag & 3;
    if (type === 0) {
      let n = tag >>> 2;
      if (n >= 60) {
        const bytes = n - 59;
        n = 0;
        for (let i = 0; i < bytes; i++) n |= src[p++] << (8 * i);
      }
      n += 1;
      if (o + n > len || p + n > src.length) throw new Error('Snappy 数据损坏');
      out.set(src.subarray(p, p + n), o);
      p += n; o += n;
      continue;
    }
    let n, off;
    if (type === 1) { n = ((tag >>> 2) & 7) + 4; off = ((tag >>> 5) << 8) | src[p++]; }
    else if (type === 2) { n = (tag >>> 2) + 1; off = src[p] | (src[p + 1] << 8); p += 2; }
    else { n = (tag >>> 2) + 1; off = (src[p] | (src[p + 1] << 8) | (src[p + 2] << 16) | (src[p + 3] << 24)) >>> 0; p += 4; }
    if (!off || off > o || o + n > len) throw new Error('Snappy 数据损坏');
    // 可能重叠（off < n），逐字节复制
    for (let i = 0; i < n; i++, o++) out[o] = out[o - off];
  }
  return o === len ? out : out.subarray(0, o);
}

/** IWA 文件 → 解压后的整段字节。 @param {Uint8Array} src */
export function iwaData(src) {
  const parts = [];
  let p = 0, total = 0;
  while (p + 4 <= src.length) {
    if (src[p] !== 0) throw new Error('IWA 块头错误');
    const n = src[p + 1] | (src[p + 2] << 8) | (src[p + 3] << 16);
    const chunk = snappy(src.subarray(p + 4, p + 4 + n));
    parts.push(chunk);
    total += chunk.length;
    p += 4 + n;
  }
  const out = new Uint8Array(total);
  let o = 0;
  for (const c of parts) { out.set(c, o); o += c.length; }
  return out;
}

/**
 * protobuf 字段表：[{ f: 字段号, w: 类型, v: 数字 | 字节 }]。只做我们需要的：varint、定长、带长度。
 * @param {Uint8Array} b @returns {{ f: number, w: number, v: any }[]}
 */
export function pbFields(b) {
  const out = [];
  let p = 0;
  const varint = () => {
    let v = 0, mul = 1;
    for (let i = 0; i < 10; i++) {
      const x = b[p++];
      if (x === undefined) throw new Error('protobuf 截断');
      v += (x & 0x7f) * mul;
      mul *= 128;
      if (!(x & 0x80)) return v;
    }
    throw new Error('protobuf varint 太长');
  };
  while (p < b.length) {
    const key = varint();
    const f = Math.floor(key / 8), w = key % 8;
    if (w === 0) out.push({ f, w, v: varint() });
    else if (w === 1) { out.push({ f, w, v: b.subarray(p, p + 8) }); p += 8; }
    else if (w === 2) { const n = varint(); if (p + n > b.length) throw new Error('protobuf 截断'); out.push({ f, w, v: b.subarray(p, p + n) }); p += n; }
    else if (w === 5) { out.push({ f, w, v: b.subarray(p, p + 4) }); p += 4; }
    else throw new Error('protobuf 类型不支持');
  }
  return out;
}

/**
 * 解压后的 IWA → [{ id, type, data }]（一个归档可能有多条消息，这里各自展开，id 相同）。
 * @param {Uint8Array} d
 */
export function iwaArchives(d) {
  const out = [];
  let p = 0;
  while (p < d.length) {
    let n = 0, mul = 1;
    for (;;) { const x = d[p++]; n += (x & 0x7f) * mul; mul *= 128; if (!(x & 0x80) || p >= d.length) break; }
    const info = pbFields(d.subarray(p, p + n));
    p += n;
    const id = info.find((x) => x.f === 1)?.v ?? 0;
    for (const mi of info.filter((x) => x.f === 2)) {
      const m = pbFields(mi.v);
      const type = m.find((x) => x.f === 1)?.v ?? 0;
      const len = m.find((x) => x.f === 3)?.v ?? 0;
      out.push({ id, type, data: d.subarray(p, p + len) });
      p += len;
    }
  }
  return out;
}

const dec = new TextDecoder();

/** StorageArchive → { kind, text }。 @param {Uint8Array} data */
function storage(data) {
  const f = pbFields(data);
  return {
    kind: f.find((x) => x.f === 1 && x.w === 0)?.v ?? KIND_BODY,
    text: f.filter((x) => x.f === 3 && x.w === 2).map((x) => dec.decode(x.v)).join(''),
  };
}

/** 去掉占位用的特殊字符，按段落切开。 @param {string} t */
const paragraphs = (t) => t.replace(/[\ufffc\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '')
  .split(/\r\n|[\n\r\u2029]/).map((s) => s.replace(/\u2028/g, '\n').replace(/\s+$/, ''));

/** 包里的 Index/*.iwa：新格式直接在 ZIP 里，旧一点的套在 Index.zip 里。 @param {ArrayBuffer | Uint8Array} buf */
async function indexOf(buf) {
  let zip = unzip(buf);
  if (![...zip.keys()].some((n) => /^Index\/.*\.iwa$/.test(n))) {
    const inner = zip.get('Index.zip');
    if (inner) zip = unzip(await inner.bytes());
    else if ([...zip.keys()].some((n) => /index\.(xml|apxl)(\.gz)?$/i.test(n))) {
      throw new Error(t("这是 iWork ‘09 的旧格式，请先用新版 Pages / Keynote 打开并存一次，或者导出成 Word / PowerPoint"));
    } else throw new Error(t("没有找到 iWork 文档内容，文件可能已损坏"));
  }
  /** @type {Map<string, ReturnType<typeof iwaArchives>>} */ const out = new Map();
  for (const [name, e] of zip) {
    if (!/^Index\/.*\.iwa$/.test(name)) continue;
    try { out.set(name, iwaArchives(iwaData(await e.bytes()))); } catch { /* 个别部件读不了就跳过 */ }
  }
  return out;
}

const limitNote = () => t('iWork 格式只导入了文字（不含样式、图片和表格）；要保留格式，请在 Pages / Keynote 里”文件 → 导出为 → Word / PowerPoint”后再导入');

/** Pages → 文档块（都是普通段落）。 @param {ArrayBuffer | Uint8Array} buf */
export async function fromPages(buf) {
  const index = await indexOf(buf);
  const doc = index.get('Index/Document.iwa') ?? [...index.values()].flat();
  const stores = doc.filter((a) => a.type === STORAGE).map((a) => storage(a.data));
  const body = stores.filter((s) => s.kind === KIND_BODY && s.text.trim());
  const use = body.length ? body : stores.filter((s) => s.kind === KIND_TEXTBOX && s.text.trim());
  /** @type {any[]} */ const blocks = [];
  for (const s of use) {
    for (const line of paragraphs(s.text)) {
      if (!line && (!blocks.length || !blocks[blocks.length - 1].runs.length)) continue;
      blocks.push({ id: uid('b'), t: 'p', runs: line ? [[line]] : [] });
    }
  }
  while (blocks.length && !blocks[blocks.length - 1].runs.length) blocks.pop();
  if (!blocks.length) throw new Error(t('没有在这个 Pages 文件里找到文字'));
  return { blocks, media: new Map(), notes: [limitNote()] };
}

/**
 * Keynote → 幻灯片：每个 Index/Slide*.iwa 一页，第一段短文字当标题，其余当正文，演讲者备注照搬。
 * 页的顺序：在 Document.iwa 里找“引用了最多页节点的那条列表”；找不到就按文件名。
 * @param {ArrayBuffer | Uint8Array} buf
 */
export async function fromKeynote(buf) {
  const index = await indexOf(buf);
  const files = [...index.keys()].filter((n) => /^Index\/Slide[^/]*\.iwa$/.test(n) && !/Master|Template/i.test(n));
  files.sort((a, b) => (Number(a.match(/(\d+)/)?.[1]) || 0) - (Number(b.match(/(\d+)/)?.[1]) || 0));
  const order = slideOrder(index, files);
  const slides = [];
  for (const name of order) {
    const arcs = index.get(name) ?? [];
    const stores = arcs.filter((a) => a.type === STORAGE).map((a) => storage(a.data));
    const texts = stores.filter((s) => (s.kind === KIND_TEXTBOX || s.kind === KIND_BODY) && s.text.trim()).map((s) => paragraphs(s.text).join('\n').trim());
    const note = stores.filter((s) => s.kind === KIND_NOTE).map((s) => s.text.trim()).filter(Boolean).join('\n');
    const ti = texts.findIndex((t) => !t.includes('\n') && t.length <= 80);
    const title = ti >= 0 ? texts.splice(ti, 1)[0] : '';
    const body = texts.join('\n\n');
    /** @type {any[]} */ const els = [];
    if (title) els.push({ id: uid('e'), t: 'text', x: 60, y: 36, w: 840, h: 80, size: 36, b: 1, color: '#1f2328', align: 'left', role: 'title', runs: [[title]] });
    if (body) els.push({ id: uid('e'), t: 'text', x: 60, y: title ? 136 : 60, w: 840, h: title ? 360 : 420, size: body.length > 400 ? 16 : 22, color: '#1f2328', align: 'left', role: 'body', runs: [[body]] });
    /** @type {any} */ const s = { id: uid('s'), bg: '#ffffff', els };
    if (note) s.notes = note.slice(0, 5000);
    slides.push(s);
  }
  if (!slides.length) throw new Error(t('没有在这个 Keynote 文件里找到幻灯片'));
  return { slides, media: new Map(), notes: [limitNote()], ratio: 16 / 9 };
}

/**
 * 页的顺序（启发式）：每个 Slide*.iwa 里第一个归档是这一页的对象；Document.iwa 里引用它的是“页节点”；
 * 再找一个归档，按字段顺序引用了最多的页节点 —— 那就是放映顺序。
 * @param {Map<string, {id: number, type: number, data: Uint8Array}[]>} index @param {string[]} files
 */
function slideOrder(index, files) {
  const doc = index.get('Index/Document.iwa');
  if (!doc) return files;
  /** @type {Map<number, string>} */ const slideOf = new Map();
  for (const f of files) { const id = index.get(f)?.[0]?.id; if (id) slideOf.set(id, f); }
  /** 消息里所有 Reference（子消息 {1: 编号}）的编号，按出现顺序。 @param {Uint8Array} data */
  const refs = (data) => {
    const out = [];
    try {
      for (const x of pbFields(data)) {
        if (x.w !== 2 || x.v.length > 12) continue;
        try { const r = pbFields(x.v); if (r.length === 1 && r[0].f === 1 && r[0].w === 0) out.push(r[0].v); } catch { /* 不是子消息 */ }
      }
    } catch { /* 忽略 */ }
    return out;
  };
  /** @type {Map<number, string>} */ const nodeOf = new Map();
  for (const a of doc) for (const r of refs(a.data)) if (slideOf.has(r) && !nodeOf.has(a.id)) nodeOf.set(a.id, /** @type {string} */ (slideOf.get(r)));
  let best = /** @type {string[]} */ ([]);
  for (const a of doc) {
    const list = refs(a.data).map((r) => nodeOf.get(r) ?? slideOf.get(r)).filter(Boolean);
    if (list.length > best.length) best = /** @type {string[]} */ (list);
  }
  if (best.length < Math.min(2, files.length)) return files;
  const seen = new Set(best);
  return [...new Set(best), ...files.filter((f) => !seen.has(f))];
}
