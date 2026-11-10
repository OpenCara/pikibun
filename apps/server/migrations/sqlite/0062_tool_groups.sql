-- Tool groups (apps/server/src/tool-groups.ts, packages/shared/src/tool-groups.ts).
-- A session has the tools of its owner's role, unless a workspace owner or admin put the owner in one of the workspace's
-- own groups, with the tools it chose (tools_json: a list of Pikibun's session tools).
CREATE TABLE workspace_tool_groups (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  tools_json TEXT NOT NULL,
  created_by TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL,
  updated_by TEXT NOT NULL REFERENCES users(id),
  updated_at TEXT NOT NULL,
  UNIQUE (workspace_id, name)
);
-- The group of a member of the workspace; no row: their role's tools. Removing the member or the group removes it.
CREATE TABLE workspace_member_tool_groups (
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id),
  group_id TEXT NOT NULL REFERENCES workspace_tool_groups(id) ON DELETE CASCADE,
  assigned_by TEXT NOT NULL REFERENCES users(id),
  assigned_at TEXT NOT NULL,
  PRIMARY KEY (workspace_id, user_id)
);
CREATE INDEX workspace_member_tool_groups_group ON workspace_member_tool_groups (group_id);
