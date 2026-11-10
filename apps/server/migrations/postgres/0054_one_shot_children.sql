ALTER TABLE session_schedules ADD COLUMN one_shot BIGINT NOT NULL DEFAULT 1 CHECK (one_shot IN (0, 1));
ALTER TABLE sessions ADD COLUMN one_shot BIGINT NOT NULL DEFAULT 0;
CREATE INDEX sessions_one_shot ON sessions (activity) WHERE one_shot = 1;
