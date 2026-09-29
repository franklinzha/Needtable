/**
 * 模型 ↔ 实时通道的桥。GridModel 不知道网络存在，RealtimeConnection 不知道表格存在，
 * 这个文件是唯一同时知道两者的地方。
 *
 * 一条贯穿全文件的设计约束：**发出去的 op 必须是幂等的绝对赋值**。
 * 所以 addRows / addCols 在这里被换算成 setRowCount / setColCount 再上网。
 * 这一条换来三样东西：
 *   · 自己的回声可以直接再应用一遍（用来纠正服务端的实际落序），不会把行数加两次
 *   · 断线时"发了但没收到回声"的批次可以安全重发
 *   · 补增量与全量快照走同一套 apply 路径，不需要两份代码
 *
 * 乐观应用：本地先改、马上可见，再发给 DO。DO 回来的广播里带着我们自己的 batchId，
 * 那既是 ack 也是权威顺序。冲突策略就是单元格级 LWW（见 RD §8），不做 OT/CRDT ——
 * 表格场景下"后写的赢"正是用户的预期。
 */

import { api } from './api.js';
import { RealtimeConnection } from './ws.js';
import { coalesce, isStructural, LIMITS } from '../../shared/model/ops.js';
import { uid } from '../../shared/util/uid.js';
import { t, tr } from '../../shared/i18n/i18n.js';

/** 本地改动的合批窗口。16ms ≈ 一帧：连续敲键与拖拽调宽都会并成一条消息。 */
const BATCH_MS = 16;
/** 光标广播节流。10Hz 足够顺滑，再高只是白白烧 DO 的入站消息额度。 */
const CURSOR_MS = 100;
/** 离线期间最多缓存多少个待发单元格。超过就只能以服务器为准（会明确告知用户）。 */
const OFFLINE_MAX_CELLS = 100000;
/** 由视图自己做三方合并的属性（docview / slides），别人的版本不能被本地待发的那份遮掉。 */
const MERGED_PROPS = new Set(['doc', 'slides']);

/** @typedef {'loading' | 'offline' | 'connecting' | 'syncing' | 'online' | 'readonly'} SyncState */

export class SyncEngine {
  /**
   * @param {string} tableId
   * @param {import('../grid/model.js').GridModel} model
   * @param {{
   *   onPresence?: (users: {id:string,email:string,name?:string,role?:string}[]) => void,
   *   onWelcome?: (you: {id?:string,email?:string,name?:string,role?:string,scope?:string|null}) => void,
   *   onCursor?: (from: string, sel: any, editing: boolean) => void,
   *   onNotice?: (msg: string, kind: 'info'|'error') => void,
   * }} [handlers]
   */
  constructor(tableId, model, handlers = {}) {
    this.tableId = tableId;
    this.model = model;
    this.h = handlers;

    /** 已知的服务端序号。作为 hello 的 lastSeq 与每次提交的 baseSeq。 */
    this.seq = 0;
    /** @type {SyncState} */ this.state = 'loading';
    /** @type {any} */ this.you = null;
    /**
     * viewer 角色。它与连接状态是两件事：断线时状态会变成 offline，但一个只读用户
     * 不该因为断了一下就短暂地能编辑 —— 所以可写性单独记一份，只由 welcome 改写。
     */
    this.readonly = false;
    /** 服务端确认可以收发了（welcome + synced 都到齐）。 */
    this.ready = false;
    /**
     * 连接本身是否已补齐（收到了 synced）。与 ready 分开记：重新同步期间连接可能已经好了，
     * 但在快照落地之前不能发 —— 那时的 baseSeq 还是旧的，回声也会被当成快照前的广播吞掉。
     */
    this._linkUp = false;
    this.destroyed = false;

    /** @type {any[]} 攒着等合批的本地 op */ this._out = [];
    /** @type {any} */ this._timer = null;
    /** @type {Map<string, any[]>} 已发出但还没收到回声的批次 */ this._pending = new Map();
    /** 离线缓存溢出：重连后只能以服务器为准 */ this._overflow = false;
    /** @type {any} */ this._cursorTimer = null;
    /** @type {any} */ this._cursorPending = null;
    /** 自己的结构性批次在途期间，是否插进来过别人的改动 */ this._foreignSinceStructural = false;
    /** @type {any[] | null} 重新同步期间先攒着的广播，快照到了再按 seq 补上 */ this._buffered = null;

    /** @type {RealtimeConnection | null} */ this.conn = null;
    this._unsub = model.subscribe((ops, meta) => { if (meta.local) this._queueLocal(ops); });
  }

