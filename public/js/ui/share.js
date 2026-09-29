/**
 * 通用分享面板：工作区 / 内容 / 表共用一套。
 *
 *   · 能分享的人（对这一级是管理者及以上，且账号等级允许）：按邮箱加人、选角色、
 *     勾选可见视图（表格 / 看板 / 仪表盘），改角色、改视图、移除
 *   · 其他人：看看都有谁、各自从哪一级拿到的权限；自己在这一级上有记录的可以退出
 *
 * 列表里每个人显示「有效权限」（最具体的那一级胜出），被盖住的更宽的一级显示为
 * 「继承自工作区：编辑」。只从更宽一级继承来的人在这里没有控件 —— 要单独给他
 * 不同的权限，在上面按邮箱添加即可，这一级的记录会覆盖继承来的。
 *
 * 管理员碰到还没账号的邮箱，可以直接开户（默认密码）再分享进来。
 */

import { api, ApiError } from '../core/api.js';
import { toast } from './toast.js';
import { h, openPanel, linkBox, errMsg } from './panel.js';
import { confirmDialog } from './dialog.js';
import { t } from '../../shared/i18n/i18n.js';

/** @typedef {'workspace'|'base'|'table'} Level */

const PATH = { workspace: '/api/workspaces/', base: '/api/bases/', table: '/api/tables/' };
const ROLE = { owner: t('所有者'), manager: t('管理者'), editor: t('可编辑'), viewer: t('只读') };
const ROLE_HINT = {
  viewer: t('只能看'),
  editor: t('可以改数据'),
  manager: t('可以改数据，也能继续分享给别人'),
};
const VIEWS = /** @type {const} */ ([['grid', t('表格')], ['kanban', t('看板')], ['dashboard', t('仪表盘')]]);

// 带对象类型的整句按类型分开写（键必须是静态字面量，也不能把名词拼进句子）
/** @typedef {'workspace'|'base'|'table'|'doc'|'slides'} Noun */
const SHARE_TITLE = /** @type {Record<Noun, (name: string) => string>} */ ({
  workspace: (name) => t('分享工作区 · {name}', { name }),
  base: (name) => t('分享内容 · {name}', { name }),
  table: (name) => t('分享表 · {name}', { name }),
  doc: (name) => t('分享文档 · {name}', { name }),
  slides: (name) => t('分享幻灯片 · {name}', { name }),
});
const PUBLIC_HINT = /** @type {Record<Noun, () => string>} */ ({
  workspace: () => t('任何拿到这个链接的人（不用登录）都能查看这张表，但不能修改、复制或导出。防复制只是界面上的限制，挡不住截图。'),
  base: () => t('任何拿到这个链接的人（不用登录）都能查看这张表，但不能修改、复制或导出。防复制只是界面上的限制，挡不住截图。'),
  table: () => t('任何拿到这个链接的人（不用登录）都能查看这张表，但不能修改、复制或导出。防复制只是界面上的限制，挡不住截图。'),
  doc: () => t('任何拿到这个链接的人（不用登录）都能查看这份文档，但不能修改、复制或导出。防复制只是界面上的限制，挡不住截图。'),
  slides: () => t('任何拿到这个链接的人（不用登录）都能查看这份幻灯片，但不能修改、复制或导出。防复制只是界面上的限制，挡不住截图。'),
});
const ONLY_THIS = /** @type {Record<Noun, () => string>} */ ({
  workspace: () => t('加进工作区的人能看到里面全部内容和表。只想分享其中一个内容或一张表，请在那个内容 / 表的「⋯ → 分享」里操作。'),
  base: () => t('只分享这个内容：对方的主页会出现它所在的工作区，但里面只有这一项。'),
  table: () => t('只分享这个表：对方的主页会出现它所在的工作区，但里面只有这一项。'),
  doc: () => t('只分享这个文档：对方的主页会出现它所在的工作区，但里面只有这一项。'),
  slides: () => t('只分享这个幻灯片：对方的主页会出现它所在的工作区，但里面只有这一项。'),
});
const ONLY_MANAGERS = /** @type {Record<Level, () => string>} */ ({
  workspace: () => t('只有这个工作区的管理者和所有者能添加或移除成员。'),
  base: () => t('只有这个内容的管理者和所有者能添加或移除成员。'),
  table: () => t('只有这个表的管理者和所有者能添加或移除成员。'),
});
const VIA = /** @type {Record<Level, () => string>} */ ({
  workspace: () => t('来自工作区'),
  base: () => t('来自内容'),
  table: () => t('来自表'),
});
const INHERITED = /** @type {Record<Level, (role: string) => string>} */ ({
  workspace: (role) => t('继承自工作区：{role}（已被覆盖）', { role }),
  base: (role) => t('继承自内容：{role}（已被覆盖）', { role }),
  table: (role) => t('继承自表：{role}（已被覆盖）', { role }),
});

