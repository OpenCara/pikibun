-- Sessions started by an agent (apps/server/src/cross-session.ts, docs/design/cross-session.md).
-- A workspace's settings for them, as its owners and admins chose them; no row: the defaults (on).
-- child_models 1: an agent that starts a session for a sub-task may choose the model and reasoning level it runs on.
-- 0: every such session runs on its parent's current model and reasoning level.
CREATE TABLE workspace_child_session_settings (
  workspace_id TEXT PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
  child_models INTEGER NOT NULL DEFAULT 1 CHECK (child_models IN (0, 1)),
  updated_by TEXT NOT NULL REFERENCES users(id),
  updated_at TEXT NOT NULL
);
