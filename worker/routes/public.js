/**
 * 公开只读链接。
 *
 * 链接形如 /t/<表 id>?view=<令牌>。令牌放查询串而不是 # 后面：
 *   · # 之后的部分根本不会发到服务端，服务端就没法在返回页面前验证令牌；
 *   · 微信、企业微信等聊天软件识别链接时常在 # 处截断（开通链接踩过同一个坑）。
 *
 * 两组接口：
 *   已登录（走常规中间件链）   GET/POST/DELETE /api/tables/:id/public   查看 / 开启 / 关闭
 *   未登录（在鉴权之前短路）   GET /api/public/:token[/data|/seq|/files/:fid]
 *
 * 公开访客在 DO 那边的身份固定是 uid='public'、role='viewer'，而且根本不连 WebSocket
 * （拿不到 ticket），只能拉快照 + 轮询 seq —— 服务端层面就不存在写入的通路。
 * 「不能复制」只能在前端做到劝阻：截图和开发者工具是挡不住的。
 *
 * 公开页面要加载 index.html 和它的模块，而那些平时都在登录墙后面。
 * 打开有效的公开链接时顺手发一张短期签名 Cookie（绑定表 id），凭它只放行
 * js / css / shared 这几类静态文件，别的一概不给。
 */

import { json, notFound, forbidden, tooManyRequests } from '../lib/response.js';
import { t } from '../../public/shared/i18n/i18n.js';
import { requireTableRole } from '../middleware/rbac.js';
import { consume } from '../middleware/ratelimit.js';
import { can } from '../lib/tiers.js';
import { audit } from '../lib/audit.js';
import { readExtPublic } from './refs.js';
import { bytesToB64url, b64urlToBytes } from '../../public/shared/util/b64.js';

export const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;
const TABLE_ID_RE = /^[A-Za-z0-9_-]{4,64}$/;

/** 公开页面的资源 Cookie：只证明「这个浏览器刚打开过某张表的有效公开链接」。 */
const PUB_COOKIE = 'tbl_pub';
const PUB_TTL_MS = 12 * 60 * 60 * 1000;

/** 已登录：公开链接的地址。 @param {URL} url @param {string} tableId @param {string} token */
function linkOf(url, tableId, token) {
  return url.origin + '/t/' + encodeURIComponent(tableId) + '?view=' + token;
}

/** GET /api/tables/:id/public */
export async function getPublicLink(request, c) {
  const gate = await requireTableRole(c.env, c.user, c.params.id, 'viewer');
  if ('response' in gate) return gate.response;
  const row = await c.env.DB.prepare('SELECT token, created_by, created_at FROM public_links WHERE table_id = ?')
    .bind(c.params.id).first();
  const manage = gate.via !== 'admin' && (gate.role === 'owner' || gate.role === 'manager');
  return json({
    link: row ? { url: linkOf(c.url, c.params.id, String(row.token)), createdBy: row.created_by, createdAt: row.created_at } : null,
    canCreate: manage && can(c.user, 'publicShare'),
    // 开链接的人（admin / pro）可能后来被降级：manager 及以上照样能把它关掉
    canRevoke: manage || c.user.role === 'admin',
  });
}

/** POST /api/tables/:id/public — 已存在就原样返回，不重新生成（免得旧链接突然失效） */
export async function createPublicLink(request, c) {
  const gate = await requireTableRole(c.env, c.user, c.params.id, 'manager');
  if ('response' in gate) return gate.response;
  if (!can(c.user, 'publicShare')) return forbidden(t('只有管理员和 Pro 账号可以开公开链接'));

  const token = bytesToB64url(crypto.getRandomValues(new Uint8Array(32)));
  await c.env.DB.prepare('INSERT OR IGNORE INTO public_links (token, table_id, created_by, created_at) VALUES (?, ?, ?, ?)')
    .bind(token, c.params.id, c.user.id, Date.now()).run();
  const row = await c.env.DB.prepare('SELECT token, created_by, created_at FROM public_links WHERE table_id = ?')
    .bind(c.params.id).first();
  if (!row) return notFound(t('表不存在'));
  if (row.token === token) {
    audit(c.env, c.ctx, {
      actorId: c.user.id, actorEmail: c.user.email, workspaceId: gate.workspaceId,
      action: 'public_link.create', targetType: 'table', targetId: c.params.id, request,
    });
  }
  return json({ link: { url: linkOf(c.url, c.params.id, String(row.token)), createdBy: row.created_by, createdAt: row.created_at } });
}

/** DELETE /api/tables/:id/public */
export async function revokePublicLink(request, c) {
  const gate = await requireTableRole(c.env, c.user, c.params.id, 'viewer');
  if ('response' in gate) return gate.response;
  const manage = gate.via !== 'admin' && (gate.role === 'owner' || gate.role === 'manager');
  if (!manage && c.user.role !== 'admin') return forbidden(t('需要 manager 及以上权限'));
  const res = await c.env.DB.prepare('DELETE FROM public_links WHERE table_id = ?').bind(c.params.id).run();
  if (res.meta?.changes) {
    audit(c.env, c.ctx, {
      actorId: c.user.id, actorEmail: c.user.email, workspaceId: gate.workspaceId,
      action: 'public_link.revoke', targetType: 'table', targetId: c.params.id, request,
    });
  }
  return json({ ok: true });
}

