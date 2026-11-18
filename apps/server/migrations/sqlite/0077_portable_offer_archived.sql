-- Whether a portable session is archived on the server it is attached to, as the host last reported it: 1 archived
-- there, 0 open there, NULL unknown (a connector from before this, or one whose server hasn't said yet). An archived
-- session isn't offered for Bring here (apps/server/src/portable-sessions.ts, docs/design/portable-sessions.md).
ALTER TABLE portable_offers ADD COLUMN archived INTEGER CHECK (archived IS NULL OR archived IN (0, 1));
