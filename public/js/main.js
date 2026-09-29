/**
 * 前端主入口。
 *
 * 启动顺序：
 *   1. GET /api/me + GET /api/home 并行 —— 前者验证身份（任何一环断了这里都会失败），
 *      后者是这个人能看到的全部工作区 → 内容 → 表
 *   2. 渲染顶栏
 *   3. 按地址栏决定显示什么：
 *        /          主页：工作区卡片，下面列内容和表
 *        /w/<id>    某个工作区：侧边栏 + 空白主区
 *        /t/<id>    某张表：侧边栏 + 网格。表编号也是跨表引用的地址
 *      旧的 #/t/<id> 自动换成 /t/<id>。服务端对这些路径都回落到 index.html。
 *
 * 选中一张表就在 main 区挂一个 Grid，并给它配一个 SyncEngine：
 * Grid 管交互与渲染，SyncEngine 管与 Durable Object 的对齐，两者只通过 model 相遇。
 */

import { api, ApiError, setPublicMode } from './core/api.js';
import { applyTheme, effectiveTheme } from './core/theme.js';
import { syncLang } from './core/lang.js';
import { atLeast, canCreate, canShare } from './core/perm.js';
import { Grid } from './grid/grid.js';
import { SyncEngine } from './core/sync.js';
import { renderTopbar, renderPeers } from './ui/topbar.js';
import { renderSidebar } from './ui/sidebar.js';
import { renderHome } from './ui/home.js';
import { openMenu } from './ui/menu.js';
import { promptDialog, confirmDialog } from './ui/dialog.js';
import { inlineEdit } from './ui/inline-edit.js';
import { toast } from './ui/toast.js';
import { t as tt } from '../shared/i18n/i18n.js';

const el = {
  boot:    /** @type {HTMLElement} */ (document.getElementById('boot')),
  app:     /** @type {HTMLElement} */ (document.getElementById('app')),
  topbar:  /** @type {HTMLElement} */ (document.getElementById('topbar')),
  sidebar: /** @type {HTMLElement} */ (document.getElementById('sidebar')),
  main:    /** @type {HTMLElement} */ (document.getElementById('main')),
};

/**
 * @typedef {'workspace'|'base'|'table'} Level
 * @typedef {{ x: number, y: number }} Point
 */

/** 客户端状态。workspaces 就是 /api/home 的树，侧边栏和主页都从它取。 */
const state = {
  /** @type {any} */ user: null,
  /** @type {any} */ app: { name: 'Needtable', environment: 'production' },
  /** @type {any[]} */ workspaces: [],
  /** @type {any[]} 管理员监控：其余所有人的工作区（只读），普通用户恒为空 */ monitor: [],
  /** @type {'home'|'workspace'|'table'} */ view: 'home',
  /** @type {string | null} */ activeWorkspaceId: null,
  /** @type {string | null} */ activeTableId: null,
  /** @type {any} 主题配色（/api/me 的 theme） */ theme: null,
};

/** @type {any} 当前挂载的网格（或文档 / 幻灯片编辑器，接口同名）。切表时必须先 destroy 掉旧的。 */
let grid = null;
/** @type {SyncEngine | null} 与当前网格配对的同步引擎。 */
let sync = null;
/** @type {string | null} grid 当前对应哪张表，用来避免无谓重建。 */
let mountedTableId = null;
/** 异步挂载（文档 / 幻灯片要先加载编辑器）的令牌：切走后旧的挂载作废。 */
let mountToken = /** @type {object | null} */ (null);

