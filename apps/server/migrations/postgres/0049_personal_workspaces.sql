-- Postgres translation of sqlite/0056_personal_workspaces.sql.
-- Private workspaces (authority/personal-workspaces.ts). Every user has one workspace of their own, created the first
-- time they list their workspaces, which nobody else can join: it takes no members and has no invite link. Its sessions
-- need no source, so an agent can run there privately before any workspace is set up. The row marks the workspace as
-- its owner's private one; it lasts as long as the workspace, and a user has at most one.
CREATE TABLE personal_workspaces (
  user_id TEXT PRIMARY KEY NOT NULL REFERENCES users(id),
  workspace_id TEXT NOT NULL UNIQUE REFERENCES workspaces(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL
);
