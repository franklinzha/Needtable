-- ============================================================================
-- 0005_public_links.sql — 公开只读链接
--
-- 一张表至多一条公开链接。拿到链接的人（登没登录都行）只能看，不能改、不能复制导出。
-- 令牌 32 字节随机数 base64url（43 字符），整个链接就是凭据：删掉这一行即刻失效。
-- 只有 admin / pro 能开（tiers.js 的 publicShare），表的 manager 及以上能关。
-- ============================================================================

CREATE TABLE public_links (
  token      TEXT PRIMARY KEY,
  table_id   TEXT NOT NULL UNIQUE REFERENCES tables (id) ON DELETE CASCADE,
  created_by TEXT,
  created_at INTEGER NOT NULL
);
