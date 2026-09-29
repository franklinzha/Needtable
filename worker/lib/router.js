/**
 * 极简路由。支持 /api/tables/:id/fields 这样的具名参数。
 * 不引第三方框架，因为整个后端只有二三十条路由，而每个依赖都要 vendor 进仓库。
 */

/**
 * @typedef {{ params: Record<string,string>, url: URL, env: any, ctx: ExecutionContext,
 *             identity: { email: string, sub: string, name?: string },
 *             user: { id: string, email: string, name: string|null, role: string } }} RequestContext
 */

export class Router {
  /** @type {{ method: string, segs: string[], handler: Function }[]} */
  #routes = [];

  /** @param {string} method @param {string} path @param {Function} handler */
  add(method, path, handler) {
    this.#routes.push({ method, segs: path.split('/').filter(Boolean), handler });
    return this;
  }

  /** @param {string} p @param {Function} h */ get(p, h)    { return this.add('GET', p, h); }
  /** @param {string} p @param {Function} h */ post(p, h)   { return this.add('POST', p, h); }
  /** @param {string} p @param {Function} h */ patch(p, h)  { return this.add('PATCH', p, h); }
  /** @param {string} p @param {Function} h */ put(p, h)    { return this.add('PUT', p, h); }
  /** @param {string} p @param {Function} h */ delete(p, h) { return this.add('DELETE', p, h); }

  /**
   * @param {string} method @param {string} pathname
   * @returns {{ handler: Function, params: Record<string,string> } | { allow: string[] } | null}
   */
  match(method, pathname) {
    const parts = pathname.split('/').filter(Boolean);
    /** @type {Set<string>} */
    const pathMatched = new Set();

    for (const route of this.#routes) {
      if (route.segs.length !== parts.length) continue;
      /** @type {Record<string,string>} */
      const params = {};
      let hit = true;
      for (let i = 0; i < parts.length; i++) {
        const seg = route.segs[i];
        if (seg.startsWith(':')) params[seg.slice(1)] = decodeURIComponent(parts[i]);
        else if (seg !== parts[i]) { hit = false; break; }
      }
      if (!hit) continue;
      pathMatched.add(route.method);
      if (route.method === method) return { handler: route.handler, params };
    }
    // 路径存在但方法不对 → 405 而不是 404，便于排查
    if (pathMatched.size > 0) return { allow: [...pathMatched] };
    return null;
  }
}
