/**
 * 界面文字的多语言。源文本就是中文：代码里写 t('保存')，中文字符串本身当键，
 * 查不到译文就原样显示中文 —— 漏翻的地方顶多是中文，不会出现空白或键名。
 *
 * 词典在同目录的 en.js / ja.js / ko.js / es.js / fr.js，每个 export default { 中文: 译文 }。
 * 由页面入口 js/boot.js 在任何界面代码执行之前加载好（setDict），所以模块顶层调 t() 也安全。
 * worker 也会 import 用到 t() 的共享模块：那边从不 setDict，t() 恒返回中文。
 *
 * 占位符：t('已选 {n} 行', { n: 3 })。译文里同名占位符原样替换，顺序可以不同。
 */

/** 可选语言。id 同时是词典文件名；tag 用于 <html lang> 和数字 / 日期格式。 */
export const LANGS = [
  { id: 'zh', tag: 'zh-CN', name: '中文' },
  { id: 'en', tag: 'en', name: 'English' },
  { id: 'ja', tag: 'ja', name: '日本語' },
  { id: 'ko', tag: 'ko', name: '한국어' },
  { id: 'es', tag: 'es-MX', name: 'Español' },
  { id: 'fr', tag: 'fr', name: 'Français' },
];
export const DEFAULT_LANG = 'zh';

/** @param {unknown} id */
export const isLang = (id) => typeof id === 'string' && LANGS.some((l) => l.id === id);

let lang = DEFAULT_LANG;
/** @type {Record<string, string> | null} */
let dict = null;
/** @type {{ re: RegExp, names: string[], key: string }[] | null} */
let patterns = null;

/** 当前语言 id */
export const currentLang = () => lang;
/** 当前语言的 BCP 47 标签 */
export const langTag = () => LANGS.find((l) => l.id === lang)?.tag ?? 'zh-CN';

/** @param {string} id @param {Record<string, string> | null} d */
export function setDict(id, d) {
  lang = isLang(id) ? id : DEFAULT_LANG;
  dict = lang === DEFAULT_LANG ? null : d;
  patterns = null;
}

/** @param {string} s @param {Record<string, unknown>} [params] */
function fill(s, params) {
  if (!params) return s;
  return s.replace(/\{(\w+)\}/g, (m, k) => (k in params ? String(params[k]) : m));
}

/**
 * 翻译一段界面文字。
 * @param {string} zh 中文原文（也是词典的键）
 * @param {Record<string, unknown>} [params] 占位符的值
 */
export function t(zh, params) {
  const s = dict && Object.prototype.hasOwnProperty.call(dict, zh) ? dict[zh] : zh;
  return fill(s, params);
}

/**
 * 翻译一条已经拼好的中文消息（服务端的报错、提示）。
 * 先整句查词典；查不到就拿带占位符的词条当模板去匹配，把数字、名字等抠出来填进译文。
 * @param {string} msg
 */
export function tr(msg) {
  if (!dict || typeof msg !== 'string' || !msg) return msg;
  if (Object.prototype.hasOwnProperty.call(dict, msg)) return dict[msg];
  if (!patterns) {
    patterns = [];
    for (const key of Object.keys(dict)) {
      if (!key.includes('{')) continue;
      const names = [];
      const src = key.split(/(\{\w+\})/).map((part) => {
        const m = /^\{(\w+)\}$/.exec(part);
        if (m) { names.push(m[1]); return '(.+?)'; }
        return part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      }).join('');
      patterns.push({ re: new RegExp('^' + src + '$', 's'), names, key });
    }
  }
  for (const p of patterns) {
    const m = p.re.exec(msg);
    if (!m) continue;
    /** @type {Record<string, string>} */ const params = {};
    // 填进去的值本身也是词条（如账号等级「管理员」）就一并翻译
    p.names.forEach((n, i) => { const v = m[i + 1]; params[n] = Object.prototype.hasOwnProperty.call(dict, v) ? dict[v] : v; });
    return fill(dict[p.key], params);
  }
  return msg;
}
