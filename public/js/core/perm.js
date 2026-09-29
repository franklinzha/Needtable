/**
 * 前端的权限判断，只用来决定按钮显不显示 —— 真正的把关在服务端（worker/lib/tiers.js、
 * worker/middleware/rbac.js），这里算错了顶多是点了之后收到 403。
 */

import { t } from '../../shared/i18n/i18n.js';

const RANK = /** @type {Record<string, number>} */ ({ viewer: 1, editor: 2, manager: 3, owner: 4 });

/** @param {string | null | undefined} role @param {'viewer'|'editor'|'manager'|'owner'} min */
export const atLeast = (role, min) => (RANK[role ?? ''] ?? 0) >= RANK[min];

export const ROLE_LABEL = /** @type {Record<string, string>} */ ({
  owner: t('所有者'), manager: t('管理者'), editor: t('可编辑'), viewer: t('只读'),
});

/** 账号等级允许新建工作区 / 内容 / 表吗（normal 不行）。 @param {any} user */
export const canCreate = (user) => !!user?.tier?.create;

/** 账号等级允许分享吗。 @param {any} user */
export const canShare = (user) => !!user?.tier?.share;
