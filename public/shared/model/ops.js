/**
 * op 定义 —— 浏览器与 Durable Object 共用的**同一份**校验代码。
 *
 * 这是零构建选型最实在的一处红利：客户端在发送前用它拦掉非法 op，DO 在写库前
 * 用它再拦一次。两边永远不会对"什么是合法 op"产生分歧，因为根本只有一份实现。
 *
 * 一个安全原则：DO 端**永远不信任**客户端发来的任何字段。normalizeOp 不是在
 * "修正格式"，它是在重新构造一个干净的 op —— 输入里多出来的键一律丢弃，
 * 数值一律钳到合法范围，字符串一律截断。非法就返回 null，不做猜测性修补。
 */

import { t as tt } from '../i18n/i18n.js';

/** 上限。都不是拍脑袋：MAX_CELLS 对应 DO SQLite 单实例 1GB 的量级，留了一个数量级余量。 */
export const LIMITS = {
  MAX_ROWS: 200000,
  MAX_COLS: 256,
  MAX_CELL_LEN: 32768,
  MAX_FIELD_NAME: 60,
  MIN_COL_W: 32,
  MAX_COL_W: 1000,
  MIN_ROW_H: 18,
  MAX_ROW_H: 400,
  /** 单条 ops 消息最多携带多少个单元格改动。超过就拆包。 */
  MAX_CELLS_PER_MSG: 20000,
  /** 一张表最多多少个非空单元格。到顶后拒绝写入，而不是让 DO 悄悄撑爆。 */
  MAX_CELLS: 2000000,
};

/**
 * 会改变「行列索引 → 内容」映射关系的 op。
 * 客户端如果基于一个早于最近结构性 op 的 seq 提交，DO 会回 resync 而不是勉强合并 ——
 * 表格里一次错位的合并比一次刷新讨厌得多。
 */
const STRUCTURAL = new Set(['clearAll', 'insertRows', 'deleteRows', 'insertCols', 'deleteCols']);

/** 表属性的键。值是一段受限的 JSON，由 setProp 整体替换。 */
export const PROP_KEYS = new Set([
  'merges', 'freeze', 'cf', 'charts', 'hiddenRows', 'hiddenCols', 'validations', 'gridlines', 'kanban', 'filter', 'notes', 'dashboard', 'files', 'pivots',
  'doc', 'slides',
]);
/** 文档 / 幻灯片的内容是一棵更深的树（页 → 元素 → 文字段 → 样式），放宽嵌套深度。 */
const DEEP_PROPS = new Set(['doc', 'slides']);
/** 单个属性序列化后的上限。WebSocket 单帧 1MB，留足余量。 */
const MAX_PROP_BYTES = 256 * 1024;

/** @param {any} op */
export function isStructural(op) { return STRUCTURAL.has(op?.t); }

/** @param {unknown} v @param {number} lo @param {number} hi @returns {number | null} */
function int(v, lo, hi) {
  if (typeof v !== 'number' || !Number.isFinite(v)) return null;
  const n = Math.round(v);
  return n < lo || n > hi ? null : n;
}

/** 单元格值统一成字符串。P3 的类型化字段会在这之上再解析，但存储层只认文本。 */
function cellValue(v) {
  if (v == null) return '';
  const s = typeof v === 'string' ? v : String(v);
  return s.length > LIMITS.MAX_CELL_LEN ? s.slice(0, LIMITS.MAX_CELL_LEN) : s;
}

/**
 * 把任意输入规范成一个可信 op；不合法返回 null。
 * @param {any} op
 * @returns {any | null}
 */
