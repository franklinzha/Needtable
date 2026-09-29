/**
 * 极简 DOM 构造器。全部走属性与 textContent，绝不拼 HTML（CSP 也不允许内联样式属性，
 * 所以 style 只接受对象，经 CSSOM 写入）。
 *
 *   h('button', { class: 'btn', onclick: fn, title: '加粗' }, '𝐁')
 */

/**
 * @param {string} tag
 * @param {Record<string, any> | null} [props]
 * @param {...any} kids 字符串、节点、数组、null/false（跳过）
 * @returns {any}
 */
export function h(tag, props, ...kids) {
  const el = document.createElement(tag);
  if (props) {
    for (const [k, v] of Object.entries(props)) {
      if (v == null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k === 'text') el.textContent = v;
      else if (k === 'style') Object.assign(el.style, v);
      else if (k === 'dataset') Object.assign(el.dataset, v);
      else if (k === 'attrs') for (const [a, av] of Object.entries(v)) { if (av != null && av !== false) el.setAttribute(a, String(av)); }
      else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
      else if (k in el) el[k] = v;
      else el.setAttribute(k, String(v));
    }
  }
  append(el, kids);
  return el;
}

function append(el, kids) {
  for (const k of kids) {
    if (k == null || k === false) continue;
    if (Array.isArray(k)) append(el, k);
    else el.append(typeof k === 'string' || typeof k === 'number' ? String(k) : k);
  }
}

/** 下拉框。 @param {[string, string][]} options [value, label] @param {string} [value] */
export function select(options, value, props = {}) {
  const el = h('select', { class: 'ui-input', ...props });
  for (const [v, label] of options) el.append(h('option', { value: v, text: label }));
  if (value != null) el.value = value;
  return el;
}

/** 带标签的一行表单。 */
export function field(label, control, hint) {
  return h('label', { class: 'ui-field' }, h('span', { class: 'ui-field__label', text: label }), control, hint ? h('span', { class: 'ui-field__hint', text: hint }) : null);
}

/** 颜色输入（原生 color picker）。 */
export function colorInput(value, props = {}) {
  return h('input', { type: 'color', class: 'ui-color', value: value || '#000000', ...props });
}

/** 把元素定位到屏幕上某点附近，并保证不出视口。 */
export function placeNear(el, x, y) {
  el.style.left = '0px';
  el.style.top = '0px';
  const r = el.getBoundingClientRect();
  const W = window.innerWidth, H = window.innerHeight;
  const left = Math.max(4, Math.min(x, W - r.width - 4));
  const top = y + r.height > H - 4 ? Math.max(4, y - r.height) : y;
  el.style.left = left + 'px';
  el.style.top = top + 'px';
}

/**
 * 标题栏里的名字去掉前面的图标（main.js 的 tableTitle 是「图标 + 空格 + 名字」），导出文件名、导出标题用。
 * @param {string | null | undefined} s
 */
export const plainTitle = (s) => (s ?? '').trim().replace(/^[^\p{L}\p{N}\s]+\s+/u, '').trim();
