import { useEffect, useSyncExternalStore } from "react";
import type { NotificationConfig, NotificationDevice, NotificationFeed, PikibunNotification } from "../../../packages/shared/src/notifications";
import { notificationPath } from "../../../packages/shared/src/notifications";
import { api, ApiError, segment } from "./api";
import { desktopBridge } from "./desktop";

// Notifications on this device (docs/notifications.md). Each person turns them on per device; then:
// - in the desktop app, open windows poll the notification feed and the app shows native notifications;
// - in a browser with Web Push, the service worker (public/sw.js) shows what the server pushes, even with no tab open;
// - in a browser without it (no service worker or PushManager, or a server without Web Push), open tabs poll the feed
//   and show system notifications while one is open.

/** How this device shows notifications, or why it can't. */
export type DeviceSupport = { kind: "desktop" } | { kind: "push" } | { kind: "page" } | { kind: "unsupported"; reason: string };

export function deviceSupport(webPushKey: string | null): DeviceSupport {
  const bridge = desktopBridge();
  if (bridge?.notify) return { kind: "desktop" };
  // An app from before notifications: its windows allow pages no notifications of their own.
  if (bridge) return { kind: "unsupported", reason: "Update the Pikibun app to get notifications here." };
  if (typeof window === "undefined" || !("Notification" in window)) return { kind: "unsupported", reason: "This browser can't show notifications." };
  if (webPushKey && window.isSecureContext && "serviceWorker" in navigator && "PushManager" in window) return { kind: "push" };
  return { kind: "page" };
}

const choiceKey = (userId: string) => `pikibun.notifications.${userId}`;
const deviceKey = (userId: string) => `pikibun.notificationDevice.${userId}`;

function read(key: string): string | null {
  try { return localStorage.getItem(key); } catch { return null; }
}
function write(key: string, value: string | null): void {
  try { if (value === null) localStorage.removeItem(key); else localStorage.setItem(key, value); } catch { /* Private mode: this page only. */ }
}

// The choice, as a tiny store, so Settings and the delivery hook stay in step.
const listeners = new Set<() => void>();
function changed(): void { for (const listener of listeners) listener(); }
function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  const storage = (event: StorageEvent) => { if (event.key?.startsWith("pikibun.notification")) listener(); };
  window.addEventListener("storage", storage);
  return () => { listeners.delete(listener); window.removeEventListener("storage", storage); };
}

/** Whether notifications are on for this person on this device (and the browser still lets the page show them). */
export function notificationsOn(userId: string): boolean {
  if (read(choiceKey(userId)) !== "on") return false;
  if (desktopBridge()?.notify) return true;
  return typeof Notification !== "undefined" && Notification.permission === "granted";
}

export function useNotificationsOn(userId: string): boolean {
  return useSyncExternalStore(subscribe, () => notificationsOn(userId), () => false);
}

/** A short name for this device, so the device list tells browsers apart. */
function deviceName(): string {
  const agent = navigator.userAgent;
  const browser = /Edg\//.test(agent) ? "Edge" : /Firefox\//.test(agent) ? "Firefox" : /Chrome\//.test(agent) ? "Chrome" : /Safari\//.test(agent) ? "Safari" : "Browser";
  const system = /iPhone|iPad/.test(agent) ? "iOS" : /Android/.test(agent) ? "Android" : /Mac OS X/.test(agent) ? "macOS" : /Windows/.test(agent) ? "Windows"
    : /Linux/.test(agent) ? "Linux" : "";
  return system ? `${browser} on ${system}` : browser;
}

function keyBytes(base64url: string): Uint8Array<ArrayBuffer> {
  const base64 = base64url.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(base64 + "=".repeat((4 - base64.length % 4) % 4));
  return Uint8Array.from(binary, char => char.charCodeAt(0));
}

function sameKey(current: ArrayBuffer | null | undefined, expected: Uint8Array): boolean {
  if (!current) return false;
  const bytes = new Uint8Array(current);
  return bytes.length === expected.length && bytes.every((byte, index) => byte === expected[index]);
}

/**
 * This browser's push subscription for the server's key, registered as this person's device for this sign-in. A
 * subscription made for another key (the server's changed) is replaced.
 */
async function registerPush(userId: string, webPushKey: string): Promise<NotificationDevice> {
  const registration = await navigator.serviceWorker.register("/sw.js");
  await navigator.serviceWorker.ready;
  const key = keyBytes(webPushKey);
  let subscription = await registration.pushManager.getSubscription();
  if (subscription && !sameKey(subscription.options.applicationServerKey, key)) {
    await subscription.unsubscribe();
    subscription = null;
  }
  subscription ??= await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
  const { endpoint, keys } = subscription.toJSON();
  const { device } = await api<{ device: NotificationDevice }>("/api/notifications/devices", {
    method: "POST", body: { kind: "web", endpoint, keys: { p256dh: keys?.p256dh, auth: keys?.auth }, name: deviceName() },
  });
  write(deviceKey(userId), device.id);
  return device;
}

