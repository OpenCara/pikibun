-- Postgres translation of sqlite/0057_scheduled_child_sessions.sql.

-- Scheduled prompts that run in a new child session (scheduled-prompts.ts; SessionSchedule.runIn): 'session' sends each
-- run to the session's own agent, as before; 'child' starts a new session under it for each run, whose opening message
-- the run's message is.
ALTER TABLE session_schedules ADD COLUMN run_in TEXT NOT NULL DEFAULT 'session' CHECK (run_in IN ('session', 'child'));
-- The child session its last run started (run_in 'child'); null otherwise.
ALTER TABLE session_schedules ADD COLUMN last_session_id TEXT;
-- The schedule that started this session, as a child of parent_session_id; null for every other session. It keeps the
-- schedule's children out of the sessions tool's count of the sessions an agent started, and counts them on their own.
ALTER TABLE sessions ADD COLUMN schedule_id TEXT;
