-- ============================================================================
-- 0002_auth.sql — 自建口令登录
--
-- 这张迁移推翻了 0001 里那句「本项目不自建凭据」。原因是外部的：
-- Cloudflare Zero Trust（Access）要求账户绑定信用卡，而本项目的使用者没有，
-- 所以边界认证这条路走不通，只能把登录墙搬进应用自己。
--
-- 安全要求没有降级，只是换了实现：
--   · 未登录仍然拿不到 index.html（靠 run_worker_first + 会话 Cookie 门禁）
--   · 仍然不开放注册，账号一律由管理员用 scripts/user.mjs 签发邀请链接
--   · 多了一道 TOTP 第二因素
--
-- Access 那条链路的代码全部保留，wrangler.jsonc 里 AUTH_MODE 改回 "access"
-- 即可切换 —— 哪天有卡了，一个词的事。
--
-- 口令的存法见 worker/lib/password.js：库里存的是
--   HMAC-SHA256(AUTH_PEPPER, pw_salt ‖ dk)
-- 其中 dk 是浏览器用 600k 次 PBKDF2 算出来的。库被脱走也打不开，
-- 因为 pepper 在 Cloudflare 的 secret store 里，不在 D1 里。
-- ============================================================================

-- ─── 用户表补齐凭据字段 ─────────────────────────────────────────────────────
ALTER TABLE users ADD COLUMN pw_hash        TEXT;                      -- base64url，见上
ALTER TABLE users ADD COLUMN pw_salt        TEXT;                      -- base64url，16 字节
ALTER TABLE users ADD COLUMN pw_version     INTEGER NOT NULL DEFAULT 1;-- KDF 版本，便于日后换算法
ALTER TABLE users ADD COLUMN pw_updated_at  INTEGER NOT NULL DEFAULT 0;

ALTER TABLE users ADD COLUMN totp_secret    TEXT;                      -- AES-GCM 密文
-- 已经用过的时间窗。不记的话，同一个 6 位码在 30 秒内能重复使用。
ALTER TABLE users ADD COLUMN totp_last_step INTEGER NOT NULL DEFAULT 0;

-- pending：邀请已发但还没设置口令；active：正常；disabled：管理员停用
ALTER TABLE users ADD COLUMN status         TEXT NOT NULL DEFAULT 'active';

-- 会话吊销计数器。+1 即让该用户已签发的所有 Cookie 立刻失效，
-- 省掉一张 sessions 表和它带来的每次登录一行 D1 写入。
ALTER TABLE users ADD COLUMN session_epoch  INTEGER NOT NULL DEFAULT 1;

-- 连续失败锁定。写入受 worker/middleware/ratelimit.js 的内存限流保护，
-- 不会被撞库刷爆 D1 的写额度。
ALTER TABLE users ADD COLUMN failed_count   INTEGER NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN locked_until   INTEGER NOT NULL DEFAULT 0;

CREATE INDEX idx_users_status ON users (status);

-- ─── 邀请 / 重置令牌 ────────────────────────────────────────────────────────
-- 库里只存 sha256(token)。令牌本身有 256 位熵，不需要慢哈希 ——
-- 慢哈希是为了保护低熵口令，对随机令牌没有意义。
--
-- 管理员签发令牌时**算不出**口令哈希（pepper 在 Cloudflare 那边，CLI 拿不到），
-- 这正好是想要的：管理员从头到尾不知道用户的口令，也不知道 TOTP 密钥。
CREATE TABLE user_invites (
  token_hash  TEXT PRIMARY KEY,                    -- sha256(token) 的十六进制
  user_id     TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  email       TEXT NOT NULL,
  kind        TEXT NOT NULL DEFAULT 'invite',      -- invite | reset
  created_by  TEXT,
  created_at  INTEGER NOT NULL,
  expires_at  INTEGER NOT NULL,
  used_at     INTEGER
);
CREATE INDEX idx_invites_user ON user_invites (user_id);
CREATE INDEX idx_invites_expires ON user_invites (expires_at);
