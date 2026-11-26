-- Postgres translation of sqlite/0097_tool_search_default.sql.

-- Tool search (Pi's built-in pi:tool-search, HostConfig.builtinExtensions in packages/shared/src/host-config.ts) is on
-- by default: a host with no connector_configs row gets it from defaultHostConfig, and the route writes every column of
-- a new row from that, so builtin_extensions_json's column default of '[]' is never what a host runs with. This turns it
-- on for the hosts configured before, which their owners and admins can still turn off.
UPDATE connector_configs
SET builtin_extensions_json = (builtin_extensions_json::jsonb || '["pi:tool-search"]'::jsonb)::text
WHERE builtin_extensions_json LIKE '[%'
  AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements_text(connector_configs.builtin_extensions_json::jsonb) AS item(name) WHERE item.name IN ('pi:tool-search', 'tool-search'));
