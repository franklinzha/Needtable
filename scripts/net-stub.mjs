/**
 * 浏览器网络侧的替身：`fetch` / `WebSocket` / `location` / `window` / `document`。
 *
 * 它不是一个假服务器 —— 它把浏览器那一端直接接到**真的 TableDO** 上（见 do-stub.mjs）。
 * 于是 sync.test.mjs 测的是一整条真实链路：
 *
 *   SyncEngine → ws.js → [假 socket] → TableDO.webSocketMessage → 真 SQLite → 广播回来
 *
 * 这么做的理由：P2 最容易出错的地方全在两端的**配合**上（回声当 ack、baseSeq 对不上、
 * 补增量的边界）。任何一端换成手写的假实现，这些配合就测不到了。
 */

import { tick } from './do-stub.mjs';

export class FakeNet {
  /** @param {ReturnType<import('./do-stub.mjs').makeDO>} harness */
  constructor(harness, session = {}) {
    this.h = harness;
    this.session = { uid: 'u1', email: 'u1@x.com', role: 'editor', tableId: 't1', ...session };
    /** 置 true 后 ticket 与快照请求都会失败，等同于拔网线 */
    this.offline = false;
    /** @type {Map<string, any>} 已发出但还没用掉的 ticket */ this.tickets = new Map();
    this._ticketN = 0;
    /** @type {WebSocketStub[]} 浏览器这一侧建过的所有连接 */ this.sockets = [];
    this.reloaded = 0;
    /** 断网期间被拒绝的 ticket 请求次数，用来断言退避确实在重试 */ this.ticketFails = 0;
    /**
     * 可选的网络延迟（毫秒）。设了之后：快照在请求那一刻取、晚些才交付；WS 帧逐条延迟但
     * 保持单条连接内的顺序。于是「WS 广播抢在 HTTP 快照前面到」这类线上时序能被复现。
     * @type {null | (() => number)}
     */
    this.lag = null;
  }

  /** 等一段随机延迟（没设 lag 就不等）。 */
  _wait() { const ms = this.lag?.() ?? 0; return ms > 0 ? new Promise((r) => setTimeout(r, ms)) : null; }

  /** 拔网线：断掉现有连接，后续的连接尝试也一律失败。 */
  cut() {
    this.offline = true;
    for (const s of this.sockets) if (s.readyState === 1) s._serverClose(1006);
  }

  /** 插回网线。调用方通常紧接着 `conn.connect(true)` 来跳过退避。 */
  restore() { this.offline = false; }

  // ── fetch ──────────────────────────────────────────────────────────────

  /** @param {string} path @param {any} init */
  async fetch(path, init = {}) {
    if (this.offline) {
      if (path === '/api/realtime/ticket') this.ticketFails++;
      throw new TypeError('Failed to fetch');
    }

    if (path === '/api/realtime/ticket') {
      this.ticketRequests = (this.ticketRequests ?? 0) + 1;
      // 模拟权限被收回：服务端对 ticket 请求回 403 / 404
      if (this.ticketStatus) return new NetResponse('{"error":{"code":"not_found","message":"表不存在"}}', { status: this.ticketStatus });
      const ticket = 'tk' + (++this._ticketN);
      this.tickets.set(ticket, { ...this.session });
      return jsonRes({ ticket, expiresIn: 30 });
    }

    if (path === '/api/tables/' + encodeURIComponent(this.session.tableId) + '/data') {
      const snap = await this.h.state(this.session.tableId);
      await this._wait();
      return jsonRes(snap);
    }

    return new NetResponse('{"error":{"code":"not_found","message":"no route"}}', { status: 404 });
  }

  // ── WebSocket ──────────────────────────────────────────────────────────

