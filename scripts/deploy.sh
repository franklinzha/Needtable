#!/usr/bin/env bash
# 部署（macOS / Linux）。Windows 请直接双击项目根目录的 deploy.cmd。
# 幂等，可重复运行。D1 / KV 会在首次 deploy 时由 wrangler 自动创建。
set -euo pipefail
cd "$(dirname "$0")/.."
# 有 wrangler.local.jsonc（本机真实配置，不进仓库）就用它
CFG=wrangler.jsonc; [ -f wrangler.local.jsonc ] && CFG=wrangler.local.jsonc

echo -e "\n[1/4] 检查登录状态"
npx --yes wrangler@4 whoami >/dev/null 2>&1 || npx --yes wrangler@4 login

echo -e "\n[2/4] 部署 Worker（首次会自动创建 D1 和 KV）"
npx --yes wrangler@4 deploy -c "$CFG"

echo -e "\n[3/4] 建表（应用数据库迁移）"
CI=true npx --yes wrangler@4 d1 migrations apply table-db --remote -c "$CFG"   # 没有 --yes 这个参数，CI=true 才是跳过确认的办法

# 三把密钥都不进仓库，只存在 Cloudflare 那边：
#   SESSION_SECRET   会话 Cookie 的签名密钥
#   AUTH_PEPPER      口令哈希、TOTP 密钥加密用的 pepper
#   REALTIME_SECRET  WebSocket 票据的签名密钥
# 换掉任何一把都有后果：换 SESSION_SECRET 是所有人重新登录；换 AUTH_PEPPER
# 是所有密码和验证器一起作废，只能逐个 reset 重新开通。所以只在缺失时生成。
echo -e "\n[4/4] 检查密钥"
existing=$(npx --yes wrangler@4 secret list -c "$CFG" 2>/dev/null || true)
for name in SESSION_SECRET AUTH_PEPPER REALTIME_SECRET; do
  if grep -q "$name" <<<"$existing"; then
    echo "      $name 已存在，跳过"
  else
    echo "      生成 $name ..."
    node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))" \
      | npx --yes wrangler@4 secret put "$name" -c "$CFG"
  fi
done

cat <<'TIP'

部署完成。

站点已经跑起来了，但现在一个账号都没有，谁也进不去 ——
本站不开放注册，账号只能从命令行签发。先给自己开一个管理员：

    node scripts/user.mjs add 你的邮箱@example.com --admin

它会打印一条一次性开通链接（还带一个二维码）。在浏览器里打开，
用验证器 App 扫码，设一个密码，就进站了。
密码和验证器密钥都只在你自己手里 —— 服务器上存的是哈希，管理员也看不到。

往后常用的几条：
    node scripts/user.mjs list                        看看都有谁
    node scripts/user.mjs add 同事@example.com        再开一个普通成员
    node scripts/user.mjs reset 某人邮箱              换手机/忘密码，重发链接
    node scripts/user.mjs disable 某人邮箱            停用，所有设备立刻下线

详见 README.md。
TIP
