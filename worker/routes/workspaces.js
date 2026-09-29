/**
 * 工作区与 base（侧边栏那棵树）。
 */

import { json, badRequest, forbidden, notFound } from '../lib/response.js';
import { t } from '../../public/shared/i18n/i18n.js';
import { requireWorkspaceRole, requireBaseRole, accessibleTree, monitorTree } from '../middleware/rbac.js';
import { can, tierOf } from '../lib/tiers.js';
import { listShares, putShare, removeShare } from './share.js';
import { newWorkspaceId, newBaseId } from '../../public/shared/util/uid.js';
import { keyAfter } from '../../public/shared/model/fracindex.js';
import { audit } from '../lib/audit.js';

const MAX_NAME = 80;

/** @param {unknown} v @returns {string | null} */
function cleanName(v) {
  if (typeof v !== 'string') return null;
  const s = v.trim();
  if (!s || s.length > MAX_NAME) return null;
  return s;
}

/** 读 JSON body，非法返回 null。 */
async function readJson(request) {
  try { return await request.json(); } catch { return null; }
}

/**
 * GET /api/workspaces/:id — 侧边栏整棵树（内容 + 表）。
 * 只被分享了其中某个内容或某张表的人也能进来，但只看得到分给他的那几项。
 */
export async function getWorkspace(request, c) {
  let [ws] = await accessibleTree(c.env, c.user.id, c.params.id);
  // 管理员进别人的工作区（或只被分享了其中一部分的）：看整棵树，只读
  if ((!ws || ws.partial) && c.user.role === 'admin') [ws] = await monitorTree(c.env, c.user.id, c.params.id);
  if (!ws) return notFound(t('工作区不存在'));
  const { bases, ...info } = ws;
  return json({
    workspace: info,
    bases: bases.map((/** @type {any} */ b) => { const { tables, ...rest } = b; return rest; }),
    tables: bases.flatMap((/** @type {any} */ b) => b.tables),
  });
}

/** POST /api/workspaces — 建工作区，建者即 owner */
export async function createWorkspace(request, c) {
  if (!can(c.user, 'create')) return forbidden(t('你的账号等级不能新建工作区，请联系管理员'));
  const tier = tierOf(c.user);
  if (Number.isFinite(tier.maxWorkspaces)) {
    const n = await c.env.DB.prepare('SELECT COUNT(*) AS n FROM workspaces WHERE owner_id = ?').bind(c.user.id).first();
    if (Number(n?.n ?? 0) >= tier.maxWorkspaces) {
      return forbidden(t('{label} 账号最多拥有 {n} 个工作区，需要更多请联系管理员升级', { label: tier.label, n: tier.maxWorkspaces }));
    }
  }
  const body = await readJson(request);
  const name = cleanName(body?.name);
  if (!name) return badRequest(t('名称不能为空且不超过 {n} 字', { n: MAX_NAME }));

  const id = newWorkspaceId();
  const now = Date.now();
  await c.env.DB.batch([
    c.env.DB.prepare(
      'INSERT INTO workspaces (id, name, icon, owner_id, created_at, updated_at) VALUES (?,?,?,?,?,?)',
    ).bind(id, name, typeof body.icon === 'string' ? body.icon.slice(0, 8) : '📊', c.user.id, now, now),
    c.env.DB.prepare(
      'INSERT INTO workspace_members (workspace_id, user_id, role, created_at) VALUES (?,?,?,?)',
    ).bind(id, c.user.id, 'owner', now),
    // 带一个空内容进去，新工作区打开就能直接建表
    c.env.DB.prepare(
      'INSERT INTO bases (id, workspace_id, name, icon, ordinal, created_at, updated_at) VALUES (?,?,?,?,?,?,?)',
    ).bind(newBaseId(), id, '默认', '📁', keyAfter(null), now, now),
  ]);

  audit(c.env, c.ctx, {
    actorId: c.user.id, actorEmail: c.user.email, workspaceId: id,
    action: 'workspace.create', targetType: 'workspace', targetId: id, request,
  });
  return json({ id, name }, 201);
}

