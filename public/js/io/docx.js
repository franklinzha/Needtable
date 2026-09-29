/**
 * 文档 ⇄ Word（.docx），零依赖。纯函数，不碰 DOM，Node 里也能跑（见 scripts/office.test.mjs）。
 *
 * 导出：段落样式（标题 1-3 / 引用 / 代码）、列表（多级、有序列表各自从 1 编号）、待办（☐ ☑ 前缀）、
 *       分割线、图片（按块宽度占版心的比例）、行内的加粗 / 斜体 / 下划线 / 删除线 / 行内代码 / 字色 / 高亮 / 链接、
 *       对齐和缩进。嵌入的表格内容导出成当下的快照：区域和透视表是 Word 表格，图表是图片。
 * 导入：反过来认上面这些；Word 表格按行变成段落（单元格用 │ 隔开），页眉页脚、脚注、批注不导入。
 *       图片先放进 media，块里写 img: '@键'，由调用方上传后换成附件编号。
 */

import { zipStore, unzip } from './zip.js';
import { esc, xmlRoot, kids, kid, all, find, parseRels, relsOf, imageMime, mimeExt } from './xml.js';
import { uid } from '../../shared/util/uid.js';
import { t } from '../../shared/i18n/i18n.js';

const HEAD = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';
const W_NS = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';
const DRAW_NS = 'xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"';
const REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
/** A4 纵向、页边距 2.54 cm 时的版心宽度 */
const CONTENT_EMU = Math.round(6.27 * 914400);
const CONTENT_TWIPS = 9026;
/** 文档里缩进一级 24px ≈ 0.25 英寸 */
const INDENT_TWIPS = 360;
const MONO = /consolas|courier|menlo|monaco|mono|code/i;
const TEXT_TYPES = new Set(['p', 'h1', 'h2', 'h3', 'quote', 'code', 'ul', 'ol', 'todo']);

/**
 * @typedef {{ data: Uint8Array, type: string, w?: number, h?: number }} Pic
 * @typedef {{ rows?: string[][], pic?: Pic }} Snap
 * @typedef {{ images?: Map<string, Pic>, embeds?: Map<string, Snap>, title?: string }} Assets
 */

// ── 导出 ─────────────────────────────────────────────────────────────────

