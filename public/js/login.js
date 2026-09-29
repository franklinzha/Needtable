/**
 * 登录页。整站唯一在未登录状态下会运行的脚本。
 *
 * 它负责三件事：
 *   · 登录     —— 邮箱 + 密码（管理员开了动态码的话再加 6 位码），一次交齐
 *                 （不做「先验密码再问动态码」，那等于送给攻击者一个
 *                 「这个邮箱存不存在」的探测接口）
 *   · 开通账号 —— 管理员签发的一次性链接 /enroll/<token>，在这里设置密码
 *                 （开了动态码的话先绑定验证器），然后直接进站
 *   · 改初始密码 —— 管理员用默认密码开户 / 重置的账号，登录后先到这一步；
 *                 主站拿到 mustChange 也会把人送回 /login?change=1
 *
 * 密码**不会**离开这台机器：提交的是 600k 次 PBKDF2 之后的派生密钥 dk，
 * 理由与代价见 shared/util/kdf.js 开头那段。
 *
 * 令牌放在 URL 路径里（/enroll/<token>）：旧版用片段（# 后面），但片段在聊天 / 邮件软件
 * 里转发时常被截掉，用户拿到的链接不完整。代价是路径会进访问日志 —— 可以接受：
 * 令牌一次性、库里只存哈希、7 天过期。
 */

import { setDict, t, tr } from '/shared/i18n/i18n.js';
import { cachedLang, translateDom, langSelect } from '/js/core/lang.js';
import LOGIN_DICTS from '/js/login-i18n.js';
import { deriveLoginKey, checkPasswordStrength, normalizeEmail } from '/shared/util/kdf.js';
import { bytesToB64url } from '/shared/util/b64.js';
import { drawQr } from '/shared/util/qr.js';

setDict(cachedLang(), LOGIN_DICTS[cachedLang()] ?? null);
translateDom(document);
document.body.append(langSelect({ remote: false, className: 'lang-select' }));

const $ = (/** @type {string} */ id) => /** @type {any} */ (document.getElementById(id));

const els = {
  appName: $('app-name'),
  login: $('view-login'),
  enroll: $('view-enroll'),
  change: $('view-change'),
  msg: $('view-msg'),
  msgText: $('msg-text'),
  error: $('error'),
  busy: $('busy'),
  busyText: $('busy-text'),
};

/** 当前开通链接里的令牌。只存在于内存和 URL 片段里。 */
let inviteToken = '';

/** 登录要不要动态码。全站开关，由 /api/auth/config 告诉我们，默认不要。 */
let loginNeedsCode = false;
/** 这次开通要不要绑验证器。由 enroll/begin 的响应决定。 */
let enrollNeedsCode = false;

/** 强制改密：账号邮箱，和刚登录时算过的旧 dk（有它就不必再输一遍当前密码） */
let changeEmail = '';
let changeOldDk = '';

// ── 小工具 ──────────────────────────────────────────────────────────────

/** @param {string} text */
function showError(text) {
  els.error.textContent = text;
  els.error.hidden = false;
}
function clearError() { els.error.hidden = true; }

/** @param {string | null} text null 表示结束 */
function setBusy(text) {
  if (text === null) { els.busy.hidden = true; return; }
  els.busyText.textContent = text;
  els.busy.hidden = false;
}

/** @param {'login' | 'enroll' | 'change' | 'msg'} which */
function showView(which) {
  els.login.hidden = which !== 'login';
  els.enroll.hidden = which !== 'enroll';
  els.change.hidden = which !== 'change';
  els.msg.hidden = which !== 'msg';
}

/** @param {string} text */
function showMessage(text) {
  els.msgText.textContent = text;
  showView('msg');
}

/**
 * 登录成功后要跳去哪。只接受本站的绝对路径 ——
 * 不校验的话 ?next=//evil.com 就是一个开放重定向。
 */
function safeNext() {
  const n = new URLSearchParams(location.search).get('next');
  if (!n || n[0] !== '/' || n[1] === '/' || n[1] === '\\') return '/';
  return n;
}

/**
 * @param {string} path @param {unknown} body
 * @returns {Promise<any>}
 */
async function post(path, body) {
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    credentials: 'same-origin',
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let data = null;
  if (text) { try { data = JSON.parse(text); } catch { /* 非 JSON，保持 null */ } }
  if (!res.ok) {
    const err = new Error(data?.error?.message ?? t('请求失败（HTTP {status}）', { status: res.status }));
    /** @type {any} */ (err).status = res.status;
    throw err;
  }
  return data;
}

