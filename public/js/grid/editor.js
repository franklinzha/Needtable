/**
 * 单元格编辑器：浮在 Canvas 之上的一个真实 DOM 输入框。
 *
 * 只在编辑时存在一个节点，所以不违背"不给 10 万行挂 DOM"的前提；
 * 而用真 <textarea> 换来的是输入法（中文、日文）、拼写、辅助技术全部原生可用 ——
 * 在 Canvas 里自绘光标永远做不到这些。
 */

export class CellEditor {
  /**
   * @param {HTMLElement} layer 覆盖层容器（pointer-events:none）
   * @param {{
   *   onCommit:(v:string, move:'down'|'right'|'up'|'left'|'none')=>void,
   *   onCancel:()=>void,
   *   onKey?:(e:KeyboardEvent)=>boolean,
   *   onInput?:(v:string)=>void,
   *   keepOnBlur?:(e:FocusEvent)=>boolean,
   * }} handlers  onKey 返回 true 表示已处理（公式自动完成用）；keepOnBlur 返回 true 时失焦不提交（焦点去了公式栏）
   */
  constructor(layer, handlers) {
    this.layer = layer;
    this.handlers = handlers;
    this.open = false;

    const ta = document.createElement('textarea');
    ta.className = 'grid__editor';
    ta.rows = 1;
    ta.spellcheck = false;
    ta.autocapitalize = 'off';
    ta.hidden = true;
    ta.addEventListener('keydown', (e) => this._key(e));
    ta.addEventListener('blur', (e) => {
      if (!this.open || this.handlers.keepOnBlur?.(e)) return;
      this.commit('none');
    });
    ta.addEventListener('input', () => { this._autoGrow(); this.handlers.onInput?.(ta.value); });
    layer.append(ta);
    this.el = ta;
  }

  /**
   * @param {{x:number,y:number,w:number,h:number}} rect 屏幕坐标
   * @param {string} value
   * @param {boolean} selectAll true = 双击/F2 进入（保留原值），false = 直接打字覆盖
   */
  show(rect, value, selectAll, focus = true) {
    this.open = true;
    this.el.hidden = false;
    this.el.value = value;
    this.place(rect);
    if (focus) this.el.focus({ preventScroll: true });
    if (selectAll) this.el.select();
    else this.el.setSelectionRange(this.el.value.length, this.el.value.length);
    this._autoGrow();
  }

  /** 滚动或调宽后重新定位。 @param {{x:number,y:number,w:number,h:number}} rect */
  place(rect) {
    const s = this.el.style;
    s.maxWidth = Math.max(rect.w + 1, 480) + 'px';
    s.left = (rect.x - 1) + 'px';
    s.top = (rect.y - 1) + 'px';
    s.minWidth = (rect.w + 1) + 'px';
    s.minHeight = (rect.h + 1) + 'px';
    this._rect = rect;
  }

  /** 内容超出一行时向下长，不挡住右边的列。 */
  _autoGrow() {
    if (!this._rect) return;
    this.el.style.height = 'auto';
    this.el.style.height = Math.max(this._rect.h + 1, this.el.scrollHeight) + 'px';
  }

  /** @param {'down'|'right'|'up'|'left'|'none'} move */
  commit(move) {
    if (!this.open) return;
    const v = this.el.value;
    this.hide();
    this.handlers.onCommit(v, move);
  }

  cancel() {
    if (!this.open) return;
    this.hide();
    this.handlers.onCancel();
  }

  hide() {
    this.open = false;
    this.el.hidden = true;
    this.el.value = '';
    this.el.style.height = 'auto';
  }

  /** @param {KeyboardEvent} e */
  _key(e) {
    if (this.handlers.onKey?.(e)) return;
    if (e.key === 'Escape') { e.preventDefault(); this.cancel(); return; }
    if (e.key === 'Enter') {
      if (e.altKey || e.metaKey) {                     // Alt+Enter = 单元格内换行
        // 不能指望浏览器默认行为：Windows 上 Alt+Enter 是系统键，textarea 里并不会插入换行
        e.preventDefault();
        this.el.setRangeText('\n', this.el.selectionStart, this.el.selectionEnd, 'end');
        this.el.dispatchEvent(new Event('input'));
        return;
      }
      e.preventDefault();
      this.commit(e.shiftKey ? 'up' : 'down');
      return;
    }
    if (e.key === 'Tab') {
      e.preventDefault();
      this.commit(e.shiftKey ? 'left' : 'right');
      return;
    }
    e.stopPropagation();                                // 其余按键别冒泡到网格的快捷键
  }
}
