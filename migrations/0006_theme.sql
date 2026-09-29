-- ============================================================================
-- 0006_theme.sql — 主题配色
--
-- users.theme：每个人自己选的配色 id（内置的 slug 或管理员加的 c_xxxx）。NULL = 跟随系统默认。
-- 系统默认配色、管理员新增的配色存在 app_settings：
--   · theme_default  → 配色 id（没有这一行 = pastel-dreams，马卡龙色）
--   · themes_custom  → JSON 数组 [{ id, name, colors:[5 个 #rrggbb] }]
-- ============================================================================

ALTER TABLE users ADD COLUMN theme TEXT;
