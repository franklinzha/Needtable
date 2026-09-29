/**
 * 幻灯片 ⇄ PowerPoint（.pptx），零依赖。纯函数，不碰 DOM（见 scripts/office.test.mjs）。
 *
 * 坐标：画布 960×540 逻辑像素对应 16:9 的 12192000×6858000 EMU，1 px = 12700 EMU = 1 磅，
 *       所以文字的 size（px）直接就是 PowerPoint 里的字号（磅）。
 * 导出：背景色、文本框（行内格式、对齐、底色、链接）、形状（对应到 PowerPoint 的预设形状）、线条、
 *       图片（按“完整显示”算好位置）、嵌入内容（区域 / 透视表 → PowerPoint 表格，图表 → 图片）、备注。
 *       主题字体写进 PowerPoint 主题，打开后换字体也方便。
 * 导入：按 sldIdLst 的顺序读每一页；占位符的位置、字号、颜色顺着版式 → 母版 → 主题继承；
 *       组合会拆开；不是 16:9 的按比例缩放后居中；表格变成文本框；图表、SmartArt、动画不导入。
 *       图片先放进 media，元素里写 img: '@键'，由调用方上传后换成附件编号。
 */

import { zipStore, unzip } from './zip.js';
import { esc, xmlRoot, kids, kid, kidPath, all, find, parseRels, relsOf, imageMime, mimeExt } from './xml.js';
import { coreXml } from './docx.js';
import { t } from '../../shared/i18n/i18n.js';
import { uid } from '../../shared/util/uid.js';

const HEAD = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';
const NS = 'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"';
const REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const CT = 'application/vnd.openxmlformats-officedocument.presentationml';
const EMU = 12700;
const W = 960, H = 540;
const LINE_SP = 115000;

/** 我们的形状 ↔ PowerPoint 预设形状 */
const PRST = {
  rect: 'rect', round: 'roundRect', ellipse: 'ellipse', triangle: 'triangle', rtriangle: 'rtTriangle', diamond: 'diamond',
  parallelogram: 'parallelogram', trapezoid: 'trapezoid', pentagon: 'pentagon', hexagon: 'hexagon', octagon: 'octagon',
  star: 'star5', star6: 'star6', heart: 'heart', 'arrow-r': 'rightArrow', 'arrow-l': 'leftArrow', 'arrow-u': 'upArrow',
  'arrow-d': 'downArrow', 'arrow-lr': 'leftRightArrow', chevron: 'chevron', pentarrow: 'homePlate', plus: 'plus',
  cross: 'mathMultiply', lightning: 'lightningBolt', callout: 'wedgeRectCallout', bubble: 'wedgeRoundRectCallout',
  donut: 'donut', frame: 'frame', wave: 'wave', flag: 'flowChartDocument',
};
/** 导入时额外认的几个近似形状 */
const FROM_PRST = {
  ...Object.fromEntries(Object.entries(PRST).map(([k, v]) => [v, k])),
  flowChartProcess: 'rect', snip1Rect: 'rect', round2SameRect: 'round', round1Rect: 'round', flowChartAlternateProcess: 'round',
  flowChartConnector: 'ellipse', flowChartDecision: 'diamond', flowChartTerminator: 'round', flowChartPreparation: 'hexagon',
  isoscelesTriangle: 'triangle', star4: 'star', star7: 'star6', star8: 'star6', rightArrowCallout: 'arrow-r', notchedRightArrow: 'arrow-r',
  leftArrowCallout: 'arrow-l', upArrowCallout: 'arrow-u', downArrowCallout: 'arrow-d', mathPlus: 'plus',
  wedgeEllipseCallout: 'bubble', cloudCallout: 'bubble', ribbon2: 'flag', doubleWave: 'wave', plaque: 'round',
};
const LINES = new Set(['line', 'straightConnector1', 'bentConnector2', 'bentConnector3', 'curvedConnector3']);
const FONT_FACE = {
  sans: { latin: 'Calibri', ea: '微软雅黑' },
  serif: { latin: 'Georgia', ea: '宋体' },
  kai: { latin: 'KaiTi', ea: '楷体' },
};

/** @param {number} px */
const emu = (px) => Math.round(px * EMU);
/** @param {string} c '#rrggbb' */
const srgb = (c) => `<a:srgbClr val="${c.slice(1).toUpperCase()}"/>`;
const HEX = /^#[0-9a-f]{6}$/i;

/**
 * @typedef {{ data: Uint8Array, type: string, w?: number, h?: number }} Pic
 * @typedef {{ rows?: string[][], pic?: Pic }} Snap
 * @typedef {{ images?: Map<string, Pic>, embeds?: Map<string, Snap>, title?: string, font?: string }} Assets
 */

// ── 导出 ─────────────────────────────────────────────────────────────────