/** 侧边栏与主页共用的操作。 */
const on = {
  /** @param {string} path */
  go: (path) => navigate(path),
  /** @param {Level} level @param {any} obj @param {Point} at */
  menu: (level, obj, at) => openMenu(menuItems(level, obj), at),
  /** 双击改名：有权限才进入编辑。 @param {Level} level @param {any} obj @param {HTMLElement} labelEl */
  rename: (level, obj, labelEl) => {
    if (!canRename(level, obj)) return;
    inlineEdit(labelEl, (name) => void withError(() => rename(level, obj, name)));
  },
  createWorkspace: () => void withError(createWorkspace),
  /** @param {string} wsId */
  createBase: (wsId) => void withError(() => createBase(wsId)),
  /** @param {string} baseId @param {string} [kind] grid · doc · slides */
  createTable: (baseId, kind = 'grid') => void withError(() => createTable(baseId, kind)),
  /** 内容旁的「+」：选新建表、文档还是幻灯片。 @param {string} baseId @param {HTMLElement} anchor */
  createIn: (baseId, anchor) => {
    const r = anchor.getBoundingClientRect();
    openMenu([
      { label: tt('新建表'), icon: '📄', action: () => on.createTable(baseId, 'grid') },
      { label: tt('新建文档'), icon: '📝', action: () => on.createTable(baseId, 'doc') },
      { label: tt('新建幻灯片'), icon: '📽️', action: () => on.createTable(baseId, 'slides') },
    ], { x: r.left, y: r.bottom + 2 });
  },
  /** @param {Level} level @param {any} obj */
  share: (level, obj) => void withError(() => openShare(level, obj)),
};

async function boot() {
  // 旧地址 #/t/<id>：换成真实路径，书签和别人发来的老链接都还能用
  const legacy = location.hash.match(/^#\/t\/([A-Za-z0-9_]+)$/);
  if (legacy) history.replaceState(null, '', '/t/' + legacy[1]);

  // 公开只读链接 /t/<id>?view=<令牌>：不登录、不拉工作区树，只挂一张只读网格
  const pub = location.pathname.match(/^\/t\/([A-Za-z0-9_]+)\/?$/);
  const token = new URLSearchParams(location.search).get('view');
  if (pub && token && /^[A-Za-z0-9_-]{43}$/.test(token)) return bootPublic(pub[1], token);

  try {
    const [me, home] = await Promise.all([api.me(), api.get('/api/home')]);
    state.user = me.user;
    state.app = me.app;
    state.theme = me.theme;
    applyTheme(effectiveTheme(me.theme), me.theme?.custom);
    if (syncLang(me.lang)) return;   // 账号上存的语言和本机不同：换好缓存重新载入
    setHome(home);
  } catch (err) {
    return bootFailed(err);
  }

  el.boot.hidden = true;
  el.app.hidden = false;
  renderTopbar(el.topbar, state, { onHome: () => navigate('/') });

  // 站内链接（<a data-nav>）走 pushState；按住 Ctrl / ⌘ 或中键照常开新标签页
  document.addEventListener('click', (e) => {
    const a = e.target instanceof Element ? e.target.closest('a[data-nav]') : null;
    if (!a || e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    e.preventDefault();
    navigate(/** @type {string} */ (a.getAttribute('href')));
  });
  window.addEventListener('popstate', applyRoute);
  applyRoute();
}

/**
 * 公开只读模式。能看、能切视图、能筛选排序看数据，不能改、不能复制导出。
 * 「不能复制」只是劝阻：截图、开发者工具都挡不住，界面上也照实说。
 * @param {string} tableId @param {string} token
 */
async function bootPublic(tableId, token) {
  setPublicMode();
  /** @type {any} */ let meta;
  try {
    const res = await fetch('/api/public/' + token, { credentials: 'same-origin' });
    if (!res.ok) throw new ApiError(res.status, 'gone', res.status === 404 ? tt('链接已失效：分享者可能已经关闭了公开访问') : tt('载入失败（HTTP {status}）', { status: res.status }));
    meta = (await res.json()).table;
    if (meta.id !== tableId) throw new ApiError(404, 'gone', tt('链接不完整'));
  } catch (err) {
    return bootFailed(err);
  }
  const { usePublicFiles } = await import('./io/attach.js');
  const { PublicSync } = await import('./core/publicsync.js');
  usePublicFiles(token);
  document.documentElement.classList.add('is-public');
  // 复制、剪切、拖拽、右键「复制」、打印：统统不给（劝阻性质）
  for (const ev of ['copy', 'cut', 'dragstart']) {
    document.addEventListener(ev, (e) => {
      const t = e.target instanceof Element ? e.target : null;
      if (t?.closest('input, textarea')) return;
      e.preventDefault();
    }, true);
  }
  document.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && ['p', 's'].includes(e.key.toLowerCase())) e.preventDefault();
  }, true);

  el.boot.hidden = true;
  el.app.hidden = false;
  el.app.classList.add('app--public');
  document.title = tt('{name} · 公开只读', { name: meta.name });
  const brand = document.createElement('a');
  brand.className = 'topbar__brand';
  brand.href = '/login';
  brand.title = tt('登录 Needtable');
  brand.textContent = '📊 Needtable';
  const badge = document.createElement('span');
  badge.className = 'topbar__public';
  badge.textContent = tt('公开只读');
  badge.title = tt('任何拿到链接的人都能查看；不能修改、复制或导出');
  const spacer = document.createElement('div');
  spacer.className = 'topbar__spacer';
  const login = document.createElement('a');
  login.className = 'topbar__logout';
  login.href = '/login?next=' + encodeURIComponent('/t/' + tableId);
  login.textContent = tt('登录');
  el.topbar.replaceChildren(brand, badge, spacer, login);

  const onStatus = (/** @type {string} */ msg, /** @type {string} [kind] */ kind) => toast(msg, kind === 'error' ? 'error' : 'success');
  const g = meta.kind === 'doc' || meta.kind === 'slides'
    ? await mountDocLike(meta.kind, { name: tableTitle(meta), tableId, extPath: '/api/public/' + token + '/ext', publicMode: true, onStatus })
    : new Grid(el.main, { name: tableTitle(meta), tableId, extPath: '/api/public/' + token + '/ext', noCopy: true, onStatus });
  grid = g;
  g.nameEl.title = tt('公开只读链接');
  const engine = new PublicSync(token, tableId, g.model, {
    onState: (s, detail) => { g.setConnState(/** @type {any} */ (s), detail); g.setReadonlyReason(tt('公开链接：只能查看，不能修改或复制')); },
    onNotice: (msg, kind) => toast(msg, kind === 'error' ? 'error' : 'success'),
    onGone: () => {
      g.setReadonlyReason(tt('链接已被分享者关闭'));
      toast(tt('这个公开链接已被关闭'), 'error');
    },
  });
  g.attachSync(/** @type {any} */ (engine));
  void engine.start();
}

/** @param {unknown} err */
function bootFailed(err) {
  const msg = err instanceof ApiError
    ? tt('无法加载（{code}）：{message}', { code: err.code, message: err.message })
    : tt('无法连接服务器，请检查网络后刷新页面。');
  el.boot.classList.add('boot--error');
  const text = el.boot.querySelector('.boot__text');
  if (text) text.textContent = msg;
  console.error(err);
}

// ── 路由 ──────────────────────────────────────────────────────────────────

/** @param {string} path */
function navigate(path) {
  if (location.pathname + location.search !== path) history.pushState(null, '', path);
  applyRoute();
}

/** 地址栏 → state，然后重画。 */
function applyRoute() {
  const path = location.pathname;
  const t = path.match(/^\/t\/([A-Za-z0-9_]+)\/?$/);
  const w = path.match(/^\/w\/([A-Za-z0-9_]+)\/?$/);
  if (t) {
    state.view = 'table';
    state.activeTableId = t[1];
    state.activeWorkspaceId = findTable(t[1])?.ws.id ?? null;
  } else if (w) {
    state.view = 'workspace';
    state.activeTableId = null;
    state.activeWorkspaceId = w[1];
  } else {
    state.view = 'home';
    state.activeTableId = null;
  }
  redraw();
}

/** @param {any} home /api/home 的返回 */
function setHome(home) {
  state.workspaces = home.workspaces;
  state.monitor = home.monitor ?? [];
}

/** @param {string | null} id */
function findWs(id) {
  return state.workspaces.find((w) => w.id === id) ?? state.monitor.find((w) => w.id === id);
}

/** @param {string} id */
function findTable(id) {
  for (const ws of [...state.workspaces, ...state.monitor]) {
    for (const base of ws.bases) {
      const table = base.tables.find((/** @type {any} */ t) => t.id === id);
      if (table) return { ws, base, table };
    }
  }
  return null;
}

/** 重新拉一次树（改名、新建、删除、分享之后），然后按当前地址重画。 */
async function reloadTree() {
  setHome(await api.get('/api/home'));
  applyRoute();
}

function redraw() {
  const home = state.view === 'home';
  el.app.classList.toggle('app--home', home);
  const ws = findWs(state.activeWorkspaceId);
  const hit = state.activeTableId ? findTable(state.activeTableId) : null;
  document.title = (hit ? hit.table.name + ' · ' : !home && ws ? ws.name + ' · ' : '') + state.app.name;

  if (home) {
    teardownGrid();
    el.sidebar.replaceChildren();
    renderHome(el.main, state, on);
    return;
  }
  renderSidebar(el.sidebar, state, on);
  mountMain();
}

// ── 主区 ──────────────────────────────────────────────────────────────────

function teardownGrid() {
  renderPeers(el.topbar, []);
  // 旧网格与旧连接都要显式拆掉：ResizeObserver、matchMedia、WebSocket、重连定时器
  // 都不会因为 DOM 被替换而自己消失。
  sync?.destroy();
  sync = null;
  grid?.destroy();
  grid = null;
  mountedTableId = null;
  mountToken = null;
  el.main.replaceChildren();
}

/** 各种「表」的叫法和默认图标。 */
/**
 * 按类型分开写的整句：名词不拼进句子（别的语言词序不同），键也才能静态扫描。
 * @type {Record<'grid'|'doc'|'slides', { create: () => string, nameLabel: () => string, untitled: () => string, created: () => string, del: () => string, delMenu: () => string, id: (id: string) => string }>}
 */
const KIND_TEXT = {
  grid: {
    create: () => tt('新建表'), nameLabel: () => tt('表名称'), untitled: () => tt('未命名表'), created: () => tt('已创建表'),
    del: () => tt('删除表'), delMenu: () => tt('删除表…'), id: (id) => tt('表编号 {id}', { id }),
  },
  doc: {
    create: () => tt('新建文档'), nameLabel: () => tt('文档名称'), untitled: () => tt('未命名文档'), created: () => tt('已创建文档'),
    del: () => tt('删除文档'), delMenu: () => tt('删除文档…'), id: (id) => tt('文档编号 {id}', { id }),
  },
  slides: {
    create: () => tt('新建幻灯片'), nameLabel: () => tt('幻灯片名称'), untitled: () => tt('未命名幻灯片'), created: () => tt('已创建幻灯片'),
    del: () => tt('删除幻灯片'), delMenu: () => tt('删除幻灯片…'), id: (id) => tt('幻灯片编号 {id}', { id }),
  },
};
const KIND_ICON = { grid: '📄', sheet: '🧮', doc: '📝', slides: '📽️' };
/** @param {string} [kind] */
const kindText = (kind) => KIND_TEXT[kind === 'doc' || kind === 'slides' ? kind : 'grid'];
/** @param {any} t */
const isDocKind = (t) => t.kind === 'doc' || t.kind === 'slides';

/** @param {any} t */
const tableTitle = (t) => (t.icon || /** @type {any} */ (KIND_ICON)[t.kind] || '📄') + ' ' + t.name;

/**
 * 文档 / 幻灯片：按需加载编辑器。模型用一个不画界面的 GridModel，只用它的 props 和订阅。
 * @param {'doc'|'slides'} kind @param {any} opts
 */
async function mountDocLike(kind, opts) {
  const [{ GridModel }, mod] = await Promise.all([
    import('./grid/model.js'),
    kind === 'doc' ? import('./doc/docview.js') : import('./doc/slides.js'),
  ]);
  const View = kind === 'doc' ? /** @type {any} */ (mod).DocView : /** @type {any} */ (mod).SlidesView;
  return new View(el.main, { ...opts, model: new GridModel() });
}

function mountMain() {
  const hit = state.activeTableId ? findTable(state.activeTableId) : null;

  // 侧边栏的任何操作都会走 redraw()。如果当前这张表的网格已经挂着，就别重建 ——
  // 重建会断开 WebSocket、重拉一次全量，纯属浪费。
  if (hit && mountedTableId === hit.table.id && (grid || mountToken)) {
    grid?.setName(tableTitle(hit.table));
    grid?.setScope(hit.table.scope);
    return;
  }
  teardownGrid();

  if (hit && isDocKind(hit.table)) {
    void withError(() => mountDocTable(hit));
    return;
  }

  if (hit) {
    const table = hit.table;
    mountedTableId = table.id;
    const g = new Grid(el.main, {
      name: tableTitle(table),
      tableId: table.id,
      onStatus: (msg, kind) => toast(msg, kind === 'error' ? 'error' : 'success'),
      onPeers: (list) => { if (grid === g) renderPeers(el.topbar, list, (id) => void g.jumpToPeer(id)); },
    });
    grid = g;
    g.setScope(table.scope);
    g.nameEl.title = KIND_TEXT.grid.id(table.id) + (atLeast(table.role, 'editor') ? ' · ' + tt('双击改名') : '');
    g.nameEl.addEventListener('dblclick', () => {
      const cur = findTable(table.id)?.table;
      if (!cur || !canRename('table', cur)) return;
      // 显示的名字前面带着图标：编辑时只放名字
      g.nameEl.textContent = cur.name;
      inlineEdit(g.nameEl, (name) => void withError(() => rename('table', cur, name)));
      // 取消（名字没变）时不会重画，自己把图标补回来
      g.nameEl.querySelector('input')?.addEventListener('blur', () => {
        setTimeout(() => { const now = findTable(table.id)?.table; if (now && grid === g) g.setName(tableTitle(now)); }, 0);
      });
    });

    const engine = new SyncEngine(table.id, g.model, {
      onState: (s, detail) => g.setConnState(s, detail),
      onPresence: (users) => g.setPeers(users),
      // 服务端认定的可见视图：分享被改了、重连之后以这个为准
      onWelcome: (you) => g.setScope(you.scope),
      onCursor: (from, sel, editing) => g.setPeerCursor(from, sel, editing),
      onNotice: (msg, kind) => toast(msg, kind === 'error' ? 'error' : 'success'),
    });
    sync = engine;
    g.attachSync(engine);
    // 不 await：网格要立刻可见可滚动，数据到了再填进去
    void engine.start();
    return;
  }

  const ws = findWs(state.activeWorkspaceId);
  const box = document.createElement('div');
  box.className = 'placeholder';
  const title = document.createElement('div');
  title.className = 'placeholder__title';
  const hint = document.createElement('p');
  hint.className = 'placeholder__hint';
  if (state.view === 'table') {
    title.textContent = tt('打不开');
    hint.textContent = tt('编号 {id} 对应的表 / 文档 / 幻灯片不存在、已被删除，或者没有分享给你。', { id: state.activeTableId });
  } else if (!ws) {
    title.textContent = tt('找不到这个工作区');
    hint.textContent = tt('它可能已被删除，或者没有分享给你。');
  } else {
    title.textContent = (ws.icon || '📊') + ' ' + ws.name;
    const n = ws.bases.reduce((s, /** @type {any} */ b) => s + b.tables.length, 0);
    hint.textContent = n ? tt('从左侧选择一张表、文档或幻灯片。') : tt('这个工作区还没有内容，点左侧内容旁的 + 新建表、文档或幻灯片。');
    if (n) {
      // 窄屏没有侧边栏，「从左侧选择」就成了死路：换成直接列出全部表（宽屏由 CSS 藏起来）
      hint.classList.add('placeholder__hint--wide');
      const list = document.createElement('div');
      list.className = 'placeholder__tables';
      for (const b of ws.bases) {
        for (const t of b.tables) {
          const a = document.createElement('a');
          a.href = '/t/' + t.id;
          a.dataset.nav = '';
          a.className = 'home-chip';
          a.textContent = tableTitle(t);
          list.append(a);
        }
      }
      box.append(title, hint, list);
    }
  }
  const back = document.createElement('a');
  back.href = '/';
  back.dataset.nav = '';
  back.className = 'placeholder__link';
  back.textContent = tt('← 回到主页');
  if (!box.childElementCount) box.append(title, hint);
  box.append(back);
  el.main.append(box);
}

/** 挂一份文档 / 幻灯片。和表格一样走 SyncEngine：同一个 DO、同一套权限和分享。 @param {any} hit */
async function mountDocTable(hit) {
  const table = hit.table;
  mountedTableId = table.id;
  const token = {};
  mountToken = token;
  const g = await mountDocLike(table.kind, {
    name: tableTitle(table),
    tableId: table.id,
    // 同一个内容里的其它表：插入「表格内容」时从这里选
    tables: () => (findTable(table.id)?.base.tables ?? []).filter((/** @type {any} */ t) => t.id !== table.id),
    onShare: () => on.share('table', findTable(table.id)?.table ?? table),
    onStatus: (/** @type {string} */ msg, /** @type {string} [kind] */ kind) => toast(msg, kind === 'error' ? 'error' : 'success'),
  });
  // 加载编辑器的这一小会儿里用户可能已经切走了
  if (mountToken !== token) { g.destroy(); return; }
  grid = g;
  g.nameEl.title = kindText(table.kind).id(table.id) + (atLeast(table.role, 'editor') ? ' · ' + tt('双击改名') : '');
  g.nameEl.addEventListener('dblclick', () => {
    const cur = findTable(table.id)?.table;
    if (!cur || !canRename('table', cur)) return;
    g.nameEl.textContent = cur.name;
    inlineEdit(g.nameEl, (name) => void withError(() => rename('table', cur, name)));
    g.nameEl.querySelector('input')?.addEventListener('blur', () => {
      setTimeout(() => { const now = findTable(table.id)?.table; if (now && grid === g) g.setName(tableTitle(now)); }, 0);
    });
  });
  const engine = new SyncEngine(table.id, g.model, {
    onState: (s, detail) => g.setConnState(s, detail),
    onPresence: (users) => { if (grid === g) renderPeers(el.topbar, users); },
    onNotice: (msg, kind) => toast(msg, kind === 'error' ? 'error' : 'success'),
  });
  sync = engine;
  g.attachSync(engine);
  void engine.start();
}

// ── 操作 ──────────────────────────────────────────────────────────────────

/** @param {Level} level @param {any} obj */
function canRename(level, obj) {
  return level === 'workspace' ? atLeast(obj.role, 'manager') : atLeast(obj.role, 'editor');
}

/**
 * 「⋯」菜单 / 右键菜单。按钮按权限置灰，真正的把关在服务端。
 * @param {Level} level @param {any} obj
 * @returns {import('./ui/menu.js').Item[]}
 */
function menuItems(level, obj) {
  const shareItem = {
    label: canShare(state.user) && atLeast(obj.role, 'manager') ? tt('分享…') : tt('查看成员…'),
    icon: '👥', disabled: !obj.role, action: () => on.share(level, obj),
  };
  const renameItem = {
    label: tt('重命名…'), icon: '✎', disabled: !canRename(level, obj),
    action: () => void withError(async () => {
      const name = (await promptDialog(tt('重命名'), tt('新名称'), obj.name))?.trim();
      if (name && name !== obj.name) await rename(level, obj, name);
    }),
  };
  if (level === 'workspace') {
    return [
      { label: tt('打开'), icon: '→', action: () => navigate('/w/' + obj.id) },
      renameItem,
      shareItem,
      { sep: true },
      { label: tt('新建内容…'), icon: '＋', disabled: !(canCreate(state.user) && atLeast(obj.role, 'editor')), action: () => on.createBase(obj.id) },
    ];
  }
  if (level === 'base') {
    const cannot = !(canCreate(state.user) && atLeast(obj.role, 'editor'));
    return [
      { label: tt('新建表…'), icon: '📄', disabled: cannot, action: () => on.createTable(obj.id, 'grid') },
      { label: tt('新建文档…'), icon: '📝', disabled: cannot, action: () => on.createTable(obj.id, 'doc') },
      { label: tt('新建幻灯片…'), icon: '📽️', disabled: cannot, action: () => on.createTable(obj.id, 'slides') },
      { sep: true },
      renameItem,
      shareItem,
    ];
  }
  const url = location.origin + '/t/' + obj.id;
  return [
    { label: tt('打开'), icon: '→', action: () => navigate('/t/' + obj.id) },
    { label: tt('在新标签页打开'), icon: '↗', action: () => window.open(url, '_blank', 'noopener') },
    renameItem,
    { label: isDocKind(obj) ? tt('复制编号') : tt('复制表编号（跨表引用用）'), icon: '#', action: () => copy(obj.id, tt('已复制编号 {id}', { id: obj.id })) },
    { label: tt('复制链接'), icon: '🔗', action: () => copy(url, tt('已复制链接')) },
    shareItem,
    { sep: true },
    { label: kindText(obj.kind).delMenu(), icon: '🗑', danger: true, disabled: !atLeast(obj.role, 'manager'), action: () => void withError(() => deleteTable(obj)) },
  ];
}

