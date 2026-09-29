/**
 * Canvas 网格渲染器。
 *
 * 为什么不用 DOM：10 万行 × 26 列 = 260 万个格子，哪怕只挂可视区的 ~600 个节点，
 * 滚动时的节点回收与样式重算也会在中端笔记本上掉帧。Canvas 每帧只画看得见的部分，
 * 成本与数据量完全无关。
 *
 * 每个窗格按固定层次绘制：网格线 → 合并块底色 → 单元格（底色 / 数据条 / 文本 / 装饰）
 * → 边框 → 合并块文本 → 筛选按钮。文本、颜色、对齐全部问 calc（它负责公式与数字格式），
 * 渲染器自己只关心"画在哪、画成什么样"。
 *
 * 颜色全部取自 CSS 变量（tokens.css），所以暗色模式无需在这里写第二套配色。
 */

import { t as tt } from '../../shared/i18n/i18n.js';

const FROZEN_SHADOW = 'rgba(0,0,0,0.10)';
const K = 16384;
const PAD = 6;
const FILTER_BTN = 16;

export class GridRenderer {
  /**
   * @param {HTMLCanvasElement} canvas
   * @param {import('./model.js').GridModel} model
   * @param {import('./viewport.js').Viewport} vp
   * @param {import('./selection.js').Selection} sel
   * @param {import('./calc.js').Calc} calc
   */
  constructor(canvas, model, vp, sel, calc) {
    this.canvas = canvas;
    this.ctx = /** @type {CanvasRenderingContext2D} */ (canvas.getContext('2d', { alpha: false }));
    this.model = model;
    this.vp = vp;
    this.sel = sel;
    this.calc = calc;
    this.theme = readTheme(canvas);
    this.dpr = 1;
    this._raf = 0;
    this._font = '';
    /** @type {Map<string, {sel:{r0:number,c0:number,r1:number,c1:number}, label:string}>}
     *  其他人的选区。只读展示，永远不参与本地的任何判断。 */
    this.peers = new Map();
    /** 公式编辑时被引用区域的彩色框。 @type {{r0:number,c0:number,r1:number,c1:number,color:string}[]} */
    this.refHighlights = [];
    /** 复制区域的虚线框。 @type {{r0:number,c0:number,r1:number,c1:number} | null} */
    this.copyRect = null;
    /** 填充柄拖拽中的目标区域预览。 @type {{r0:number,c0:number,r1:number,c1:number} | null} */
    this.fillPreview = null;
    this.showFillHandle = true;
    /** 上一帧填充柄的屏幕位置（命中测试用）。 @type {{x:number,y:number,w:number,h:number} | null} */
    this.handleRect = null;
    /** 上一帧活动单元格下拉按钮的位置。 @type {{x:number,y:number,w:number,h:number} | null} */
    this.listBtnRect = null;
  }

  refreshTheme() { this.theme = readTheme(this.canvas); this._font = ''; }

  /** 合帧：一次事件里多处调用只画一遍。 */
  schedule() {
    if (this._raf) return;
    this._raf = requestAnimationFrame(() => { this._raf = 0; this.draw(); });
  }

