-- ============================================================================
-- 0003_settings.sql — 全站开关
--
-- 目前只有一个键：totp_required。
--   · 没有这一行 / 值不是 '1' → 登录只要邮箱 + 密码
--   · '1'                     → 登录必须再带 6 位动态码
-- 默认关。开关在界面右上角「安全设置」里，只有管理员看得到。
-- ============================================================================

CREATE TABLE IF NOT EXISTS app_settings (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at INTEGER NOT NULL DEFAULT 0,
  updated_by TEXT
);
