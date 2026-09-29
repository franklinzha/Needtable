/**
 * 用户管理页 /yonghuguanli 的入口。页面本身只有管理员拿得到（见 worker/index.js），
 * 这里再查一次身份只是为了在会话过期 / 被降级时给出明白的提示。
 *
 * 地址上的 ?ws=<工作区 id> 是从顶栏带过来的当前工作区：新建账号时默认勾选「同时加入」它。
 */

import { api } from './core/api.js';
import { syncLang } from './core/lang.js';
import { mountUsers } from './ui/users.js';
import { h, errMsg } from './ui/panel.js';
import { t } from '../shared/i18n/i18n.js';

const view = /** @type {HTMLElement} */ (document.getElementById('view'));

try {
  const [me, home] = await Promise.all([api.me(), api.get('/api/home')]);
  // 模块顶层不能 return：语言要切换时页面会重新加载，这里什么都不挂
  if (!syncLang(me?.lang)) {
    if (me?.user?.role !== 'admin') throw new Error(t('只有管理员能管理用户'));
    const owned = (home?.workspaces ?? [])
      .filter((/** @type {any} */ w) => w.role === 'owner')
      .map((/** @type {any} */ w) => ({ id: w.id, name: w.name }));
    mountUsers(view, owned, new URL(location.href).searchParams.get('ws'));
  }
} catch (e) {
  view.replaceChildren(h('p', 'sec-error', errMsg(e)));
}
