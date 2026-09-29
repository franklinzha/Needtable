/**
 * 够跑起 TableDO 的最小 workerd 替身。
 *
 * 真正被测的是 `worker/do/TableDO.js` 本身 —— 这里只补齐它依赖的四样运行时能力：
 * `ctx.storage.sql`（用 node:sqlite 顶上，它跟 DO SQLite 都是 SQLite，语法一致）、
 * `WebSocketPair`、Hibernation 的 `acceptWebSocket / getWebSockets`、以及能带
 * `webSocket` 字段与 101 状态的 `Response`（node 的 undici 实现会拒绝 101）。
 *
 * 用真 SQLite 而不是假 Map 是有意的：物化表、ON CONFLICT、WITHOUT ROWID、
 * AUTOINCREMENT 的 seq 语义，只要换成手写替身就全部失真，那测的就不再是线上那条路径。
 */

// node:sqlite 目前会打一条 ExperimentalWarning。它跟被测代码无关，滤掉以免淹没测试输出。
process.removeAllListeners('warning');
process.on('warning', (w) => { if (w.name !== 'ExperimentalWarning') console.warn(w.stack ?? w.message); });
const { DatabaseSync } = await import('node:sqlite');

// ── WebSocket 对 ────────────────────────────────────────────────────────────

/**
 * 成对的假 WebSocket。两端直连，send 经过一次 microtask 才送达 ——
 * 保留"消息是异步到的"这个事实，否则测试会掩盖掉真实的时序问题。
 */
export class FakeWebSocket {
  constructor(label) {
    this.label = label;
    /** @type {FakeWebSocket | null} */ this.peer = null;
    this.readyState = 1;                       // OPEN
    /** @type {Map<string, Set<Function>>} */ this._on = new Map();
    /** 对端还没挂上 message 监听时先存着。真实 WebSocket 也不会把 101 之前的帧丢掉。 */
    /** @type {any[]} */ this._inbox = [];
    this._att = null;
    /** 测试断言用：这一端发出去的原始文本 */ this.sent = [];
    /** 这一端的 close 事件是否已经触发。之后到的帧才算丢 —— 关闭前发出的帧照常按序送达。 */
    this._closeFired = false;
  }

  addEventListener(type, fn) {
    if (!this._on.has(type)) this._on.set(type, new Set());
    this._on.get(type).add(fn);
    if (type === 'message' && this._inbox.length) {
      const q = this._inbox.splice(0, this._inbox.length);
      for (const data of q) queueMicrotask(() => this._emit('message', { data }));
    }
  }
  removeEventListener(type, fn) { this._on.get(type)?.delete(fn); }

  send(data) {
    if (this.readyState !== 1) throw new Error('socket 已关闭');
    this.sent.push(data);
    const peer = this.peer;
    if (!peer || peer.readyState !== 1) return;
    queueMicrotask(() => {
      if (peer._closeFired) return;
      if (peer._on.get('message')?.size) peer._emit('message', { data });
      else peer._inbox.push(data);
    });
  }

  close(code = 1000, reason = '') {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this._closeFired = true;
    this._emit('close', { code, reason });
    const peer = this.peer;
    if (peer && peer.readyState !== 3) {
      peer.readyState = 3;
      queueMicrotask(() => { peer._closeFired = true; peer._emit('close', { code, reason }); });
    }
  }

  accept() { /* Hibernation 路径不会调用它；留着是为了在误用时不炸 */ }
  serializeAttachment(v) { this._att = JSON.parse(JSON.stringify(v)); }
  deserializeAttachment() { return this._att; }

  _emit(type, ev) { for (const fn of this._on.get(type) ?? []) fn(ev); }
}

export function makePair() {
  const a = new FakeWebSocket('client');
  const b = new FakeWebSocket('server');
  a.peer = b; b.peer = a;
  return [a, b];
}

// ── Response ────────────────────────────────────────────────────────────────

/** undici 的 Response 不接受 101，也没有 webSocket 字段。 */
export class FakeResponse {
  constructor(body, init = {}) {
    this._body = body;
    this.status = init.status ?? 200;
    this.webSocket = init.webSocket ?? null;
    // headers 可能是普通对象、Headers 实例或别的 FakeResponse 的 headers（withCookie 会拿来重建）
    const src = init.headers ?? {};
    const entries = typeof src[Symbol.iterator] === 'function' ? [...src] : Object.entries(src);
    const h = new Map();
    for (const [k, v] of entries) {
      const key = k.toLowerCase();
      h.set(key, h.has(key) && key === 'set-cookie' ? h.get(key) + ', ' + v : String(v));
    }
    this.headers = {
      get: (k) => h.get(String(k).toLowerCase()) ?? null,
      has: (k) => h.has(String(k).toLowerCase()),
      [Symbol.iterator]: () => h.entries(),
    };
  }
  get body() { return this._body ?? null; }
  get statusText() { return ''; }
  get ok() { return this.status >= 200 && this.status < 300; }
  async text() {
    if (this._body == null) return '';
    if (typeof this._body === 'string') return this._body;
    const reader = this._body.getReader();
    const dec = new TextDecoder();
    let out = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      out += dec.decode(value, { stream: true });
    }
    return out + dec.decode();
  }
  async json() { return JSON.parse(await this.text()); }
  async arrayBuffer() {
    if (this._body == null) return new ArrayBuffer(0);
    if (typeof this._body === 'string') return new TextEncoder().encode(this._body).buffer;
    const reader = this._body.getReader();
    const parts = [];
    let n = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      parts.push(value);
      n += value.length;
    }
    const out = new Uint8Array(n);
    let o = 0;
    for (const v of parts) { out.set(v, o); o += v.length; }
    return out.buffer;
  }
}

