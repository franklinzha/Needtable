/**
 * 全站开关，存在 D1 的 app_settings 里（见 migrations/0003_settings.sql）。
 *
 * 不做内存缓存：登录与开通本来就要查 D1，多一次读不花写额度；
 * 而缓存的代价是管理员刚关掉动态码，别的 isolate 还要再拦一分钟。
 */

/**
 * 登录是否必须带动态码。没有这一行就是关。
 *
 * 只有「表还不存在」（0003 迁移还没跑）才当作关；别的数据库错误照常抛 ——
 * D1 抖一下就把第二因素放掉，那不叫默认值，叫漏洞。
 * @param {any} env @returns {Promise<boolean>}
 */
export async function totpRequired(env) {
  try {
    const row = await env.DB.prepare('SELECT value FROM app_settings WHERE key = ?')
      .bind('totp_required').first();
    return row?.value === '1';
  } catch (err) {
    if (/no such table/i.test(String(/** @type {Error} */ (err)?.message))) return false;
    throw err;
  }
}

/** @param {any} env @param {boolean} on @param {string} byUserId */
export async function setTotpRequired(env, on, byUserId) {
  await env.DB.prepare(
    `INSERT INTO app_settings (key, value, updated_at, updated_by) VALUES (?, ?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value,
                                      updated_at = excluded.updated_at,
                                      updated_by = excluded.updated_by`,
  ).bind('totp_required', on ? '1' : '0', Date.now(), byUserId).run();
}

/** 管理员开户 / 重置时给的默认密码。首次登录必须改掉。 */
export const DEFAULT_PASSWORD = 'Password@130';

/** @param {any} env @returns {Promise<string>} */
export async function defaultPassword(env) {
  try {
    const row = await env.DB.prepare('SELECT value FROM app_settings WHERE key = ?').bind('default_password').first();
    return row?.value || DEFAULT_PASSWORD;
  } catch (err) {
    if (/no such table/i.test(String(/** @type {Error} */ (err)?.message))) return DEFAULT_PASSWORD;
    throw err;
  }
}

/** @param {any} env @param {string} pw @param {string} byUserId */
export async function setDefaultPassword(env, pw, byUserId) {
  await env.DB.prepare(
    `INSERT INTO app_settings (key, value, updated_at, updated_by) VALUES (?, ?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value,
                                      updated_at = excluded.updated_at,
                                      updated_by = excluded.updated_by`,
  ).bind('default_password', pw, Date.now(), byUserId).run();
}

/** @param {any} env @param {string} key @returns {Promise<string | null>} 表还没建时当作没有 */
async function readSetting(env, key) {
  try {
    const row = await env.DB.prepare('SELECT value FROM app_settings WHERE key = ?').bind(key).first();
    return row?.value ?? null;
  } catch (err) {
    if (/no such table/i.test(String(/** @type {Error} */ (err)?.message))) return null;
    throw err;
  }
}

/** @param {any} env @param {string} key @param {string} value @param {string} byUserId */
async function writeSetting(env, key, value, byUserId) {
  await env.DB.prepare(
    `INSERT INTO app_settings (key, value, updated_at, updated_by) VALUES (?, ?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value,
                                      updated_at = excluded.updated_at,
                                      updated_by = excluded.updated_by`,
  ).bind(key, value, Date.now(), byUserId).run();
}

/**
 * 系统默认配色 + 管理员加的配色。读坏了（手改过数据库）就当没有，不影响登录。
 * @param {any} env @returns {Promise<{ def: string | null, custom: any[] }>}
 */
export async function themeConfig(env) {
  const def = await readSetting(env, 'theme_default');
  let custom = [];
  try { custom = JSON.parse((await readSetting(env, 'themes_custom')) ?? '[]'); } catch { /* 坏数据当空 */ }
  return { def: def || null, custom: Array.isArray(custom) ? custom : [] };
}

/** @param {any} env @param {{ def?: string, custom?: any[] }} cfg @param {string} byUserId */
export async function setThemeConfig(env, cfg, byUserId) {
  if (cfg.custom !== undefined) await writeSetting(env, 'themes_custom', JSON.stringify(cfg.custom), byUserId);
  if (cfg.def !== undefined) await writeSetting(env, 'theme_default', cfg.def, byUserId);
}
