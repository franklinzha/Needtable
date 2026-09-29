/**
 * 仪表盘导出：PNG 图片 / PDF。
 *
 * 不截屏（浏览器没有这样的 API，也不引第三方库），而是按页面上各项的实际位置重新画一遍：
 *   · 指标卡：圆角框 + 标签 + 数值
 *   · 图表：直接把页面上已经画好的 <canvas> 贴过来
 *   · 透视表：用 pivotMatrix 摊平后画成文字表格（超出框的部分截掉，和页面上一样只看得到框内）
 * 隐藏的项不导出。
 *
 * PDF 手写：一页，页面大小与图片相同，图片以 JPEG（DCTDecode）嵌入 —— PDF 原生支持 JPEG，
 * 不需要自己压缩。
 */

import { computePivot, pivotMatrix, fmtPivot, validPivot } from '../grid/pivotcalc.js';
import { t as tt } from '../../shared/i18n/i18n.js';

/** 输出倍率：高于屏幕分辨率，打印 / 放大看也清楚 */
const SCALE = 2;
const PAD = 24;
const TITLE_H = 44;

/**
 * @param {{ root: HTMLElement, kpis: HTMLElement, charts: HTMLElement, g: any }} view
 * @param {{ title: string, sub?: string, theme: {fg:string, muted:string, line:string, bg:string} }} o
 * @returns {HTMLCanvasElement}
 */
export function renderDashboard(view, o) {
  const cs = getComputedStyle(view.root);
  const color = (/** @type {string} */ n, /** @type {string} */ d) => cs.getPropertyValue(n).trim() || d;
  const page = color('--c-bg', '#fffafc');
  const surface = color('--c-surface', '#ffffff');
  const border = color('--c-border', '#f0dfeb');
  const font = color('--font-ui', 'system-ui, sans-serif') || 'system-ui, sans-serif';

  const k0 = view.kpis.getBoundingClientRect();
  const c0 = view.charts.getBoundingClientRect();
  const left = Math.min(k0.left, c0.left);
  const top = view.kpis.childElementCount ? k0.top : c0.top;
  const width = Math.max(k0.width, c0.width, 320);
  const bottom = Math.max(c0.bottom, k0.bottom);
  const W = Math.ceil(width + PAD * 2), H = Math.ceil(bottom - top + PAD * 2 + TITLE_H);

  const canvas = document.createElement('canvas');
  canvas.width = W * SCALE;
  canvas.height = H * SCALE;
  const ctx = /** @type {CanvasRenderingContext2D} */ (canvas.getContext('2d'));
  ctx.scale(SCALE, SCALE);
  ctx.fillStyle = page;
  ctx.fillRect(0, 0, W, H);
  ctx.textBaseline = 'middle';

  // 标题
  ctx.fillStyle = o.theme.fg;
  ctx.font = '700 18px ' + font;
  ctx.fillText(o.title, PAD, PAD + 10);
  if (o.sub) {
    ctx.fillStyle = o.theme.muted;
    ctx.font = '12px ' + font;
    ctx.fillText(o.sub, PAD, PAD + 30);
  }

  /** 页面坐标 → 画布坐标 @param {DOMRect} r */
  const at = (r) => ({ x: r.left - left + PAD, y: r.top - top + PAD + TITLE_H, w: r.width, h: r.height });
  const box = (/** @type {{x:number,y:number,w:number,h:number}} */ b) => {
    ctx.fillStyle = surface;
    ctx.strokeStyle = border;
    ctx.lineWidth = 1;
    roundRect(ctx, b.x + 0.5, b.y + 0.5, b.w - 1, b.h - 1, 10);
    ctx.fill();
    ctx.stroke();
  };

  // 指标卡
  for (const card of /** @type {HTMLElement[]} */ ([...view.kpis.children])) {
    const b = at(card.getBoundingClientRect());
    box(b);
    const accent = getComputedStyle(card).borderLeftColor || o.theme.fg;
    ctx.save();
    roundRect(ctx, b.x + 0.5, b.y + 0.5, b.w - 1, b.h - 1, 10);
    ctx.clip();
    ctx.fillStyle = accent;
    ctx.fillRect(b.x, b.y, 4, b.h);
    ctx.restore();
    const label = card.querySelector('.db__klabel')?.textContent ?? '';
    const val = card.querySelector('.db__kval')?.textContent ?? '';
    ctx.fillStyle = o.theme.muted;
    ctx.font = '12px ' + font;
    ctx.fillText(ellipsis(ctx, label, b.w - 32), b.x + 16, b.y + 20);
    ctx.fillStyle = o.theme.fg;
    ctx.font = '700 26px ' + font;
    ctx.fillText(ellipsis(ctx, val, b.w - 32), b.x + 16, b.y + b.h - 26);
  }

  // 图表 / 透视表
  const pivots = new Map((Array.isArray(view.g.model.props.pivots) ? view.g.model.props.pivots : [])
    .filter((/** @type {any} */ p) => p?.id).map((/** @type {any} */ p) => [p.id, p]));
  for (const el of /** @type {HTMLElement[]} */ ([...view.charts.querySelectorAll('.db__item')])) {
    const b = at(el.getBoundingClientRect());
    box(b);
    const head = el.querySelector('.db__ihead');
    const hh = head ? head.getBoundingClientRect().height : 28;
    ctx.fillStyle = o.theme.fg;
    ctx.font = '600 12px ' + font;
    ctx.fillText(ellipsis(ctx, el.querySelector('.db__ititle')?.textContent ?? '', b.w - 24), b.x + 12, b.y + hh / 2);
    ctx.strokeStyle = border;
    ctx.beginPath();
    ctx.moveTo(b.x + 1, b.y + hh + 0.5);
    ctx.lineTo(b.x + b.w - 1, b.y + hh + 0.5);
    ctx.stroke();

    const src = /** @type {HTMLCanvasElement | null} */ (el.querySelector('canvas.db__canvas'));
    if (src) {
      const r = at(src.getBoundingClientRect());
      if (src.width && src.height) ctx.drawImage(src, r.x, r.y, r.w, r.h);
      continue;
    }
    const p = pivots.get(el.dataset.pivot ?? '');
    const area = el.querySelector('.db__pv');
    if (p && area) {
      const r = at(area.getBoundingClientRect());
      ctx.save();
      ctx.beginPath();
      ctx.rect(r.x, r.y, r.w, r.h);
      ctx.clip();
      drawPivot(ctx, view.g, p, r, { ...o.theme, font, head: color('--c-bg-sunken', '#f7ecf4'), total: color('--c-grid-header', '#fdf4f9') });
      ctx.restore();
    }
  }
  return canvas;
}

