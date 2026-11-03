-- Notifications (docs/notifications.md, apps/server/src/notifications.ts).
-- Which notifications each person gets; no row: the defaults (everything on, with session titles).
CREATE TABLE notification_preferences (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  approvals INTEGER NOT NULL DEFAULT 1 CHECK (approvals IN (0, 1)),
  finished INTEGER NOT NULL DEFAULT 1 CHECK (finished IN (0, 1)),
  failed INTEGER NOT NULL DEFAULT 1 CHECK (failed IN (0, 1)),
  details INTEGER NOT NULL DEFAULT 1 CHECK (details IN (0, 1)),
  updated_at TEXT NOT NULL
);
-- The devices that get a person's notifications: a browser's Web Push subscription (endpoint, p256dh and auth keys) or
-- the app's Expo push token (in endpoint). Each belongs to the sign-in that registered it, and goes with it: signing
-- out, or signing an app out from the web, stops its notifications.
CREATE TABLE notification_devices (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  auth_token_hash TEXT NOT NULL REFERENCES auth_sessions(token_hash) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('web', 'expo')),
  endpoint TEXT NOT NULL UNIQUE,
  p256dh TEXT,
  auth TEXT,
  name TEXT,
  created_at TEXT NOT NULL,
  CHECK ((kind = 'web') = (p256dh IS NOT NULL AND auth IS NOT NULL))
);
CREATE INDEX notification_devices_user ON notification_devices(user_id);
CREATE INDEX notification_devices_auth ON notification_devices(auth_token_hash);
-- Each person's recent notifications, which open web pages and desktop windows poll (GET /api/notifications/feed).
-- Ids sort in the order they were made; rows older than a day are removed as new ones come.
CREATE TABLE notifications (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  session_id TEXT REFERENCES sessions(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('approval', 'finished', 'failed', 'test')),
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX notifications_user ON notifications(user_id, id);
-- Keys the server makes for itself once; the Web Push (VAPID) key pair, its private half sealed with VAULT_KEY.
CREATE TABLE server_keys (
  name TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  created_at TEXT NOT NULL
);
