-- How many of the tools a remote MCP server last listed Pikibun left out (issue #530): tools_over_limit those past the
-- tools it offers from one server, tools_unusable those whose names or input schemas it can't offer. Shown to the
-- workspace's members rather than dropped silently.
ALTER TABLE workspace_mcp_servers ADD COLUMN tools_over_limit INTEGER NOT NULL DEFAULT 0;
ALTER TABLE workspace_mcp_servers ADD COLUMN tools_unusable INTEGER NOT NULL DEFAULT 0;