  // ── 生命周期 ────────────────────────────────────────────────────────────

  async start() {
    this._setState('loading');
    // ticket 和全量数据互不依赖，并行拉能省掉一整个往返。ticket 有效期 30 秒，
    // 数据再慢也不至于；真过期了 WS 会被拒，走正常的重连逻辑重新申请。
    const ticket = api.post('/api/realtime/ticket', { tableId: this.tableId });
    ticket.catch(() => {});   // 失败由 connect() 处理；这里只防 unhandledrejection
    try {
      await this._loadSnapshot();
    } catch (err) {
      this._setState('offline', t('无法载入表格数据'));
      this.h.onNotice?.(err instanceof Error ? err.message : t('无法载入表格数据'), 'error');
      return;
    }
    if (this.destroyed) return;

    this.conn = new RealtimeConnection(this.tableId, {
      onMessage: (msg) => this._onMessage(msg),
      onState: (s, detail) => {
        if (s === 'online') return;              // 真正的"在线"要等 welcome/synced，这里先不报
        this.ready = false;
        this._linkUp = false;
        this._setState(s === 'connecting' ? 'connecting' : 'offline', detail);
      },
    });
    await this.conn.connect(false, ticket);
  }

  destroy() {
    this.destroyed = true;
    this._unsub();
    clearTimeout(this._timer);
    clearTimeout(this._cursorTimer);
    this.conn?.close();
    this.conn = null;
  }

  /** 全量拉取并重建模型。首次打开与 resync 都走这条路。 */
  async _loadSnapshot() {
    const snap = await api.get('/api/tables/' + encodeURIComponent(this.tableId) + '/data');
    this.model.loadSnapshot(snap);
    this.seq = Number(snap.seq ?? 0);
  }

  // ── 本地改动 ────────────────────────────────────────────────────────────

  /** @param {any[]} ops */
  _queueLocal(ops) {
    if (this.destroyed || this.readonly) return;
    for (const op of ops) {
      const w = this._toWire(op);
      if (w) this._out.push(w);
    }
    if (!this._out.length) return;

    if (this._countCells(this._out) > OFFLINE_MAX_CELLS) {
      // 说清楚代价，而不是让本地和服务端悄悄分叉
      if (!this._overflow) {
        this._overflow = true;
        this.h.onNotice?.(t('离线修改过多，已超出缓存上限；恢复连接后将以服务器数据为准。'), 'error');
      }
      this._out.length = 0;
      return;
    }

    clearTimeout(this._timer);
    this._timer = setTimeout(() => this._flush(), BATCH_MS);
  }

  /**
   * 本地 op → 线上 op。关键动作是把相对量换算成绝对量：
   * 模型此刻的 rowCount/colCount 已经包含了这次改动，直接取即可。
   * @param {any} op @returns {any | null}
   */
  _toWire(op) {
    switch (op.t) {
      case 'addRows':     return { t: 'setRowCount', n: this.model.rowCount };
      case 'addCols':     return { t: 'setColCount', n: this.model.colCount };
      case 'bulk':        return null;   // 载入类改动不回传（demo 数据在联网时本就禁用）
      case 'setCell': case 'setCells': case 'resizeField': case 'renameField':
      case 'setRowHeight': case 'setRowCount': case 'setColCount': case 'clearAll':
      case 'setFormats': case 'setProp':
      case 'insertRows': case 'deleteRows': case 'insertCols': case 'deleteCols':
        return op;
      default:
        console.warn('sync: 不认识的本地 op，未发送', op.t);
        return null;
    }
  }

  _flush() {
    this._timer = null;
    if (!this._out.length) return;
    if (!this.ready) return;                    // 离线：留在 _out 里，重连后再发
    // 自己的插删行列还没等到回声：服务端的 structural_seq 已经前移，此刻带着旧 baseSeq 发出的
    // 任何一批都会被打回 resync，连同用户刚敲的字一起丢掉。先攒着，回声把 seq 推上去后再发。
    for (const ops of this._pending.values()) if (ops.some(isStructural)) return;

    const batches = splitBatches(coalesce(this._out));
    this._out = [];
    for (const ops of batches) this._send(ops);
  }

