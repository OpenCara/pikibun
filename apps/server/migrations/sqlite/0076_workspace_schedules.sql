-- Scheduled prompts move from sessions to workspaces (scheduled-prompts.ts, docs/design/workspace-schedules.md).
-- A schedule belongs to a workspace and runs as its owner. One with a session_id wakes that session, as every
-- schedule did before; one without starts a new session for each run. origin_session_id is the session such a
-- schedule was made from (by its agent, or in its panel), whose runs start under it and fall back on its model. Every
-- schedule that ran in a new child session becomes one.
CREATE TABLE schedules (
  id TEXT PRIMARY KEY NOT NULL,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  -- The session each run wakes; null for a schedule that starts a new session each run.
  session_id TEXT REFERENCES sessions(id) ON DELETE CASCADE,
  -- For one that starts a new session each run: the session it was made from, if any.
  origin_session_id TEXT REFERENCES sessions(id) ON DELETE SET NULL,
  -- Whom each run acts as. Its creator, until someone else (a workspace owner or admin) edits it and takes it over.
  owner_id TEXT NOT NULL REFERENCES users(id),
  created_by TEXT NOT NULL REFERENCES users(id),
  name TEXT NOT NULL,
  cron TEXT NOT NULL,
  time_zone TEXT NOT NULL,
  content TEXT NOT NULL,
  access TEXT NOT NULL DEFAULT 'approval' CHECK (access IN ('read', 'approval', 'auto')),
  one_shot INTEGER NOT NULL DEFAULT 1 CHECK (one_shot IN (0, 1)),
  -- The model and reasoning level each new session starts on; null model: the origin session's current one.
  model_id TEXT,
  thinking_level TEXT CHECK (thinking_level IS NULL OR thinking_level IN ('off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max')),
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  next_run_at TEXT,
  last_run_at TEXT,
  last_submission_id TEXT,
  last_session_id TEXT,
  last_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (session_id IS NULL OR (origin_session_id IS NULL AND model_id IS NULL AND thinking_level IS NULL))
);

INSERT INTO schedules (id, workspace_id, session_id, origin_session_id, owner_id, created_by, name, cron, time_zone, content, access, one_shot,
    model_id, thinking_level, enabled, next_run_at, last_run_at, last_submission_id, last_session_id, last_error, created_at, updated_at)
  SELECT p.id, s.workspace_id,
    CASE WHEN p.run_in = 'child' THEN NULL ELSE p.session_id END,
    CASE WHEN p.run_in = 'child' THEN p.session_id ELSE NULL END,
    s.owner_id, p.created_by, p.name, p.cron, p.time_zone, p.content, p.access, p.one_shot,
    CASE WHEN p.run_in = 'child' THEN p.model_id ELSE NULL END,
    CASE WHEN p.run_in = 'child' THEN p.thinking_level ELSE NULL END,
    -- One whose session was archived ran nothing; as a workspace schedule it would, so it stays paused.
    CASE WHEN p.run_in = 'child' AND s.status <> 'ready' THEN 0 ELSE p.enabled END,
    CASE WHEN p.run_in = 'child' AND s.status <> 'ready' THEN NULL ELSE p.next_run_at END,
    p.last_run_at, p.last_submission_id, p.last_session_id, p.last_error, p.created_at, p.updated_at
  FROM session_schedules p JOIN sessions s ON s.id = p.session_id;

DROP TABLE session_schedules;

CREATE INDEX schedules_session ON schedules (session_id);
CREATE INDEX schedules_origin ON schedules (origin_session_id);
CREATE INDEX schedules_workspace ON schedules (workspace_id, owner_id);
CREATE INDEX schedules_due ON schedules (next_run_at) WHERE enabled = 1;

-- Only the schedules that wake a session show it as scheduled.
UPDATE sessions SET next_scheduled_at = (SELECT MIN(next_run_at) FROM schedules
    WHERE schedules.session_id = sessions.id AND enabled = 1 AND next_run_at IS NOT NULL)
  WHERE next_scheduled_at IS NOT NULL;
