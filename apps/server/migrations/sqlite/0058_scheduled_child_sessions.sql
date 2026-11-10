ALTER TABLE session_schedules ADD COLUMN run_in TEXT NOT NULL DEFAULT 'session' CHECK (run_in IN ('session', 'child'));
ALTER TABLE session_schedules ADD COLUMN last_session_id TEXT;
ALTER TABLE sessions ADD COLUMN schedule_id TEXT;
