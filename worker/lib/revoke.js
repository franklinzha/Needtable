/**
 * 权限收回之后，把人从已经打开的实时连接里请出去。
 *
 * ticket 只在建连那一刻校验角色，之后 DO 就信 attachment 里记的那一份。
 * 所以「移出工作区」「降为只读」「停用账号」之后，对方开着的标签页还能继续写 ——
 * 直到下次断线重连。这里让 DO 主动断开那个人的连接（4001），客户端会立刻重连、
 * 重新申请 ticket：权限还在就按新角色回来，不在了就拿不到 ticket。
 *
 * 一张表一次 DO 请求，全部丢进 waitUntil：踢人失败不该让管理操作本身失败。
 */

/**
 * @param {any} env @param {ExecutionContext} ctx
 * @param {string} userId @param {string[]} tableIds
 */
export function revokeRealtime(env, ctx, userId, tableIds) {
  if (!env.TABLE_DO || !tableIds.length) return;
  const jobs = tableIds.map((tableId) => {
    const stub = env.TABLE_DO.get(env.TABLE_DO.idFromName(tableId));
    return stub.fetch('https://do/revoke', {
      method: 'POST',
      headers: { 'x-user-id': userId, 'x-table-id': tableId },
    }).catch((/** @type {any} */ err) => { console.error('revoke 失败', tableId, err); });
  });
  ctx.waitUntil(Promise.all(jobs));
}

/** 某人能通过工作区成员身份或表级 ACL 访问到的全部表。 @param {any} env @param {string} userId */
export async function tablesOfUser(env, userId) {
  const { results } = await env.DB.prepare(
    `SELECT t.id FROM tables t
       JOIN workspace_members m ON m.workspace_id = t.workspace_id AND m.user_id = ?
     UNION
     SELECT table_id AS id FROM table_acl WHERE user_id = ?`,
  ).bind(userId, userId).all();
  return (results ?? []).map((/** @type {any} */ r) => String(r.id));
}

/** 某个工作区里的全部表。 @param {any} env @param {string} workspaceId */
export async function tablesOfWorkspace(env, workspaceId) {
  const { results } = await env.DB.prepare('SELECT id FROM tables WHERE workspace_id = ?')
    .bind(workspaceId).all();
  return (results ?? []).map((/** @type {any} */ r) => String(r.id));
}
