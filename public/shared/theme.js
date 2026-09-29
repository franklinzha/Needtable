/**
 * 主题配色：每套 5 个颜色，由它们推导出整套界面令牌（tokens.css 里的 --c-* 变量）。
 * 前端（切换主题、预览）和服务端（校验管理员新增的配色）共用。纯逻辑，不碰 DOM。
 *
 * 推导规则（亮色）：
 *   · 5 个原色直接当 --c-pastel-*，用来铺底和点缀；
 *   · 最鲜艳的那个颜色 → 强调色，第二鲜艳且色相差得开的 → 第二强调色，
 *     都按原色相**加深**到对白底对比度 ≥ 4.5（原色太浅，直接当文字读不清）；
 *   · 背景、边框、文字都是带一点强调色色相的中性色。
 * 暗色：原色压暗当点缀，强调色提亮到对深色背景对比度 ≥ 4.5。
 * 默认主题（Pastel Dreams）不推导，直接用 tokens.css 里手调的值。
 */

export const DEFAULT_THEME = 'pastel-dreams';
/** 管理员最多加这么多套自定义配色 */
export const MAX_CUSTOM_THEMES = 30;

/** @typedef {{ id: string, name: string, colors: string[], custom?: boolean }} Theme */

/** @type {[string, string][]} [名字, 5 个颜色] */
const RAW = [
  ['Pastel Dreams', 'ff99c8 fcf6bd d0f4de a9def9 e4c1f9'],
  ['Sunrise Glow', 'ffc09f ffee93 fcf5c7 a0ced9 adf7b6'],
  ['Pastel Dream', 'fdc5f5 f7aef8 b388eb 8093f1 72ddf7'],
  ['Peachy Delight', 'ffac81 ff928b fec3a6 efe9ae cdeac0'],
  ['Pastel Skies', 'e5d9f2 f5efff cdc1ff a594f9 7371fc'],
  ['Dreamy Pastels', 'efd9ce dec0f1 b79ced 957fef 7161ef'],
  ['Pastel Dreamland', 'd3f8e2 e4c1f9 f694c1 ede7b1 a9def9'],
  ['Pastel Fantasy', '7bdff2 b2f7ef eff7f6 f7d6e0 f2b5d4'],
  ['Soft Lavender', '9381ff b8b8ff f8f7ff ffeedd ffd8be'],
  ['Vibrant Nature Hues', 'ee6055 60d394 aaf683 ffd97d ff9b85'],
  ['Soft Ivory', 'd0b8ac f3d8c7 efe5dc fbfefb ffffff'],
  ['Peachy Sunrise', 'ffffff 84dcc6 a5ffd6 ffa69e ff686b'],
  ['Pastel Rainbow', '70d6ff ff70a6 ff9770 ffd670 e9ff70'],
  ['Pastel Pop', '5aa9e6 7fc8f8 f9f9f9 ffe45e ff6392'],
  ['Pastel Serenity', 'e27396 ea9ab2 efcfe3 eaf2d7 b3dee2'],
  ['Summer Splash', 'ff69eb ff86c8 ffa3a5 ffbf81 ffdc5e'],
  ['Peach Sorbet', 'f08080 f4978e f8ad9d fbc4ab ffdab9'],
  ['Refreshing Spring Hues', '90f1ef ffd6e0 ffef9f c1fba4 7bf1a8'],
  ['Pastel Bliss', 'ffb5a7 fcd5ce f8edeb f9dcc4 fec89a'],
  ['Pastel Dreamland Adventure', 'cdb4db ffc8dd ffafcc bde0fe a2d2ff'],
  ['Soft Pastels', 'ffd6ff e7c6ff c8b6ff b8c0ff bbd0ff'],
  ['Golden Summer Fields', 'ccd5ae e9edc9 fefae0 faedcd d4a373'],
  ['Soft Pink Delight', 'ffe5ec ffc2d1 ffb3c6 ff8fab fb6f92'],
  ['Soft Sand', 'edede9 d6ccc2 f5ebe0 e3d5ca d5bdaf'],
];