/** @param {{ slides: any[] }} deck @param {Assets} [assets] @returns {Uint8Array} */
export function toPptx(deck, assets = {}) {
  const images = assets.images ?? new Map(), embeds = assets.embeds ?? new Map();
  const slides = Array.isArray(deck?.slides) && deck.slides.length ? deck.slides : [{ bg: '#ffffff', els: [] }];
  const face = /** @type {Record<string, {latin: string, ea: string}>} */ (FONT_FACE)[assets.font ?? 'sans'] ?? FONT_FACE.sans;
  /** @type {{name: string, data: Uint8Array | string}[]} */ const files = [];
  const exts = new Set();
  let mediaN = 0;
  const hasNotes = slides.some((s) => String(s.notes ?? '').trim());

  slides.forEach((s, si) => {
    const n = si + 1;
    /** @type {string[]} */ const rels = [`<Relationship Id="rId1" Type="${REL}/slideLayout" Target="../slideLayouts/slideLayout1.xml"/>`];
    let rid = 1, spId = 1;
    const rel = (/** @type {string} */ type, /** @type {string} */ target, external = false) => {
      const id = 'rId' + ++rid;
      rels.push(`<Relationship Id="${id}" Type="${REL}/${type}" Target="${esc(target)}"${external ? ' TargetMode="External"' : ''}/>`);
      return id;
    };
    const media = (/** @type {Pic} */ p) => {
      const ext = mimeExt(p.type);
      exts.add(ext);
      const name = 'image' + ++mediaN + '.' + ext;
      files.push({ name: 'ppt/media/' + name, data: p.data });
      return rel('image', '../media/' + name);
    };
    const xfrm = (/** @type {number} */ x, /** @type {number} */ y, /** @type {number} */ w, /** @type {number} */ h, attrs = '') =>
      `<a:xfrm${attrs}><a:off x="${emu(x)}" y="${emu(y)}"/><a:ext cx="${emu(Math.max(0, w))}" cy="${emu(Math.max(0, h))}"/></a:xfrm>`;
    const picXml = (/** @type {Pic} */ p, /** @type {any} */ e, /** @type {string} */ name) => {
      // 我们的图片是“完整显示”（object-fit: contain），PowerPoint 是拉伸，所以先算好居中的框
      let { x, y, w, h } = e;
      if (p.w && p.h) {
        const k = Math.min(w / p.w, h / p.h);
        const iw = p.w * k, ih = p.h * k;
        x += (w - iw) / 2; y += (h - ih) / 2; w = iw; h = ih;
      }
      const id = ++spId;
      return `<p:pic><p:nvPicPr><p:cNvPr id="${id}" name="${esc(name)} ${id}"/><p:cNvPicPr><a:picLocks noChangeAspect="1"/></p:cNvPicPr><p:nvPr/></p:nvPicPr>`
        + `<p:blipFill><a:blip r:embed="${media(p)}"/><a:stretch><a:fillRect/></a:stretch></p:blipFill>`
        + `<p:spPr>${xfrm(x, y, w, h)}<a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr></p:pic>`;
    };

    const tree = [];
    for (const e of Array.isArray(s.els) ? s.els : []) {
      if (e.t === 'text') {
        const id = ++spId;
        const fill = HEX.test(e.fill) ? `<a:solidFill>${srgb(e.fill)}</a:solidFill>` : '<a:noFill/>';
        tree.push(`<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="文本框 ${id}"/><p:cNvSpPr txBox="1"/><p:nvPr/></p:nvSpPr>`
          + `<p:spPr>${xfrm(e.x, e.y, e.w, e.h)}<a:prstGeom prst="rect"><a:avLst/></a:prstGeom>${fill}</p:spPr>`
          + `<p:txBody><a:bodyPr wrap="square" lIns="${emu(10)}" tIns="${emu(6)}" rIns="${emu(10)}" bIns="${emu(6)}" rtlCol="0" anchor="t"><a:noAutofit/></a:bodyPr><a:lstStyle/>`
          + textParas(e, (href) => rel('hyperlink', href, true)) + '</p:txBody></p:sp>');
      } else if (e.t === 'shape') {
        tree.push(shapeXml(e, ++spId, xfrm));
      } else if (e.t === 'img') {
        const p = images.get(e.img);
        if (p) tree.push(picXml(p, e, '图片'));
      } else if (e.t === 'embed') {
        const snap = embeds.get(e.id);
        if (snap?.rows?.length) tree.push(tableXml(snap.rows, e, ++spId));
        else if (snap?.pic) tree.push(picXml(snap.pic, e, e.title || '图表'));
      }
    }
    const bg = HEX.test(s.bg) ? s.bg : '#ffffff';
    files.push({ name: `ppt/slides/slide${n}.xml`, data: HEAD + `<p:sld ${NS}><p:cSld>`
      + `<p:bg><p:bgPr><a:solidFill>${srgb(bg)}</a:solidFill><a:effectLst/></p:bgPr></p:bg>`
      + `<p:spTree>${GRP}${tree.join('')}</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sld>` });
    if (String(s.notes ?? '').trim()) {
      rel('notesSlide', `../notesSlides/notesSlide${n}.xml`);
      files.push({ name: `ppt/notesSlides/notesSlide${n}.xml`, data: notesXml(String(s.notes)) });
      files.push({ name: `ppt/notesSlides/_rels/notesSlide${n}.xml.rels`, data: relsXml([
        `<Relationship Id="rId1" Type="${REL}/notesMaster" Target="../notesMasters/notesMaster1.xml"/>`,
        `<Relationship Id="rId2" Type="${REL}/slide" Target="../slides/slide${n}.xml"/>`]) });
    }
    files.push({ name: `ppt/slides/_rels/slide${n}.xml.rels`, data: relsXml(rels) });
  });

  const count = slides.length;
  const presRels = [
    `<Relationship Id="rId1" Type="${REL}/slideMaster" Target="slideMasters/slideMaster1.xml"/>`,
    `<Relationship Id="rId2" Type="${REL}/theme" Target="theme/theme1.xml"/>`,
    `<Relationship Id="rId3" Type="${REL}/presProps" Target="presProps.xml"/>`,
    `<Relationship Id="rId4" Type="${REL}/viewProps" Target="viewProps.xml"/>`,
    `<Relationship Id="rId5" Type="${REL}/tableStyles" Target="tableStyles.xml"/>`,
    ...(hasNotes ? [`<Relationship Id="rId6" Type="${REL}/notesMaster" Target="notesMasters/notesMaster1.xml"/>`] : []),
    ...slides.map((_, i) => `<Relationship Id="rIdS${i + 1}" Type="${REL}/slide" Target="slides/slide${i + 1}.xml"/>`),
  ];
  const pres = HEAD + `<p:presentation ${NS} saveSubsetFonts="1">`
    + '<p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rId1"/></p:sldMasterIdLst>'
    + (hasNotes ? '<p:notesMasterIdLst><p:notesMasterId r:id="rId6"/></p:notesMasterIdLst>' : '')
    + '<p:sldIdLst>' + slides.map((_, i) => `<p:sldId id="${256 + i}" r:id="rIdS${i + 1}"/>`).join('') + '</p:sldIdLst>'
    + `<p:sldSz cx="${emu(W)}" cy="${emu(H)}"/><p:notesSz cx="6858000" cy="9144000"/>`
    + '<p:defaultTextStyle>' + [1, 2, 3].map((l) => `<a:lvl${l}pPr marL="${(l - 1) * 457200}" algn="l" defTabSz="914400" eaLnBrk="1" latinLnBrk="0" hangingPunct="1">`
      + '<a:defRPr sz="1800" kern="1200"><a:solidFill><a:schemeClr val="tx1"/></a:solidFill><a:latin typeface="+mn-lt"/><a:ea typeface="+mn-ea"/><a:cs typeface="+mn-cs"/></a:defRPr>'
      + `</a:lvl${l}pPr>`).join('') + '</p:defaultTextStyle>'
    + '</p:presentation>';

  const types = HEAD + '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
    + '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
    + '<Default Extension="xml" ContentType="application/xml"/>'
    + [...exts].map((e) => `<Default Extension="${e}" ContentType="image/${e}"/>`).join('')
    + `<Override PartName="/ppt/presentation.xml" ContentType="${CT}.presentation.main+xml"/>`
    + `<Override PartName="/ppt/slideMasters/slideMaster1.xml" ContentType="${CT}.slideMaster+xml"/>`
    + `<Override PartName="/ppt/slideLayouts/slideLayout1.xml" ContentType="${CT}.slideLayout+xml"/>`
    + '<Override PartName="/ppt/theme/theme1.xml" ContentType="application/vnd.openxmlformats-officedocument.theme+xml"/>'
    + `<Override PartName="/ppt/presProps.xml" ContentType="${CT}.presProps+xml"/>`
    + `<Override PartName="/ppt/viewProps.xml" ContentType="${CT}.viewProps+xml"/>`
    + `<Override PartName="/ppt/tableStyles.xml" ContentType="${CT}.tableStyles+xml"/>`
    + '<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>'
    + slides.map((_, i) => `<Override PartName="/ppt/slides/slide${i + 1}.xml" ContentType="${CT}.slide+xml"/>`).join('')
    + (hasNotes ? `<Override PartName="/ppt/notesMasters/notesMaster1.xml" ContentType="${CT}.notesMaster+xml"/>`
      + '<Override PartName="/ppt/theme/theme2.xml" ContentType="application/vnd.openxmlformats-officedocument.theme+xml"/>'
      + slides.map((s, i) => (String(s.notes ?? '').trim() ? `<Override PartName="/ppt/notesSlides/notesSlide${i + 1}.xml" ContentType="${CT}.notesSlide+xml"/>` : '')).join('') : '')
    + '</Types>';

  return zipStore([
    { name: '[Content_Types].xml', data: types },
    { name: '_rels/.rels', data: relsXml([
      `<Relationship Id="rId1" Type="${REL}/officeDocument" Target="ppt/presentation.xml"/>`,
      '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>']) },
    { name: 'docProps/core.xml', data: coreXml(assets.title) },
    { name: 'ppt/presentation.xml', data: pres },
    { name: 'ppt/_rels/presentation.xml.rels', data: relsXml(presRels) },
    { name: 'ppt/presProps.xml', data: HEAD + `<p:presentationPr ${NS}/>` },
    { name: 'ppt/viewProps.xml', data: HEAD + `<p:viewPr ${NS}><p:normalViewPr><p:restoredLeft sz="15620"/><p:restoredTop sz="94660"/></p:normalViewPr><p:gridSpacing cx="76200" cy="76200"/></p:viewPr>` },
    { name: 'ppt/tableStyles.xml', data: HEAD + '<a:tblStyleLst xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" def="{5C22544A-7EE6-4342-B048-85BDC9FD1C3A}"/>' },
    { name: 'ppt/theme/theme1.xml', data: themeXml(face) },
    { name: 'ppt/slideMasters/slideMaster1.xml', data: MASTER },
    { name: 'ppt/slideMasters/_rels/slideMaster1.xml.rels', data: relsXml([
      `<Relationship Id="rId1" Type="${REL}/slideLayout" Target="../slideLayouts/slideLayout1.xml"/>`,
      `<Relationship Id="rId2" Type="${REL}/theme" Target="../theme/theme1.xml"/>`]) },
    { name: 'ppt/slideLayouts/slideLayout1.xml', data: LAYOUT },
    { name: 'ppt/slideLayouts/_rels/slideLayout1.xml.rels', data: relsXml([`<Relationship Id="rId1" Type="${REL}/slideMaster" Target="../slideMasters/slideMaster1.xml"/>`]) },
    ...(hasNotes ? [
      { name: 'ppt/theme/theme2.xml', data: themeXml(face) },
      { name: 'ppt/notesMasters/notesMaster1.xml', data: NOTES_MASTER },
      { name: 'ppt/notesMasters/_rels/notesMaster1.xml.rels', data: relsXml([`<Relationship Id="rId1" Type="${REL}/theme" Target="../theme/theme2.xml"/>`]) },
    ] : []),
    ...files,
  ]);
}

