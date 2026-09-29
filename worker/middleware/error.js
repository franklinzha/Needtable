/**
 * 统一错误兜底。
 *
 * 目标只有两个：
 *   1. 任何未捕获异常都不能把栈、SQL 语句、绑定名泄露给客户端
 *   2. 内部要能查到 —— 所以给每次错误发一个 errorId，日志里打全量，响应里只回 id
 */

import { serverError } from '../lib/response.js';
import { t } from '../../public/shared/i18n/i18n.js';

/**
 * @param {Request} request
 * @param {() => Promise<Response>} run
 * @returns {Promise<Response>}
 */
export async function withErrorBoundary(request, run) {
  try {
    return await run();
  } catch (err) {
    const errorId = crypto.randomUUID().slice(0, 8);
    // console.error 会进 wrangler tail / Workers Logs，不会进响应体
    console.error('[' + errorId + ']', request.method, new URL(request.url).pathname, err);
    return serverError(t('服务器内部错误，请稍后重试'), { errorId });
  }
}
