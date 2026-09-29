/** 极简 toast。全部走 textContent，绝不拼 HTML。 */

const host = /** @type {HTMLElement} */ (document.getElementById('toasts'));

/**
 * @param {string} message
 * @param {'info' | 'success' | 'error'} [kind]
 * @param {number} [ms]
 */
export function toast(message, kind = 'info', ms = 3200) {
  const el = document.createElement('div');
  el.className = 'toast' + (kind === 'info' ? '' : ' toast--' + kind);
  el.textContent = message;
  host.append(el);
  setTimeout(() => el.remove(), ms);
}
