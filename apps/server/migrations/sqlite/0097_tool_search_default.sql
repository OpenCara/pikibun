-- Tool search (Pi's built-in pi:tool-search, HostConfig.builtinExtensions in packages/shared/src/host-config.ts) is on
-- by default: a host with no connector_configs row gets newHostBuiltinExtensions, and the route writes every column of
-- a new row from that, so builtin_extensions_json's column default of '[]' is never what a host runs with. This turns it
-- on for the hosts configured before, which their owners and admins can still turn off.
UPDATE connector_configs
SET builtin_extensions_json = json_insert(builtin_extensions_json, '$[#]', 'pi:tool-search')
WHERE json_valid(builtin_extensions_json) AND json_type(builtin_extensions_json) = 'array'
  AND NOT EXISTS (SELECT 1 FROM json_each(connector_configs.builtin_extensions_json) WHERE value IN ('pi:tool-search', 'tool-search'));
