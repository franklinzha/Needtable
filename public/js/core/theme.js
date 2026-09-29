/**
 * 切换主题配色：算出整套 CSS 变量，写进缓存，交给 theme-boot.js 贴到 <html> 上。
 * 然后发一个 window 'themechange' 事件：画在 canvas 上的网格、图表要自己重读颜色。
 */

import { DEFAULT_THEME, findTheme, themeVars } from '../../shared/theme.js';

const KEY = 'nt-theme';

/** /api/me 返回的主题信息 @typedef {{ mine: string | null, def: string, custom: import('../../shared/theme.js').Theme[] }} ThemeInfo */

/** 实际生效的配色 id：自己选的，否则系统默认。 @param {ThemeInfo | undefined} info */
export function effectiveTheme(info) {
  const id = info?.mine ?? info?.def ?? DEFAULT_THEME;
  return findTheme(id, info?.custom) ? id : DEFAULT_THEME;
}

/**
 * 贴上配色。默认配色（马卡龙）不贴任何东西，直接用 tokens.css。
 * @param {string} id @param {import('../../shared/theme.js').Theme[]} [custom]
 */
export function applyTheme(id, custom = []) {
  const t = findTheme(id, custom);
  const next = !t || t.id === DEFAULT_THEME ? null : { id: t.id, ...themeVars(t.colors) };
  if ((next?.id ?? null) === current) return;
  current = next?.id ?? null;
  try {
    if (next) localStorage.setItem(KEY, JSON.stringify(next));
    else localStorage.removeItem(KEY);
  } catch { /* 隐私模式存不了：照样贴，只是下次打开会先闪一下默认色 */ }
  const w = /** @type {any} */ (window);
  if (typeof w.__ntApplyTheme === 'function') w.__ntApplyTheme(next);
  window.dispatchEvent(new Event('themechange'));
}

/** 当前贴着的配色（null = 默认），首次调用前以缓存为准 */
let current = (() => { try { return JSON.parse(localStorage.getItem(KEY) ?? 'null')?.id ?? null; } catch { return null; } })();
