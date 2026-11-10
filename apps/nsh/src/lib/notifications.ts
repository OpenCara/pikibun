import { cleanup, effect, host, signal, Storage, untracked, type Accessor } from "nsh";
import { notificationPath, type NotificationConfig, type NotificationDevice, type NotificationFeed } from "../../../../packages/shared/src/notifications";
import { ApiError, segment } from "../shared";
import { session } from "./auth";
import { inBackground } from "./resource";
import { pageAvailable } from "./page";

export type DeviceSupport = ({ kind: "push" } | { kind: "page" } | { kind: "unsupported"; reason: string }) & { permission?: NotificationPermission };
type NotificationPermission = "default" | "granted" | "denied";

const choiceKey = (userId: string) => `pikibun.notifications.${userId}`;
const deviceKey = (userId: string) => `pikibun.notificationDevice.${userId}`;

const on = signal(false);
export const notificationsOn: Accessor<boolean> = on;

export async function loadNotificationChoice(userId: string): Promise<boolean> {
  const value = pageAvailable() && (await Storage.getItem(choiceKey(userId)).catch(() => null)) === "on";
  on.set(value);
  return value;
}

export async function deviceSupport(webPushKey: string | null): Promise<DeviceSupport> {
  if (!pageAvailable()) return { kind: "unsupported", reason: "This app can't show notifications yet. Turn them on in Pikibun on the web, or in a browser, to be told here." };
  try {
    return (await host.call<DeviceSupport>("page.notifications.support", { webPushKey })) ?? { kind: "unsupported", reason: "This browser can't show notifications." };
  } catch {
    return { kind: "unsupported", reason: "This browser can't show notifications." };
  }
}

async function registerPush(userId: string, webPushKey: string): Promise<NotificationDevice> {
  const subscription = await host.call<{ endpoint?: string; keys?: { p256dh?: string; auth?: string }; name: string }>("page.notifications.subscribe", { webPushKey }, { timeout: 60_000 });
  if (!subscription?.endpoint) throw new Error("This browser couldn't subscribe to notifications.");
  const { device } = await session().api<{ device: NotificationDevice }>("/api/notifications/devices", {
    method: "POST", body: { kind: "web", endpoint: subscription.endpoint, keys: subscription.keys, name: subscription.name },
  });
  await Storage.setItem(deviceKey(userId), device.id);
  return device;
}

export async function enableNotifications(userId: string, config: Pick<NotificationConfig, "webPushKey">): Promise<DeviceSupport> {
  const support = await deviceSupport(config.webPushKey);
  if (support.kind === "unsupported") throw new Error(support.reason);
  const permission = await host.call<NotificationPermission>("page.notifications.permit", null, { timeout: 0 });
  if (permission !== "granted") {
    throw new Error(permission === "denied"
      ? "This browser blocks notifications from Pikibun. Allow them in the site's settings (the icon beside the address), then try again."
      : "Notifications weren't allowed.");
  }
  if (support.kind === "push") await registerPush(userId, config.webPushKey!);
  await Storage.setItem(choiceKey(userId), "on");
  on.set(true);
  return support;
}

export async function disableNotifications(userId: string): Promise<void> {
  await Storage.removeItem(choiceKey(userId)).catch(() => undefined);
  on.set(false);
  try {
    const id = await Storage.getItem(deviceKey(userId)).catch(() => null);
    if (id) {
      await session().api(`/api/notifications/devices/${segment(id)}`, { method: "DELETE" })
        .catch(reason => { if (!(reason instanceof ApiError && reason.status === 404)) throw reason; });
      await Storage.removeItem(deviceKey(userId));
    }
  } finally {
    if (pageAvailable()) await host.call("page.notifications.unsubscribe").catch(() => undefined);
  }
}

export async function currentDeviceId(userId: string): Promise<string | null> {
  return Storage.getItem(deviceKey(userId)).catch(() => null);
}

const POLL_MS = 20_000;

function deliver(userId: string): () => void {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let cursor: string | undefined;
  async function poll() {
    if (stopped) return;
    if (!inBackground()) {
      try {
        const feed = await session().api<NotificationFeed>(`/api/notifications/feed${cursor ? `?after=${encodeURIComponent(cursor)}` : ""}`);
        if (stopped) return;
        if (cursor) {
          for (const notification of feed.notifications) {
            await host.call("page.notifications.show", { id: notification.id, title: notification.title, body: notification.body,
              path: notificationPath(notification), sessionId: notification.sessionId ?? null }).catch(() => undefined);
          }
        }
        cursor = feed.cursor;
      } catch { }
    }
    if (!stopped) timer = setTimeout(() => void poll(), POLL_MS);
  }
  void (async () => {
    let support: DeviceSupport;
    try {
      const config = await session().api<NotificationConfig>("/api/notifications/config");
      support = await deviceSupport(config.webPushKey);
      const known = await currentDeviceId(userId);
      if (support.kind === "push" && known && !config.devices.some(device => device.id === known)) {
        if (!stopped) await disableNotifications(userId).catch(() => undefined);
        return;
      }
      if (support.kind === "push" && support.permission === "granted" && !stopped) await registerPush(userId, config.webPushKey!);
    } catch {
      support = { kind: "page" };
    }
    if (!stopped && support.kind === "page") void poll();
  })();
  return () => {
    stopped = true;
    clearTimeout(timer);
  };
}

export function createNotificationDelivery(userId: string): void {
  if (!pageAvailable()) return;
  void loadNotificationChoice(userId);
  effect(() => (on() ? untracked(() => deliver(userId)) : undefined));
  cleanup(() => on.set(false));
}
