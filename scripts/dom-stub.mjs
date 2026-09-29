/**
 * 够跑起 Grid 的最小 DOM 替身。
 *
 * 不是要重造浏览器 —— 只是让网格的装配、命中测试、键盘、剪贴板、渲染调用序列
 * 能在 `node` 里跑一遍。真实浏览器里的像素效果仍然要靠肉眼，但"点这里选中的是不是
 * 那一格""粘贴有没有落错位置""10 万行时一帧画了多少个格子"这些，机器判得比人准。
 */

class ClassList {
  constructor(el) { this.el = el; }
  _list() { return this.el.className.split(/\s+/).filter(Boolean); }
  add(...c) { this.el.className = [...new Set([...this._list(), ...c])].join(' '); }
  remove(...c) { this.el.className = this._list().filter((x) => !c.includes(x)).join(' '); }
  toggle(c, force) { const on = force ?? !this.contains(c); if (on) this.add(c); else this.remove(c); return on; }
  contains(c) { return this._list().includes(c); }
}

class Stub {
  constructor(tag) {
    this.tagName = tag.toUpperCase();
    this.className = '';
    this.children = [];
    this.style = new Proxy({}, { get: (t, k) => t[k] ?? (k === 'setProperty' ? (n, v) => { t[n] = v; } : ''), set: (t, k, v) => { t[k] = v; return true; } });
    this.textContent = '';
    this.hidden = false;
    this.value = '';
    this.scrollTop = 0;
    this.scrollLeft = 0;
    this.scrollHeight = 22;
    this.tabIndex = -1;
    this.dataset = {};
    this.classList = new ClassList(this);
    this.parent = null;
    this._attrs = new Map();
    this._on = new Map();
    this._rect = { left: 0, top: 0, width: 900, height: 600 };
    if (tag === 'canvas') { this.width = 0; this.height = 0; this._ctx = new Ctx2D(); }
  }

  append(...kids) {
    for (const k of kids) {
      if (k == null) continue;
      if (typeof k !== 'object') { this.textContent += String(k); continue; }
      this.children.push(k); k.parent = this;
    }
  }
  prepend(...kids) { this.append(...kids); }
  appendChild(k) { this.append(k); return k; }
  insertBefore(k) { this.append(k); return k; }
  removeChild(k) { k.remove(); return k; }
  replaceChildren(...kids) { this.children = []; this.append(...kids); }
  remove() { if (this.parent) this.parent.children = this.parent.children.filter((k) => k !== this); this.parent = null; }
  contains(el) { for (let e = el; e; e = e.parent) if (e === this) return true; return false; }
  closest() { return null; }
  get firstChild() { return this.children[0] ?? null; }
  get parentNode() { return this.parent; }
  get parentElement() { return this.parent; }
  get isConnected() { return true; }
  get offsetWidth() { return this._rect.width; }
  get offsetHeight() { return this._rect.height; }
  get clientWidth() { return this._rect.width; }
  get clientHeight() { return this._rect.height; }
  getContext() { return this._ctx; }
  getBoundingClientRect() { return { ...this._rect, x: this._rect.left, y: this._rect.top, right: this._rect.left + this._rect.width, bottom: this._rect.top + this._rect.height }; }
  setAttribute(k, v) { this._attrs.set(k, String(v)); }
  getAttribute(k) { return this._attrs.get(k) ?? null; }
  removeAttribute(k) { this._attrs.delete(k); }
  hasAttribute(k) { return this._attrs.has(k); }
  focus() { globalThis.document.activeElement = this; }
  blur() { }
  click() { this.fire('click'); }
  scrollIntoView() { }
  select() { }
  setSelectionRange() { }
  setPointerCapture() { }
  releasePointerCapture() { }
  querySelector() { return null; }
  querySelectorAll() { return []; }

  addEventListener(type, fn) {
    if (!this._on.has(type)) this._on.set(type, new Set());
    this._on.get(type).add(fn);
  }
  removeEventListener(type, fn) { this._on.get(type)?.delete(fn); }

