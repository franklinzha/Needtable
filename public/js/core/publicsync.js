/**
 * 公开只读链接的「同步引擎」：没有 WebSocket（公开访客拿不到 ticket），
 * 只拉一次快照，之后每分钟问一次 seq，变了就整表重拉。
 *
 * 对 Grid 暴露的接口与 SyncEngine 相同的那一小部分：state / readonly / you / tableId /
 * sendCursor / start / destroy。本地改动一律不回传 —— 网格本身也是只读的。
 */

import { t } from '../../shared/i18n/i18n.js';

const POLL_MS = 60_000;

export class PublicSync {
  /**
   * @param {string} token @param {string} tableId @param {any} model
   * @param {{ onState?(s: string, detail?: string): void, onNotice?(msg: string, kind?: string): void, onGone?(): void }} h
   */
  constructor(token, tableId, model, h) {
    this.token = token;
    this.tableId = tableId;
    this.model = model;
    this.h = h;
    this.readonly = true;
    /** @type {string} */ this.state = 'loading';
    this.you = { id: 'public', email: '', name: t('访客'), role: 'viewer' };
    this.seq = -1;
    this.destroyed = false;
    /** @type {any} */ this._iv = null;
    this._onVisible = () => { if (document.visibilityState === 'visible') void this._poll(); };
  }

  get base() { return '/api/public/' + this.token; }

  async start() {
    this._setState('loading');
    try {
      await this._load();
    } catch (err) {
      this._setState('offline', t('无法载入表格数据'));
      this.h.onNotice?.(err instanceof Error ? err.message : t('无法载入表格数据'), 'error');
      return;
    }
    if (this.destroyed) return;
    this._setState('readonly', t('公开只读链接，每分钟自动刷新'));
    this._iv = setInterval(() => { if (document.visibilityState === 'visible') void this._poll(); }, POLL_MS);
    document.addEventListener('visibilitychange', this._onVisible);
  }

  destroy() {
    this.destroyed = true;
    clearInterval(this._iv);
    document.removeEventListener('visibilitychange', this._onVisible);
  }

  sendCursor() {}

  async _load() {
    const res = await fetch(this.base + '/data', { credentials: 'same-origin' });
    if (res.status === 404) { this._gone(); throw new Error(t('链接已失效')); }
    if (!res.ok) throw new Error(t('载入失败（HTTP {status}）', { status: res.status }));
    const snap = await res.json();
    if (this.destroyed) return;
    this.model.loadSnapshot(snap);
    this.seq = Number(snap.seq ?? 0);
  }

  async _poll() {
    if (this.destroyed || this._busy) return;
    this._busy = true;
    try {
      const res = await fetch(this.base + '/seq', { credentials: 'same-origin' });
      if (res.status === 404) return this._gone();
      if (!res.ok) return;
      const { seq } = await res.json();
      if (Number(seq) !== this.seq) await this._load();
      this._setState('readonly', t('公开只读链接，每分钟自动刷新'));
    } catch {
      this._setState('offline', t('网络断开，恢复后自动刷新'));
    } finally {
      this._busy = false;
    }
  }

  _gone() {
    this.destroy();
    this.h.onGone?.();
  }

  /** @param {string} s @param {string} [detail] */
  _setState(s, detail) {
    this.state = s;
    this.h.onState?.(s, detail);
  }
}
