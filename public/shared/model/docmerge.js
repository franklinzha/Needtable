/**
 * 文档 / 幻灯片的三方合并（按 id）。
 *
 * 文档内容整份存在一个 prop 里（LWW），两个人同时改不同段落时，后到的会整份覆盖先到的。
 * 客户端在「本地有未保存改动、又收到别人的新版本」时用它合并：
 *
 *   base   我上次同步到的版本
 *   mine   我本地当前的版本
 *   theirs 刚收到的远端版本
 *
 * 规则（逐项按 id）：
 *   · 我删了 → 删；我没动 → 用他们的（含他们删掉）；我改了 → 用我的（即便他们删了）
 *   · 顺序以他们的为准，我新增的项插在它在我这边的前一项后面
 *   · 两边都改了同一项时可以交给 onBoth 细分合并（幻灯片用它合并页内元素）
 */

/** @param {any} a @param {any} b */
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/**
 * @template {{id: string}} T
 * @param {T[]} base @param {T[]} mine @param {T[]} theirs
 * @param {(b: T, m: T, t: T) => T} [onBoth]
 * @returns {T[]}
 */
export function mergeById(base, mine, theirs, onBoth) {
  const B = new Map(base.map((x) => [x.id, x]));
  const M = new Map(mine.map((x) => [x.id, x]));
  const T = new Map(theirs.map((x) => [x.id, x]));
  /** @type {T[]} */
  const out = [];
  const placed = new Set();

  for (const t of theirs) {
    const b = B.get(t.id), m = M.get(t.id);
    if (b && !m) continue;                                // 我删了
    let v = t;
    if (m && b && !same(m, b)) v = !same(t, b) && onBoth ? onBoth(b, m, t) : m;   // 我改了
    else if (m && !b) v = m;                              // 两边碰巧同 id 新增：以我为准
    out.push(v);
    placed.add(t.id);
  }
  // 他们删了但我改过的 → 保留；我新增的 → 插回去
  for (let i = 0; i < mine.length; i++) {
    const m = mine[i];
    if (placed.has(m.id)) continue;
    const b = B.get(m.id);
    if (b && !T.has(m.id) && same(m, b)) continue;        // 他们删了，我没动
    let at = 0;
    for (let j = i - 1; j >= 0; j--) {
      const k = out.findIndex((x) => x.id === mine[j].id);
      if (k >= 0) { at = k + 1; break; }
    }
    out.splice(at, 0, m);
    placed.add(m.id);
  }
  return out;
}

/** 幻灯片：页按 id 合并，同一页两边都改了就再按元素合并。 @param {any} base @param {any} mine @param {any} theirs */
export function mergeSlides(base, mine, theirs) {
  const b = base?.slides ?? [], m = mine?.slides ?? [], t = theirs?.slides ?? [];
  const slides = mergeById(b, m, t, (sb, sm, st) => {
    const pick = (/** @type {string} */ k) => (same(sm[k], sb[k]) ? st[k] : sm[k]);
    return { ...st, bg: pick('bg'), els: mergeById(sb.els ?? [], sm.els ?? [], st.els ?? []) };
  });
  const ratio = same(mine?.ratio, base?.ratio) ? theirs?.ratio : mine?.ratio;
  return withTheme({ ...(theirs ?? {}), ratio, slides }, base, mine, theirs);
}

/** 文档：块按 id 合并。 @param {any} base @param {any} mine @param {any} theirs */
export function mergeDoc(base, mine, theirs) {
  return withTheme({ ...(theirs ?? {}), blocks: mergeById(base?.blocks ?? [], mine?.blocks ?? [], theirs?.blocks ?? []) }, base, mine, theirs);
}

/** 主题、页面大小：我改过就用我的，否则用远端的。 @param {any} out @param {any} base @param {any} mine @param {any} theirs */
function withTheme(out, base, mine, theirs) {
  for (const k of ['theme', 'size']) {
    const t = same(mine?.[k], base?.[k]) ? theirs?.[k] : mine?.[k];
    if (t === undefined) delete out[k]; else out[k] = t;
  }
  return out;
}
