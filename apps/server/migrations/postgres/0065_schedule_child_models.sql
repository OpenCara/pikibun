-- Postgres translation of sqlite/0072_schedule_child_models.sql.
-- The model (a workspace model id) and reasoning level each run of a schedule that runs in a new child session starts
-- on (scheduled-prompts.ts). Null, as for every existing schedule, is the scheduling session's current one, as before.
ALTER TABLE session_schedules ADD COLUMN model_id TEXT;
ALTER TABLE session_schedules ADD COLUMN thinking_level TEXT
  CHECK (thinking_level IS NULL OR thinking_level IN ('off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'));
