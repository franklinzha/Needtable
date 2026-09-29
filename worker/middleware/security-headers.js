/**
 * 安全响应头。
 *
 * CSP 之所以能写得这么紧（没有 unsafe-inline、没有任何外域），是因为项目选了
 * 零构建 + 全部依赖 vendor 进仓库：页面上没有内联脚本，也不从 CDN 取任何东西。
 * 这是"零构建"这个选择带来的一个不太显然的安全红利。
 */

/**
 * @param {URL} url 当前请求的 URL，用来推导 WebSocket 的同源地址
 * @returns {string}
 */
function buildCsp(url) {
  // 开发时是 ws://localhost:8787，线上是 wss://table.example.com。
  // 从请求 URL 推导而不是写死，这样 dev 和 prod 用同一套策略。
  const wsOrigin = url.origin.replace(/^http/, 'ws');

  return [
    "default-src 'self'",
    "script-src 'self'",          // 无 unsafe-inline / unsafe-eval
    "style-src 'self'",
    "img-src 'self' data: blob:", // data: 给图标，blob: 给图表导出
    "font-src 'self'",
    "connect-src 'self' " + wsOrigin,
    "worker-src 'self' blob:",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",         // 本站没有任何原生表单提交
    "frame-ancestors 'none'",     // 防点击劫持，比 X-Frame-Options 更强
    'upgrade-insecure-requests',
  ].join('; ');
}

/**
 * 给响应补上安全头。会复制一份响应，因为 env.ASSETS.fetch() 返回的 headers 不可变。
 * @param {Response} response
 * @param {URL} url
 * @returns {Response}
 */
export function withSecurityHeaders(response, url) {
  const headers = new Headers(response.headers);

  // 附件响应自带一份更严的 CSP（sandbox），不能被站点通用策略覆盖掉
  if (!headers.has('content-security-policy')) headers.set('content-security-policy', buildCsp(url));
  headers.set('x-content-type-options', 'nosniff');
  headers.set('referrer-policy', 'same-origin');
  headers.set('cross-origin-opener-policy', 'same-origin');
  headers.set('cross-origin-resource-policy', 'same-origin');
  headers.set('permissions-policy', 'geolocation=(), microphone=(), camera=(), payment=()');

  // HSTS 只在 https 下发，否则本地 http 调试会被浏览器强制升级导致连不上
  if (url.protocol === 'https:') {
    headers.set('strict-transport-security', 'max-age=31536000; includeSubDomains');
  }

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}