/** @param {string[]} rels */
const relsXml = (rels) => HEAD + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' + rels.join('') + '</Relationships>';

const GRP = '<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>';

/**
 * 文本框的 runs → 一串 <a:p>：按 \n 分段，每段里的行内格式照搬；元素级的加粗 / 斜体 / 下划线当默认值。
 * @param {any} e @param {(href: string) => string} link
 */
function textParas(e, link) {
  const size = Math.max(8, Math.min(200, Number(e.size) || 22));
  const color = HEX.test(e.color) ? e.color : '#1f2328';
  const algn = e.align === 'center' ? ' algn="ctr"' : e.align === 'right' ? ' algn="r"' : '';
  /** @type {[string, any][][]} */ const paras = [[]];
  for (const r of Array.isArray(e.runs) ? e.runs : []) {
    String(r[0] ?? '').split('\n').forEach((seg, i) => {
      if (i) paras.push([]);
      if (seg) paras[paras.length - 1].push([seg, r[1] ?? {}]);
    });
  }
  const endRpr = `<a:endParaRPr lang="zh-CN" sz="${size * 100}" dirty="0"/>`;
  return paras.map((runs) => `<a:p><a:pPr${algn}><a:lnSpc><a:spcPct val="${LINE_SP}"/></a:lnSpc></a:pPr>`
    + runs.map(([t, m]) => {
      const attrs = [`lang="zh-CN"`, `sz="${size * 100}"`];
      if (m.b ?? e.b) attrs.push('b="1"');
      if (m.i ?? e.i) attrs.push('i="1"');
      if (m.u ?? e.u) attrs.push('u="sng"');
      if (m.s) attrs.push('strike="sngStrike"');
      let kids = `<a:solidFill>${srgb(HEX.test(m.c) ? m.c : m.a ? '#0563c1' : color)}</a:solidFill>`;
      if (HEX.test(m.bg)) kids += `<a:highlight>${srgb(m.bg)}</a:highlight>`;
      if (m.k) kids += '<a:latin typeface="Consolas"/><a:cs typeface="Consolas"/>';
      if (m.a) kids += `<a:hlinkClick r:id="${link(m.a)}"/>`;
      return `<a:r><a:rPr ${attrs.join(' ')} dirty="0">${kids}</a:rPr><a:t>${esc(t)}</a:t></a:r>`;
    }).join('') + endRpr + '</a:p>').join('');
}

/**
 * @param {any} e @param {number} id
 * @param {(x: number, y: number, w: number, h: number, attrs?: string) => string} xfrm
 */
function shapeXml(e, id, xfrm) {
  const line = e.shape === 'line' || e.shape === 'diag';
  const fill = e.fill === 'none' ? 'none' : HEX.test(e.fill) ? e.fill : '#a5d8ff';
  const sw = Math.max(0, Math.min(20, Math.round(Number(e.sw ?? (line ? 3 : 0)) || 0)));
  const stroke = HEX.test(e.stroke) ? e.stroke : line && fill !== 'none' ? fill : '#1f2328';
  const ln = sw ? `<a:ln w="${sw * EMU}"><a:solidFill>${srgb(stroke)}</a:solidFill></a:ln>` : '<a:ln><a:noFill/></a:ln>';
  if (line) {
    // 直线从左中到右中；斜线从左下到右上（翻转的斜线从左上到右下）
    const box = e.shape === 'line' ? xfrm(e.x, e.y + e.h / 2, e.w, 0) : xfrm(e.x, e.y, e.w, e.h, e.flip ? '' : ' flipV="1"');
    return `<p:cxnSp><p:nvCxnSpPr><p:cNvPr id="${id}" name="直线 ${id}"/><p:cNvCxnSpPr/><p:nvPr/></p:nvCxnSpPr>`
      + `<p:spPr>${box}<a:prstGeom prst="line"><a:avLst/></a:prstGeom>${sw ? ln : `<a:ln w="${EMU}"><a:solidFill>${srgb(stroke)}</a:solidFill></a:ln>`}</p:spPr></p:cxnSp>`;
  }
  const prst = /** @type {Record<string, string>} */ (PRST)[e.shape] ?? 'rect';
  const av = e.shape === 'round' ? '<a:gd name="adj" fmla="val 12000"/>' : '';
  return `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="形状 ${id}"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr>`
    + `<p:spPr>${xfrm(e.x, e.y, e.w, e.h, e.flip ? ' flipH="1"' : '')}<a:prstGeom prst="${prst}"><a:avLst>${av}</a:avLst></a:prstGeom>`
    + (fill === 'none' ? '<a:noFill/>' : `<a:solidFill>${srgb(fill)}</a:solidFill>`) + ln + '</p:spPr>'
    + '<p:txBody><a:bodyPr rtlCol="0" anchor="ctr"/><a:lstStyle/><a:p><a:endParaRPr lang="zh-CN"/></a:p></p:txBody></p:sp>';
}

