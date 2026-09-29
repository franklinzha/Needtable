/*
 * 主题配色的「首屏」部分：普通脚本（不是 module），放在 <head> 里同步执行，
 * 在样式表画出第一帧之前把上次选的配色贴到 <html> 上，免得先闪一下默认的马卡龙色。
 *
 * 缓存在 localStorage['nt-theme'] = { id, light:{--c-*:…}, dark:{…} }，由 js/core/theme.js 写入。
 * 没有缓存 = 默认配色，tokens.css 里的值直接生效。
 * 登录页、帮助页的样式表自成一套变量名（--bg / --fg …），这里顺带映射过去。
 */
(function () {
  var KEY = 'nt-theme';
  var ALIAS = {
    '--bg': '--c-bg', '--card': '--c-surface', '--surface': '--c-surface',
    '--fg': '--c-text', '--text': '--c-text', '--muted': '--c-text-muted',
    '--line': '--c-border', '--border': '--c-border',
    '--accent': '--c-accent', '--accent-hover': '--c-accent-hover', '--accent-soft': '--c-accent-soft',
    '--accent-fg': '--c-on-accent', '--on-accent': '--c-on-accent', '--dream': '--bg-dream',
  };
  var mq = window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null;
  var applied = [];
  var current = read();

  function read() {
    try { return JSON.parse(localStorage.getItem(KEY) || 'null'); } catch (e) { return null; }
  }

  // t 省略 = 沿用当前的（系统切换深浅色时）；null = 回到默认配色
  function apply(t) {
    if (t !== undefined) current = t;
    var style = document.documentElement.style;
    for (var i = 0; i < applied.length; i++) style.removeProperty(applied[i]);
    applied = [];
    var vars = current && (mq && mq.matches ? current.dark : current.light);
    if (!vars) return;
    var set = function (k, v) { style.setProperty(k, v); applied.push(k); };
    for (var k in vars) if (Object.prototype.hasOwnProperty.call(vars, k)) set(k, vars[k]);
    for (var a in ALIAS) if (vars[ALIAS[a]]) set(a, vars[ALIAS[a]]);
  }

  apply();
  if (mq) {
    var onChange = function () { apply(); window.dispatchEvent(new Event('themechange')); };
    if (mq.addEventListener) mq.addEventListener('change', onChange); else mq.addListener(onChange);
  }
  // js/core/theme.js 换配色时调用
  window.__ntApplyTheme = apply;
})();
