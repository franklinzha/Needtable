@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"
rem 有 wrangler.local.jsonc（本机真实配置，不进仓库）就用它
set "CFG=wrangler.jsonc"
if exist wrangler.local.jsonc set "CFG=wrangler.local.jsonc"

echo.
echo ================================================
echo    Table - 一键部署到 Cloudflare
echo ================================================
echo.

rem ── 1. Node.js ──────────────────────────────────────────────────────────────
echo [1/5] 检查 Node.js
where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo    没找到 Node.js。请先装一次：https://nodejs.org  选 LTS 版，一路下一步。
  echo    装完重新双击本文件即可。Cloudflare 本身不需要安装任何东西。
  echo.
  pause
  exit /b 1
)
for /f "delims=" %%v in ('node --version') do echo        Node %%v

rem ── 2. 登录 ─────────────────────────────────────────────────────────────────
echo [2/5] 检查 Cloudflare 登录状态
call npx --yes wrangler@4 whoami >nul 2>nul
if errorlevel 1 (
  echo        未登录，正在打开浏览器授权...
  call npx --yes wrangler@4 login
  if errorlevel 1 goto :fail
)

rem ── 3. 部署（首次会自动创建 D1 和 KV）────────────────────────────────────────
echo [3/5] 部署 Worker（首次会自动创建 D1 数据库和 KV）
call npx --yes wrangler@4 deploy -c "%CFG%"
if errorlevel 1 goto :fail

rem ── 4. 数据库迁移 ───────────────────────────────────────────────────────────
echo [4/5] 建表（应用数据库迁移）
rem  没有 --yes 这种参数。wrangler 在非交互环境会自己跳过确认，
rem  CI=true 就是告诉它"别问了"；万一它不认，也只是多按一次 y，不会出错。
setlocal
set CI=true
call npx --yes wrangler@4 d1 migrations apply table-db --remote -c "%CFG%"
endlocal
if errorlevel 1 goto :fail

rem ── 5. 三把密钥（已有就跳过）─────────────────────────────────────────────────
echo [5/5] 检查密钥
rem  三把密钥都不进仓库，只存在 Cloudflare 那边：
rem    SESSION_SECRET   会话 Cookie 的签名密钥
rem    AUTH_PEPPER      口令哈希、TOTP 密钥加密用的 pepper
rem    REALTIME_SECRET  WebSocket 票据的签名密钥
rem  换掉任何一把都有后果：换 SESSION_SECRET 是所有人重新登录；
rem  换 AUTH_PEPPER 是所有密码和验证器一起作废，只能逐个 reset 重新开通。
rem  所以下面只在缺失时生成，绝不覆盖已有的。
set "SECRET_LIST=%TEMP%\table_secret_list.txt"
call npx --yes wrangler@4 secret list -c "%CFG%" > "%SECRET_LIST%" 2>nul
for %%S in (SESSION_SECRET AUTH_PEPPER REALTIME_SECRET) do (
  findstr /C:"%%S" "%SECRET_LIST%" >nul
  if errorlevel 1 (
    echo        生成 %%S ...
    node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))" | call npx --yes wrangler@4 secret put %%S -c "%CFG%"
  ) else (
    echo        %%S 已存在，跳过
  )
)
del "%SECRET_LIST%" >nul 2>nul

echo.
echo ================================================
echo    部署完成
echo ================================================
echo.
echo  站点已经在 wrangler.jsonc 里配置的域名上跑起来了，但现在一个账号都没有，
echo  谁也进不去 —— 本站不开放注册，账号只能从命令行签发。
echo.
echo  先给自己开一个管理员：
echo.
echo      node scripts/user.mjs add 你的邮箱@example.com --admin
echo.
echo  它会打印一条一次性开通链接（还带一个二维码）。在浏览器里打开，
echo  用验证器 App 扫码（Google Authenticator、1Password、微信都行），
echo  设一个密码，就进站了。
echo  密码和验证器密钥都只在你自己手里 —— 服务器上存的是哈希，管理员也看不到。
echo.
echo  往后常用的几条：
echo      node scripts/user.mjs list                        看看都有谁
echo      node scripts/user.mjs add 同事@example.com        再开一个普通成员
echo      node scripts/user.mjs reset 某人邮箱              换手机/忘密码，重发链接
echo      node scripts/user.mjs disable 某人邮箱            停用，所有设备立刻下线
echo.
echo  详细说明见 README.md。
echo.
pause
exit /b 0

:fail
echo.
echo ================================================
echo    部署失败
echo ================================================
echo  把上面红色的报错整段复制给我，我来看。
echo.
pause
exit /b 1