  /** @param {any[]} ops */
  _send(ops) {
    const batchId = uid();
    this._pending.set(batchId, ops);
    const ok = this.conn?.send({ t: 'ops', batchId, baseSeq: this.seq, ops });
    if (!ok) {
      // 连接在这一瞬间断了。放回队列头部，重连后按原顺序重发。
      this._pending.delete(batchId);
      this._out = ops.concat(this._out);
      this.ready = false;
    }
  }

  // ── 服务端消息 ──────────────────────────────────────────────────────────

  /** @param {any} msg */
  _onMessage(msg) {
    switch (msg?.t) {
      case 'welcome':
        this.you = msg.you;
        this.readonly = msg.you?.role === 'viewer';
        this.h.onWelcome?.(msg.you ?? {});
        this._setState(this.readonly ? 'readonly' : 'syncing');
        this.conn?.send({ t: 'hello', lastSeq: this.seq });
        return;

      case 'synced':
        this.seq = Math.max(this.seq, Number(msg.seq ?? 0));
        this._linkUp = true;
        // 快照还在路上：等它落地后由 _resync 放行，否则会带着旧 baseSeq 发出去
        if (this._resyncing) return;
        this.ready = true;
        this._setState(this.readonly ? 'readonly' : 'online');
        this._resume();
        return;

      case 'ops': {
        // 快照在路上：这期间的广播可能在快照之前、也可能在之后，先攒着，快照到了按 seq 分拣
        if (this._buffered) { this._buffered.push(msg); return; }
        const seq = Number(msg.seq ?? 0);
        // 已经包含在快照里的旧广播（WS 比 HTTP 慢到的那种）—— 再应用一遍，插删行列会被做两次
        if (seq <= this.seq) { this._pending.delete(msg.batchId); return; }
        this.seq = seq;
        this._applyIncoming(msg);
        return;
      }

      case 'resync':
        // hello 之后补不齐时，服务端回的是 resync 而不是 synced —— 这条连接同样已经可用
        this._linkUp = true;
        void this._resync(msg.reason);
        return;

      case 'rejected':
        // 服务端拒绝了这一批。本地已经乐观应用过，必须重新对齐，否则两边永久分叉。
        this._pending.delete(msg.batchId);
        this.h.onNotice?.(msg.msg ? tr(msg.msg) : t('修改未被接受'), 'error');
        void this._resync('rejected');
        return;

      case 'presence':
        this.h.onPresence?.(msg.users ?? []);
        return;

      case 'cursor':
        this.h.onCursor?.(msg.from, msg.sel, msg.editing === true);
        return;

      case 'error':
        this.h.onNotice?.(t('服务端错误：{code}', { code: msg.code ?? 'unknown' }), 'error');
        return;
    }
  }

  /** @param {any} msg */
  _applyIncoming(msg) {
    const mine = msg.batchId != null && this._pending.has(msg.batchId);
    const structural = (msg.ops ?? []).some(isStructural);
    if (mine && structural) {
      // 插入 / 删除行列不是幂等的，回声绝不能再应用一遍。
      // 若在它之前有别人的改动先落了库，本地的应用顺序与服务端不同 —— 只能重拉。
      this._pending.delete(msg.batchId);
      if (this._foreignSinceStructural) void this._resync('structural');
      else this._flush();                       // 等它期间攒下的改动，现在带着新的 baseSeq 发出去
      this._foreignSinceStructural = false;
      return;
    }
    if (!mine && this._hasStructuralInFlight()) this._foreignSinceStructural = true;
    if (!mine && structural && (this._out.length || this._pending.size)) {
      // 别人改了结构，而我还有按旧坐标写的改动没落库：硬合并会写错位置
      void this._resync('structural');
      return;
    }
    if (mine) {
      this._pending.delete(msg.batchId);
      // 我在它之后还有插删行列没落库：本地的坐标已经挪过了，按旧坐标把回声再写一遍会凭空多出
      // 一份（原位置一份、挪过去的一份）。跳过是安全的 —— 这期间若插进过别人的改动，
      // _foreignSinceStructural 已经记下，等那条结构性回声到了会整体重拉。
      if (this._hasStructuralInFlight()) return;
    }
    // 服务端的落序是权威的，回声和别人的改动都照单应用 —— 唯独跳过我自己还有更晚写入在路上的
    // 那些格子：那些写入会在服务端排在这条后面、最终胜出。不跳的话，别人先落库的旧值会盖掉我
    // 刚敲的字，而我自己那条回声到了也不一定会重放（后面还有待确认批次时），两边就此分叉。
    const ops = this._maskOwn(msg.ops ?? [], !mine);
    if (ops.length) this.model.applyRemote(ops);
  }

