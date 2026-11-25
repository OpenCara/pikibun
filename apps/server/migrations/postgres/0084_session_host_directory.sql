-- Postgres translation of sqlite/0091_session_host_directory.sql.
-- The working directory of the host a session that runs directly on it (host_environment = 1) works in, as its owner chose
-- it when starting the session (POST /api/sessions with hostDirectory): an absolute path on the host, or one under its user's
-- home (~/...). NULL for every other session, which works in its own private worktree. It never changes once set: the host
-- keeps it in the session's binding.
ALTER TABLE sessions ADD COLUMN host_directory TEXT;
