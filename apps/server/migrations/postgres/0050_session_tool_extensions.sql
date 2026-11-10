-- Postgres translation of sqlite/0057_session_tool_extensions.sql.
-- Pikibun's session-tool extensions (piki:git, piki:node, ...; packages/shared/src/piki-extensions.ts) were on in every
-- workspace that didn't list them turned off. From now on a workspace has one only once it is added: with its first
-- repository (piki:git, and piki:github for GitHub), its first document source of a kind (piki:notion, ...), or by its
-- owners and admins under Extensions; the control plane lists the others turned off (withSessionToolsListed in
-- packages/shared/src/host-extensions.ts). Existing workspaces keep the tools they had: each gets, turned on and as its
-- owner, the ones it doesn't list, but piki:github only with a GitHub repository and a kind of document source only with
-- a source of that kind (neither offers anything without one), and a kind not where the workspace turned piki:sources,
-- which they replace, off. piki:tunnel was off unless listed, and piki:files is always on. Session-tool extensions take
-- none of a workspace's 32 places.
WITH tools(source, n) AS (VALUES ('piki:schedule', 1), ('piki:host-shell', 2), ('piki:shell', 3), ('piki:git', 4), ('piki:node', 5),
  ('piki:python', 6), ('piki:rust', 7), ('piki:go', 8), ('piki:dotnet', 9), ('piki:make', 10), ('piki:browser', 11), ('piki:sessions', 12))
INSERT INTO workspace_extensions (workspace_id, package_key, source, position, enabled, tools_mode, settings_json, updated_by, updated_at)
  SELECT w.id, t.source, t.source, (SELECT COALESCE(MAX(e.position), 0) FROM workspace_extensions e WHERE e.workspace_id = w.id) + t.n,
    1, 'approval', '{}', w.owner_id, to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
  FROM workspaces w CROSS JOIN tools t
  WHERE NOT EXISTS (SELECT 1 FROM workspace_extensions e WHERE e.workspace_id = w.id AND e.package_key = t.source)
  ON CONFLICT (workspace_id, package_key) DO NOTHING;
INSERT INTO workspace_extensions (workspace_id, package_key, source, position, enabled, tools_mode, settings_json, updated_by, updated_at)
  SELECT w.id, 'piki:github', 'piki:github', (SELECT COALESCE(MAX(e.position), 0) + 1 FROM workspace_extensions e WHERE e.workspace_id = w.id),
    1, 'approval', '{}', w.owner_id, to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
  FROM workspaces w
  WHERE EXISTS (SELECT 1 FROM workspace_repositories r WHERE r.workspace_id = w.id AND r.provider = 'github')
    AND NOT EXISTS (SELECT 1 FROM workspace_extensions e WHERE e.workspace_id = w.id AND e.package_key = 'piki:github')
  ON CONFLICT (workspace_id, package_key) DO NOTHING;
WITH kinds(kind, n) AS (VALUES ('notion', 1), ('google-drive', 2), ('dropbox', 3), ('onedrive', 4), ('feishu', 5), ('tencent-docs', 6))
INSERT INTO workspace_extensions (workspace_id, package_key, source, position, enabled, tools_mode, settings_json, updated_by, updated_at)
  SELECT w.id, 'piki:' || k.kind, 'piki:' || k.kind, (SELECT COALESCE(MAX(e.position), 0) FROM workspace_extensions e WHERE e.workspace_id = w.id) + k.n,
    1, 'approval', '{}', w.owner_id, to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
  FROM workspaces w CROSS JOIN kinds k
  WHERE EXISTS (SELECT 1 FROM document_sources d WHERE d.workspace_id = w.id AND d.kind = k.kind)
    AND NOT EXISTS (SELECT 1 FROM workspace_extensions e WHERE e.workspace_id = w.id AND e.package_key = 'piki:' || k.kind)
    AND NOT EXISTS (SELECT 1 FROM workspace_extensions e WHERE e.workspace_id = w.id AND e.package_key = 'piki:sources' AND e.enabled = 0)
  ON CONFLICT (workspace_id, package_key) DO NOTHING;