  /**
   * 去掉被「我还没确认 / 还没发出」的写入覆盖的部分。
   * 例外：别人的文档 / 幻灯片整份内容照样放行 —— 视图要拿它和自己还没落库的那版做三方合并，
   * 藏掉的话两人同一刻保存，后到的那份会把先到的整份盖掉（别人改的段落就此丢失）。
   * @param {any[]} ops @param {boolean} [foreign] 这是别人的改动 @returns {any[]}
   */
  _maskOwn(ops, foreign = false) {
    if (!this._out.length && !this._pending.size) return ops;
    /** @type {Set<string>} */ const mine = new Set();
    for (const batch of this._pending.values()) for (const op of batch) opKeys(op, mine);
    for (const op of this._out) opKeys(op, mine);
    if (!mine.size) return ops;
    /** @type {any[]} */ const out = [];
    for (const op of ops) {
      if (op.t === 'setCells' || op.t === 'setFormats') {
        const p = op.t === 'setCells' ? 'v' : 'f';
        const cells = op.cells.filter((/** @type {any[]} */ e) => !mine.has(p + e[0] + ':' + e[1]));
        if (cells.length) out.push(cells.length === op.cells.length ? op : { t: op.t, cells });
        continue;
      }
      if (foreign && op.t === 'setProp' && MERGED_PROPS.has(op.key)) { out.push(op); continue; }
      const ks = new Set(); opKeys(op, ks);
      if (![...ks].some((k) => mine.has(k))) out.push(op);
    }
    return out;
  }

  /** 我有没有还没落库的插删行列 —— 已发出待确认的，和还在合批窗口 / 离线队列里没发出的都算。 */
  _hasStructuralInFlight() {
    for (const ops of this._pending.values()) if (ops.some(isStructural)) return true;
    return this._out.some(isStructural);
  }

  /** 重连并补齐之后：先补发悬空批次，再发离线期间攒下的改动。 */
  _resume() {
    if (this._overflow) { this._overflow = false; void this._resync('overflow'); return; }

    const stranded = [...this._pending.values()];
    this._pending.clear();
    if (stranded.some((ops) => ops.some(isStructural))) {
      // 结构性批次不幂等，不知道服务端是否已应用就不能重发
      void this._resync('structural');
      return;
    }
    // 这些批次发出去了但没等到回声，无从判断 DO 到底应用没有。
    // 因为线上 op 全是幂等绝对赋值，重发一次的代价上限是"覆盖掉期间别人对同几格的修改"，
    // 比静默丢掉用户的输入要好得多。
    for (const ops of stranded) this._send(ops);
    this._flush();
  }

