-- Personal remote MCP connections (docs/design/connections.md): a member signs in to a remote MCP server once, in their
-- profile, with any of the sign-ins a workspace's server takes (OAuth, a token, a username and password, a custom
-- header), and brings that connection to the workspaces they choose. One per member and address. headers_ciphertext
-- (context mcp-connection:<id>) and oauth_ciphertext (context mcp-connection-oauth:<id>) are encrypted with VAULT_KEY,
-- never shown, audited or sent to any address but url.
CREATE TABLE mcp_connections (
  id TEXT PRIMARY KEY NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 64),
  url TEXT NOT NULL CHECK (length(url) BETWEEN 1 AND 2048),
  headers_ciphertext TEXT,
  header_names_json TEXT NOT NULL DEFAULT '[]',
  oauth_ciphertext TEXT,
  oauth_at TEXT,
  error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (user_id, url)
);

-- The workspaces a member brought a connection to. Only there, and only while they are still a member, do that
-- workspace's servers at the connection's address use it, and only as its servers' sign_in_as allows.
CREATE TABLE mcp_connection_workspaces (
  connection_id TEXT NOT NULL REFERENCES mcp_connections(id) ON DELETE CASCADE,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  PRIMARY KEY (connection_id, workspace_id)
);
CREATE INDEX mcp_connection_workspaces_workspace ON mcp_connection_workspaces (workspace_id);

-- Whose sign-in a workspace's server calls with: 'workspace' its own (headers or the OAuth sign-in an owner or admin
-- made, as before), 'members' the requester's own connection only, 'members-then-workspace' the requester's own
-- connection where they brought one, else the workspace's.
ALTER TABLE workspace_mcp_servers ADD COLUMN sign_in_as TEXT NOT NULL DEFAULT 'workspace'
  CHECK (sign_in_as IN ('workspace', 'members', 'members-then-workspace'));

-- An OAuth sign-in to a personal connection under way, from the web (app = 0: state_hash, verifier and client until the
-- callback) or from an app (app = 1: begin_hash, then the same, then finish_hash and secret_ciphertext, as in
-- mcp_oauth_app_sign_ins). It uses the same callbacks as a workspace server's sign-in, so the same OAuth clients.
CREATE TABLE mcp_connection_sign_ins (
  id TEXT PRIMARY KEY NOT NULL,
  connection_id TEXT NOT NULL REFERENCES mcp_connections(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  url TEXT NOT NULL,
  app INTEGER NOT NULL CHECK (app IN (0, 1)),
  begin_hash TEXT UNIQUE,
  state_hash TEXT UNIQUE,
  verifier TEXT,
  client_ciphertext TEXT,
  finish_hash TEXT UNIQUE,
  secret_ciphertext TEXT,
  expires_at INTEGER NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX mcp_connection_sign_ins_user ON mcp_connection_sign_ins (user_id);