/** POST /api/workspaces/:id/bases */
export async function createBase(request, c) {
  const gate = await requireWorkspaceRole(c.env, c.user, c.params.id, 'editor');
  if ('response' in gate) return gate.response;
  if (!can(c.user, 'create')) return forbidden(t('你的账号等级不能新建内容，请联系管理员'));

  const body = await readJson(request);
  const name = cleanName(body?.name);
  if (!name) return badRequest(t('名称不能为空且不超过 {n} 字', { n: MAX_NAME }));

  const last = await c.env.DB
    .prepare('SELECT ordinal FROM bases WHERE workspace_id = ? ORDER BY ordinal DESC LIMIT 1')
    .bind(c.params.id).first();

  const id = newBaseId();
  const now = Date.now();
  await c.env.DB.prepare(
    'INSERT INTO bases (id, workspace_id, name, icon, ordinal, created_at, updated_at) VALUES (?,?,?,?,?,?,?)',
  ).bind(id, c.params.id, name, typeof body.icon === 'string' ? body.icon.slice(0, 8) : '📁',
         keyAfter(last?.ordinal ?? null), now, now).run();

  audit(c.env, c.ctx, {
    actorId: c.user.id, actorEmail: c.user.email, workspaceId: c.params.id,
    action: 'base.create', targetType: 'base', targetId: id, meta: { name }, request,
  });
  return json({ id, name }, 201);
}

// ── 重命名 ────────────────────────────────────────────────────────────────

/** PATCH /api/workspaces/:id — { name?, icon? }，只有 owner / 管理者能改 */
export async function updateWorkspace(request, c) {
  const gate = await requireWorkspaceRole(c.env, c.user, c.params.id, 'manager');
  if ('response' in gate) return gate.response;
  const res = await patchRow(c, request, 'workspaces');
  if (res.ok) {
    audit(c.env, c.ctx, {
      actorId: c.user.id, actorEmail: c.user.email, workspaceId: c.params.id,
      action: 'workspace.update', targetType: 'workspace', targetId: c.params.id, request,
    });
  }
  return res;
}

/** PATCH /api/bases/:id — { name?, icon? }，编辑及以上 */
export async function updateBase(request, c) {
  const gate = await requireBaseRole(c.env, c.user, c.params.id, 'editor');
  if ('response' in gate) return gate.response;
  const res = await patchRow(c, request, 'bases');
  if (res.ok) {
    audit(c.env, c.ctx, {
      actorId: c.user.id, actorEmail: c.user.email, workspaceId: gate.workspaceId,
      action: 'base.update', targetType: 'base', targetId: c.params.id, request,
    });
  }
  return res;
}

/**
 * @param {any} c @param {Request} request @param {'workspaces'|'bases'} table 固定的两个表名之一
 */
async function patchRow(c, request, table) {
  const body = await readJson(request);
  /** @type {string[]} */ const sets = [];
  /** @type {unknown[]} */ const args = [];
  if (body?.name !== undefined) {
    const name = cleanName(body.name);
    if (!name) return badRequest(t('名称不能为空且不超过 {n} 字', { n: MAX_NAME }));
    sets.push('name = ?'); args.push(name);
  }
  if (typeof body?.icon === 'string') { sets.push('icon = ?'); args.push(body.icon.slice(0, 8)); }
  if (!sets.length) return badRequest(t('没有可更新的字段'));
  sets.push('updated_at = ?'); args.push(Date.now(), c.params.id);
  await c.env.DB.prepare('UPDATE ' + table + ' SET ' + sets.join(', ') + ' WHERE id = ?').bind(...args).run();
  return json({ ok: true });
}

// ── 成员（共享工作区）────────────────────────────────────────────────────────
// 三级分享共用一套规则，见 share.js。

export const listMembers = listShares('workspace');
export const putMember = putShare('workspace');
export const removeMember = removeShare('workspace');

export const listBaseMembers = listShares('base');
export const putBaseMember = putShare('base');
export const removeBaseMember = removeShare('base');
