/**
 * 文档 / 幻灯片里嵌入的「表格元素」：一块区域、一个图表、一个透视表。
 *
 * 数据走跨表引用（ExtRefs → /api/tables/<文档>/ext）：插入时把这块区域登记到 table_refs，
 * 于是能看文档、但看不了源表的人，也能看到这一块（和表格里的 =tbl_xxx!A1:C9 同一套规则）。
 * 公开链接的访客走 /api/public/<令牌>/ext，同样只认登记过的区域。
 *
 * 图表 / 透视表的配置在插入时拍一份快照存在块里（cfg），数据是活的：源表改了，
 * 这边最多半分钟后跟着变。源表里的图表后来被删了、改了，文档里这份不受影响。
 *
 * 嵌入块：{ t:'embed', src:'tbl_…', kind:'range'|'chart'|'pivot', range:'A1:C9', cfg?, fields?, title? }
 */

import { ExtRefs } from '../grid/extrefs.js';
import { ERR, isErr, Ref } from '../../shared/formula/values.js';
import { keyOf, parseRange, tooBig, TABLE_ID_RE } from '../../shared/formula/extref.js';
import { colName } from '../../shared/util/a1.js';
import { chartData, drawChart, readChartTheme } from '../grid/chartdraw.js';
import { pivotTable } from '../views/pivot.js';
import { validPivot } from '../grid/pivotcalc.js';
import { h } from '../ui/dom.js';
import { t as tt } from '../../shared/i18n/i18n.js';

/** 区域嵌入最多画这么多行，再多的只显示提示（文档里放一整张大表没意义）。 */
const MAX_TABLE_ROWS = 200;
const MAX_TABLE_COLS = 30;

/** @param {any} v */
function text(v) {
  if (v == null) return '';
  if (isErr(v)) return String(v);
  if (typeof v === 'number') return Number.isInteger(v) ? String(v) : String(+v.toFixed(8));
  if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE';
  return String(v);
}

/** 块里的区域：区域嵌入用 range，图表 / 透视表用 cfg.range（[r0,c0,r1,c1]）。 @param {any} b */
export function embedRange(b) {
  if (b.kind === 'range') {
    const g = parseRange(String(b.range ?? ''));
    return g && g.r0 != null && g.c0 != null && !tooBig(g) ? keyOf(g) : null;
  }
  const r = b.cfg?.range;
  if (!Array.isArray(r) || r.length !== 4 || !r.every(Number.isInteger)) return null;
  const g = { r0: r[0], c0: r[1], r1: r[2], c1: r[3] };
  return tooBig(g) ? null : keyOf(g);
}

/** 这个嵌入块要登记 / 读取的公式文本（ExtRefs.register 认公式）。 @param {any} b */
export function embedFormula(b) {
  const k = embedRange(b);
  return k && TABLE_ID_RE.test(String(b.src)) ? '=' + b.src + '!' + k : null;
}

/**
 * 把取回来的 Ref 装成 chartData / pivotTable 认的 g。
 * @param {Ref} ref @param {string[]} [fields] 源表的字段名（插入时拍的快照）
 */
function shim(ref, fields = []) {
  const v = (/** @type {number} */ r, /** @type {number} */ c) => {
    if (r < ref.r0 || r > ref.r1 || c < ref.c0 || c > ref.c1) return null;
    return ref.eng.cell(r, c);
  };
  return {
    model: {
      rowCount: ref.r1 + 1,
      colCount: ref.c1 + 1,
      getCell: (/** @type {number} */ r, /** @type {number} */ c) => text(v(r, c)),
      colTitle: (/** @type {number} */ c) => fields[c] || colName(c),
    },
    calc: { value: v, text: (/** @type {number} */ r, /** @type {number} */ c) => text(v(r, c)) },
  };
}

export class EmbedHost {
  /**
   * @param {string} docId 文档 / 幻灯片自己的表编号
   * @param {{ path?: string, onError?: (msg: string) => void }} [opts] path：公开链接的取值接口
   */
  constructor(docId, opts = {}) {
    this.docId = docId;
    /** @type {Set<{ b: any, el: HTMLElement }>} */ this.live = new Set();
    this.ext = new ExtRefs(docId, { onChange: () => this.refresh(), onError: opts.onError }, opts.path);
  }

  /** 把块里的区域登记到服务端（插入时调用；只读的人调了也会被服务端拒绝，所以只在可编辑时调）。 @param {any[]} blocks */
  register(blocks) {
    const fs = blocks.map(embedFormula).filter(Boolean);
    if (fs.length) void this.ext.register(/** @type {string[]} */ (fs));
  }

  /**
   * 渲染一个嵌入块，返回它的内容节点（外框由调用方负责）。数据到了会原地重画。
   * @param {any} b
   */
  mount(b) {
    const el = h('div', { class: 'emb' });
    const rec = { b, el };
    this.live.add(rec);
    this._paint(rec);
    return el;
  }

