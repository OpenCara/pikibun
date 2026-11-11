-- Postgres translation of sqlite/0064_default_audit_context_extensions.sql.
-- Pikibun's prompt audit (piki:prompt-audit) and context files (piki:context-files), both built into the connector, for
-- every existing workspace, turned off, after the ones it has: its owners and admins turn on the ones they want. New
-- workspaces get the same ones when they are created (defaultWorkspaceExtensions in packages/shared/src/host-extensions.ts,
-- which lists the same sources). A workspace that already lists one keeps its own; one at the limit of 32 gets no more.
INSERT INTO workspace_extensions (workspace_id, package_key, source, position, enabled, tools_mode, settings_json, updated_by, updated_at)
  SELECT w.id, 'piki:prompt-audit', 'piki:prompt-audit', (SELECT COALESCE(MAX(e.position), 0) + 1 FROM workspace_extensions e WHERE e.workspace_id = w.id),
    0, 'automatic', '{}', w.owner_id, to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
  FROM workspaces w
  WHERE (SELECT COUNT(*) FROM workspace_extensions e WHERE e.workspace_id = w.id AND e.package_key NOT IN
    ('piki:schedule', 'piki:host-shell', 'piki:shell', 'piki:git', 'piki:node', 'piki:python', 'piki:rust', 'piki:go', 'piki:dotnet', 'piki:make',
     'piki:browser', 'piki:tunnel', 'piki:files', 'piki:github', 'piki:sources', 'piki:notion', 'piki:google-drive', 'piki:dropbox', 'piki:onedrive',
     'piki:feishu', 'piki:tencent-docs', 'piki:sessions')) < 32
  ON CONFLICT (workspace_id, package_key) DO NOTHING;
INSERT INTO workspace_extensions (workspace_id, package_key, source, position, enabled, tools_mode, settings_json, updated_by, updated_at)
  SELECT w.id, 'piki:context-files', 'piki:context-files', (SELECT COALESCE(MAX(e.position), 0) + 1 FROM workspace_extensions e WHERE e.workspace_id = w.id),
    0, 'automatic', '{}', w.owner_id, to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
  FROM workspaces w
  WHERE (SELECT COUNT(*) FROM workspace_extensions e WHERE e.workspace_id = w.id AND e.package_key NOT IN
    ('piki:schedule', 'piki:host-shell', 'piki:shell', 'piki:git', 'piki:node', 'piki:python', 'piki:rust', 'piki:go', 'piki:dotnet', 'piki:make',
     'piki:browser', 'piki:tunnel', 'piki:files', 'piki:github', 'piki:sources', 'piki:notion', 'piki:google-drive', 'piki:dropbox', 'piki:onedrive',
     'piki:feishu', 'piki:tencent-docs', 'piki:sessions')) < 32
  ON CONFLICT (workspace_id, package_key) DO NOTHING;
