# Needtable

**一个只有受邀的人才能用的在线表格，部署在你自己的 Cloudflare 上，数据在你自己手里。**

中文 · [English](#english)

## 为什么做它

想和几个人一起在线维护一张表，现有的选择都有点别扭：

- **Excel**：桌面版要付费订阅，在线协作还要每个人都有微软账号。
- **Google 表格**：每个人都得注册 Google 账号，国内访问也不方便。
- **WPS 等国产办公软件**：要下载客户端、注册账号，文件存在厂商的服务器上。

Needtable 的做法是：

- **打开浏览器就能用**，不用下载安装任何软件。
- **只有你邀请的人能进**：不开放注册，账号由管理员开通。没登录的人连页面代码都拿不到。
- **自己搭建，隐私好**：代码开源，跑在你自己的 Cloudflare 账号上，数据不经过任何第三方。
- **兼容 Excel**：能导入导出 `.xlsx` / `.csv`，和 Excel 之间直接复制粘贴，常用公式写法一致，上手不用重新学。
- **免费**：只用 Cloudflare 的免费额度，不用绑信用卡。

## 能做什么

- **表格**：公式和函数、数字格式、条件格式、合并单元格、冻结行列、数据验证和多级下拉、查找替换、撤销重做
- **分析**：透视表、柱形 / 条形 / 折线 / 面积 / 饼图、看板、可拖拽排版的仪表盘（能导出 PNG / PDF）
- **文档和幻灯片**：可以嵌入表格里的数据和图表，表格改了它们跟着更新；支持导入导出 Word、PowerPoint、PDF
- **多人协作**：实时同步，能看到别人的光标；断网时的修改联网后自动补上
- **权限**：按工作区、内容、单张表分享，分所有者、管理者、可编辑、只读四级；也可以生成公开只读链接
- **多语言界面**：中文（默认）、English、日本語、한국어、Español、Français，右上角切换，每个人的语言偏好跟着账号走
- **账号安全**：密码只在浏览器里做哈希，服务器见不到明文；可以全站开启手机验证器动态码

## 截图

![表格：公式、格式和 Excel 一样的功能区](docs/screenshots/grid.png)

| 看板 | 仪表盘 |
|---|---|
| ![看板视图](docs/screenshots/kanban.png) | ![仪表盘](docs/screenshots/dashboard.png) |

| 幻灯片（日语界面） | English UI |
|---|---|
| ![幻灯片，日语界面](docs/screenshots/slides-ja.png) | ![英文界面的表格](docs/screenshots/grid-en.png) |

## 自己部署（约 10 分钟）

需要准备：一个 Cloudflare 账号和托管在上面的域名，以及 [Node.js](https://nodejs.org) LTS。

1. **填域名**：把 `wrangler.jsonc` 里的两处 `table.example.com` 换成你的子域名。如果不想把这些改动提交进仓库，可以复制一份 `wrangler.local.jsonc` 只改这份，它已经在 `.gitignore` 里。
2. **部署**：Windows 双击 `deploy.cmd`；macOS / Linux 运行 `./scripts/deploy.sh`。脚本会引导你登录 Cloudflare，自动建库、迁移、生成密钥。以后改了代码，再运行一次就行。
3. **给自己开管理员账号**：
   ```bash
   node scripts/user.mjs add you@example.com --name 你的名字 --admin
   ```
   命令会打印一条一次性开通链接，在浏览器打开、设好密码就能登录。之后在网页顶栏的「用户管理」里给其他人开账号。

> 部署后不要修改 `wrangler.jsonc` 里的 Worker 名字 `table`：改名等于新建一个 Worker，旧的表格数据会留在原来那个 Worker 上。显示名称可以通过 `vars.APP_NAME` 随意修改。

## 本地开发

本地运行**不需要 Cloudflare 账号**：wrangler 在本机模拟 Workers、Durable Objects 和 D1，数据存在项目里的 `.wrangler/state/` 目录。只有第一次 `npm install` 需要联网（下载 wrangler），之后断网也能跑。

```bash
npm install                      # 第一次需要联网
cp .dev.vars.example .dev.vars   # 本地配置；默认免登录，把 DEV_BYPASS_EMAIL 改成你的邮箱
npm run migrate:local            # 建本地数据库的表（第一次，以及每次拉到新的 migrations 后）
npm run dev:local                # 完全在本机运行，打开 http://localhost:8787
npm test                         # 全部测试，纯 Node，不需要浏览器
```

- `npm run dev`（不带 `:local`）是**远程模式**：代码跑在 Cloudflare 上，需要先 `npx wrangler login`，一般用不到。
- 想在本地走真实的登录流程：把 `.dev.vars` 里的 `DEV_BYPASS_EMAIL` 那一行注释掉，然后运行 `node scripts/user.mjs add you@example.com --admin --local`，打开它打印的链接设密码。
- 想清空本地数据：停掉服务，删除 `.wrangler/state/` 目录，再运行一次 `npm run migrate:local`。

不需要构建：原生 ES Modules，改完直接部署。欢迎提交 issue 和 PR，提交前请确认 `npm test` 全部通过。

## 内网 / 私有部署（不用 Cloudflare）

公司内网、自己的服务器、数据只存在本机，**可以**：用上面「本地开发」的同一套本地模式常驻运行，前面加一层 HTTPS 反向代理给内网访问。所有数据（账号、表格、附件）都在服务器的 `.wrangler/state/` 目录里，不连 Cloudflare，也不连任何外部服务（前端没有 CDN、外部字体）。

> **先了解限制**：这里用的是 wrangler 的本地运行时（和 Cloudflare 线上是同一个 workerd 引擎），它的定位是开发服务器，Cloudflare 不对这种用法做生产保证。几十人以内的团队内部使用问题不大，但**一定要定期备份**。单独运行 workerd 不带 D1 数据库，所以要按下面的方法通过 wrangler 启动。

**1. 准备服务器**

- Windows、Linux、macOS 都可以，装好 [Node.js](https://nodejs.org) LTS（20 或更新）和 git。
- 安装步骤要联网一次（下载代码和 wrangler）。装完之后服务器可以完全断开外网。如果服务器本身不能上网，可以在一台能上网的同系统机器上做完第 2 步，把整个目录（含 `node_modules`）拷过去。

**2. 下载代码并安装**

```bash
git clone https://github.com/franklinzha/Needtable.git
cd Needtable
npm install
```

**3. 写配置文件 `.dev.vars`**

```bash
cp .dev.vars.example .dev.vars
```

用文本编辑器打开 `.dev.vars`，改成下面这样（**注意删掉 `DEV_BYPASS_EMAIL` 和 `DEV_BYPASS_NAME` 两行**，否则任何人打开页面都会直接以管理员身份登录）：

```ini
ENVIRONMENT=production
SESSION_SECRET=换成一串随机字符
AUTH_PEPPER=换成另一串随机字符
REALTIME_SECRET=再换一串随机字符
```

三把密钥各生成一串随机值，比如运行三次：

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"
```

`AUTH_PEPPER` 定下来之后**不要再改**：改了以后所有人的密码和验证器都会失效，只能逐个重置。`.dev.vars` 已在 `.gitignore` 里，不会被提交。

**4. 建数据库的表**

```bash
npm run migrate:local
```

**5. 为什么必须用 HTTPS**

登录时，密码是在浏览器里先做哈希再发给服务器的（服务器永远见不到明文），这要用到浏览器的 Web Crypto 功能。浏览器规定它**只能在 HTTPS 或 `localhost` 下使用**，所以同事直接用 `http://192.168.1.50:8787` 打开的话，页面能显示，但**登录不了**。

因此内网部署的做法是：Needtable 只监听本机，前面放一个 Caddy 或 nginx 提供 HTTPS。下面假设大家用 `https://table.company.lan` 访问：

- 这个名字要能在内网解析到服务器：在公司 DNS 里加一条记录，或者在每台电脑的 `hosts` 文件里加一行 `192.168.1.50  table.company.lan`。
- 只是想先在服务器上自己试一下的话，可以跳过 HTTPS：用第 6 步的命令去掉 `--local-upstream` 和 `--upstream-protocol` 两个参数，在服务器本机打开 `http://localhost:8787`。

**6. 启动 Needtable**

```bash
npm run dev:local -- --ip 127.0.0.1 --port 8787 --local-upstream table.company.lan --upstream-protocol https
```

- `--ip 127.0.0.1 --port 8787`：只监听本机的 8787 端口，外面只能经过 HTTPS 代理访问。
- `--local-upstream table.company.lan --upstream-protocol https`：告诉程序「用户实际是用 `https://table.company.lan` 访问的」。开通链接用这个地址生成，登录 Cookie 也会按 HTTPS 加上安全标记。**必须和用户实际访问的地址一致**，不填的话会用 `wrangler.jsonc` 里的示例域名，生成的链接打不开。
- 看到 `Ready on http://127.0.0.1:8787` 就启动好了。先别关这个终端，第 7、8 步做完再按第 9 步改成常驻运行。

**7. 配置 HTTPS 反向代理**

任选一种：

- **Caddy（最简单）**：安装 [Caddy](https://caddyserver.com)，新建一个 `Caddyfile`：
  ```
  table.company.lan {
    tls internal
    reverse_proxy 127.0.0.1:8787
  }
  ```
  在 `Caddyfile` 所在目录运行 `caddy run`（常驻用 `caddy start` 或装成服务）。`tls internal` 表示 Caddy 自己签发内网证书。同事的电脑要信任 Caddy 的根证书，否则浏览器会提示证书不受信任：根证书在 Caddy 数据目录的 `pki/authorities/local/root.crt`，通过域控组策略下发，或者在每台电脑上双击导入到「受信任的根证书颁发机构」。公司已经有自己的证书的话，把 `tls internal` 换成 `tls 证书.pem 私钥.pem`。WebSocket 会自动转发。
- **nginx**：用公司的证书，**要转发 WebSocket**（实时协作用 `/api/realtime/ws`）：
  ```nginx
  server {
    listen 443 ssl;
    server_name table.company.lan;
    ssl_certificate     /path/to/cert.pem;
    ssl_certificate_key /path/to/key.pem;
    client_max_body_size 50m;
    location / {
      proxy_pass http://127.0.0.1:8787;
      proxy_http_version 1.1;
      proxy_set_header Upgrade $http_upgrade;
      proxy_set_header Connection "upgrade";
      proxy_set_header Host $host;
      proxy_read_timeout 1h;
    }
  }
  ```

服务器防火墙放行 443 端口（8787 不用放行）。

**8. 给自己开管理员账号**

保持服务运行，另开一个终端，在项目目录运行：

```bash
node scripts/user.mjs add you@company.com --name 你的名字 --admin --local --host https://table.company.lan
```

打开它打印的一次性链接设好密码，就能登录了。之后在网页顶栏的「用户管理」里给同事开账号，不用再碰命令行。

**9. 开机自动运行**

终端关掉服务就停了，要让它常驻，任选一种（下面的「启动参数」指第 6 步 `npm run dev:local --` 后面那一串）：

- **pm2（Windows / Linux / macOS 通用）**：
  ```bash
  npm install -g pm2
  pm2 start npm --name needtable -- run dev:local -- --ip 127.0.0.1 --port 8787 --local-upstream table.company.lan --upstream-protocol https
  pm2 save
  pm2 startup        # Linux / macOS：按提示执行它打印的那条命令
  ```
  Windows 上 `pm2 startup` 不可用，可以装 `pm2-installer`，或用下面的 NSSM。常用命令：`pm2 logs needtable` 看日志，`pm2 restart needtable` 重启。
- **Windows 服务（NSSM）**：下载 [NSSM](https://nssm.cc)，运行 `nssm install Needtable`。Path 填 `npm.cmd` 的完整路径（`where npm.cmd` 可以查到），Startup directory 填项目目录，Arguments 填 `run dev:local -- ` 加上启动参数，保存后运行 `nssm start Needtable`。
- **Linux systemd**：新建 `/etc/systemd/system/needtable.service`，`WorkingDirectory` 设为项目目录，`ExecStart` 设为 `/usr/bin/npm run dev:local -- ` 加上启动参数，加上 `Restart=always`，然后运行 `systemctl enable --now needtable`。

**10. 备份、升级、迁移**

- **备份**：所有数据都在 `.wrangler/state/` 目录。先停服务（`pm2 stop needtable`），把整个目录复制或打包到别处，再启动。建议每天定时做一次。
- **恢复 / 换服务器**：新服务器按第 1～3 步装好，把备份的 `.wrangler/state/` 放回项目目录（`.dev.vars` 也要一起带过去，里面的 `AUTH_PEPPER` 必须和原来一样），再启动。
- **升级**：停服务 → 备份 → `git pull` → `npm install` → `npm run migrate:local` → 启动。
- **命令行管理账号**：`node scripts/user.mjs list --local`、`reset 邮箱 --local`、`disable 邮箱 --local` 等，完整用法见 `scripts/user.mjs` 开头的说明。

## 技术栈

Cloudflare Workers + Durable Objects（SQLite，每张表一个，WebSocket 实时同步）+ D1（账号和权限）。前端不依赖任何框架，公式引擎是自己写的，不使用 `eval`。

## English

**Needtable is an invite-only online spreadsheet you host on your own Cloudflare account, so your data stays yours.**

Existing options each come with friction. Excel desktop needs a paid subscription, and online collaboration requires everyone to have a Microsoft account. Google Sheets requires a Google account for every collaborator. WPS and similar suites need a desktop client and store your files on the vendor's servers.

What Needtable offers instead:

- **Runs in the browser**: nothing to download or install.
- **Invite-only**: there is no public sign-up, and an admin creates every account. Visitors who are not signed in can't load even the app's code.
- **Self-hosted and private**: the code is open source (MIT) and runs on your own Cloudflare account. No third party sees your data.
- **Works with Excel**:
  - import and export `.xlsx` / `.csv`;
  - copy and paste to and from Excel;
  - common formulas are written the same way as in Excel.
- **Free to run**: it fits within Cloudflare's free tier, with no credit card needed.

Features include:

- formulas, formatting, conditional formatting and data validation;
- pivot tables, charts and dashboards;
- documents and slides that embed live table data;
- real-time collaboration with offline catch-up;
- fine-grained sharing with four permission levels;
- optional TOTP two-factor login;
- a UI in six languages, chosen per user.

![Needtable in English](docs/screenshots/grid-en.png)

**Deploy**:

1. Replace `table.example.com` in `wrangler.jsonc` with your own subdomain.
2. Run `deploy.cmd` on Windows or `./scripts/deploy.sh` on macOS / Linux.
3. Create your admin account with `node scripts/user.mjs add you@example.com --admin`.
4. Open the one-time link it prints and set your password.

The UI is available in Chinese (default), English, Japanese, Korean, Spanish and French. Switch languages from the top-right corner; each user's choice is saved to their account.

### Local development

Running locally **does not need a Cloudflare account**. Wrangler emulates Workers, Durable Objects and D1 on your machine and stores the data in `.wrangler/state/`. Only the first `npm install` needs internet access; after that it works offline.

```bash
npm install                      # needs internet the first time
cp .dev.vars.example .dev.vars   # local config; sign-in is bypassed by default (set DEV_BYPASS_EMAIL)
npm run migrate:local            # create the local database tables (again after pulling new migrations)
npm run dev:local                # runs fully on your machine at http://localhost:8787
npm test                         # all tests, plain Node, no browser needed
```

- `npm run dev` (without `:local`) is **remote mode**: the code runs on Cloudflare and needs `npx wrangler login` first.
- To test the real sign-in flow, comment out `DEV_BYPASS_EMAIL` in `.dev.vars`, run `node scripts/user.mjs add you@example.com --admin --local`, and open the link it prints.
- To wipe local data, stop the server, delete `.wrangler/state/`, and run `npm run migrate:local` again.

### Self-hosting on a LAN (no Cloudflare)

You can run Needtable on your own server inside a company network, with all data kept on that server. It uses the same local mode as above, kept running in the background behind an HTTPS reverse proxy. All data (accounts, tables, attachments) lives in `.wrangler/state/`. Nothing connects to Cloudflare or any other outside service; the frontend loads no CDN or web fonts.

> **Limits**: this uses wrangler's local runtime (the same workerd engine Cloudflare runs). It is meant as a development server, and Cloudflare does not support it for production. It works well for a team of a few dozen people, but **back up regularly**. Plain standalone workerd has no D1 database, so start it through wrangler as shown below.

**HTTPS is required.** Passwords are hashed in the browser with Web Crypto before they are sent, and browsers only allow Web Crypto on HTTPS or `localhost`. Colleagues opening `http://192.168.1.50:8787` directly will see the page but **cannot sign in**.

1. **Prepare the server**: Windows, Linux or macOS with [Node.js](https://nodejs.org) LTS (20+) and git. Installing needs internet once. Afterwards the server can be fully offline. For an air-gapped server, run step 2 on a machine with the same OS and copy the whole folder, including `node_modules`.
2. **Get the code**:
   ```bash
   git clone https://github.com/franklinzha/Needtable.git
   cd Needtable
   npm install
   ```
3. **Configure**: run `cp .dev.vars.example .dev.vars`. Then edit `.dev.vars` so it contains only the lines below. **Delete `DEV_BYPASS_EMAIL` and `DEV_BYPASS_NAME`**, or anyone who opens the page is signed in as an admin.
   ```ini
   ENVIRONMENT=production
   SESSION_SECRET=<random string>
   AUTH_PEPPER=<another random string>
   REALTIME_SECRET=<another random string>
   ```
   Generate each value with `node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"`. **Never change `AUTH_PEPPER` later**: doing so invalidates every password and authenticator.
4. **Create the tables**: `npm run migrate:local`
5. **Start Needtable**, listening only on localhost. The example below assumes users will open `https://table.company.lan`. That name must resolve to the server through internal DNS or a `hosts` entry.
   ```bash
   npm run dev:local -- --ip 127.0.0.1 --port 8787 --local-upstream table.company.lan --upstream-protocol https
   ```
   `--local-upstream` and `--upstream-protocol` tell the app the address users actually use. Invite links are built from it, and cookies get the secure flag. They must match the real address, or the links point to the placeholder domain in `wrangler.jsonc`.
6. **Add an HTTPS reverse proxy**: pick one.
   - **Caddy** (simplest). Use this `Caddyfile` and run it with `caddy run`:
     ```
     table.company.lan {
       tls internal
       reverse_proxy 127.0.0.1:8787
     }
     ```
     Client machines must trust Caddy's root certificate, `pki/authorities/local/root.crt` in Caddy's data directory. Push it through group policy or import it on each machine. If you have your own certificate, use `tls cert.pem key.pem` instead.
   - **nginx** with your own certificate. It must forward WebSocket upgrades, because real-time collaboration uses `/api/realtime/ws`. Add these to the proxied `location`: `proxy_http_version 1.1`, `proxy_set_header Upgrade $http_upgrade`, `proxy_set_header Connection "upgrade"`, `proxy_set_header Host $host` and `proxy_read_timeout 1h`. The Chinese section above has the full config.

   Open port 443 in the firewall. Port 8787 stays closed.
7. **Create your admin account** in a second terminal while the server runs:
   ```bash
   node scripts/user.mjs add you@company.com --admin --local --host https://table.company.lan
   ```
   Open the one-time link it prints and set your password. Add everyone else from **Users** in the top bar.
8. **Keep it running** with one of these:
   - pm2: `pm2 start npm --name needtable -- run dev:local -- <the flags from step 5>`, then `pm2 save` and `pm2 startup`. `pm2 startup` is not available on Windows, so use `pm2-installer` or NSSM there.
   - NSSM, as a Windows service.
   - systemd on Linux, with `Restart=always`.
9. **Back up and upgrade**
   - To back up, stop the service and copy `.wrangler/state/`. Keep `.dev.vars` with it, since the same `AUTH_PEPPER` is needed to restore.
   - To upgrade: stop → back up → `git pull` → `npm install` → `npm run migrate:local` → start.

Trying it on the server alone? Drop the two upstream flags and open `http://localhost:8787` on the server itself. localhost doesn't need HTTPS.

## 许可证

[MIT](LICENSE)
