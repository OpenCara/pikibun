-- Postgres translation of sqlite/0048_piki_extensions.sql.

-- Pikibun extensions (docs/design/piki-extensions.md, apps/server/src/extensions.ts).
-- piki:<name> sources come with the connector; their package_key is the source itself. A workspace that binds its
-- first repository on GitHub (github.com or Enterprise Server), GitLab or Azure DevOps gets the extension of that forge's
-- command-line tool (gh, glab, az): its tools wait for approval, and owners and admins turn it off or remove it like any
-- other. Workspaces that already have such a repository get it here, as their owner, unless they use 32 extensions.
INSERT INTO workspace_extensions (workspace_id, package_key, source, position, enabled, tools_mode, settings_json, updated_by, updated_at)
SELECT w.id, 'piki:gh', 'piki:gh', COALESCE((SELECT MAX(e.position) FROM workspace_extensions e WHERE e.workspace_id = w.id), 0) + 1, 1, 'approval', '{}', w.owner_id,
  to_char(clock_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
FROM workspaces w
WHERE EXISTS (SELECT 1 FROM workspace_repositories r WHERE r.workspace_id = w.id AND r.provider IN ('github', 'github-enterprise'))
  AND NOT EXISTS (SELECT 1 FROM workspace_extensions e WHERE e.workspace_id = w.id AND e.package_key = 'piki:gh')
  AND (SELECT COUNT(*) FROM workspace_extensions e WHERE e.workspace_id = w.id) < 32;
INSERT INTO workspace_extensions (workspace_id, package_key, source, position, enabled, tools_mode, settings_json, updated_by, updated_at)
SELECT w.id, 'piki:glab', 'piki:glab', COALESCE((SELECT MAX(e.position) FROM workspace_extensions e WHERE e.workspace_id = w.id), 0) + 1, 1, 'approval', '{}', w.owner_id,
  to_char(clock_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
FROM workspaces w
WHERE EXISTS (SELECT 1 FROM workspace_repositories r WHERE r.workspace_id = w.id AND r.provider IN ('gitlab'))
  AND NOT EXISTS (SELECT 1 FROM workspace_extensions e WHERE e.workspace_id = w.id AND e.package_key = 'piki:glab')
  AND (SELECT COUNT(*) FROM workspace_extensions e WHERE e.workspace_id = w.id) < 32;
INSERT INTO workspace_extensions (workspace_id, package_key, source, position, enabled, tools_mode, settings_json, updated_by, updated_at)
SELECT w.id, 'piki:azure-cli', 'piki:azure-cli', COALESCE((SELECT MAX(e.position) FROM workspace_extensions e WHERE e.workspace_id = w.id), 0) + 1, 1, 'approval', '{}', w.owner_id,
  to_char(clock_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
FROM workspaces w
WHERE EXISTS (SELECT 1 FROM workspace_repositories r WHERE r.workspace_id = w.id AND r.provider IN ('azure-devops'))
  AND NOT EXISTS (SELECT 1 FROM workspace_extensions e WHERE e.workspace_id = w.id AND e.package_key = 'piki:azure-cli')
  AND (SELECT COUNT(*) FROM workspace_extensions e WHERE e.workspace_id = w.id) < 32;
-- Pi's built-in extensions a host's configuration turns on are named pi:<name> (packages/shared/src/host-config.ts),
-- beside Pikibun's own piki:<name>; configurations saved before named them bare. Reads accept those too.
UPDATE connector_configs SET builtin_extensions_json = REPLACE(builtin_extensions_json, '"codemode"', '"pi:codemode"')
  WHERE builtin_extensions_json LIKE '%"codemode"%';
