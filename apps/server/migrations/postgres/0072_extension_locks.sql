-- Postgres translation of sqlite/0079_extension_locks.sql.

-- Extension locks, Pikibun-server registry metadata, and opt-in sandboxed auto-caching (docs/design/extension-planes.md, #438).
-- integrity locks the sha512-... tarball digest of an npm:<package>@<version> workspace extension once resolved or supplied.
ALTER TABLE workspace_extensions ADD COLUMN integrity TEXT;

-- Package metadata (name, version, description) fetched and verified against dist.integrity by the Pikibun server itself
-- from https://registry.npmjs.org; connector-reported modules stay scoped to connector_extensions.
CREATE TABLE extension_descriptions (
  source TEXT NOT NULL,
  integrity TEXT NOT NULL,
  metadata_json TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (source, integrity)
);

-- Host owner opt-in to auto-caching locked npm: workspace extensions for sandboxed sessions on this host (0 = off by default in phase 1).
ALTER TABLE connector_extension_settings ADD COLUMN auto_cache BIGINT NOT NULL DEFAULT 0 CHECK (auto_cache IN (0, 1));