/** 服务端的 scope（null = 全部；否则逗号分隔）→ 数组 @param {string | null | undefined} s */
const scopeList = (s) => (s ? s.split(',') : VIEWS.map(([k]) => k));
/** @param {string | null | undefined} s */
const scopeText = (s) => (s ? t('仅{views}', { views: scopeList(s).map((k) => VIEWS.find(([v]) => v === k)?.[1] ?? k).join(t('、')) }) : '');

/**
 * @param {Level} level
 * @param {{ id: string, name: string }} obj
 * @param {{ id: string, role: string }} me
 * @param {{ onChanged(): void }} on
 */
export function openSharePanel(level, obj, me, on) {
  // 文档 / 幻灯片也是「表」（同一套 ACL、公开链接），只是没有视图可限制
  const kind = /** @type {any} */ (obj).kind;
  const docLike = level === 'table' && (kind === 'doc' || kind === 'slides');
  /** @type {Noun} */
  const noun = docLike ? kind : level;
  const { body, dismiss } = openPanel(SHARE_TITLE[noun](obj.name), { wide: true });
  const base = PATH[level] + encodeURIComponent(obj.id) + '/members';
  let changed = false;
  const touched = () => { changed = true; };

  /** @param {HTMLElement} [flash] 重建后要继续显示的东西（刚开通的账号信息） */
  const render = async (flash) => {
    try {
      const data = await api.get(base);
      body.replaceChildren();
      if (data.canShare) body.append(addSection(data, flash));
      body.append(listSection(data));
      if (level === 'table') body.append(await publicSection());
      if (changed) { changed = false; on.onChanged(); }
    } catch (e) {
      body.replaceChildren(h('p', 'sec-error', errMsg(e)));
    }
  };

  /**
   * 公开只读链接：拿到链接的人不登录也能看，但不能改、不能复制导出。
   * 只有 admin / pro 能开；表的管理者及以上（或管理员）能关。
   */
  async function publicSection() {
    const sec = h('section', 'sec-section');
    const url = PATH.table + encodeURIComponent(obj.id) + '/public';
    /** @type {any} */ let info;
    try { info = await api.get(url); } catch { return sec; }
    if (!info.link && !info.canCreate) return sec;
    sec.append(h('h3', 'sec-subtitle', t('公开链接（只读）')));
    const act = async (/** @type {() => Promise<any>} */ fn, /** @type {string} */ done) => {
      try { await fn(); toast(done, 'success'); sec.replaceWith(await publicSection()); }
      catch (e) { toast(errMsg(e), 'error'); }
    };
    if (info.link) {
      const box = h('div', 'sec-link');
      const input = /** @type {HTMLInputElement} */ (h('input', 'sec-input sec-input--mono'));
      input.readOnly = true;
      input.value = info.link.url;
      input.addEventListener('focus', () => input.select());
      const copy = /** @type {HTMLButtonElement} */ (h('button', 'sec-btn', t('复制')));
      copy.type = 'button';
      copy.addEventListener('click', async () => {
        try { await navigator.clipboard.writeText(info.link.url); } catch { input.focus(); input.select(); document.execCommand('copy'); }
        copy.textContent = t('已复制');
        setTimeout(() => { copy.textContent = t('复制'); }, 1500);
      });
      const row = h('div', 'sec-row');
      row.append(input, copy);
      if (info.canRevoke) {
        const off = /** @type {HTMLButtonElement} */ (h('button', 'sec-btn sec-btn--ghost', t('关闭公开')));
        off.type = 'button';
        off.addEventListener('click', async () => {
          const ok = await confirmDialog(t('关闭公开链接'), t('关闭后这个链接立即失效，正在查看的人也会看不到新内容。之后再开会生成一个新链接。'), { ok: t('关闭'), danger: true });
          if (ok) void act(() => api.del(url), t('已关闭公开链接'));
        });
        row.append(off);
      }
      box.append(row);
      sec.append(box, h('p', 'sec-muted', PUBLIC_HINT[noun]()));
    } else {
      const on = /** @type {HTMLButtonElement} */ (h('button', 'sec-btn', t('生成公开链接')));
      on.type = 'button';
      on.addEventListener('click', () => void act(() => api.post(url, {}), t('已生成公开链接')));
      sec.append(on, h('p', 'sec-muted', t('生成一个不用登录就能查看的只读链接。只有管理员和 Pro 账号能生成，随时可以关闭。')));
    }
    return sec;
  }

  /** @param {any} data @param {HTMLElement} [flash] */
  function addSection(data, flash) {
    const sec = h('section', 'sec-section');
    sec.append(h('h3', 'sec-subtitle', t('添加成员')));
    const form = h('form', 'sec-row');
    const email = /** @type {HTMLInputElement} */ (h('input', 'sec-input'));
    email.type = 'email'; email.required = true; email.placeholder = t('对方的登录邮箱'); email.autocomplete = 'off';
    const role = roleSelect(data.grantable, 'editor');
    const ok = /** @type {HTMLButtonElement} */ (h('button', 'sec-btn', t('添加')));
    ok.type = 'submit';
    form.append(email, role, ok);
    const views = scopePicker(null);
    views.el.hidden = docLike;
    const hint = h('div');
    sec.append(form, views.el, hint);
    if (flash) sec.append(flash);
    sec.append(h('p', 'sec-muted', ONLY_THIS[noun]()));

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const scope = views.value();
      if (!scope) { toast(t('至少勾选一个可见视图'), 'error'); return; }
      ok.disabled = true;
      hint.replaceChildren();
      try {
        await api.put(base, { email: email.value, role: role.value, scope });
        toast(t('已分享给 {email}', { email: email.value.trim() }), 'success');
        touched();
        await render();
      } catch (err) {
        ok.disabled = false;
        if (err instanceof ApiError && err.status === 404 && me.role === 'admin') {
          hint.append(noAccount(email.value.trim(), role.value, scope));
        } else {
          toast(errMsg(err), 'error', 5000);
        }
      }
    });
    if (!flash) queueMicrotask(() => email.focus());
    return sec;
  }

  /**
   * 管理员专用：邮箱还没账号时，先开户再分享。
   * 开的是 normal 账号（只能用分给他的东西）；要让他自己建表，之后在「用户管理」里升级。
   * @param {string} email @param {string} role @param {string[]} scope
   */
  function noAccount(email, role, scope) {
    const box = h('div', 'sec-callout');
    box.append(h('p', 'sec-warn', t('{email} 还没有账号。', { email })));
    const label = t('为对方开通账号并分享');
    const b = /** @type {HTMLButtonElement} */ (h('button', 'sec-btn', label));
    b.type = 'button';
    b.addEventListener('click', async () => {
      b.disabled = true;
      try {
        const { dkFor, passwordBox } = await import('./users.js');
        const settings = await api.get('/api/admin/settings');
        const usePw = !settings.totpRequired;
        if (usePw) b.textContent = t('正在计算…');
        const res = await api.post('/api/admin/users', {
          email, role: 'normal',
          ...(usePw ? { dk: await dkFor(settings.defaultPassword, email) } : {}),
        });
        await api.put(base, { email: res.user.email, role, scope });
        toast(t('已开通并分享给 {email}', { email: res.user.email }), 'success');
        touched();
        await render(usePw ? passwordBox(res.user.email, settings.defaultPassword) : linkBox(res.link, res.user.email));
      } catch (err) {
        b.disabled = false;
        b.textContent = label;
        toast(errMsg(err), 'error', 5000);
      }
    });
    box.append(b);
    return box;
  }

  /** @param {any} data */
  function listSection(data) {
    const sec = h('section', 'sec-section');
    sec.append(h('h3', 'sec-subtitle', t('可以访问的人（{n}）', { n: data.members.length })));
    const list = h('ul', 'sec-list');
    for (const m of data.members) list.append(memberRow(m, data));
    sec.append(list);
    if (!data.canShare) {
      sec.append(h('p', 'sec-muted', me.role === 'normal'
        ? t('你的账号等级不能分享。需要的话请联系管理员。')
        : ONLY_MANAGERS[level]()));
    }
    return sec;
  }

  /** @param {any} m @param {any} data */
  function memberRow(m, data) {
    const li = h('li', 'sec-item share-item');
    const info = h('div', 'sec-item__main');
    const title = h('div', 'sec-item__title');
    title.append(h('span', '', m.name || m.email));
    if (m.me) title.append(h('span', 'sec-badge', t('我')));
    if (m.status === 'pending') title.append(h('span', 'sec-badge sec-badge--warn', t('待开通')));
    if (m.status === 'disabled') title.append(h('span', 'sec-badge sec-badge--bad', t('已停用')));
    const sub = [m.email];
    if (m.via && m.via !== level) sub.push(VIA[/** @type {Level} */ (m.via)]?.() ?? m.via);
    if (m.inherited) {
      const role = ROLE[/** @type {'viewer'} */ (m.inherited.role)] ?? m.inherited.role;
      sub.push(INHERITED[/** @type {Level} */ (m.inherited.via)]?.(role) ?? role);
    }
    if (m.scope) sub.push(scopeText(m.scope));
    info.append(title, h('div', 'sec-muted sec-item__sub', sub.join(' · ')));

    const actions = h('div', 'sec-item__actions');
    const editable = data.canShare && m.direct && m.role !== 'owner' && !m.me
      && (data.myRole === 'owner' || rank(m.role) < rank(data.myRole));

    if (editable) {
      const grantable = data.grantable.includes(m.role) ? data.grantable : [...data.grantable, m.role];
      const sel = roleSelect(grantable, m.role);
      sel.addEventListener('change', () => run(sel, async () => {
        await api.put(base, { email: m.email, role: sel.value, scope: scopeList(m.scope) });
        toast(t('已改为{role}', { role: ROLE[/** @type {'viewer'} */ (sel.value)] }), 'success');
        touched();
        await render();
      }, () => { sel.value = m.role; }));

      const viewsBtn = /** @type {HTMLButtonElement} */ (h('button', 'sec-btn sec-btn--ghost', t('视图…')));
      viewsBtn.type = 'button';
      viewsBtn.title = t('限制对方能看到的视图');
      viewsBtn.addEventListener('click', () => {
        if (li.querySelector('.share-scope-edit')) return;
        const picker = scopePicker(m.scope);
        const save = /** @type {HTMLButtonElement} */ (h('button', 'sec-btn', t('保存')));
        save.type = 'button';
        save.addEventListener('click', () => {
          const scope = picker.value();
          if (!scope) { toast(t('至少勾选一个可见视图'), 'error'); return; }
          run(save, async () => {
            await api.put(base, { email: m.email, role: m.role, scope });
            toast(t('已更新可见视图'), 'success');
            touched();
            await render();
          });
        });
        const wrap = h('div', 'sec-row share-scope-edit');
        wrap.append(picker.el, save);
        li.append(wrap);
      });

      const rm = /** @type {HTMLButtonElement} */ (h('button', 'sec-btn sec-btn--ghost', t('移除')));
      rm.type = 'button';
      rm.addEventListener('click', async () => {
        const msg = level === 'workspace'
          ? t('把 {email} 移出「{name}」？他在里面的内容级、表级权限也一并收回，打开着的表会立即断开。', { email: m.email, name: obj.name })
          : m.inherited
            ? t('取消 {email} 在「{name}」上的单独授权？之后他按继承来的权限访问。', { email: m.email, name: obj.name })
            : t('取消 {email} 在「{name}」上的单独授权？', { email: m.email, name: obj.name });
        if (!(await confirmDialog(t('移除成员'), msg, { ok: t('移除'), danger: true }))) return;
        run(rm, async () => {
          await api.del(base + '/' + encodeURIComponent(m.id));
          toast(t('已移除'), 'success');
          touched();
          await render();
        });
      });
      if (docLike) actions.append(sel, rm); else actions.append(sel, viewsBtn, rm);
    } else {
      actions.append(h('span', 'sec-muted', ROLE[/** @type {'viewer'} */ (m.role)] ?? m.role ?? ''));
      if (m.me && m.direct && m.role !== 'owner') {
        const leave = /** @type {HTMLButtonElement} */ (h('button', 'sec-btn sec-btn--ghost', t('退出')));
        leave.type = 'button';
        leave.addEventListener('click', async () => {
          const ok = await confirmDialog(t('退出分享'), t('退出「{name}」？之后需要对方重新分享给你才能访问。', { name: obj.name }), { ok: t('退出'), danger: true });
          if (!ok) return;
          run(leave, async () => {
            await api.del(base + '/' + encodeURIComponent(m.id));
            dismiss();
            on.onChanged();
          });
        });
        actions.append(leave);
      }
    }
    li.append(info, actions);
    return li;
  }

  render();
}

