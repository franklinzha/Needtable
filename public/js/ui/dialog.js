/**
 * 模态对话框。浏览器原生的 alert/confirm/prompt 会冻结整个页面（包括实时同步的消息处理），
 * 所以这里全部自己画。Esc 取消，Enter 触发主按钮（多行文本框里的 Enter 除外）。
 */

import { h } from './dom.js';
import { t } from '../../shared/i18n/i18n.js';

/**
 * @param {{
 *   title: string,
 *   body: Node | Node[],
 *   buttons?: {label:string, primary?:boolean, danger?:boolean, action?:()=>boolean|void|Promise<boolean|void>}[],
 *   width?: number,
 *   onClose?: () => void,
 * }} opts  按钮 action 返回 false 时不关闭（用于校验失败）
 * @returns {{close:()=>void, el:HTMLElement}}
 */
export function openDialog(opts) {
  const prevFocus = document.activeElement;
  const overlay = h('div', { class: 'ui-dialog-overlay' });
  const panel = h('div', { class: 'ui-dialog', attrs: { role: 'dialog', 'aria-modal': 'true', 'aria-label': opts.title } });
  if (opts.width) panel.style.width = 'min(' + opts.width + 'px, calc(100vw - 32px))';
  const closeBtn = h('button', { class: 'ui-dialog__x', type: 'button', attrs: { 'aria-label': t('关闭') }, text: '×' });
  const head = h('div', { class: 'ui-dialog__head' }, h('h2', { class: 'ui-dialog__title', text: opts.title }), closeBtn);
  const body = h('div', { class: 'ui-dialog__body' }, opts.body);
  const foot = h('div', { class: 'ui-dialog__foot' });
  const buttons = opts.buttons ?? [{ label: t('关闭'), primary: true }];
  /** @type {HTMLButtonElement | null} */ let primary = null;
  for (const b of buttons) {
    const btn = h('button', {
      type: 'button',
      class: 'ui-btn' + (b.primary ? ' ui-btn--primary' : '') + (b.danger ? ' ui-btn--danger' : ''),
      text: b.label,
    });
    btn.addEventListener('click', async () => {
      const r = b.action ? await b.action() : undefined;
      if (r !== false) close();
    });
    if (b.primary) primary = btn;
    foot.append(btn);
  }
  panel.append(head, body, foot);
  overlay.append(panel);
  document.body.append(overlay);

  let closed = false;
  function close() {
    if (closed) return;
    closed = true;
    overlay.remove();
    document.removeEventListener('keydown', onKey, true);
    opts.onClose?.();
    if (prevFocus && typeof prevFocus.focus === 'function') prevFocus.focus({ preventScroll: true });
  }
  const onKey = (e) => {
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); return; }
    if (e.key === 'Enter' && primary && !(e.target && e.target.tagName === 'TEXTAREA') && !(e.target && e.target.tagName === 'BUTTON')) {
      e.preventDefault(); e.stopPropagation(); primary.click();
    }
  };
  document.addEventListener('keydown', onKey, true);
  closeBtn.addEventListener('click', close);
  overlay.addEventListener('pointerdown', (e) => { if (e.target === overlay) close(); });

  const first = panel.querySelector?.('input, select, textarea');
  setTimeout(() => { (first || primary)?.focus?.(); if (first && first.select) first.select(); }, 0);
  return { close, el: panel };
}

/**
 * 输入一个值。取消返回 null。
 * @param {string} title @param {string} label @param {string} [value] @param {{multiline?:boolean, placeholder?:string}} [o]
 * @returns {Promise<string | null>}
 */
export function promptDialog(title, label, value = '', o = {}) {
  return new Promise((resolve) => {
    let result = null;
    const input = o.multiline
      ? h('textarea', { class: 'ui-input ui-input--area', value, placeholder: o.placeholder || '' })
      : h('input', { class: 'ui-input', value, placeholder: o.placeholder || '' });
    openDialog({
      title,
      body: [h('label', { class: 'ui-field' }, h('span', { class: 'ui-field__label', text: label }), input)],
      buttons: [
        { label: t('取消') },
        { label: t('确定'), primary: true, action: () => { result = input.value; } },
      ],
      onClose: () => resolve(result),
    });
  });
}

/** @param {string} title @param {string} message @param {{ok?:string, danger?:boolean}} [o] @returns {Promise<boolean>} */
export function confirmDialog(title, message, o = {}) {
  return new Promise((resolve) => {
    let ok = false;
    openDialog({
      title,
      body: [h('p', { class: 'ui-dialog__msg', text: message })],
      buttons: [
        { label: t('取消') },
        { label: o.ok || t('确定'), primary: true, danger: o.danger, action: () => { ok = true; } },
      ],
      onClose: () => resolve(ok),
    });
  });
}

/** 只有一个"知道了"按钮的提示框。 */
export function alertDialog(title, message) {
  return new Promise((resolve) => {
    openDialog({ title, body: [h('p', { class: 'ui-dialog__msg', text: message })], onClose: () => resolve(undefined) });
  });
}
