-- ============================================================================
-- 0001_core.sql — 目录层核心表
--
-- 设计要点：D1 只存「目录与冷数据」，单元格内容一律进 Durable Object 的
-- SQLite。原因是 D1 免费额度自 2026-09-01 起强制执行 100K 行写入/天，
-- 若把每次单元格编辑写进 D1，单人连续编辑几小时就会触顶报错。
--
-- workspace_id 贯穿所有业务表：即使当前只服务单个组织，这个字段现在加成本
-- 接近零，后期补则需要改写每一条查询。
-- ============================================================================

-- ─── 用户 ───────────────────────────────────────────────────────────────────
-- 身份由 Cloudflare Access 提供，这里只做本地映射与角色。
-- 没有 password / password_hash / session 字段 —— 本项目不自建凭据。
CREATE TABLE users (
  id           TEXT PRIMARY KEY,
  email        TEXT NOT NULL UNIQUE,
  name         TEXT,
  access_sub   TEXT,                                -- Access JWT 的 sub
  role         TEXT NOT NULL DEFAULT 'member',      -- admin | member
  created_at   INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL
);
CREATE INDEX idx_users_access_sub ON users (access_sub);

-- ─── 工作区 ─────────────────────────────────────────────────────────────────
CREATE TABLE workspaces (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  icon       TEXT,
  owner_id   TEXT NOT NULL REFERENCES users (id),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX idx_workspaces_owner ON workspaces (owner_id);

CREATE TABLE workspace_members (
  workspace_id TEXT NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  user_id      TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  role         TEXT NOT NULL DEFAULT 'editor',      -- owner | editor | viewer
  created_at   INTEGER NOT NULL,
  PRIMARY KEY (workspace_id, user_id)
);
CREATE INDEX idx_ws_members_user ON workspace_members (user_id);

-- ─── Base（Notion 式分组，一个工作区下的若干表归成一组）─────────────────────
CREATE TABLE bases (
  id           TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  name         TEXT NOT NULL,
  icon         TEXT,
  ordinal      TEXT NOT NULL,                       -- 字符串分数索引
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL
);
CREATE INDEX idx_bases_workspace ON bases (workspace_id, ordinal);

-- ─── 表 ─────────────────────────────────────────────────────────────────────
-- kind 决定公式引用语法：
--   'sheet' → Google Sheets 式 A1 / B2:D9（列即 A、B、C…）
--   'grid'  → Airtable 式 {字段名}
-- 两种模式共用同一个求值器，只换 resolver（见 shared/formula/）。
CREATE TABLE tables (
  id           TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  base_id      TEXT NOT NULL REFERENCES bases (id) ON DELETE CASCADE,
  name         TEXT NOT NULL,
  icon         TEXT,
  kind         TEXT NOT NULL DEFAULT 'grid',        -- sheet | grid
  ordinal      TEXT NOT NULL,
  row_count    INTEGER NOT NULL DEFAULT 0,          -- DO 快照时回写，仅供列表展示
  snapshot_key TEXT,                                -- R2 对象键
  snapshot_seq INTEGER NOT NULL DEFAULT 0,          -- 快照覆盖到的 oplog seq
  created_by   TEXT NOT NULL REFERENCES users (id),
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL
);
CREATE INDEX idx_tables_base ON tables (base_id, ordinal);
CREATE INDEX idx_tables_workspace ON tables (workspace_id);

-- ─── 表级权限（覆盖工作区级角色）───────────────────────────────────────────
CREATE TABLE table_acl (
  table_id   TEXT NOT NULL REFERENCES tables (id) ON DELETE CASCADE,
  user_id    TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  role       TEXT NOT NULL,                         -- owner | editor | viewer
  created_at INTEGER NOT NULL,
  PRIMARY KEY (table_id, user_id)
);
CREATE INDEX idx_table_acl_user ON table_acl (user_id);

-- ─── 快照索引（正文在 R2）───────────────────────────────────────────────────
CREATE TABLE snapshots (
  table_id   TEXT NOT NULL REFERENCES tables (id) ON DELETE CASCADE,
  seq        INTEGER NOT NULL,
  r2_key     TEXT NOT NULL,
  byte_size  INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (table_id, seq)
);

-- ─── 审计日志 ───────────────────────────────────────────────────────────────
CREATE TABLE audit_log (
  id           TEXT PRIMARY KEY,
  workspace_id TEXT,
  actor_id     TEXT,
  actor_email  TEXT,
  action       TEXT NOT NULL,                       -- login / table.create / export …
  target_type  TEXT,
  target_id    TEXT,
  meta_json    TEXT,
  ip           TEXT,
  ts           INTEGER NOT NULL
);
CREATE INDEX idx_audit_ts ON audit_log (ts DESC);
CREATE INDEX idx_audit_actor ON audit_log (actor_id, ts DESC);
