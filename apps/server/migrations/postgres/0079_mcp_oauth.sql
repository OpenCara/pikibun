-- Postgres translation of sqlite/0086_mcp_oauth.sql.

-- OAuth sign-ins for workspace remote MCP servers (docs/design/extension-planes.md, "Remote MCP OAuth"): an owner or admin
-- signs in to a server that asks for it (MCP authorization: protected resource metadata, authorization server metadata,
-- dynamic client registration, PKCE). oauth_ciphertext holds the registered client and its tokens, encrypted with
-- VAULT_KEY (context remote-mcp-oauth:<id>); oauth_by and oauth_at say who signed in and when.
ALTER TABLE workspace_mcp_servers ADD COLUMN oauth_ciphertext TEXT;
ALTER TABLE workspace_mcp_servers ADD COLUMN oauth_by TEXT;
ALTER TABLE workspace_mcp_servers ADD COLUMN oauth_at TEXT;

-- A sign-in under way: the state Pikibun sent, its PKCE verifier and the client registered for it (encrypted), for one
-- member, server and address, until the authorization server redirects back (at most 10 minutes). The browser carries the
-- state in a cookie too.
CREATE TABLE mcp_oauth_states (
  state_hash TEXT PRIMARY KEY NOT NULL,
  server_id TEXT NOT NULL REFERENCES workspace_mcp_servers(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  url TEXT NOT NULL,
  verifier TEXT NOT NULL,
  client_ciphertext TEXT NOT NULL,
  expires_at BIGINT NOT NULL,
  created_at TEXT NOT NULL
);
