/**
 * 后端主入口。
 *
 * 请求流转顺序（顺序本身就是安全设计的一部分）：
 *
 *   error 兜底
 *     └─ /api/realtime/ws ──► ticket 验签 ──► TableDO        （见 routes/realtime.js）
 *     └─ /api/auth/*      ──► 登录、登出、开通账号            （全站唯一公开的接口）
 *     └─ 公开页面白名单   ──► 登录页自己和它的三个依赖
 *     └─ 其余全部请求
 *          ├─ authenticate  会话 Cookie（或 Access JWT）→ identity
 *          ├─ resolveUser   identity → 本地用户；null / 停用 / 代次不符一律 401
 *          ├─ ratelimit     每用户令牌桶
 *          ├─ /api/*  ──► 路由表
 *          └─ 其余    ──► env.ASSETS  静态资源
 *
 * 关键点：wrangler.jsonc 里 assets.run_worker_first = true。
 * 默认顺序是静态资源**先于** Worker 命中，那样 index.html 会裸奔在公网上。
 *
 * 白名单为什么必须**精确匹配**、绝不能写成前缀：
 * assets.not_found_handling = "single-page-application"，也就是说任何命不中
 * 文件的路径都会回落到 index.html —— 而 index.html 是要保护的东西。
 * 如果放行 "/css/" 这样的前缀，那 /css/不存在.css 就会把 index.html 吐出去。
 */

import { Router } from './lib/router.js';
import {
  json, notFound, methodNotAllowed, tooManyRequests, unauthorized, notConfigured,
} from './lib/response.js';
import { t } from '../public/shared/i18n/i18n.js';
import { withErrorBoundary } from './middleware/error.js';
import { authenticate, authMode } from './middleware/auth.js';
import { resolveUser, invalidateUser } from './middleware/rbac.js';
import { consume } from './middleware/ratelimit.js';
import { withSecurityHeaders } from './middleware/security-headers.js';
import {
  signSession, sessionCookieHeader, clearCookieHeader, withCookie, SESSION_RENEW_AFTER_MS,
} from './lib/session.js';

import { getMe, changePassword } from './routes/me.js';
import { putMyTheme, putAdminTheme } from './routes/theme.js';
import { putMyLang } from './routes/lang.js';
import { getHome } from './routes/home.js';
import {
  getWorkspace, createWorkspace, updateWorkspace, createBase, updateBase,
  listMembers, putMember, removeMember, listBaseMembers, putBaseMember, removeBaseMember,
} from './routes/workspaces.js';
import { listUsers, createUser, resetUser, updateUser } from './routes/admin.js';
import {
  getTable, getTableData, createTable, updateTable, deleteTable, uploadFile, getFile,
  listTableMembers, putTableMember, removeTableMember,
} from './routes/tables.js';
import { issueTicket, handleWsUpgrade } from './routes/realtime.js';
import { registerRefs, readExt } from './routes/refs.js';
import { getAuthConfig, login, logout, enrollBegin, enrollComplete } from './routes/auth.js';
import { getSettings, putSettings, getMySecurity, totpBegin, totpConfirm } from './routes/security.js';
import { aiCapabilities, aiComplete, aiFormula } from './routes/ai.js';
import {
  getPublicLink, createPublicLink, revokePublicLink, handlePublicApi, hasPublicCookie, publicPageCookie,
} from './routes/public.js';

export { TableDO } from './do/TableDO.js';

/** 必须先改初始密码的会话能调的接口。 */
const MUST_CHANGE_ALLOWED = new Set(['GET /api/me', 'POST /api/me/password']);

