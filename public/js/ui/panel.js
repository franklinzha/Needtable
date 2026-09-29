/**
 * 弹出面板的外壳：遮罩 + 标题栏 + 可滚动的正文。安全设置、用户管理、成员共用。
 * Esc、点遮罩、点 × 都能关。
 */

import { t } from '../../shared/i18n/i18n.js';

/** @param {string} tag @param {string} [cls] @param {string} [text] */
export function h(tag, cls, text) {
  const el = document.createElement(tag);
  if (cls) el.className = cls;
  if (text !== undefined) el.textContent = text;
  return el;
}

/**
 * @param {string} title
 * @param {{ wide?: boolean, onClose?: () => void }} [opts]
 * @returns {{ body: HTMLElement, dismiss: () => void }}
 */
export function openPanel(title, opts = {}) {
  const overlay = h('div', 'sec-overlay');
  const panel = h('div', 'sec-panel' + (opts.wide ? ' sec-panel--wide' : ''));
  panel.setAttribute('role', 'dialog');
  panel.setAttribute('aria-modal', 'true');
  panel.setAttribute('aria-label', title);

  const head = h('div', 'sec-head');
  const close = h('button', 'sec-close', '×');
  close.setAttribute('aria-label', t('关闭'));
  head.append(h('h2', 'sec-title', title), close);

  const body = h('div', 'sec-body');
  body.append(h('p', 'sec-muted', t('加载中…')));
  panel.append(head, body);
  overlay.append(panel);
  document.body.append(overlay);

  const dismiss = () => {
    overlay.remove();
    document.removeEventListener('keydown', onKey);
    opts.onClose?.();
  };
  const onKey = (/** @type {KeyboardEvent} */ e) => { if (e.key === 'Escape') dismiss(); };
  document.addEventListener('keydown', onKey);
  close.addEventListener('click', dismiss);
  overlay.addEventListener('mousedown', (e) => { if (e.target === overlay) dismiss(); });
  return { body, dismiss };
}

/**
 * 开通 / 重置链接的展示块：只读输入框 + 复制按钮 + 一句用法说明。
 * @param {string} link @param {string} [who]
 */
export function linkBox(link, who) {
  const box = h('div', 'sec-link');
  const input = /** @type {HTMLInputElement} */ (h('input', 'sec-input sec-input--mono'));
  input.readOnly = true;
  input.value = link;
  input.addEventListener('focus', () => input.select());
  const copy = /** @type {HTMLButtonElement} */ (h('button', 'sec-btn', t('复制')));
  copy.type = 'button';
  copy.addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(link); }
    catch {
      // 剪贴板 API 要求安全上下文和焦点；拿不到就退回老办法
      input.focus(); input.select();
      document.execCommand('copy');
    }
    copy.textContent = t('已复制');
    setTimeout(() => { copy.textContent = t('复制'); }, 1500);
  });
  const row = h('div', 'sec-row');
  row.append(input, copy);
  box.append(row, h('p', 'sec-muted',
    who ? t('把这个链接发给 {who}：7 天内有效、只能用一次，打开后由对方自己设置密码。这个链接只显示这一次。', { who })
        : t('把这个链接发给对方：7 天内有效、只能用一次，打开后由对方自己设置密码。这个链接只显示这一次。')));
  return box;
}

/** @param {unknown} e */
export const errMsg = (e) => (e instanceof Error ? e.message : t('操作失败'));
