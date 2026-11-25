-- Postgres translation of sqlite/0090_mcp_oauth_app.sql.

-- Remote MCP OAuth sign-ins started from a native app (docs/design/extension-planes.md, "Remote MCP OAuth from the app").
-- The app signs in with a bearer token the system browser doesn't have, so the browser can't prove who it is: the app
-- asks for a one-time link (begin_hash), the browser follows it through the authorization server, and the callback keeps
-- the tokens it got (secret_ciphertext, VAULT_KEY context remote-mcp-oauth-app:<id>) under a one-time code (finish_hash)
-- it shows the browser. Only the app of the member who asked, given that code, keeps the sign-in for the server: a link
-- passed to someone else ends with a code only their own app holds, which isn't theirs to finish.
-- state_hash, verifier and client_ciphertext are the flow under way, as in mcp_oauth_states; a row lives 10 minutes
-- from its link, then 10 more from its callback.
CREATE TABLE mcp_oauth_app_sign_ins (
  id TEXT PRIMARY KEY NOT NULL,
  server_id TEXT NOT NULL REFERENCES workspace_mcp_servers(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  url TEXT NOT NULL,
  begin_hash TEXT UNIQUE,
  state_hash TEXT UNIQUE,
  verifier TEXT,
  client_ciphertext TEXT,
  finish_hash TEXT UNIQUE,
  secret_ciphertext TEXT,
  expires_at BIGINT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX mcp_oauth_app_sign_ins_user ON mcp_oauth_app_sign_ins (user_id);
