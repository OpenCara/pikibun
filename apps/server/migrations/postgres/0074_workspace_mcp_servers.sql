-- Postgres translation of sqlite/0081_workspace_mcp_servers.sql.

-- Workspace remote MCP servers (docs/design/extension-planes.md, phase 3, #438): the Pikibun server calls them with
-- credentials kept here, encrypted with VAULT_KEY (headers_ciphertext), and offers their tools to sessions as brokered tools.
-- tools_json holds the last tools/list answer, bounded and sanitized; read_only_tools_json the tool names a workspace owner
-- or admin marked safe for Read-only messages (a server's own readOnlyHint is never trusted).
CREATE TABLE workspace_mcp_servers (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  prefix TEXT NOT NULL,
  name TEXT NOT NULL,
  url TEXT NOT NULL,
  headers_ciphertext TEXT,
  header_names_json TEXT NOT NULL DEFAULT '[]',
  read_only_tools_json TEXT NOT NULL DEFAULT '[]',
  tools_json TEXT NOT NULL DEFAULT '[]',
  enabled BIGINT NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  discovered_at TEXT,
  error TEXT,
  created_by TEXT NOT NULL,
  updated_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (workspace_id, prefix)
);
