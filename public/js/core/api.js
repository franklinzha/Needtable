/**
 * REST 客户端。
 *
 * 唯一需要特别处理的是 401：会话过期后 fetch 拿到的是 401 而不是数据。
 * 这时候整页跳到登录页，并把当前地址放进 ?next= —— 登录完能回到原来那一页，
 * 而不是被扔回首页。
 *
 * 为什么不是 location.reload()：Worker 只对「浏览器地址栏发起的文档请求」
 * 回 302，对 fetch 一律回 401（否则 JS 模块加载会拿到一坨 HTML 而不是报错）。
 * 所以这一跳得前端自己走。
 */

import { t, tr } from '../../shared/i18n/i18n.js';

/** 跳登录页，带上回跳地址。重复调用只跳一次。 */
let redirecting = false;
/** 公开只读链接：访客本来就没登录，401 只是「这个功能要登录」，不该把人送去登录页。 */
let publicMode = false;
export function setPublicMode() { publicMode = true; }
function toLogin() {
  if (redirecting || publicMode) return;
  redirecting = true;
  const next = location.pathname + location.search;
  location.replace(next === '/' ? '/login' : '/login?next=' + encodeURIComponent(next));
}

/** 还在用管理员给的初始密码：服务端除了改密码一律 403，送去改密码页。 */
function toChangePassword() {
  if (redirecting) return;
  redirecting = true;
  const next = location.pathname + location.search;
  location.replace('/login?change=1' + (next === '/' ? '' : '&next=' + encodeURIComponent(next)));
}

export class ApiError extends Error {
  /** @param {number} status @param {string} code @param {string} message */
  constructor(status, code, message) {
    super(tr(message));   // 服务端的报错是中文整句，按词典翻译
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
  }
}

/** @param {string} path @param {RequestInit} [init] */
async function request(path, init = {}) {
  const res = await fetch(path, {
    ...init,
    headers: {
      accept: 'application/json',
      ...(init.body ? { 'content-type': 'application/json' } : {}),
      ...init.headers,
    },
    credentials: 'same-origin',
  });

  if (res.status === 401) {
    toLogin();
    throw new ApiError(401, 'unauthorized', t('登录已过期'));
  }

  const text = await res.text();
  /** @type {any} */
  let data = null;
  if (text) { try { data = JSON.parse(text); } catch { /* 非 JSON 响应，保持 null */ } }

  if (!res.ok) {
    if (res.status === 403 && data?.error?.code === 'must_change_password') toChangePassword();
    throw new ApiError(res.status, data?.error?.code ?? 'http_' + res.status,
                       data?.error?.message ?? t('请求失败（HTTP {status}）', { status: res.status }));
  }
  return data;
}

export const api = {
  /** @param {string} p */
  get: (p) => request(p),
  /** @param {string} p @param {unknown} body */
  post: (p, body) => request(p, { method: 'POST', body: JSON.stringify(body ?? {}) }),
  /** @param {string} p @param {unknown} body */
  patch: (p, body) => request(p, { method: 'PATCH', body: JSON.stringify(body ?? {}) }),
  /** @param {string} p @param {unknown} body */
  put: (p, body) => request(p, { method: 'PUT', body: JSON.stringify(body ?? {}) }),
  /** @param {string} p */
  del: (p) => request(p, { method: 'DELETE' }),

  me: async () => {
    const me = await request('/api/me');
    if (me?.user?.mustChange) {
      toChangePassword();
      throw new ApiError(403, 'must_change_password', t('请先修改初始密码'));
    }
    return me;
  },
  /** @param {string} id */
  workspace: (id) => request('/api/workspaces/' + encodeURIComponent(id)),
};
