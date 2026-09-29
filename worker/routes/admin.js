/**
 * 用户管理（仅全站管理员）。
 *
 * 和 scripts/user.mjs 做的是同一件事，只是换成了网页：本站仍然不开放注册，
 * 账号只能由管理员签发。两种开户方式：
 *
 *   · 默认密码（推荐）：管理员页面在浏览器里用默认密码算出 dk 交上来，账号直接可用，
 *     但 must_change_pw = 1 —— 第一次登录必须先改密码，改之前除了改密码什么也做不了。
 *     服务器始终只见到 dk，不见明文。
 *   · 开通链接：只写一行 sha256(一次性令牌) 进 user_invites，把链接交给管理员转发，
 *     密码（和开了动态码时的 TOTP 密钥）在用户点开链接那一刻才产生。
 *     全站开了动态码时只能用这种 —— 默认密码登录的人没有验证器，进不来。
 *
 * 账号等级 admin > pro > plus > normal（见 lib/tiers.js）。normal 不能建东西，
 * 所以不给他建空的默认工作区；以后升级时再补。
 *
 * 管理员不能对自己做停用 / 降级 / 重置：点错一下就把自己锁在门外，
 * 只能回命令行救。真要这么做，用 CLI。
 */

import { json, badRequest, forbidden, notFound, conflict } from '../lib/response.js';
import { t } from '../../public/shared/i18n/i18n.js';
import { newUserId, newWorkspaceId, newBaseId } from '../../public/shared/util/uid.js';
import { keyBetween } from '../../public/shared/model/fracindex.js';
import { invalidateUser, requireWorkspaceRole } from '../middleware/rbac.js';
import { hashLoginKey, newServerSalt, parseDk, PW_VERSION } from '../lib/password.js';
import { totpRequired } from '../lib/settings.js';
import { TIER_NAMES, can } from '../lib/tiers.js';
import { audit } from '../lib/audit.js';
import { revokeRealtime, tablesOfUser } from '../lib/revoke.js';
import { bytesToB64url } from '../../public/shared/util/b64.js';

const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;   // 与 worker/routes/auth.js、scripts/user.mjs 一致
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MAX_NAME = 80;

/** @param {Request} request */
async function readJson(request) {
  try { return await request.json(); } catch { return null; }
}

