/**
 * 选区：一个锚点 + 一个焦点定义矩形，另有一个**独立的活动单元格**在矩形内游走。
 *
 * 第三个字段是必须的，不是冗余。Excel 里选中一块区域后连按 Tab，高亮框在区域内
 * 逐格移动而区域本身纹丝不动 —— 如果活动单元格就是锚点，每按一次 Tab 矩形都会跟着缩，
 * 三下之后选区就没了。这个坑只有写到 Tab 循环时才会露出来。
 *
 * 只保留单矩形（不做 Ctrl 多重选区）—— 它在表格协作里用得极少，
 * 却会让渲染、剪贴板、公式引用三处同时变复杂。真需要时再加。
 */

export class Selection {
  constructor() {
    this.anchor = { r: 0, c: 0 };
    this.focus = { r: 0, c: 0 };
    this.cursor = { r: 0, c: 0 };
    /** 整行/整列选中，供表头高亮与"删除整行"之类的操作判断。 */
    this.mode = /** @type {'cell'|'row'|'col'} */ ('cell');
  }

  /** 活动单元格：输入、编辑、公式引用都落在它身上。 */
  get active() { return this.cursor; }

  /** 规范化矩形，闭区间。 */
  get rect() {
    return {
      r0: Math.min(this.anchor.r, this.focus.r), r1: Math.max(this.anchor.r, this.focus.r),
      c0: Math.min(this.anchor.c, this.focus.c), c1: Math.max(this.anchor.c, this.focus.c),
    };
  }

  get isSingle() { return this.anchor.r === this.focus.r && this.anchor.c === this.focus.c; }

  /** @param {number} r @param {number} c */
  set(r, c, mode = 'cell') {
    this.anchor = { r, c };
    this.focus = { r, c };
    this.cursor = { r, c };
    this.mode = /** @type {any} */ (mode);
  }

  /** 扩展焦点（Shift+点击 / Shift+方向键）。活动单元格留在锚点，与 Excel 一致。 */
  extendTo(r, c) {
    this.focus = { r, c };
    this.cursor = { ...this.anchor };
  }

  /** @param {number} r @param {number} c */
  contains(r, c) {
    const s = this.rect;
    return r >= s.r0 && r <= s.r1 && c >= s.c0 && c <= s.c1;
  }

  /**
   * 方向键移动。extend=true 时只动焦点（Shift+方向），否则整个选区塌成一格。
   * @param {number} dr @param {number} dc
   * @param {{rows:number, cols:number}} bounds
   */
  move(dr, dc, bounds, extend = false) {
    const from = extend ? this.focus : this.cursor;
    const r = clamp(from.r + dr, 0, bounds.rows - 1);
    const c = clamp(from.c + dc, 0, bounds.cols - 1);
    if (extend) { this.focus = { r, c }; }
    else this.set(r, c);
  }

  /**
   * Tab / Enter：活动单元格在选区内循环，选区本身不变。单格选区时退化为普通移动。
   * @param {1|-1} dir @param {'row'|'col'} axis
   * @param {{rows:number, cols:number}} bounds
   */
  advance(dir, axis, bounds) {
    if (this.isSingle) {
      this.move(axis === 'row' ? dir : 0, axis === 'col' ? dir : 0, bounds);
      return;
    }
    const s = this.rect;
    let { r, c } = this.cursor;
    if (axis === 'col') {
      c += dir;
      if (c > s.c1) { c = s.c0; r++; }
      else if (c < s.c0) { c = s.c1; r--; }
      if (r > s.r1) r = s.r0;
      if (r < s.r0) r = s.r1;
    } else {
      r += dir;
      if (r > s.r1) { r = s.r0; c++; }
      else if (r < s.r0) { r = s.r1; c--; }
      if (c > s.c1) c = s.c0;
      if (c < s.c0) c = s.c1;
    }
    this.cursor = { r, c };
  }
}

function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }
