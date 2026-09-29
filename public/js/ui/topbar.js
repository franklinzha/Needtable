import { openSecurityPanel } from './security.js';
import { langSelect } from '../core/lang.js';
import { t } from '../../shared/i18n/i18n.js';

/**
 * 顶栏：品牌 + 当前用户 + 用户管理（管理员）+ 安全设置 + 退出。身份来自 /api/me。
 *
 * 退出按钮只在自建口令登录（via === 'password'）时出现。Access 模式下的会话
 * 是 Cloudflare 那边的，站内清自己的 Cookie 没有任何意义 —— 与其放一个点了
 * 不起作用的按钮，不如不放。
 */

/**
 * @param {HTMLElement} root
 * @param {{ user: { email: string, name: string|null, role: string, via: string },
 *           app: { name: string, environment: string },
 *           workspaces: { id: string, name: string, role: string }[], activeWorkspaceId: string | null }} state
 * @param {{ onHome(): void }} on
 */
export function renderTopbar(root, state, on) {
  root.replaceChildren();

  // 品牌名就是回主页的入口（窄屏没有侧边栏，只能靠它）
  const brand = document.createElement('a');
  brand.className = 'topbar__brand';
  brand.href = '/';
  brand.title = t('回到主页');
  brand.addEventListener('click', (e) => {
    if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey) return;
    e.preventDefault();
    on.onHome();
  });
  brand.append(span('📊'), span(state.app.name));

  const spacer = document.createElement('div');
  spacer.className = 'topbar__spacer';

  // 同一张表里在线的人，由 renderPeers 填
  const peers = document.createElement('div');
  peers.className = 'topbar__peers';

  root.append(brand, spacer, peers);

  // 本地开发用的是 DEV_BYPASS，必须在界面上显眼地标出来，
  // 否则很容易把"本地没登录也能进"误判成线上也一样。
  if (state.user.via === 'dev-bypass' || state.app.environment !== 'production') {
    const badge = document.createElement('span');
    badge.className = 'topbar__env';
    badge.textContent = state.user.via === 'dev-bypass' ? 'DEV BYPASS' : state.app.environment;
    root.append(badge);
  }

  const who = document.createElement('div');
  who.className = 'topbar__user';
  const avatar = document.createElement('span');
  avatar.className = 'avatar';
  avatar.textContent = (state.user.name || state.user.email).trim().charAt(0).toUpperCase();
  avatar.title = state.user.email;
  const email = span(state.user.email);
  email.className = 'topbar__email';
  who.append(avatar, email);
  if (state.user.role === 'admin') {
    const tag = document.createElement('span');
    tag.className = 'topbar__env';
    tag.style.background = 'var(--c-success)';
    tag.textContent = 'ADMIN';
    who.append(tag);
  }
  // 帮助中心快捷入口：新标签页打开 /help（服务端要求登录，这里能看到按钮就已经登录了）
  const help = document.createElement('a');
  help.className = 'topbar__logout topbar__help';
  help.href = '/help';
  help.target = '_blank';
  help.rel = 'noopener';
  help.textContent = t('帮助中心');
  help.title = t('打开帮助中心（使用说明与全部函数）');
  who.append(help);
  // 主题配色：每个人都能选；管理员在同一个面板里设系统默认、加配色
  const theme = document.createElement('button');
  theme.type = 'button';
  theme.className = 'topbar__logout';
  theme.textContent = t('主题配色');
  theme.addEventListener('click', async () => {
    const { openThemePanel } = await import('./themes.js');
    openThemePanel(state);
  });
  who.append(theme);
  if (state.user.role === 'admin') {
    // 独立页面（新标签页打开，不打断手上的表格）；带上当前工作区，新建账号时默认「同时加入」它
    const users = document.createElement('a');
    users.className = 'topbar__logout';
    users.textContent = t('用户管理');
    users.target = '_blank';
    users.rel = 'noopener';
    const sync = () => { users.href = '/yonghuguanli' + (state.activeWorkspaceId ? '?ws=' + encodeURIComponent(state.activeWorkspaceId) : ''); };
    sync();
    users.addEventListener('mousedown', sync);   // 切过工作区之后，点的那一刻再取一次
    users.addEventListener('focus', sync);
    who.append(users);
  }
  if (state.user.via === 'password') {
    // 动态码开关与绑定验证器都在这里；Access 模式下登录方式归 Cloudflare 管，不显示。
    const sec = document.createElement('button');
    sec.type = 'button';
    sec.className = 'topbar__logout';
    sec.textContent = state.user.role === 'admin' ? t('安全设置') : t('验证器');
    sec.addEventListener('click', () => openSecurityPanel(state.user));
    who.append(sec, logoutButton());
  }
  // 界面语言：存在自己的账号上，和主题配色一样换设备也跟着走
  who.append(langSelect({ className: 'topbar__lang' }));
  root.append(who);
}

