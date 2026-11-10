export const notificationKinds = ["approval", "finished", "failed", "test"] as const;
export type NotificationKind = (typeof notificationKinds)[number];

export interface NotificationPreferences {
  approvals: boolean;
  finished: boolean;
  failed: boolean;
  details: boolean;
}

export const defaultNotificationPreferences: NotificationPreferences = { approvals: true, finished: true, failed: true, details: true };

export interface PikibunNotification {
  id: string;
  kind: NotificationKind;
  title: string;
  body: string;
  sessionId?: string;
  createdAt: string;
}

export interface NotificationPayload extends PikibunNotification {
  origin: string;
  path: string;
}

export interface NotificationDevice {
  id: string;
  kind: "web";
  name: string | null;
  createdAt: string;
  current: boolean;
}

export interface NotificationConfig {
  preferences: NotificationPreferences;
  webPushKey: string | null;
  devices: NotificationDevice[];
}

export interface NotificationFeed {
  notifications: PikibunNotification[];
  cursor: string;
}

export const NOTIFICATION_FEED_RETENTION_MS = 24 * 60 * 60 * 1000;

export function notificationPath(notification: Pick<PikibunNotification, "sessionId">): string {
  return notification.sessionId ? `/#/s/${encodeURIComponent(notification.sessionId)}` : "/#/settings/notifications";
}