  /** 按容器尺寸与 devicePixelRatio 调整位图，返回尺寸是否变化。 */
  resize(w, h) {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);   // >2 的屏收益已不可见，显存却翻倍
    const bw = Math.round(w * dpr);
    const bh = Math.round(h * dpr);
    if (this.canvas.width === bw && this.canvas.height === bh) return false;
    this.canvas.width = bw;
    this.canvas.height = bh;
    this.canvas.style.width = w + 'px';
    this.canvas.style.height = h + 'px';
    this.dpr = dpr;
    this.vp.width = w;
    this.vp.height = h;
    return true;
  }

  _setFont(f) { if (f !== this._font) { this.ctx.font = f; this._font = f; } }

  /** 单元格样式 → canvas font 串。 */
  fontOf(fmt) {
    const t = this.theme;
    if (!fmt || (!fmt.b && !fmt.i && !fmt.fs && !fmt.ff)) return t.font;
    return (fmt.i ? 'italic ' : '') + (fmt.b ? 'bold ' : '') + (fmt.fs || t.fs) + 'px ' + (fmt.ff ? fmt.ff + ', ' : '') + t.family;
  }

  draw() {
    const { ctx, vp, theme } = this;
    const dpr = this.dpr || 1;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = theme.bg;
    ctx.fillRect(0, 0, vp.width, vp.height);
    this._font = '';
    this._setFont(theme.font);
    ctx.textBaseline = 'middle';
    /** 本帧画出的附件角标，grid 用它判断点击 */
    this.fileHits = [];

    const v = vp.visible();
    const fr = vp.frozenRows;
    const fc = vp.frozenCols;

    // 四个窗格：主体、冻结行、冻结列、冻结角。冻结数为 0 时后三个直接跳过。
    this._pane(v.r0, v.r1, v.c0, v.c1, vp.headerW + vp.frozenW, vp.headerH + vp.frozenH);
    if (fr > 0) this._pane(0, fr - 1, v.c0, v.c1, vp.headerW + vp.frozenW, vp.headerH);
    if (fc > 0) this._pane(v.r0, v.r1, 0, fc - 1, vp.headerW, vp.headerH + vp.frozenH);
    if (fr > 0 && fc > 0) this._pane(0, fr - 1, 0, fc - 1, vp.headerW, vp.headerH);

    this._selection();
    this._overlays();
    this._peers();
    this._headers(v);
    this._frozenEdges();
  }

  /** 行 r 的屏幕 y（冻结行不减滚动量）。 */
  _rowY(r) { const vp = this.vp; return vp.headerH + vp.rows.offsetOf(r) - (r < vp.frozenRows ? 0 : vp.scrollY); }
  _colX(c) { const vp = this.vp; return vp.headerW + vp.cols.offsetOf(c) - (c < vp.frozenCols ? 0 : vp.scrollX); }

  /** 区域（闭区间）的屏幕矩形。 */
  rectOf(r0, c0, r1, c1) {
    const x = this._colX(c0), y = this._rowY(r0);
    return { x, y, w: this._colX(c1) + this.vp.cols.sizeOf(c1) - x, h: this._rowY(r1) + this.vp.rows.sizeOf(r1) - y };
  }

  /** 筛选按钮的屏幕位置。 */
  filterBtnRect(r, c) {
    const x = this._colX(c), y = this._rowY(r);
    const w = this.vp.cols.sizeOf(c), h = this.vp.rows.sizeOf(r);
    const s = Math.min(FILTER_BTN, h - 4);
    return { x: x + w - s - 3, y: y + (h - s) / 2, w: s, h: s };
  }

  /** 画一个窗格。clipX/clipY 是窗格左上边界，右下永远到画布边。 */
  _pane(r0, r1, c0, c1, clipX, clipY) {
    const { ctx, vp, model, theme, calc } = this;
    if (r1 < r0 || c1 < c0) return;
    const W = vp.width, H = vp.height;

    // 先把可见的行列（跳过隐藏的、滚出画布的）连同坐标算好，后面几层共用
    /** @type {number[]} */ const rows = [], ry = [], rh = [];
    for (let r = r0; r <= r1; r++) {
      const h = vp.rows.sizeOf(r);
      if (!h) continue;
      const y = this._rowY(r);
      if (y > H) break;
      if (y + h < clipY) continue;
      rows.push(r); ry.push(y); rh.push(h);
    }
    /** @type {number[]} */ const cols = [], cx = [], cw = [];
    for (let c = c0; c <= c1; c++) {
      const w = vp.cols.sizeOf(c);
      if (!w) continue;
      const x = this._colX(c);
      if (x > W) break;
      if (x + w < clipX) continue;
      cols.push(c); cx.push(x); cw.push(w);
    }
    if (!rows.length || !cols.length) return;

    ctx.save();
    ctx.beginPath();
    ctx.rect(clipX, clipY, W - clipX, H - clipY);
    ctx.clip();

    // ① 网格线整条一次性描：比每格描四边少一个数量级的路径操作
    if (model.props.gridlines !== false) {
      ctx.strokeStyle = theme.line;
      ctx.lineWidth = 1;
      ctx.beginPath();
      for (let i = 0; i < rows.length; i++) {
        const y = Math.round(ry[i] + rh[i]) - 0.5;
        ctx.moveTo(clipX, y);
        ctx.lineTo(W, y);
      }
      for (let j = 0; j < cols.length; j++) {
        const x = Math.round(cx[j] + cw[j]) - 0.5;
        ctx.moveTo(x, clipY);
        ctx.lineTo(x, H);
      }
      ctx.stroke();
    }

    // ② 合并块：盖住内部网格线，内部格子在下面的循环里跳过
    const merges = calc.mergesIn(rows[0], rows[rows.length - 1], cols[0], cols[cols.length - 1]);
    /** @type {Set<number> | null} */ let covered = null;
    const hasCf = calc.hasCf;
    if (merges.length) {
      covered = new Set();
      for (const m of merges) {
        const ra = Math.max(m[0], rows[0]), rb = Math.min(m[2], rows[rows.length - 1]);
        const ca = Math.max(m[1], cols[0]), cb = Math.min(m[3], cols[cols.length - 1]);
        for (let r = ra; r <= rb; r++) for (let c = ca; c <= cb; c++) covered.add(r * K + c);
        const box = this.rectOf(m[0], m[1], m[2], m[3]);
        const fmt = model.getFormat(m[0], m[1]);
        const cf = hasCf ? calc.cfAt(m[0], m[1]) : null;
        ctx.fillStyle = cf?.bg || fmt?.bg || theme.bg;
        ctx.fillRect(Math.round(box.x), Math.round(box.y), Math.round(box.x + box.w) - 1 - Math.round(box.x), Math.round(box.y + box.h) - 1 - Math.round(box.y));
      }
    }

    const hasNotes = calc.hasNotes;
    const hasVal = Array.isArray(model.props.validations) && model.props.validations.length > 0;
    /** @type {any[]} */ const borders = [];

    // ③ 逐格：底色 → 数据条 → 文本 → 批注角标
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i], y = ry[i], h = rh[i];
      for (let j = 0; j < cols.length; j++) {
        const c = cols[j];
        if (covered && covered.has(r * K + c)) continue;
        const x = cx[j], w = cw[j];
        const fmt = model.getFormat(r, c);
        const raw = model.getCell(r, c);
        // 空格子也可能被动态数组铺到（=IMPORTRANGE(...) 的结果）
        const spilled = raw === '' && !!calc.spillOwner(r, c);
        if (!fmt && raw === '' && !hasCf && !spilled) continue;
        const cf = hasCf ? calc.cfAt(r, c) : null;
        const bg = cf?.bg || fmt?.bg;
        if (bg) { ctx.fillStyle = bg; ctx.fillRect(x, y, w, h); }
        if (cf?.bar) this._bar(cf.bar, x, y, w, h);
        if (fmt?.bd) borders.push(x, y, w, h, fmt.bd);
        if (raw === '' && !spilled) continue;

        const val = hasVal ? calc.validationAt(r, c) : null;
        if (val?.type === 'checkbox') { this._checkbox(calc.value(r, c), x, y, w, h); continue; }

        // 左对齐的长文本溢出到右侧的空格子里（与 Excel 一致），溢出区的竖线要擦掉
        let extra = 0;
        const d = calc.display(r, c);
        const align = fmt?.ha || d.align;
        if (align === 'l' && !fmt?.wr && d.text.length > 3) {
          this._setFont(this.fontOf(fmt));
          const need = ctx.measureText(d.text).width + PAD * 2;
          if (need > w) {
            for (let k = j + 1; k < cols.length && w + extra < need; k++) {
              const cc = cols[k];
              if (calc.hasContent(r, cc) || (covered && covered.has(r * K + cc))) break;
              const f2 = model.getFormat(r, cc);
              if (f2?.bg || (hasCf && calc.cfAt(r, cc)?.bg)) break;
              extra += cw[k];
            }
            if (extra > 0) {
              const y0 = Math.round(y);
              ctx.fillStyle = bg || theme.bg;
              ctx.fillRect(Math.round(x + w) - 1, y0, extra, Math.round(y + h) - 1 - y0);
            }
          }
        }
        this._cellText(d, fmt, cf, x, y, w, h, extra);
        if (hasNotes && calc.noteAt(r, c) != null) this._noteMark(x, y, w);
      }
    }

    // ④ 边框压在所有底色之上
    for (let k = 0; k < borders.length; k += 5) this._borders(borders[k], borders[k + 1], borders[k + 2], borders[k + 3], borders[k + 4]);

    // ⑤ 合并块的文本（在合并区内居中 / 对齐）
    for (const m of merges) {
      const box = this.rectOf(m[0], m[1], m[2], m[3]);
      const fmt = model.getFormat(m[0], m[1]);
      if (fmt?.bd) this._borders(box.x, box.y, box.w, box.h, fmt.bd);
      if (model.getCell(m[0], m[1]) === '') continue;
      const cf = hasCf ? calc.cfAt(m[0], m[1]) : null;
      this._cellText(calc.display(m[0], m[1]), fmt, cf, box.x, box.y, box.w, box.h, 0);
      if (hasNotes && calc.noteAt(m[0], m[1]) != null) this._noteMark(box.x, box.y, box.w);
    }

    // ⑤½ 附件角标
    if (calc.fileEntries().length) this._files(rows, cols);

    // ⑥ 自动筛选的下拉按钮
    const f = model.props.filter;
    if (f && Array.isArray(f.range)) {
      const i = rows.indexOf(f.range[0]);
      if (i >= 0) {
        for (let j = 0; j < cols.length; j++) {
          const c = cols[j];
          if (c < f.range[1] || c > f.range[3]) continue;
          const crit = f.crit?.[c];
          const active = Array.isArray(crit) ? crit.length > 0 : !!(crit && ((crit.show) || (crit.hide && crit.hide.length)));
          this._filterBtn(this.filterBtnRect(f.range[0], c), active);
        }
      }
    }
    ctx.restore();
  }

  /**
   * 单元格文本。extra 是向右溢出可用的额外宽度。
   * 数字放不下显示 ###（和 Excel 一样，绝不截断出一个错误的数），文本放不下补省略号。
   */
  _cellText(d, fmt, cf, x, y, w, h, extra) {
    const { ctx, theme } = this;
    if (!d.text) return;
    const avail = w + extra - PAD * 2;
    if (avail <= 4) return;
    const font = cf && (cf.b || cf.i) ? this.fontOf({ ...fmt, b: cf.b || fmt?.b, i: cf.i || fmt?.i }) : this.fontOf(fmt);
    this._setFont(font);
    ctx.fillStyle = cf?.fc || d.color || fmt?.fc || theme.text;
    const align = fmt?.ha || d.align;
    const va = fmt?.va || 'm';
    const fs = fmt?.fs || theme.fs;
    const lineH = Math.round(fs * 1.35);

    /** @type {string[]} */ let lines;
    if (fmt?.wr) {
      lines = wrapLines(ctx, d.text, w - PAD * 2, Math.max(1, Math.floor((h - 4) / lineH)));
    } else {
      let s = d.text.length > 300 ? d.text.slice(0, 300) : d.text;
      if (s.includes('\n')) s = s.replace(/\r?\n/g, ' ');
      let tw = ctx.measureText(s).width;
      if (tw > avail) {
        if (d.align === 'r' && align !== 'l') {
          s = '#'.repeat(Math.max(1, Math.floor(avail / Math.max(1, ctx.measureText('#').width))));
        } else {
          // 按平均字宽估一刀再微调：比逐字符二分快，视觉上没差别
          let n = Math.max(1, Math.floor(s.length * avail / tw) - 1);
          while (n > 1 && ctx.measureText(s.slice(0, n) + '…').width > avail) n--;
          s = s.slice(0, n) + '…';
        }
      }
      lines = [s];
    }

    const blockH = lines.length * lineH;
    let ty = va === 't' ? y + 3 + lineH / 2 : va === 'b' ? y + h - 3 - blockH + lineH / 2 : y + (h - blockH) / 2 + lineH / 2;
    for (const line of lines) {
      const tw = ctx.measureText(line).width;
      const tx = align === 'r' ? x + w - PAD - tw : align === 'c' ? x + (w - tw) / 2 : x + PAD;
      ctx.fillText(line, tx, ty);
      if (fmt?.u || fmt?.s) {
        ctx.fillRect(tx, Math.round(fmt.u ? ty + fs * 0.5 : ty) , tw, Math.max(1, fs / 14));
        if (fmt.u && fmt.s) ctx.fillRect(tx, Math.round(ty), tw, Math.max(1, fs / 14));
      }
      ty += lineH;
    }
  }

  _bar(bar, x, y, w, h) {
    const ctx = this.ctx;
    ctx.globalAlpha = 0.55;
    ctx.fillStyle = bar.color;
    ctx.fillRect(x + 2, y + 3, Math.max(0, (w - 4) * bar.ratio), h - 7);
    ctx.globalAlpha = 1;
  }

  _checkbox(v, x, y, w, h) {
    const { ctx, theme } = this;
    const on = v === true || (typeof v === 'number' && v !== 0) || (typeof v === 'string' && v.toUpperCase() === 'TRUE');
    const s = Math.min(14, h - 6);
    const bx = Math.round(x + (w - s) / 2) + 0.5, by = Math.round(y + (h - s) / 2) + 0.5;
    ctx.lineWidth = 1.5;
    if (on) {
      ctx.fillStyle = theme.accent;
      ctx.fillRect(bx - 0.5, by - 0.5, s + 1, s + 1);
      ctx.strokeStyle = '#fff';
      ctx.beginPath();
      ctx.moveTo(bx + s * 0.22, by + s * 0.52);
      ctx.lineTo(bx + s * 0.42, by + s * 0.72);
      ctx.lineTo(bx + s * 0.78, by + s * 0.3);
      ctx.stroke();
    } else {
      ctx.strokeStyle = theme.textMuted;
      ctx.strokeRect(bx, by, s, s);
    }
    ctx.lineWidth = 1;
  }

