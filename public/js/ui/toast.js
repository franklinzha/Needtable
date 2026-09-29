/** 极简 toast。全部走 textContent，绝不拼 HTML。 */

/** 提示条的容器。页面没放 #toasts（比如独立的 /yonghuguanli）时自己补一个，不能因为少个 div 就让调用方抛错。 */
function host() {
  let el = document.getElementById('toasts');
  if (!el) {
    el = document.createElement('div');
    el.id = 'toasts';
    el.className = 'toasts';
    el.setAttribute('role', 'status');
    el.setAttribute('aria-live', 'polite');
    document.body.append(el);
  }
  return el;
}

/**
 * @param {string} message
 * @param {'info' | 'success' | 'error'} [kind]
 * @param {number} [ms]
 */
export function toast(message, kind = 'info', ms = 3200) {
  const el = document.createElement('div');
  el.className = 'toast' + (kind === 'info' ? '' : ' toast--' + kind);
  el.textContent = message;
  host().append(el);
  setTimeout(() => el.remove(), ms);
}
