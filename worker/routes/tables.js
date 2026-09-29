/**
 * 表的目录级 CRUD。
 * 注意：这里只动 D1 里的**目录**记录，表内的行列单元格全部在 TableDO 里，
 * 由实时通道读写（P2）。这条边界是整个额度预算的前提，不要在这里开口子。
 */

import { json, badRequest, notFound, forbidden } from '../lib/response.js';
import { t } from '../../public/shared/i18n/i18n.js';
import { requireBaseRole, requireTableRole } from '../middleware/rbac.js';
import { can } from '../lib/tiers.js';
import { listShares, putShare, removeShare } from './share.js';
import { newTableId } from '../../public/shared/util/uid.js';
import { keyAfter } from '../../public/shared/model/fracindex.js';
import { audit } from '../lib/audit.js';

const MAX_NAME = 80;
const KINDS = new Set(['sheet', 'grid', 'doc', 'slides']);
/** 各类的默认图标：表格、文档、幻灯片 */
const KIND_ICON = { sheet: '🧮', grid: '📄', doc: '📝', slides: '📽️' };

async function readJson(request) {
  try { return await request.json(); } catch { return null; }
}

function cleanName(v) {
  if (typeof v !== 'string') return null;
  const s = v.trim();
  return s && s.length <= MAX_NAME ? s : null;
}

/** GET /api/tables/:id — 目录元信息（表内容走 WS） */
export async function getTable(request, c) {
  const gate = await requireTableRole(c.env, c.user, c.params.id, 'viewer');
  if ('response' in gate) return gate.response;

  const row = await c.env.DB.prepare(
    `SELECT id, workspace_id, base_id, name, icon, kind, ordinal,
            row_count, snapshot_seq, created_at, updated_at
       FROM tables WHERE id = ?`,
  ).bind(c.params.id).first();
  if (!row) return notFound(t('表不存在'));

  return json({ table: row, role: gate.role, scope: gate.scope, via: gate.via });
}

/**
 * GET /api/tables/:id/data — 表内容的全量快照。
 *
 * 为什么不走 WebSocket 拿全量：HTTP 能自动 gzip、能流式输出、且不计入 DO 的
 * WS 入站消息计费。客户端拿到里面的 seq 之后再连 WS 并以它作为 lastSeq，
 * DO 从那里接着补增量 —— DO 是单线程的，这两步之间不可能漏掉任何一次写入。
 */
export async function getTableData(request, c) {
  const gate = await requireTableRole(c.env, c.user, c.params.id, 'viewer');
  if ('response' in gate) return gate.response;

  const stub = c.env.TABLE_DO.get(c.env.TABLE_DO.idFromName(c.params.id));
  // DO 只认这些头，不信任任何来自客户端的身份字段
  const res = await stub.fetch('https://do/state', {
    headers: {
      'x-table-id': c.params.id,
      'x-user-id': c.user.id,
      'x-user-email': c.user.email,
      'x-user-role': gate.role,
    },
  });
  // 直接把 DO 的流转出去，不在 Worker 里 buffer —— 大表会把 128MB 内存吃光
  return new Response(res.body, {
    status: res.status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });
}

/** POST /api/tables — { baseId, name, kind } */
export async function createTable(request, c) {
  const body = await readJson(request);
  const name = cleanName(body?.name);
  if (!name) return badRequest(t('名称不能为空且不超过 {n} 字', { n: MAX_NAME }));
  if (typeof body.baseId !== 'string') return badRequest(t('缺少 baseId'));

  const kind = KINDS.has(body.kind) ? body.kind : 'grid';

  // 被分享了整个内容的编辑者也能在里面建表；只被分享了某张表的人不行
  const gate = await requireBaseRole(c.env, c.user, body.baseId, 'editor');
  if ('response' in gate) return gate.response;
  if (!can(c.user, 'create')) return forbidden(t('你的账号等级不能新建表，请联系管理员'));
  const base = { id: body.baseId, workspace_id: gate.workspaceId };

  const last = await c.env.DB
    .prepare('SELECT ordinal FROM tables WHERE base_id = ? ORDER BY ordinal DESC LIMIT 1')
    .bind(base.id).first();

  const id = newTableId();
  const now = Date.now();
  await c.env.DB.prepare(
    `INSERT INTO tables (id, workspace_id, base_id, name, icon, kind, ordinal,
                         created_by, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?)`,
  ).bind(id, base.workspace_id, base.id, name,
         typeof body.icon === 'string' ? body.icon.slice(0, 8) : KIND_ICON[/** @type {'grid'} */ (kind)],
         kind, keyAfter(last?.ordinal ?? null), c.user.id, now, now).run();

  audit(c.env, c.ctx, {
    actorId: c.user.id, actorEmail: c.user.email, workspaceId: base.workspace_id,
    action: 'table.create', targetType: 'table', targetId: id, meta: { name, kind }, request,
  });
  return json({ id, name, kind, baseId: base.id }, 201);
}

