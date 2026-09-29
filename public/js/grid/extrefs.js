/**
 * 跨表引用的客户端：给公式引擎供数（=tbl_xxx!A1、IMPORTRANGE）。
 *
 *   · 按「表!区域」缓存取回来的计算结果。没取到时先给 #LOADING，同一轮里要的
 *     全部攒起来，下一个宏任务里分批（每批 10 项）一起问服务端，到了之后通知网格重算。
 *   · 30 秒过期：过期的照样先用旧值，同时后台刷新；标签页可见时每 30 秒、
 *     窗口重新获得焦点时把用过的全部刷一遍 —— 被引用的表改了，这边最多慢半分钟。
 *   · 公式提交时把里面的外表引用登记到服务端（table_refs）。登记之后，
 *     对被引用表没有权限、但能看这张表的人，也能看到这块区域的结果（「引用大于权限」）。
 *
 * 服务端规则见 worker/routes/refs.js。
 */

import { api } from '../core/api.js';
import { t, tr } from '../../shared/i18n/i18n.js';
import { ERR } from '../../shared/formula/values.js';
import { extRefsIn, unpackRange } from '../../shared/formula/extref.js';

const TTL = 30_000;
const BATCH = 10;
const CACHE_MAX = 400;

export class ExtRefs {
  /**
   * @param {string} tableId 当前这张表
   * @param {{ onChange(): void, onError?(msg: string): void }} on
   * @param {string} [path] 取值接口；公开只读链接走 /api/public/<令牌>/ext
   */
  constructor(tableId, on, path) {
    this.tableId = tableId;
    this.on = on;
    this.path = path ?? '/api/tables/' + encodeURIComponent(tableId) + '/ext';
    /** @type {Map<string, { v: any, at: number, json: string }>} */ this.cache = new Map();
    /** @type {Set<string>} */ this.queue = new Set();
    /** @type {Set<string>} */ this.inflight = new Set();
    /** @type {Set<string>} 本次会话里已经登记过的 */ this.registered = new Set();
    this._timer = 0;
    this.disposed = false;
    this._onFocus = () => this.refreshAll();
    window.addEventListener('focus', this._onFocus);
    this._iv = setInterval(() => { if (document.visibilityState === 'visible') this.refreshAll(); }, TTL);
  }

  /**
   * 引擎的 host.ext。
   * @param {string} table @param {string} range 规范化的区域文本
   */
  get(table, range) {
    const key = table + '!' + range;
    const hit = this.cache.get(key);
    if (hit) {
      if (Date.now() - hit.at > TTL) this._want(key);
      return hit.v;
    }
    this._want(key);
    return ERR.LOADING;
  }

  /** @param {string} key */
  _want(key) {
    if (this.disposed || this.inflight.has(key)) return;
    this.queue.add(key);
    if (!this._timer) this._timer = setTimeout(() => this._flush(), 0);
  }

  _flush() {
    this._timer = 0;
    const keys = [...this.queue];
    this.queue.clear();
    for (let i = 0; i < keys.length; i += BATCH) void this._fetch(keys.slice(i, i + BATCH));
  }

  /** @param {string[]} keys */
  async _fetch(keys) {
    for (const k of keys) this.inflight.add(k);
    let changed = false;
    try {
      const items = keys.map((k) => {
        const i = k.indexOf('!');
        return { src: k.slice(0, i), range: k.slice(i + 1) };
      });
      const res = await api.post(this.path, { items });
      const now = Date.now();
      keys.forEach((k, i) => {
        const p = res.results?.[i] ?? { e: '#REF!' };
        const json = JSON.stringify(p);
        const old = this.cache.get(k);
        if (old?.json !== json) changed = true;
        this.cache.delete(k);           // 重新插到末尾：Map 的顺序就是最近使用顺序
        this.cache.set(k, { v: unpackRange(p), at: now, json });
      });
      while (this.cache.size > CACHE_MAX) this.cache.delete(/** @type {string} */ (this.cache.keys().next().value));
    } catch {
      // 断网之类：有旧值就继续用旧值，没有的给 #REF!，并且推迟到下一个周期再试，免得原地打转
      const now = Date.now();
      for (const k of keys) {
        const old = this.cache.get(k);
        if (old) old.at = now;
        else { this.cache.set(k, { v: ERR.REF, at: now, json: '' }); changed = true; }
      }
    } finally {
      for (const k of keys) this.inflight.delete(k);
    }
    if (changed && !this.disposed) this.on.onChange();
  }

  /** 把缓存里的全部刷一遍（结果没变就不会触发重算）。 */
  refreshAll() {
    for (const k of this.cache.keys()) this._want(k);
  }

  /**
   * 新写的公式里有外表引用：登记到服务端。登记前取到的 #REF!（当时还没授权）作废重取。
   * @param {string[]} formulas 以 '=' 开头的公式原文
   */
  async register(formulas) {
    /** @type {{ to: string, range: string }[]} */ const refs = [];
    for (const f of formulas) {
      for (const r of extRefsIn(f.slice(1))) {
        const k = r.table + '!' + r.range;
        if (r.table === this.tableId || this.registered.has(k)) continue;
        this.registered.add(k);
        refs.push({ to: r.table, range: r.range });
      }
    }
    if (!refs.length) return;
    try {
      for (let i = 0; i < refs.length; i += 20) {
        const res = await api.post('/api/tables/' + encodeURIComponent(this.tableId) + '/refs', { refs: refs.slice(i, i + 20) });
        const bad = (res.results ?? []).filter((/** @type {any} */ x) => !x.ok);
        if (bad.length) this.on.onError?.(bad[0].error ? tr(bad[0].error) : t('跨表引用登记失败'));
      }
    } catch (e) {
      for (const r of refs) this.registered.delete(r.to + '!' + r.range);
      this.on.onError?.(t('跨表引用登记失败：{msg}', { msg: /** @type {Error} */ (e).message || t('网络错误') }));
      return;
    }
    let stale = false;
    for (const r of refs) {
      const k = r.to + '!' + r.range;
      if (this.cache.has(k)) { this.cache.delete(k); stale = true; }
      this._want(k);
    }
    if (stale && !this.disposed) this.on.onChange();
  }

  dispose() {
    this.disposed = true;
    clearTimeout(this._timer);
    clearInterval(this._iv);
    window.removeEventListener('focus', this._onFocus);
  }
}
