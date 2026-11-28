-- Postgres translation of sqlite/0102_workspace_order.sql.

-- Each member's own order of their workspaces in the sidebar (PUT /api/workspaces/order, catalog.ts). A row places one
-- workspace for one user; workspaces without one follow those with one, oldest first. The private workspace is always
-- first and never has a row.
CREATE TABLE workspace_order (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  position INTEGER NOT NULL,
  PRIMARY KEY (user_id, workspace_id)
);