/** @param {{ blocks: any[] }} doc @param {Assets} [assets] @returns {Uint8Array} */
export function toDocx(doc, assets = {}) {
  const images = assets.images ?? new Map(), embeds = assets.embeds ?? new Map();
  /** @type {string[]} */ const rels = [
    `<Relationship Id="rIdStyles" Type="${REL}/styles" Target="styles.xml"/>`,
    `<Relationship Id="rIdNum" Type="${REL}/numbering" Target="numbering.xml"/>`,
    `<Relationship Id="rIdSettings" Type="${REL}/settings" Target="settings.xml"/>`,
  ];
  /** @type {{name: string, data: Uint8Array}[]} */ const media = [];
  const exts = new Set();
  let rid = 0, picId = 0;
  const link = (/** @type {string} */ href) => {
    const id = 'rIdL' + ++rid;
    rels.push(`<Relationship Id="${id}" Type="${REL}/hyperlink" Target="${esc(href)}" TargetMode="External"/>`);
    return id;
  };
  const picXml = (/** @type {Pic} */ p, /** @type {number} */ widthEmu, /** @type {string} */ alt) => {
    const ext = mimeExt(p.type);
    exts.add(ext);
    const n = ++picId, id = 'rIdP' + n, name = 'image' + n + '.' + ext;
    media.push({ name: 'word/media/' + name, data: p.data });
    rels.push(`<Relationship Id="${id}" Type="${REL}/image" Target="media/${name}"/>`);
    const cx = Math.max(1, Math.round(widthEmu));
    const cy = Math.max(1, Math.round(p.w && p.h ? cx * p.h / p.w : cx * 0.6));
    return `<w:r><w:drawing><wp:inline distT="0" distB="0" distL="0" distR="0"><wp:extent cx="${cx}" cy="${cy}"/>`
      + `<wp:docPr id="${n}" name="图片 ${n}" descr="${esc(alt)}"/><wp:cNvGraphicFramePr><a:graphicFrameLocks noChangeAspect="1"/></wp:cNvGraphicFramePr>`
      + `<a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic>`
      + `<pic:nvPicPr><pic:cNvPr id="${n}" name="${name}"/><pic:cNvPicPr/></pic:nvPicPr>`
      + `<pic:blipFill><a:blip r:embed="${id}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill>`
      + `<pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr>`
      + `</pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r>`;
  };

  // 每一段连续的有序列表单独一个 numId，这样各自从 1 开始
  /** @type {string[]} */ const nums = ['<w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num>'];
  let olNum = 0, prevT = '';
  const body = [];
  for (const b of Array.isArray(doc?.blocks) ? doc.blocks : []) {
    if (b.t === 'ol' && prevT !== 'ol') {
      olNum = nums.length + 1;
      nums.push(`<w:num w:numId="${olNum}"><w:abstractNumId w:val="1"/>`
        + Array.from({ length: 9 }, (_, l) => `<w:lvlOverride w:ilvl="${l}"><w:startOverride w:val="1"/></w:lvlOverride>`).join('') + '</w:num>');
    }
    prevT = b.t;
    if (TEXT_TYPES.has(b.t)) body.push(para(b, olNum, link));
    else if (b.t === 'hr') body.push('<w:p><w:pPr><w:pBdr><w:bottom w:val="single" w:sz="6" w:space="1" w:color="A0A0A0"/></w:pBdr></w:pPr></w:p>');
    else if (b.t === 'img') {
      const p = images.get(b.img);
      const w = Math.max(10, Math.min(100, Number(b.w) || 100));
      if (p) body.push('<w:p><w:pPr><w:jc w:val="center"/></w:pPr>' + picXml(p, CONTENT_EMU * w / 100, b.cap || '图片') + '</w:p>');
      if (b.cap) body.push(`<w:p><w:pPr><w:pStyle w:val="Caption"/><w:jc w:val="center"/></w:pPr>${run(String(b.cap), null)}</w:p>`);
    } else if (b.t === 'embed') {
      const s = embeds.get(b.id);
      const title = b.title ? String(b.title) : '';
      if (title) body.push(`<w:p><w:pPr><w:pStyle w:val="Caption"/></w:pPr>${run(title, { b: 1 })}</w:p>`);
      if (s?.rows?.length) body.push(table(s.rows));
      else if (s?.pic) body.push('<w:p><w:pPr><w:jc w:val="center"/></w:pPr>' + picXml(s.pic, CONTENT_EMU, title || '图表') + '</w:p>');
      else body.push(`<w:p>${run('［表格内容' + (title ? '：' + title : '') + '］', { c: '#808080' })}</w:p>`);
    }
  }
  if (!body.length) body.push('<w:p/>');

  const document = HEAD + `<w:document ${W_NS} ${DRAW_NS}><w:body>${body.join('')}`
    + '<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="851" w:footer="992" w:gutter="0"/></w:sectPr>'
    + '</w:body></w:document>';
  const types = HEAD + '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
    + '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
    + '<Default Extension="xml" ContentType="application/xml"/>'
    + [...exts].map((e) => `<Default Extension="${e}" ContentType="image/${e}"/>`).join('')
    + '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>'
    + '<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>'
    + '<Override PartName="/word/numbering.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml"/>'
    + '<Override PartName="/word/settings.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.settings+xml"/>'
    + '<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>'
    + '</Types>';
  return zipStore([
    { name: '[Content_Types].xml', data: types },
    { name: '_rels/.rels', data: HEAD + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
      + `<Relationship Id="rId1" Type="${REL}/officeDocument" Target="word/document.xml"/>`
      + '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>'
      + '</Relationships>' },
    { name: 'docProps/core.xml', data: coreXml(assets.title) },
    { name: 'word/document.xml', data: document },
    { name: 'word/_rels/document.xml.rels', data: HEAD + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' + rels.join('') + '</Relationships>' },
    { name: 'word/styles.xml', data: STYLES },
    { name: 'word/settings.xml', data: HEAD + `<w:settings ${W_NS}><w:defaultTabStop w:val="420"/><w:compat><w:compatSetting w:name="compatibilityMode" w:uri="http://schemas.microsoft.com/office/word" w:val="15"/></w:compat></w:settings>` },
    { name: 'word/numbering.xml', data: numberingXml(nums) },
    ...media,
  ]);
}

/** @param {string} [title] */
export function coreXml(title) {
  const now = new Date().toISOString().replace(/\.\d+Z$/, 'Z');
  return HEAD + '<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">'
    + (title ? `<dc:title>${esc(title)}</dc:title>` : '')
    + `<dcterms:created xsi:type="dcterms:W3CDTF">${now}</dcterms:created><dcterms:modified xsi:type="dcterms:W3CDTF">${now}</dcterms:modified>`
    + '</cp:coreProperties>';
}

const STYLE_OF = { h1: 'Heading1', h2: 'Heading2', h3: 'Heading3', quote: 'Quote', code: 'Code' };

/** 一个文字块 → <w:p>。 @param {any} b @param {number} olNum @param {(href: string) => string} link */
function para(b, olNum, link) {
  const ind = Math.max(0, Math.min(4, b.indent | 0));
  let ppr = '';
  const style = /** @type {Record<string, string>} */ (STYLE_OF)[b.t];
  if (style) ppr += `<w:pStyle w:val="${style}"/>`;
  else if (b.t === 'ul' || b.t === 'ol') ppr += '<w:pStyle w:val="ListParagraph"/>';
  if (b.t === 'ul' || b.t === 'ol') ppr += `<w:numPr><w:ilvl w:val="${ind}"/><w:numId w:val="${b.t === 'ul' ? 1 : olNum}"/></w:numPr>`;
  else if (ind) ppr += `<w:ind w:left="${ind * INDENT_TWIPS}"/>`;
  if (b.align === 'center' || b.align === 'right') ppr += `<w:jc w:val="${b.align}"/>`;
  let runs = '';
  if (b.t === 'todo') runs += run(b.checked ? '☑ ' : '☐ ', null);
  for (const r of Array.isArray(b.runs) ? b.runs : []) {
    const m = r[1] ?? null;
    const x = run(String(r[0] ?? ''), m);
    runs += m?.a ? `<w:hyperlink r:id="${link(m.a)}" w:history="1">${x}</w:hyperlink>` : x;
  }
  return `<w:p>${ppr ? '<w:pPr>' + ppr + '</w:pPr>' : ''}${runs}</w:p>`;
}

/** 一段同样式的文字 → <w:r>；换行变 <w:br/>，制表符变 <w:tab/>。 @param {string} text @param {any} m */
function run(text, m) {
  let rpr = '';
  if (m?.a) rpr += '<w:rStyle w:val="Hyperlink"/>';
  if (m?.k) rpr += '<w:rFonts w:ascii="Consolas" w:hAnsi="Consolas"/>';
  if (m?.b) rpr += '<w:b/>';
  if (m?.i) rpr += '<w:i/>';
  if (m?.s) rpr += '<w:strike/>';
  if (m?.c) rpr += `<w:color w:val="${m.c.slice(1).toUpperCase()}"/>`;
  if (m?.u) rpr += '<w:u w:val="single"/>';
  if (m?.bg || m?.k) rpr += `<w:shd w:val="clear" w:color="auto" w:fill="${(m.bg ?? '#eeeeee').slice(1).toUpperCase()}"/>`;
  const parts = [];
  text.split('\n').forEach((line, i) => {
    if (i) parts.push('<w:br/>');
    line.split('\t').forEach((seg, j) => {
      if (j) parts.push('<w:tab/>');
      if (seg) parts.push(`<w:t xml:space="preserve">${esc(seg)}</w:t>`);
    });
  });
  return `<w:r>${rpr ? '<w:rPr>' + rpr + '</w:rPr>' : ''}${parts.join('')}</w:r>`;
}

/** 快照的行列 → Word 表格，第一行加粗当表头。 @param {string[][]} rows */
function table(rows) {
  const cols = Math.max(1, ...rows.map((r) => r.length));
  const cw = Math.floor(CONTENT_TWIPS / cols);
  const grid = '<w:tblGrid>' + `<w:gridCol w:w="${cw}"/>`.repeat(cols) + '</w:tblGrid>';
  const trs = rows.map((r, i) => '<w:tr>' + Array.from({ length: cols }, (_, j) =>
    `<w:tc><w:tcPr><w:tcW w:w="${cw}" w:type="dxa"/>${i === 0 ? '<w:shd w:val="clear" w:color="auto" w:fill="F2F2F2"/>' : ''}</w:tcPr>`
    + `<w:p>${run(String(r[j] ?? ''), i === 0 ? { b: 1 } : null)}</w:p></w:tc>`).join('') + '</w:tr>').join('');
  return `<w:tbl><w:tblPr><w:tblStyle w:val="TableGrid"/><w:tblW w:w="${cw * cols}" w:type="dxa"/></w:tblPr>${grid}${trs}</w:tbl><w:p/>`;
}

/** @param {string[]} nums */
function numberingXml(nums) {
  const lvl = (/** @type {number} */ i, /** @type {boolean} */ ordered) => {
    const fmt = ordered ? ['decimal', 'lowerLetter', 'lowerRoman'][i % 3] : 'bullet';
    const txt = ordered ? `%${i + 1}.` : ['●', '○', '■'][i % 3];
    return `<w:lvl w:ilvl="${i}"><w:start w:val="1"/><w:numFmt w:val="${fmt}"/><w:lvlText w:val="${txt}"/><w:lvlJc w:val="left"/>`
      + `<w:pPr><w:ind w:left="${(i + 1) * 420}" w:hanging="420"/></w:pPr>`
      + (ordered ? '' : '<w:rPr><w:rFonts w:ascii="Arial" w:hAnsi="Arial" w:hint="default"/><w:sz w:val="16"/></w:rPr>') + '</w:lvl>';
  };
  const abs = (/** @type {number} */ id, /** @type {boolean} */ ordered) => `<w:abstractNum w:abstractNumId="${id}"><w:multiLevelType w:val="hybridMultilevel"/>`
    + Array.from({ length: 9 }, (_, i) => lvl(i, ordered)).join('') + '</w:abstractNum>';
  return HEAD + `<w:numbering ${W_NS}>${abs(0, false)}${abs(1, true)}${nums.join('')}</w:numbering>`;
}

const STYLES = HEAD + `<w:styles ${W_NS}>`
  + '<w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Calibri" w:hAnsi="Calibri" w:eastAsia="微软雅黑" w:cs="Arial"/><w:sz w:val="22"/><w:szCs w:val="22"/><w:lang w:val="en-US" w:eastAsia="zh-CN"/></w:rPr></w:rPrDefault>'
  + '<w:pPrDefault><w:pPr><w:spacing w:after="120" w:line="300" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults>'
  + '<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:qFormat/></w:style>'
  + [1, 2, 3].map((n) => `<w:style w:type="paragraph" w:styleId="Heading${n}"><w:name w:val="heading ${n}"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/>`
    + `<w:pPr><w:keepNext/><w:spacing w:before="${[360, 280, 240][n - 1]}" w:after="120"/><w:outlineLvl w:val="${n - 1}"/></w:pPr>`
    + `<w:rPr><w:b/><w:sz w:val="${[40, 32, 28][n - 1]}"/><w:szCs w:val="${[40, 32, 28][n - 1]}"/></w:rPr></w:style>`).join('')
  + '<w:style w:type="paragraph" w:styleId="Quote"><w:name w:val="Quote"/><w:basedOn w:val="Normal"/><w:qFormat/>'
  + '<w:pPr><w:pBdr><w:left w:val="single" w:sz="18" w:space="8" w:color="C8C8C8"/></w:pBdr><w:ind w:left="284"/></w:pPr><w:rPr><w:color w:val="595959"/></w:rPr></w:style>'
  + '<w:style w:type="paragraph" w:styleId="Code"><w:name w:val="Code"/><w:basedOn w:val="Normal"/><w:qFormat/>'
  + '<w:pPr><w:shd w:val="clear" w:color="auto" w:fill="F3F3F3"/><w:spacing w:after="0" w:line="240" w:lineRule="auto"/></w:pPr>'
  + '<w:rPr><w:rFonts w:ascii="Consolas" w:hAnsi="Consolas"/><w:sz w:val="20"/></w:rPr></w:style>'
  + '<w:style w:type="paragraph" w:styleId="ListParagraph"><w:name w:val="List Paragraph"/><w:basedOn w:val="Normal"/><w:qFormat/><w:pPr><w:spacing w:after="60"/></w:pPr></w:style>'
  + '<w:style w:type="paragraph" w:styleId="Caption"><w:name w:val="caption"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/><w:rPr><w:color w:val="595959"/><w:sz w:val="20"/></w:rPr></w:style>'
  + '<w:style w:type="character" w:styleId="Hyperlink"><w:name w:val="Hyperlink"/><w:rPr><w:color w:val="0563C1"/><w:u w:val="single"/></w:rPr></w:style>'
  + '<w:style w:type="table" w:styleId="TableGrid"><w:name w:val="Table Grid"/><w:pPr><w:spacing w:after="0" w:line="240" w:lineRule="auto"/></w:pPr><w:tblPr><w:tblBorders>'
  + ['top', 'left', 'bottom', 'right', 'insideH', 'insideV'].map((s) => `<w:${s} w:val="single" w:sz="4" w:space="0" w:color="BFBFBF"/>`).join('')
  + '</w:tblBorders><w:tblCellMar><w:left w:w="108" w:type="dxa"/><w:right w:w="108" w:type="dxa"/></w:tblCellMar></w:tblPr></w:style>'
  + '</w:styles>';

// ── 导入 ─────────────────────────────────────────────────────────────────

/** Word 高亮色名 → 十六进制 */
const HIGHLIGHT = {
  yellow: '#ffff00', green: '#00ff00', cyan: '#00ffff', magenta: '#ff00ff', blue: '#0000ff', red: '#ff0000',
  darkBlue: '#000080', darkCyan: '#008080', darkGreen: '#008000', darkMagenta: '#800080', darkRed: '#800000',
  darkYellow: '#808000', darkGray: '#808080', lightGray: '#c0c0c0', black: '#000000', white: '#ffffff',
};

/** @param {any} v 开关属性：<w:b/> 或 <w:b w:val="1"/> 算开，val = 0 / false / none 算关 */
const on = (v) => v != null && !['0', 'false', 'none', 'off'].includes(String(v.a?.['w:val'] ?? '1').toLowerCase());
/** @param {string | undefined} s */
const hex = (s) => (s && /^[0-9a-f]{6}$/i.test(s) ? '#' + s.toLowerCase() : undefined);

/**
 * @typedef {{ data: Uint8Array, type: string, name: string }} Media
 * @param {ArrayBuffer | Uint8Array} buf
 * @returns {Promise<{ blocks: any[], media: Map<string, Media>, notes: string[] }>}
 */
export async function fromDocx(buf) {
  const zip = unzip(buf);
  const read = async (/** @type {string} */ n) => (zip.has(n) ? zip.get(n)?.text() ?? '' : '');
  const rootRels = parseRels(await read('_rels/.rels'), '');
  const main = [...rootRels.values()].find((r) => r.type.endsWith('/officeDocument'))?.target ?? 'word/document.xml';
  if (!zip.has(main)) throw new Error(t('不是有效的 Word 文档（.docx）'));
  const dir = main.slice(0, main.lastIndexOf('/') + 1);
  const rels = parseRels(await read(relsOf(main)), dir);
  const relOf = (/** @type {string} */ type) => [...rels.values()].find((r) => r.type.endsWith('/' + type))?.target;
  const styles = parseStyles(await read(relOf('styles') ?? dir + 'styles.xml'));
  const numFmt = parseNumbering(await read(relOf('numbering') ?? dir + 'numbering.xml'));
  const body = find(xmlRoot(await read(main)), 'w:body');

  /** @type {any[]} */ const blocks = [];
  /** @type {Map<string, Media>} */ const media = new Map();
  /** @type {string[]} */ const notes = [];
  let skippedPics = 0;

  /** 一张图片 → 块（先放进 media）。 @param {string} rId @param {number} cx EMU */
  const picBlock = async (rId, cx) => {
    const r = rels.get(rId);
    const type = r && !r.external ? imageMime(r.target) : null;
    const entry = r ? zip.get(r.target) : null;
    if (!type || !entry) { skippedPics++; return null; }
    const key = '@' + (media.size + 1);
    media.set(key, { data: await entry.bytes(), type, name: r?.target.split('/').pop() ?? 'image' });
    return { id: uid('b'), t: 'img', img: key, w: Math.max(10, Math.min(100, Math.round(cx / CONTENT_EMU * 100) || 100)) };
  };

  /** @param {any} p <w:p> @param {{ cell?: boolean }} [opt] */
  const paragraph = async (p, opt = {}) => {
    const ppr = kid(p, 'w:pPr');
    const st = styles.get(kid(ppr, 'w:pStyle')?.a['w:val'] ?? '') ?? styles.get(styles.defaultId ?? '');
    /** @type {any} */ const b = { t: 'p' };
    const lvl = kid(ppr, 'w:outlineLvl')?.a['w:val'] ?? st?.outline;
    if (st?.kind) b.t = st.kind;
    else if (lvl != null && Number(lvl) < 9) b.t = 'h' + Math.min(3, Number(lvl) + 1);
    const numPr = kid(ppr, 'w:numPr');
    const numId = kid(numPr, 'w:numId')?.a['w:val'] ?? st?.numId;
    const ilvl = Number(kid(numPr, 'w:ilvl')?.a['w:val'] ?? st?.ilvl ?? 0) || 0;
    if (numId && numId !== '0' && !b.t.startsWith('h')) {
      const fmt = numFmt.get(numId)?.[ilvl] ?? numFmt.get(numId)?.[0];
      if (fmt) { b.t = fmt === 'bullet' ? 'ul' : 'ol'; if (ilvl) b.indent = Math.min(4, ilvl); }
    }
    const jc = kid(ppr, 'w:jc')?.a['w:val'] ?? st?.jc;
    if (jc === 'center' || jc === 'right') b.align = jc;
    else if (jc === 'end') b.align = 'right';
    const left = Number(kid(ppr, 'w:ind')?.a['w:left'] ?? kid(ppr, 'w:ind')?.a['w:start'] ?? 0);
    if (!b.indent && b.t === 'p' && left >= INDENT_TWIPS * 0.8) b.indent = Math.min(4, Math.round(left / INDENT_TWIPS));

    /** @type {any[]} */ const runs = [];
    /** @type {any[]} */ const out = [];
    let mono = 0, chars = 0;
    const flush = () => { if (runs.length) { out.push({ ...b, runs: runs.splice(0) }); } };
    /** @param {any} node @param {string | undefined} href */
    const walk = async (node, href) => {
      for (const c of node.k) {
        if (c.n === 'w:r') await runOf(c, href);
        else if (c.n === 'w:hyperlink') {
          const r = rels.get(c.a['r:id']);
          await walk(c, r?.external ? r.target : href);
        } else if (['w:ins', 'w:smartTag', 'w:fldSimple', 'w:customXml', 'w:sdt', 'w:sdtContent', 'w:bdo', 'w:dir'].includes(c.n)) await walk(c, href);
      }
    };
    /** @param {any} r @param {string | undefined} href */
    const runOf = async (r, href) => {
      const rpr = kid(r, 'w:rPr');
      const cst = styles.get(kid(rpr, 'w:rStyle')?.a['w:val'] ?? '');
      /** @type {any} */ const m = {};
      if (on(kid(rpr, 'w:b')) || (cst?.b && !kid(rpr, 'w:b'))) m.b = 1;
      if (on(kid(rpr, 'w:i')) || (cst?.i && !kid(rpr, 'w:i'))) m.i = 1;
      if (on(kid(rpr, 'w:u'))) m.u = 1;
      if (on(kid(rpr, 'w:strike')) || on(kid(rpr, 'w:dstrike'))) m.s = 1;
      const c = hex(kid(rpr, 'w:color')?.a['w:val']);
      if (c && c !== '#000000' && !href) m.c = c;
      const hl = kid(rpr, 'w:highlight')?.a['w:val'];
      const bg = /** @type {Record<string, string>} */ (HIGHLIGHT)[hl ?? ''] ?? hex(kid(rpr, 'w:shd')?.a['w:fill']);
      if (bg && bg !== '#ffffff') m.bg = bg;
      const font = kid(rpr, 'w:rFonts')?.a['w:ascii'] ?? cst?.font ?? '';
      const isMono = MONO.test(font);
      if (isMono && m.bg === '#eeeeee') delete m.bg;
      if (href) m.a = href;
      let text = '';
      for (const x of r.k) {
        if (x.n === 'w:t') text += x.k.map((/** @type {any} */ t) => t.t ?? '').join('');
        else if (x.n === 'w:tab' || x.n === 'w:ptab') text += '\t';
        else if (x.n === 'w:br' || x.n === 'w:cr') { if (x.a['w:type'] !== 'page' && x.a['w:type'] !== 'column') text += '\n'; }
        else if (x.n === 'w:noBreakHyphen') text += '-';
        else if ((x.n === 'w:drawing' || x.n === 'w:pict' || x.n === 'mc:AlternateContent') && !opt.cell) {
          const blip = find(x, 'a:blip')?.a['r:embed'] ?? find(x, 'v:imagedata')?.a['r:id'];
          if (!blip) continue;
          if (text) { pushRun(text, m, isMono); text = ''; }
          const cx = Number(find(x, 'wp:extent')?.a.cx) || CONTENT_EMU;
          const img = await picBlock(blip, cx);
          if (img) { flush(); out.push(img); }
        }
      }
      if (text) pushRun(text, m, isMono);
    };
    /** @param {string} text @param {any} m @param {boolean} isMono */
    const pushRun = (text, m, isMono) => {
      chars += text.length;
      if (isMono) { mono += text.length; if (b.t !== 'code') m = { ...m, k: 1 }; }
      runs.push(Object.keys(m).length ? [text, m] : [text]);
    };
    await walk(p, undefined);

    // 整段都是等宽字体：当成代码块，去掉行内代码标记
    if (b.t === 'p' && chars > 0 && mono === chars && runs.length) {
      b.t = 'code';
      for (const r of runs) { if (r[1]) { delete r[1].k; delete r[1].bg; if (!Object.keys(r[1]).length) r.length = 1; } }
    }
    // ☐ / ☑ 开头的段落是待办
    const first = runs[0];
    if (first && (b.t === 'p' || b.t === 'ul') && /^[☐☑☒□■✓✔]\s?/.test(first[0])) {
      b.checked = /^[☑☒■✓✔]/.test(first[0]) || undefined;
      b.t = 'todo';
      first[0] = first[0].replace(/^[☐☑☒□■✓✔]\s?/, '');
      if (!first[0]) runs.shift();
    }
    // 只有下边框、没有字的段落是分割线
    if (!runs.length && !out.length && find(kid(ppr, 'w:pBdr'), 'w:bottom')) return [{ id: uid('b'), t: 'hr' }];
    flush();
    if (!out.length) out.push({ ...b, runs: [] });
    return out.map((x) => (x.t === 'img' ? x : { id: uid('b'), ...x }));
  };

  /** @param {any} node */
  const walkBody = async (node) => {
    let afterTable = false;
    for (const c of node?.k ?? []) {
      const wasTable = afterTable;
      afterTable = c.n === 'w:tbl';
      if (c.n === 'w:p') {
        for (const b of await paragraph(c)) {
          const prev = blocks[blocks.length - 1];
          if (b.t === 'caption') {
            // 紧跟在图片后面的题注并回图片块
            const text = (b.runs ?? []).map((/** @type {any} */ r) => r[0]).join('').trim();
            if (prev?.t === 'img' && !prev.cap && text) { prev.cap = text.slice(0, 200); continue; }
            b.t = 'p';
          }
          if (wasTable && isEmpty(b)) continue;
          blocks.push(b);
        }
      } else if (c.n === 'w:tbl') {
        for (const tr of all(c, 'w:tr')) {
          const cells = [];
          for (const tc of kids(tr, 'w:tc')) {
            const ps = [];
            for (const p of kids(tc, 'w:p')) for (const x of await paragraph(p, { cell: true })) ps.push(...(x.runs ?? []));
            cells.push(ps);
          }
          while (cells.length && !cells[cells.length - 1].some((r) => String(r[0]).trim())) cells.pop();
          const row = [];
          cells.forEach((cr, i) => { if (i) row.push([' │ ']); row.push(...cr); });
          if (row.some((r) => String(r[0]).trim() && r[0] !== ' │ ')) blocks.push({ id: uid('b'), t: 'p', runs: row });
        }
      } else if (c.n === 'w:sdt') await walkBody(kid(c, 'w:sdtContent'));
      else if (c.n === 'w:customXml' || c.n === 'w:ins') await walkBody(c);
    }
  };
  await walkBody(body);

  // Word 喜欢用空段落撑间距：连续的空段落只留一个，首尾的去掉
  const tidy = blocks.filter((b, i) => !(isEmpty(b) && (i === 0 || isEmpty(blocks[i - 1]))));
  while (tidy.length && isEmpty(tidy[tidy.length - 1])) tidy.pop();
  if (skippedPics) notes.push(t('{n} 张图片的格式浏览器显示不了（如 EMF / WMF），已跳过', { n: skippedPics }));
  return { blocks: tidy, media, notes };
}

/** @param {any} b */
const isEmpty = (b) => b.t === 'p' && !(b.runs ?? []).some((/** @type {any} */ r) => String(r[0]).trim());

/**
 * styles.xml → Map<styleId, 解析后的样式>（顺着 basedOn 继承）。
 * @param {string} src
 */
function parseStyles(src) {
  /** @type {Map<string, any> & { defaultId?: string }} */ const out = new Map();
  if (!src) return out;
  /** @type {Map<string, any>} */ const raw = new Map();
  for (const s of kids(xmlRoot(src), 'w:style')) {
    const id = s.a['w:styleId'];
    if (!id) continue;
    raw.set(id, s);
    if (s.a['w:type'] === 'paragraph' && on({ a: { 'w:val': s.a['w:default'] ?? '0' } })) out.defaultId = id;
  }
  /** @param {string} id @param {number} depth @returns {any} */
  const get = (id, depth = 0) => {
    if (out.has(id)) return out.get(id);
    const s = raw.get(id);
    if (!s || depth > 20) return undefined;
    const base = s.a && kid(s, 'w:basedOn') ? get(kid(s, 'w:basedOn')?.a['w:val'] ?? '', depth + 1) : undefined;
    const name = String(kid(s, 'w:name')?.a['w:val'] ?? '').toLowerCase();
    const ppr = kid(s, 'w:pPr'), rpr = kid(s, 'w:rPr');
    /** @type {any} */ const st = { ...(base ?? {}) };
    delete st.kind;
    let m;
    if ((m = /^heading\s*(\d)$/.exec(name) ?? /^标题\s*(\d)$/.exec(name))) st.kind = 'h' + Math.min(3, Number(m[1]));
    else if (name === 'title' || name === '标题') st.kind = 'h1';
    else if (name === 'subtitle' || name === '副标题') st.kind = 'h2';
    else if (/quote|引用/.test(name)) st.kind = 'quote';
    else if (/code|preformatted|源代码|代码/.test(name)) st.kind = 'code';
    else if (name === 'caption' || name === '题注') st.kind = 'caption';
    else if (base?.kind && !/^h\d$/.test(base.kind)) st.kind = base.kind;
    const ol = kid(ppr, 'w:outlineLvl')?.a['w:val'];
    if (ol != null) st.outline = ol;
    const np = kid(ppr, 'w:numPr');
    if (np) { st.numId = kid(np, 'w:numId')?.a['w:val']; st.ilvl = kid(np, 'w:ilvl')?.a['w:val']; }
    const jc = kid(ppr, 'w:jc')?.a['w:val'];
    if (jc) st.jc = jc;
    if (kid(rpr, 'w:b')) st.b = on(kid(rpr, 'w:b'));
    if (kid(rpr, 'w:i')) st.i = on(kid(rpr, 'w:i'));
    const font = kid(rpr, 'w:rFonts')?.a['w:ascii'];
    if (font) st.font = font;
    out.set(id, st);
    return st;
  };
  for (const id of raw.keys()) get(id);
  return out;
}

/** numbering.xml → Map<numId, 各级的 numFmt>。 @param {string} src */
function parseNumbering(src) {
  /** @type {Map<string, string[]>} */ const out = new Map();
  if (!src) return out;
  const root = xmlRoot(src);
  /** @type {Map<string, string[]>} */ const abs = new Map();
  for (const a of kids(root, 'w:abstractNum')) {
    const lv = [];
    for (const l of kids(a, 'w:lvl')) lv[Number(l.a['w:ilvl']) || 0] = kid(l, 'w:numFmt')?.a['w:val'] ?? 'decimal';
    abs.set(a.a['w:abstractNumId'], lv);
  }
  for (const n of kids(root, 'w:num')) {
    const lv = abs.get(kid(n, 'w:abstractNumId')?.a['w:val'] ?? '');
    if (lv) out.set(n.a['w:numId'], lv);
  }
  return out;
}
