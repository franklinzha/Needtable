/**
 * 分享：工作区 / 内容 / 表三级，同一套规则。
 *
 *   GET    /api/{workspaces|bases|tables}/:id/members           谁能访问（含继承来的）
 *   PUT    /api/{workspaces|bases|tables}/:id/members           { email, role, scope? } 加人或改角色
 *   DELETE /api/{workspaces|bases|tables}/:id/members/:userId   移除；成员也可以自己退出
 *
 * 规则：
 *   · 管理分享要对这个资源有 manager 及以上角色，并且账号等级允许分享（normal 不行）
 *   · 能授出的角色看等级：plus 只能给「查看 / 编辑」，pro 及以上还能给「管理者」
 *   · 低等级不能改高等级成员的权限（admin > pro > plus > normal）；
 *     不是工作区 owner 的管理者，也动不了和自己同级或更高的授权
 *   · 工作区 owner 谁也改不了
 *   · 权限变了就把对方开着的表踢一下，让他按新角色重连
 *
 * 被分享的人必须已经有账号 —— 本站不开放注册，账号由管理员在「用户管理」里开通。
 */

import { json, badRequest, forbidden, notFound } from '../lib/response.js';
import { t } from '../../public/shared/i18n/i18n.js';
import { requireWorkspaceRole, requireBaseRole, requireTableRole, effectiveOf } from '../middleware/rbac.js';
import { revokeRealtime, tablesOfWorkspace } from '../lib/revoke.js';
import { can, grantableRoles, normalizeScope, outranks, RANK, tierOf } from '../lib/tiers.js';
import { audit } from '../lib/audit.js';

/** @typedef {'workspace'|'base'|'table'} Level */

const ALL_ROLES = new Set(['viewer', 'editor', 'manager']);

/** @param {Request} request */
async function readJson(request) {
  try { return await request.json(); } catch { return null; }
}

/**
 * 资源本身的位置信息 + 调用者在上面的有效角色。
 * @param {Level} level @param {any} c @param {'viewer'|'manager'} min
 * @returns {Promise<{ response: Response } | { role: string, workspaceId: string, baseId: string | null, tableId: string | null }>}
 */
async function gateFor(level, c, min) {
  const id = c.params.id;
  if (level === 'workspace') {
    const g = await requireWorkspaceRole(c.env, c.user, id, min);
    return 'response' in g ? g : { role: g.role, workspaceId: id, baseId: null, tableId: null };
  }
  if (level === 'base') {
    const g = await requireBaseRole(c.env, c.user, id, min);
    return 'response' in g ? g : { role: g.role, workspaceId: g.workspaceId, baseId: id, tableId: null };
  }
  const g = await requireTableRole(c.env, c.user, id, min);
  return 'response' in g ? g : { role: g.role, workspaceId: g.workspaceId, baseId: g.baseId, tableId: id };
}

/**
 * 这一级上直接授出的记录。
 * @param {any} env @param {Level} level @param {string} id @param {string} [userId]
 */
function directRows(env, level, id, userId) {
  const [tbl, key] = aclTable(level);
  // 表名、列名来自上面的固定映射，不是用户输入
  const sql = `SELECT x.user_id AS id, u.email, u.name, u.status, u.role AS tier, x.role, x.scope, x.created_at
                 FROM ${tbl} x JOIN users u ON u.id = x.user_id
                WHERE x.${key} = ?` + (userId ? ' AND x.user_id = ?' : '');
  const st = env.DB.prepare(sql);
  return userId ? st.bind(id, userId) : st.bind(id);
}

/** 这一级对应的表名与主键列。 @param {Level} level */
function aclTable(level) {
  return level === 'workspace' ? ['workspace_members', 'workspace_id']
    : level === 'base' ? ['base_acl', 'base_id'] : ['table_acl', 'table_id'];
}

/** 这一级变了会影响哪些表的实时连接。 @param {any} env @param {Level} level @param {string} id */
async function affectedTables(env, level, id) {
  if (level === 'workspace') return tablesOfWorkspace(env, id);
  if (level === 'table') return [id];
  const { results } = await env.DB.prepare('SELECT id FROM tables WHERE base_id = ?').bind(id).all();
  return (results ?? []).map((/** @type {any} */ r) => String(r.id));
}

