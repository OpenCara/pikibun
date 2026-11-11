-- Postgres translation of sqlite/0064_automatic_packing.sql.

-- Archived sessions' files are packed on their hosts automatically (apps/server/src/automatic-packing.ts), as their owners
-- would with Pack files. pack_due_at: when the server next asks the session's host to pack them. Set a week after a
-- session is archived, and later again while its host is offline, busy or not yet able to; NULL once its files are packed,
-- its host refused to pack them, it was unarchived, or it isn't archived.
ALTER TABLE sessions ADD COLUMN pack_due_at TEXT;
CREATE INDEX sessions_pack_due ON sessions (pack_due_at) WHERE pack_due_at IS NOT NULL;
-- Sessions archived before now: their week starts now.
UPDATE sessions SET pack_due_at = to_char(now() AT TIME ZONE 'UTC' + interval '7 days', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') WHERE status = 'archived' AND packed_at IS NULL;
-- A workspace's packing settings, as its owners and admins chose them; no row: the defaults (automatic packing on).
-- automatic 0: its archived sessions are packed only when their owners pack them.
CREATE TABLE workspace_packing_settings (
  workspace_id TEXT PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
  automatic BIGINT NOT NULL DEFAULT 1 CHECK (automatic IN (0, 1)),
  updated_by TEXT NOT NULL REFERENCES users(id),
  updated_at TEXT NOT NULL
);
