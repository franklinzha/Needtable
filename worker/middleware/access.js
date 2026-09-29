/**
 * 身份认证中间件：把 Cloudflare Access 的 JWT 换成一个可信的 identity。
 *
 * 这是三道闸门里的第二道。第一道是 Access 本身（未登录者连 index.html 都拿不到），
 * 第三道是 rbac.js 的应用内权限。这一道存在的意义是：万一 Access 应用被误删、
 * 域名被改、或者有人找到了绕过边界的路子，Worker 自己仍然会拒绝。
 */

import { verifyAccessJwt } from '../lib/jwt.js';
import { unauthorized, notConfigured } from '../lib/response.js';
import { t } from '../../public/shared/i18n/i18n.js';

/**
 * @typedef {object} Identity
 * @property {string} email
 * @property {string} sub
 * @property {string} [name]
 * @property {'access' | 'dev-bypass'} via
 */

/**
 * @param {Request} request
 * @param {any} env
 * @returns {Promise<{ identity: Identity } | { response: Response }>}
 */
export async function authenticate(request, env) {
  // 本地开发没有 Access 登录墙，用 .dev.vars 里的 DEV_BYPASS_EMAIL 假装一个用户。
  // 双重 fail-closed：既要 ENVIRONMENT=development，又要变量非空。
  // wrangler.jsonc 里生产环境写死 ENVIRONMENT=production，且 vars 里没有这个键，
  // 所以它在线上永远不可能被触发。
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

  // 配置没填完就拒绝所有请求。宁可整站 503，也不要出现一个「谁都能进」的窗口 ——
  // 部署完成到 Access 配好之间的那几分钟，正是最容易被扫到的时候。
  if (!env.ACCESS_TEAM_DOMAIN || !env.ACCESS_AUD) {
    return { response: notConfigured('ACCESS_TEAM_DOMAIN / ACCESS_AUD 尚未填写') };
  }

  const token = request.headers.get('Cf-Access-Jwt-Assertion');
  if (!token) return { response: unauthorized(t('缺少 Access 身份凭据')) };

  const claims = await verifyAccessJwt(token, env);
  if (!claims) return { response: unauthorized(t('身份凭据无效或已过期')) };

  return {
    identity: {
      email: claims.email.toLowerCase(),
      sub: claims.sub,
      name: claims.name,
      via: 'access',
    },
  };
}
