-- The tools of a remote MCP server its workspace's owners and admins turned off: sessions don't get them and Pikibun
-- refuses to call them. Every tool a server lists is on until someone turns it off, tools it lists later included.
ALTER TABLE workspace_mcp_servers ADD COLUMN off_tools_json TEXT NOT NULL DEFAULT '[]';
