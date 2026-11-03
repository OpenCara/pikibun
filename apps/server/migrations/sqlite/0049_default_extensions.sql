-- Popular Pi extensions for every existing workspace (docs/extensions.md), turned off and with tools on approval, after
-- the ones it has: its owners and admins turn on the ones they want. New workspaces get the same ones when they are
-- created (defaultWorkspaceExtensions in packages/shared/src/host-extensions.ts, which lists the same sources). A
-- workspace that already uses a package, any version of it, keeps its own; one at the limit of 32 gets no more.
INSERT INTO workspace_extensions (workspace_id, package_key, source, position, enabled, tools_mode, settings_json, updated_by, updated_at)
  SELECT w.id, 'npm:pi-web-access', 'npm:pi-web-access@0.46.0', (SELECT COALESCE(MAX(e.position), 0) + 1 FROM workspace_extensions e WHERE e.workspace_id = w.id),
    0, 'approval', '{}', w.owner_id, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  FROM workspaces w
  WHERE (SELECT COUNT(*) FROM workspace_extensions e WHERE e.workspace_id = w.id) < 32
  ON CONFLICT (workspace_id, package_key) DO NOTHING;
INSERT INTO workspace_extensions (workspace_id, package_key, source, position, enabled, tools_mode, settings_json, updated_by, updated_at)
  SELECT w.id, 'npm:pi-web-search', 'npm:pi-web-search@1.7.0', (SELECT COALESCE(MAX(e.position), 0) + 1 FROM workspace_extensions e WHERE e.workspace_id = w.id),
    0, 'approval', '{}', w.owner_id, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  FROM workspaces w
  WHERE (SELECT COUNT(*) FROM workspace_extensions e WHERE e.workspace_id = w.id) < 32
  ON CONFLICT (workspace_id, package_key) DO NOTHING;
INSERT INTO workspace_extensions (workspace_id, package_key, source, position, enabled, tools_mode, settings_json, updated_by, updated_at)
  SELECT w.id, 'npm:cc-safety-net', 'npm:cc-safety-net@2.7.2', (SELECT COALESCE(MAX(e.position), 0) + 1 FROM workspace_extensions e WHERE e.workspace_id = w.id),
    0, 'approval', '{}', w.owner_id, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  FROM workspaces w
  WHERE (SELECT COUNT(*) FROM workspace_extensions e WHERE e.workspace_id = w.id) < 32
  ON CONFLICT (workspace_id, package_key) DO NOTHING;
