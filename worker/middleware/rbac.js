/**
 * 应用内身份与权限（三道闸门的第三道）。
 *
 * 一个关键的额度考虑：用户解析是**每个请求**都要做的事，如果每次都往 D1 写一次
 * last_seen_at，50 个用户就能轻松打满 D1 免费额度的 10 万行写入/天。
 * 所以这里做两层节流：
 *   1. isolate 内存缓存 60 秒 —— 绝大多数请求连 D1 读都不做
 *   2. last_seen_at 每小时最多写一次
 * 缓存也不用 KV，因为 KV 免费额度只有 1000 写/天，比 D1 还紧。
 *
 * 代价：角色变更、停用账号最多 60 秒后生效。自建口令登录之后这个数字不能再大了 ——
 * 「立刻踢掉某个人」是管理员真会用到的操作。
 */

import { newUserId, newWorkspaceId, newBaseId } from '../../public/shared/util/uid.js';
import { keyBetween } from '../../public/shared/model/fracindex.js';
import { forbidden, notFound } from '../lib/response.js';
import { t } from '../../public/shared/i18n/i18n.js';
import { RANK } from '../lib/tiers.js';

// 60 秒而不是 5 分钟：口令模式下「停用账号」「重置口令」要能很快生效。
// 代价是每分钟每 isolate 多一次 D1 读 —— 读的免费额度是 5M/天，无所谓。
const USER_TTL_MS = 60 * 1000;
const LAST_SEEN_THROTTLE_MS = 60 * 60 * 1000;

/**
 * @typedef {object} AppUser
 * @property {string} id
 * @property {string} email
 * @property {string | null} name
 * @property {string} role  用户等级 admin | pro | plus | normal（见 lib/tiers.js）
 * @property {string} status  active | pending | disabled
 * @property {number} sessionEpoch  会话代次，用于吊销已签发的 Cookie
 * @property {boolean} [mustChange]  管理员设的默认密码还没改：除了改密码什么都不让做
 */

/** @type {Map<string, { expiresAt: number, user: AppUser }>} */
const userMemo = new Map();

/**
 * 首次登录时开账号，顺带建一个默认工作区和一个默认 base，
 * 否则用户进来会看到一个什么都干不了的空界面。
 * @param {{ email: string, sub: string, name?: string }} identity
 * @param {any} env
 * @returns {Promise<AppUser>}
 */
async function provisionUser(identity, env) {
  const now = Date.now();
  const userId = newUserId();
  const workspaceId = newWorkspaceId();
  const baseId = newBaseId();

  // 第一个登录的人是管理员，之后的都是 plus（能建表、能分享）
  const countRow = await env.DB.prepare('SELECT COUNT(*) AS n FROM users').first();
  const role = (countRow?.n ?? 0) === 0 ? 'admin' : 'plus';
  const name = identity.name || identity.email.split('@')[0];
  const firstKey = keyBetween(null, null);

  await env.DB.batch([
    env.DB.prepare(
      'INSERT INTO users (id, email, name, access_sub, role, created_at, last_seen_at) VALUES (?,?,?,?,?,?,?)',
    ).bind(userId, identity.email, name, identity.sub, role, now, now),

    env.DB.prepare(
      'INSERT INTO workspaces (id, name, icon, owner_id, created_at, updated_at) VALUES (?,?,?,?,?,?)',
    ).bind(workspaceId, name + ' 的工作区', '📊', userId, now, now),

    env.DB.prepare(
      'INSERT INTO workspace_members (workspace_id, user_id, role, created_at) VALUES (?,?,?,?)',
    ).bind(workspaceId, userId, 'owner', now),

    env.DB.prepare(
      'INSERT INTO bases (id, workspace_id, name, icon, ordinal, created_at, updated_at) VALUES (?,?,?,?,?,?,?)',
    ).bind(baseId, workspaceId, '默认', '📁', firstKey, now, now),
  ]);

  return { id: userId, email: identity.email, name, role, status: 'active', sessionEpoch: 1 };
}

/**
 * 把外部身份映射成本地用户。
 * Access / 本地旁路身份在首次登录时开户；口令身份不会 —— 那条路不开放注册。
 * @param {{ email: string, sub: string, name?: string, via?: string }} identity
 * @param {any} env
 * @returns {Promise<AppUser | null>} null 表示这个身份在本地没有对应账号
 */
