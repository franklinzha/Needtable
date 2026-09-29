/**
 * 跨表引用（=tbl_xxx!A1、IMPORTRANGE）的两个接口。
 *
 * 规则与 Google 表格的 IMPORTRANGE 一样：「引用大于权限」。
 *
 *   登记  POST /api/tables/:A/refs { refs: [{ to, range }] }
 *         写公式的人对 A 至少能编辑、对被引用的表 B 至少能查看，服务端就记一条
 *         「A → B 的这块区域」到 table_refs。客户端在公式提交时调用。
 *
 *   读取  POST /api/tables/:A/ext { items: [{ src, range }] }
 *         调用者对 A 至少能查看，并且满足其一就放行：
 *           · table_refs 里有 A → src、盖住这块区域的登记；
 *           · 他自己对 src 至少能查看（自己的两张表之间，不登记也能用）。
 *         于是对 B 没有任何权限、但能看 A 的人，能看到 A 引用的那块区域的**计算结果**
 *         —— 看不到公式原文，也看不到 B 的其它部分，更打不开 B。
 *
 * 计算在被引用表自己的 DO 里做（/range）。B 又引用了 C：DO 把需要的外表区域报回来，
 * 这里按 B → C 的登记放行、取来再交给 B 重算；最多往下 MAX_EXT_DEPTH 层，
 * 同一块区域在链上出现第二次就是循环，给 #CIRC!。
 *
 * 免费档 D1 每次调用最多 50 条查询：一个表的全部登记一次查出来缓存在本次请求里，
 * 每批最多 ITEMS_MAX 项。
 */

import { json, badRequest } from '../lib/response.js';
import { t } from '../../public/shared/i18n/i18n.js';
import { requireTableRole } from '../middleware/rbac.js';
import {
  TABLE_ID_RE, MAX_EXT_DEPTH, parseRange, keyOf, tooBig, covers,
} from '../../public/shared/formula/extref.js';

const ITEMS_MAX = 10;
const REFS_PER_REQUEST = 20;
/** 一张表最多登记多少条引用（防止被当成任意读取的后门刷爆） */
const REFS_PER_TABLE = 500;
/** 一次请求里最多调几次 DO（免费档子请求上限 50，留足余量） */
const DO_CALLS_MAX = 30;
/** 取值时多轮重算：B 的某个 IF 分支拿到外表值之后可能又需要别的外表区域 */
const ROUNDS = 3;

const REF_ERR = { e: '#REF!' };

async function readJson(request) {
  try { return await request.json(); } catch { return null; }
}

/** POST /api/tables/:id/refs */
export async function registerRefs(request, c) {
  const from = c.params.id;
  const gate = await requireTableRole(c.env, c.user, from, 'editor');
  if ('response' in gate) return gate.response;
  const body = await readJson(request);
  const list = Array.isArray(body?.refs) ? body.refs : null;
  if (!list || list.length > REFS_PER_REQUEST) return badRequest(t('refs 应为数组，每次最多 {n} 条', { n: REFS_PER_REQUEST }));

  const count = await c.env.DB.prepare('SELECT COUNT(*) AS n FROM table_refs WHERE from_table = ?').bind(from).first();
  let room = REFS_PER_TABLE - Number(count?.n ?? 0);
  const now = Date.now();
  const results = [];
  for (const item of list) {
    const to = typeof item?.to === 'string' ? item.to : '';
    const g = parseRange(item?.range);
    const range = g ? keyOf(g) : String(item?.range ?? '');
    if (!TABLE_ID_RE.test(to) || !g) { results.push({ to, range, ok: false, error: t('表编号或区域写法不对') }); continue; }
    if (tooBig(g)) { results.push({ to, range, ok: false, error: t('区域太大（最多 5 万格，整列 / 整行最多 50 列 / 行）') }); continue; }
    if (to === from) { results.push({ to, range, ok: true }); continue; }   // 引用自己不用登记

    const target = await requireTableRole(c.env, c.user, to, 'viewer');
    if ('response' in target) {
      results.push({ to, range, ok: false, error: target.response.status === 404 ? t('表 {id} 不存在，或者没有分享给你', { id: to }) : t('你对表 {id} 没有查看权限', { id: to }) });
      continue;
    }
    if (room <= 0) { results.push({ to, range, ok: false, error: t('这张表的跨表引用太多了（最多 {n} 处）', { n: REFS_PER_TABLE }) }); continue; }
    const r = await c.env.DB.prepare(
      'INSERT OR IGNORE INTO table_refs (from_table, to_table, range_a1, created_by, created_at) VALUES (?, ?, ?, ?, ?)',
    ).bind(from, to, range, c.user.id, now).run();
    if (r?.meta?.changes) room--;
    results.push({ to, range, ok: true });
  }
  return json({ results });
}

/** POST /api/tables/:id/ext */
export async function readExt(request, c) {
  const from = c.params.id;
  const gate = await requireTableRole(c.env, c.user, from, 'viewer');
  if ('response' in gate) return gate.response;
  const body = await readJson(request);
  const items = Array.isArray(body?.items) ? body.items : null;
  if (!items || items.length > ITEMS_MAX) return badRequest(t('items 应为数组，每次最多 {n} 项', { n: ITEMS_MAX }));

  const ctx = newCtx(c);
  const results = [];
  for (const item of items) {
    const src = typeof item?.src === 'string' ? item.src : '';
    const g = parseRange(item?.range);
    if (!TABLE_ID_RE.test(src) || !g || tooBig(g)) { results.push(REF_ERR); continue; }
    let ok = src === from || await granted(ctx, from, src, g);
    if (!ok) ok = !('response' in await requireTableRole(c.env, c.user, src, 'viewer'));
    results.push(ok ? await compute(ctx, src, keyOf(g), [], 1) : REF_ERR);
  }
  return json({ results });
}

