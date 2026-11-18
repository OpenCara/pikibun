-- Postgres translation of sqlite/0078_forwarded_sessions.sql.
-- Private sessions live on their computer's own Pikibun (docs/design/local-private-sessions.md); another server shows
-- them by forwarding requests through the computer's connector. forwarded_sessions is the last list each connector
-- reported (apps/server/src/forwarded-sessions.ts): what the private workspace lists, notifies about and shows while
-- the computer is offline. record_json holds the session's record as the computer's Pikibun gave it, checked field by
-- field; nothing of its conversation is kept. activity is the last reported activity, to notify on a change.
CREATE TABLE forwarded_sessions (
  connector_id TEXT NOT NULL REFERENCES connectors(id) ON DELETE CASCADE,
  session_id TEXT NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  record_json TEXT NOT NULL,
  activity TEXT,
  reported_at TEXT NOT NULL,
  PRIMARY KEY (connector_id, session_id)
);
CREATE INDEX forwarded_sessions_user ON forwarded_sessions(user_id, session_id);
-- Bring here is gone: no server offers another's portable sessions any more.
DROP TABLE portable_offers;