  /** 从页面上摘掉的块别再重画。 */
  prune() {
    for (const r of this.live) if (!r.el.isConnected) this.live.delete(r);
  }

  refresh() {
    this.prune();
    for (const r of this.live) this._paint(r);
  }

  /** @param {{ b: any, el: HTMLElement }} rec */
  _paint(rec) {
    const { b, el } = rec;
    const key = embedRange(b);
    if (!key || !TABLE_ID_RE.test(String(b.src))) { el.replaceChildren(msg(tt('这个嵌入的区域无效。'))); return; }
    const v = this.ext.get(b.src, key);
    if (v === ERR.LOADING) { if (!el.firstChild) el.replaceChildren(msg(tt('载入中…'))); return; }
    if (!(v instanceof Ref)) {
      el.replaceChildren(msg(isErr(v) && String(v) === '#REF!' ? tt('无法读取：源表已删除，或你没有权限查看这块区域。') : tt('读取失败：{err}', { err: text(v) })));
      return;
    }
    const g = shim(v, b.fields);
    if (b.kind === 'chart') {
      const canvas = /** @type {HTMLCanvasElement} */ (h('canvas', { class: 'emb__canvas' }));
      el.replaceChildren(canvas);
      draw(canvas, b.cfg, g);
    } else if (b.kind === 'pivot') {
      el.replaceChildren(validPivot(b.cfg) ? pivotTable(g, b.cfg) : msg(tt('透视表配置无效。')));
    } else {
      el.replaceChildren(rangeTable(v));
    }
  }

  /** 页面宽度变了：图表按新尺寸重画。 */
  redrawCharts() {
    this.prune();
    for (const r of this.live) if (r.b.kind === 'chart') this._paint(r);
  }

  dispose() {
    this.ext.dispose();
    this.live.clear();
  }
}

/** @param {string} s */
const msg = (s) => h('div', { class: 'emb__msg', text: s });

/** @param {Ref} ref */
function rangeTable(ref) {
  const rows = Math.min(ref.r1 - ref.r0 + 1, MAX_TABLE_ROWS), cols = Math.min(ref.c1 - ref.c0 + 1, MAX_TABLE_COLS);
  const table = h('table', { class: 'emb__table' });
  const head = h('tr', null, h('th', { class: 'emb__corner' }));
  for (let c = 0; c < cols; c++) head.append(h('th', { text: colName(ref.c0 + c) }));
  table.append(h('thead', null, head));
  const body = h('tbody');
  for (let r = 0; r < rows; r++) {
    const tr = h('tr', null, h('th', { text: String(ref.r0 + r + 1) }));
    for (let c = 0; c < cols; c++) {
      const v = ref.eng.cell(ref.r0 + r, ref.c0 + c);
      tr.append(h('td', { class: typeof v === 'number' ? 'emb__num' : null, text: text(v) }));
    }
    body.append(tr);
  }
  table.append(body);
  const more = ref.r1 - ref.r0 + 1 > rows || ref.c1 - ref.c0 + 1 > cols;
  return h('div', { class: 'emb__scroll' }, table, more ? msg(tt('只显示前 {rows} 行、{cols} 列。', { rows, cols })) : null);
}

/** 等画布进了页面、有了尺寸再画。 @param {HTMLCanvasElement} canvas @param {any} chart @param {any} g */
function draw(canvas, chart, g) {
  requestAnimationFrame(() => {
    if (!canvas.isConnected) return;
    const dpr = window.devicePixelRatio || 1;
    const w = Math.max(160, canvas.clientWidth || 480), hh = Math.max(100, canvas.clientHeight || 300);
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(hh * dpr);
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    try { drawChart(ctx, w, hh, chart, chartData(g, chart), readChartTheme(canvas)); } catch (err) { console.warn('embed chart', err); }
  });
}

// ── 插入对话框 ────────────────────────────────────────────────────────────────

/**
 * 选一张表、再选区域 / 图表 / 透视表。返回嵌入块的数据（不含 id），取消返回 null。
 * @param {{ id: string, name: string, icon?: string, kind: string }[]} tables 同一内容里可选的表
 * @returns {Promise<any | null>}
 */