const ROLE_LABEL = /** @type {Record<string, string>} */ ({ owner: t('所有者'), manager: t('管理者'), editor: t('编辑'), viewer: t('查看') });
const MAX_SHOWN = 6;

/**
 * 右上角的在线头像：谁和你在同一张表里。颜色与画布上那个人的选区框同色；
 * 悬停显示「姓名 · 编辑 · 正在看 C12」，点一下跳到他的选区。不在表里时传空数组清掉。
 * @param {HTMLElement} root 顶栏
 * @param {{id:string, name:string, email:string, role:string, hue:number, me:boolean, where:string|null, editing:boolean}[]} list
 * @param {(id: string) => void} [onJump]
 */
export function renderPeers(root, list, onJump) {
  const box = root.querySelector('.topbar__peers');
  if (!box) return;
  // 只有自己一个人时不显示：顶栏右边本来就有自己的头像
  if (list.length <= 1) { box.replaceChildren(); return; }
  const shown = list.slice(0, MAX_SHOWN);
  const nodes = shown.map((u) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'avatar topbar__peer' + (u.me ? ' topbar__peer--me' : '') + (u.editing ? ' topbar__peer--editing' : '');
    b.style.background = 'hsl(' + u.hue + ' 72% 48%)';
    b.textContent = (u.name || u.email || '?').trim().charAt(0).toUpperCase();
    const doing = u.where ? (u.editing ? t('正在编辑 {where}', { where: u.where }) : t('正在看 {where}', { where: u.where })) : t('刚进来');
    b.title = [(u.me ? t('{name}（你）', { name: u.name }) : u.name), ROLE_LABEL[u.role] ?? u.role, doing].join(' · ') + (u.email ? '\n' + u.email : '');
    b.setAttribute('aria-label', b.title);
    if (u.me || !onJump) b.disabled = true;
    else b.addEventListener('click', () => onJump(u.id));
    return b;
  });
  if (list.length > MAX_SHOWN) {
    const more = document.createElement('span');
    more.className = 'avatar topbar__peer topbar__peer--more';
    more.textContent = '+' + (list.length - MAX_SHOWN);
    more.title = list.slice(MAX_SHOWN).map((u) => u.name).join('、');
    nodes.push(more);
  }
  box.replaceChildren(...nodes);
}

/** 退出：清 Cookie 然后整页跳登录页（不是 SPA 内部路由 —— 要让浏览器重新取一次首页）。 */
function logoutButton() {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'topbar__logout';
  btn.textContent = t('退出');
  btn.addEventListener('click', async () => {
    btn.disabled = true;
    try {
      await fetch('/api/auth/logout', { method: 'POST', credentials: 'same-origin' });
    } catch { /* 网络不通也要跳走：本地这张 Cookie 留着没用 */ }
    location.replace('/login');
  });
  return btn;
}

/** @param {string} text */
function span(text) {
  const el = document.createElement('span');
  el.textContent = text;
  return el;
}