/** 快照的行列 → PowerPoint 表格，行高按元素高度均分，最多 40 行。 @param {string[][]} rows @param {any} e @param {number} id */
function tableXml(rows, e, id) {
  rows = rows.slice(0, 40);
  const cols = Math.max(1, ...rows.map((r) => r.length));
  const cw = Math.floor(emu(e.w) / cols), rh = Math.floor(emu(e.h) / rows.length);
  const sz = Math.max(800, Math.min(1400, Math.round(e.h / rows.length * 0.55) * 100));
  const bd = (/** @type {string} */ side) => `<a:${side} w="6350"><a:solidFill><a:srgbClr val="BFBFBF"/></a:solidFill></a:${side}>`;
  const trs = rows.map((r, i) => `<a:tr h="${rh}">` + Array.from({ length: cols }, (_, j) =>
    `<a:tc><a:txBody><a:bodyPr/><a:lstStyle/><a:p><a:r><a:rPr lang="zh-CN" sz="${sz}"${i === 0 ? ' b="1"' : ''} dirty="0"><a:solidFill><a:srgbClr val="1F2328"/></a:solidFill></a:rPr>`
    + `<a:t>${esc(r[j] ?? '')}</a:t></a:r></a:p></a:txBody>`
    + `<a:tcPr marL="45720" marR="45720" marT="22860" marB="22860">${bd('lnL')}${bd('lnR')}${bd('lnT')}${bd('lnB')}`
    + `<a:solidFill><a:srgbClr val="${i === 0 ? 'F2F2F2' : 'FFFFFF'}"/></a:solidFill></a:tcPr></a:tc>`).join('') + '</a:tr>').join('');
  return `<p:graphicFrame><p:nvGraphicFramePr><p:cNvPr id="${id}" name="${esc(e.title || '表格')} ${id}"/><p:cNvGraphicFramePr><a:graphicFrameLocks noGrp="1"/></p:cNvGraphicFramePr><p:nvPr/></p:nvGraphicFramePr>`
    + `<p:xfrm><a:off x="${emu(e.x)}" y="${emu(e.y)}"/><a:ext cx="${cw * cols}" cy="${rh * rows.length}"/></p:xfrm>`
    + '<a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/table"><a:tbl><a:tblPr firstRow="1" bandRow="1"/>'
    + '<a:tblGrid>' + `<a:gridCol w="${cw}"/>`.repeat(cols) + `</a:tblGrid>${trs}</a:tbl></a:graphicData></a:graphic></p:graphicFrame>`;
}

/** @param {string} text */
function notesXml(text) {
  const paras = text.split('\n').map((l) => `<a:p>${l ? `<a:r><a:rPr lang="zh-CN" dirty="0"/><a:t>${esc(l)}</a:t></a:r>` : ''}<a:endParaRPr lang="zh-CN"/></a:p>`).join('');
  return HEAD + `<p:notes ${NS}><p:cSld><p:spTree>${GRP}`
    + '<p:sp><p:nvSpPr><p:cNvPr id="2" name="备注占位符 1"/><p:cNvSpPr><a:spLocks noGrp="1"/></p:cNvSpPr><p:nvPr><p:ph type="body" idx="1"/></p:nvPr></p:nvSpPr>'
    + `<p:spPr/><p:txBody><a:bodyPr/><a:lstStyle/>${paras}</p:txBody></p:sp>`
    + '</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:notes>';
}

const CLR_MAP = 'bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"';

const MASTER = HEAD + `<p:sldMaster ${NS}><p:cSld><p:bg><p:bgRef idx="1001"><a:schemeClr val="bg1"/></p:bgRef></p:bg><p:spTree>${GRP}</p:spTree></p:cSld>`
  + `<p:clrMap ${CLR_MAP}/><p:sldLayoutIdLst><p:sldLayoutId id="2147483649" r:id="rId1"/></p:sldLayoutIdLst>`
  + '<p:txStyles>'
  + '<p:titleStyle><a:lvl1pPr algn="l" rtl="0" eaLnBrk="1" latinLnBrk="0" hangingPunct="1"><a:lnSpc><a:spcPct val="90000"/></a:lnSpc><a:spcBef><a:spcPct val="0"/></a:spcBef><a:buNone/>'
  + '<a:defRPr sz="4400" kern="1200"><a:solidFill><a:schemeClr val="tx1"/></a:solidFill><a:latin typeface="+mj-lt"/><a:ea typeface="+mj-ea"/><a:cs typeface="+mj-cs"/></a:defRPr></a:lvl1pPr></p:titleStyle>'
  + '<p:bodyStyle><a:lvl1pPr marL="228600" indent="-228600" algn="l" rtl="0" eaLnBrk="1" latinLnBrk="0" hangingPunct="1"><a:lnSpc><a:spcPct val="90000"/></a:lnSpc><a:spcBef><a:spcPts val="1000"/></a:spcBef>'
  + '<a:buFont typeface="Arial"/><a:buChar char="•"/><a:defRPr sz="2800" kern="1200"><a:solidFill><a:schemeClr val="tx1"/></a:solidFill><a:latin typeface="+mn-lt"/><a:ea typeface="+mn-ea"/><a:cs typeface="+mn-cs"/></a:defRPr></a:lvl1pPr></p:bodyStyle>'
  + '<p:otherStyle><a:defPPr><a:defRPr lang="zh-CN"/></a:defPPr><a:lvl1pPr marL="0" algn="l" defTabSz="914400" rtl="0" eaLnBrk="1" latinLnBrk="0" hangingPunct="1">'
  + '<a:defRPr sz="1800" kern="1200"><a:solidFill><a:schemeClr val="tx1"/></a:solidFill><a:latin typeface="+mn-lt"/><a:ea typeface="+mn-ea"/><a:cs typeface="+mn-cs"/></a:defRPr></a:lvl1pPr></p:otherStyle>'
  + '</p:txStyles></p:sldMaster>';

const LAYOUT = HEAD + `<p:sldLayout ${NS} type="blank" preserve="1"><p:cSld name="空白"><p:spTree>${GRP}</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sldLayout>`;

const NOTES_MASTER = HEAD + `<p:notesMaster ${NS}><p:cSld><p:bg><p:bgRef idx="1001"><a:schemeClr val="bg1"/></p:bgRef></p:bg><p:spTree>${GRP}`
  + '<p:sp><p:nvSpPr><p:cNvPr id="2" name="备注占位符 1"/><p:cNvSpPr><a:spLocks noGrp="1"/></p:cNvSpPr><p:nvPr><p:ph type="body" idx="1"/></p:nvPr></p:nvSpPr>'
  + '<p:spPr><a:xfrm><a:off x="685800" y="4400550"/><a:ext cx="5486400" cy="3600450"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr>'
  + '<p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:endParaRPr lang="zh-CN"/></a:p></p:txBody></p:sp>'
  + `</p:spTree></p:cSld><p:clrMap ${CLR_MAP}/></p:notesMaster>`;