export function normalizeOp(op) {
  if (!op || typeof op !== 'object') return null;

  switch (op.t) {
    case 'setCell': {
      const r = int(op.r, 0, LIMITS.MAX_ROWS - 1);
      const c = int(op.c, 0, LIMITS.MAX_COLS - 1);
      if (r === null || c === null) return null;
      return { t: 'setCell', r, c, v: cellValue(op.v) };
    }

    case 'setCells': {
      if (!Array.isArray(op.cells)) return null;
      if (op.cells.length > LIMITS.MAX_CELLS_PER_MSG) return null;
      /** @type {[number,number,string][]} */
      const cells = [];
      for (const e of op.cells) {
        if (!Array.isArray(e) || e.length < 2) return null;
        const r = int(e[0], 0, LIMITS.MAX_ROWS - 1);
        const c = int(e[1], 0, LIMITS.MAX_COLS - 1);
        if (r === null || c === null) return null;
        cells.push([r, c, cellValue(e[2])]);
      }
      return cells.length ? { t: 'setCells', cells } : null;
    }

    case 'resizeField': {
      const c = int(op.c, 0, LIMITS.MAX_COLS - 1);
      const w = int(op.w, LIMITS.MIN_COL_W, LIMITS.MAX_COL_W);
      if (c === null) return null;
      // 宽度越界不算错，钳住就行 —— 拖拽时鼠标跑到屏幕外是很正常的事
      return { t: 'resizeField', c, w: w ?? clamp(op.w, LIMITS.MIN_COL_W, LIMITS.MAX_COL_W) };
    }

    case 'renameField': {
      const c = int(op.c, 0, LIMITS.MAX_COLS - 1);
      if (c === null) return null;
      const name = String(op.name ?? '').slice(0, LIMITS.MAX_FIELD_NAME);
      return { t: 'renameField', c, name };
    }

    case 'setRowHeight': {
      const r = int(op.r, 0, LIMITS.MAX_ROWS - 1);
      if (r === null) return null;
      return { t: 'setRowHeight', r, h: clamp(op.h, LIMITS.MIN_ROW_H, LIMITS.MAX_ROW_H) };
    }

    case 'addRows': {
      const n = int(op.n, 1, LIMITS.MAX_ROWS);
      return n === null ? null : { t: 'addRows', n };
    }

    case 'addCols': {
      const n = int(op.n, 1, LIMITS.MAX_COLS);
      return n === null ? null : { t: 'addCols', n };
    }

    case 'setRowCount': {
      const n = int(op.n, 1, LIMITS.MAX_ROWS);
      return n === null ? null : { t: 'setRowCount', n };
    }

    case 'setColCount': {
      const n = int(op.n, 1, LIMITS.MAX_COLS);
      return n === null ? null : { t: 'setColCount', n };
    }

    case 'clearAll':
      return { t: 'clearAll' };

    case 'setFormats': {
      if (!Array.isArray(op.cells)) return null;
      if (op.cells.length > LIMITS.MAX_CELLS_PER_MSG) return null;
      /** @type {[number,number,any][]} */
      const cells = [];
      for (const e of op.cells) {
        if (!Array.isArray(e) || e.length < 2) return null;
        const r = int(e[0], 0, LIMITS.MAX_ROWS - 1);
        const c = int(e[1], 0, LIMITS.MAX_COLS - 1);
        if (r === null || c === null) return null;
        cells.push([r, c, normalizeStyle(e[2])]);
      }
      return cells.length ? { t: 'setFormats', cells } : null;
    }

    case 'setProp': {
      if (!PROP_KEYS.has(op.key)) return null;
      if (op.value == null) return { t: 'setProp', key: op.key, value: null };
      const value = cleanJson(op.value, 0, DEEP_PROPS.has(op.key) ? 10 : 6);
      if (value === undefined) return null;
      if (JSON.stringify(value).length > MAX_PROP_BYTES) return null;
      return { t: 'setProp', key: op.key, value };
    }

    case 'insertRows': case 'deleteRows': {
      const at = int(op.at, 0, LIMITS.MAX_ROWS - 1);
      const n = int(op.n, 1, LIMITS.MAX_ROWS);
      return at === null || n === null ? null : { t: op.t, at, n };
    }

    case 'insertCols': case 'deleteCols': {
      const at = int(op.at, 0, LIMITS.MAX_COLS - 1);
      const n = int(op.n, 1, LIMITS.MAX_COLS);
      return at === null || n === null ? null : { t: op.t, at, n };
    }

    default:
      return null;
  }
}