/**
 * 透视表画成文字表格。
 * @param {CanvasRenderingContext2D} ctx @param {any} g @param {any} p
 * @param {{x:number,y:number,w:number,h:number}} r
 * @param {{fg:string, muted:string, line:string, font:string, head:string, total:string}} t
 */
function drawPivot(ctx, g, p, r, t) {
  if (!validPivot(p)) return;
  const res = computePivot(p, (rr, c) => g.calc.value(rr, c), (rr, c) => g.calc.text(rr, c), (c) => g.model.colTitle(c));
  if (res.error) {
    ctx.fillStyle = t.muted;
    ctx.font = '12px ' + t.font;
    ctx.fillText(res.error, r.x + 8, r.y + 16);
    return;
  }
  const mat = pivotMatrix(res);
  const text = (/** @type {{v:any, pct?:boolean}} */ cell) => (typeof cell.v === 'number' ? fmtPivot(cell.v, !!cell.pct, res.opts) : String(cell.v ?? ''));
  const ROW = 24, PADX = 8;
  // 列宽：按内容量，封顶 180
  /** @type {number[]} */ const widths = [];
  ctx.font = '600 12px ' + t.font;
  mat.rows.forEach((row) => row.forEach((cell, c) => {
    widths[c] = Math.min(180, Math.max(widths[c] ?? 40, ctx.measureText(text(cell)).width + PADX * 2));
  }));
  let y = r.y;
  mat.rows.forEach((row, i) => {
    if (y > r.y + r.h) return;
    const kind = mat.kinds[i];
    const bold = kind !== '';
    let x = r.x;
    const rowW = widths.reduce((a, b) => a + b, 0);
    if (kind === 'head' || kind === 'total' || kind === 'sub') {
      ctx.fillStyle = kind === 'head' ? t.head : t.total;
      ctx.fillRect(r.x, y, rowW, ROW);
    }
    ctx.font = (bold ? '600 ' : '') + '12px ' + t.font;
    row.forEach((cell, c) => {
      const w = widths[c];
      const s = ellipsis(ctx, text(cell), w - PADX * 2);
      ctx.fillStyle = t.fg;
      if (typeof cell.v === 'number') {
        ctx.textAlign = 'right';
        ctx.fillText(s, x + w - PADX, y + ROW / 2);
        ctx.textAlign = 'left';
      } else {
        ctx.fillText(s, x + PADX, y + ROW / 2);
      }
      x += w;
    });
    ctx.strokeStyle = t.line;
    ctx.beginPath();
    ctx.moveTo(r.x, y + ROW - 0.5);
    ctx.lineTo(r.x + rowW, y + ROW - 0.5);
    ctx.stroke();
    y += ROW;
  });
}

