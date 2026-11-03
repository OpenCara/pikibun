-- Postgres translation of sqlite/0047_host_builtin_extensions.sql.

-- Pi's built-in extensions every session on a host runs with, as its owner and admins set it in Pikibun
-- (HostConfig.builtinExtensions in packages/shared/src/host-config.ts): their names, as a JSON array. '[]' runs none.
ALTER TABLE connector_configs ADD COLUMN builtin_extensions_json TEXT NOT NULL DEFAULT '[]';
