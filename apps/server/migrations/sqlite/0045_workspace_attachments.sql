-- Files attached to messages (apps/server/src/file-uploads.ts).
-- A workspace's attachment settings, as its owners and admins chose them; no row: the defaults (10 MiB a file).
-- max_file_bytes: the largest file a message here may carry, uploaded into the session's worktree.
CREATE TABLE workspace_attachment_settings (
  workspace_id TEXT PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
  max_file_bytes INTEGER NOT NULL CHECK (max_file_bytes BETWEEN 1048576 AND 52428800),
  updated_by TEXT NOT NULL REFERENCES users(id),
  updated_at TEXT NOT NULL
);
