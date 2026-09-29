/**
 * 最小可用的 .xlsx 读写，零依赖。
 *
 * 写：ZIP 仅存储（见 zip.js）；Excel / WPS / Numbers 都认。
 *     数字写 <v>，文本写 inlineStr，公式写 <f> 并附上缓存值；
 *     加粗 / 斜体 / 字色 / 填充 / 对齐 / 数字格式 / 边框映射进 styles.xml。
 * 读：只取第一张表的值。
 */

import { lastRow, lastCol } from '../grid/commands.js';
import { cellRef, parseRef } from '../../shared/util/a1.js';
import { t } from '../../shared/i18n/i18n.js';

import { zipStore, unzip } from './zip.js';

// ── XML 帮手 ─────────────────────────────────────────────────────────────

/** @param {string} s */
const esc = (s) => String(s)
  .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const argb = (hex) => 'FF' + hex.slice(1).toUpperCase();
const HEAD = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';
const NS = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const RNS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const PNS = 'http://schemas.openxmlformats.org/package/2006/relationships';

// ── 写 ───────────────────────────────────────────────────────────────────

const BUILTIN_NF = { General: 0, '0': 1, '0.00': 2, '#,##0': 3, '#,##0.00': 4, '0%': 9, '0.00%': 10, '0.00E+00': 11, '@': 49 };

/** 把格式对象去重成 styles.xml 的 fonts / fills / borders / numFmts / cellXfs。 */
class StyleBook {
  constructor() {
    this.fonts = ['<font><sz val="11"/><name val="Calibri"/></font>'];
    this.fills = ['<fill><patternFill patternType="none"/></fill>', '<fill><patternFill patternType="gray125"/></fill>'];
    this.borders = ['<border><left/><right/><top/><bottom/><diagonal/></border>'];
    /** @type {string[]} */ this.numFmts = [];
    this.xfs = ['<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>'];
    /** @type {Map<string, number>} */ this.idx = new Map();
    /** @type {Map<string, number>} */ this.nfIds = new Map();
  }
  /** @param {string[]} list @param {string} xml */
  _add(list, xml) { let i = list.indexOf(xml); if (i < 0) { i = list.length; list.push(xml); } return i; }
  /** @param {any} f @returns {number} */
  xf(f) {
    if (!f) return 0;
    const key = JSON.stringify(f);
    const hit = this.idx.get(key);
    if (hit != null) return hit;
    let font = '<font>' + (f.b ? '<b/>' : '') + (f.i ? '<i/>' : '') + (f.s ? '<strike/>' : '') + (f.u ? '<u/>' : '')
      + '<sz val="' + (f.fs ?? 11) + '"/>' + (f.fc ? '<color rgb="' + argb(f.fc) + '"/>' : '')
      + '<name val="' + esc(f.ff || 'Calibri') + '"/></font>';
    const fontId = this._add(this.fonts, font);
    const fillId = f.bg ? this._add(this.fills, '<fill><patternFill patternType="solid"><fgColor rgb="' + argb(f.bg) + '"/><bgColor indexed="64"/></patternFill></fill>') : 0;
    let borderId = 0;
    if (f.bd) {
      const side = (tag, k) => f.bd[k] ? '<' + tag + ' style="thin"><color rgb="' + argb(f.bd[k]) + '"/></' + tag + '>' : '<' + tag + '/>';
      borderId = this._add(this.borders, '<border>' + side('left', 'l') + side('right', 'r') + side('top', 't') + side('bottom', 'b') + '<diagonal/></border>');
    }
    let numFmtId = 0;
    if (f.nf) {
      numFmtId = BUILTIN_NF[f.nf] ?? this.nfIds.get(f.nf) ?? -1;
      if (numFmtId < 0) {
        numFmtId = 164 + this.numFmts.length;
        this.nfIds.set(f.nf, numFmtId);
        this.numFmts.push('<numFmt numFmtId="' + numFmtId + '" formatCode="' + esc(f.nf) + '"/>');
      }
    }
    const H = { l: 'left', c: 'center', r: 'right' }, V = { t: 'top', m: 'center', b: 'bottom' };
    const align = f.ha || f.va || f.wr
      ? '<alignment' + (f.ha ? ' horizontal="' + H[f.ha] + '"' : '') + (f.va ? ' vertical="' + V[f.va] + '"' : '') + (f.wr ? ' wrapText="1"' : '') + '/>'
      : '';
    const xml = '<xf numFmtId="' + numFmtId + '" fontId="' + fontId + '" fillId="' + fillId + '" borderId="' + borderId + '" xfId="0"'
      + (numFmtId ? ' applyNumberFormat="1"' : '') + (fontId ? ' applyFont="1"' : '') + (fillId ? ' applyFill="1"' : '')
      + (borderId ? ' applyBorder="1"' : '') + (align ? ' applyAlignment="1">' + align + '</xf>' : '/>');
    const id = this._add(this.xfs, xml);
    this.idx.set(key, id);
    return id;
  }
  xml() {
    const list = (tag, a) => '<' + tag + ' count="' + a.length + '">' + a.join('') + '</' + tag + '>';
    return HEAD + '<styleSheet xmlns="' + NS + '">'
      + (this.numFmts.length ? list('numFmts', this.numFmts) : '')
      + list('fonts', this.fonts) + list('fills', this.fills) + list('borders', this.borders)
      + '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>'
      + list('cellXfs', this.xfs)
      + '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>';
  }
}