/**
 * 公开只读链接里的跨表引用：只认 table_refs 的登记（公开访客对别的表没有任何权限）。
 * @param {Request} request @param {any} env @param {string} from 已由令牌确认的表
 */
export async function readExtPublic(request, env, from) {
  const body = await readJson(request);
  const items = Array.isArray(body?.items) ? body.items : null;
  if (!items || items.length > ITEMS_MAX) return badRequest(t('items 应为数组，每次最多 {n} 项', { n: ITEMS_MAX }));
  const ctx = newCtx({ env, user: { id: 'public', email: '' } });
  const results = [];
  for (const item of items) {
    const src = typeof item?.src === 'string' ? item.src : '';
    const g = parseRange(item?.range);
    if (!TABLE_ID_RE.test(src) || !g || tooBig(g)) { results.push(REF_ERR); continue; }
    const ok = src === from || await granted(ctx, from, src, g);
    results.push(ok ? await compute(ctx, src, keyOf(g), [], 1) : REF_ERR);
  }
  return json({ results });
}

/** @param {any} c */
function newCtx(c) {
  return {
    env: c.env,
    uid: c.user.id,
    email: c.user.email,
    /** @type {Map<string, Promise<{ to: string, g: any }[]>>} from_table → 登记（本次请求内缓存） */
    refs: new Map(),
    calls: 0,
  };
}

/**
 * table_refs 里有没有 from → to、盖住 g 的登记。被引用的表已删除的不算。
 * @param {ReturnType<typeof newCtx>} ctx @param {string} from @param {string} to @param {any} g
 */
async function granted(ctx, from, to, g) {
  let p = ctx.refs.get(from);
  if (!p) {
    p = ctx.env.DB.prepare(
      `SELECT r.to_table AS to_table, r.range_a1 AS range_a1
         FROM table_refs r JOIN tables t ON t.id = r.to_table
        WHERE r.from_table = ?`,
    ).bind(from).all().then((/** @type {any} */ res) => (res?.results ?? []).map((/** @type {any} */ row) => ({
      to: String(row.to_table), g: parseRange(String(row.range_a1)),
    })));
    ctx.refs.set(from, /** @type {any} */ (p));
  }
  const list = await /** @type {Promise<{ to: string, g: any }[]>} */ (p);
  return list.some((x) => x.to === to && x.g && covers(x.g, g));
}

/**
 * 在 id 的 DO 里算出 key 这块区域；它要的外表区域按 id 的登记放行后递归取来。
 * @param {ReturnType<typeof newCtx>} ctx @param {string} id @param {string} key
 * @param {string[]} chain 调用链上已经在算的「表!区域」，用来发现循环
 * @param {number} depth
 * @returns {Promise<any>} 打包的区域，或 { e }
 */
async function compute(ctx, id, key, chain, depth) {
  const me = id + '!' + key;
  /** @type {Record<string, any>} */ const provided = {};
  let res = null;
  for (let round = 0; round < ROUNDS; round++) {
    res = await callRange(ctx, id, key, provided);
    if (!res || typeof res.e === 'string') return res ?? REF_ERR;
    const fresh = (res.needs ?? []).filter((/** @type {string} */ k) => !Object.hasOwn(provided, k));
    if (!fresh.length) break;
    for (const need of fresh) {
      const bang = need.indexOf('!');
      const t = need.slice(0, bang);
      const g = parseRange(need.slice(bang + 1));
      if (!TABLE_ID_RE.test(t) || !g || tooBig(g)) provided[need] = REF_ERR;
      else if (need === me || chain.includes(need)) provided[need] = { e: '#CIRC!' };
      else if (depth >= MAX_EXT_DEPTH) provided[need] = REF_ERR;
      else if (!(await granted(ctx, id, t, g))) provided[need] = REF_ERR;
      else provided[need] = await compute(ctx, t, keyOf(g), [...chain, me], depth + 1);
    }
  }
  return { r0: res.r0, c0: res.c0, rows: res.rows };
}

/**
 * @param {ReturnType<typeof newCtx>} ctx @param {string} id @param {string} key @param {Record<string, any>} provided
 */
async function callRange(ctx, id, key, provided) {
  if (++ctx.calls > DO_CALLS_MAX) return REF_ERR;
  const stub = ctx.env.TABLE_DO.get(ctx.env.TABLE_DO.idFromName(id));
  const r = await stub.fetch('https://do/range', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      // DO 只认 Worker 透传的身份头；这里是「服务端替 A 表去读」，角色一律 viewer
      'x-table-id': id,
      'x-user-id': ctx.uid,
      'x-user-email': ctx.email,
      'x-user-role': 'viewer',
    },
    body: JSON.stringify({ range: key, provided }),
  });
  if (!r.ok) return REF_ERR;
  try { return await r.json(); } catch { return REF_ERR; }
}
