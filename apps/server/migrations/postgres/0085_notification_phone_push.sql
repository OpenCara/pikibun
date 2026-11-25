-- Postgres translation of sqlite/0092_notification_phone_push.sql.
-- iPhone and iPad pushes come last (docs/notifications.md, apps/server/src/notifications.ts): a notification goes to a
-- person's phone apps (notification_devices of kind expo) only when no other device of theirs took it. A browser or a
-- desktop app that shows a notification says so (POST /api/notifications/handled), which sets handled_at.
-- push_at is when the push to the phone apps is due while it waits for that (NULL: none is waiting), and pushed_at
-- when it was sent, after which nothing takes it back.
ALTER TABLE notifications ADD COLUMN handled_at TEXT;
ALTER TABLE notifications ADD COLUMN push_at TEXT;
ALTER TABLE notifications ADD COLUMN pushed_at TEXT;
CREATE INDEX notifications_push ON notifications(push_at) WHERE push_at IS NOT NULL;