/** 最小但完整的主题（PowerPoint 要求 fmtScheme 里每个列表至少 3 项）。 @param {{latin: string, ea: string}} face */
function themeXml(face) {
  const fills = '<a:solidFill><a:schemeClr val="phClr"/></a:solidFill>'.repeat(3);
  const lines = [6350, 12700, 19050].map((w) => `<a:ln w="${w}" cap="flat" cmpd="sng" algn="ctr"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:prstDash val="solid"/><a:miter lim="800000"/></a:ln>`).join('');
  const font = (/** @type {string} */ tag) => `<a:${tag}><a:latin typeface="${esc(face.latin)}"/><a:ea typeface="${esc(face.ea)}"/><a:cs typeface=""/></a:${tag}>`;
  const clr = (/** @type {string} */ n, /** @type {string} */ v) => `<a:${n}><a:srgbClr val="${v}"/></a:${n}>`;
  return HEAD + '<a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" name="Office"><a:themeElements>'
    + '<a:clrScheme name="Office">' + clr('dk1', '000000') + clr('lt1', 'FFFFFF') + clr('dk2', '44546A') + clr('lt2', 'E7E6E6')
    + clr('accent1', '4472C4') + clr('accent2', 'ED7D31') + clr('accent3', 'A5A5A5') + clr('accent4', 'FFC000') + clr('accent5', '5B9BD5')
    + clr('accent6', '70AD47') + clr('hlink', '0563C1') + clr('folHlink', '954F72') + '</a:clrScheme>'
    + `<a:fontScheme name="Office">${font('majorFont')}${font('minorFont')}</a:fontScheme>`
    + `<a:fmtScheme name="Office"><a:fillStyleLst>${fills}</a:fillStyleLst><a:lnStyleLst>${lines}</a:lnStyleLst>`
    + '<a:effectStyleLst>' + '<a:effectStyle><a:effectLst/></a:effectStyle>'.repeat(3) + '</a:effectStyleLst>'
    + `<a:bgFillStyleLst>${fills}</a:bgFillStyleLst></a:fmtScheme>`
    + '</a:themeElements><a:objectDefaults/><a:extraClrSchemeLst/></a:theme>';
}

// ── 导入 ─────────────────────────────────────────────────────────────────

const PRESET_COLORS = { black: '000000', white: 'ffffff', red: 'ff0000', green: '008000', blue: '0000ff', yellow: 'ffff00', gray: '808080', grey: '808080', orange: 'ffa500' };

/** @param {string} hex @returns {[number, number, number]} */
const rgbOf = (hex) => [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16));
/** @param {number[]} c */
const hexOf = (c) => '#' + c.map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join('');

/** 亮度调整（lumMod / lumOff）在 HSL 空间里做。 @param {number[]} rgb @param {number} mod @param {number} off */
function lum(rgb, mod, off) {
  const [r, g, b] = rgb.map((v) => v / 255);
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
  let hh = 0, s = 0, l = (mx + mn) / 2;
  if (mx !== mn) {
    const d = mx - mn;
    s = l > 0.5 ? d / (2 - mx - mn) : d / (mx + mn);
    hh = mx === r ? (g - b) / d + (g < b ? 6 : 0) : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
    hh /= 6;
  }
  l = Math.max(0, Math.min(1, l * mod + off));
  if (!s) return [l * 255, l * 255, l * 255];
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s, p = 2 * l - q;
  const f = (/** @type {number} */ t) => {
    t = (t + 1) % 1;
    return 255 * (t < 1 / 6 ? p + (q - p) * 6 * t : t < 1 / 2 ? q : t < 2 / 3 ? p + (q - p) * (2 / 3 - t) * 6 : p);
  };
  return [f(hh + 1 / 3), f(hh), f(hh - 1 / 3)];
}

/**
 * @typedef {{ theme: Map<string, string>, clrMap: Record<string, string> }} ColorCtx
 * 颜色节点（srgbClr / schemeClr / …）所在的父节点 → '#rrggbb'；拿不到返回 undefined。
 * @param {any} parent @param {ColorCtx} ctx
 */
function colorIn(parent, ctx) {
  const c = parent?.k.find((/** @type {any} */ x) => /^a:(srgbClr|schemeClr|sysClr|prstClr|scrgbClr)$/.test(x.n));
  if (!c) return undefined;
  let hex;
  if (c.n === 'a:srgbClr') hex = c.a.val;
  else if (c.n === 'a:sysClr') hex = c.a.lastClr ?? (c.a.val === 'window' ? 'ffffff' : '000000');
  else if (c.n === 'a:prstClr') hex = /** @type {Record<string, string>} */ (PRESET_COLORS)[c.a.val];
  else if (c.n === 'a:scrgbClr') hex = hexOf(['r', 'g', 'b'].map((k) => (Number(c.a[k]) || 0) / 100000 * 255)).slice(1);
  else {
    const v = c.a.val;
    if (v === 'phClr') return undefined;
    hex = ctx.theme.get(ctx.clrMap[v] ?? v);
  }
  if (!hex || !/^[0-9a-f]{6}$/i.test(hex)) return undefined;
  let rgb = rgbOf(hex.toLowerCase());
  const mod = Number(kid(c, 'a:lumMod')?.a.val ?? 100000) / 100000, off = Number(kid(c, 'a:lumOff')?.a.val ?? 0) / 100000;
  if (mod !== 1 || off) rgb = lum(rgb, mod, off);
  const tint = kid(c, 'a:tint')?.a.val, shade = kid(c, 'a:shade')?.a.val;
  if (tint) { const t = Number(tint) / 100000; rgb = rgb.map((v) => v * t + 255 * (1 - t)); }
  if (shade) { const t = Number(shade) / 100000; rgb = rgb.map((v) => v * t); }
  return hexOf(rgb);
}

/**
 * 填充：'none' / '#hex' / undefined（没写）。渐变取第一个色标，图片填充返回 { blip }。
 * @param {any} spPr @param {ColorCtx} ctx @returns {string | { blip: string } | undefined}
 */
function fillOf(spPr, ctx) {
  for (const c of spPr?.k ?? []) {
    if (c.n === 'a:noFill') return 'none';
    if (c.n === 'a:solidFill') return colorIn(c, ctx) ?? 'none';
    if (c.n === 'a:gradFill') return colorIn(find(c, 'a:gs'), ctx) ?? 'none';
    if (c.n === 'a:pattFill') return colorIn(kid(c, 'a:fgClr'), ctx) ?? 'none';
    if (c.n === 'a:blipFill') { const id = kid(c, 'a:blip')?.a['r:embed']; return id ? { blip: id } : undefined; }
    if (c.n === 'a:grpFill') return undefined;
  }
  return undefined;
}

/**
 * @typedef {{ data: Uint8Array, type: string, name: string }} Media
 * @param {ArrayBuffer | Uint8Array} buf
 * @returns {Promise<{ slides: any[], media: Map<string, Media>, notes: string[], ratio: number }>}
 */
