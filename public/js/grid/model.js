/**
 * 网格数据模型（P1：纯内存实现）。
 *
 * 这一层的存在只为一件事：**让 P2 能把后端换掉而网格一行不改**。
 * 所有改动都必须经过 apply(ops)，渲染层只读不写。P2 接上 Durable Object 时，
 * 本地 apply 变成"乐观应用 + 发往 DO"，DO 广播回来的走 applyRemote —— 路径已经分好。
 *
 * 单元格稀疏存储：10 万行 × 26 列 = 260 万个格子，全量数组会吃掉几百 MB，
 * 而实际有值的通常只有千分之一。Map + 'r:c' 字符串键在 V8 上足够快。
 */

import { colName } from '../../shared/util/a1.js';
import { structuralSpec, shiftIndex, adjustProps, adjustCellText } from '../../shared/model/sheet.js';
import { LIMITS } from '../../shared/model/ops.js';

const DEFAULT_COL_W = 104;
const DEFAULT_ROW_H = 26;
const MIN_COL_W = 32;
const MAX_COL_W = 1000;

const key = (r, c) => r + ':' + c;

export class GridModel {
  /** @param {{rows?:number, cols?:number}} [opts] */
  constructor(opts = {}) {
    this.rowCount = opts.rows ?? 200;
    /** @type {{id:string, name:string, width:number}[]} */
    this.cols = [];
    for (let c = 0; c < (opts.cols ?? 26); c++) this.cols.push(this._newCol(c));
    /** @type {Map<string,string>} 稀疏值表，键 'row:col' */
    this.cells = new Map();
    /** @type {Map<number,number>} 行高覆盖，缺省走 DEFAULT_ROW_H */
    this.rowHeights = new Map();
    /** @type {Map<string, Record<string, any>>} 单元格样式，键 'row:col' */
    this.formats = new Map();
    /** @type {Record<string, any>} 表属性：合并、冻结、条件格式、图表…… */
    this.props = {};
    /** @type {Set<(ops:any[], meta:{local:boolean})=>void>} */
    this._subs = new Set();
    /** 数据版本号，渲染层用它判断要不要重画。 */
    this.rev = 0;
  }

  /** @param {number} c */
  _newCol(c) { return { id: 'f' + c, name: '', width: DEFAULT_COL_W }; }

  get colCount() { return this.cols.length; }

  /** @param {number} r @param {number} c @returns {string} */
  getCell(r, c) { return this.cells.get(key(r, c)) ?? ''; }

  /** 所有公式格 [行, 列, 原文]（计算层建动态数组溢出索引用）。 @returns {Generator<[number, number, string]>} */
  *formulaCells() {
    for (const [k, v] of this.cells) {
      if (v.charCodeAt(0) !== 61 /* = */ || v.length < 2) continue;
      const i = k.indexOf(':');
      yield [Number(k.slice(0, i)), Number(k.slice(i + 1)), v];
    }
  }

  /** @param {number} c */
  colWidth(c) { return this.cols[c]?.width ?? DEFAULT_COL_W; }

  /** @param {number} c */
  colTitle(c) { return this.cols[c]?.name || colName(c); }

  /** @param {number} r @param {number} c @returns {Record<string, any> | undefined} */
  getFormat(r, c) { return this.formats.get(key(r, c)); }

  /** @param {string} k */
  getProp(k) { return this.props[k]; }

  /** @param {number} r */
  rowHeight(r) { return this.rowHeights.get(r) ?? DEFAULT_ROW_H; }

  get defaultRowHeight() { return DEFAULT_ROW_H; }
  get defaultColWidth() { return DEFAULT_COL_W; }

  /** @param {(ops:any[], meta:{local:boolean})=>void} fn @returns {() => void} */
  subscribe(fn) { this._subs.add(fn); return () => this._subs.delete(fn); }

  /**
   * 应用一批 op，返回可撤销回去的逆 op（P6 的 undo 直接吃这个返回值）。
   * @param {any[]} ops
   * @param {{local?:boolean}} [meta]
   * @returns {any[]}
   */
  apply(ops, meta = {}) {
    if (!ops.length) return [];
    /** @type {any[]} */
    const inverse = [];
    for (const op of ops) {
      const inv = this._applyOne(op);
      if (Array.isArray(inv)) inverse.unshift(...inv);   // 一条 op 的逆可能是几条，保持内部顺序
      else if (inv) inverse.unshift(inv);                // 逆序才能正确回滚
    }
    this._notify(ops, meta.local !== false);
    return inverse;
  }

  /**
   * 通知订阅者。local=true 表示"这是本地用户刚做的事，需要发给服务端"，
   * false 表示"这是服务端或全量载入带来的，不要再发回去"。sync.js 全靠这个标记
   * 区分两者 —— 弄反了就会产生无限回环。
   * @param {any[]} ops @param {boolean} local
   */
  _notify(ops, local) {
    this.rev++;
    const m = { local };
    for (const fn of this._subs) fn(ops, m);
  }

  /** 远端（P2 的 DO 广播）来的改动。与本地同路，只是不再回发。 */
  applyRemote(ops) { return this.apply(ops, { local: false }); }

