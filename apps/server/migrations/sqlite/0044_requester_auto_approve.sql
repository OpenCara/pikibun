-- Auto-approving other members' requests (apps/server/src/requester-auto-approve.ts).
-- A workspace's approval settings, as its owners and admins chose them; no row: the defaults (off).
-- requester_auto_approve 1: session owners there may choose to auto-approve the requests of a member who writes to their
-- session, from one of that member's approval cards. Off, no such choice is offered and every one already made rests.
CREATE TABLE workspace_approval_settings (
  workspace_id TEXT PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
  requester_auto_approve INTEGER NOT NULL DEFAULT 0 CHECK (requester_auto_approve IN (0, 1)),
  updated_by TEXT NOT NULL REFERENCES users(id),
  updated_at TEXT NOT NULL
);
-- The members whose requests a session's owner auto-approves. A row stays once the owner stops (revoked_at), so the
-- operations that ran on its strength stay valid in the session's history.
CREATE TABLE session_auto_approved_requesters (
  session_id TEXT NOT NULL REFERENCES sessions(id),
  user_id TEXT NOT NULL REFERENCES users(id),
  approval_id TEXT NOT NULL,
  granted_by TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL,
  revoked_at TEXT,
  PRIMARY KEY (session_id, user_id)
);
