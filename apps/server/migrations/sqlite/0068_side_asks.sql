-- Side asks in the session list (sessions.ts): the session list shows a person's latest side asks under each session
-- they asked in, so a side ask is as easy to find again as a child session. The server keeps, for each person and
-- session, only their latest three: the side ask's conversation on the host, and a preview of its question (its first
-- line, with secrets hidden, at most 120 characters), as it keeps a session's title. The transcript stays on the host.
-- Only the person who asked sees their rows, and only while they may still view the session. Side asks the sessions
-- tool sends are left out: they are listed with the session's messages in Details.
CREATE TABLE side_asks (
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  actor_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  conversation_id TEXT NOT NULL,
  preview TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (session_id, conversation_id)
);
CREATE INDEX side_asks_actor ON side_asks (actor_id, created_at);