export async function fromPptx(buf) {
  const zip = unzip(buf);
  const read = async (/** @type {string} */ n) => (n && zip.has(n) ? zip.get(n)?.text() ?? '' : '');
  const main = [...parseRels(await read('_rels/.rels'), '').values()].find((r) => r.type.endsWith('/officeDocument'))?.target ?? 'ppt/presentation.xml';
  if (!zip.has(main)) throw new Error(t('不是有效的 PowerPoint 文件（.pptx）'));
  const pdir = main.slice(0, main.lastIndexOf('/') + 1);
  const pres = xmlRoot(await read(main));
  const presRels = parseRels(await read(relsOf(main)), pdir);
  const sz = kid(pres, 'p:sldSz');
  const cx = Number(sz?.a.cx) || 12192000, cy = Number(sz?.a.cy) || 6858000;
  // 等比缩放到 960×540 里，居中
  const k = Math.min(W / cx, H / cy);
  const ox = (W - cx * k) / 2, oy = (H - cy * k) / 2;
  const defaultText = kid(pres, 'p:defaultTextStyle');

  /** @type {Map<string, Media>} */ const media = new Map();
  /** @type {string[]} */ const notes = [];
  let skippedPics = 0, charts = 0;
  /** @type {Map<string, any>} */ const parts = new Map();
  /** 读一个 XML 部件和它的 rels（有缓存，版式和母版会被很多页共用）。 @param {string} path */
  const part = async (path) => {
    if (parts.has(path)) return parts.get(path);
    const dir = path.slice(0, path.lastIndexOf('/') + 1);
    const p = { path, root: xmlRoot(await read(path)), rels: parseRels(await read(relsOf(path)), dir) };
    parts.set(path, p);
    return p;
  };
  const relTarget = (/** @type {any} */ p, /** @type {string} */ type) => [...p.rels.values()].find((r) => r.type.endsWith('/' + type))?.target;

  /** 图片 → media 的键。 @param {any} p 所在部件 @param {string} rId */
  const pic = async (p, rId) => {
    const r = p.rels.get(rId);
    const type = r && !r.external ? imageMime(r.target) : null;
    const entry = r && zip.get(r.target);
    if (!type || !entry) { skippedPics++; return null; }
    for (const [key, m] of media) if (m.name === r.target) return key;
    const key = '@' + (media.size + 1);
    media.set(key, { data: await entry.bytes(), type, name: r.target });
    return key;
  };

  /** @type {any[]} */ const slides = [];
  const ids = kids(kid(pres, 'p:sldIdLst'), 'p:sldId').map((s) => presRels.get(s.a['r:id'])?.target).filter(Boolean);
  for (const path of /** @type {string[]} */ (ids)) {
    if (!zip.has(path)) continue;
    const slide = await part(path);
    if (slide.root.a.show === '0') continue;
    const layout = await part(relTarget(slide, 'slideLayout') ?? '');
    const master = await part(relTarget(layout, 'slideMaster') ?? '');
    const themeRoot = xmlRoot(await read(relTarget(master, 'theme') ?? ''));
    /** @type {Map<string, string>} */ const theme = new Map();
    for (const c of find(themeRoot, 'a:clrScheme')?.k ?? []) {
      const v = kid(c, 'a:srgbClr')?.a.val ?? kid(c, 'a:sysClr')?.a.lastClr;
      if (v) theme.set(c.n.slice(2), v.toLowerCase());
    }
    const clrMap = { ...(kid(master.root, 'p:clrMap')?.a ?? {}) };
    for (const p of [layout, slide]) Object.assign(clrMap, kidPath(p.root, 'p:clrMapOvr', 'a:overrideClrMapping')?.a ?? {});
    /** @type {ColorCtx} */ const ctx = { theme, clrMap };
    const titleStyle = kidPath(master.root, 'p:txStyles', 'p:titleStyle');
    const bodyStyle = kidPath(master.root, 'p:txStyles', 'p:bodyStyle');
    const otherStyle = kidPath(master.root, 'p:txStyles', 'p:otherStyle');

    /** @type {any[]} */ const els = [];
    let bg = '#ffffff';
    for (const p of [slide, layout, master]) {
      const b = kidPath(p.root, 'p:cSld', 'p:bg');
      if (!b) continue;
      const bgPr = kid(b, 'p:bgPr'), ref = kid(b, 'p:bgRef');
      const f = bgPr ? fillOf(bgPr, ctx) : colorIn(ref, ctx);
      if (typeof f === 'string' && f !== 'none') bg = f;
      else if (f && typeof f === 'object') {
        const key = await pic(p, f.blip);
        if (key) els.push({ id: uid('e'), t: 'img', img: key, x: 0, y: 0, w: W, h: H });
      }
      break;
    }

    // 占位符：按 idx，再按类型，在版式和母版里找对应的那个（继承位置和文字样式）
    const phNorm = (/** @type {string | undefined} */ t) => (t === 'ctrTitle' ? 'title' : !t || ['subTitle', 'obj'].includes(t) ? 'body' : t);
    /** @param {any} p @param {any} ph */
    const phIn = (p, ph) => {
      const cands = all(kidPath(p.root, 'p:cSld', 'p:spTree'), 'p:sp').filter((s) => kidPath(s, 'p:nvSpPr', 'p:nvPr', 'p:ph'));
      const phOf = (/** @type {any} */ s) => kidPath(s, 'p:nvSpPr', 'p:nvPr', 'p:ph');
      if (ph.a.idx != null) { const m = cands.find((s) => phOf(s).a.idx === ph.a.idx && p !== master); if (m) return m; }
      return cands.find((s) => phNorm(phOf(s).a.type) === phNorm(ph.a.type));
    };

    /**
     * 形状树 → 元素。 @param {any} tree @param {(x: number, y: number) => [number, number]} map 组合里的坐标换算
     * @param {number} sx @param {number} sy 组合的缩放
     */
    const walk = async (tree, map, sx, sy) => {
      for (let node of tree?.k ?? []) {
        if (node.n === 'mc:AlternateContent') node = kid(node, 'mc:Fallback') ?? kid(node, 'mc:Choice') ?? node;
        const inner = node.n === 'mc:Fallback' || node.n === 'mc:Choice' ? node.k : [node];
        for (const x of inner) await shape(x, map, sx, sy);
      }
    };

    /** @param {any} x @param {(x: number, y: number) => [number, number]} map @param {number} sx @param {number} sy */
    const shape = async (x, map, sx, sy) => {
      const nv = x.k.find((/** @type {any} */ c) => /^p:nv/.test(c.n));
      if (kid(nv, 'p:cNvPr')?.a.hidden === '1' || kid(nv, 'p:cNvPr')?.a.hidden === 'true') return;
      const ph = kidPath(nv, 'p:nvPr', 'p:ph');
      const lph = ph ? phIn(layout, ph) : undefined, mph = ph ? phIn(master, ph) : undefined;
      const spPr = kid(x, 'p:spPr') ?? kid(x, 'p:grpSpPr');
      const xf = kid(spPr, 'a:xfrm') ?? kid(x, 'p:xfrm')
        ?? kidPath(lph, 'p:spPr', 'a:xfrm') ?? kidPath(mph, 'p:spPr', 'a:xfrm');
      const box = () => {
        const off = kid(xf, 'a:off'), ext = kid(xf, 'a:ext');
        const [x0, y0] = map(Number(off?.a.x) || 0, Number(off?.a.y) || 0);
        return { x: x0 * k + ox, y: y0 * k + oy, w: (Number(ext?.a.cx) || 0) * sx * k, h: (Number(ext?.a.cy) || 0) * sy * k };
      };

      if (x.n === 'p:grpSp') {
        const off = kid(xf, 'a:off'), ext = kid(xf, 'a:ext'), cho = kid(xf, 'a:chOff'), che = kid(xf, 'a:chExt');
        const gsx = Number(che?.a.cx) ? Number(ext?.a.cx) / Number(che?.a.cx) : 1;
        const gsy = Number(che?.a.cy) ? Number(ext?.a.cy) / Number(che?.a.cy) : 1;
        const [gx, gy] = map(Number(off?.a.x) || 0, Number(off?.a.y) || 0);
        const cx0 = Number(cho?.a.x) || 0, cy0 = Number(cho?.a.y) || 0;
        await walk(x, (a, b) => [gx + (a - cx0) * gsx * sx, gy + (b - cy0) * gsy * sy], sx * gsx, sy * gsy);
        return;
      }
      if (!xf) return;
      const b = box();
      if (b.w < 1 && b.h < 1) return;

      if (x.n === 'p:pic') {
        const id = find(kid(x, 'p:blipFill'), 'a:blip')?.a['r:embed'];
        const key = id ? await pic(slide, id) : null;
        if (key) els.push({ id: uid('e'), t: 'img', img: key, ...b });
        return;
      }
      if (x.n === 'p:graphicFrame') {
        const tbl = find(x, 'a:tbl');
        if (tbl) {
          const lines = kids(tbl, 'a:tr').map((tr) => kids(tr, 'a:tc').filter((tc) => !tc.a.hMerge && !tc.a.vMerge)
            .map((tc) => kids(kid(tc, 'a:txBody'), 'a:p').map(plain).join(' ')).join(' │ '));
          const size = Math.max(8, Math.min(40, Math.round((Number(find(tbl, 'a:rPr')?.a.sz) || 1400) / 100 * k * 12700)));
          els.push({ id: uid('e'), t: 'text', ...b, runs: [[lines.join('\n')]], size, color: '#1f2328', align: 'left' });
        } else charts++;
        return;
      }
      if (x.n !== 'p:sp' && x.n !== 'p:cxnSp') return;

      const geom = kid(spPr, 'a:prstGeom')?.a.prst ?? (kid(spPr, 'a:custGeom') ? 'custom' : 'rect');
      const style = kid(x, 'p:style');
      let fill = fillOf(spPr, ctx);
      if (fill === undefined && ph) fill = fillOf(kid(lph, 'p:spPr'), ctx) ?? fillOf(kid(mph, 'p:spPr'), ctx);
      if (fill === undefined && style && Number(kid(style, 'a:fillRef')?.a.idx) > 0) fill = colorIn(kid(style, 'a:fillRef'), ctx);
      const lnNode = kid(spPr, 'a:ln');
      let stroke, sw = 0;
      if (lnNode && !kid(lnNode, 'a:noFill')) {
        stroke = colorIn(kid(lnNode, 'a:solidFill'), ctx);
        if (!stroke && style && Number(kid(style, 'a:lnRef')?.a.idx) > 0) stroke = colorIn(kid(style, 'a:lnRef'), ctx);
        sw = stroke ? Math.max(1, Math.round((Number(lnNode.a.w) || 12700) * k)) : 0;
      } else if (!lnNode && style && Number(kid(style, 'a:lnRef')?.a.idx) > 0) {
        stroke = colorIn(kid(style, 'a:lnRef'), ctx);
        sw = stroke ? 1 : 0;
      }

      if (x.n === 'p:cxnSp' || LINES.has(geom)) {
        const flipV = xf.a.flipV === '1' || xf.a.flipV === 'true', flipH = xf.a.flipH === '1' || xf.a.flipH === 'true';
        const color = stroke ?? '#1f2328';
        if (b.h < 4) els.push({ id: uid('e'), t: 'shape', shape: 'line', x: b.x, y: b.y + b.h / 2 - 10, w: Math.max(10, b.w), h: 20, stroke: color, sw: Math.max(1, sw) });
        // 竖线没有对应的形状：用最窄的斜线近似
        else if (b.w < 4) els.push({ id: uid('e'), t: 'shape', shape: 'diag', x: b.x - 5, y: b.y, w: 10, h: b.h, stroke: color, sw: Math.max(1, sw) });
        else els.push({ id: uid('e'), t: 'shape', shape: 'diag', ...b, stroke: color, sw: Math.max(1, sw), ...(flipV === flipH ? { flip: true } : {}) });
        return;
      }

      // 文字：顺着 shape → 版式占位符 → 母版占位符 → 母版文字样式 → 默认样式 找
      const tx = kid(x, 'p:txBody');
      const phType = ph ? phNorm(ph.a.type) : null;
      const chain = [kid(tx, 'a:lstStyle'), kidPath(lph, 'p:txBody', 'a:lstStyle'), kidPath(mph, 'p:txBody', 'a:lstStyle'),
        phType === 'title' ? titleStyle : phType === 'body' ? bodyStyle : ph ? otherStyle : null, defaultText].filter(Boolean);
      const scale = Number(find(kid(tx, 'a:bodyPr'), 'a:normAutofit')?.a.fontScale ?? 100000) / 100000;
      const link = (/** @type {string} */ rId) => { const r = slide.rels.get(rId); return r?.external ? r.target : undefined; };
      const text = tx ? textOf(tx, chain, ctx, scale * 12700 * k, link) : null;

      const shapeId = geom === 'custom' ? 'rect' : /** @type {Record<string, string>} */ (FROM_PRST)[geom] ?? 'rect';
      const hasText = !!text && text.runs.some((r) => String(r[0]).trim());
      const flipH = xf.a.flipH === '1' || xf.a.flipH === 'true';
      const solid = typeof fill === 'string' && fill !== 'none' ? fill : undefined;
      if (fill && typeof fill === 'object') {
        const key = await pic(slide, fill.blip);
        if (key) els.push({ id: uid('e'), t: 'img', img: key, ...b });
      }
      const boxy = shapeId === 'rect' && !sw;
      if (!hasText || !boxy) {
        if (solid || (stroke && sw)) {
          els.push({ id: uid('e'), t: 'shape', shape: shapeId, ...b, fill: solid ?? 'none',
            ...(stroke && sw ? { stroke, sw: Math.min(20, sw) } : {}), ...(flipH ? { flip: true } : {}) });
        }
      }
      if (hasText && text) {
        /** @type {any} */ const el = { id: uid('e'), t: 'text', ...b, runs: text.runs, size: text.size, color: text.color, align: text.align };
        if (boxy && solid) el.fill = solid;
        if (phType === 'title') el.role = 'title';
        else if (ph && (ph.a.type === 'subTitle')) el.role = 'sub';
        else if (phType === 'body') el.role = 'body';
        els.push(el);
      }
    };

    // 母版和版式上“非占位符”的东西（标志、装饰条）也是页面的一部分，除非这一页或版式说不显示
    const showMaster = slide.root.a.showMasterSp !== '0' && layout.root.a.showMasterSp !== '0';
    const staticOf = (/** @type {any} */ p) => ({ ...kidPath(p.root, 'p:cSld', 'p:spTree'), k: (kidPath(p.root, 'p:cSld', 'p:spTree')?.k ?? [])
      .filter((/** @type {any} */ s) => !kidPath(s.k.find((/** @type {any} */ c) => /^p:nv/.test(c.n)), 'p:nvPr', 'p:ph')) });
    const ident = (/** @type {number} */ a, /** @type {number} */ b) => /** @type {[number, number]} */ ([a, b]);
    if (showMaster) {
      await walkIn(master, staticOf(master));
      await walkIn(layout, staticOf(layout));
    }
    /** @param {any} p @param {any} tree */
    async function walkIn(p, tree) {
      // 母版 / 版式里的图片关系在它们自己的 rels 里：临时把 slide 换掉
      const saved = slide.rels;
      slide.rels = p.rels;
      try { await walk(tree, ident, 1, 1); } finally { slide.rels = saved; }
    }
    await walk(kidPath(slide.root, 'p:cSld', 'p:spTree'), ident, 1, 1);

    /** @type {any} */ const out = { id: uid('s'), bg, els: els.map(roundEl) };
    const np = relTarget(slide, 'notesSlide');
    if (np && zip.has(np)) {
      const n = await part(np);
      const body = all(kidPath(n.root, 'p:cSld', 'p:spTree'), 'p:sp').find((s) => kidPath(s, 'p:nvSpPr', 'p:nvPr', 'p:ph')?.a.type === 'body');
      const t = kids(kid(body, 'p:txBody'), 'a:p').map(plain).join('\n').trim();
      if (t) out.notes = t.slice(0, 5000);
    }
    slides.push(out);
  }
  if (skippedPics) notes.push(t('{n} 张图片的格式浏览器显示不了（如 EMF / WMF），已跳过', { n: skippedPics }));
  if (charts) notes.push(t('{n} 个图表 / SmartArt 没有导入', { n: charts }));
  return { slides, media, notes, ratio: cx / cy };
}

