/**
 * AxisMap —— 一条轴（行或列）上「显示序号 → 存储键」的映射。
 *
 * 为什么要有它：DO SQLite 按「写了多少行」计费（免费 10 万行/天，全账号共享）。
 * 以前单元格按 (r, c) 存，在第 3 行上面插一行，下面每个格子的主键都要改一遍 ——
 * 实测 1000 个格子要写 2000 行。现在行 / 列各有一个稳定的键，插入删除只改这张映射表，
 * 存成 meta 里的一个 JSON 值，一次写入。
 *
 * 结构：按显示顺序排列的段 [起始键, 长度]，最后一段长度无限（原始的非负键一路往后）。
 * 新表是恒等映射 [[0, ∞)]，所以从旧结构迁移过来时 r / c 原样当键用。
 * 插入分配的新键是负数，从 -1 往下取：一个段内键仍随序号递增，按段做区间查询时顺序天然正确。
 * 删掉的键不再出现在任何段里（indexOf = -1），落在它上面的数据就看不见了。
 */
export class AxisMap {
  /** @param {{ s?: [number, number | null][], n?: number } | null} [data] */
  constructor(data) {
    /** @type {{ k: number, n: number }[]} */
    this.segs = data?.s?.length
      ? data.s.map(([k, n]) => ({ k: Number(k), n: n == null ? Infinity : Number(n) }))
      : [{ k: 0, n: Infinity }];
    /** 下一个可分配的新键（负数，往下走） */
    this.next = Number(data?.n ?? -1);
    this._reindex();
  }

  /** 还是初始的恒等映射：不必存 */
  isIdentity() { return this.segs.length === 1 && this.segs[0].k === 0 && this.next === -1; }

  toJSON() {
    return { s: this.segs.map(({ k, n }) => [k, n === Infinity ? null : n]), n: this.next };
  }

  _reindex() {
    /** 每段的起始序号 */
    this.pos = new Array(this.segs.length);
    let p = 0;
    for (let i = 0; i < this.segs.length; i++) { this.pos[i] = p; p += this.segs[i].n; }
    /** @type {number[] | null} 按起始键排序的段下标，indexOf 用；懒建 */
    this._byKey = null;
  }

  /** 序号 i 落在哪一段 @param {number} i */
  _segAt(i) {
    let lo = 0, hi = this.pos.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (this.pos[mid] <= i) lo = mid; else hi = mid - 1;
    }
    return lo;
  }

  /** @param {number} i */
  keyAt(i) {
    const j = this._segAt(i);
    return this.segs[j].k + (i - this.pos[j]);
  }

  /** 键 → 当前序号；已删除的键返回 -1 @param {number} key */
  indexOf(key) {
    if (!this._byKey) this._byKey = this.segs.map((_, i) => i).sort((a, b) => this.segs[a].k - this.segs[b].k);
    const by = this._byKey;
    let lo = 0, hi = by.length - 1, hit = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (this.segs[by[mid]].k <= key) { hit = mid; lo = mid + 1; } else hi = mid - 1;
    }
    if (hit < 0) return -1;
    const j = by[hit], s = this.segs[j];
    return key < s.k + s.n ? this.pos[j] + (key - s.k) : -1;
  }

  /**
   * 序号 [from, from + count) 对应的键区间，按显示顺序。
   * @param {number} from @param {number} count
   * @returns {[number, number, number][]} [起始键, 结束键（含）, 起始序号]
   */
  ranges(from, count) {
    /** @type {[number, number, number][]} */ const out = [];
    let i = from, left = count, j = this._segAt(from);
    while (left > 0 && j < this.segs.length) {
      const s = this.segs[j], off = i - this.pos[j];
      const take = Math.min(left, s.n - off);
      out.push([s.k + off, s.k + off + take - 1, i]);
      i += take; left -= take; j++;
    }
    return out;
  }

  /** 保证序号 i 处是段的起点，返回那一段的下标 @param {number} i */
  _split(i) {
    const j = this._segAt(i);
    const s = this.segs[j], off = i - this.pos[j];
    if (off === 0) return j;
    this.segs.splice(j, 1, { k: s.k, n: off }, { k: s.k + off, n: s.n - off });
    this._reindex();
    return j + 1;
  }

  /** 首尾相接的相邻段并起来 */
  _merge() {
    /** @type {{ k: number, n: number }[]} */ const out = [];
    for (const s of this.segs) {
      const p = out[out.length - 1];
      if (p && p.n !== Infinity && p.k + p.n === s.k) p.n += s.n;
      else out.push({ ...s });
    }
    this.segs = out;
    this._reindex();
  }

  /** 在序号 at 处插入 n 个新键 @param {number} at @param {number} n */
  insert(at, n) {
    const j = this._split(at);
    const k = this.next - n + 1;
    this.next = k - 1;
    this.segs.splice(j, 0, { k, n });
    this._merge();
    return [k, k + n - 1];
  }

  /**
   * 删掉序号 [at, at + d)，返回被删的键区间 —— 调用方据此删掉存储里的记录。
   * @param {number} at @param {number} d
   * @returns {[number, number][]}
   */
  delete(at, d) {
    const a = this._split(at);
    const b = this._split(at + d);
    const gone = this.segs.splice(a, b - a);
    this._merge();
    return gone.map((s) => [s.k, s.k + s.n - 1]);
  }
}