/** Turns notifications on for this person on this device, asking the browser's permission where it needs one. */
export async function enableNotifications(userId: string, config: Pick<NotificationConfig, "webPushKey">): Promise<DeviceSupport> {
  const support = deviceSupport(config.webPushKey);
  if (support.kind === "unsupported") throw new Error(support.reason);
  if (support.kind !== "desktop") {
    const permission = Notification.permission === "granted" ? "granted" : await Notification.requestPermission();
    if (permission !== "granted") {
      throw new Error(permission === "denied"
        ? "This browser blocks notifications from Pikibun. Allow them in the site's settings (the icon beside the address), then try again."
        : "Notifications weren't allowed.");
    }
  }
  if (support.kind === "push") await registerPush(userId, config.webPushKey!);
  write(choiceKey(userId), "on");
  changed();
  return support;
}

/** Turns them off here: the browser's subscription and its registration go. */
export async function disableNotifications(userId: string): Promise<void> {
  write(choiceKey(userId), null);
  changed();
  const id = read(deviceKey(userId));
  write(deviceKey(userId), null);
  if (id) await api(`/api/notifications/devices/${segment(id)}`, { method: "DELETE" }).catch(reason => { if (!(reason instanceof ApiError && reason.status === 404)) throw reason; });
  const registration = "serviceWorker" in navigator ? await navigator.serviceWorker.getRegistration("/sw.js").catch(() => undefined) : undefined;
  await (await registration?.pushManager.getSubscription().catch(() => null))?.unsubscribe().catch(() => false);
}

/** This device's registration, as the server knows it, when it has one. */
export function currentDeviceId(userId: string): string | null {
  return read(deviceKey(userId));
}

/** The person is looking at that session right now: no need to tell them. */
function watching(notification: PikibunNotification): boolean {
  return !!notification.sessionId && document.visibilityState === "visible" && document.hasFocus()
    && window.location.hash === notificationPath(notification).slice(1);
}

function show(notification: PikibunNotification): void {
  if (watching(notification)) return;
  const path = notificationPath(notification);
  const bridge = desktopBridge();
  if (bridge?.notify) {
    // Several windows of this server each poll; the app shows each notification once, by its id.
    void bridge.notify({ title: notification.title, body: notification.body, path, tag: notification.id }).catch(() => {});
    return;
  }
  if (Notification.permission !== "granted") return;
  // Tabs that each show it replace one another's: one notification, by its id.
  const shown = new Notification(notification.title, { body: notification.body, tag: notification.id, icon: "/favicon.svg" });
  shown.onclick = () => {
    window.focus();
    window.location.hash = path.slice(1);
    shown.close();
  };
}

const POLL_MS = 20_000;

/**
 * Delivers this person's notifications on this device while the app is open: polls the feed where nothing pushes to
 * the device (the desktop app, browsers without Web Push), keeps a browser's push registration on the current sign-in,
 * and opens the session a notification the service worker showed was clicked for.
 */
export function useNotificationDelivery(userId: string): void {
  const on = useNotificationsOn(userId);
  useEffect(() => {
    if (!on) return;
    let stopped = false;
    let timer: number | undefined;
    let cursor: string | undefined;
    const navigateTo = (event: MessageEvent) => {
      const data = event.data as { type?: string; path?: string } | undefined;
      if (data?.type === "pikibun-open" && typeof data.path === "string" && data.path.startsWith("/#/")) window.location.hash = data.path.slice(1);
    };
    if ("serviceWorker" in navigator) navigator.serviceWorker.addEventListener("message", navigateTo);
    const poll = async () => {
      try {
        const feed = await api<NotificationFeed>(`/api/notifications/feed${cursor ? `?after=${encodeURIComponent(cursor)}` : ""}`);
        if (stopped) return;
        if (cursor) for (const notification of feed.notifications) show(notification);
        cursor = feed.cursor;
      } catch { /* Offline or signed out: the next poll tries again. */ }
      if (!stopped) timer = window.setTimeout(() => void poll(), POLL_MS);
    };
    void (async () => {
      let support: DeviceSupport;
      try {
        const config = await api<NotificationConfig>("/api/notifications/config");
        support = deviceSupport(config.webPushKey);
        // Registered again on every start: a new sign-in in this browser takes the subscription over.
        if (support.kind === "push") await registerPush(userId, config.webPushKey!);
      } catch {
        // Push isn't working here now: the page shows what comes while it is open.
        support = deviceSupport(null);
      }
      if (!stopped && support.kind !== "push" && support.kind !== "unsupported") void poll();
    })();
    return () => {
      stopped = true;
      window.clearTimeout(timer);
      if ("serviceWorker" in navigator) navigator.serviceWorker.removeEventListener("message", navigateTo);
    };
  }, [on, userId]);
}
