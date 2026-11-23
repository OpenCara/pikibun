-- Host build caches (docs/design/build-caches.md, #472). connector_configs.build_caches is the host owner's setting
-- (HostConfig.buildCaches: off, workspace or owner) and build_cache_gib its size limit; workspace_build_caches holds each
-- workspace's declared caches: a name, the environment variable commands get its path in, and the tool groups that
-- narrow who writes its shared copy (writer_groups_json, tool group ids; empty for the role rule alone).
ALTER TABLE connector_configs ADD COLUMN build_caches TEXT NOT NULL DEFAULT 'off' CHECK (build_caches IN ('off', 'workspace', 'owner'));
ALTER TABLE connector_configs ADD COLUMN build_cache_gib INTEGER NOT NULL DEFAULT 20 CHECK (build_cache_gib BETWEEN 1 AND 10000);

CREATE TABLE workspace_build_caches (
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  env TEXT NOT NULL,
  writer_groups_json TEXT NOT NULL DEFAULT '[]',
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_by TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (workspace_id, name),
  UNIQUE (workspace_id, env)
);
