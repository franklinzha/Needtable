/**
 * 界面语言：和主题配色一样，每个人存自己的偏好（users.lang），本机再缓存一份。
 *
 * 启动时 js/boot.js 先调 loadLang()：按本机缓存加载词典，再去跑页面代码，首屏就是对的语言。
 * /api/me 回来后 syncLang() 比对服务端的偏好：换了设备 / 在别处改过，就更新缓存重新载入一次。
 * 换语言 = 存偏好 + 整页重新载入：界面文字大多在创建时就定下了，逐个刷新不划算。
 */

import { LANGS, DEFAULT_LANG, isLang, setDict, t, langTag } from '../../shared/i18n/i18n.js';

const KEY = 'nt-lang';

/** 本机缓存的语言 */
export function cachedLang() {
  try {
    const v = localStorage.getItem(KEY);
    return isLang(v) ? /** @type {string} */ (v) : DEFAULT_LANG;
  } catch { return DEFAULT_LANG; }
}

/** @param {string} id */
function cache(id) {
  try {
    if (id === DEFAULT_LANG) localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, id);
  } catch { /* 隐私模式：只是下次打开先显示中文 */ }
}

/** @param {string} id */
async function loadDict(id) {
  if (id === DEFAULT_LANG) return null;
  try { return (await import(`../../shared/i18n/${id}.js`)).default; }
  catch (err) { console.warn('词典加载失败', id, err); return null; }
}

/** 按本机缓存加载词典，并翻译 HTML 里写死的文字。页面代码执行前调用。 */
export async function loadLang() {
  const id = cachedLang();
  const d = await loadDict(id);
  setDict(d ? id : DEFAULT_LANG, d);
  translateDom(document);
}

/**
 * 翻译 HTML 里标了 data-i18n 的元素：
 *   data-i18n            整段文字（textContent）
 *   data-i18n-html       含标签的一段（词典里连标签一起写，内容是我们自己的，不是用户输入）
 *   data-i18n-attr="placeholder title"   这些属性
 * @param {ParentNode} root
 */
export function translateDom(root) {
  document.documentElement.lang = langTag();
  if (root === document) document.title = t(document.title);
  for (const el of root.querySelectorAll('[data-i18n]')) el.textContent = t((el.textContent ?? '').trim());
  for (const el of root.querySelectorAll('[data-i18n-html]')) el.innerHTML = t(el.innerHTML.trim());
  for (const el of root.querySelectorAll('[data-i18n-attr]')) {
    for (const a of (el.getAttribute('data-i18n-attr') ?? '').split(/\s+/)) {
      const v = a && el.getAttribute(a);
      if (v) el.setAttribute(a, t(v));
    }
  }
}

/**
 * /api/me 回来后调用。服务端存的偏好和本机不同就更新缓存、重新载入，返回 true（调用方别再往下渲染）。
 * 服务端没存过（null）就沿用本机的选择。
 * @param {string | null | undefined} serverLang
 */
export function syncLang(serverLang) {
  if (!isLang(serverLang) || serverLang === cachedLang()) return false;
  cache(/** @type {string} */ (serverLang));
  location.reload();
  return true;
}

/**
 * 换语言：存到自己的账号上（没登录的页面只存本机），然后重新载入。
 * @param {string} id @param {{ remote?: boolean }} [opts]
 */
export async function chooseLang(id, { remote = true } = {}) {
  if (!isLang(id)) return;
  if (remote) {
    const res = await fetch('/api/me/lang', {
      method: 'PUT', credentials: 'same-origin',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ lang: id }),
    });
    if (!res.ok) throw new Error(t('保存语言偏好失败'));
  }
  cache(id);
  location.reload();
}

/**
 * 语言选择框（顶栏、登录页、帮助页共用）。
 * @param {{ remote?: boolean, className?: string }} [opts]
 */
export function langSelect({ remote = true, className = 'lang-select' } = {}) {
  const sel = document.createElement('select');
  sel.className = className;
  sel.title = t('界面语言');
  sel.setAttribute('aria-label', t('界面语言'));
  const cur = cachedLang();
  for (const l of LANGS) {
    const o = document.createElement('option');
    o.value = l.id;
    o.textContent = l.name;
    o.selected = l.id === cur;
    sel.append(o);
  }
  sel.addEventListener('change', async () => {
    sel.disabled = true;
    try { await chooseLang(sel.value, { remote }); }
    catch (err) {
      sel.disabled = false; sel.value = cur;
      const msg = /** @type {Error} */ (err).message;
      import('../ui/toast.js').then((m) => m.toast(msg, 'error'), () => console.warn(msg));
    }
  });
  return sel;
}