/** PATCH /api/tables/:id — 改名 / 换图标 */
export async function updateTable(request, c) {
  const gate = await requireTableRole(c.env, c.user, c.params.id, 'editor');
  if ('response' in gate) return gate.response;

  const body = await readJson(request);
  /** @type {string[]} */ const sets = [];
  /** @type {unknown[]} */ const args = [];

  if (body?.name !== undefined) {
    const name = cleanName(body.name);
    if (!name) return badRequest(t('名称不能为空且不超过 {n} 字', { n: MAX_NAME }));
    sets.push('name = ?'); args.push(name);
  }
  if (typeof body?.icon === 'string') { sets.push('icon = ?'); args.push(body.icon.slice(0, 8)); }
  if (sets.length === 0) return badRequest(t('没有可更新的字段'));

  sets.push('updated_at = ?'); args.push(Date.now());
  args.push(c.params.id);
  // 字段名来自上面的白名单，不是用户输入；值一律参数绑定
  await c.env.DB.prepare('UPDATE tables SET ' + sets.join(', ') + ' WHERE id = ?').bind(...args).run();

  audit(c.env, c.ctx, {
    actorId: c.user.id, actorEmail: c.user.email, workspaceId: gate.workspaceId,
    action: 'table.update', targetType: 'table', targetId: c.params.id, request,
  });
  return json({ ok: true });
}

/** DELETE /api/tables/:id */
export async function deleteTable(request, c) {
  const gate = await requireTableRole(c.env, c.user, c.params.id, 'manager');
  if ('response' in gate) return gate.response;

  await c.env.DB.prepare('DELETE FROM tables WHERE id = ?').bind(c.params.id).run();
  // DO 里的数据与 R2 快照留给后台清理（P6），删目录记录已经让它不可达

  audit(c.env, c.ctx, {
    actorId: c.user.id, actorEmail: c.user.email, workspaceId: gate.workspaceId,
    action: 'table.delete', targetType: 'table', targetId: c.params.id, request,
  });
  return json({ ok: true });
}

// ── 分享单张表（规则见 share.js）──────────────────────────────────────────────
export const listTableMembers = listShares('table');
export const putTableMember = putShare('table');
export const removeTableMember = removeShare('table');

/**
 * 附件存在各表自己的 TableDO 里（SQLite 切块），不用 R2 —— R2 要绑信用卡。
 * Worker 只负责鉴权，请求体与响应体都原样流式转给 DO，不在这里 buffer。
 */
function fileStub(c, role) {
  const stub = c.env.TABLE_DO.get(c.env.TABLE_DO.idFromName(c.params.id));
  const headers = {
    'x-table-id': c.params.id,
    'x-user-id': c.user.id,
    'x-user-email': c.user.email,
    'x-user-role': role,
  };
  return { stub, headers };
}

/** POST /api/tables/:id/files — 请求体就是文件本身；文件名与类型走 x-file-name / x-file-type 头 */
export async function uploadFile(request, c) {
  const gate = await requireTableRole(c.env, c.user, c.params.id, 'editor');
  if ('response' in gate) return gate.response;
  const { stub, headers } = fileStub(c, gate.role);
  const len = request.headers.get('content-length');
  const res = await stub.fetch('https://do/files', {
    method: 'POST',
    body: request.body,
    headers: {
      ...headers,
      ...(len ? { 'content-length': len } : {}),
      'x-file-name': request.headers.get('x-file-name') ?? '',
      'x-file-type': request.headers.get('x-file-type') ?? '',
    },
  });
  if (res.ok) {
    audit(c.env, c.ctx, {
      actorId: c.user.id, actorEmail: c.user.email, workspaceId: gate.workspaceId,
      action: 'file.upload', targetType: 'table', targetId: c.params.id, request,
    });
  }
  return res;
}

/** GET /api/tables/:id/files/:fid */
export async function getFile(request, c) {
  const gate = await requireTableRole(c.env, c.user, c.params.id, 'viewer');
  if ('response' in gate) return gate.response;
  if (!/^f_[a-z0-9]{12,32}$/.test(c.params.fid)) return notFound(t('附件不存在'));
  const { stub, headers } = fileStub(c, gate.role);
  const res = await stub.fetch('https://do/files/' + c.params.fid, { headers });
  return new Response(res.body, { status: res.status, headers: res.headers });
}
