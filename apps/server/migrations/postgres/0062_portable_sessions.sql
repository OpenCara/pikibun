-- Postgres translation of sqlite/0069_portable_sessions.sql.

-- Portable sessions (docs/design/portable-sessions.md, apps/server/src/portable-sessions.ts): private-workspace sessions that
-- belong to their owner's identity, an Ed25519 key kept on their hosts, and can be attached to another server that
-- identity's hosts are paired with.
-- A host's delegation: the account that paired connector_id acts for public_key on this server. The statement and its
-- signature are kept as the host sent them, checked against public_key.
CREATE TABLE identity_delegations (
  connector_id TEXT PRIMARY KEY REFERENCES connectors(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  public_key TEXT NOT NULL,
  statement_json TEXT NOT NULL,
  signature TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX identity_delegations_user ON identity_delegations(user_id, public_key);
-- The portable sessions a host last reported, whether attached here or to another server: what Bring here offers.
-- attached 1: the host's binding names this connector. working 1: it was working when reported.
CREATE TABLE portable_offers (
  connector_id TEXT NOT NULL REFERENCES connectors(id) ON DELETE CASCADE,
  session_id TEXT NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  public_key TEXT NOT NULL,
  title TEXT NOT NULL,
  created_at TEXT NOT NULL,
  host_environment BIGINT NOT NULL DEFAULT 0 CHECK (host_environment IN (0, 1)),
  provider TEXT NOT NULL,
  model_id TEXT NOT NULL,
  attached BIGINT NOT NULL DEFAULT 0 CHECK (attached IN (0, 1)),
  working BIGINT NOT NULL DEFAULT 0 CHECK (working IN (0, 1)),
  reported_at TEXT NOT NULL,
  PRIMARY KEY (connector_id, session_id)
);
CREATE INDEX portable_offers_user ON portable_offers(user_id);
-- portable_key: the identity a portable session belongs to; NULL for every other session.
-- detached_at: when its host attached it to another server, which archived it here.
ALTER TABLE sessions ADD COLUMN portable_key TEXT;
ALTER TABLE sessions ADD COLUMN detached_at TEXT;
-- The private workspace's settings that travel with an identity (name, transcript paging and tool output), as the
-- latest statement its hosts signed. pending_*: settings changed here that its hosts haven't signed yet.
-- applied_version: the highest signed version applied to this server's private workspace.
CREATE TABLE portable_settings (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  public_key TEXT,
  version BIGINT NOT NULL DEFAULT 0,
  statement_json TEXT,
  signature TEXT,
  applied_version BIGINT NOT NULL DEFAULT 0,
  pending_version BIGINT,
  pending_json TEXT,
  updated_at TEXT NOT NULL
);
