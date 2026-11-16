-- Postgres translation of sqlite/0071_session_activity_ended.sql.
-- When the session's host last reported its agent stopped working (activity idle, done or failed), so a message's write
-- admission is renewed past its hour only while the run that began after it goes on, not for a later side ask
-- (docs/design/security-rationale.md, apps/server/src/authority/run-admissions.ts). Sessions at rest now count from now.
ALTER TABLE sessions ADD COLUMN activity_ended_at TEXT;
UPDATE sessions SET activity_ended_at = to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
  WHERE activity IS NOT NULL AND activity NOT IN ('working', 'waiting');
