/**
 * 用户等级：admin > pro > plus > normal。
 *
 * 等级管的是「这个人能不能新建东西、能不能分享给别人」；
 * 能不能看、能不能改某一张表，是资源角色（owner/manager/editor/viewer）的事，见 rbac.js。
 * 两者独立：normal 不能建表，但被分配成某张表的 editor 之后照样能编辑它。
 *
 * 想调整额度，只改这张表。
 */

/**
 * @typedef {object} Tier
 * @property {string} name
 * @property {number} rank
 * @property {string} label
 * @property {number} maxWorkspaces   自己拥有的工作区上限
 * @property {boolean} create         能否新建工作区 / 内容 / 表
 * @property {boolean} share          能否把自己管理的东西分享给别人
 * @property {boolean} grantManager   能否授出「管理者」（对方可以继续转分享）
 * @property {boolean} publicShare    能否开公开只读链接（不登录也能看）
 */

/** @type {Record<string, Tier>} */
export const TIERS = {
  admin:  { name: 'admin', rank: 4, label: '管理员', maxWorkspaces: Infinity, create: true,  share: true,  grantManager: true,  publicShare: true },
  pro:    { name: 'pro', rank: 3, label: 'Pro',    maxWorkspaces: Infinity, create: true,  share: true,  grantManager: true,  publicShare: true },
  plus:   { name: 'plus', rank: 2, label: 'Plus',   maxWorkspaces: 3,        create: true,  share: true,  grantManager: false, publicShare: false },
  normal: { name: 'normal', rank: 1, label: '普通',   maxWorkspaces: 0,        create: false, share: false, grantManager: false, publicShare: false },
};

export const TIER_NAMES = /** @type {const} */ (['admin', 'pro', 'plus', 'normal']);

/** 资源角色的强弱。 */
export const RANK = { viewer: 1, editor: 2, manager: 3, owner: 4 };

/** 可见视图。scope 为 NULL 表示全部。 */
export const VIEWS = /** @type {const} */ (['grid', 'kanban', 'dashboard']);

/** 老数据里的 member 当 plus 看（迁移之前签发的缓存里可能还有）。 @param {{role?: string}} user */
export function tierOf(user) {
  return TIERS[user?.role ?? ''] ?? TIERS.plus;
}

/**
 * @param {{role?: string}} user
 * @param {'create'|'share'|'grantManager'|'publicShare'} what
 */
export function can(user, what) {
  return !!tierOf(user)[what];
}

/** a 的等级是否严格高于 b。 @param {{role?: string}} a @param {{role?: string}} b */
export function outranks(a, b) {
  return tierOf(a).rank > tierOf(b).rank;
}

/** a 的等级是否不低于 b。 @param {{role?: string}} a @param {{role?: string}} b */
export function atLeastTier(a, b) {
  return tierOf(a).rank >= tierOf(b).rank;
}

/** 这个人能授出的资源角色。 @param {{role?: string}} user */
export function grantableRoles(user) {
  if (!can(user, 'share')) return [];
  return can(user, 'grantManager') ? ['viewer', 'editor', 'manager'] : ['viewer', 'editor'];
}

/**
 * 规范化 scope：数组 / 逗号串 → 排好序的逗号串；全选或不传 → null。
 * @param {unknown} v @returns {{ ok: true, scope: string | null } | { ok: false }}
 */
export function normalizeScope(v) {
  if (v == null) return { ok: true, scope: null };
  const list = Array.isArray(v) ? v : typeof v === 'string' ? v.split(',') : null;
  if (!list) return { ok: false };
  const set = new Set(list.map((x) => String(x).trim()).filter(Boolean));
  if (!set.size) return { ok: false };
  for (const x of set) if (!VIEWS.includes(/** @type {any} */ (x))) return { ok: false };
  if (set.size === VIEWS.length) return { ok: true, scope: null };
  return { ok: true, scope: VIEWS.filter((x) => set.has(x)).join(',') };
}