export async function resolveUser(identity, env) {
  const cached = userMemo.get(identity.email);
  if (cached && cached.expiresAt > Date.now()) return cached.user;

  const row = await env.DB.prepare(
    'SELECT id, email, name, role, status, session_epoch, last_seen_at, must_change_pw FROM users WHERE email = ?',
  ).bind(identity.email).first();

  /** @type {AppUser} */
  let user;
  if (!row) {
    // 口令模式下不开放注册 —— 账号只能由管理员用 scripts/user.mjs 签发。
    // 会话 Cookie 是自校验的，用户行被删掉之后旧 Cookie 还能验签通过，
    // 所以这里必须明确拒绝，不能顺手把人建回来。
    if (identity.via === 'password') return null;
    user = await provisionUser(identity, env);
  } else {
    user = {
      id: row.id, email: row.email, name: row.name, role: row.role,
      status: row.status ?? 'active', sessionEpoch: Number(row.session_epoch ?? 1),
      mustChange: Number(row.must_change_pw ?? 0) === 1,
    };
    // 每小时最多写一次，避免每请求一次 D1 写入
    if (Date.now() - Number(row.last_seen_at ?? 0) > LAST_SEEN_THROTTLE_MS) {
      await env.DB.prepare('UPDATE users SET last_seen_at = ?, access_sub = ? WHERE id = ?')
        .bind(Date.now(), identity.sub, user.id).run();
    }
  }

  userMemo.set(identity.email, { expiresAt: Date.now() + USER_TTL_MS, user });
  return user;
}

/**
 * 校验用户在某工作区的角色（完整成员才算；只被分享了其中某个内容 / 某张表的人不算）。
 * @param {any} env @param {AppUser} user @param {string} workspaceId
 * @param {'viewer'|'editor'|'manager'|'owner'} min
 * @returns {Promise<{ role: string, scope: string | null } | { response: Response }>}
 */
export async function requireWorkspaceRole(env, user, workspaceId, min) {
  const row = await env.DB.prepare(
    'SELECT role, scope FROM workspace_members WHERE workspace_id = ? AND user_id = ?',
  ).bind(workspaceId, user.id).first();

  if (!row) {
    if (user.role === 'admin' && await env.DB.prepare('SELECT 1 FROM workspaces WHERE id = ?').bind(workspaceId).first()) {
      return RANK.viewer < RANK[min] ? { response: forbidden(t('管理员监控只能查看')) } : { ...ADMIN_WATCH };
    }
    // 不暴露"这个工作区存在但你没权限"，统一按不存在处理
    return { response: notFound(t('工作区不存在')) };
  }
  if (RANK[row.role] < RANK[min]) {
    return { response: forbidden(t('需要 {min} 及以上权限', { min })) };
  }
  return { role: row.role, scope: row.scope ?? null };
}

/**
 * 校验用户对某个内容（base）的角色。内容级授权优先，缺省继承工作区角色。
 * @param {any} env @param {AppUser} user @param {string} baseId
 * @param {'viewer'|'editor'|'manager'|'owner'} min
 * @returns {Promise<{ role: string, scope: string | null, workspaceId: string, via: string } | { response: Response }>}
 */
export async function requireBaseRole(env, user, baseId, min) {
  const row = await env.DB.prepare(
    `SELECT b.workspace_id AS workspace_id, m.role AS m_role, m.scope AS m_scope,
            a.role AS b_role, a.scope AS b_scope
       FROM bases b
       LEFT JOIN base_acl a ON a.base_id = b.id AND a.user_id = ?
       LEFT JOIN workspace_members m ON m.workspace_id = b.workspace_id AND m.user_id = ?
      WHERE b.id = ?`,
  ).bind(user.id, user.id, baseId).first();

  if (!row) return { response: notFound(t('内容不存在')) };
  const eff = effectiveOf(row) ?? watchOf(user);
  if (!eff) return { response: notFound(t('内容不存在')) };
  if (RANK[eff.role] < RANK[min]) return { response: forbidden(t('需要 {min} 及以上权限', { min })) };
  return { ...eff, workspaceId: row.workspace_id };
}