/** 附件：右侧一枚 📎 小签（多于一个时带数量）；单元格没有文字时顺带显示文件名。 */
  _files(rows, cols) {
    const { ctx, theme, calc, model, vp } = this;
    const rA = rows[0], rB = rows[rows.length - 1], cA = cols[0], cB = cols[cols.length - 1];
    for (const [r, c, files] of calc.fileEntries()) {
      if (r < rA || r > rB || c < cA || c > cB) continue;
      const m = calc.mergeAt(r, c);
      if (m && (m[0] !== r || m[1] !== c)) continue;
      if (!vp.rows.sizeOf(r) || !vp.cols.sizeOf(c)) continue;
      const box = m ? this.rectOf(m[0], m[1], m[2], m[3]) : this.rectOf(r, c, r, c);
      const label = files.length > 1 ? '📎' + files.length : '📎';
      this._setFont('11px ' + theme.family);
      const cw = Math.min(box.w - 4, ctx.measureText(label).width + 8);
      const ch = Math.min(16, box.h - 4);
      const cx = box.x + box.w - cw - 3, cy = box.y + (box.h - ch) / 2;
      ctx.globalAlpha = 0.14;
      ctx.fillStyle = theme.accent;
      ctx.beginPath();
      ctx.roundRect ? ctx.roundRect(cx, cy, cw, ch, 4) : ctx.rect(cx, cy, cw, ch);
      ctx.fill();
      ctx.globalAlpha = 1;
      ctx.fillStyle = theme.accent;
      ctx.textAlign = 'center';
      ctx.fillText(label, cx + cw / 2, cy + ch / 2 + 0.5);
      ctx.textAlign = 'left';
      if (model.getCell(r, c) === '' && cx - box.x > 30) {
        this._setFont(theme.font);
        ctx.fillStyle = theme.textMuted;
        ctx.save();
        ctx.beginPath();
        ctx.rect(box.x, box.y, cx - box.x - 2, box.h);
        ctx.clip();
        ctx.fillText(String(files[0].n ?? tt('附件')), box.x + PAD, box.y + box.h / 2);
        ctx.restore();
      }
      this.fileHits.push({ x: cx, y: cy, w: cw, h: ch, r, c });
    }
  }

  /** @returns {{r:number,c:number} | null} */
  fileHitAt(x, y) {
    for (const b of this.fileHits ?? []) if (x >= b.x && x <= b.x + b.w && y >= b.y && y <= b.y + b.h) return b;
    return null;
  }

  _noteMark(x, y, w) {
    const ctx = this.ctx;
    ctx.fillStyle = this.theme.danger;
    ctx.beginPath();
    ctx.moveTo(x + w - 7, y);
    ctx.lineTo(x + w - 1, y);
    ctx.lineTo(x + w - 1, y + 6);
    ctx.closePath();
    ctx.fill();
  }

  _borders(x, y, w, h, bd) {
    const ctx = this.ctx;
    const L = Math.round(x) - 0.5, R = Math.round(x + w) - 0.5, T = Math.round(y) - 0.5, B = Math.round(y + h) - 0.5;
    ctx.lineWidth = 1;
    const seg = (color, x1, y1, x2, y2) => {
      ctx.strokeStyle = color;
      ctx.beginPath();
      ctx.moveTo(x1, y1);
      ctx.lineTo(x2, y2);
      ctx.stroke();
    };
    if (bd.t) seg(bd.t, L - 0.5, T, R + 0.5, T);
    if (bd.b) seg(bd.b, L - 0.5, B, R + 0.5, B);
    if (bd.l) seg(bd.l, L, T - 0.5, L, B + 0.5);
    if (bd.r) seg(bd.r, R, T - 0.5, R, B + 0.5);
  }

  _filterBtn(b, active) {
    const { ctx, theme } = this;
    ctx.fillStyle = active ? theme.accent : theme.headerBg;
    ctx.fillRect(b.x, b.y, b.w, b.h);
    ctx.strokeStyle = active ? theme.accent : theme.lineStrong;
    ctx.strokeRect(Math.round(b.x) + 0.5, Math.round(b.y) + 0.5, b.w - 1, b.h - 1);
    ctx.fillStyle = active ? '#fff' : theme.textMuted;
    const cx = b.x + b.w / 2, cy = b.y + b.h / 2;
    ctx.beginPath();
    ctx.moveTo(cx - 4, cy - 2);
    ctx.lineTo(cx + 4, cy - 2);
    ctx.lineTo(cx, cy + 3);
    ctx.closePath();
    ctx.fill();
  }

  /** 选区底色 + 活动单元格边框 + 填充柄 + 下拉按钮。 */
  _selection() {
    const { ctx, vp, sel, theme, calc } = this;
    const s = calc.expandRect(sel.rect);
    const a = sel.active;
    const m = calc.mergeAt(a.r, a.c);
    const act = m ? this.rectOf(m[0], m[1], m[2], m[3]) : vp.cellRect(a.r, a.c);

    ctx.save();
    ctx.beginPath();
    ctx.rect(vp.headerW, vp.headerH, vp.bodyW, vp.bodyH);
    ctx.clip();

    const box = this.rectOf(s.r0, s.c0, s.r1, s.c1);
    const single = sel.isSingle || (m && s.r0 === m[0] && s.c0 === m[1] && s.r1 === m[2] && s.c1 === m[3]);
    if (!single) {
      ctx.fillStyle = theme.selFill;
      ctx.fillRect(box.x, box.y, box.w, box.h);
      ctx.strokeStyle = theme.accent;
      ctx.lineWidth = 1;
      ctx.strokeRect(Math.round(box.x) - 0.5, Math.round(box.y) - 0.5, box.w, box.h);
    }

    ctx.strokeStyle = theme.accent;
    ctx.lineWidth = 2;
    ctx.strokeRect(Math.round(act.x) - 1, Math.round(act.y) - 1, act.w + 1, act.h + 1);

    this.handleRect = null;
    if (this.showFillHandle) {
      const hx = Math.round(box.x + box.w) - 4, hy = Math.round(box.y + box.h) - 4;
      if (hx > vp.headerW && hy > vp.headerH && hx < vp.width && hy < vp.height) {
        ctx.fillStyle = '#fff';
        ctx.fillRect(hx - 1, hy - 1, 9, 9);
        ctx.fillStyle = theme.accent;
        ctx.fillRect(hx, hy, 7, 7);
        this.handleRect = { x: hx - 3, y: hy - 3, w: 13, h: 13 };
      }
    }

    this.listBtnRect = null;
    const val = calc.validationAt(a.r, a.c);
    if ((val?.type === 'list' || val?.type === 'cascade') && this.showFillHandle) {
      const bw = 18, bh = Math.min(20, act.h - 2);
      const bx = act.x + act.w + 2, by = act.y + (act.h - bh) / 2;
      ctx.fillStyle = theme.headerBg;
      ctx.fillRect(bx, by, bw, bh);
      ctx.strokeStyle = theme.lineStrong;
      ctx.lineWidth = 1;
      ctx.strokeRect(Math.round(bx) + 0.5, Math.round(by) + 0.5, bw - 1, bh - 1);
      ctx.fillStyle = theme.textMuted;
      ctx.beginPath();
      ctx.moveTo(bx + 5, by + bh / 2 - 2);
      ctx.lineTo(bx + 13, by + bh / 2 - 2);
      ctx.lineTo(bx + 9, by + bh / 2 + 3);
      ctx.closePath();
      ctx.fill();
      this.listBtnRect = { x: bx, y: by, w: bw, h: bh };
    }
    ctx.restore();
  }

  /** 公式引用高亮、复制虚线框、填充预览。 */
  _overlays() {
    const { ctx, vp, theme } = this;
    if (!this.refHighlights.length && !this.copyRect && !this.fillPreview) return;
    ctx.save();
    ctx.beginPath();
    ctx.rect(vp.headerW, vp.headerH, vp.bodyW, vp.bodyH);
    ctx.clip();
    for (const h of this.refHighlights) {
      const b = this.rectOf(h.r0, h.c0, Math.min(h.r1, this.model.rowCount - 1), Math.min(h.c1, this.model.colCount - 1));
      ctx.globalAlpha = 0.08;
      ctx.fillStyle = h.color;
      ctx.fillRect(b.x, b.y, b.w, b.h);
      ctx.globalAlpha = 1;
      ctx.strokeStyle = h.color;
      ctx.lineWidth = 2;
      ctx.strokeRect(Math.round(b.x), Math.round(b.y), b.w - 1, b.h - 1);
    }
    const dashed = (s, color) => {
      const b = this.rectOf(s.r0, s.c0, s.r1, s.c1);
      ctx.strokeStyle = color;
      ctx.lineWidth = 2;
      ctx.setLineDash([5, 3]);
      ctx.strokeRect(Math.round(b.x), Math.round(b.y), b.w - 1, b.h - 1);
      ctx.setLineDash([]);
    };
    if (this.copyRect) dashed(this.copyRect, theme.accent);
    if (this.fillPreview) dashed(this.fillPreview, theme.textMuted);
    ctx.restore();
  }

  /**
   * 其他协作者的选区。画在自己的选区之上、表头之下。
   * 颜色由用户 ID 哈希出色相 —— 同一个人在所有人屏幕上永远是同一个颜色，
   * 而且不需要服务端分配调色板。
   */
  _peers() {
    if (this.peers.size === 0) return;
    const { ctx, vp } = this;

    ctx.save();
    ctx.beginPath();
    ctx.rect(vp.headerW, vp.headerH, vp.bodyW, vp.bodyH);
    ctx.clip();
    ctx.lineWidth = 2;
    this._setFont(this.theme.font);
    ctx.textBaseline = 'middle';

    for (const [id, peer] of this.peers) {
      const s = peer.sel;
      if (!s) continue;
      const a = vp.cellRect(s.r0, s.c0);
      const b = vp.cellRect(s.r1, s.c1);
      const w = b.x + b.w - a.x;
      const h = b.y + b.h - a.y;
      if (a.x > vp.width || a.y > vp.height || a.x + w < vp.headerW || a.y + h < vp.headerH) continue;

      const hue = hashHue(id);
      // 正在输入的人：选框加粗，名牌后面写「正在输入…」
      ctx.lineWidth = peer.editing ? 3 : 2;
      ctx.strokeStyle = 'hsl(' + hue + ' 72% 48%)';
      ctx.fillStyle = 'hsl(' + hue + ' 72% 48% / 0.12)';
      ctx.fillRect(a.x, a.y, w, h);
      ctx.strokeRect(Math.round(a.x) - 1, Math.round(a.y) - 1, w + 1, h + 1);

      // 名牌贴在选区上沿；顶到画布外时翻到下沿，免得被表头吃掉
      const label = peer.editing ? tt('{name} · 正在输入…', { name: peer.label }) : peer.label;
      const tw = ctx.measureText(label).width;
      const ly = a.y - 9 < vp.headerH + 2 ? a.y + h + 9 : a.y - 9;
      ctx.fillStyle = 'hsl(' + hue + ' 72% 48%)';
      ctx.fillRect(a.x - 1, ly - 8, tw + 10, 16);
      ctx.fillStyle = '#fff';
      ctx.fillText(label, a.x + 4, ly);
    }
    ctx.restore();
  }

  /** 行号列与列名行。最后画，盖住滚上来的单元格。 */
  _headers(v) {
    const { ctx, vp, model, theme, sel } = this;
    const s = sel.rect;

    ctx.fillStyle = theme.headerBg;
    ctx.fillRect(0, 0, vp.width, vp.headerH);
    ctx.fillRect(0, 0, vp.headerW, vp.height);
    ctx.lineWidth = 1;
    this._setFont(theme.font);

    ctx.save();
    ctx.beginPath();
    ctx.rect(vp.headerW, 0, vp.width - vp.headerW, vp.headerH);
    ctx.clip();
    for (const c of colsToDraw(vp, v)) {
      const box = vp.cellRect(0, c);
      if (!box.w) continue;
      if (box.x > vp.width) break;
      const hot = c >= s.c0 && c <= s.c1;
      if (hot) { ctx.fillStyle = theme.headerHot; ctx.fillRect(box.x, 0, box.w, vp.headerH); }
      ctx.strokeStyle = theme.line;
      ctx.beginPath();
      ctx.moveTo(Math.round(box.x + box.w) - 0.5, 0);
      ctx.lineTo(Math.round(box.x + box.w) - 0.5, vp.headerH);
      ctx.stroke();
      ctx.fillStyle = hot ? theme.accent : theme.textMuted;
      const label = model.colTitle(c);
      const tw = ctx.measureText(label).width;
      if (tw < box.w - 8) ctx.fillText(label, box.x + (box.w - tw) / 2, vp.headerH / 2);
    }
    ctx.restore();

    ctx.save();
    ctx.beginPath();
    ctx.rect(0, vp.headerH, vp.headerW, vp.height - vp.headerH);
    ctx.clip();
    for (const r of rowsToDraw(vp, v)) {
      const box = vp.cellRect(r, 0);
      if (!box.h) continue;
      if (box.y > vp.height) break;
      const hot = r >= s.r0 && r <= s.r1;
      if (hot) { ctx.fillStyle = theme.headerHot; ctx.fillRect(0, box.y, vp.headerW, box.h); }
      ctx.strokeStyle = theme.line;
      ctx.beginPath();
      ctx.moveTo(0, Math.round(box.y + box.h) - 0.5);
      ctx.lineTo(vp.headerW, Math.round(box.y + box.h) - 0.5);
      ctx.stroke();
      ctx.fillStyle = hot ? theme.accent : theme.textMuted;
      const label = String(r + 1);
      const tw = ctx.measureText(label).width;
      ctx.fillText(label, vp.headerW - 6 - tw, box.y + box.h / 2);
    }
    ctx.restore();

    ctx.fillStyle = theme.headerBg;
    ctx.fillRect(0, 0, vp.headerW, vp.headerH);
    // 角上的小三角：点它全选
    ctx.fillStyle = theme.lineStrong;
    ctx.beginPath();
    ctx.moveTo(vp.headerW - 4, vp.headerH - 14);
    ctx.lineTo(vp.headerW - 4, vp.headerH - 4);
    ctx.lineTo(vp.headerW - 14, vp.headerH - 4);
    ctx.closePath();
    ctx.fill();
    ctx.strokeStyle = theme.lineStrong;
    ctx.beginPath();
    ctx.moveTo(0, vp.headerH - 0.5);
    ctx.lineTo(vp.width, vp.headerH - 0.5);
    ctx.moveTo(vp.headerW - 0.5, 0);
    ctx.lineTo(vp.headerW - 0.5, vp.height);
    ctx.stroke();
  }

  /** 冻结分界线与投影，让用户看出这一块不会滚。 */
  _frozenEdges() {
    const { ctx, vp, theme } = this;
    if (vp.frozenCols > 0) {
      const x = vp.headerW + vp.frozenW;
      ctx.strokeStyle = theme.lineStrong;
      ctx.beginPath();
      ctx.moveTo(Math.round(x) - 0.5, vp.headerH);
      ctx.lineTo(Math.round(x) - 0.5, vp.height);
      ctx.stroke();
      if (vp.scrollX > 0) {
        const g = ctx.createLinearGradient(x, 0, x + 6, 0);
        g.addColorStop(0, FROZEN_SHADOW);
        g.addColorStop(1, 'transparent');
        ctx.fillStyle = g;
        ctx.fillRect(x, vp.headerH, 6, vp.height);
      }
    }
    if (vp.frozenRows > 0) {
      const y = vp.headerH + vp.frozenH;
      ctx.strokeStyle = theme.lineStrong;
      ctx.beginPath();
      ctx.moveTo(vp.headerW, Math.round(y) - 0.5);
      ctx.lineTo(vp.width, Math.round(y) - 0.5);
      ctx.stroke();
      if (vp.scrollY > 0) {
        const g = ctx.createLinearGradient(0, y, 0, y + 6);
        g.addColorStop(0, FROZEN_SHADOW);
        g.addColorStop(1, 'transparent');
        ctx.fillStyle = g;
        ctx.fillRect(vp.headerW, y, vp.width, 6);
      }
    }
  }
}