  /** 测试用：触发一个事件，返回事件对象（方便断言 preventDefault 有没有被调用）。 */
  fire(type, init = {}) {
    const ev = {
      type, defaultPrevented: false, preventDefault() { ev.defaultPrevented = true; },
      stopPropagation() { }, button: 0, pointerId: 1, clientX: 0, clientY: 0,
      shiftKey: false, ctrlKey: false, metaKey: false, altKey: false, key: '',
      target: this,
      ...init,
    };
    for (const fn of this._on.get(type) ?? []) fn(ev);
    return ev;
  }
}

/** 记录调用次数的 2D 上下文 —— 计数本身就是断言依据（一帧画了多少格）。 */
class Ctx2D {
  constructor() { this.calls = { fillText: 0, fillRect: 0, stroke: 0, clip: 0 }; }
  setTransform() { }
  save() { }
  restore() { }
  beginPath() { }
  closePath() { }
  rect() { }
  clip() { this.calls.clip++; }
  moveTo() { }
  lineTo() { }
  arc() { }
  ellipse() { }
  quadraticCurveTo() { }
  bezierCurveTo() { }
  fill() { }
  stroke() { this.calls.stroke++; }
  strokeRect() { }
  clearRect() { }
  fillRect() { this.calls.fillRect++; }
  fillText() { this.calls.fillText++; }
  strokeText() { }
  setLineDash() { }
  translate() { }
  rotate() { }
  scale() { }
  measureText(s) { return { width: String(s).length * 7 }; }
  createLinearGradient() { return { addColorStop() { } }; }
  resetCalls() { for (const k of Object.keys(this.calls)) this.calls[k] = 0; }
}

/** 待执行的帧回调。rAF 必须是异步的 —— 同步执行会让 renderer 的合帧守卫
 *  （先跑回调、再把返回的 id 赋给 _raf）永远停在"有帧在排队"的状态，
 *  之后所有 schedule() 都变成空操作，测出来的滚动成本会假到离谱。 */
const frames = [];
let frameId = 0;

/** 把排队的帧全部画掉。测试里每"一帧"调一次。 */
export function flushFrames() {
  const n = frames.length;
  const todo = frames.splice(0, frames.length);
  for (const fn of todo) fn(performance.now());
  return n;
}

export function installDom() {
  const doc = {
    createElement: (tag) => new Stub(tag),
    createElementNS: (_ns, tag) => new Stub(tag),
    createTextNode: (t) => { const n = new Stub('#text'); n.textContent = String(t); return n; },
    createDocumentFragment: () => new Stub('#fragment'),
    documentElement: new Stub('html'),
    body: new Stub('body'),
    activeElement: null,
    getElementById: () => null,
    querySelector: () => null,
    addEventListener() { },
    removeEventListener() { },
  };
  globalThis.document = doc;
  globalThis.getComputedStyle = () => ({ getPropertyValue: () => '' });
  globalThis.requestAnimationFrame = (fn) => { frames.push(fn); return ++frameId; };
  globalThis.cancelAnimationFrame = () => { };
  globalThis.ResizeObserver = class { observe() { } disconnect() { } };
  globalThis.window = {
    devicePixelRatio: 2,
    innerWidth: 1280,
    innerHeight: 800,
    matchMedia: () => ({ matches: false, addEventListener() { }, removeEventListener() { } }),
    addEventListener() { },
    removeEventListener() { },
  };
  globalThis.alert = (m) => { globalThis.__lastAlert = m; };
  globalThis.confirm = () => true;
  return { Stub };
}

/** 假的 DataTransfer，用来驱动 copy / paste 事件。 */
export function clipboardData(initial = {}) {
  const store = { ...initial };
  return {
    store,
    getData: (t) => store[t] ?? '',
    setData: (t, v) => { store[t] = v; },
  };
}

export { Stub, Ctx2D };