/**
 * 校验用户对某张表的角色。**最具体的授权胜出**：表级 > 内容级 > 工作区级。
 * 工作区 owner 例外 —— 谁也不能在他自己的工作区里把他降级。
 * @param {any} env @param {AppUser} user @param {string} tableId
 * @param {'viewer'|'editor'|'manager'|'owner'} min
 * @returns {Promise<{ role: string, scope: string | null, via: string, workspaceId: string, baseId: string } | { response: Response }>}
 */
export async function requireTableRole(env, user, tableId, min) {
  const row = await env.DB.prepare(
    `SELECT t.workspace_id AS workspace_id, t.base_id AS base_id,
            a.role AS t_role, a.scope AS t_scope,
            b.role AS b_role, b.scope AS b_scope,
            m.role AS m_role, m.scope AS m_scope
       FROM tables t
       LEFT JOIN table_acl a ON a.table_id = t.id AND a.user_id = ?
       LEFT JOIN base_acl b ON b.base_id = t.base_id AND b.user_id = ?
       LEFT JOIN workspace_members m ON m.workspace_id = t.workspace_id AND m.user_id = ?
      WHERE t.id = ?`,
  ).bind(user.id, user.id, user.id, tableId).first();

  if (!row) return { response: notFound(t('表不存在')) };
  const eff = effectiveOf(row) ?? watchOf(user);
  if (!eff) return { response: notFound(t('表不存在')) };
  if (RANK[eff.role] < RANK[min]) {
    return { response: forbidden(t('需要 {min} 及以上权限', { min })) };
  }
  return { ...eff, workspaceId: row.workspace_id, baseId: row.base_id };
}

/**
 * 管理员监控：admin 对没被分享给他的资源也有只读权限（查看全站工作区用）。
 * via: 'admin' 让前端知道这是监控视角，不是真的被分享了。
 */
const ADMIN_WATCH = Object.freeze({ role: 'viewer', scope: null, via: 'admin' });

/** @param {AppUser} user */
function watchOf(user) {
  return user.role === 'admin' ? { ...ADMIN_WATCH } : null;
}

/**
 * 三级授权按「最具体胜出」取一个。t_* 表级、b_* 内容级、m_* 工作区级，缺哪级就是 null。
 * @param {any} row @returns {{ role: string, scope: string | null, via: string } | null}
 */
export function effectiveOf(row) {
  if (row.m_role === 'owner') return { role: 'owner', scope: null, via: 'workspace' };
  if (row.t_role) return { role: String(row.t_role), scope: row.t_scope ?? null, via: 'table' };
  if (row.b_role) return { role: String(row.b_role), scope: row.b_scope ?? null, via: 'base' };
  if (row.m_role) return { role: String(row.m_role), scope: row.m_scope ?? null, via: 'workspace' };
  return null;
}

/**
 * 某人能看到的全部表（带有效角色）。三路来源合并：工作区成员、内容级授权、表级授权。
 * 用 IN 子查询限定范围，不去扫全站的 tables。
 * @param {any} env @param {string} userId @param {string} [workspaceId] 只要某个工作区里的
 */
export async function visibleTables(env, userId, workspaceId) {
  const { results } = await env.DB.prepare(
    `SELECT t.id, t.workspace_id, t.base_id, t.name, t.icon, t.kind, t.ordinal, t.row_count, t.updated_at,
            a.role AS t_role, a.scope AS t_scope,
            b.role AS b_role, b.scope AS b_scope,
            m.role AS m_role, m.scope AS m_scope
       FROM tables t
       LEFT JOIN table_acl a ON a.table_id = t.id AND a.user_id = ?1
       LEFT JOIN base_acl b ON b.base_id = t.base_id AND b.user_id = ?1
       LEFT JOIN workspace_members m ON m.workspace_id = t.workspace_id AND m.user_id = ?1
      WHERE (t.workspace_id IN (SELECT workspace_id FROM workspace_members WHERE user_id = ?1)
             OR t.base_id IN (SELECT base_id FROM base_acl WHERE user_id = ?1)
             OR t.id IN (SELECT table_id FROM table_acl WHERE user_id = ?1))
        AND (?2 IS NULL OR t.workspace_id = ?2)
      ORDER BY t.ordinal`,
  ).bind(userId, workspaceId ?? null).all();
  /** @type {any[]} */ const out = [];
  for (const r of results ?? []) {
    const eff = effectiveOf(r);
    if (!eff) continue;
    out.push({
      id: r.id, workspace_id: r.workspace_id, base_id: r.base_id, name: r.name, icon: r.icon,
      kind: r.kind, ordinal: r.ordinal, row_count: r.row_count, updated_at: r.updated_at,
      role: eff.role, scope: eff.scope, via: eff.via,
    });
  }
  return out;
}

