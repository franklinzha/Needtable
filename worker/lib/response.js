/** 统一的响应构造。所有 API 响应一律 no-store —— 表格数据不该进任何缓存。 */

import { t } from '../../public/shared/i18n/i18n.js';

/**
 * @param {unknown} data
 * @param {number} [status]
 * @param {Record<string,string>} [headers]
 */
export function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      ...headers,
    },
  });
}

/**
 * 错误响应。对外只暴露稳定的 code 与一句人话，绝不回传堆栈或内部细节。
 * @param {number} status
 * @param {string} code
 * @param {string} message
 * @param {Record<string, unknown>} [extra]
 */
export function fail(status, code, message, extra) {
  return json({ error: { code, message, ...extra } }, status);
}

export const badRequest   = (m = t('请求格式不正确'), extra) => fail(400, 'bad_request', m, extra);
export const unauthorized = (m = t('需要登录'))             => fail(401, 'unauthorized', m);
export const forbidden    = (m = t('没有访问权限'))          => fail(403, 'forbidden', m);
export const notFound     = (m = t('资源不存在'))            => fail(404, 'not_found', m);
export const methodNotAllowed = (allow) => fail(405, 'method_not_allowed', t('方法不被允许'), { allow });
export const conflict     = (m = t('版本冲突，请刷新后重试'), extra) => fail(409, 'conflict', m, extra);
export const tooManyRequests = (retryAfter) =>
  json({ error: { code: 'rate_limited', message: t('请求过于频繁，请稍后再试') } }, 429, {
    'retry-after': String(retryAfter),
  });
export const serverError  = (m = t('服务器内部错误'), extra) => fail(500, 'internal_error', m, extra);

/** 配置缺失时的 fail-closed 响应：宁可整站不可用，也不放行未鉴权流量。 */
export const notConfigured = (what) =>
  fail(503, 'not_configured', t('服务尚未完成配置（{what}），已拒绝所有请求', { what }));