  /** @param {string} url @returns {Promise<any | null>} DO 那一侧返回的浏览器端 socket */
  async open(url) {
    if (this.offline) return null;
    const ticket = new URL(url).searchParams.get('ticket') ?? '';
    const sess = this.tickets.get(ticket);
    if (!sess) return null;                       // ticket 是一次性的
    this.tickets.delete(ticket);
    const res = await this.h.connect({ ...sess, nonce: ticket });
    return res.status === 101 ? res.webSocket : null;
  }
}

/** 浏览器 WebSocket 的最小实现。连接是异步建立的，这一点必须保真。 */
class WebSocketStub {
  /** @param {FakeNet} net @param {string} url */
  constructor(net, url) {
    this.net = net;
    this.url = url;
    this.readyState = 0;                          // CONNECTING
    /** @type {Map<string, Set<Function>>} */ this._on = new Map();
    /** @type {any} */ this._ep = null;
    net.sockets.push(this);

    queueMicrotask(async () => {
      const ep = await net.open(url);
      if (this.readyState === 3) { ep?.close(1000, 'aborted'); return; }
      if (!ep) { this.readyState = 3; this._emit('close', { code: 1006, reason: 'refused' }); return; }
      this._ep = ep;
      ep.addEventListener('message', (ev) => this._later(() => { if (this.readyState === 1) this._emit('message', { data: ev.data }); }));
      ep.addEventListener('close', (ev) => this._later(() => {
        if (this.readyState === 3) return;
        this.readyState = 3;
        this._emit('close', { code: ev.code ?? 1006, reason: ev.reason ?? '' });
      }));
      this.readyState = 1;
      this._emit('open', {});
    });
  }

  addEventListener(type, fn) {
    if (!this._on.has(type)) this._on.set(type, new Set());
    this._on.get(type).add(fn);
  }
  removeEventListener(type, fn) { this._on.get(type)?.delete(fn); }

  send(data) {
    if (this.readyState !== 1) throw new Error('socket 未打开');
    if (!this.net.lag) { this._ep.send(data); return; }
    this._outQ = (this._outQ ?? Promise.resolve()).then(() => this.net._wait()).then(() => {
      if (this._ep.readyState === 1) this._ep.send(data);
    });
  }

  /** 入站事件：没有延迟就同步派发（保持原有测试的时序），有延迟就排队、按序交付。 */
  _later(fn) {
    if (!this.net.lag) { fn(); return; }
    this._inQ = (this._inQ ?? Promise.resolve()).then(() => this.net._wait()).then(fn);
  }

  close(code = 1000, reason = '') {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this._ep?.close(code, reason);
    this._emit('close', { code, reason });
  }

  /** 测试用：模拟服务端/网络单方面断开，本端不主动 close。 */
  _serverClose(code = 1006) {
    if (this.readyState === 3) return;
    this._ep?.close(code, 'network');
  }

  _emit(type, ev) { for (const fn of this._on.get(type) ?? []) fn(ev); }
}

class NetResponse {
  constructor(body, init = {}) { this._b = body; this.status = init.status ?? 200; }
  get ok() { return this.status >= 200 && this.status < 300; }
  async text() { return this._b; }
}

function jsonRes(obj) { return new NetResponse(JSON.stringify(obj), { status: 200 }); }

/**
 * 装上浏览器全局。返回 net，测试用它拔网线、看 ticket 用了几张。
 * @param {ReturnType<import('./do-stub.mjs').makeDO>} harness
 */
export function installNet(harness, session) {
  const net = new FakeNet(harness, session);

  globalThis.fetch = (path, init) => net.fetch(String(path), init);
  globalThis.WebSocket = /** @type {any} */ (class extends WebSocketStub {
    constructor(url) { super(net, String(url)); }
  });
  globalThis.location = {
    protocol: 'https:', host: 'table.example.com', href: 'https://table.example.com/',
    reload() { net.reloaded++; },
  };
  globalThis.window = { addEventListener() { }, removeEventListener() { } };
  globalThis.document = { addEventListener() { }, removeEventListener() { }, visibilityState: 'visible' };

  return net;
}

export { tick };
