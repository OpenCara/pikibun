-- Postgres translation of sqlite/0043_session_packing.sql.

-- When the session's owner packed its files on its host (apps/runner/src/pack.ts): set from just before the host is asked
-- until unarchiving has unpacked them, so a pack whose outcome is unclear is unpacked all the same. Only archived sessions
-- are packed. NULL: its files are as the session left them.
ALTER TABLE sessions ADD COLUMN packed_at TEXT;