/** @param {string} text */
async function sha256Hex(text) {
  const bits = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(bits)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** @param {any} c */
const adminOnly = (c) => (c.user.role === 'admin' ? null : forbidden(t('只有管理员能管理用户')));

/**
 * 签发一次性开通链接。同一个人的旧链接一律作废。
 * @param {any} c @param {string} userId @param {string} email @param {'invite'|'reset'} kind
 * @returns {Promise<{ stmts: any[], link: string }>} 语句交给调用方和其它写入放进同一个 batch
 */
async function inviteStatements(c, userId, email, kind) {
  const token = bytesToB64url(crypto.getRandomValues(new Uint8Array(32)));
  const now = Date.now();
  const stmts = [
    c.env.DB.prepare('UPDATE user_invites SET used_at = ? WHERE user_id = ? AND used_at IS NULL').bind(now, userId),
    c.env.DB.prepare(
      `INSERT INTO user_invites (token_hash, user_id, email, kind, created_by, created_at, expires_at)
       VALUES (?,?,?,?,?,?,?)`,
    ).bind(await sha256Hex(token), userId, email, kind, c.user.id, now, now + INVITE_TTL_MS),
  ];
  // 令牌放在路径里：老的 /enroll#<令牌> 常被聊天软件在 # 处截断（对方只打开了 /enroll）。
  // 数据库只存哈希、一次性、7 天过期；Referrer-Policy 是 same-origin，不会外泄给第三方站点。
  return { stmts, link: c.url.origin + '/enroll/' + token };
}

/**
 * 某人的默认工作区（带一个「默认」内容）。
 * @param {any} DB @param {string} userId @param {string} name @param {number} now
 */
export function defaultWorkspaceStatements(DB, userId, name, now) {
  const wsId = newWorkspaceId();
  return [
    DB.prepare('INSERT INTO workspaces (id, name, icon, owner_id, created_at, updated_at) VALUES (?,?,?,?,?,?)')
      .bind(wsId, name + ' 的工作区', '📊', userId, now, now),
    DB.prepare('INSERT INTO workspace_members (workspace_id, user_id, role, created_at) VALUES (?,?,?,?)')
      .bind(wsId, userId, 'owner', now),
    DB.prepare('INSERT INTO bases (id, workspace_id, name, icon, ordinal, created_at, updated_at) VALUES (?,?,?,?,?,?,?)')
      .bind(newBaseId(), wsId, '默认', '📁', keyBetween(null, null), now, now),
  ];
}

/**
 * 能建东西的人如果一个自己的工作区都没有（刚从 normal 升上来），补一个。
 * @param {any} env @param {{ id: string, name: string|null, email: string, role: string }} user
 * @returns {Promise<boolean>} 是否新建了
 */
export async function ensureDefaultWorkspace(env, user) {
  if (!can(user, 'create')) return false;
  const own = await env.DB.prepare('SELECT 1 AS x FROM workspaces WHERE owner_id = ? LIMIT 1').bind(user.id).first();
  if (own) return false;
  await env.DB.batch(defaultWorkspaceStatements(env.DB, user.id, user.name || user.email.split('@')[0], Date.now()));
  return true;
}

/**
 * 把 dk 换成服务器端存的哈希。
 * @param {any} env @param {unknown} raw
 * @returns {Promise<{ hash: string, salt: string } | null | { error: Response }>} 没带 dk 返回 null
 */
async function passwordFromDk(env, raw) {
  if (raw === undefined || raw === null) return null;
  const dk = parseDk(raw);
  if (!dk) return { error: badRequest(t('口令派生数据格式不正确')) };
  if (await totpRequired(env)) {
    return { error: badRequest(t('全站已开启动态码，默认密码登录的人没有验证器，请改用开通链接')) };
  }
  const salt = newServerSalt();
  return { hash: await hashLoginKey(dk, salt, env), salt };
}

/** @param {unknown} v @returns {string | null} */
const tierFrom = (v) => (typeof v === 'string' && TIER_NAMES.includes(v) ? v : null);

/** @param {any} c @param {string} id */
async function findUser(c, id) {
  return c.env.DB.prepare('SELECT id, email, name, role, status, pw_hash FROM users WHERE id = ?').bind(id).first();
}

/** GET /api/admin/users */
export async function listUsers(/** @type {Request} */ request, /** @type {any} */ c) {
  const deny = adminOnly(c); if (deny) return deny;
  const { results } = await c.env.DB.prepare(
    `SELECT u.id, u.email, u.name, u.role, u.status, u.last_seen_at, u.created_at, u.locked_until,
            u.pw_hash IS NOT NULL AS has_pw, u.totp_secret IS NOT NULL AS has_totp, u.must_change_pw,
            (SELECT COUNT(*) FROM user_invites i
              WHERE i.user_id = u.id AND i.used_at IS NULL AND i.expires_at > ?) AS pending_invites
       FROM users u ORDER BY u.created_at`,
  ).bind(Date.now()).all();
  return json({
    users: (results ?? []).map((/** @type {any} */ r) => ({
      id: r.id, email: r.email, name: r.name, role: r.role, status: r.status,
      lastSeenAt: Number(r.last_seen_at ?? 0), createdAt: Number(r.created_at ?? 0),
      locked: Number(r.locked_until ?? 0) > Date.now(),
      hasPassword: !!r.has_pw, hasTotp: !!r.has_totp, pendingInvite: Number(r.pending_invites) > 0,
      mustChange: Number(r.must_change_pw ?? 0) === 1,
      me: r.id === c.user.id,
    })),
  });
}

/**
 * POST /api/admin/users — body: { email, name?, role?, dk?, shareWorkspaceId?, shareRole? }
 *
 * 带 dk（默认密码派生）就直接开好、首次登录强制改密；不带就发开通链接。
 * 能建东西的等级顺手建一个他自己的默认工作区（否则第一次进来是个什么都干不了的空界面）；
 * 带了 shareWorkspaceId 就同时把他拉进那个工作区 —— 「加个同事一起编辑」是最常见的用法。
 */
export async function createUser(/** @type {Request} */ request, /** @type {any} */ c) {
  const deny = adminOnly(c); if (deny) return deny;
  const body = await readJson(request);
  const email = String(body?.email ?? '').trim().toLowerCase();
  if (!EMAIL_RE.test(email) || email.length > 254) return badRequest(t('邮箱格式不对'));
  const name = String(body?.name ?? '').trim().slice(0, MAX_NAME) || email.split('@')[0];
  if (body?.role !== undefined && !tierFrom(body.role)) return badRequest(t('等级只能是 admin、pro、plus 或 normal'));
  const role = tierFrom(body?.role) ?? 'plus';
  const shareRole = body?.shareRole === 'viewer' ? 'viewer' : 'editor';
  const shareWs = typeof body?.shareWorkspaceId === 'string' && body.shareWorkspaceId ? body.shareWorkspaceId : null;

  if (shareWs) {
    const gate = await requireWorkspaceRole(c.env, c.user, shareWs, 'owner');
    if ('response' in gate) return gate.response;
  }
  if (await c.env.DB.prepare('SELECT 1 AS x FROM users WHERE email = ?').bind(email).first()) {
    return conflict(t('这个邮箱已经有账号了。要重新发开通链接，请在列表里点「重置」'));
  }

  const pw = await passwordFromDk(c.env, body?.dk);
  if (pw && 'error' in pw) return pw.error;

  const now = Date.now();
  const userId = newUserId();
  const DB = c.env.DB;
  const invite = pw ? null : await inviteStatements(c, userId, email, 'invite');
  const status = pw ? 'active' : 'pending';
  await DB.batch([
    DB.prepare(
      `INSERT INTO users (id, email, name, access_sub, role, created_at, last_seen_at,
                          status, session_epoch, pw_version, pw_updated_at, totp_last_step,
                          failed_count, locked_until, pw_hash, pw_salt, must_change_pw)
       VALUES (?,?,?,NULL,?,?,?,?,1,?,?,0,0,0,?,?,?)`,
    ).bind(userId, email, name, role, now, now, status, PW_VERSION, pw ? now : 0,
      pw?.hash ?? null, pw?.salt ?? null, pw ? 1 : 0),
    ...(can({ role }, 'create') ? defaultWorkspaceStatements(DB, userId, name, now) : []),
    ...(shareWs ? [DB.prepare('INSERT INTO workspace_members (workspace_id, user_id, role, created_at) VALUES (?,?,?,?)')
      .bind(shareWs, userId, shareRole, now)] : []),
    ...(invite?.stmts ?? []),
  ]);

  audit(c.env, c.ctx, {
    actorId: c.user.id, actorEmail: c.user.email, action: 'user.create',
    targetType: 'user', targetId: userId,
    meta: { email, role, via: pw ? 'default-password' : 'link', shareWs, shareRole: shareWs ? shareRole : null }, request,
  });
  return json({
    user: { id: userId, email, name, role, status, mustChange: !!pw },
    ...(invite ? { link: invite.link } : {}),
  }, 201);
}

/**
 * POST /api/admin/users/:id/reset — body: { dk? }
 * 旧密码、旧验证器、已登录的设备全部立即失效。带 dk 就重置成默认密码（首次登录强制改），
 * 否则发一条新链接。
 */
export async function resetUser(/** @type {Request} */ request, /** @type {any} */ c) {
  const deny = adminOnly(c); if (deny) return deny;
  if (c.params.id === c.user.id) return forbidden(t('不能重置自己 —— 会把自己锁在门外。请用命令行 scripts/user.mjs reset'));
  const u = await findUser(c, c.params.id);
  if (!u) return notFound(t('用户不存在'));
  const body = await readJson(request);
  const pw = await passwordFromDk(c.env, body?.dk);
  if (pw && 'error' in pw) return pw.error;
  if (pw && u.status === 'disabled') return badRequest(t('这个账号已被停用，请先恢复再重置'));

  if (pw) {
    const now = Date.now();
    await c.env.DB.batch([
      c.env.DB.prepare(
        `UPDATE users SET pw_hash = ?, pw_salt = ?, pw_version = ?, pw_updated_at = ?,
                totp_secret = NULL, totp_last_step = 0, status = 'active', must_change_pw = 1,
                session_epoch = session_epoch + 1, failed_count = 0, locked_until = 0
          WHERE id = ?`,
      ).bind(pw.hash, pw.salt, PW_VERSION, now, u.id),
      // 之前发出去的开通链接一并作废
      c.env.DB.prepare('UPDATE user_invites SET used_at = ? WHERE user_id = ? AND used_at IS NULL').bind(now, u.id),
    ]);
    invalidateUser(u.email);
    revokeRealtime(c.env, c.ctx, u.id, await tablesOfUser(c.env, u.id));
    audit(c.env, c.ctx, {
      actorId: c.user.id, actorEmail: c.user.email, action: 'user.reset',
      targetType: 'user', targetId: u.id, meta: { email: u.email, via: 'default-password' }, request,
    });
    return json({ ok: true, mustChange: true });
  }

  const { stmts, link } = await inviteStatements(c, u.id, u.email, 'reset');
  await c.env.DB.batch([
    c.env.DB.prepare(
      `UPDATE users SET pw_hash = NULL, pw_salt = NULL, pw_updated_at = 0,
              totp_secret = NULL, totp_last_step = 0, status = 'pending',
              session_epoch = session_epoch + 1, failed_count = 0, locked_until = 0
        WHERE id = ?`,
    ).bind(u.id),
    ...stmts,
  ]);
  invalidateUser(u.email);
  revokeRealtime(c.env, c.ctx, u.id, await tablesOfUser(c.env, u.id));
  audit(c.env, c.ctx, {
    actorId: c.user.id, actorEmail: c.user.email, action: 'user.reset',
    targetType: 'user', targetId: u.id, meta: { email: u.email }, request,
  });
  return json({ ok: true, link });
}

/** PATCH /api/admin/users/:id — body: { status?: 'active'|'disabled', role?: 'admin'|'pro'|'plus'|'normal', name? } */
export async function updateUser(/** @type {Request} */ request, /** @type {any} */ c) {
  const deny = adminOnly(c); if (deny) return deny;
  const body = await readJson(request);
  const u = await findUser(c, c.params.id);
  if (!u) return notFound(t('用户不存在'));

  const self = u.id === c.user.id;
  /** @type {any[]} */ const stmts = [];
  let kick = false;

  if (body?.status !== undefined) {
    if (body.status !== 'active' && body.status !== 'disabled') return badRequest(t('status 只能是 active 或 disabled'));
    if (self) return forbidden(t('不能停用自己'));
    if (body.status === 'disabled') {
      // session_epoch + 1 才是真正把人踢下线的那一下
      stmts.push(c.env.DB.prepare("UPDATE users SET status = 'disabled', session_epoch = session_epoch + 1 WHERE id = ?").bind(u.id));
      kick = true;
    } else {
      // 还没设过密码的恢复成待开通
      stmts.push(c.env.DB.prepare('UPDATE users SET status = ?, failed_count = 0, locked_until = 0 WHERE id = ?')
        .bind(u.pw_hash ? 'active' : 'pending', u.id));
    }
  }
  if (body?.role !== undefined) {
    if (!tierFrom(body.role)) return badRequest(t('等级只能是 admin、pro、plus 或 normal'));
    if (self && body.role !== 'admin') return forbidden(t('不能取消自己的管理员身份'));
    stmts.push(c.env.DB.prepare('UPDATE users SET role = ? WHERE id = ?').bind(body.role, u.id));
  }
  if (body?.name !== undefined) {
    const name = String(body.name).trim().slice(0, MAX_NAME);
    if (!name) return badRequest(t('名字不能为空'));
    stmts.push(c.env.DB.prepare('UPDATE users SET name = ? WHERE id = ?').bind(name, u.id));
  }
  if (!stmts.length) return badRequest(t('没有要修改的内容'));

  await c.env.DB.batch(stmts);
  invalidateUser(u.email);
  // 从 normal 升上来的人还没有自己的工作区
  if (body?.role !== undefined) await ensureDefaultWorkspace(c.env, await findUser(c, u.id));
  if (kick) revokeRealtime(c.env, c.ctx, u.id, await tablesOfUser(c.env, u.id));
  audit(c.env, c.ctx, {
    actorId: c.user.id, actorEmail: c.user.email, action: 'user.update',
    targetType: 'user', targetId: u.id,
    meta: { email: u.email, status: body.status, role: body.role }, request,
  });
  const row = await findUser(c, u.id);
  return json({ user: { id: row.id, email: row.email, name: row.name, role: row.role, status: row.status } });
}
