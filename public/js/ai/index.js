/**
 * AI 能力的前端入口 —— 目前只预留接口，不接任何模型。
 *
 * 界面只认 AIProvider 这几个方法；服务端没启用 AI（GET /api/ai/capabilities 回 enabled:false）
 * 时拿到的是 NullProvider，所有调用直接报「未启用」，入口显示成「即将推出」。
 * 以后服务端（worker/routes/ai.js）登记了模型，这里自动换成 RemoteProvider，界面不用改。
 */

import { api } from '../core/api.js';
import { t } from '../../shared/i18n/i18n.js';

/**
 * @typedef {{ enabled: boolean, providers: { id: string, name: string, features: string[] }[] }} AICapabilities
 */

export class AIDisabledError extends Error {
  constructor() { super(t('AI 模块未启用')); this.name = 'AIDisabledError'; }
}

/** 接口约定：所有实现都有这几个方法。 */
export class AIProvider {
  get enabled() { return false; }
  /** @param {string} feature 'complete' | 'formula' */
  supports(feature) { return false; }
  /**
   * 通用补全。
   * @param {string} prompt @param {Record<string, unknown>} [context]
   * @returns {Promise<{ text: string }>}
   */
  async complete(prompt, context) { throw new AIDisabledError(); }
  /**
   * 用自然语言描述要算什么，返回一条公式。
   * @param {string} question @param {{ tableId?: string, range?: string }} [where]
   * @returns {Promise<{ formula: string, explanation: string }>}
   */
  async formula(question, where) { throw new AIDisabledError(); }
}

/** 未启用：什么都不做。 */
export class NullProvider extends AIProvider {}

/** 走服务端 /api/ai/*。 */
export class RemoteProvider extends AIProvider {
  /** @param {AICapabilities} caps */
  constructor(caps) { super(); this.caps = caps; }
  get enabled() { return this.caps.enabled; }
  supports(feature) { return this.caps.providers.some((p) => p.features.includes(feature)); }
  async complete(prompt, context) {
    if (!this.supports('complete')) throw new AIDisabledError();
    return api.post('/api/ai/complete', { prompt, context });
  }
  async formula(question, where = {}) {
    if (!this.supports('formula')) throw new AIDisabledError();
    return api.post('/api/ai/formula', { question, ...where });
  }
}

/** @type {Promise<AIProvider> | null} */
let cached = null;

/** 取当前可用的 AI 实现（整个页面只问一次服务端）；接口出错也当作未启用。 */
export function getAI() {
  cached ??= api.get('/api/ai/capabilities')
    .then((/** @type {AICapabilities} */ caps) => caps?.enabled ? new RemoteProvider(caps) : new NullProvider())
    .catch(() => new NullProvider());
  return cached;
}
