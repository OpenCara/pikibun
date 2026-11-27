-- A member's own choice, per workspace, of whether their own account serves their sessions on other people's hosts
-- (apps/server/src/authority/host-account.ts, docs/design/security-rationale.md). No row, or others_hosts 0: as before, the
-- owner's account (the owner-account push identity, and gh, glab and az writes and personal access tokens) serves only
-- sessions on their own hosts. others_hosts 1: it also serves their sessions on hosts other members own, whose owners can
-- then read the token while it is valid.
CREATE TABLE member_host_account (
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  others_hosts INTEGER NOT NULL DEFAULT 0 CHECK (others_hosts IN (0, 1)),
  updated_at TEXT NOT NULL,
  PRIMARY KEY (workspace_id, user_id)
);