/** 需要登录才能调的接口。 */
const router = new Router()
  .get('/api/health', (req, c) => json({ ok: true, env: c.env.ENVIRONMENT ?? 'production' }))
  .get('/api/me', getMe)
  .get('/api/home', getHome)
  .post('/api/me/password', changePassword)
  .put('/api/me/theme', putMyTheme)
  .put('/api/me/lang', putMyLang)
  .get('/api/me/security', getMySecurity)
  .post('/api/me/totp/begin', totpBegin)
  .post('/api/me/totp/confirm', totpConfirm)

  .get('/api/admin/settings', getSettings)
  .put('/api/admin/settings', putSettings)
  .put('/api/admin/theme', putAdminTheme)
  .get('/api/admin/users', listUsers)
  .post('/api/admin/users', createUser)
  .post('/api/admin/users/:id/reset', resetUser)
  .patch('/api/admin/users/:id', updateUser)

  .post('/api/workspaces', createWorkspace)
  .get('/api/workspaces/:id', getWorkspace)
  .patch('/api/workspaces/:id', updateWorkspace)
  .post('/api/workspaces/:id/bases', createBase)
  .get('/api/workspaces/:id/members', listMembers)
  .put('/api/workspaces/:id/members', putMember)
  .delete('/api/workspaces/:id/members/:userId', removeMember)

  .patch('/api/bases/:id', updateBase)
  .get('/api/bases/:id/members', listBaseMembers)
  .put('/api/bases/:id/members', putBaseMember)
  .delete('/api/bases/:id/members/:userId', removeBaseMember)

  .post('/api/tables', createTable)
  .get('/api/tables/:id', getTable)
  .get('/api/tables/:id/data', getTableData)
  .post('/api/tables/:id/files', uploadFile)
  .get('/api/tables/:id/files/:fid', getFile)
  .patch('/api/tables/:id', updateTable)
  .delete('/api/tables/:id', deleteTable)
  .get('/api/tables/:id/members', listTableMembers)
  .put('/api/tables/:id/members', putTableMember)
  .delete('/api/tables/:id/members/:userId', removeTableMember)
  .post('/api/tables/:id/refs', registerRefs)
  .post('/api/tables/:id/ext', readExt)
  .get('/api/tables/:id/public', getPublicLink)
  .post('/api/tables/:id/public', createPublicLink)
  .delete('/api/tables/:id/public', revokePublicLink)

  .get('/api/ai/capabilities', aiCapabilities)
  .post('/api/ai/complete', aiComplete)
  .post('/api/ai/formula', aiFormula)

  .post('/api/realtime/ticket', issueTicket);

/**
 * 不需要登录的接口。单独一张表，而不是在上面那张表里开口子 ——
 * 「公开」这件事应该一眼能数清楚，而不是散落在各个 handler 的第一行。
 * 每一条都自己扛限流与枚举防护，见 routes/auth.js。
 */
const publicRouter = new Router()
  .get('/api/auth/config', getAuthConfig)
  .post('/api/auth/login', login)
  .post('/api/auth/logout', logout)
  .post('/api/auth/enroll/begin', enrollBegin)
  .post('/api/auth/enroll/complete', enrollComplete);

/**
 * 公开页面路径 → 实际文件。显式改写而不是靠 html_handling 去猜，
 * 也不能让它走 SPA 回落（那会吐出受保护的 index.html）。
 */
const PUBLIC_PAGES = new Map([
  ['/login', '/login.html'],
  ['/login.html', '/login.html'],
  ['/enroll', '/login.html'],   // 开通账号与登录共用一个页面，靠 URL 片段区分
]);

/**
 * 帮助中心：必须登录才能看（在 ⑧ 静态资源分支里改写）。/help 与 /help.html 都认；
 * 不能让它走 SPA 回落，否则登录后打开 /help 看到的是表格首页。
 */
const HELP_PAGES = new Set(['/help', '/help.html']);

/**
 * 用户管理页：只给管理员。故意不叫 /admin 之类容易被扫到的名字；
 * 非管理员访问一律 404，看起来跟不存在的路径一样。
 */
const USERS_PAGES = new Set(['/yonghuguanli', '/yonghuguanli.html']);

/**
 * 开通链接 /enroll/<令牌>（32 字节 base64url = 43 个字符）。
 * 令牌放路径而不是 # 后面：微信、企业微信等聊天软件识别链接时常在 # 处截断，
 * 对方点开只剩 /enroll。只认这一种精确形状，/enroll/ 和别的子路径照旧不公开。
 */
const ENROLL_PATH = /^\/enroll\/[A-Za-z0-9_-]{43}$/;

/**
 * 公开静态文件。这就是未登录者能拿到的**全部**字节，逐个列出。
 * 登录页刻意不复用 tokens.css / base.css：少暴露一个文件，样式自己带。
 */
