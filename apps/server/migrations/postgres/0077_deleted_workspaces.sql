-- Postgres translation of sqlite/0084_deleted_workspaces.sql.

-- Soft-deleted workspaces (apps/server/src/authority/deleted-workspaces.ts, docs/workspaces.md#deleting-a-workspace).
-- Deleting a workspace moves its memberships here, out of workspace_members, which every access decision joins: no one
-- sees or reaches the workspace, its sessions, hosts or schedules any more, while everything in it is kept. Restoring
-- moves the memberships back. Deleting the workspace for good (only possible with no sessions) cascades these rows.
CREATE TABLE deleted_workspaces (
  workspace_id TEXT PRIMARY KEY NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  deleted_by TEXT NOT NULL REFERENCES users(id),
  deleted_at TEXT NOT NULL
);

CREATE TABLE deleted_workspace_members (
  workspace_id TEXT NOT NULL REFERENCES deleted_workspaces(workspace_id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id),
  role TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (workspace_id, user_id)
);