/** @param {Level} level */
export function listShares(level) {
  /** @param {Request} request @param {any} c */
  return async (request, c) => {
    const g = await gateFor(level, c, 'viewer');
    if ('response' in g) return g.response;

    // 从最宽到最具体，逐级收集；同一个人以最具体的那条为准，宽的那条记为「继承」
    const levels = /** @type {[Level, string][]} */ ([['workspace', g.workspaceId]]);
    if (g.baseId) levels.push(['base', g.baseId]);
    if (g.tableId) levels.push(['table', g.tableId]);
    const batches = await c.env.DB.batch(levels.map(([lv, id]) => directRows(c.env, lv, id)));

    /** @type {Map<string, any>} */ const people = new Map();
    levels.forEach(([lv], i) => {
      for (const r of batches[i].results ?? []) {
        const p = people.get(r.id) ?? { id: r.id, email: r.email, name: r.name, status: r.status, tier: r.tier, rows: {} };
        p.rows[lv] = { role: r.role, scope: r.scope ?? null, createdAt: Number(r.created_at ?? 0) };
        people.set(r.id, p);
      }
    });

    const order = { owner: 0, manager: 1, editor: 2, viewer: 3 };
    const members = [...people.values()].map((p) => {
      const eff = effectiveOf({
        m_role: p.rows.workspace?.role, m_scope: p.rows.workspace?.scope,
        b_role: p.rows.base?.role, b_scope: p.rows.base?.scope,
        t_role: p.rows.table?.role, t_scope: p.rows.table?.scope,
      });
      // 被这一条盖住的、更宽的那一级（界面上显示「继承自工作区：编辑」）
      const chain = /** @type {Level[]} */ (['table', 'base', 'workspace']);
      const wider = chain.slice(chain.indexOf(/** @type {Level} */ (eff?.via)) + 1).find((lv) => p.rows[lv]);
      return {
        id: p.id, email: p.email, name: p.name, status: p.status, tier: p.tier,
        role: eff?.role, scope: eff?.scope ?? null, via: eff?.via,
        direct: !!p.rows[level],
        inherited: wider ? { role: p.rows[wider].role, via: wider } : null,
        me: p.id === c.user.id,
      };
    }).sort((a, b) => (order[a.role] ?? 9) - (order[b.role] ?? 9) || String(a.email).localeCompare(String(b.email)));

    const canManage = RANK[g.role] >= RANK.manager && can(c.user, 'share');
    return json({
      level, members, myRole: g.role, canShare: canManage,
      grantable: canManage ? grantableRoles(c.user) : [],
    });
  };
}

/**
 * 能不能动某人在这一级上的授权。
 * @param {any} c @param {{ role: string }} g 调用者在资源上的角色
 * @param {{ tier: string, role: string } | null} cur 对方在这一级上现有的记录
 * @returns {Response | null}
 */
function mayTouch(c, g, cur) {
  if (!cur) return null;
  if (cur.role === 'owner') return badRequest(t('不能修改所有者的角色'));
  if (outranks({ role: cur.tier }, c.user)) {
    return forbidden(t('对方的账号等级（{label}）比你高，不能修改对方的权限', { label: tierOf({ role: cur.tier }).label }));
  }
  if (g.role !== 'owner' && RANK[cur.role] >= RANK[g.role]) {
    return forbidden(t('只有所有者能修改管理者的权限'));
  }
  return null;
}

