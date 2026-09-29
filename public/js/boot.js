/**
 * 页面入口：先按本机缓存加载界面语言的词典，再加载页面自己的代码（<script data-app="main"> → ./main.js）。
 *
 * 必须用动态 import 串起来：静态 import 的兄弟模块不会等另一个模块的顶层 await，
 * 那样有些模块会在词典到位之前就把中文定死在界面上。
 */

import { loadLang } from './core/lang.js';

await loadLang();
const app = document.querySelector('script[data-app]')?.getAttribute('data-app') ?? '';
if (/^[a-z]+$/.test(app)) await import(`./${app}.js`);
