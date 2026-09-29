/**
 * 主页数据：这个人能看到的全部工作区 → 内容 → 表。
 *
 * 一次给齐，前端据此画主页，进到某张表时侧边栏也直接从这里取，不再单独拉工作区。
 * 完整成员看到工作区里的一切；只被分享了某个内容 / 某张表的人，工作区带 partial，
 * 里面只有他够得着的那几项（见 rbac.js accessibleTree）。
 */

import { json } from '../lib/response.js';
import { accessibleTree, monitorTree } from '../middleware/rbac.js';
import { ensureDefaultWorkspace } from './admin.js';

/** GET /api/home */
export async function getHome(/** @type {Request} */ request, /** @type {any} */ c) {
  // 从 normal 升上来、还没有自己工作区的人：第一次进主页时补一个
  await ensureDefaultWorkspace(c.env, c.user);
  const workspaces = await accessibleTree(c.env, c.user.id);
  // 管理员：另附其余所有人的工作区，只读监控
  if (c.user.role !== 'admin') return json({ workspaces });
  return json({ workspaces, monitor: await monitorTree(c.env, c.user.id) });
}
