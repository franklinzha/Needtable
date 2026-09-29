/**
 * 原地改名：把一段文字换成输入框，Enter / 失焦提交，Esc 取消。
 *
 * 侧边栏、主页卡片、表名的「双击改名」都用它。onCommit 自己负责提示错误；
 * 失败后调用方重画界面，名字自然回到服务器上的值。
 */

/**
 * @param {HTMLElement} el 显示名字的元素（textContent 就是当前名字）
 * @param {(name: string) => unknown} onCommit 名字没变或为空时不会调用
 */
export function inlineEdit(el, onCommit) {
  if (el.querySelector('input')) return;
  const old = el.textContent ?? '';
  const input = document.createElement('input');
  input.className = 'inline-edit';
  input.value = old;
  input.maxLength = 100;
  input.spellcheck = false;
  el.replaceChildren(input);
  input.focus();
  input.select();

  let done = false;
  /** @param {boolean} save */
  const finish = (save) => {
    if (done) return;
    done = true;
    const name = input.value.trim();
    el.textContent = save && name ? name : old;
    if (save && name && name !== old) onCommit(name);
  };
  input.addEventListener('keydown', (e) => {
    e.stopPropagation();          // 别让网格 / 菜单的快捷键吃掉按键
    if (e.key === 'Enter') { e.preventDefault(); finish(true); }
    else if (e.key === 'Escape') { e.preventDefault(); finish(false); }
  });
  // 输入框多半嵌在按钮里：点它不该触发按钮
  for (const t of ['click', 'dblclick', 'pointerdown']) input.addEventListener(t, (e) => e.stopPropagation());
  input.addEventListener('blur', () => finish(true));
}
