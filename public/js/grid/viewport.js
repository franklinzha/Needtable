/**
 * 虚拟视口：把「像素」和「行列序号」互相换算。
 *
 * 10 万行不能各存一个偏移量 —— 那是 800KB 的数组，而且每改一次行高就要全量重算。
 * 这里只存**被改过**的那几行/几列（通常个位数），其余按默认尺寸算：
 *
 *     offsetOf(i) = i * default + Σ(被改过的、序号 < i 的那些的增量)
 *
 * 右边那个 Σ 用一个「排序过的覆盖索引 + 前缀和」做二分，O(log k)，k 是覆盖数量。
 * 反查 indexAt(px) 再在外面套一层二分，O(log n · log k)。10 万行下是 17×3 次比较。
 */

export class Axis {
  /** @param {number} count @param {number} defaultSize */
  constructor(count, defaultSize) {
    this.count = count;
    this.default = defaultSize;
    /** @type {Map<number, number>} */
    this.overrides = new Map();
    /** @type {number[]} */ this._idx = [];
    /** @type {number[]} */ this._pre = [];   // _pre[k] = 前 k 个覆盖的增量之和
    this._dirty = false;
    this._extra = 0;
  }

  /** @param {number} count */
  setCount(count) { this.count = Math.max(0, count); }

  /** @param {number} i @param {number} size */
  setSize(i, size) {
    if (size === this.default) this.overrides.delete(i);
    else this.overrides.set(i, size);
    this._dirty = true;
  }

  /** @param {number} i */
  sizeOf(i) { return this.overrides.get(i) ?? this.default; }

  _rebuild() {
    this._idx = [...this.overrides.keys()].sort((a, b) => a - b);
    this._pre = new Array(this._idx.length + 1);
    this._pre[0] = 0;
    for (let k = 0; k < this._idx.length; k++) {
      this._pre[k + 1] = this._pre[k] + (this.overrides.get(this._idx[k]) - this.default);
    }
    this._extra = this._pre[this._idx.length];
    this._dirty = false;
  }

  /** 序号 < i 的所有覆盖带来的增量之和。 @param {number} i */
  _extraBefore(i) {
    if (this._dirty) this._rebuild();
    const idx = this._idx;
    if (idx.length === 0 || i <= idx[0]) return 0;
    let lo = 0, hi = idx.length;                 // 找第一个 >= i 的位置
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (idx[mid] < i) lo = mid + 1; else hi = mid;
    }
    return this._pre[lo];
  }

  /** 第 i 行/列的起始像素。 @param {number} i */
  offsetOf(i) { return i * this.default + this._extraBefore(i); }

  total() {
    if (this._dirty) this._rebuild();
    return this.count * this.default + this._extra;
  }

  /** 像素 → 序号（落在哪一格）。结果夹在 [0, count-1]。 @param {number} px */
  indexAt(px) {
    if (this.count === 0) return 0;
    if (px <= 0) return 0;
    if (px >= this.total()) return this.count - 1;
    let lo = 0, hi = this.count - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (this.offsetOf(mid) <= px) lo = mid; else hi = mid - 1;
    }
    return lo;
  }

  /**
   * 覆盖 [from, from+extent) 这段像素的序号区间，闭区间。
   * @param {number} from @param {number} extent
   */
  rangeAt(from, extent) {
    const first = this.indexAt(from);
    const last = this.indexAt(from + Math.max(0, extent));
    return { first, last: Math.min(this.count - 1, last) };
  }
}

/**
 * 整个网格的几何。行列两根轴 + 表头尺寸 + 冻结区。
 */
export class Viewport {
  /** @param {import('./model.js').GridModel} model */
  constructor(model) {
    this.model = model;
    this.rows = new Axis(model.rowCount, model.defaultRowHeight);
    this.cols = new Axis(model.colCount, model.defaultColWidth);
    for (const [r, h] of model.rowHeights) this.rows.setSize(r, h);
    model.cols.forEach((col, c) => this.cols.setSize(c, col.width));

    /** @type {(() => Set<number> | null) | null} 被筛选隐藏的行（由 grid 接到 calc 上） */
    this.hiddenRowsFn = null;
    this.headerW = 48;
    this.headerH = 26;
    this.frozenRows = 0;
    this.frozenCols = 0;

    this.scrollX = 0;
    this.scrollY = 0;
    this.width = 0;      // 画布 CSS 像素尺寸
    this.height = 0;
  }

