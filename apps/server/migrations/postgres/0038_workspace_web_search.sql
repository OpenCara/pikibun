-- Postgres translation of sqlite/0045_workspace_web_search.sql.

-- A workspace's own web search provider (apps/server/src/web-search.ts), as its owners and admins chose it, with their API
-- key, vault-encrypted for that workspace alone (`workspace-web-search:<workspace id>`). No row: the provider the server's
-- operator configured (WEB_SEARCH), if any. Whether agents search at all stays workspace_network_policies.web_search.
CREATE TABLE workspace_web_search (
  workspace_id TEXT PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
  provider TEXT NOT NULL CHECK (provider IN ('brave', 'tavily', 'exa', 'serper')),
  key_ciphertext TEXT NOT NULL CHECK (length(key_ciphertext) <= 22000),
  updated_by TEXT NOT NULL REFERENCES users(id),
  updated_at TEXT NOT NULL
);
