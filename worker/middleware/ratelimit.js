/**
 * 每用户限流。
 *
 * 用 isolate 内存里的令牌桶，不用 KV —— KV 免费额度只有 1000 写/天，
 * 每请求写一次会在几分钟内打满。
 *
 * 代价要说清楚：Cloudflare 会在多个 isolate 上并行跑同一个 Worker，
 * 所以这是**每 isolate** 的限额，不是全局精确限额。对 50 人规模的内部工具，
 * 目的只是挡住误写的死循环和脚本刷接口，不是抗 DDoS —— 真正的 DDoS 由
 * Cloudflare 边界和 Access 登录墙挡在前面。需要精确全局限额时，可以换成
 * 原生 Rate Limiting 绑定（在 wrangler.jsonc 里加 [[unsafe.bindings]]），
 * 本文件的接口保持不变。
 */

/** @type {Map<string, { tokens: number, updatedAt: number }>} */
const buckets = new Map();

/** 桶数量上限，防止内存无限增长（key 是用户 id，正常远小于这个数） */
const MAX_BUCKETS = 5000;

/**
 * @param {string} key 通常是用户 id
 * @param {{ capacity?: number, refillPerSec?: number }} [opts]
 * @returns {{ ok: true } | { ok: false, retryAfter: number }}
 */
export function consume(key, opts = {}) {
  const capacity = opts.capacity ?? 120;        // 突发 120 次
  const refillPerSec = opts.refillPerSec ?? 4;  // 稳态 4 次/秒
  const now = Date.now();

  let b = buckets.get(key);
  if (!b) {
    if (buckets.size >= MAX_BUCKETS) buckets.clear();  // 简单粗暴，但不会泄漏
    b = { tokens: capacity, updatedAt: now };
    buckets.set(key, b);
  } else {
    const elapsed = (now - b.updatedAt) / 1000;
    b.tokens = Math.min(capacity, b.tokens + elapsed * refillPerSec);
    b.updatedAt = now;
  }

  if (b.tokens < 1) {
    return { ok: false, retryAfter: Math.max(1, Math.ceil((1 - b.tokens) / refillPerSec)) };
  }
  b.tokens -= 1;
  return { ok: true };
}

/** 测试用。 */
export function resetRateLimit() { buckets.clear(); }
