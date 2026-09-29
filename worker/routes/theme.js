/**
 * 主题配色：每个人选自己的配色，管理员设系统默认、增删自定义配色。
 *
 * 配色本身（24 套内置 + 推导规则）在 public/shared/theme.js，前后端共用；
 * 这里只存「谁选了哪套」和管理员加的那几套。
 */

import { json, badRequest, forbidden } from '../lib/response.js';
import { t } from '../../public/shared/i18n/i18n.js';
import { themeConfig, setThemeConfig } from '../lib/settings.js';
import { DEFAULT_THEME, MAX_CUSTOM_THEMES, cleanTheme, findTheme } from '../../public/shared/theme.js';

/** @param {Request} request */
async function readJson(request) {
  try { return await request.json(); } catch { return null; }
}

/** 自己选的配色。users.theme 列还没迁移时当作没选。 @param {any} env @param {string} userId */
async function myTheme(env, userId) {
  try {
    const row = await env.DB.prepare('SELECT theme FROM users WHERE id = ?').bind(userId).first();
    return row?.theme ?? null;
  } catch { return null; }
}

/**
 * /api/me 里带的主题信息：mine = 自己选的（null = 跟随默认），def = 系统默认，custom = 管理员加的。
 * 选过的配色被管理员删了，就当没选。
 * @param {any} env @param {string} userId
 */
export async function themeView(env, userId) {
  const cfg = await themeConfig(env);
  const custom = cfg.custom.map(cleanTheme).filter(Boolean);
  const def = findTheme(cfg.def, custom) ? cfg.def : DEFAULT_THEME;
  const mine = await myTheme(env, userId);
  return { mine: findTheme(mine, custom) ? mine : null, def, custom };
}

/** PUT /api/me/theme — body: { theme: id | null } */
export async function putMyTheme(/** @type {Request} */ request, /** @type {any} */ c) {
  const body = await readJson(request);
  const id = body?.theme ?? null;
  if (id !== null) {
    const { custom } = await themeConfig(c.env);
    if (typeof id !== 'string' || !findTheme(id, custom.map(cleanTheme).filter(Boolean))) return badRequest(t('没有这套配色'));
  }
  await c.env.DB.prepare('UPDATE users SET theme = ? WHERE id = ?').bind(id, c.user.id).run();
  return json(await themeView(c.env, c.user.id));
}

/** PUT /api/admin/theme — body: { def?: id, custom?: Theme[] }（custom 是整份替换） */
export async function putAdminTheme(/** @type {Request} */ request, /** @type {any} */ c) {
  if (c.user.role !== 'admin') return forbidden(t('只有管理员能修改系统配色'));
  const body = await readJson(request);
  if (!body || (body.def === undefined && body.custom === undefined)) return badRequest(t('没有要修改的内容'));
  const cfg = await themeConfig(c.env);
  /** @type {any[]} */ let custom = cfg.custom.map(cleanTheme).filter(Boolean);
  if (body.custom !== undefined) {
    if (!Array.isArray(body.custom) || body.custom.length > MAX_CUSTOM_THEMES) return badRequest(t('自定义配色最多 {n} 套', { n: MAX_CUSTOM_THEMES }));
    const next = body.custom.map(cleanTheme);
    if (next.some((th) => !th)) return badRequest(t('配色要有名字和 5 个 #rrggbb 颜色'));
    const ids = new Set(next.map((th) => /** @type {any} */ (th).id));
    if (ids.size !== next.length) return badRequest(t('配色编号重复'));
    custom = next.map(({ id, name, colors }) => ({ id, name, colors }));
  }
  let def = body.def !== undefined ? body.def : cfg.def;
  if (def != null && (typeof def !== 'string' || !findTheme(def, custom))) {
    if (body.def !== undefined) return badRequest(t('没有这套配色'));
    def = DEFAULT_THEME;   // 删掉的正好是系统默认：退回马卡龙
  }
  await setThemeConfig(c.env, {
    ...(body.custom !== undefined ? { custom } : {}),
    ...(def !== cfg.def ? { def: def ?? DEFAULT_THEME } : {}),
  }, c.user.id);
  return json(await themeView(c.env, c.user.id));
}