function* colsToDraw(vp, v) {
  for (let c = 0; c < vp.frozenCols; c++) yield c;
  for (let c = v.c0; c <= v.c1; c++) yield c;
}

function* rowsToDraw(vp, v) {
  for (let r = 0; r < vp.frozenRows; r++) yield r;
  for (let r = v.r0; r <= v.r1; r++) yield r;
}

/**
 * 自动换行：先按显式换行切段，再逐字累积到超宽为止（中文没有空格，只能按字切；
 * 英文优先在空格处断）。最多返回 maxLines 行，最后一行放不下补省略号。
 * @param {CanvasRenderingContext2D} ctx @param {string} text @param {number} width @param {number} maxLines
 */
export function wrapLines(ctx, text, width, maxLines) {
  /** @type {string[]} */ const out = [];
  if (width <= 4) return [text.slice(0, 1)];
  for (const para of String(text).split(/\r?\n/)) {
    let line = '';
    let lastSpace = -1;
    for (const ch of para) {
      const next = line + ch;
      if (line && ctx.measureText(next).width > width) {
        if (ch !== ' ' && lastSpace > 0) {
          out.push(line.slice(0, lastSpace));
          line = line.slice(lastSpace + 1) + ch;
        } else {
          out.push(line);
          line = ch === ' ' ? '' : ch;
        }
        lastSpace = -1;
        if (out.length >= maxLines) break;
      } else {
        line = next;
      }
      if (ch === ' ') lastSpace = line.length - 1;
    }
    if (out.length >= maxLines) break;
    out.push(line);
    if (out.length >= maxLines) break;
  }
  if (out.length > maxLines) out.length = maxLines;
  return out;
}

