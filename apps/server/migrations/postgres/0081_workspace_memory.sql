-- Postgres translation of sqlite/0088_workspace_memory.sql.

-- Workspace memory (apps/server/src/workspace-memory.ts, docs/design/workspace-memory.md): what every session of a
-- workspace starts with, as a project's knowledge does in Claude Projects. instructions and memory are Markdown its
-- owners and admins write, and the memory tool's update replaces; revision counts the saves, so a save made against an
-- older revision is refused rather than undoing someone else's. No row: both are empty, revision 0.
CREATE TABLE workspace_memory (
  workspace_id TEXT PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
  instructions TEXT NOT NULL DEFAULT '',
  memory TEXT NOT NULL DEFAULT '',
  revision BIGINT NOT NULL DEFAULT 0,
  updated_by TEXT REFERENCES users(id),
  updated_at TEXT
);

-- Notes agents propose for the memory (memory {action: "note"}), as the sender of the message they worked on, until an
-- owner or admin accepts one (taking it into the memory) or dismisses it.
CREATE TABLE workspace_memory_notes (
  id TEXT PRIMARY KEY NOT NULL,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  session_id TEXT REFERENCES sessions(id) ON DELETE SET NULL,
  author_id TEXT NOT NULL REFERENCES users(id),
  text TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'accepted', 'dismissed')),
  created_at TEXT NOT NULL,
  resolved_by TEXT REFERENCES users(id),
  resolved_at TEXT
);
CREATE INDEX workspace_memory_notes_status ON workspace_memory_notes (workspace_id, status, created_at);
