-- When the session's host last reported its agent stopped working (activity idle, done or failed), so a message's write
-- admission is renewed past its hour only while the run that began after it goes on, not for a later side ask
-- (docs/design/security-rationale.md, apps/server/src/authority/run-admissions.ts). Sessions at rest now count from now.
ALTER TABLE sessions ADD COLUMN activity_ended_at TEXT;
UPDATE sessions SET activity_ended_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  WHERE activity IS NOT NULL AND activity NOT IN ('working', 'waiting');
