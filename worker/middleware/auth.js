/**
 * 认证分发器。
 *
 * 项目原本走 Cloudflare Access 边界认证，但 Zero Trust 要求账户绑定信用卡，
 * 这条路对本项目的使用者是堵死的。于是把登录墙搬进应用自己：
 * 口令 + TOTP，账号由管理员签发，不开放注册。
 *
 * Access 那套代码一行没删，用 AUTH_MODE 这个 var 切换：
 *   "password"（默认）  自建登录页 + 会话 Cookie
 *   "access"            Cloudflare Access JWT（原方案，哪天有卡了改这一个词）
 *
 * 不管走哪条路，出口都是同一个 identity 对象，后面的中间件与路由感知不到区别。
 */

import { unauthorized, notConfigured } from '../lib/response.js';
import { t } from '../../public/shared/i18n/i18n.js';
import { authenticate as accessAuthenticate } from './access.js';
import { readSessionCookie, verifySession } from '../lib/session.js';

/**
 * @typedef {object} Identity
 * @property {string} email
 * @property {string} sub
 * @property {string} [name]
 * @property {'access' | 'password' | 'dev-bypass'} via
 */

/** @param {any} env @returns {'password' | 'access'} */
export function authMode(env) {
  return env.AUTH_MODE === 'access' ? 'access' : 'password';
}

/**
 * @param {Request} request @param {URL} url @param {any} env
 * @returns {Promise<{ identity: Identity, session?: import('../lib/session.js').SessionPayload }
 *                   | { response: Response }>}
 */
export async function authenticate(request, url, env) {
  // 本地开发的旁路。双重 fail-closed：既要 ENVIRONMENT=development，
  // 又要 .dev.vars 里显式写了邮箱。生产的 wrangler.jsonc 里两个条件都不成立。
  if (env.ENVIRONMENT === 'development' && env.DEV_BYPASS_EMAIL) {
    return {
      identity: {
        email: String(env.DEV_BYPASS_EMAIL).toLowerCase(),
        sub: 'dev|' + env.DEV_BYPASS_EMAIL,
        name: env.DEV_BYPASS_NAME || '本地开发者',
        via: 'dev-bypass',
      },
    };
  }

  if (authMode(env) === 'access') {
    const result = await accessAuthenticate(request, env);
    return 'response' in result ? result : { identity: result.identity };
  }

  // 密钥没配就整站 503。部署完成到密钥就位之间的窗口，正是最容易被扫到的时候，
  // 宁可不可用也不放行 —— 与原方案对 Access 配置的处理一致。
  if (!env.SESSION_SECRET || !env.AUTH_PEPPER) {
    return { response: notConfigured('SESSION_SECRET / AUTH_PEPPER 尚未设置') };
  }

  const token = readSessionCookie(request, url);
  if (!token) return { response: unauthorized(t('需要登录')) };

  const session = await verifySession(token, env);
  if (!session) return { response: unauthorized(t('登录已过期')) };

  return {
    identity: { email: session.email, sub: session.uid, via: 'password' },
    session,
  };
}
