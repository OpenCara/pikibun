-- Built-in extensions (docs/design/builtin-extensions.md, apps/server/src/extensions.ts).
-- builtin:<name> sources come with the connector; their package_key is the source itself. A workspace that binds its
-- first repository on GitHub (github.com or Enterprise Server), GitLab or Azure DevOps gets the extension of that forge's
-- command-line tool (gh, glab, az): its tools wait for approval, and owners and admins turn it off or remove it like any
-- other. Workspaces that already have such a repository get it here, as their owner, unless they use 32 extensions.
INSERT INTO workspace_extensions (workspace_id, package_key, source, position, enabled, tools_mode, settings_json, updated_by, updated_at)
SELECT w.id, 'builtin:gh', 'builtin:gh', COALESCE((SELECT MAX(e.position) FROM workspace_extensions e WHERE e.workspace_id = w.id), 0) + 1, 1, 'approval', '{}', w.owner_id,
  strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
FROM workspaces w
WHERE EXISTS (SELECT 1 FROM workspace_repositories r WHERE r.workspace_id = w.id AND r.provider IN ('github', 'github-enterprise'))
  AND NOT EXISTS (SELECT 1 FROM workspace_extensions e WHERE e.workspace_id = w.id AND e.package_key = 'builtin:gh')
  AND (SELECT COUNT(*) FROM workspace_extensions e WHERE e.workspace_id = w.id) < 32;
INSERT INTO workspace_extensions (workspace_id, package_key, source, position, enabled, tools_mode, settings_json, updated_by, updated_at)
SELECT w.id, 'builtin:glab', 'builtin:glab', COALESCE((SELECT MAX(e.position) FROM workspace_extensions e WHERE e.workspace_id = w.id), 0) + 1, 1, 'approval', '{}', w.owner_id,
  strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
FROM workspaces w
WHERE EXISTS (SELECT 1 FROM workspace_repositories r WHERE r.workspace_id = w.id AND r.provider IN ('gitlab'))
  AND NOT EXISTS (SELECT 1 FROM workspace_extensions e WHERE e.workspace_id = w.id AND e.package_key = 'builtin:glab')
  AND (SELECT COUNT(*) FROM workspace_extensions e WHERE e.workspace_id = w.id) < 32;
INSERT INTO workspace_extensions (workspace_id, package_key, source, position, enabled, tools_mode, settings_json, updated_by, updated_at)
SELECT w.id, 'builtin:azure-cli', 'builtin:azure-cli', COALESCE((SELECT MAX(e.position) FROM workspace_extensions e WHERE e.workspace_id = w.id), 0) + 1, 1, 'approval', '{}', w.owner_id,
  strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
FROM workspaces w
WHERE EXISTS (SELECT 1 FROM workspace_repositories r WHERE r.workspace_id = w.id AND r.provider IN ('azure-devops'))
  AND NOT EXISTS (SELECT 1 FROM workspace_extensions e WHERE e.workspace_id = w.id AND e.package_key = 'builtin:azure-cli')
  AND (SELECT COUNT(*) FROM workspace_extensions e WHERE e.workspace_id = w.id) < 32;