const slug = (/** @type {string} */ s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

/** 内置的 24 套配色。 @type {Theme[]} */
export const PALETTES = RAW.map(([name, cs]) => ({ id: slug(name), name, colors: cs.split(' ').map((c) => '#' + c) }));

/** @param {any} c */
export const isHex = (c) => typeof c === 'string' && /^#[0-9a-f]{6}$/i.test(c);

/**
 * 校验并清洗一套自定义配色。不合格返回 null。
 * @param {any} t @returns {Theme | null}
 */
export function cleanTheme(t) {
  if (!t || typeof t !== 'object') return null;
  const name = String(t.name ?? '').replace(/\s+/g, ' ').trim().slice(0, 30);
  if (!name) return null;
  if (!Array.isArray(t.colors) || t.colors.length !== 5 || !t.colors.every(isHex)) return null;
  const id = String(t.id ?? '');
  if (!/^c_[a-z0-9]{4,16}$/.test(id)) return null;
  return { id, name, colors: t.colors.map((/** @type {string} */ c) => c.toLowerCase()), custom: true };
}

/**
 * 按 id 找配色（内置 + 自定义），找不到返回 null。
 * @param {string | null | undefined} id @param {Theme[]} [custom]
 */
export function findTheme(id, custom = []) {
  if (!id) return null;
  return PALETTES.find((p) => p.id === id) ?? custom.find((p) => p.id === id) ?? null;
}

// ── 颜色运算 ────────────────────────────────────────────────────────────────

/** @param {string} hex @returns {[number, number, number]} 0..255 */
export function rgbOf(hex) {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/** @param {number[]} rgb */
const hexOf = (rgb) => '#' + rgb.map((x) => Math.round(Math.max(0, Math.min(255, x))).toString(16).padStart(2, '0')).join('');

/** @param {string} hex @returns {[number, number, number]} h 0..360, s/l 0..1 */
function hslOf(hex) {
  const [r, g, b] = rgbOf(hex).map((x) => x / 255);
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  const h = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return [h * 60, s, l];
}

/** @param {number} h @param {number} s @param {number} l */
export function hsl(h, s, l) {
  s = Math.max(0, Math.min(1, s)); l = Math.max(0, Math.min(1, l));
  const k = (/** @type {number} */ n) => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (/** @type {number} */ n) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  return hexOf([f(0) * 255, f(8) * 255, f(4) * 255]);
}

/** 相对亮度（WCAG）。 @param {string} hex */
function lum(hex) {
  const [r, g, b] = rgbOf(hex).map((x) => { const v = x / 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** 对比度 1..21。 @param {string} a @param {string} b */
export function contrast(a, b) {
  const x = lum(a), y = lum(b);
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}

/** @param {string} hex @param {number} a */
const rgba = (hex, a) => 'rgba(' + rgbOf(hex).join(', ') + ', ' + a + ')';

/** 鲜艳程度：RGB 通道的最大差。 @param {string} hex */
const chroma = (hex) => { const c = rgbOf(hex); return Math.max(...c) - Math.min(...c); };
/** 挑强调色时的分数：黄色加深后发绿发灰（橄榄色），降权 @param {string} hex */
const score = (hex) => { const hh = hslOf(hex)[0]; return chroma(hex) * (hh >= 42 && hh <= 80 ? 0.6 : 1); };
/** 在白字 / 深色字里挑对比度高的那个当按钮文字 @param {string} bg @param {string} darkText */
const onColor = (bg, darkText) => (contrast('#ffffff', bg) >= contrast(darkText, bg) ? '#ffffff' : darkText);

/**
 * 沿亮度方向调，直到对 bg 的对比度够了。dir = -1 变暗，+1 变亮。
 * @param {number} h @param {number} s @param {number} l @param {string} bg @param {number} dir @param {number} [min]
 */
function readable(h, s, l, bg, dir, min = 4.6) {
  for (let i = 0; i < 100; i++) {
    const c = hsl(h, s, l);
    if (contrast(c, bg) >= min) return c;
    l += dir * 0.01;
    if (l <= 0 || l >= 1) break;
  }
  return hsl(h, s, Math.max(0, Math.min(1, l)));
}

/** 两个色相的差（0..180）。 @param {number} a @param {number} b */
const hueGap = (a, b) => { const d = Math.abs(a - b) % 360; return d > 180 ? 360 - d : d; };

/**
 * 5 个颜色 → 亮色 / 暗色两套 CSS 变量。
 * @param {string[]} colors
 * @returns {{ light: Record<string, string>, dark: Record<string, string> }}
 */
export function themeVars(colors) {
  const cs = colors.map((c) => c.toLowerCase());
  const byChroma = cs.map((c, i) => ({ c, i, k: score(c), hsl: hslOf(c) })).sort((a, b) => b.k - a.k || a.i - b.i);
  const main = byChroma[0];
  const second = byChroma.slice(1).find((x) => x.k > 20 && hueGap(x.hsl[0], main.hsl[0]) >= 35) ?? byChroma[1];
  const [h, s0] = main.hsl;
  const [h2, s2] = second.hsl;
  // 颜色很灰（Soft Sand 这类）时，中性色也跟着淡一些
  const tint = Math.min(1, main.k / 120);
  // 饱和度封顶：原色加深后太「艳」会很刺眼
  const s = Math.max(0.35, Math.min(0.62, s0));
  const sb = Math.max(0.3, Math.min(0.5, s2));

  const white = '#ffffff';
  const bg = hsl(h, 0.7 * tint, 0.99);
  // 强调色常写在浅强调底（选中项、标签）上：对它够了，对白底自然也够
  const accentSoft = hsl(h, Math.min(0.9, s + 0.1), 0.945);
  const accent = readable(h, s, Math.min(main.hsl[2], 0.7), accentSoft, -1);
  const accentL = hslOf(accent)[2];
  const accent2 = readable(h2, sb, Math.min(second.hsl[2], 0.7), white, -1);
  const text = hsl(h, 0.18 * tint + 0.05, 0.2);
  const muted = readable(h, 0.14 * tint + 0.04, 0.42, bg, -1);
  const light = {
    '--c-pastel-pink': cs[0], '--c-pastel-yellow': cs[1], '--c-pastel-mint': cs[2], '--c-pastel-blue': cs[3], '--c-pastel-mauve': cs[4],
    '--c-bg': bg,
    '--c-bg-subtle': hsl(h, 0.6 * tint, 0.975),
    '--c-bg-sunken': hsl(h, 0.4 * tint, 0.945),
    '--c-surface': white,
    '--c-border': hsl(h, 0.45 * tint, 0.905),
    '--c-border-strong': hsl(h, 0.25 * tint, 0.82),
    '--c-text': text,
    '--c-text-muted': muted,
    '--c-text-faint': hsl(h, 0.1 * tint + 0.04, 0.6),
    '--c-accent': accent,
    '--c-accent-hover': hsl(h, s, Math.max(0.08, accentL - 0.07)),
    '--c-accent-soft': accentSoft,
    '--c-accent-2': accent2,
    '--c-on-accent': onColor(accent, text),
    '--c-grid-line': hsl(h, 0.4 * tint, 0.925),
    '--c-grid-header': hsl(h, 0.55 * tint, 0.975),
    '--c-grid-selected': rgba(accent, 0.1),
    '--bg-dream': [
      'radial-gradient(60vw 50vh at 0% 0%, ' + rgba(cs[0], 0.24) + ', transparent 70%)',
      'radial-gradient(55vw 50vh at 100% 0%, ' + rgba(cs[3], 0.28) + ', transparent 70%)',
      'radial-gradient(60vw 55vh at 100% 100%, ' + rgba(cs[4], 0.26) + ', transparent 70%)',
      'radial-gradient(55vw 50vh at 0% 100%, ' + rgba(cs[2], 0.34) + ', transparent 70%)',
      'linear-gradient(180deg, ' + hsl(hslOf(cs[1])[0], 0.8 * tint, 0.985) + ' 0%, var(--c-bg) 100%)',
    ].join(', '),
    '--shadow-sm': '0 1px 3px ' + rgba(accent2, 0.08),
    '--shadow-md': '0 6px 18px ' + rgba(accent2, 0.12),
    '--shadow-lg': '0 16px 40px ' + rgba(accent2, 0.18),
    '--focus-ring': '0 0 0 3px ' + rgba(accent, 0.2),
  };

  const dbg = hsl(h, 0.22 * tint + 0.04, 0.115);
  // 暗色下强调色要够亮：对浅强调底也 ≥ 4.8（对背景就更高），深色按钮文字也读得清
  const dSoft = hsl(h, 0.3 * tint + 0.05, 0.21);
  const dAccent = readable(h, Math.max(0.5, s0 * 0.85), Math.max(main.hsl[2], 0.6), dSoft, 1, 4.8);
  const dAccent2 = readable(h2, Math.max(0.45, s2 * 0.8), Math.max(second.hsl[2], 0.65), dbg, 1, 5.5);
  const dim = (/** @type {string} */ c) => { const [a, b, l] = hslOf(c); return hsl(a, b * 0.7, Math.min(0.72, l * 0.82)); };
  const dark = {
    '--c-pastel-pink': dim(cs[0]), '--c-pastel-yellow': dim(cs[1]), '--c-pastel-mint': dim(cs[2]), '--c-pastel-blue': dim(cs[3]), '--c-pastel-mauve': dim(cs[4]),
    '--c-bg': dbg,
    '--c-bg-subtle': hsl(h, 0.2 * tint + 0.04, 0.14),
    '--c-bg-sunken': hsl(h, 0.2 * tint + 0.04, 0.095),
    '--c-surface': hsl(h, 0.18 * tint + 0.04, 0.16),
    '--c-border': hsl(h, 0.15 * tint + 0.04, 0.23),
    '--c-border-strong': hsl(h, 0.13 * tint + 0.04, 0.31),
    '--c-text': hsl(h, 0.35 * tint, 0.94),
    '--c-text-muted': hsl(h, 0.2 * tint, 0.77),
    '--c-text-faint': hsl(h, 0.1 * tint, 0.57),
    '--c-accent': dAccent,
    '--c-accent-hover': hsl(h, Math.max(0.5, s), Math.min(0.92, hslOf(dAccent)[2] + 0.08)),
    '--c-accent-soft': dSoft,
    '--c-accent-2': dAccent2,
    '--c-on-accent': onColor(dAccent, hsl(h, 0.4, 0.12)),
    '--c-grid-line': hsl(h, 0.13 * tint + 0.04, 0.2),
    '--c-grid-header': hsl(h, 0.2 * tint + 0.04, 0.14),
    '--c-grid-selected': rgba(dAccent, 0.16),
    '--bg-dream': [
      'radial-gradient(60vw 50vh at 0% 0%, ' + rgba(cs[0], 0.1) + ', transparent 70%)',
      'radial-gradient(55vw 50vh at 100% 0%, ' + rgba(cs[3], 0.08) + ', transparent 70%)',
      'radial-gradient(60vw 55vh at 100% 100%, ' + rgba(cs[4], 0.1) + ', transparent 70%)',
      'radial-gradient(55vw 50vh at 0% 100%, ' + rgba(cs[2], 0.07) + ', transparent 70%)',
      'var(--c-bg)',
    ].join(', '),
    '--shadow-sm': '0 1px 2px rgba(0, 0, 0, 0.4)',
    '--shadow-md': '0 6px 18px rgba(0, 0, 0, 0.45)',
    '--shadow-lg': '0 16px 40px rgba(0, 0, 0, 0.55)',
    '--focus-ring': '0 0 0 3px ' + rgba(dAccent, 0.28),
  };
  return { light, dark };
}