const NUM_RE = /^[+-]?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?$/i;

/** @param {any} v @returns {string} 公式缓存值的 <c> 属性 + 内容 */
function cached(v) {
  if (typeof v === 'number' && Number.isFinite(v)) return '><v>' + v + '</v>';
  if (typeof v === 'boolean') return ' t="b"><v>' + (v ? 1 : 0) + '</v>';
  if (v && typeof v === 'object' && 'err' in v) return ' t="e"><v>' + esc(v.err) + '</v>';
  return ' t="str"><v>' + esc(v ?? '') + '</v>';
}

/** 工作表名：去掉 Excel 不允许的字符，截到 31 个字，与已用的重名就加序号。 @param {string} name @param {Set<string>} used */
function sheetNameOf(name, used) {
  const base = String(name).replace(/[\\\/?*[\]:]/g, ' ').trim().slice(0, 31) || 'Sheet';
  let n = base, i = 2;
  while (used.has(n.toLowerCase())) { const tail = ' (' + i++ + ')'; n = base.slice(0, 31 - tail.length) + tail; }
  used.add(n.toLowerCase());
  return n;
}

/**
 * 透视表的工作表：值写成数字（带数字格式），表头 / 小计 / 总计加粗。
 * @param {ReturnType<typeof import('../grid/pivotcalc.js').pivotMatrix>} mat
 * @param {{dec?: number|null}} opts @param {StyleBook} book
 */
function pivotSheet(mat, opts, book) {
  const dec = opts.dec ?? null;
  const HEAD_BG = '#F7ECF4', TOTAL_BG = '#FDF4F9', LINE = '#DCC5D7';
  const bd = { b: LINE };
  /** 值字段自己的格式（f）优先，其次整表小数位 */
  const nf = (/** @type {number} */ v, /** @type {boolean} */ pct, /** @type {{fmt?: string, dec?: number|null} | undefined} */ f) => {
    const fmt = f?.fmt ?? 'auto';
    const money = fmt === 'cny' || fmt === 'usd';
    const d = f?.dec ?? dec ?? (pct || money || fmt === 'pct' ? 2 : Number.isInteger(v) ? 0 : 2);
    const frac = d > 0 ? '.' + '0'.repeat(d) : '';
    if (pct || fmt === 'pct') return '0' + frac + '%';
    if (fmt === 'plain') return '0' + frac;
    if (money) return (fmt === 'cny' ? '¥' : '$') + '#,##0' + frac;
    return '#,##0' + frac;
  };
  let width = 0;
  const rows = mat.rows.map((cells, r) => {
    width = Math.max(width, cells.length);
    const kind = mat.kinds[r];
    const bold = kind === 'head' || kind === 'total' || kind === 'sub' || kind === 'group' ? 1 : undefined;
    const bg = kind === 'head' ? HEAD_BG : kind === 'total' || kind === 'sub' ? TOTAL_BG : undefined;
    let xml = '';
    cells.forEach((cell, c) => {
      const ref = cellRef(r, c);
      if (typeof cell.v === 'number' && Number.isFinite(cell.v)) {
        const s = book.xf({ b: bold, bg, bd, nf: nf(cell.v, !!cell.pct, cell.f) });
        xml += '<c r="' + ref + '" s="' + s + '"><v>' + cell.v + '</v></c>';
      } else {
        const merged = c < mat.keyCols && (mat.merges ?? []).some((m) => m[0] === r && m[1] === c);
        const s = book.xf({ b: bold, bg, bd, ha: (kind === 'head' && c >= mat.keyCols) || merged ? 'c' : undefined, va: merged ? 'm' : undefined });
        xml += cell.v == null || cell.v === ''
          ? '<c r="' + ref + '" s="' + s + '"/>'
          : '<c r="' + ref + '" s="' + s + '" t="inlineStr"><is><t xml:space="preserve">' + esc(cell.v) + '</t></is></c>';
      }
    });
    return '<row r="' + (r + 1) + '">' + xml + '</row>';
  });
  const heads = mat.kinds.filter((k) => k === 'head').length;
  let cols = '';
  for (let c = 0; c < width; c++) {
    cols += '<col min="' + (c + 1) + '" max="' + (c + 1) + '" width="' + (c < mat.keyCols ? 18 : 14) + '" customWidth="1"/>';
  }
  const pane = '<pane xSplit="' + mat.keyCols + '" ySplit="' + heads + '" topLeftCell="' + cellRef(heads, mat.keyCols) + '" activePane="bottomRight" state="frozen"/>';
  const dim = rows.length ? 'A1:' + cellRef(rows.length - 1, Math.max(width - 1, 0)) : 'A1';
  return HEAD + '<worksheet xmlns="' + NS + '" xmlns:r="' + RNS + '"><dimension ref="' + dim + '"/>'
    + '<sheetViews><sheetView workbookViewId="0">' + pane + '</sheetView></sheetViews>'
    + '<sheetFormatPr defaultRowHeight="19.5"/>' + (cols ? '<cols>' + cols + '</cols>' : '')
    + '<sheetData>' + rows.join('') + '</sheetData>'
    + (mat.merges?.length ? '<mergeCells count="' + mat.merges.length + '">'
      + mat.merges.map((m) => '<mergeCell ref="' + cellRef(m[0], m[1]) + ':' + cellRef(m[2], m[3]) + '"/>').join('') + '</mergeCells>' : '')
    + '</worksheet>';
}