const PUBLIC_FILES = new Set([
  '/css/login.css',
  '/js/login.js',
  '/shared/util/kdf.js',   // 600k PBKDF2 在浏览器里跑
  '/shared/util/b64.js',   // dk 的 base64url 编码
  '/shared/util/qr.js',    // 绑定验证器时画二维码
  '/js/theme-boot.js',     // 上次选的主题配色（只读本机缓存），登录页也用
  '/shared/i18n/i18n.js',  // i18n 运行时，登录页按用户语言初始化
  '/js/core/lang.js',      // 语言切换模块，登录页用
  '/js/login-i18n.js',     // 登录页专用界面翻译入口
]);

/** 浏览器地址栏直接访问（而不是 fetch / import）才值得重定向到登录页。 */
function isDocumentNav(request) {
  const dest = request.headers.get('sec-fetch-dest');
  if (dest) return dest === 'document';
  return (request.headers.get('accept') || '').includes('text/html');
}

/** @param {URL} url */
function loginRedirect(url) {
  const next = url.pathname + url.search;
  const to = next === '/' ? '/login' : '/login?next=' + encodeURIComponent(next);
  return new Response(null, { status: 302, headers: { location: to, 'cache-control': 'no-store' } });
}

/**
 * 401 的呈现方式取决于请求者是谁：
 *   · 人在地址栏里敲的 → 302 去登录页，否则用户只会看到一片空白的 JSON
 *   · JS 发起的 fetch / import → 原样 401，让前端自己决定怎么处理
 * 503（密钥未配置）之类的不能改成重定向 —— 那会让人以为只是没登录。
 * @param {Response} res @param {Request} request @param {URL} url
 */
function presentGateFailure(res, request, url) {
  if (res.status !== 401) return res;
  if (request.method !== 'GET' || !isDocumentNav(request)) return res;
  return loginRedirect(url);
}