/** @param {string} text @param {string} done */
async function copy(text, done) {
  try { await navigator.clipboard.writeText(text); toast(done, 'success'); }
  catch { void promptDialog(tt('复制'), tt('浏览器不让直接复制，请手动选中：'), text); }
}

/** @param {Level} level @param {any} obj @param {string} name */
async function rename(level, obj, name) {
  const path = { workspace: '/api/workspaces/', base: '/api/bases/', table: '/api/tables/' }[level];
  try {
    await api.patch(path + encodeURIComponent(obj.id), { name });
    toast(tt('已重命名'), 'success');
  } finally {
    // 失败也重画：界面上的名字回到服务器上的值
    await reloadTree();
  }
}

async function createWorkspace() {
  const name = (await promptDialog(tt('新建工作区'), tt('名称'), tt('未命名工作区')))?.trim();
  if (!name) return;
  const res = await api.post('/api/workspaces', { name });
  await reloadTree();
  toast(tt('已创建工作区「{name}」', { name: res.name }), 'success');
}

/** @param {string} wsId */
async function createBase(wsId) {
  const name = (await promptDialog(tt('新建内容'), tt('内容（文件夹）名称'), tt('未命名')))?.trim();
  if (!name) return;
  await api.post('/api/workspaces/' + encodeURIComponent(wsId) + '/bases', { name });
  await reloadTree();
  toast(tt('已创建内容'), 'success');
}

/** @param {string} baseId @param {string} kind grid · doc · slides */
async function createTable(baseId, kind) {
  const kt = kindText(kind);
  const name = (await promptDialog(kt.create(), kt.nameLabel(), kt.untitled()))?.trim();
  if (!name) return;
  const res = await api.post('/api/tables', { baseId, name, kind });
  setHome(await api.get('/api/home'));
  navigate('/t/' + res.id);
  toast(kt.created(), 'success');
}

/** @param {any} t */
async function deleteTable(t) {
  const ok = await confirmDialog(kindText(t.kind).del(),
    isDocKind(t)
      ? tt('确定删除「{name}」？里面的内容和图片会一起删除，且无法恢复。', { name: t.name })
      : tt('确定删除「{name}」？表里的数据、附件，以及其它表里引用它的公式都会失效，且无法恢复。', { name: t.name }),
    { ok: tt('删除'), danger: true });
  if (!ok) return;
  const wsId = findTable(t.id)?.ws.id;
  await api.del('/api/tables/' + encodeURIComponent(t.id));
  setHome(await api.get('/api/home'));
  if (state.activeTableId === t.id) navigate(wsId ? '/w/' + wsId : '/');
  else applyRoute();
  toast(tt('已删除'), 'success');
}

/** @param {Level} level @param {any} obj */
async function openShare(level, obj) {
  const { openSharePanel } = await import('./ui/share.js');
  openSharePanel(level, obj, state.user, {
    // 分享关系变了（包括自己退出）：重新拉树。当前表没了就回主页
    onChanged: () => void withError(async () => {
      setHome(await api.get('/api/home'));
      if (state.activeTableId && !findTable(state.activeTableId)) navigate('/');
      else applyRoute();
    }),
  });
}

/** @param {() => Promise<void>} fn */
async function withError(fn) {
  try { await fn(); }
  catch (err) {
    toast(err instanceof ApiError ? err.message : tt('操作失败'), 'error');
    console.error(err);
  }
}

boot();