/** 六位动态码：允许用户带着空格粘贴进来。 @param {string} v */
const cleanCode = (v) => String(v).replace(/[\s-]/g, '');

// ── 登录 ────────────────────────────────────────────────────────────────

async function doLogin() {
  clearError();
  const email = normalizeEmail($('login-email').value);
  const password = $('login-password').value;
  const code = loginNeedsCode ? cleanCode($('login-code').value) : '';

  if (!email || !password) { showError(t('请把邮箱和密码填完整')); return; }
  if (loginNeedsCode && !/^\d{6}$/.test(code)) { showError(t('动态码是 6 位数字')); return; }

  const btn = $('login-submit');
  btn.disabled = true;
  setBusy(t('正在本地计算密钥…'));
  try {
    const dk = await deriveLoginKey(password, email);
    setBusy(t('正在登录…'));
    const res = await post('/api/auth/login', loginNeedsCode
      ? { email, dk: bytesToB64url(dk), code }
      : { email, dk: bytesToB64url(dk) });
    if (res?.user?.mustChange) {
      setBusy(null);
      btn.disabled = false;
      showChange(email, bytesToB64url(dk));
      return;
    }
    // 会话 Cookie 已经在响应头里了，整页跳转过去（不是 SPA 内部路由 ——
    // 这一跳要让浏览器带着新 Cookie 重新取 index.html）。
    location.replace(safeNext());
  } catch (e) {
    setBusy(null);
    btn.disabled = false;
    showError(tr(/** @type {Error} */ (e).message));
    if (loginNeedsCode) {
      $('login-code').value = '';
      $('login-code').focus();
    } else {
      $('login-password').select();
    }
  }
}

// ── 改初始密码 ──────────────────────────────────────────────────────────

/** @param {string} email @param {string} oldDk 空串表示不知道，要用户再输一遍当前密码 */
function showChange(email, oldDk) {
  changeEmail = email;
  changeOldDk = oldDk;
  $('change-email').textContent = email;
  $('change-old-field').hidden = !!oldDk;
  showView('change');
  (oldDk ? $('change-password') : $('change-old')).focus();
}

async function doChange() {
  clearError();
  const email = changeEmail;
  const old = $('change-old').value;
  const pw = $('change-password').value;
  const pw2 = $('change-password2').value;

  if (!changeOldDk && !old) { showError(t('请输入当前密码')); return; }
  const weak = checkPasswordStrength(pw, email);
  if (weak) { showError(weak); return; }
  if (pw !== pw2) { showError(t('两次输入的密码不一致')); return; }
  if (!changeOldDk && pw === old) { showError(t('新密码不能和当前密码相同')); return; }

  const btn = $('change-submit');
  btn.disabled = true;
  setBusy(t('正在本地计算密钥…'));
  try {
    const oldDk = changeOldDk || bytesToB64url(await deriveLoginKey(old, email));
    const newDk = bytesToB64url(await deriveLoginKey(pw, email));
    if (newDk === oldDk) throw new Error(t('新密码不能和当前密码相同'));
    setBusy(t('正在保存…'));
    await post('/api/me/password', { oldDk, newDk });
    location.replace(safeNext());
  } catch (e) {
    setBusy(null);
    btn.disabled = false;
    // 会话过期（比如在别处被重置了）：回到登录
    if (/** @type {any} */ (e).status === 401 && changeOldDk) { changeOldDk = ''; showView('login'); }
    showError(tr(/** @type {Error} */ (e).message));
  }
}

// ── 开通账号 ────────────────────────────────────────────────────────────

/** otpauth URI 里把密钥抠出来，供扫不了码的人手动输入。 @param {string} uri */
function secretFromUri(uri) {
  try {
    const s = new URL(uri).searchParams.get('secret') ?? '';
    return s.replace(/(.{4})/g, '$1 ').trim();   // 四位一组，人念得出来
  } catch { return ''; }
}