export default {
  /**
   * @param {Request} request @param {any} env @param {ExecutionContext} ctx
   * @returns {Promise<Response>}
   */
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    return withErrorBoundary(request, async () => {
      // ① WebSocket：自带 ticket 鉴权，不套安全响应头（101 响应不能改头）
      if (url.pathname === '/api/realtime/ws') {
        return handleWsUpgrade(request, url, env);
      }

      // ② 公开接口。走独立路由表，命不中就是 404，不会落到下面的静态资源分支。
      if (url.pathname.startsWith('/api/auth/')) {
        // 密钥还没配好时，登录页至少该收到一句人话。少了这一句，用户会先看到
        // 一个正常的登录表单，再收到一个 500 —— 比直接说"还没配好"难查得多。
        if (authMode(env) === 'password' && url.pathname !== '/api/auth/config'
          && (!env.SESSION_SECRET || !env.AUTH_PEPPER)) {
          return withSecurityHeaders(notConfigured('SESSION_SECRET / AUTH_PEPPER 尚未设置'), url);
        }
        const hit = publicRouter.match(request.method, url.pathname);
        let res;
        if (!hit) res = notFound(t('接口不存在'));
        else if ('allow' in hit) res = methodNotAllowed(hit.allow);
        else res = await hit.handler(request, { params: hit.params, url, env, ctx });
        return withSecurityHeaders(res, url);
      }

      // ③ 登录页本身。这是整个站点唯一不需要凭据的页面 —— 也是把登录墙从
      //    Cloudflare Access 搬进应用之后，唯一一处必须承认的让步。
      if (request.method === 'GET' || request.method === 'HEAD') {
        const page = PUBLIC_PAGES.get(url.pathname) ?? (ENROLL_PATH.test(url.pathname) ? '/login.html' : null);
        if (page) {
          const rewritten = new Request(new URL(page, url), request);
          const res = await env.ASSETS.fetch(rewritten);
          return withSecurityHeaders(noStore(res), url);
        }
        if (PUBLIC_FILES.has(url.pathname)) {
          return withSecurityHeaders(await env.ASSETS.fetch(request), url);
        }
      }

      // ③½ 公开只读链接（见 routes/public.js）。只认精确形状，其余照旧走登录墙。
      if (url.pathname.startsWith('/api/public/')) {
        return withSecurityHeaders(await handlePublicApi(request, url, env), url);
      }
      if ((request.method === 'GET' || request.method === 'HEAD') && url.searchParams.has('view') && isDocumentNav(request)) {
        const cookie = await publicPageCookie(url, env);
        if (cookie) return withSecurityHeaders(withCookie(await serveAsset(new Request(new URL('/', url), request), new URL('/', url), env), cookie), url);
      }
      // 凭公开 Cookie 只放行模块和样式；已登录的人拿到的也是同一份文件，无所谓先后
      if ((request.method === 'GET' || request.method === 'HEAD') && ASSET_PATH.test(url.pathname)
        && await hasPublicCookie(request, env)) {
        return withSecurityHeaders(await serveAsset(request, url, env, true), url);
      }

      // ④ 鉴权。静态资源也必须先过这一关。
      const auth = await authenticate(request, url, env);
      if ('response' in auth) {
        return withSecurityHeaders(presentGateFailure(auth.response, request, url), url);
      }

      // ⑤ 应用内身份。
      let user = await resolveUser(auth.identity, env);

      // Cookie 是自校验的，所以「账号还在不在、还能不能用」必须在这里查。
      // 代次对不上时先把 60 秒的内存缓存丢掉重读一次：刚改完口令的那张新
      // Cookie 不该被上一次请求留下的旧缓存挡在门外。
      if (user && auth.session && user.sessionEpoch !== auth.session.epoch) {
        invalidateUser(auth.identity.email);
        user = await resolveUser(auth.identity, env);
      }

      const rejected = !user
        || user.status !== 'active'
        || (auth.session != null && user.sessionEpoch !== auth.session.epoch);

      if (rejected) {
        const res = presentGateFailure(unauthorized(t('登录已失效，请重新登录')), request, url);
        return withSecurityHeaders(withCookie(res, clearCookieHeader(url)), url);
      }

      // ⑥ 限流
      const quota = consume(user.id);
      if (!quota.ok) return withSecurityHeaders(tooManyRequests(quota.retryAfter), url);

      // ⑥½ 管理员给的默认密码还没改：除了看自己是谁、改密码，别的一律不让做。
      //    页面本身（静态资源）照常放行 —— 前端拿到 /api/me 的 mustChange 会自己跳去改密码。
      if (user.mustChange && url.pathname.startsWith('/api/') && !MUST_CHANGE_ALLOWED.has(request.method + ' ' + url.pathname)) {
        return withSecurityHeaders(json({ error: { code: 'must_change_password', message: t('请先修改初始密码') } }, 403), url);
      }

      // ⑦ API
      if (url.pathname.startsWith('/api/')) {
        const hit = router.match(request.method, url.pathname);
        let res;
        if (!hit) res = notFound(t('接口不存在'));
        else if ('allow' in hit) res = methodNotAllowed(hit.allow);
        else {
          res = await hit.handler(request, {
            params: hit.params, url, env, ctx, identity: auth.identity, user,
          });
        }
        // 滑动续期只挂在 API 响应上：静态资源响应是可缓存的，
        // 给它加 Set-Cookie 等于把别人的会话发给下一个请求者。
        res = await maybeRenew(res, auth.session, user, url, env);
        return withSecurityHeaders(res, url);
      }

      // ⑧ 静态资源。走到这里说明已经鉴权通过。
      // 帮助中心只给登录用户：未登录的在 ④ 就被 302 到登录页（带 next=/help）
      if ((request.method === 'GET' || request.method === 'HEAD') && HELP_PAGES.has(url.pathname)) {
        const helpUrl = new URL('/help.html', url);
        return withSecurityHeaders(await serveAsset(new Request(helpUrl, request), helpUrl, env), url);
      }
      if (USERS_PAGES.has(url.pathname)) {
        if (user.role !== 'admin' || (request.method !== 'GET' && request.method !== 'HEAD')) return withSecurityHeaders(notFound(t('页面不存在')), url);
        const pageUrl = new URL('/yonghuguanli.html', url);
        return withSecurityHeaders(await serveAsset(new Request(pageUrl, request), pageUrl, env), url);
      }
      return withSecurityHeaders(await serveAsset(request, url, env), url);
    });
  },
};