/** @param {any} e */
function roundEl(e) {
  for (const key of ['x', 'y', 'w', 'h']) e[key] = Math.round(e[key]);
  e.w = Math.max(10, e.w); e.h = Math.max(10, e.h);
  return e;
}

/** 段落纯文本。 @param {any} p */
function plain(p) {
  return p.k.map((/** @type {any} */ r) => (r.n === 'a:br' ? '\n' : r.n === 'a:r' || r.n === 'a:fld' ? kid(r, 'a:t')?.k.map((/** @type {any} */ t) => t.t ?? '').join('') ?? '' : '')).join('');
}

/**
 * 文字框 → runs + 元素级的字号、颜色、对齐（取第一段有字的）。
 * @param {any} tx @param {any[]} chain lstStyle 链 @param {ColorCtx} ctx
 * @param {number} scale 磅 → 逻辑像素（含自动缩小字号） @param {(rId: string) => string | undefined} linkOf
 */
function textOf(tx, chain, ctx, scale, linkOf) {
  /** @param {number} lvl @param {(p: any) => any} fn */
  const look = (lvl, fn) => {
    for (const lst of chain) {
      const v = fn(kid(lst, `a:lvl${lvl}pPr`));
      if (v !== undefined) return v;
    }
    return undefined;
  };
  /** @type {any[]} */ const runs = [];
  /** @type {number | undefined} */ let size;
  /** @type {string | undefined} */ let color, align;
  let num = 0, prevLvl = -1;
  kids(tx, 'a:p').forEach((p, pi) => {
    const ppr = kid(p, 'a:pPr');
    const lvl = (Number(ppr?.a.lvl) || 0) + 1;
    const algn = ppr?.a.algn ?? look(lvl, (x) => x?.a.algn);
    const bu = ['a:buNone', 'a:buChar', 'a:buAutoNum', 'a:buBlip'].map((n) => kid(ppr, n)).find(Boolean)
      ?? look(lvl, (x) => ['a:buNone', 'a:buChar', 'a:buAutoNum', 'a:buBlip'].map((n) => kid(x, n)).find(Boolean));
    const textRuns = p.k.filter((/** @type {any} */ r) => r.n === 'a:r' || r.n === 'a:br' || r.n === 'a:fld');
    const hasText = textRuns.some((/** @type {any} */ r) => r.n !== 'a:br');
    if (pi) runs.push(['\n']);
    if (hasText && bu && bu.n !== 'a:buNone') {
      if (bu.n === 'a:buAutoNum') { num = lvl === prevLvl || prevLvl < 0 ? num + 1 : 1; } else num = 0;
      const mark = bu.n === 'a:buAutoNum' ? num + (String(bu.a.type).includes('Paren') ? ') ' : '. ') : '• ';
      runs.push(['    '.repeat(lvl - 1) + mark]);
    } else if (!bu || bu.n === 'a:buNone') num = 0;
    prevLvl = lvl;
    for (const r of textRuns) {
      if (r.n === 'a:br') { runs.push(['\n']); continue; }
      const rpr = kid(r, 'a:rPr');
      const def = (/** @type {string} */ a) => rpr?.a[a] ?? look(lvl, (x) => kid(x, 'a:defRPr')?.a[a]);
      const t = kid(r, 'a:t')?.k.map((/** @type {any} */ x) => x.t ?? '').join('') ?? '';
      if (!t) continue;
      const sz = Number(def('sz')) || 1800;
      const c = colorIn(kid(rpr, 'a:solidFill'), ctx) ?? look(lvl, (x) => colorIn(kid(kid(x, 'a:defRPr'), 'a:solidFill'), ctx)) ?? '#000000';
      if (size === undefined && t.trim()) {
        size = Math.round(sz / 100 * scale);
        color = c;
        align = algn === 'ctr' ? 'center' : algn === 'r' ? 'right' : 'left';
      }
      /** @type {any} */ const m = {};
      const flag = (/** @type {string} */ a) => { const v = def(a); return v === '1' || v === 'true'; };
      if (flag('b')) m.b = 1;
      if (flag('i')) m.i = 1;
      const u = def('u');
      if (u && u !== 'none') m.u = 1;
      const st = def('strike');
      if (st && st !== 'noStrike') m.s = 1;
      if (c !== color) m.c = c;
      const hl = colorIn(kid(rpr, 'a:highlight'), ctx);
      if (hl) m.bg = hl;
      if (/consolas|courier|menlo|monaco|mono/i.test(kid(rpr, 'a:latin')?.a.typeface ?? '')) m.k = 1;
      const link = linkOf(kid(rpr, 'a:hlinkClick')?.a['r:id'] ?? '');
      if (link) { m.a = link; if (m.c === '#0563c1') delete m.c; }
      runs.push(Object.keys(m).length ? [t, m] : [t]);
    }
  });
  // 最开头的颜色被定下之前的 run 可能带着同样的颜色：统一去掉
  for (const r of runs) if (r[1]?.c === color) { delete r[1].c; if (!Object.keys(r[1]).length) r.length = 1; }
  return { runs, size: Math.max(8, Math.min(200, size ?? 18)), color: color ?? '#000000', align: align ?? 'left' };
}