async function startEnroll() {
  setBusy(t('正在准备…'));
  try {
    const info = await post('/api/auth/enroll/begin', { token: inviteToken });
    setBusy(null);

    $('enroll-email').textContent = info.email;
    if (info.kind === 'reset') {
      $('enroll-sub').textContent =
        t('重置 {email} 的登录方式。旧密码与旧验证器都会立即失效。', { email: info.email });
    }
    enrollNeedsCode = !!info.totpRequired && !!info.otpauth;
    $('enroll-step-totp').hidden = !enrollNeedsCode;
    $('enroll-step-verify').hidden = !enrollNeedsCode;
    $('enroll-pw-title').textContent = enrollNeedsCode ? t('2 · 设置密码') : t('设置密码');
    if (enrollNeedsCode) {
      drawQr($('enroll-qr'), info.otpauth, { scale: 4 });
      $('enroll-secret').textContent = secretFromUri(info.otpauth);
    } else if (info.kind === 'reset') {
      $('enroll-sub').textContent = t('重置 {email} 的密码。旧密码会立即失效。', { email: info.email });
    }
    showView('enroll');
    $('enroll-password').focus();
  } catch (e) {
    setBusy(null);
    showMessage(tr(/** @type {Error} */ (e).message));
  }
}

async function doEnroll() {
  clearError();
  const email = normalizeEmail($('enroll-email').textContent || '');
  const pw = $('enroll-password').value;
  const pw2 = $('enroll-password2').value;
  const code = enrollNeedsCode ? cleanCode($('enroll-code').value) : '';

  const weak = checkPasswordStrength(pw, email);
  if (weak) { showError(weak); return; }
  if (pw !== pw2) { showError(t('两次输入的密码不一致')); return; }
  if (enrollNeedsCode && !/^\d{6}$/.test(code)) { showError(t('请输入验证器上的 6 位动态码')); return; }

  const btn = $('enroll-submit');
  btn.disabled = true;
  setBusy(t('正在本地计算密钥…'));
  try {
    const dk = await deriveLoginKey(pw, email);
    setBusy(t('正在开通…'));
    await post('/api/auth/enroll/complete', enrollNeedsCode
      ? { token: inviteToken, dk: bytesToB64url(dk), code }
      : { token: inviteToken, dk: bytesToB64url(dk) });
    location.replace('/');
  } catch (e) {
    setBusy(null);
    btn.disabled = false;
    showError(tr(/** @type {Error} */ (e).message));
  }
}

// ── 启动 ────────────────────────────────────────────────────────────────

async function boot() {
  // 应用名是公开信息，顺带确认后端活着。失败不阻塞登录。
  try {
    const cfg = await fetch('/api/auth/config', { headers: { accept: 'application/json' } })
      .then((r) => (r.ok ? r.json() : null));
    if (cfg?.appName) {
      els.appName.textContent = cfg.appName;
      document.title = t('登录') + ' · ' + cfg.appName;
    }
    loginNeedsCode = !!cfg?.totpRequired;
    if (cfg?.mode === 'access') {
      showMessage(t('本站当前使用 Cloudflare Access 登录，请直接访问首页。'));
      return;
    }
  } catch { /* 离线或后端异常，照样把登录表单画出来 */ }

  // 带令牌就是在开通账号：新链接 /enroll/<令牌>，老链接 /enroll#<令牌> 也认
  const m = location.pathname.match(/^\/enroll\/([A-Za-z0-9_-]+)$/);
  const token = m ? m[1] : decodeURIComponent(location.hash.slice(1));
  if (token) {
    inviteToken = token;
    // 令牌从地址栏和历史记录里抹掉，免得被人从浏览器历史里翻到
    history.replaceState(null, '', '/enroll');
    await startEnroll();
    return;
  }

  // 主站发现会话还带着 mustChange，把人送到这里。邮箱从当前会话里取。
  if (new URLSearchParams(location.search).has('change')) {
    try {
      const res = await fetch('/api/me', { headers: { accept: 'application/json' }, credentials: 'same-origin' });
      const me = res.ok ? await res.json() : null;
      if (me?.user?.mustChange) { showChange(me.user.email, ''); return; }
      if (me?.user) { location.replace(safeNext()); return; }
    } catch { /* 当作没登录 */ }
  }

  if (location.pathname === '/enroll') {
    showMessage(t('这个开通链接不完整。请把管理员发给你的整条链接（/enroll/ 后面还有一长串字符）完整复制到浏览器地址栏打开；如果还不行，请管理员重新生成一次。'));
    return;
  }

  $('login-code-field').hidden = !loginNeedsCode;
  $('login-code-hint').hidden = !loginNeedsCode;
  showView('login');
  $('login-email').focus();
}

els.login.addEventListener('submit', (e) => { e.preventDefault(); doLogin(); });
els.enroll.addEventListener('submit', (e) => { e.preventDefault(); doEnroll(); });
els.change.addEventListener('submit', (e) => { e.preventDefault(); doChange(); });

boot();
