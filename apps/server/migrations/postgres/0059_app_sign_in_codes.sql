-- Sign in an app with a code (authority/app-codes.ts): a signed-in browser or app makes a one-use code, shown as a
-- pikibun:// link and its QR code, that another app exchanges for a session of its own. Only the code's hash is kept.
-- A code dies with the session that made it (signing out, a password change, a suspension), and is kept, used, until
-- it expires, so the page that made it can say which app used it.
CREATE TABLE app_sign_in_codes (
  id TEXT PRIMARY KEY,
  code_hash TEXT NOT NULL UNIQUE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  session_hash TEXT NOT NULL REFERENCES auth_sessions(token_hash) ON DELETE CASCADE,
  method TEXT CHECK (method IS NULL OR method = 'password'),
  expires_at BIGINT NOT NULL,
  created_at TEXT NOT NULL,
  used_at TEXT,
  device_name TEXT
);
CREATE INDEX app_sign_in_codes_user ON app_sign_in_codes(user_id);
CREATE INDEX app_sign_in_codes_session ON app_sign_in_codes(session_hash);
-- How a session began, where neither its client nor its method says: 'code' for one made from such a code, which is
-- listed so under Signed-in apps and never stands for a recent GitHub sign-in; NULL for every other.
ALTER TABLE auth_sessions ADD COLUMN via TEXT CHECK (via IS NULL OR via = 'code');