  /** @param {any} op */
  _applyOne(op) {
    switch (op.t) {
      case 'setCell': {
        const k = key(op.r, op.c);
        const before = this.cells.get(k) ?? '';
        const v = op.v == null ? '' : String(op.v);
        if (v === before) return null;
        if (v === '') this.cells.delete(k); else this.cells.set(k, v);
        this._grow(op.r, op.c);
        return { t: 'setCell', r: op.r, c: op.c, v: before };
      }
      // DO 会把零散的 setCell 合并成一条 setCells 再广播，所以这条路径是常态而非优化
      case 'setCells': {
        /** @type {[number,number,string][]} */
        const before = [];
        for (const [r, c, raw] of op.cells) {
          const k = key(r, c);
          before.push([r, c, this.cells.get(k) ?? '']);
          const v = raw == null ? '' : String(raw);
          if (v === '') this.cells.delete(k); else this.cells.set(k, v);
          this._grow(r, c);
        }
        return { t: 'setCells', cells: before };
      }
      case 'clearAll':
        this.cells.clear();
        this.rowHeights.clear();
        this.formats.clear();
        // 不返回逆 op：整表内容的快照会把 undo 栈撑爆，这一步刻意不可撤销
        return null;
      case 'resizeField': {
        const col = this.cols[op.c];
        if (!col) return null;
        const before = col.width;
        col.width = Math.max(MIN_COL_W, Math.min(MAX_COL_W, Math.round(op.w)));
        return col.width === before ? null : { t: 'resizeField', c: op.c, w: before };
      }
      case 'renameField': {
        const col = this.cols[op.c];
        if (!col) return null;
        const before = col.name;
        col.name = String(op.name ?? '').slice(0, 60);
        return { t: 'renameField', c: op.c, name: before };
      }
      case 'setRowHeight': {
        const before = this.rowHeight(op.r);
        this.rowHeights.set(op.r, Math.max(18, Math.min(400, Math.round(op.h))));
        return { t: 'setRowHeight', r: op.r, h: before };
      }
      case 'addRows':
        this.rowCount += Math.max(0, op.n | 0);
        return { t: 'setRowCount', n: this.rowCount - (op.n | 0) };
      case 'setRowCount':
        this.rowCount = Math.max(1, op.n | 0);
        return null;
      case 'addCols': {
        const from = this.cols.length;
        for (let i = 0; i < (op.n | 0); i++) this.cols.push(this._newCol(from + i));
        return { t: 'setColCount', n: from };
      }
      case 'setColCount':
        this.cols.length = Math.max(1, op.n | 0);
        return null;
      case 'setFormats': {
        /** @type {[number,number,any][]} */
        const before = [];
        for (const [r, c, f] of op.cells) {
          const k = key(r, c);
          before.push([r, c, this.formats.get(k) ?? null]);
          if (f) this.formats.set(k, f); else this.formats.delete(k);
          this._grow(r, c);
        }
        return { t: 'setFormats', cells: before };
      }
      case 'setProp': {
        const before = this.props[op.key] ?? null;
        if (op.value == null) delete this.props[op.key]; else this.props[op.key] = op.value;
        return { t: 'setProp', key: op.key, value: before };
      }
      case 'insertRows': case 'deleteRows': case 'insertCols': case 'deleteCols':
        return this._structural(op);
      default:
        console.warn('未知 op', op.t);
        return null;
    }
  }