const RE_COLOR = /^#[0-9a-fA-F]{6}$/;
const RE_FONT = /^[\w\s一-龥,'"-]{1,60}$/;

/**
 * 单元格样式白名单。不认识的键丢弃，值不合法的键丢弃；什么都不剩返回 null（= 清除格式）。
 * @param {any} s @returns {Record<string, any> | null}
 */
export function normalizeStyle(s) {
  if (!s || typeof s !== 'object' || Array.isArray(s)) return null;
  /** @type {Record<string, any>} */ const out = {};
  for (const k of ['b', 'i', 'u', 's', 'wr']) if (s[k] === true) out[k] = true;
  if (typeof s.fs === 'number') { const fs = int(s.fs, 6, 72); if (fs !== null) out.fs = fs; }
  if (typeof s.fc === 'string' && RE_COLOR.test(s.fc)) out.fc = s.fc.toLowerCase();
  if (typeof s.bg === 'string' && RE_COLOR.test(s.bg)) out.bg = s.bg.toLowerCase();
  if (s.ha === 'l' || s.ha === 'c' || s.ha === 'r') out.ha = s.ha;
  if (s.va === 't' || s.va === 'm' || s.va === 'b') out.va = s.va;
  if (typeof s.nf === 'string' && s.nf && s.nf.length <= 100) out.nf = s.nf;
  if (typeof s.ff === 'string' && RE_FONT.test(s.ff)) out.ff = s.ff;
  if (s.bd && typeof s.bd === 'object') {
    /** @type {Record<string, string>} */ const bd = {};
    for (const side of ['t', 'r', 'b', 'l']) {
      const v = s.bd[side];
      if (typeof v === 'string' && RE_COLOR.test(v)) bd[side] = v.toLowerCase();
    }
    if (Object.keys(bd).length) out.bd = bd;
  }
  return Object.keys(out).length ? out : null;
}

/**
 * 受限 JSON：只收普通对象 / 数组 / 有限数字 / 布尔 / 字符串（截断），深度与数量都有上限。
 * 不合法返回 undefined。
 * @param {any} v @param {number} depth @param {number} [max] @returns {any}
 */
function cleanJson(v, depth, max = 6) {
  if (depth > max) return undefined;
  if (v === null) return null;
  switch (typeof v) {
    case 'boolean': return v;
    case 'number': return Number.isFinite(v) ? v : undefined;
    case 'string': return v.length > 2000 ? v.slice(0, 2000) : v;
    case 'object': {
      if (Array.isArray(v)) {
        if (v.length > 50000) return undefined;
        const out = [];
        for (const x of v) { const y = cleanJson(x, depth + 1, max); if (y === undefined) return undefined; out.push(y); }
        return out;
      }
      const proto = Object.getPrototypeOf(v);
      if (proto !== Object.prototype && proto !== null) return undefined;
      const keys = Object.keys(v);
      if (keys.length > 200) return undefined;
      /** @type {Record<string, any>} */ const out = {};
      for (const k of keys) {
        if (k === '__proto__' || k === 'constructor' || k === 'prototype' || k.length > 60) continue;
        const y = cleanJson(v[k], depth + 1, max);
        if (y === undefined) return undefined;
        out[k] = y;
      }
      return out;
    }
    default: return undefined;
  }
}

/** @param {unknown} v @param {number} lo @param {number} hi */
function clamp(v, lo, hi) {
  const n = typeof v === 'number' && Number.isFinite(v) ? Math.round(v) : lo;
  return Math.max(lo, Math.min(hi, n));
}

/**
 * 批量规范化。任意一条非法就整批拒绝 —— 部分应用会让两端状态悄悄分叉，
 * 而分叉在表格里表现为"我看到的和你看到的不一样"，是最难排查的一类 bug。
 * @param {unknown} ops
 * @returns {{ ops: any[] } | { error: string }}
 */
export function normalizeOps(ops) {
  if (!Array.isArray(ops) || ops.length === 0) return { error: tt('ops 为空') };
  if (ops.length > LIMITS.MAX_CELLS_PER_MSG) return { error: tt('ops 过多') };

  /** @type {any[]} */
  const out = [];
  let cells = 0;
  for (const raw of ops) {
    const op = normalizeOp(raw);
    if (!op) return { error: tt('包含非法 op：{op}', { op: String(raw?.t) }) };
    cells += op.t === 'setCells' || op.t === 'setFormats' ? op.cells.length : 1;
    if (cells > LIMITS.MAX_CELLS_PER_MSG) return { error: tt('单条消息携带的单元格过多') };
    out.push(op);
  }
  return { ops: out };
}

/** 把零散的 setCell 合并成一条 setCells，减少 oplog 行数与广播体积。 */
export function coalesce(ops) {
  /** @type {any[]} */
  const out = [];
  /** @type {Map<string, [number,number,string]>} */
  let pending = new Map();

  const flush = () => {
    if (pending.size) { out.push({ t: 'setCells', cells: [...pending.values()] }); pending = new Map(); }
  };

  for (const op of ops) {
    if (op.t === 'setCell') {
      pending.set(op.r + ':' + op.c, [op.r, op.c, op.v]);   // 同一格重复写只留最后一次
    } else if (op.t === 'setCells') {
      for (const [r, c, v] of op.cells) pending.set(r + ':' + c, [r, c, v]);
    } else {
      flush();
      out.push(op);
    }
  }
  flush();
  return out;
}
