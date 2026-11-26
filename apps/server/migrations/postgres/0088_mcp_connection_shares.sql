-- Postgres translation of sqlite/0095_mcp_connection_shares.sql.

-- A member's personal remote MCP connection shared with a whole workspace (docs/design/connections.md, "Sharing a
-- connection with a whole workspace"): an owner or admin of the workspace shares their own connection, which adds a
-- server to the workspace whose calls, for every member's requests, use that connection, and only while the member who
-- shared it still belongs to the workspace. Its address and sign-in can't be changed in the workspace: they are the
-- connection's. Deleting the connection deletes the server; so does withdrawing the share.
ALTER TABLE workspace_mcp_servers ADD COLUMN shared_connection_id TEXT REFERENCES mcp_connections(id) ON DELETE CASCADE;
CREATE UNIQUE INDEX workspace_mcp_servers_shared_connection ON workspace_mcp_servers (workspace_id, shared_connection_id)
  WHERE shared_connection_id IS NOT NULL;
CREATE INDEX workspace_mcp_servers_connection ON workspace_mcp_servers (shared_connection_id) WHERE shared_connection_id IS NOT NULL;