  /**
   * 插入 / 删除行列。返回的逆 op 能把删掉的内容、被改成 #REF! 的公式、
   * 被缩小的合并区域等全部恢复 —— 撤销一次删除行应当和没删过一样。
   * @param {any} op
   */
  _structural(op) {
    const spec = /** @type {NonNullable<ReturnType<typeof structuralSpec>>} */ (structuralSpec(op));
    const { axis, at, n } = spec;
    const isRow = axis === 'row';
    const limit = isRow ? LIMITS.MAX_ROWS : LIMITS.MAX_COLS;
    /** @type {[number,number,string][]} */ const lostCells = [];
    /** @type {[number,number,any][]} */ const lostFormats = [];

    /** @type {Map<string,string>} */ const cells = new Map();
    for (const [k, v] of this.cells) {
      const i = k.indexOf(':');
      const r = +k.slice(0, i), c = +k.slice(i + 1);
      const nv = adjustCellText(v, axis, at, n);
      const nr = isRow ? shiftIndex(r, at, n) : r;
      const nc = isRow ? c : shiftIndex(c, at, n);
      if (nr < 0 || nc < 0 || nr >= LIMITS.MAX_ROWS || nc >= LIMITS.MAX_COLS) { lostCells.push([r, c, v]); continue; }
      if (nv !== v) lostCells.push([r, c, v]);          // 撤销时按原坐标写回原公式
      if (nv !== '') cells.set(key(nr, nc), nv);
    }
    this.cells = cells;

    /** @type {Map<string, any>} */ const formats = new Map();
    for (const [k, f] of this.formats) {
      const i = k.indexOf(':');
      const r = +k.slice(0, i), c = +k.slice(i + 1);
      const nr = isRow ? shiftIndex(r, at, n) : r;
      const nc = isRow ? c : shiftIndex(c, at, n);
      if (nr < 0 || nc < 0 || nr >= LIMITS.MAX_ROWS || nc >= LIMITS.MAX_COLS) { lostFormats.push([r, c, f]); continue; }
      formats.set(key(nr, nc), f);
    }
    this.formats = formats;

    /** @type {any[]} */ const inverse = [];
    const propsBefore = this.props;
    const changed = adjustProps(this.props, axis, at, n);
    const nextProps = { ...this.props };
    for (const [k, v] of Object.entries(changed)) { if (v == null) delete nextProps[k]; else nextProps[k] = v; }
    this.props = nextProps;

    if (isRow) {
      /** @type {Map<number,number>} */ const rh = new Map();
      for (const [r, h] of this.rowHeights) {
        const nr = shiftIndex(r, at, n);
        if (nr >= 0) rh.set(nr, h); else if (n < 0) inverse.push({ t: 'setRowHeight', r, h });
      }
      this.rowHeights = rh;
      this.rowCount = Math.max(1, Math.min(limit, this.rowCount + n));
    } else if (n > 0) {
      const add = [];
      for (let i = 0; i < n; i++) add.push(this._newCol(0));
      this.cols.splice(Math.min(at, this.cols.length), 0, ...add);
      if (this.cols.length > limit) this.cols.length = limit;
      this.cols.forEach((col, i) => { col.id = 'f' + i; });
    } else {
      const removed = this.cols.splice(at, -n);
      if (!this.cols.length) this.cols.push(this._newCol(0));
      this.cols.forEach((col, i) => { col.id = 'f' + i; });
      removed.forEach((col, i) => {
        if (col.width !== DEFAULT_COL_W) inverse.push({ t: 'resizeField', c: at + i, w: col.width });
        if (col.name) inverse.push({ t: 'renameField', c: at + i, name: col.name });
      });
    }

    // 逆操作：先把结构还原，再按原坐标写回丢失 / 被改写的内容
    const undoStruct = n > 0
      ? { t: isRow ? 'deleteRows' : 'deleteCols', at, n }
      : { t: isRow ? 'insertRows' : 'insertCols', at, n: -n };
    const out = [undoStruct];
    if (lostCells.length) out.push({ t: 'setCells', cells: lostCells });
    if (lostFormats.length) out.push({ t: 'setFormats', cells: lostFormats });
    for (const k of Object.keys(changed)) out.push({ t: 'setProp', key: k, value: propsBefore[k] ?? null });
    return out.concat(inverse);
  }

  /** 写入可以落在当前边界之外（粘贴一块超出表尾的数据），表跟着长。 */
  _grow(r, c) {
    if (r >= this.rowCount) this.rowCount = r + 1;
    while (c >= this.cols.length) this.cols.push(this._newCol(this.cols.length));
  }

  /**
   * 用服务端的全量快照重建整个模型。resync 与首次打开都走这里。
   * 它是**替换**而不是合并 —— 服务端状态就是唯一真相，本地任何残留都必须丢掉。
   * @param {{rowCount:number, colCount:number, fields:{c:number,name:string,width:number}[],
   *          rowHeights:[number,number][], cells:[number,number,string][]}} snap
   */
  loadSnapshot(snap) {
    this.rowCount = Math.max(1, snap.rowCount | 0);
    this.cols = [];
    for (let c = 0; c < Math.max(1, snap.colCount | 0); c++) this.cols.push(this._newCol(c));
    for (const f of snap.fields ?? []) {
      const col = this.cols[f.c];
      if (!col) continue;
      col.name = f.name || '';
      if (f.width) col.width = Math.max(MIN_COL_W, Math.min(MAX_COL_W, f.width | 0));
    }
    this.rowHeights = new Map(snap.rowHeights ?? []);
    this.cells = new Map();
    for (const [r, c, v] of snap.cells ?? []) if (v !== '') this.cells.set(key(r, c), v);
    this.formats = new Map();
    for (const [r, c, f] of snap.formats ?? []) if (f) this.formats.set(key(r, c), f);
    this.props = { ...(snap.props ?? {}) };
    this._notify([{ t: 'bulk' }], false);
  }

  /**
   * 批量填充（示例数据、粘贴大区域）。绕开逐 op 的逆运算记录，
   * 10 万行生成时那份 inverse 数组本身就会撑爆内存。
   * @param {(r:number, c:number)=>string|undefined} fill
   */
  bulkFill(rows, cols, fill) {
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const v = fill(r, c);
        if (v != null && v !== '') this.cells.set(key(r, c), v);
      }
    }
    if (rows > this.rowCount) this.rowCount = rows;
    while (this.cols.length < cols) this.cols.push(this._newCol(this.cols.length));
    // local:false —— bulk 是"载入"而不是"编辑"，不该被 sync 当成待发送的 op
    this._notify([{ t: 'bulk' }], false);
  }

  /** 清空全表。走 apply 是为了让它作为一条 clearAll op 同步给其他人。 */
  clear() { return this.apply([{ t: 'clearAll' }]); }
}
