-- Prompt-cache warming (apps/runner/src/session/cache-warming.ts, docs/design/cache-warming.md).
-- A workspace's choice, as its owners and admins made it; no row: the default ('idle').
-- mode 'idle': hosts refresh a session's prompt cache while its agent works and for up to 30 minutes after it answered;
-- 'streaming': only while its agent works; 'off': never.
CREATE TABLE workspace_cache_warming_settings (
  workspace_id TEXT PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
  mode TEXT NOT NULL DEFAULT 'idle' CHECK (mode IN ('idle', 'streaming', 'off')),
  updated_by TEXT NOT NULL REFERENCES users(id),
  updated_at TEXT NOT NULL
);