/** 令牌 → 表。 @param {any} env @param {string} token */
export async function tableOfToken(env, token) {
  if (!TOKEN_RE.test(token)) return null;
  const row = await env.DB.prepare(
    `SELECT t.id AS id, t.name AS name, t.icon AS icon, t.kind AS kind
       FROM public_links p JOIN tables t ON t.id = p.table_id
      WHERE p.token = ?`,
  ).bind(token).first();
  return row ? { id: String(row.id), name: String(row.name ?? ''), icon: row.icon ?? null, kind: String(row.kind ?? 'grid') } : null;
}

/** @param {any} env @param {string} tableId */
function doFetch(env, tableId, path) {
  const stub = env.TABLE_DO.get(env.TABLE_DO.idFromName(tableId));
  return stub.fetch('https://do' + path, {
    headers: { 'x-table-id': tableId, 'x-user-id': 'public', 'x-user-email': '', 'x-user-role': 'viewer' },
  });
}

const PUBLIC_API = /^\/api\/public\/([A-Za-z0-9_-]{43})(?:\/(data|seq|ext)|\/files\/(f_[a-z0-9]{12,32}))?$/;

/**
 * 未登录也能调的 /api/public/*。每 IP 限流；令牌不对一律 404，不区分「不存在」和「已关闭」。
 * @param {Request} request @param {URL} url @param {any} env
 */
export async function handlePublicApi(request, url, env) {
  const ip = request.headers.get('cf-connecting-ip') ?? 'unknown';
  const quota = consume('pub:' + ip, { capacity: 60, refillPerSec: 1 });
  if (!quota.ok) return tooManyRequests(quota.retryAfter);

  const m = PUBLIC_API.exec(url.pathname);
  if (!m) return notFound(t('接口不存在'));
  const table = await tableOfToken(env, m[1]);
  if (!table) return notFound(t('链接已失效'));
  // 唯一的 POST：跨表引用取值（只读，请求体只是要取哪些区域）
  if (m[2] === 'ext') return request.method === 'POST' ? readExtPublic(request, env, table.id) : notFound(t('接口不存在'));
  if (request.method !== 'GET') return notFound(t('接口不存在'));

  if (!m[2] && !m[3]) return json({ table }, 200, { 'cache-control': 'no-store' });
  if (m[2] === 'seq') {
    const res = await doFetch(env, table.id, '/seq');
    return new Response(res.body, { status: res.status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } });
  }
  if (m[2] === 'data') {
    const res = await doFetch(env, table.id, '/state');
    return new Response(res.body, { status: res.status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } });
  }
  const res = await doFetch(env, table.id, '/files/' + m[3]);
  const headers = new Headers(res.headers);
  headers.set('cache-control', 'no-store');
  return new Response(res.body, { status: res.status, headers });
}

// ---------------------------------------------------------------------------
// 公开页面的资源 Cookie
// ---------------------------------------------------------------------------

const enc = new TextEncoder();

/** @param {any} env */
function pubKey(env) {
  if (!env.SESSION_SECRET) throw new Error('SESSION_SECRET 未配置');
  // 与会话签名分开派生：公开 Cookie 永远不可能被当成会话 Cookie 用
  return crypto.subtle.importKey('raw', enc.encode('public-view:' + env.SESSION_SECRET),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
}

/** @param {string} tableId @param {any} env @returns {Promise<string>} */
async function signPub(tableId, env, now = Date.now()) {
  const body = tableId + '.' + (now + PUB_TTL_MS);
  const sig = await crypto.subtle.sign('HMAC', await pubKey(env), enc.encode(body));
  return body + '.' + bytesToB64url(sig);
}

/** @param {Request} request @param {any} env @returns {Promise<boolean>} */
export async function hasPublicCookie(request, env) {
  const raw = (request.headers.get('cookie') ?? '').split(/;\s*/).find((x) => x.startsWith(PUB_COOKIE + '='));
  if (!raw || !env.SESSION_SECRET) return false;
  const v = raw.slice(PUB_COOKIE.length + 1);
  const parts = v.split('.');
  if (parts.length !== 3 || !TABLE_ID_RE.test(parts[0]) || !/^\d{1,15}$/.test(parts[1])) return false;
  if (Number(parts[1]) < Date.now()) return false;
  try {
    return await crypto.subtle.verify('HMAC', await pubKey(env), b64urlToBytes(parts[2]), enc.encode(parts[0] + '.' + parts[1]));
  } catch { return false; }
}

/**
 * /t/<id>?view=<令牌> 的文档请求：令牌有效就返回 null 以外的 Cookie 头。
 * @param {URL} url @param {any} env @returns {Promise<string | null>}
 */
export async function publicPageCookie(url, env) {
  const m = /^\/t\/([A-Za-z0-9_-]{4,64})$/.exec(url.pathname);
  const token = url.searchParams.get('view') ?? '';
  if (!m || !TOKEN_RE.test(token) || !env.SESSION_SECRET) return null;
  const table = await tableOfToken(env, token);
  if (!table || table.id !== m[1]) return null;
  const secure = url.protocol === 'https:' ? '; Secure' : '';
  return PUB_COOKIE + '=' + await signPub(table.id, env) + '; Path=/; HttpOnly; SameSite=Lax; Max-Age=' + PUB_TTL_MS / 1000 + secure;
}