/**
 * 会话超过续期阈值就顺手换一张新 Cookie，避免用户干到一半被踢出去。
 * 不写 D1 —— Cookie 是自校验的，续期只是重新签个名。
 * @param {Response} res
 * @param {import('./lib/session.js').SessionPayload | undefined} session
 * @param {{ id: string, email: string, sessionEpoch: number }} user
 * @param {URL} url @param {any} env
 */
async function maybeRenew(res, session, user, url, env) {
  if (!session) return res;
  if (Date.now() - session.iat <= SESSION_RENEW_AFTER_MS) return res;
  // 处理函数自己发了新 Cookie（改密码会把代次 +1）：不能再拿旧代次盖掉它
  if (res.headers.has('set-cookie')) return res;
  const token = await signSession(
    { id: user.id, email: user.email, session_epoch: user.sessionEpoch }, env,
  );
  return withCookie(res, sessionCookieHeader(token, url));
}

/** 登录页不该被任何缓存留下来。 @param {Response} res */
/**
 * 带版本前缀的静态资源：/v/<部署版本>/js/grid/grid.js → /js/grid/grid.js。
 *
 * 零构建没有文件名哈希，原来每次打开页面都要把 40 多个模块逐个 304 重新验证一遍，
 * 而且 import 是一层套一层的，隔着跨境链路就是好几秒。现在 index.html 里的引用
 * 被改写成带部署版本的路径，模块之间都是相对 import，会自动继承这个前缀，
 * 于是整棵模块树可以 immutable 长缓存；一次部署换一个前缀，旧缓存自然失效。
 */
const VERSIONED = /^\/v\/([a-z0-9-]{1,64})(\/(?:js|css|shared)\/[^?#]+)$/;
/** 公开页面能拿的静态文件：只有模块和样式。 */
const ASSET_PATH = /^(?:\/v\/[a-z0-9-]{1,64})?\/(?:js|css|shared)\/[A-Za-z0-9_\/.-]+\.(?:js|css)$/;

/** @param {any} env */
function assetVersion(env) {
  return String(env.CF_VERSION_METADATA?.id ?? 'dev').toLowerCase().replace(/[^a-z0-9-]/g, '').slice(0, 64) || 'dev';
}

/** @param {Request} request @param {URL} url @param {any} env @param {boolean} [strict] 不许回落成 index.html */
async function serveAsset(request, url, env, strict = false) {
  const m = VERSIONED.exec(url.pathname);
  if (m) {
    const res = await env.ASSETS.fetch(new Request(new URL(m[2], url), request));
    // 不存在的文件会被 SPA 回落成 index.html —— 对模块请求来说那只能是 404
    if (!res.ok || (res.headers.get('content-type') ?? '').includes('text/html')) return notFound(t('文件不存在'));
    const headers = new Headers(res.headers);
    // 本地 wrangler dev 没有版本号，别让浏览器把开发中的文件缓存一年
    headers.set('cache-control', assetVersion(env) === 'dev' ? 'no-cache' : 'private, max-age=31536000, immutable');
    headers.delete('etag');
    return new Response(res.body, { status: 200, headers });
  }

  const res = await env.ASSETS.fetch(request);
  if (strict) return !res.ok || (res.headers.get('content-type') ?? '').includes('text/html') ? notFound(t('文件不存在')) : res;
  if (!(res.headers.get('content-type') ?? '').includes('text/html') || !res.ok) return res;
  // index.html（含 SPA 回落）：把站内资源引用换成带版本的路径。它本身绝不能被缓存，
  // 否则部署后浏览器会一直拿着旧前缀、跑旧代码。
  const ver = assetVersion(env);
  const html = (await res.text()).replace(/(href|src)="\/(js|css|shared)\//g, '$1="/v/' + ver + '/$2/');
  const headers = new Headers(res.headers);
  headers.set('cache-control', 'no-store');
  headers.delete('etag');
  headers.delete('content-length');
  return new Response(html, { status: res.status, headers });
}

function noStore(res) {
  const headers = new Headers(res.headers);
  headers.set('cache-control', 'no-store');
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
}
