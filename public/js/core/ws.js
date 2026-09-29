/**
 * 实时通道的连接管理。只管「连上、断了、重连」，不认识任何业务消息 —— 那是 sync.js 的事。
 *
 * 每次连接都要先换一张新 ticket：ticket 只有 30 秒有效期且一次性，
 * 所以它不能缓存，重连时必须重新申请（见 worker/lib/ticket.js 里的理由）。
 *
 * 重连退避带抖动。50 个人的小团队看起来不需要考虑惊群，但 Cloudflare 边缘节点
 * 重启时所有人会在同一毫秒掉线，不加抖动就会在同一毫秒一起重连。
 */

import { api } from './api.js';
import { t } from '../../shared/i18n/i18n.js';

const PING_MS = 25000;          // 心跳间隔，短于常见代理的 60s 空闲断连
const PONG_TIMEOUT_MS = 10000;  // 心跳发出后多久没回就判定这条连接已经死了
const BACKOFF_MS = [500, 1000, 2000, 5000, 10000, 20000, 30000];

/** @typedef {'offline' | 'connecting' | 'online'} ConnState */

export class RealtimeConnection {
  /**
   * @param {string} tableId
   * @param {{ onMessage: (msg:any)=>void, onState: (s:ConnState, detail?:string)=>void }} handlers
   */
  constructor(tableId, handlers) {
    this.tableId = tableId;
    this.onMessage = handlers.onMessage;
    this.onState = handlers.onState;

    /** @type {WebSocket | null} */ this.ws = null;
    /** @type {ConnState} */ this.state = 'offline';
    this.attempt = 0;
    this.closed = false;
    /** @type {any} */ this._retryTimer = null;
    /** @type {any} */ this._pingTimer = null;
    /** @type {any} */ this._pongTimer = null;

    // 浏览器判定网络恢复时立刻重试，不等退避计时器走完 —— 用户切回 WiFi 的
    // 那一刻正是最希望它马上连上的时候
    this._onOnline = () => { if (!this.closed && this.state !== 'online') this.connect(true); };
    window.addEventListener('online', this._onOnline);
    this._onVisible = () => {
      if (!this.closed && document.visibilityState === 'visible' && this.state === 'offline') this.connect(true);
    };
    document.addEventListener('visibilitychange', this._onVisible);
  }

  /**
   * @param {boolean} [immediate] 跳过退避，立刻尝试
   * @param {Promise<any>} [ticket] 已经提前发出的 ticket 请求（首次打开时和全量数据并行拉）
   */
  async connect(immediate = false, ticket) {
    if (this.closed || this.state === 'connecting') return;
    clearTimeout(this._retryTimer);
    if (immediate) this.attempt = 0;

    this._setState('connecting');

    /** @type {any} */ let res;
    try {
      res = await (ticket ?? api.post('/api/realtime/ticket', { tableId: this.tableId }));
    } catch (err) {
      // 401 已经在 api.js 里触发整页刷新。403 / 404 是权限被收回了（被移出工作区、
      // 表被删）—— 重试多少次都一样，停下来说清楚，别在后台无限重连。
      const status = /** @type {any} */ (err)?.status;
      if (status === 403 || status === 404) {
        this.ws = null;
        this._setState('offline', t('你已没有这张表的访问权限'));
        return;
      }
      return this._retry(err instanceof Error ? err.message : t('无法获取连接凭据'));
    }
    if (this.closed) return;

    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const url = proto + '//' + location.host + '/api/realtime/ws?ticket=' + encodeURIComponent(res.ticket);

    /** @type {WebSocket} */ let ws;
    try { ws = new WebSocket(url); } catch (err) { return this._retry(t('无法建立连接')); }
    this.ws = ws;

    ws.addEventListener('open', () => {
      if (this.ws !== ws) return;
      this.attempt = 0;
      this._setState('online');
      this._startHeartbeat();
    });

    ws.addEventListener('message', (ev) => {
      if (this.ws !== ws) return;
      /** @type {any} */ let msg;
      try { msg = JSON.parse(ev.data); } catch { return; }
      if (msg?.t === 'pong') { clearTimeout(this._pongTimer); return; }
      // 权限变更：服务端随后会发 4001 的 close 帧，但线上 TCP 可能迟迟不拆，
      // 等 close 事件会卡住十几秒。自己先断开，立刻按新权限重连。
      if (msg?.t === 'revoked') {
        this._stopHeartbeat();
        this.ws = null;
        try { ws.close(4001, 'revoked'); } catch { /* 已经断了 */ }
        if (this.closed) return;
        this.attempt = 0;
        this._setState('offline', t('权限已变更，正在重新连接…'));
        this.connect();
        return;
      }
      this.onMessage(msg);
    });

    ws.addEventListener('close', (ev) => {
      if (this.ws !== ws) return;
      this._stopHeartbeat();
      this.ws = null;
      if (this.closed) return;
      // 4001：服务端因为权限变更把我们请了出去。马上重连，按新权限回来（或者回不来）。
      if (ev.code === 4001) { this.attempt = 0; this._setState('offline', t('权限已变更，正在重新连接…')); this.connect(); return; }
      this._retry(t('连接已断开（{code}）', { code: ev.code }));
    });

    ws.addEventListener('error', () => { /* close 一定会跟着来，在那里统一处理 */ });
  }