/**
 * 某人能看到的整棵树：工作区 → 内容 → 表。
 * 完整成员看到工作区里的一切；只被分享了某个内容或某张表的人，工作区标成 partial，
 * 里面只列他够得着的那几项（表所在的内容作为容器一起列出，但不代表对内容有权限）。
 * @param {any} env @param {string} userId @param {string} [workspaceId]
 */
export async function accessibleTree(env, userId, workspaceId) {
  const wsFilter = workspaceId ?? null;
  const [members, baseAcl, tables] = await Promise.all([
    env.DB.prepare(
      `SELECT w.id, w.name, w.icon, w.owner_id, w.created_at, w.updated_at, m.role, m.scope,
              u.name AS owner_name, u.email AS owner_email
         FROM workspace_members m JOIN workspaces w ON w.id = m.workspace_id
         LEFT JOIN users u ON u.id = w.owner_id
        WHERE m.user_id = ?1 AND (?2 IS NULL OR w.id = ?2)
        ORDER BY w.created_at`,
    ).bind(userId, wsFilter).all(),
    env.DB.prepare(
      `SELECT a.base_id, a.role, a.scope FROM base_acl a JOIN bases b ON b.id = a.base_id
        WHERE a.user_id = ?1 AND (?2 IS NULL OR b.workspace_id = ?2)`,
    ).bind(userId, wsFilter).all(),
    visibleTables(env, userId, workspaceId),
  ]);

  /** @type {Map<string, any>} */ const wsMap = new Map();
  for (const w of members.results ?? []) wsMap.set(w.id, { ...w, partial: false });
  const baseRole = new Map((baseAcl.results ?? []).map((/** @type {any} */ r) => [r.base_id, r]));

  // 需要列出的内容：完整成员的工作区里的全部 + 单独授权的 + 可见表所在的
  const wantBases = new Set([...baseRole.keys(), ...tables.map((t) => t.base_id)]);
  const bases = await loadBases(env, [...wsMap.keys()], [...wantBases]);

  // 部分可见的工作区：补上名称
  const partialIds = [...new Set(bases.map((b) => b.workspace_id))].filter((id) => !wsMap.has(id));
  if (partialIds.length) {
    const { results } = await env.DB.prepare(
      `SELECT w.id, w.name, w.icon, w.owner_id, w.created_at, w.updated_at,
              u.name AS owner_name, u.email AS owner_email
         FROM workspaces w LEFT JOIN users u ON u.id = w.owner_id
        WHERE w.id IN (SELECT value FROM json_each(?))`,
    ).bind(JSON.stringify(partialIds)).all();
    for (const w of results ?? []) wsMap.set(w.id, { ...w, role: null, scope: null, partial: true });
  }

  /** @type {Map<string, any[]>} */ const byBase = new Map();
  for (const t of tables) {
    if (!byBase.has(t.base_id)) byBase.set(t.base_id, []);
    byBase.get(t.base_id)?.push(t);
  }
  const workspaces = [...wsMap.values()].map((w) => ({ ...w, bases: /** @type {any[]} */ ([]) }));
  const wsById = new Map(workspaces.map((w) => [w.id, w]));
  for (const b of bases) {
    const w = wsById.get(b.workspace_id);
    if (!w) continue;
    const acl = baseRole.get(b.id);
    const eff = effectiveOf({ m_role: w.role, m_scope: w.scope, b_role: acl?.role, b_scope: acl?.scope })
      ?? { role: null, scope: null, via: 'container' };
    w.bases.push({ ...b, ...eff, tables: byBase.get(b.id) ?? [] });
  }
  return workspaces;
}

/**
 * 管理员监控：自己不是完整成员的那些工作区，整棵树都列出来（只读）。
 * 自己在其中某张表 / 某个内容上本来就有授权的，按本来的权限；其余一律 viewer（via 'admin'）。
 * @param {any} env @param {string} userId @param {string} [workspaceId]
 */