// ── SQL ─────────────────────────────────────────────────────────────────────

/**
 * workerd 的 `sql.exec(query, ...binds)` 返回可迭代游标；这里用数组顶上。
 * 游标上的 rowsWritten 用 SQLite 的 total_changes() 前后差近似（线上还会算上索引，这里只算行）。
 */
function makeSql(db) {
  const changes = () => Number(db.prepare('SELECT total_changes() AS n').get().n);
  return {
    exec(query, ...binds) {
      const isSelect = /^\s*(select|with)\b/i.test(query);
      if (isSelect) {
        const rows = db.prepare(query).all(...binds);
        rows.rowsWritten = 0;
        rows.toArray = () => rows;
        return rows;
      }
      const before = changes();
      if (!binds.length) db.exec(query); else db.prepare(query).run(...binds);
      /** @type {any} */ const out = [];
      out.rowsWritten = changes() - before;
      out.toArray = () => out;
      return out;
    },
  };
}

/** `storage.transactionSync(fn)`：抛错就整体回滚 */
function makeTx(db) {
  let depth = 0;
  return (fn) => {
    const name = 'tx' + depth++;
    db.exec('SAVEPOINT ' + name);
    try {
      const r = fn();
      db.exec('RELEASE ' + name);
      return r;
    } catch (err) {
      db.exec('ROLLBACK TO ' + name);
      db.exec('RELEASE ' + name);
      throw err;
    } finally {
      depth--;
    }
  };
}

// ── DurableObjectState ──────────────────────────────────────────────────────

class FakeState {
  /** @param {any} [db] 传入已有的库 = 模拟同一个 DO 被驱逐后重新构造 */
  constructor(db) {
    this.db = db ?? new DatabaseSync(':memory:');
    this.storage = {
      sql: makeSql(this.db),
      transactionSync: makeTx(this.db),
      _alarm: /** @type {number | null} */ (null),
      getAlarm: async function () { return this._alarm; },
      setAlarm: async function (at) { this._alarm = at; },
      deleteAlarm: async function () { this._alarm = null; },
    };
    /** @type {Set<FakeWebSocket>} */ this._sockets = new Set();
    /** @type {Promise<any>[]} */ this.waits = [];
    /** @type {any} */ this.obj = null;         // 构造完成后由 makeDO 回填
  }

  /** 线上这段期间不会投递任何事件；测试里 await h.ready 达到同样效果 */
  blockConcurrencyWhile(fn) { this.ready = Promise.resolve(fn()); return this.ready; }
  waitUntil(p) { this.waits.push(Promise.resolve(p)); }

  acceptWebSocket(ws) {
    this._sockets.add(ws);
    ws.addEventListener('message', (ev) => { void this.obj.webSocketMessage(ws, ev.data); });
    ws.addEventListener('close', () => {
      this._sockets.delete(ws);
      void this.obj.webSocketClose(ws);
    });
  }
  getWebSockets() { return [...this._sockets]; }
}

/** 全局：WebSocketPair / Response。只在测试进程里生效。 */
export function installWorkerGlobals() {
  globalThis.WebSocketPair = function WebSocketPair() {
    const [a, b] = makePair();
    return { 0: a, 1: b };
  };
  globalThis.Response = FakeResponse;
}

/**
 * 造一个挂好的 Durable Object。
 * @param {new (ctx:any, env:any) => any} Klass
 * @param {any} [env]
 * @param {any} [db] 复用另一个 DO 的库（h.ctx.db）= 模拟重启
 */
export function makeDO(Klass, env = {}, db) {
  const ctx = new FakeState(db);
  const obj = new Klass(ctx, env);
  ctx.obj = obj;

  return {
    ctx, obj, env,
    ready: ctx.ready,

    /** 直连一条 WebSocket，返回浏览器那一端。 */
    async connect({ uid, email = uid + '@x.com', role = 'editor', tableId = 't1', nonce, name, scope }) {
      const res = await obj.fetch(new Request('https://do/ws', {
        headers: {
          upgrade: 'websocket',
          'x-user-id': uid,
          'x-user-email': email,
          'x-user-role': role,
          'x-table-id': tableId,
          'x-ticket-nonce': nonce ?? 'n-' + Math.random().toString(36).slice(2),
          ...(name !== undefined ? { 'x-user-name': encodeURIComponent(name) } : {}),
          ...(scope ? { 'x-user-scope': scope } : {}),
        },
      }));
      return res;
    },

    /** 全量快照（浏览器走 HTTP 的那条路）。 */
    async state(tableId = 't1') {
      const res = await obj.fetch(new Request('https://do/state', {
        headers: { 'x-user-id': 'u0', 'x-user-role': 'editor', 'x-table-id': tableId },
      }));
      return res.json();
    },

    /** 让排队的 waitUntil（alarm 排期）跑完，避免测试之间互相串。 */
    async settle() { await Promise.all(ctx.waits.splice(0, ctx.waits.length)); },
  };
}

/** 收集一端收到的所有消息，返回一个可断言的数组。 */
export function collect(ws) {
  /** @type {any[]} */ const got = [];
  ws.addEventListener('message', (ev) => { try { got.push(JSON.parse(ev.data)); } catch { /* 非 JSON 不入列 */ } });
  return got;
}

/** 让 microtask 与到期的定时器都跑完。 */
export function tick(ms = 0) { return new Promise((r) => setTimeout(r, ms)); }