  /**
   * 模型变化后重新同步尺寸与冻结区。
   * 覆盖表整张重建：行高 / 列宽 / 隐藏行列 / 被筛选掉的行都在这里折算成「尺寸」，
   * 隐藏就是尺寸为 0 —— 命中测试、滚动、绘制全部自动跳过，不需要各处单独判断。
   */
  sync() {
    const m = this.model;
    this.rows.setCount(m.rowCount);
    this.cols.setCount(m.colCount);
    this.rows.default = m.defaultRowHeight;
    this.rows.overrides.clear();
    this.cols.overrides.clear();
    for (const [r, h] of m.rowHeights) this.rows.setSize(r, h);
    m.cols.forEach((col, c) => this.cols.setSize(c, col.width));
    const hr = m.props.hiddenRows, hc = m.props.hiddenCols;
    if (Array.isArray(hr)) for (const r of hr) if (r < m.rowCount) this.rows.overrides.set(r, 0);
    if (Array.isArray(hc)) for (const c of hc) if (c < m.colCount) this.cols.overrides.set(c, 0);
    const filtered = this.hiddenRowsFn?.();
    if (filtered) for (const r of filtered) this.rows.overrides.set(r, 0);
    this.rows._dirty = true;
    this.cols._dirty = true;
    const fz = m.props.freeze;
    this.frozenRows = Math.max(0, Math.min(m.rowCount - 1, fz?.r | 0));
    this.frozenCols = Math.max(0, Math.min(m.colCount - 1, fz?.c | 0));
  }

  /** 行 / 列是否被隐藏（尺寸为 0）。 */
  rowHidden(r) { return this.rows.sizeOf(r) === 0; }
  colHidden(c) { return this.cols.sizeOf(c) === 0; }

  /** 表头之外、真正画数据的区域宽高。 */
  get bodyW() { return Math.max(0, this.width - this.headerW); }
  get bodyH() { return Math.max(0, this.height - this.headerH); }

  /** 冻结区占掉的像素（冻结的行列不参与滚动）。 */
  get frozenW() { return this.cols.offsetOf(this.frozenCols); }
  get frozenH() { return this.rows.offsetOf(this.frozenRows); }

  /** 可滚动部分（冻结区之后）当前应该画哪些行列。 */
  visible() {
    const cTop = this.frozenCols;
    const rTop = this.frozenRows;
    const cStart = Math.max(cTop, this.cols.indexAt(this.frozenW + this.scrollX));
    const rStart = Math.max(rTop, this.rows.indexAt(this.frozenH + this.scrollY));
    const cEnd = this.cols.indexAt(this.frozenW + this.scrollX + (this.bodyW - this.frozenW));
    const rEnd = this.rows.indexAt(this.frozenH + this.scrollY + (this.bodyH - this.frozenH));
    return {
      r0: rStart, r1: Math.min(this.rows.count - 1, rEnd + 1),
      c0: cStart, c1: Math.min(this.cols.count - 1, cEnd + 1),
    };
  }

  /** 单元格左上角在画布上的屏幕坐标（未考虑裁剪）。 @param {number} r @param {number} c */
  cellRect(r, c) {
    const frozenC = c < this.frozenCols;
    const frozenR = r < this.frozenRows;
    return {
      x: this.headerW + this.cols.offsetOf(c) - (frozenC ? 0 : this.scrollX),
      y: this.headerH + this.rows.offsetOf(r) - (frozenR ? 0 : this.scrollY),
      w: this.cols.sizeOf(c),
      h: this.rows.sizeOf(r),
    };
  }

  /**
   * 画布上的屏幕坐标 → 行列。落在表头上时对应序号为 -1。
   * @param {number} x @param {number} y
   */
  hit(x, y) {
    const inColHeader = y < this.headerH;
    const inRowHeader = x < this.headerW;
    const cx = x - this.headerW;
    const cy = y - this.headerH;
    const col = inRowHeader ? -1
      : this.cols.indexAt(cx < this.frozenW ? cx : cx + this.scrollX);
    const row = inColHeader ? -1
      : this.rows.indexAt(cy < this.frozenH ? cy : cy + this.scrollY);
    return { row, col, inColHeader, inRowHeader };
  }

  /** 把某个单元格滚进可视区，返回是否发生了滚动。 @param {number} r @param {number} c */
  scrollIntoView(r, c) {
    const before = this.scrollX + ':' + this.scrollY;
    const x0 = this.cols.offsetOf(c);
    const x1 = x0 + this.cols.sizeOf(c);
    const y0 = this.rows.offsetOf(r);
    const y1 = y0 + this.rows.sizeOf(r);

    if (c >= this.frozenCols) {
      const viewL = this.scrollX + this.frozenW;
      const viewR = this.scrollX + this.bodyW;
      if (x0 < viewL) this.scrollX = x0 - this.frozenW;
      else if (x1 > viewR) this.scrollX = x1 - this.bodyW;
    }
    if (r >= this.frozenRows) {
      const viewT = this.scrollY + this.frozenH;
      const viewB = this.scrollY + this.bodyH;
      if (y0 < viewT) this.scrollY = y0 - this.frozenH;
      else if (y1 > viewB) this.scrollY = y1 - this.bodyH;
    }
    this.scrollX = Math.max(0, Math.min(this.scrollX, this.maxScrollX));
    this.scrollY = Math.max(0, Math.min(this.scrollY, this.maxScrollY));
    return before !== this.scrollX + ':' + this.scrollY;
  }

  get maxScrollX() { return Math.max(0, this.cols.total() - this.bodyW); }
  get maxScrollY() { return Math.max(0, this.rows.total() - this.bodyH); }
}