/** 行高自适应用：文本在给定宽度下需要几行。 */
export function measureLines(ctx, text, width) { return wrapLines(ctx, text, width, 200).length; }

/** @param {HTMLElement} el */
function readTheme(el) {
  const cs = getComputedStyle(el);
  const v = (name, fallback) => (cs.getPropertyValue(name) || '').trim() || fallback;
  const family = v('--font-ui', 'system-ui, sans-serif');
  const fs = parseInt(v('--fs-md', '13px'), 10) || 13;
  return {
    bg:         v('--c-surface', '#ffffff'),
    text:       v('--c-text', '#1a1d23'),
    textMuted:  v('--c-text-muted', '#5b6472'),
    line:       v('--c-grid-line', '#e1e4ea'),
    lineStrong: v('--c-border-strong', '#c9ced9'),
    headerBg:   v('--c-grid-header', '#f4f5f7'),
    headerHot:  v('--c-accent-soft', '#e8f0fe'),
    selFill:    v('--c-grid-selected', 'rgba(47,111,235,.1)'),
    accent:     v('--c-accent', '#2f6feb'),
    danger:     v('--c-danger', '#e03131'),
    family,
    fs,
    font:       fs + 'px ' + family,
  };
}

/** 把用户 ID 稳定地映射到一个色相，保证同一个人到哪都是同一个颜色。 */
export function hashHue(id) {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  return h % 360;
}
