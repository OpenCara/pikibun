-- The extensions a host's owner requires of every session on it, whatever its workspace chose (HostConfig.requiredExtensions
-- in packages/shared/src/host-config.ts): each one's source and settings, as JSON, in the order sessions run them.
-- '[]' requires none.
ALTER TABLE connector_configs ADD COLUMN required_extensions_json TEXT NOT NULL DEFAULT '[]';
