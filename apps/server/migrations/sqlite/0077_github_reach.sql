-- A member's own choice, per workspace, of which GitHub repositories their own messages may act on (apps/server/src/github-reach.ts,
-- docs/design/security-rationale.md). No row, or any_repository 0: only the workspace's repositories, as before.
-- any_repository 1: in sessions they own, messages they send themselves may also read and write, as them, any github.com
-- repository their GitHub sign-in reaches (github_read, github_issue, github_merge, and gh's writes on their own hosts).
CREATE TABLE member_github_reach (
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  any_repository INTEGER NOT NULL DEFAULT 0 CHECK (any_repository IN (0, 1)),
  updated_at TEXT NOT NULL,
  PRIMARY KEY (workspace_id, user_id)
);
