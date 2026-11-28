-- Postgres translation of sqlite/0103_workspace_hidden.sql.

-- The workspaces each member hid from their sidebar (PUT /api/workspaces/:id/hidden, catalog.ts). A row hides one workspace
-- for one user only: it stays in their settings, their new session's workspace choice and their search. The private
-- workspace is never hidden.
CREATE TABLE workspace_hidden (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  PRIMARY KEY (user_id, workspace_id)
);
