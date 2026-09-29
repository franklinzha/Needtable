/**
 * 仪表盘布局：纯函数，不碰 DOM。
 *
 * props.dashboard.layout = { order: [id…], hidden: [id…], wide: [id…], sizes?: { id: {w?, h?} } }
 * sizes 是拖右下角改出来的大小：w 占几列（网格列数，占满用 wide 表示），h 高度（像素）。
 * id 形如 'c:<图表 id>' / 'p:<透视表 id>'。保存的顺序里找不到的（已删掉的）丢弃，
 * 新出现的追加在末尾 —— 所以插入新图表 / 透视表后仪表盘会自动带上它。
 */

/**
 * @param {string[]} ids 当前实际存在的项，按默认顺序（先图表后透视表）
 * @param {any} layout
 * @returns {{id:string, hidden:boolean, wide:boolean, size?:{w?:number, h?:number}}[]}
 */
export function arrange(ids, layout) {
  const have = new Set(ids);
  const saved = Array.isArray(layout?.order) ? layout.order.filter((id) => have.has(id)) : [];
  const seen = new Set(saved);
  const order = [...saved, ...ids.filter((id) => !seen.has(id))];
  const hidden = new Set(Array.isArray(layout?.hidden) ? layout.hidden : []);
  const wide = new Set(Array.isArray(layout?.wide) ? layout.wide : []);
  const sizes = layout?.sizes && typeof layout.sizes === 'object' ? layout.sizes : {};
  return order.map((id) => {
    /** @type {{id:string, hidden:boolean, wide:boolean, size?:{w?:number, h?:number}}} */
    const it = { id, hidden: hidden.has(id), wide: wide.has(id) };
    const sz = cleanSize(sizes[id]);
    if (sz) it.size = sz;
    return it;
  });
}

/** 高度范围（像素）和列跨度上限。 */
export const MIN_H = 180, MAX_H = 1200, MAX_SPAN = 6;

/** @param {any} s @returns {{w?:number, h?:number} | null} */
function cleanSize(s) {
  if (!s || typeof s !== 'object') return null;
  /** @type {{w?:number, h?:number}} */ const out = {};
  if (Number.isInteger(s.w) && s.w >= 1 && s.w <= MAX_SPAN) out.w = s.w;
  if (Number.isFinite(s.h)) out.h = Math.round(Math.max(MIN_H, Math.min(MAX_H, s.h)));
  return out.w || out.h ? out : null;
}

/**
 * 把 from 挪到 to 的前面（after=true 则后面）。返回新顺序；没动返回 null。
 * @param {string[]} order @param {string} from @param {string} to @param {boolean} [after]
 */
export function moveItem(order, from, to, after = false) {
  if (from === to || !order.includes(from) || !order.includes(to)) return null;
  const rest = order.filter((id) => id !== from);
  const i = rest.indexOf(to) + (after ? 1 : 0);
  rest.splice(i, 0, from);
  return rest.every((id, k) => id === order[k]) ? null : rest;
}

/**
 * 切换某一项在某个集合里的成员身份（hidden / wide），顺带把当前顺序固化下来，
 * 并清掉已不存在的 id。
 * @param {{id:string, hidden:boolean, wide:boolean}[]} items arrange 的结果
 * @param {'hidden'|'wide'|null} key @param {string} [id] @param {string[]} [order] 新顺序（拖动时给）
 */
export function nextLayout(items, key, id, order) {
  const hidden = items.filter((x) => x.hidden).map((x) => x.id);
  const wide = items.filter((x) => x.wide).map((x) => x.id);
  const flip = (list) => (list.includes(id) ? list.filter((x) => x !== id) : [...list, id]);
  /** @type {any} */ const out = {
    order: order ?? items.map((x) => x.id),
    hidden: key === 'hidden' ? flip(hidden) : hidden,
    wide: key === 'wide' ? flip(wide) : wide,
  };
  /** @type {Record<string, any>} */ const sizes = {};
  for (const x of items) {
    if (!x.size) continue;
    // 切换半宽 / 整行时，拖出来的宽度作废（高度保留）
    const sz = key === 'wide' && x.id === id ? { h: x.size.h } : x.size;
    const c = cleanSize(sz);
    if (c) sizes[x.id] = c;
  }
  if (Object.keys(sizes).length) out.sizes = sizes;
  return out;
}

/**
 * 拖右下角改大小之后的布局。span 为占的网格列数（>= 总列数 → 整行），h 为高度像素。
 * @param {{id:string, hidden:boolean, wide:boolean, size?:any}[]} items @param {string} id
 * @param {{span:number, cols:number, h:number}} sz
 */
export function resizeLayout(items, id, sz) {
  const full = sz.span >= sz.cols;
  const next = items.map((x) => {
    if (x.id !== id) return x;
    /** @type {any} */ const size = { h: sz.h };
    // 窄屏只有一列时宽度无从调整，保留原来的设置
    if (sz.cols <= 1) { if (x.size?.w) size.w = x.size.w; return { ...x, size }; }
    if (!full && sz.span >= 1) size.w = Math.min(MAX_SPAN, Math.round(sz.span));
    return { ...x, wide: full, size };
  });
  return nextLayout(next, null);
}
