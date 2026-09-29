/**
 * 函数详细说明的 DOM：参数表 + 示例 + 「在帮助页打开」。
 * 编辑时提示条展开的「?」和插入函数对话框共用；/help 页面自己渲染（不依赖应用内模块）。
 */

import { h } from '../ui/dom.js';
import { t as tt } from '../../shared/i18n/i18n.js';
import { DOCS, helpUrl } from '../../shared/formula/docs.js';

/**
 * @param {string} name
 * @param {number} [arg] 光标所在的参数序号（从 0 开始），高亮对应那一行；变长参数停在最后一行
 */
export function fnDetail(name, arg = -1) {
  const d = DOCS[name];
  if (!d) return null;
  const cur = arg < 0 || !d.params.length ? -1 : Math.min(arg, d.params.length - 1);
  return h('div', { class: 'fn-detail' },
    d.params.length ? h('dl', { class: 'fn-detail__params' },
      d.params.map(([p, t], i) => [
        h('dt', { class: i === cur ? 'is-current' : null, text: p }),
        h('dd', { class: i === cur ? 'is-current' : null, text: t }),
      ])) : null,
    h('div', { class: 'fn-detail__ex' },
      h('span', { class: 'fn-detail__label', text: tt('示例') }),
      h('code', { text: d.example }),
      d.result !== '' ? h('span', { class: 'fn-detail__res', text: '→ ' + d.result }) : null),
    h('a', { class: 'fn-detail__link', href: helpUrl(name), target: '_blank', rel: 'noopener', text: tt('在帮助页打开 ↗') }));
}
