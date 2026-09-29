/**
 * AI 接口：目前只占位，不接任何模型。
 *
 * 路由和请求 / 响应形状先定下来，前端（public/js/ai/index.js）照这个写；
 * 以后接模型时只要在 PROVIDERS 里登记一个实现，并把 capabilities 里的 enabled 打开，
 * 前端不用改。没有启用时一律 501，前端据此把入口显示成「即将推出」。
 *
 *   GET  /api/ai/capabilities → { enabled, providers: [{ id, name, features }] }
 *   POST /api/ai/complete     { prompt, context? }            → { text }
 *   POST /api/ai/formula      { question, tableId?, range? }  → { formula, explanation }
 */

import { json, fail, badRequest } from '../lib/response.js';
import { t } from '../../public/shared/i18n/i18n.js';

/**
 * 已登记的模型提供方。每项：
 *   { id, name, features: ('complete'|'formula')[], complete?(env, body), formula?(env, body) }
 * @type {any[]}
 */
export const PROVIDERS = [];

const notEnabled = () => fail(501, 'ai_disabled', t('AI 模块未启用'));

async function readBody(request) {
  try { return await request.json(); } catch { return null; }
}

/** GET /api/ai/capabilities */
export async function aiCapabilities(/** @type {Request} */ request, /** @type {any} */ c) {
  const providers = PROVIDERS.map(({ id, name, features }) => ({ id, name, features }));
  return json({ enabled: providers.length > 0, providers });
}

/** 挑第一个支持该功能的提供方 */
function pick(feature) {
  return PROVIDERS.find((p) => p.features?.includes(feature) && typeof p[feature] === 'function') ?? null;
}

/** POST /api/ai/complete */
export async function aiComplete(/** @type {Request} */ request, /** @type {any} */ c) {
  const p = pick('complete');
  if (!p) return notEnabled();
  const body = await readBody(request);
  if (!body || typeof body.prompt !== 'string' || !body.prompt.trim()) return badRequest(t('缺少 prompt'));
  return json(await p.complete(c.env, body, c.user));
}

/** POST /api/ai/formula */
export async function aiFormula(/** @type {Request} */ request, /** @type {any} */ c) {
  const p = pick('formula');
  if (!p) return notEnabled();
  const body = await readBody(request);
  if (!body || typeof body.question !== 'string' || !body.question.trim()) return badRequest(t('缺少 question'));
  return json(await p.formula(c.env, body, c.user));
}
