-- Hosts a member trusts with their own account (apps/server/src/authority/trusted-hosts.ts, docs/design/security-rationale.md).
-- Without a row, the member's own account (the owner-account push identity, and gh, glab and az writes and personal access tokens)
-- serves only their sessions on their own hosts. With one, it also serves their sessions on that host, whose owner can then read the
-- token while it is valid. host_owner_id is the host's owner when they trusted it: the trust counts only while the host has that owner.
CREATE TABLE member_trusted_hosts (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  connector_id TEXT NOT NULL REFERENCES connectors(id) ON DELETE CASCADE,
  host_owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  PRIMARY KEY (user_id, connector_id)
);
CREATE INDEX member_trusted_hosts_connector ON member_trusted_hosts (connector_id);