/**
 * @param {import('../grid/model.js').GridModel} model
 * @param {any} calc
 * @param {string} [name]
 * @param {{name: string, matrix: any, opts?: {dec?: number|null}}[]} [pivots] 每个透视表单独一张工作表，排在数据表后面
 * @returns {Promise<Uint8Array>}
 */
export async function toXlsx(model, calc, name = 'Sheet1', pivots = []) {
  const used = new Set();
  const sheetName = sheetNameOf(name || 'Sheet1', used);
  const book = new StyleBook();
  const R = lastRow(model), C = lastCol(model);
  const props = model.props ?? {};

  let cols = '';
  for (let c = 0; c <= Math.max(C, 0); c++) {
    const w = model.colWidth(c), hidden = props.hiddenCols?.includes?.(c);
    cols += '<col min="' + (c + 1) + '" max="' + (c + 1) + '" width="' + (w / 7).toFixed(2) + '" customWidth="1"' + (hidden ? ' hidden="1"' : '') + '/>';
  }

  const rows = [];
  for (let r = 0; r <= R; r++) {
    let cells = '';
    for (let c = 0; c <= C; c++) {
      const raw = model.getCell(r, c), f = model.getFormat(r, c);
      if (raw === '' && !f) continue;
      const ref = cellRef(r, c), s = book.xf(f);
      const sa = s ? ' s="' + s + '"' : '';
      if (raw === '') { cells += '<c r="' + ref + '"' + sa + '/>'; continue; }
      if (raw[0] === '=' && raw.length > 1) {
        cells += '<c r="' + ref + '"' + sa + cached(calc.value(r, c)).replace('>', '><f>' + esc(raw.slice(1)) + '</f>') + '</c>';
      } else if (raw[0] !== "'" && NUM_RE.test(raw.trim())) {
        cells += '<c r="' + ref + '"' + sa + '><v>' + Number(raw) + '</v></c>';
      } else if (/^(true|false)$/i.test(raw)) {
        cells += '<c r="' + ref + '"' + sa + ' t="b"><v>' + (/^t/i.test(raw) ? 1 : 0) + '</v></c>';
      } else {
        const text = raw[0] === "'" ? raw.slice(1) : raw;
        cells += '<c r="' + ref + '"' + sa + ' t="inlineStr"><is><t xml:space="preserve">' + esc(text) + '</t></is></c>';
      }
    }
    const h = model.rowHeights.get(r), hidden = props.hiddenRows?.includes?.(r);
    if (cells || h || hidden) {
      rows.push('<row r="' + (r + 1) + '"' + (h ? ' ht="' + (h * 0.75).toFixed(2) + '" customHeight="1"' : '') + (hidden ? ' hidden="1"' : '') + '>' + cells + '</row>');
    }
  }

  const fr = props.freeze?.r | 0, fc = props.freeze?.c | 0;
  const pane = fr || fc
    ? '<pane' + (fc ? ' xSplit="' + fc + '"' : '') + (fr ? ' ySplit="' + fr + '"' : '') + ' topLeftCell="' + cellRef(fr, fc) + '" activePane="' + (fr && fc ? 'bottomRight' : fr ? 'bottomLeft' : 'topRight') + '" state="frozen"/>'
    : '';
  const merges = (props.merges ?? []).map((m) => '<mergeCell ref="' + cellRef(m[0], m[1]) + ':' + cellRef(m[2], m[3]) + '"/>');
  const dim = R < 0 ? 'A1' : 'A1:' + cellRef(R, Math.max(C, 0));

  const sheet = HEAD + '<worksheet xmlns="' + NS + '" xmlns:r="' + RNS + '"><dimension ref="' + dim + '"/>'
    + '<sheetViews><sheetView workbookViewId="0"' + (props.gridlines === false ? ' showGridLines="0"' : '') + '>' + pane + '</sheetView></sheetViews>'
    + '<sheetFormatPr defaultRowHeight="19.5"/>' + (cols ? '<cols>' + cols + '</cols>' : '')
    + '<sheetData>' + rows.join('') + '</sheetData>'
    + (merges.length ? '<mergeCells count="' + merges.length + '">' + merges.join('') + '</mergeCells>' : '')
    + '</worksheet>';

  // 第 1 张是数据表，后面每个透视表一张。styles 的关系 id 排在所有工作表之后
  const sheets = [{ name: sheetName, xml: sheet }];
  for (const p of pivots) sheets.push({ name: sheetNameOf(p.name, used), xml: pivotSheet(p.matrix, p.opts ?? {}, book) });
  const WS_CT = 'application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml';
  /** @type {Record<string, string>} */ const files = {
    '[Content_Types].xml': HEAD + '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
      + '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
      + '<Default Extension="xml" ContentType="application/xml"/>'
      + '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>'
      + sheets.map((_, i) => '<Override PartName="/xl/worksheets/sheet' + (i + 1) + '.xml" ContentType="' + WS_CT + '"/>').join('')
      + '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>',
    '_rels/.rels': HEAD + '<Relationships xmlns="' + PNS + '"><Relationship Id="rId1" Type="' + RNS + '/officeDocument" Target="xl/workbook.xml"/></Relationships>',
    'xl/workbook.xml': HEAD + '<workbook xmlns="' + NS + '" xmlns:r="' + RNS + '"><sheets>'
      + sheets.map((x, i) => '<sheet name="' + esc(x.name) + '" sheetId="' + (i + 1) + '" r:id="rId' + (i + 1) + '"/>').join('')
      + '</sheets><calcPr fullCalcOnLoad="1"/></workbook>',
    'xl/_rels/workbook.xml.rels': HEAD + '<Relationships xmlns="' + PNS + '">'
      + sheets.map((_, i) => '<Relationship Id="rId' + (i + 1) + '" Type="' + RNS + '/worksheet" Target="worksheets/sheet' + (i + 1) + '.xml"/>').join('')
      + '<Relationship Id="rId' + (sheets.length + 1) + '" Type="' + RNS + '/styles" Target="styles.xml"/></Relationships>',
  };
  sheets.forEach((x, i) => { files['xl/worksheets/sheet' + (i + 1) + '.xml'] = x.xml; });
  files['xl/styles.xml'] = book.xml();
  const enc = new TextEncoder();
  return zipStore(Object.entries(files).map(([n, x]) => ({ name: n, data: enc.encode(x) })));
}

