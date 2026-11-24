-- Postgres translation of sqlite/0085_command_time_limit.sql.

-- The command time limit of a host (HostConfig in packages/shared/src/host-config.ts, docs/hosts.md) now starts at an
-- hour, its longest, where it started at 30 seconds, its shortest: a first install or build rarely fits in 30 seconds.
-- A host without a row follows the new default. A row holds every setting, written whenever any of them is saved, so a
-- 30 there is the old default far more often than a choice: those become an hour too. command_timeout_unlimited 1 is
-- the new No limit: commands on the host then run until they end or are stopped, and command_timeout_seconds keeps the
-- limit that connectors from before it apply.
ALTER TABLE connector_configs ADD COLUMN command_timeout_unlimited BIGINT NOT NULL DEFAULT 0 CHECK (command_timeout_unlimited IN (0, 1));
UPDATE connector_configs SET command_timeout_seconds = 3600 WHERE command_timeout_seconds = 30;