/** @param {Level} level */
export function putShare(level) {
  /** @param {Request} request @param {any} c */
  return async (request, c) => {
    const g = await gateFor(level, c, 'manager');
    if ('response' in g) return g.response;
    if (!can(c.user, 'share')) return forbidden(t('你的账号等级不能分享，请联系管理员升级'));

    const body = await readJson(request);
    const email = String(body?.email ?? '').trim().toLowerCase();
    if (!email) return badRequest(t('请填写对方的登录邮箱'));
    if (!ALL_ROLES.has(body?.role)) return badRequest(t('角色只能是 viewer（查看）、editor（编辑）或 manager（管理者）'));
    if (!grantableRoles(c.user).includes(body.role)) return forbidden(t('你的账号等级不能授出「管理者」'));
    const sc = normalizeScope(body?.scope);
    if (!sc.ok) return badRequest(t('可见视图只能从 grid / kanban / dashboard 里选，至少一项'));

    const u = await c.env.DB.prepare('SELECT id, email, status, role FROM users WHERE email = ?').bind(email).first();
    if (!u) return notFound(t('这个邮箱还没有账号，请先让管理员在「用户管理」里开通'));
    if (u.status === 'disabled') return badRequest(t('这个账号已被停用'));

    // 工作区 owner 在自己的工作区里永远是 owner，给他加内容 / 表级授权没有意义，也不能借此降他的级
    const owner = await c.env.DB.prepare('SELECT owner_id FROM workspaces WHERE id = ?').bind(g.workspaceId).first();
    if (owner?.owner_id === u.id) return badRequest(t('不能修改所有者的角色'));
    if (u.id === c.user.id) return badRequest(t('不能修改自己的权限'));

    const [tbl, key] = aclTable(level);
    const id = c.params.id;
    const curRow = (await directRows(c.env, level, id, u.id).all()).results?.[0] ?? null;
    const deny = mayTouch(c, g, curRow);
    if (deny) return deny;

    const now = Date.now();
    if (curRow) {
      await c.env.DB.prepare(`UPDATE ${tbl} SET role = ?, scope = ? WHERE ${key} = ? AND user_id = ?`)
        .bind(body.role, sc.scope, id, u.id).run();
      // 降级或者收窄视图的话，他开着的表要按新角色重连
      if (curRow.role !== body.role || (curRow.scope ?? null) !== sc.scope) {
        revokeRealtime(c.env, c.ctx, u.id, await affectedTables(c.env, level, id));
      }
    } else if (level === 'workspace') {
      await c.env.DB.prepare('INSERT INTO workspace_members (workspace_id, user_id, role, scope, created_at) VALUES (?,?,?,?,?)')
        .bind(id, u.id, body.role, sc.scope, now).run();
    } else if (level === 'base') {
      await c.env.DB.prepare('INSERT INTO base_acl (base_id, user_id, role, scope, created_by, created_at) VALUES (?,?,?,?,?,?)')
        .bind(id, u.id, body.role, sc.scope, c.user.id, now).run();
    } else {
      await c.env.DB.prepare('INSERT INTO table_acl (table_id, user_id, role, scope, created_at) VALUES (?,?,?,?,?)')
        .bind(id, u.id, body.role, sc.scope, now).run();
      // 已经能通过更宽的一级打开这张表的话，表级授权会覆盖它，同样要重连
      revokeRealtime(c.env, c.ctx, u.id, [id]);
    }

    audit(c.env, c.ctx, {
      actorId: c.user.id, actorEmail: c.user.email, workspaceId: g.workspaceId,
      action: curRow ? 'share.role' : 'share.add', targetType: 'user', targetId: u.id,
      meta: { level, id, email: u.email, role: body.role, scope: sc.scope }, request,
    });
    return json({ id: u.id, email: u.email, role: body.role, scope: sc.scope }, curRow ? 200 : 201);
  };
}

/** @param {Level} level */
export function removeShare(level) {
  /** @param {Request} request @param {any} c */
  return async (request, c) => {
    const self = c.params.userId === c.user.id;
    const g = await gateFor(level, c, self ? 'viewer' : 'manager');
    if ('response' in g) return g.response;
    if (!self && !can(c.user, 'share')) return forbidden(t('你的账号等级不能管理分享'));

    const id = c.params.id;
    const cur = (await directRows(c.env, level, id, c.params.userId).all()).results?.[0] ?? null;
    if (!cur) return notFound(level === 'workspace' ? t('此人不在这个工作区的分享名单里') : level === 'base' ? t('此人不在这个内容的分享名单里') : t('此人不在这张表的分享名单里'));
    if (cur.role === 'owner') return badRequest(t('不能移除所有者'));
    if (!self) {
      const deny = mayTouch(c, g, cur);
      if (deny) return deny;
    }

    const [tbl, key] = aclTable(level);
    const tableIds = await affectedTables(c.env, level, id);
    /** @type {any[]} */ const stmts = [
      c.env.DB.prepare(`DELETE FROM ${tbl} WHERE ${key} = ? AND user_id = ?`).bind(id, c.params.userId),
    ];
    if (level === 'workspace') {
      // 移出工作区就是彻底请出去：内容级、表级授权一并收回，否则还能从那两条路进来
      stmts.push(
        c.env.DB.prepare('DELETE FROM base_acl WHERE user_id = ? AND base_id IN (SELECT id FROM bases WHERE workspace_id = ?)')
          .bind(c.params.userId, id),
        c.env.DB.prepare('DELETE FROM table_acl WHERE user_id = ? AND table_id IN (SELECT id FROM tables WHERE workspace_id = ?)')
          .bind(c.params.userId, id),
      );
    }
    await c.env.DB.batch(stmts);
    revokeRealtime(c.env, c.ctx, c.params.userId, tableIds);

    audit(c.env, c.ctx, {
      actorId: c.user.id, actorEmail: c.user.email, workspaceId: g.workspaceId,
      action: 'share.remove', targetType: 'user', targetId: c.params.userId, meta: { level, id }, request,
    });
    return json({ ok: true });
  };
}
