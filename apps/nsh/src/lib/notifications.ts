import { cleanup, effect, host, lifecycle, Notifications, platform, signal, Storage, untracked, type Accessor } from "nsh";
import {
  NOTIFICATION_FEED_POLL_MS, notificationPath, type FeedNotification, type NotificationConfig, type NotificationDevice, type NotificationFeed, type PikibunNotification,
} from "../../../../packages/shared/src/notifications";
import { ApiError, errorMessage, segment } from "../shared";
import { servers, session, switchServer } from "./auth";
import { inBackground } from "./resource";
import { pageAvailable, pageRoute, parseRoute, shownPage, shownRoute, type PageRoute } from "./page";
import { deviceToken, expoPushToken, pushModule, type PushModule } from "./push";

export type DeviceSupport = ({ kind: "push" } | { kind: "page" } | { kind: "app"; remote?: boolean } | { kind: "unsupported"; reason: string }) & { permission?: NotificationPermission };
type NotificationPermission = "default" | "granted" | "denied";

const inApp = () => !pageAvailable() && platform.os !== "web";
const UNAVAILABLE = "This device can't show Pikibun's notifications. Turn them on in Pikibun on the web, or in a browser, to be told there.";

const choiceKey = (userId: string) => `pikibun.notifications.${userId}`;
const deviceKey = (userId: string) => `pikibun.notificationDevice.${userId}`;

const on = signal(false);
export const notificationsOn: Accessor<boolean> = on;

const problem = signal("");
export const pushProblem: Accessor<string> = problem;

export async function loadNotificationChoice(userId: string): Promise<boolean> {
  const value = (pageAvailable() || inApp()) && (await Storage.getItem(choiceKey(userId)).catch(() => null)) === "on";
  on.set(value);
  return value;
}