/** @param {string} role */
function rank(role) {
  return { viewer: 1, editor: 2, manager: 3, owner: 4 }[/** @type {'viewer'} */ (role)] ?? 0;
}

/** @param {string[]} grantable @param {string} value */
function roleSelect(grantable, value) {
  const sel = /** @type {HTMLSelectElement} */ (h('select', 'sec-select'));
  for (const r of ['viewer', 'editor', 'manager']) {
    if (!grantable.includes(r)) continue;
    const opt = new Option(ROLE[/** @type {'viewer'} */ (r)], r);
    opt.title = ROLE_HINT[/** @type {'viewer'} */ (r)];
    sel.append(opt);
  }
  sel.value = grantable.includes(value) ? value : grantable[0];
  return sel;
}

/**
 * 可见视图勾选框。全选 = 不限制。
 * @param {string | null} scope
 * @returns {{ el: HTMLElement, value(): string[] | null }}
 */
function scopePicker(scope) {
  const on = new Set(scopeList(scope));
  const el = h('div', 'sec-row share-scope');
  el.append(h('span', 'sec-muted', t('可见视图：')));
  /** @type {[string, HTMLInputElement][]} */ const boxes = [];
  for (const [k, label] of VIEWS) {
    const lab = h('label', 'sec-switch');
    const box = /** @type {HTMLInputElement} */ (h('input'));
    box.type = 'checkbox';
    box.checked = on.has(k);
    lab.append(box, h('span', '', label));
    el.append(lab);
    boxes.push([k, box]);
  }
  return {
    el,
    value: () => {
      const v = boxes.filter(([, b]) => b.checked).map(([k]) => k);
      return v.length ? v : null;
    },
  };
}

/**
 * @param {HTMLButtonElement | HTMLSelectElement} ctl
 * @param {() => Promise<void>} fn @param {() => void} [onFail]
 */
async function run(ctl, fn, onFail) {
  ctl.disabled = true;
  try { await fn(); } catch (e) { onFail?.(); toast(errMsg(e), 'error', 5000); }
  ctl.disabled = false;
}
