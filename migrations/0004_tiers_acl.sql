-- ============================================================================
-- 0004_tiers_acl.sql — 四档用户、三级分享、引用授权、首次登录强制改密
--
-- 用户等级（users.role）：admin > pro > plus > normal，能做什么见 worker/lib/tiers.js。
-- 原来的 member 一律升为 plus —— 他们本来就能建表、能分享，不能因为升级丢权限。
--
-- 资源角色：owner > manager > editor > viewer。manager 能继续转分享，只有 pro 及以上能授出。
-- 授权分三级：workspace_members / base_acl / table_acl，**最具体的那一级胜出**
-- （表级 > 内容级 > 工作区级），同一级里的 scope 一起生效。
--
-- scope：NULL 表示全部视图；否则是逗号分隔的 grid,kanban,dashboard 子集。
-- 只是界面层的限制 —— 看板和仪表盘本身就要靠表数据来画，数据照样会下发。
-- ============================================================================

ALTER TABLE users ADD COLUMN must_change_pw INTEGER NOT NULL DEFAULT 0;
UPDATE users SET role = 'plus' WHERE role = 'member';

ALTER TABLE workspace_members ADD COLUMN scope TEXT;
ALTER TABLE table_acl ADD COLUMN scope TEXT;

CREATE TABLE base_acl (
  base_id    TEXT NOT NULL REFERENCES bases (id) ON DELETE CASCADE,
  user_id    TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  role       TEXT NOT NULL,                        -- manager | editor | viewer
  scope      TEXT,
  created_by TEXT,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (base_id, user_id)
);
CREATE INDEX idx_base_acl_user ON base_acl (user_id);

-- 跨表引用授权（类似 Google 表格的 IMPORTRANGE）。
-- 写公式的人登记时必须能看 to_table；此后任何能看 from_table 的人，
-- 都能读到 to_table 上这块区域的**计算结果** —— 但打不开 to_table 本身。
CREATE TABLE table_refs (
  from_table TEXT NOT NULL REFERENCES tables (id) ON DELETE CASCADE,
  to_table   TEXT NOT NULL REFERENCES tables (id) ON DELETE CASCADE,
  range_a1   TEXT NOT NULL,                        -- 规范化后的 A1 区域，如 A1:C10、B:B
  created_by TEXT,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (from_table, to_table, range_a1)
);
CREATE INDEX idx_table_refs_to ON table_refs (to_table);
