-- Postgres translation of sqlite/0099_owner_forge_access.sql.

-- Whether the host owner's own sessions on the host reach the forges with the owner's Pikibun account (docs/design/host-forge-access.md).
-- connector_configs.owner_forge_access is HostConfig.ownerForgeAccess, off by default: their Git and gh keep the host's own credentials.
-- Members' sessions on someone else's host always use their own account, whatever this says.
ALTER TABLE connector_configs ADD COLUMN owner_forge_access INTEGER NOT NULL DEFAULT 0;
