// Notifications (docs/notifications.md, apps/server/src/notifications.ts): when a session's agent needs an approval,
// finishes or fails, its owner and whoever sent it the latest message hear about it on the devices they turned
// notifications on for: browsers through Web Push, the iPhone and iPad app through Expo's push service, and any open
// web page or desktop window through the notification feed it polls.

/** What a notification says happened to a session. */
export const notificationKinds = ["approval", "finished", "failed", "test"] as const;
export type NotificationKind = (typeof notificationKinds)[number];

/** Which notifications a person gets, on every device they turned them on for. */
export interface NotificationPreferences {
  /** A session's agent waits for an approval. */
  approvals: boolean;
  /** A session's agent finished the message it was working on. */
  finished: boolean;
  /** A session's agent stopped on an error. */
  failed: boolean;
  /**
   * Notifications name the session (its title) and its workspace. Off, they only say what happened, for people who
   * don't want session titles on a lock screen or passing through push services.
   */
  details: boolean;
}

export const defaultNotificationPreferences: NotificationPreferences = { approvals: true, finished: true, failed: true, details: true };

/** A notification as the feed and push payloads carry it. */
export interface PikibunNotification {
  id: string;
  kind: NotificationKind;
  title: string;
  body: string;
  /** The session it is about; absent for a test notification. */
  sessionId?: string;
  createdAt: string;
}

/** The payload of a Web Push message (the service worker's `push` event) and of an Expo push's `data`. */
export interface NotificationPayload extends PikibunNotification {
  /** The server it came from, so an app signed in elsewhere since doesn't open a session of the wrong server. */
  origin: string;
  /** Where clicking it goes, relative to the server: the session, or the notification settings. */
  path: string;
}

/** A device that gets this person's notifications: a browser's push subscription, or the app's push token. */
export interface NotificationDevice {
  id: string;
  kind: "web" | "expo";
  /** As the device named itself when it registered ("Chrome on macOS", "iPhone"). */
  name: string | null;
  createdAt: string;
  /** The device registered through the sign-in this request came with. */
  current: boolean;
}

/** GET /api/notifications/config: the person's preferences, and how this server can push. */
export interface NotificationConfig {
  preferences: NotificationPreferences;
  /** The server's Web Push (VAPID) public key, base64url; null where it can't send Web Push (no VAULT_KEY). */
  webPushKey: string | null;
  devices: NotificationDevice[];
}

/** GET /api/notifications/feed: notifications after `after`, oldest first, and the cursor to ask from next. */
export interface NotificationFeed {
  notifications: PikibunNotification[];
  cursor: string;
}

/** The feed keeps each person's notifications this long: long enough for a page that was asleep to catch up. */
export const NOTIFICATION_FEED_RETENTION_MS = 24 * 60 * 60 * 1000;

/** Where a notification leads, relative to the server's web app (its hash routes). */
export function notificationPath(notification: Pick<PikibunNotification, "sessionId">): string {
  return notification.sessionId ? `/#/s/${encodeURIComponent(notification.sessionId)}` : "/#/settings/notifications";
}