  /** @param {string} reason */
  async _resync(reason) {
    if (this.destroyed) return;
    // 正在拉的那份快照可能已经不够新：比如拉到一半断线重连，服务端说补不齐（中间断掉的那段
    // 广播谁也没收到）。不能直接忽略，记一笔，这一轮结束后再拉一次。
    if (this._resyncing) { this._resyncAgain = true; return; }
    this._resyncing = true;
    this._resyncAgain = false;
    this.ready = false;
    this._setState('syncing');
    this._out.length = 0;
    this._pending.clear();
    this._buffered = [];
    try {
      await this._loadSnapshot();
      // 快照取走之后才落库的广播，按序补上
      const late = this._buffered.filter((m) => Number(m.seq ?? 0) > this.seq);
      this._buffered = null;
      for (const m of late) { this.seq = Number(m.seq); this.model.applyRemote(m.ops ?? []); }
      // 等快照期间用户照样在编辑：快照把它们从界面上冲掉了，按原顺序重放回去再发出
      if (this._out.length) this.model.applyRemote(this._out.slice());
      // 连接这期间可能断过：没补齐就先攒着，等 synced → _resume 再发
      this.ready = this._linkUp;
      this._setState(this.readonly ? 'readonly' : this.ready ? 'online' : 'connecting');
      this.h.onNotice?.(reason === 'structural'
        ? t('表格结构已变更，已重新载入最新数据。')
        : t('已与服务器重新同步。'), 'info');
      this._flush();
    } catch {
      this._setState('offline', t('重新同步失败'));
    } finally {
      this._buffered = null;
      this._resyncing = false;
    }
    if (this._resyncAgain && !this.destroyed) void this._resync(reason);
  }

  // ── 对外 ────────────────────────────────────────────────────────────────

  /**
   * 广播自己的选区。节流到 10Hz，超出的中间状态直接丢掉（只有最后一个位置有意义）。
   * @param {any} sel @param {boolean} [editing] 正在这个格子里输入
   */
  sendCursor(sel, editing = false) {
    this._cursorPending = sel;
    this._cursorEditing = editing;
    if (this._cursorTimer) return;
    this._cursorTimer = setTimeout(() => {
      this._cursorTimer = null;
      if (this.ready && this._cursorPending) {
        this.conn?.send({ t: 'cursor', sel: this._cursorPending, ...(this._cursorEditing ? { editing: true } : {}) });
      }
      this._cursorPending = null;
    }, CURSOR_MS);
  }

  get canEdit() { return !this.readonly; }

  /** @param {SyncState} s @param {string} [detail] */
  _setState(s, detail) {
    this.state = s;
    this.h.onState?.(s, detail);
  }

  /** @param {any[]} ops */
  _countCells(ops) {
    let n = 0;
    for (const op of ops) n += op.t === 'setCells' || op.t === 'setFormats' ? op.cells.length : 1;
    return n;
  }
}

/**
 * 一条线上 op 会写到哪些「键」。同一个键上后写的赢，_maskOwn 靠它判断冲突。
 * 插删行列、清空不在此列 —— 它们走 resync 那条路。
 * @param {any} op @param {Set<string>} into
 */
function opKeys(op, into) {
  switch (op.t) {
    case 'setCell': into.add('v' + op.r + ':' + op.c); return;
    case 'setCells': for (const e of op.cells) into.add('v' + e[0] + ':' + e[1]); return;
    case 'setFormats': for (const e of op.cells) into.add('f' + e[0] + ':' + e[1]); return;
    case 'resizeField': into.add('w' + op.c); return;
    case 'renameField': into.add('n' + op.c); return;
    case 'setRowHeight': into.add('h' + op.r); return;
    case 'setProp': into.add('p' + op.key); return;
    case 'setRowCount': into.add('R'); return;
    case 'setColCount': into.add('C'); return;
  }
}

/**
 * 按单条消息的单元格上限切分。一次粘贴 20 万格会被切成 10 条消息依次发出 ——
 * DO 那边每条都是独立的一批，中间别人插入的改动按 LWW 处理即可。
 * @param {any[]} ops
 * @returns {any[][]}
 */
function splitBatches(ops) {
  /** @type {any[][]} */ const out = [];
  /** @type {any[]} */ let cur = [];
  let n = 0;

  const push = (op, cost) => {
    if (n + cost > LIMITS.MAX_CELLS_PER_MSG && cur.length) { out.push(cur); cur = []; n = 0; }
    cur.push(op);
    n += cost;
  };

  for (const op of ops) {
    if (op.t !== 'setCells' && op.t !== 'setFormats') { push(op, 1); continue; }
    // 单条 setCells 本身就可能超限，先切成若干段
    for (let i = 0; i < op.cells.length; i += LIMITS.MAX_CELLS_PER_MSG) {
      const slice = op.cells.slice(i, i + LIMITS.MAX_CELLS_PER_MSG);
      push({ t: op.t, cells: slice }, slice.length);
    }
  }
  if (cur.length) out.push(cur);
  return out;
}