export async function monitorTree(env, userId, workspaceId) {
  const wsFilter = workspaceId ?? null;
  const { results: wsRows } = await env.DB.prepare(
    `SELECT w.id, w.name, w.icon, w.owner_id, w.created_at, w.updated_at,
            u.name AS owner_name, u.email AS owner_email
       FROM workspaces w LEFT JOIN users u ON u.id = w.owner_id
      WHERE (?2 IS NULL OR w.id = ?2)
        AND w.id NOT IN (SELECT workspace_id FROM workspace_members WHERE user_id = ?1)
      ORDER BY u.email, w.created_at`,
  ).bind(userId, wsFilter).all();
  const ws = wsRows ?? [];
  if (!ws.length) return [];
  const ids = JSON.stringify(ws.map((/** @type {any} */ w) => w.id));
  const [bases, tables] = await Promise.all([
    env.DB.prepare(
      `SELECT b.id, b.workspace_id, b.name, b.icon, b.ordinal, a.role AS b_role, a.scope AS b_scope
         FROM bases b LEFT JOIN base_acl a ON a.base_id = b.id AND a.user_id = ?2
        WHERE b.workspace_id IN (SELECT value FROM json_each(?1)) ORDER BY b.ordinal`,
    ).bind(ids, userId).all(),
    env.DB.prepare(
      `SELECT t.id, t.workspace_id, t.base_id, t.name, t.icon, t.kind, t.ordinal, t.row_count, t.updated_at,
              a.role AS t_role, a.scope AS t_scope, b.role AS b_role, b.scope AS b_scope
         FROM tables t
         LEFT JOIN table_acl a ON a.table_id = t.id AND a.user_id = ?2
         LEFT JOIN base_acl b ON b.base_id = t.base_id AND b.user_id = ?2
        WHERE t.workspace_id IN (SELECT value FROM json_each(?1)) ORDER BY t.ordinal`,
    ).bind(ids, userId).all(),
  ]);
  /** @type {Map<string, any[]>} */ const byBase = new Map();
  for (const r of tables.results ?? []) {
    const eff = effectiveOf(r) ?? ADMIN_WATCH;
    const t = {
      id: r.id, workspace_id: r.workspace_id, base_id: r.base_id, name: r.name, icon: r.icon,
      kind: r.kind, ordinal: r.ordinal, row_count: r.row_count, updated_at: r.updated_at,
      role: eff.role, scope: eff.scope, via: eff.via,
    };
    if (!byBase.has(t.base_id)) byBase.set(t.base_id, []);
    byBase.get(t.base_id)?.push(t);
  }
  const out = ws.map((/** @type {any} */ w) => ({ ...w, role: 'viewer', scope: null, partial: false, monitor: true, bases: /** @type {any[]} */ ([]) }));
  const byId = new Map(out.map((w) => [w.id, w]));
  for (const b of bases.results ?? []) {
    const { b_role, b_scope, ...rest } = /** @type {any} */ (b);
    const eff = effectiveOf({ b_role, b_scope }) ?? ADMIN_WATCH;
    byId.get(b.workspace_id)?.bases.push({ ...rest, ...eff, tables: byBase.get(b.id) ?? [] });
  }
  return out;
}

/** @param {any} env @param {string[]} wsIds @param {string[]} baseIds */
async function loadBases(env, wsIds, baseIds) {
  if (!wsIds.length && !baseIds.length) return [];
  const { results } = await env.DB.prepare(
    `SELECT id, workspace_id, name, icon, ordinal FROM bases
      WHERE workspace_id IN (SELECT value FROM json_each(?1))
         OR id IN (SELECT value FROM json_each(?2))
      ORDER BY ordinal`,
  ).bind(JSON.stringify(wsIds), JSON.stringify(baseIds)).all();
  return results ?? [];
}

/**
 * 丢掉某个人的缓存。会话代次对不上时用 —— 可能只是这个 isolate 还留着
 * 改口令之前的旧行，重读一次再判断，别把刚拿到新 Cookie 的人挡在门外。
 * @param {string} email
 */
export function invalidateUser(email) { userMemo.delete(email); }

/** 测试用：清空 isolate 内存缓存。 */
export function resetUserCache() { userMemo.clear(); }
