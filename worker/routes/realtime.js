/**
 * 实时通道的入口。
 *
 * 两个端点，鉴权方式**故意不同**：
 *   POST /api/realtime/ticket —— 走常规中间件链（会话 Cookie 已验过），签一张 30 秒 ticket
 *   GET  /api/realtime/ws     —— 在中间件链之前短路，只认 ticket
 *
 * 为什么 ws 单独一条路：WebSocket 的 upgrade 请求带不上应用层能依赖的一切 ——
 * 浏览器的 WebSocket 构造函数不让设请求头，跨源时 Cookie 也未必带得上。
 * 把实时层的鉴权建立在自己签的一次性 ticket 上，换域名、换认证方式都不会把它带塌。
 * （原方案走 Cloudflare Access 时更是必须如此：Worker 级 Access 策略直接 403 掉
 * WS upgrade。现在是应用自建登录墙，那条 Bypass 策略不再需要配。）
 *
 * ticket 里带了 uid 与角色，DO 那边据此绑定身份 —— 会话 Cookie 到不了 DO。
 */

import { json, badRequest, unauthorized, notConfigured } from '../lib/response.js';
import { t } from '../../public/shared/i18n/i18n.js';
import { requireTableRole } from '../middleware/rbac.js';
import { signTicket, verifyTicket } from '../lib/ticket.js';

const TICKET_TTL_S = 30;

/** POST /api/realtime/ticket — body: { tableId } */
export async function issueTicket(request, c) {
  if (!c.env.REALTIME_SECRET) return notConfigured('REALTIME_SECRET');

  /** @type {any} */ let body;
  try { body = await request.json(); } catch { return badRequest(); }
  if (typeof body?.tableId !== 'string') return badRequest(t('缺少 tableId'));

  const gate = await requireTableRole(c.env, c.user, body.tableId, 'viewer');
  if ('response' in gate) return gate.response;

  const ticket = await signTicket({
    uid: c.user.id,
    email: c.user.email,
    tableId: body.tableId,
    role: gate.role,
    name: c.user.name || c.user.email.split('@')[0],
    scope: gate.scope ?? null,
    ttlSeconds: TICKET_TTL_S,
  }, c.env.REALTIME_SECRET);

  return json({ ticket, expiresIn: TICKET_TTL_S });
}

/**
 * GET /api/realtime/ws?ticket=... — 验票后转交给这张表的 Durable Object。
 * 这个处理器在中间件链里**排在 Access 之前**，所以它必须自己完成全部鉴权。
 * @param {Request} request @param {URL} url @param {any} env
 */
export async function handleWsUpgrade(request, url, env) {
  if (request.headers.get('upgrade')?.toLowerCase() !== 'websocket') {
    return badRequest(t('需要 WebSocket upgrade'));
  }
  if (!env.REALTIME_SECRET) return notConfigured('REALTIME_SECRET');

  const token = url.searchParams.get('ticket');
  if (!token) return unauthorized(t('缺少 ticket'));

  const payload = await verifyTicket(token, env.REALTIME_SECRET);
  if (!payload) return unauthorized(t('ticket 无效或已过期'));

  // 每张表一个 DO 实例：天然的串行化点，seq 单调，无需分布式锁
  const id = env.TABLE_DO.idFromName(payload.tableId);
  const stub = env.TABLE_DO.get(id);

  // 身份从已验签的 ticket 取，随请求头透传给 DO；DO 不信任任何来自客户端的身份字段。
  // nonce 一次性校验由 DO 在自己的 SQLite 里做（不用 KV：1000 写/天太紧）。
  const headers = new Headers(request.headers);
  headers.set('x-table-id', payload.tableId);
  headers.set('x-user-id', payload.uid);
  headers.set('x-user-email', payload.email);
  headers.set('x-user-role', payload.role);
  // 头只能是 ASCII：名字可能是中文，编码后传
  headers.set('x-user-name', encodeURIComponent(payload.name ?? ''));
  if (payload.scope) headers.set('x-user-scope', payload.scope);
  headers.set('x-ticket-nonce', payload.nonce);
  headers.set('x-ticket-exp', String(payload.exp));

  return stub.fetch(new Request(url.toString(), { method: 'GET', headers }));
}
