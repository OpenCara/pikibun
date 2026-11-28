-- Postgres translation of sqlite/0101_mcp_share_requests.sql.

-- Any member shares their own remote MCP connection with a workspace (docs/design/connections.md, "Sharing a connection
-- with a whole workspace"): an owner's or admin's share takes effect at once, as before; any other member's waits as
-- share_status = 'pending' until an owner or admin of the workspace accepts it. A pending server offers no tools and
-- runs nothing. accepted_by and accepted_at say who accepted it and when: such a share then serves while its member
-- still belongs to the workspace by the membership they had when it was accepted (workspace_members.created_at no later
-- than accepted_at), whatever their role. A share an owner or admin made themselves (accepted_by is the sharer, or NULL
-- for shares made before this) serves, as before, only while they still own or administer the workspace.
ALTER TABLE workspace_mcp_servers ADD COLUMN share_status TEXT NOT NULL DEFAULT 'accepted'
  CHECK (share_status IN ('pending', 'accepted'));
ALTER TABLE workspace_mcp_servers ADD COLUMN accepted_by TEXT;
ALTER TABLE workspace_mcp_servers ADD COLUMN accepted_at TEXT;