export async function pickEmbed(tables) {
  const { openDialog } = await import('../ui/dialog.js');
  const { api } = await import('../core/api.js');
  const { select, field } = await import('../ui/dom.js');
  const list = tables.filter((t) => t.kind === 'grid' || t.kind === 'sheet');
  if (!list.length) {
    const { alertDialog } = await import('../ui/dialog.js');
    await alertDialog(tt('插入表格内容'), tt('这个内容里还没有表格。先新建一张表，再回来插入它的区域、图表或透视表。'));
    return null;
  }
  return new Promise((resolve) => {
    let done = false;
    const finish = (/** @type {any} */ v) => { if (!done) { done = true; resolve(v); } };
    const tableSel = select(list.map((t) => [t.id, (t.icon || '📄') + ' ' + t.name]), list[0].id);
    const kindSel = select([['range', tt('单元格区域')], ['chart', tt('图表')], ['pivot', tt('透视表')]], 'range');
    const rangeIn = h('input', { class: 'ui-input', value: 'A1:D10', placeholder: tt('例如 A1:D10') });
    const itemSel = select([], '');
    const hint = h('p', { class: 'ui-field__hint' });
    const rangeRow = field(tt('区域'), rangeIn, tt('最多 5 万个单元格；文档里最多显示前 200 行。'));
    const itemRow = field(tt('选择'), itemSel);
    /** @type {any} */ let snap = null;
    let loading = 0;

    const sync = () => {
      const kind = kindSel.value;
      rangeRow.hidden = kind !== 'range';
      itemRow.hidden = kind === 'range';
      if (kind === 'range') { hint.textContent = ''; return; }
      if (!snap) { itemSel.replaceChildren(); hint.textContent = tt('正在读取表格…'); return; }
      const items = kind === 'chart' ? (snap.props?.charts ?? []) : (snap.props?.pivots ?? []);
      itemSel.replaceChildren(...items.map((/** @type {any} */ x, /** @type {number} */ i) =>
        h('option', { value: String(i), text: x.title || x.name || (kind === 'chart' ? tt('图表 {n}', { n: i + 1 }) : tt('透视表 {n}', { n: i + 1 })) })));
      hint.textContent = items.length ? '' : (kind === 'chart' ? tt('这张表里还没有图表。') : tt('这张表里还没有透视表。'));
    };
    const load = async () => {
      const my = ++loading;
      snap = null;
      sync();
      try {
        const s = await api.get('/api/tables/' + encodeURIComponent(tableSel.value) + '/data');
        if (my === loading) { snap = s; sync(); }
      } catch (e) {
        if (my === loading) hint.textContent = tt('读取失败：{err}', { err: (/** @type {Error} */ (e).message || tt('网络错误')) });
      }
    };
    tableSel.addEventListener('change', () => void load());
    kindSel.addEventListener('change', sync);
    void load();

    openDialog({
      title: tt('插入表格内容'),
      width: 460,
      body: [field(tt('表格'), tableSel), field(tt('内容'), kindSel), rangeRow, itemRow, hint,
        h('p', { class: 'ui-field__hint', text: tt('插入的是活数据：源表改了，这里会跟着更新。能看这份文档的人都能看到这块内容。') })],
      onClose: () => finish(null),
      buttons: [
        { label: tt('取消') },
        {
          label: tt('插入'), primary: true,
          action: () => {
            const src = tableSel.value;
            const t = list.find((x) => x.id === src);
            const fields = snap ? fieldNames(snap) : [];
            if (kindSel.value === 'range') {
              const g = parseRange(rangeIn.value.trim().toUpperCase());
              if (!g || g.r0 == null || g.c0 == null) { hint.textContent = tt('区域格式不对，例如 A1:D10。'); return false; }
              if (tooBig(g)) { hint.textContent = tt('区域太大了，最多 5 万个单元格。'); return false; }
              finish({ t: 'embed', src, kind: 'range', range: keyOf(g), title: (t?.name ?? '') + ' · ' + keyOf(g) });
              return;
            }
            if (!snap) { hint.textContent = tt('表格还没读完，请稍候。'); return false; }
            const kind = kindSel.value;
            const items = kind === 'chart' ? (snap.props?.charts ?? []) : (snap.props?.pivots ?? []);
            const cfg = items[Number(itemSel.value)];
            if (!cfg) { hint.textContent = kind === 'chart' ? tt('请先选择一个图表。') : tt('请先选择一个透视表。'); return false; }
            const b = { t: 'embed', src, kind, cfg: strip(cfg), fields, title: cfg.title || cfg.name || (t?.name ?? '') };
            if (!embedRange(b)) { hint.textContent = tt('它的数据区域太大（超过 5 万个单元格），没法嵌入。'); return false; }
            finish(b);
          },
        },
      ],
    });
  });
}

/** 快照里的字段名：按列号排好。 @param {any} snap */
function fieldNames(snap) {
  /** @type {string[]} */ const out = [];
  for (const f of snap.fields ?? []) if (Number.isInteger(f.c) && f.c < 200 && f.name) out[f.c] = String(f.name).slice(0, 60);
  return Array.from(out, (x) => x ?? '');
}

/** 图表 / 透视表配置里跟位置有关、文档里用不上的字段去掉。 @param {any} cfg */
function strip(cfg) {
  const { x, y, w, h: _h, ...rest } = cfg;
  return JSON.parse(JSON.stringify(rest));
}