  /** @param {any} obj @returns {boolean} 是否真的发出去了 */
  send(obj) {
    if (!this.ws || this.ws.readyState !== 1) return false;
    try { this.ws.send(JSON.stringify(obj)); return true; }
    catch { return false; }
  }

  close() {
    this.closed = true;
    clearTimeout(this._retryTimer);
    this._stopHeartbeat();
    window.removeEventListener('online', this._onOnline);
    document.removeEventListener('visibilitychange', this._onVisible);
    try { this.ws?.close(1000, 'client closed'); } catch { /* 已经断了 */ }
    this.ws = null;
    this._setState('offline');
  }

  // ── 内部 ──────────────────────────────────────────────────────────────

  /** @param {ConnState} s @param {string} [detail] */
  _setState(s, detail) {
    if (this.state === s && !detail) return;
    this.state = s;
    this.onState(s, detail);
  }

  /** @param {string} detail */
  _retry(detail) {
    this.ws = null;
    this._setState('offline', detail);
    if (this.closed) return;
    const base = BACKOFF_MS[Math.min(this.attempt, BACKOFF_MS.length - 1)];
    this.attempt++;
    // ±30% 抖动：边缘节点重启时所有人同时掉线，不抖动就会同时回来
    const delay = Math.round(base * (0.7 + Math.random() * 0.6));
    this._retryTimer = setTimeout(() => this.connect(), delay);
  }

  _startHeartbeat() {
    this._stopHeartbeat();
    this._pingTimer = setInterval(() => {
      if (!this.send({ t: 'ping' })) return;
      // 有些断网场景下 WebSocket 不会触发 close，只会静默失效。
      // 心跳没回就自己把它当死的处理，否则用户会盯着一个"在线"的假状态。
      clearTimeout(this._pongTimer);
      this._pongTimer = setTimeout(() => {
        // 网真断了的时候关闭握手也收不到回应，close 事件要再等十来秒才来 —— 这期间状态一直是
        // 「已同步」、发送却全部失败。和 revoked 一样先自己摘掉这条连接，立刻按断线处理。
        const ws = this.ws;
        this._stopHeartbeat();
        this.ws = null;
        try { ws?.close(4000, 'heartbeat timeout'); } catch { /* 已经断了 */ }
        this._retry(t('连接无响应'));
      }, PONG_TIMEOUT_MS);
    }, PING_MS);
  }

  _stopHeartbeat() {
    clearInterval(this._pingTimer);
    clearTimeout(this._pongTimer);
    this._pingTimer = null;
    this._pongTimer = null;
  }
}