export async function deviceSupport(webPushKey: string | null): Promise<DeviceSupport> {
  if (inApp()) {
    const permission = await Notifications.permission().catch(() => "unavailable" as const);
    if (permission === "unavailable") return { kind: "unsupported", reason: UNAVAILABLE };
    return { kind: "app", permission, ...(await pushModule() ? { remote: true } : {}) };
  }
  if (!pageAvailable()) return { kind: "unsupported", reason: UNAVAILABLE };
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

const phoneName = () => (platform.idiom === "pad" ? "iPad" : "iPhone");

const chosen = async (userId: string) => (await Storage.getItem(choiceKey(userId)).catch(() => null)) === "on";

async function registerPhone(userId: string, token: string, turningOn = false): Promise<void> {
  const wanted = async () => turningOn || await chosen(userId);
  try {
    const expo = await expoPushToken(token);
    if (!await wanted()) return;
    const api = session().api;
    const { device } = await api<{ device: NotificationDevice }>("/api/notifications/devices", { method: "POST", body: { kind: "expo", token: expo, name: phoneName() } });
    if (!await wanted()) {
      await api(`/api/notifications/devices/${segment(device.id)}`, { method: "DELETE" }).catch(() => undefined);
      return;
    }
    await Storage.setItem(deviceKey(userId), device.id);
    problem.set("");
  } catch (reason) {
    if (await wanted()) problem.set(errorMessage(reason));
  }
}

export async function enableNotifications(userId: string, config: Pick<NotificationConfig, "webPushKey">): Promise<DeviceSupport> {
  const support = await deviceSupport(config.webPushKey);
  if (support.kind === "unsupported") throw new Error(support.reason);
  if (support.kind === "app") {
    const permission = await Notifications.requestPermission();
    if (permission !== "granted") {
      throw new Error(permission === "denied"
        ? "Notifications from Pikibun are off in this device's settings. Turn them on there, then try again."
        : "Notifications weren't allowed.");
    }
    const push = await pushModule();
    if (push) {
      try {
        await registerPhone(userId, await deviceToken(push), true);
      } catch (reason) {
        problem.set(errorMessage(reason));
      }
    }
    await Storage.setItem(choiceKey(userId), "on");
    on.set(true);
    return { kind: "app", permission, ...(push ? { remote: true } : {}) };
  }
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
  problem.set("");
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

export function notificationRoute(id: string) {
  const at = id.lastIndexOf(" ");
  return at < 0 ? null : parseRoute(id.slice(at + 1));
}

export function pushedRoute(payload: unknown): { route: PageRoute; origin?: string } | null {
  const data = payload && typeof payload === "object" ? (payload as { body?: unknown }).body : null;
  if (!data || typeof data !== "object") return null;
  const { path, origin } = data as { path?: unknown; origin?: unknown };
  if (typeof path !== "string" || !path.startsWith("/#/")) return null;
  return { route: parseRoute(path.slice(1)), ...(typeof origin === "string" ? { origin } : {}) };
}

async function openPushed(payload: unknown): Promise<void> {
  const pushed = pushedRoute(payload);
  if (!pushed) return;
  const origin = pushed.origin;
  if (origin && origin !== untracked(session).origin && untracked(servers).some(item => item.origin === origin)) await switchServer(origin);
  pageRoute.set(pushed.route);
}

async function show(notification: PikibunNotification): Promise<void> {
  const path = notificationPath(notification);
  if (inApp()) {
    const at = shownRoute();
    if (untracked(lifecycle) === "active" && at.name === "session" && at.sessionId === notification.sessionId) return;
    await Notifications.show({ id: `${notification.id} ${path.replace(/^\/#/, "#")}`, title: notification.title, body: notification.body });
    return;
  }
  await host.call("page.notifications.show", { id: notification.id, title: notification.title, body: notification.body,
    path, sessionId: notification.sessionId ?? null });
}

async function take(notifications: readonly FeedNotification[]): Promise<Set<string> | null> {
  const ids = notifications.filter(notification => !notification.pushed).map(notification => notification.id);
  if (!ids.length) return new Set();
  try {
    return new Set((await session().api<{ handled: string[] }>("/api/notifications/handled", { method: "POST", body: { ids } })).handled);
  } catch {
    return null;
  }
}

const QUIET = { banner: false, list: false, sound: false, badge: false };

function quietInFront(pushing: Accessor<PushModule | null>): void {
  effect(() => {
    const push = pushing();
    const at = shownPage();
    if (!push || at.name !== "session") return undefined;
    const thread = { threadId: at.sessionId };
    try { push.setForegroundPresentation(QUIET, thread); } catch { return undefined; }
    return () => { try { push.setForegroundPresentation(null, thread); } catch { } };
  });
}

function deliver(userId: string, pushing: (push: PushModule | null) => void): () => void {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let cursor: string | undefined;
  let remote = false;
  let registered: string | undefined;
  let stopTokens: (() => void) | undefined;
  const register = (token: string) => {
    if (stopped || token === registered) return;
    registered = token;
    void registerPhone(userId, token);
  };
  async function poll() {
    if (stopped) return;
    if (!inBackground() || inApp()) {
      try {
        const feed = await session().api<NotificationFeed>(`/api/notifications/feed${cursor ? `?after=${encodeURIComponent(cursor)}` : ""}`);
        if (stopped) return;
        if (cursor && feed.notifications.length) {
          const taken = await take(feed.notifications);
          for (const notification of feed.notifications) {
            if (!remote || (taken ? taken.has(notification.id) : !notification.pushed)) await show(notification).catch(() => undefined);
          }
        }
        cursor = feed.cursor;
      } catch { }
    }
    if (!stopped) timer = setTimeout(() => void poll(), NOTIFICATION_FEED_POLL_MS);
  }
  void (async () => {
    let support: DeviceSupport;
    try {
      const config = await session().api<NotificationConfig>("/api/notifications/config");
      support = await deviceSupport(config.webPushKey);
      const known = await currentDeviceId(userId);
      const registers = support.kind === "push" || (support.kind === "app" && support.remote === true);
      if (registers && known && !config.devices.some(device => device.id === known)) {
        if (!stopped) await disableNotifications(userId).catch(() => undefined);
        return;
      }
      if (support.kind === "push" && support.permission === "granted" && !stopped) await registerPush(userId, config.webPushKey!);
      const push = support.kind === "app" && support.permission === "granted" ? await pushModule() : null;
      if (push && !stopped) {
        remote = true;
        pushing(push);
        stopTokens = push.on("token", ({ token }) => register(token));
        void push.register().then(({ token }) => register(token), reason => { if (!stopped) problem.set(errorMessage(reason)); });
      }
    } catch {
      support = { kind: "page" };
    }
    if (!stopped && (support.kind === "page" || (support.kind === "app" && support.permission === "granted"))) void poll();
  })();
  return () => {
    stopped = true;
    clearTimeout(timer);
    stopTokens?.();
    pushing(null);
  };
}

export function createNotificationDelivery(userId: string): void {
  if (!pageAvailable() && !inApp()) return;
  if (inApp()) {
    try {
      cleanup(Notifications.on("press", ({ id }) => {
        const route = notificationRoute(id);
        if (route) pageRoute.set(route);
      }));
    } catch { }
    let gone = false;
    let stopPresses: (() => void) | undefined;
    cleanup(() => { gone = true; stopPresses?.(); });
    void pushModule().then(push => {
      if (!push || gone) return;
      try { stopPresses = push.on("press", ({ payload }) => { void openPushed(payload).catch(() => undefined); }); } catch { }
    });
  }
  const pushing = signal<PushModule | null>(null);
  quietInFront(pushing);
  void loadNotificationChoice(userId);
  effect(() => (on() ? untracked(() => deliver(userId, push => pushing.set(push))) : undefined));
  cleanup(() => on.set(false));
}
