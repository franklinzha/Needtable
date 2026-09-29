/**
 * 当前用户。前端启动的第一个请求就是它 —— 拿不到就说明鉴权链断了。
 *
 * via 说明这个身份是怎么来的：'password'（自建登录页）、'access'（Cloudflare
 * Access）、'dev-bypass'（本地开发）。顶栏靠它决定要不要显示退出按钮：
 * Access 模式下的登出得去 Access 那边做，站内点了也没用。
 */

import { json, badRequest, unauthorized, tooManyRequests } from '../lib/response.js';
import { t } from '../../public/shared/i18n/i18n.js';
import { hashLoginKey, verifyLoginKey, newServerSalt, parseDk, PW_VERSION } from '../lib/password.js';
import { signSession, sessionCookieHeader, withCookie } from '../lib/session.js';
import { invalidateUser } from '../middleware/rbac.js';
import { revokeRealtime, tablesOfUser } from '../lib/revoke.js';
import { consume } from '../middleware/ratelimit.js';
import { can, grantableRoles, tierOf } from '../lib/tiers.js';
import { audit } from '../lib/audit.js';
import { themeView } from './theme.js';
import { myLang } from './lang.js';

/** @param {Request} request @param {import('../lib/router.js').RequestContext} c */
export async function getMe(request, c) {
  const { results } = await c.env.DB.prepare(
    `SELECT w.id, w.name, w.icon, m.role
       FROM workspaces w
       JOIN workspace_members m ON m.workspace_id = w.id
      WHERE m.user_id = ?
      ORDER BY w.created_at ASC`,
  ).bind(c.user.id).all();

  const tier = tierOf(c.user);
  return json({
    user: {
      id: c.user.id,
      email: c.user.email,
      name: c.user.name,
      role: c.user.role,
      via: c.identity.via,
      mustChange: !!c.user.mustChange,
      // 账号等级能做什么：前端据此显示 / 隐藏「新建」「分享」，服务端照样会再查一遍
      tier: {
        name: tier.name, label: tier.label,
        create: can(c.user, 'create'), share: can(c.user, 'share'),
        grantable: grantableRoles(c.user),
        maxWorkspaces: Number.isFinite(tier.maxWorkspaces) ? tier.maxWorkspaces : null,
      },
    },
    workspaces: results ?? [],
    theme: await themeView(c.env, c.user.id),
    lang: await myLang(c.env, c.user.id),
    app: { name: c.env.APP_NAME ?? 'Needtable', environment: c.env.ENVIRONMENT ?? 'production' },
  });
}

/** @param {Request} request */
async function readJson(request) {
  try { return await request.json(); } catch { return null; }
}

/**
 * POST /api/me/password — body: { oldDk, newDk }
 *
 * 两个 dk 都是浏览器用 deriveLoginKey(密码, 邮箱) 算出来的，服务器不见明文。
 * 改完 session_epoch + 1：别的设备上的登录全部失效，当前这台换一张新 Cookie 接着用。
 */
export async function changePassword(/** @type {Request} */ request, /** @type {any} */ c) {
  if (c.identity.via !== 'password') return badRequest(t('当前登录方式不使用本站密码'));
  const gate = consume('pw:' + c.user.id, { capacity: 6, refillPerSec: 0.02 });
  if (!gate.ok) return tooManyRequests(gate.retryAfter);

  const body = await readJson(request);
  const oldDk = parseDk(body?.oldDk);
  const newDk = parseDk(body?.newDk);
  if (!oldDk || !newDk) return badRequest(t('口令派生数据格式不正确'));
  if (body.oldDk === body.newDk) return badRequest(t('新密码不能和原密码相同'));

  const row = await c.env.DB.prepare('SELECT pw_hash, pw_salt, session_epoch FROM users WHERE id = ?').bind(c.user.id).first();
  if (!row?.pw_hash || !(await verifyLoginKey(oldDk, row.pw_salt, row.pw_hash, c.env))) {
    return unauthorized(t('原密码不正确'));
  }

  const salt = newServerSalt();
  const hash = await hashLoginKey(newDk, salt, c.env);
  const epoch = Number(row.session_epoch ?? 1) + 1;
  await c.env.DB.prepare(
    `UPDATE users SET pw_hash = ?, pw_salt = ?, pw_version = ?, pw_updated_at = ?,
            must_change_pw = 0, session_epoch = ?, failed_count = 0, locked_until = 0
      WHERE id = ?`,
  ).bind(hash, salt, PW_VERSION, Date.now(), epoch, c.user.id).run();
  invalidateUser(c.user.email);
  revokeRealtime(c.env, c.ctx, c.user.id, await tablesOfUser(c.env, c.user.id));
  audit(c.env, c.ctx, {
    actorId: c.user.id, actorEmail: c.user.email, action: 'user.password',
    targetType: 'user', targetId: c.user.id, meta: {}, request,
  });

  const token = await signSession({ id: c.user.id, email: c.user.email, session_epoch: epoch }, c.env);
  return withCookie(json({ ok: true }), sessionCookieHeader(token, c.url));
}