// ── 读 ───────────────────────────────────────────────────────────────────

/** @param {string} s */
const unesc = (s) => s.replace(/&(lt|gt|quot|apos|amp|#(\d+)|#x([0-9a-f]+));/gi, (_, e, d, x) =>
  d ? String.fromCodePoint(+d) : x ? String.fromCodePoint(parseInt(x, 16))
    : ({ lt: '<', gt: '>', quot: '"', apos: "'", amp: '&' })[e.toLowerCase()]);

/** <si> / <is> 里所有 <t> 拼起来（富文本分段），跳过注音 <rPh>。 @param {string} x */
const runs = (x) => {
  let s = '';
  x.replace(/<rPh\b[\s\S]*?<\/rPh>/g, '').replace(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g, (_, t) => { s += t; return ''; });
  return unesc(s);
};

const DATE_IDS = new Set([14, 15, 16, 17, 18, 19, 20, 21, 22, 45, 46, 47]);

/** Excel 序列号 → 'yyyy-mm-dd'（带时间则加 hh:mm）。 @param {number} n */
function serialToDate(n) {
  const ms = Math.round((n - 25569) * 86400000);
  const d = new Date(ms);
  const pad = (v) => String(v).padStart(2, '0');
  const date = d.getUTCFullYear() + '-' + pad(d.getUTCMonth() + 1) + '-' + pad(d.getUTCDate());
  const frac = n - Math.floor(n);
  return frac > 1e-9 ? date + ' ' + pad(d.getUTCHours()) + ':' + pad(d.getUTCMinutes()) : date;
}

/**
 * 读第一张工作表。公式保留为 "=..."，日期格式的数字转回日期文本。
 * @param {ArrayBuffer} buf
 * @returns {Promise<string[][]>}
 */
export async function fromXlsx(buf) {
  const zip = unzip(buf);
  const read = async (n) => (zip.has(n) ? zip.get(n).text() : '');

  let sheetPath = 'xl/worksheets/sheet1.xml';
  const wb = await read('xl/workbook.xml');
  const rid = /<sheet\b[^>]*\br:id="([^"]+)"/.exec(wb)?.[1];
  if (rid) {
    const rels = await read('xl/_rels/workbook.xml.rels');
    // 字符串里要写 \\b：单个 \b 是退格符，正则永远匹配不上，只能退回 sheet1.xml
    const re = new RegExp('<Relationship\\b[^>]*\\bId="' + rid + '"[^>]*>');
    const target = /Target="([^"]+)"/.exec(re.exec(rels)?.[0] ?? '')?.[1];
    if (target) sheetPath = target.startsWith('/') ? target.slice(1) : 'xl/' + target.replace(/^\.\//, '');
  }
  if (!zip.has(sheetPath)) sheetPath = [...zip.keys()].find((k) => /^xl\/worksheets\/[^/]+\.xml$/.test(k)) ?? sheetPath;

  const shared = [];
  (await read('xl/sharedStrings.xml')).replace(/<si>([\s\S]*?)<\/si>/g, (_, x) => { shared.push(runs(x)); return ''; });

  /** 哪些样式序号是日期格式 */
  const dateXf = new Set();
  const styles = await read('xl/styles.xml');
  if (styles) {
    const custom = new Map();
    styles.replace(/<numFmt\b[^>]*numFmtId="(\d+)"[^>]*formatCode="([^"]*)"/g, (_, id, code) => { custom.set(+id, unesc(code)); return ''; });
    const xfs = /<cellXfs\b[^>]*>([\s\S]*?)<\/cellXfs>/.exec(styles)?.[1] ?? '';
    let i = 0;
    xfs.replace(/<xf\b[^>]*>/g, (tag) => {
      const id = +(/numFmtId="(\d+)"/.exec(tag)?.[1] ?? 0);
      const code = custom.get(id);
      if (DATE_IDS.has(id) || (code && /[ymdh]/i.test(code.replace(/"[^"]*"|\[[^\]]*\]|\./g, '')))) dateXf.add(i);
      i++;
      return '';
    });
  }

  const xml = await read(sheetPath);
  if (!xml) throw new Error(t('找不到工作表'));
  /** @type {string[][]} */ const rows = [];
  const cellRe = /<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g;
  let m;
  while ((m = cellRe.exec(xml))) {
    const attrs = m[1], body = m[2] ?? '';
    const ref = parseRef(/\br="([A-Z]+\d+)"/.exec(attrs)?.[1] ?? '');
    if (!ref) continue;
    const t = /\bt="(\w+)"/.exec(attrs)?.[1] ?? 'n';
    const s = +(/\bs="(\d+)"/.exec(attrs)?.[1] ?? 0);
    const f = /<f\b[^>]*>([\s\S]*?)<\/f>/.exec(body)?.[1];
    const v = /<v>([\s\S]*?)<\/v>/.exec(body)?.[1];
    let out = '';
    if (f) out = '=' + unesc(f);
    else if (t === 's') out = shared[+(v ?? -1)] ?? '';
    else if (t === 'inlineStr') out = runs(/<is>([\s\S]*?)<\/is>/.exec(body)?.[1] ?? '');
    else if (t === 'b') out = v === '1' ? 'TRUE' : 'FALSE';
    else if (v != null) {
      out = unesc(v);
      if (t === 'n' && dateXf.has(s) && Number.isFinite(+out)) out = serialToDate(+out);
    }
    if (out === '') continue;
    while (rows.length <= ref.row) rows.push([]);
    const row = rows[ref.row];
    while (row.length < ref.col) row.push('');
    row[ref.col] = out;
  }
  return rows;
}