/** @param {CanvasRenderingContext2D} ctx @param {string} s @param {number} max */
function ellipsis(ctx, s, max) {
  if (max <= 0) return '';
  if (ctx.measureText(s).width <= max) return s;
  let lo = 0, hi = s.length;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (ctx.measureText(s.slice(0, mid) + '…').width <= max) lo = mid; else hi = mid - 1;
  }
  return s.slice(0, lo) + '…';
}

/** @param {CanvasRenderingContext2D} ctx */
function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

/** @param {HTMLCanvasElement} canvas @param {string} type @param {number} [q] @returns {Promise<Blob>} */
export function canvasBlob(canvas, type, q) {
  return new Promise((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error(tt('导出失败：画布太大')))), type, q));
}

/**
 * 一页 PDF，内容就是一张 JPEG。页面尺寸按 CSS 像素 × 0.75 换成 pt（96dpi → 72dpi）。
 * @param {Uint8Array} jpeg @param {number} imgW 图片像素宽 @param {number} imgH
 * @param {number} pageW 页面 pt 宽 @param {number} pageH
 * @returns {Uint8Array}
 */
export function pdfFromJpeg(jpeg, imgW, imgH, pageW, pageH) {
  const enc = new TextEncoder();
  const W = +pageW.toFixed(2), H = +pageH.toFixed(2);
  const content = 'q ' + W + ' 0 0 ' + H + ' 0 0 cm /Im0 Do Q';
  /** @type {(string | Uint8Array)[][]} */ const objs = [
    ['<< /Type /Catalog /Pages 2 0 R >>'],
    ['<< /Type /Pages /Kids [3 0 R] /Count 1 >>'],
    ['<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ' + W + ' ' + H + '] /Resources << /XObject << /Im0 4 0 R >> >> /Contents 5 0 R >>'],
    ['<< /Type /XObject /Subtype /Image /Width ' + imgW + ' /Height ' + imgH
      + ' /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ' + jpeg.length + ' >>\nstream\n', jpeg, '\nendstream'],
    ['<< /Length ' + content.length + ' >>\nstream\n' + content + '\nendstream'],
  ];
  /** @type {Uint8Array[]} */ const parts = [];
  let len = 0;
  const put = (/** @type {string | Uint8Array} */ x) => { const b = typeof x === 'string' ? enc.encode(x) : x; parts.push(b); len += b.length; };
  put('%PDF-1.4\n%âãÏÓ\n');
  /** @type {number[]} */ const offsets = [];
  objs.forEach((o, i) => {
    offsets.push(len);
    put((i + 1) + ' 0 obj\n');
    o.forEach(put);
    put('\nendobj\n');
  });
  const xref = len;
  put('xref\n0 ' + (objs.length + 1) + '\n0000000000 65535 f \n'
    + offsets.map((n) => String(n).padStart(10, '0') + ' 00000 n \n').join('')
    + 'trailer\n<< /Size ' + (objs.length + 1) + ' /Root 1 0 R >>\nstartxref\n' + xref + '\n%%EOF\n');
  const out = new Uint8Array(len);
  let at = 0;
  for (const b of parts) { out.set(b, at); at += b.length; }
  return out;
}
