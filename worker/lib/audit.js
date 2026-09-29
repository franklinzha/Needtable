/**
 * 审计日志。
 *
 * 只记「谁改变了什么」这一类低频动作：登录、建/删表、权限变更、导出、附件上传。
 * 单元格编辑不进这里 —— 那是 DO oplog 的职责，写进 D1 会直接打爆 100K 行/天。
 *
 * 全部走 ctx.waitUntil：审计失败不该让用户的操作失败。
 */

import { uid } from '../../public/shared/util/uid.js';

/**
 * @param {any} env
 * @param {ExecutionContext} ctx
 * @param {{
 *   actorId?: string, actorEmail?: string, workspaceId?: string,
 *   action: string, targetType?: string, targetId?: string,
 *   meta?: Record<string, unknown>, request?: Request
 * }} e
 */
export function audit(env, ctx, e) {
  const ip = e.request?.headers.get('cf-connecting-ip') ?? null;
  const p = env.DB.prepare(
    `INSERT INTO audit_log
       (id, workspace_id, actor_id, actor_email, action, target_type, target_id, meta_json, ip, ts)
     VALUES (?,?,?,?,?,?,?,?,?,?)`,
  ).bind(
    uid('log'),
    e.workspaceId ?? null,
    e.actorId ?? null,
    e.actorEmail ?? null,
    e.action,
    e.targetType ?? null,
    e.targetId ?? null,
    e.meta ? JSON.stringify(e.meta) : null,
    ip,
    Date.now(),
  ).run().catch((err) => { console.error('audit 写入失败', e.action, err); });

  ctx.waitUntil(p);
}
