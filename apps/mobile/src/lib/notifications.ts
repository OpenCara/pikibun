import { ApiError, type Api } from "@pikibun/client";
import Constants from "expo-constants";
import * as Device from "expo-device";
import * as Notifications from "expo-notifications";
import { useRouter } from "expo-router";
import * as SecureStore from "expo-secure-store";
import { useEffect, useRef } from "react";
import { Platform } from "react-native";
import type { NotificationConfig, NotificationDevice, NotificationPayload } from "../../../../packages/shared/src/notifications";

// Notifications on this iPhone or iPad (docs/notifications.md): the server sends them through Expo's push service to
// the push token this app registers, once its person turns them on here. Tapping one opens its session.

/** The session on screen now: a notification about it while the app is open shows in the list, not as a banner. */
let watchedSession: string | null = null;
/** The session view on screen says so; the cleanup it returns forgets it, unless another view took over since. */
export function watchSession(id: string): () => void {
  watchedSession = id;
  return () => { if (watchedSession === id) watchedSession = null; };
}

Notifications.setNotificationHandler({
  handleNotification: async notification => {
    const data = notification.request.content.data as Partial<NotificationPayload> | undefined;
    const watching = !!data?.sessionId && data.sessionId === watchedSession;
    return { shouldShowBanner: !watching, shouldShowList: true, shouldPlaySound: !watching, shouldSetBadge: false };
  },
});

// Stored per server and person, as sign-ins are: another account on this device doesn't inherit the choice.
const storageKey = (origin: string, userId: string, what: "on" | "device") =>
  `pikibun.notifications.${what}.${origin.replace(/[^A-Za-z0-9]/g, "_")}.${userId.replace(/[^A-Za-z0-9]/g, "_")}`;

/** The Expo project this build pushes through (app.json extra.eas.projectId); without one it can't get a push token. */
function projectId(): string | undefined {
  const extra = Constants.expoConfig?.extra as { eas?: { projectId?: string } } | undefined;
  return extra?.eas?.projectId ?? Constants.easConfig?.projectId ?? undefined;
}

/** Why this device can't get notifications, or null when it can. */
export function pushUnavailable(): string | null {
  if (!Device.isDevice) return "Notifications need an iPhone or iPad: the simulator can't receive them.";
  if (!projectId()) return "This build of the app has no Expo project for notifications (app.json extra.eas.projectId).";
  return null;
}

export async function notificationsOn(origin: string, userId: string): Promise<boolean> {
  return await SecureStore.getItemAsync(storageKey(origin, userId, "on")) === "on";
}

/** Registers this device's push token for the signed-in person, asking for iOS's permission first where it must. */
async function register(api: Api, origin: string, userId: string, ask: boolean): Promise<NotificationDevice> {
  const unavailable = pushUnavailable();
  if (unavailable) throw new Error(unavailable);
  let { status } = await Notifications.getPermissionsAsync();
  if (status !== "granted" && ask) status = (await Notifications.requestPermissionsAsync()).status;
  if (status !== "granted") {
    throw new Error("Notifications are off for Pikibun in iOS Settings. Turn them on there (Settings › Notifications › Pikibun), then try again.");
  }
  if (Platform.OS === "android") {
    await Notifications.setNotificationChannelAsync("default", { name: "Sessions", importance: Notifications.AndroidImportance.HIGH });
  }
  const token = (await Notifications.getExpoPushTokenAsync({ projectId: projectId() })).data;
  const { device } = await api<{ device: NotificationDevice }>("/api/notifications/devices", {
    method: "POST", body: { kind: "expo", token, name: Device.deviceName ?? Device.modelName ?? "Pikibun app" },
  });
  await SecureStore.setItemAsync(storageKey(origin, userId, "device"), device.id);
  return device;
}

export async function enableNotifications(api: Api, origin: string, userId: string): Promise<void> {
  await register(api, origin, userId, true);
  await SecureStore.setItemAsync(storageKey(origin, userId, "on"), "on");
}

/**
 * Turns them off here. The device's id is forgotten only once the server removed it (or never had it), so a failed
 * removal can be tried again rather than leaving the server pushing to a device that no longer knows which it is.
 */
export async function disableNotifications(api: Api, origin: string, userId: string): Promise<void> {
  await SecureStore.deleteItemAsync(storageKey(origin, userId, "on"));
  const id = await SecureStore.getItemAsync(storageKey(origin, userId, "device"));
  if (!id) return;
  await api(`/api/notifications/devices/${encodeURIComponent(id)}`, { method: "DELETE" }).catch(reason => {
    if (!(reason instanceof ApiError && reason.status === 404)) throw reason;
  });
  await SecureStore.deleteItemAsync(storageKey(origin, userId, "device"));
}

/** This device's registration, as the server knows it, when it has one. */
export function currentDeviceId(origin: string, userId: string): Promise<string | null> {
  return SecureStore.getItemAsync(storageKey(origin, userId, "device"));
}

/**
 * While signed in: keeps this device's push token registered on the current sign-in where notifications are on (a
 * token can change, and a new sign-in takes the device over), and opens the session a tapped notification is about,
 * including the one that launched the app.
 */
export function useNotificationRouting(api: Api, origin: string, userId: string): void {
  const router = useRouter();
  const handled = useRef(new Set<string>());
  useEffect(() => {
    void (async () => {
      if (!await notificationsOn(origin, userId) || pushUnavailable()) return;
      const known = await SecureStore.getItemAsync(storageKey(origin, userId, "device"));
      if (known) {
        const config = await api<NotificationConfig>("/api/notifications/config").catch(() => null);
        if (config && !config.devices.some(device => device.id === known)) {
          // Removed under Settings elsewhere, or its sign-in ended: off here too, until it is turned on again.
          await SecureStore.deleteItemAsync(storageKey(origin, userId, "device"));
          await SecureStore.deleteItemAsync(storageKey(origin, userId, "on"));
          return;
        }
      }
      // Registered again on every start: a push token can change.
      await register(api, origin, userId, false).catch(() => {});
    })();
  }, [api, origin, userId]);
  useEffect(() => {
    const open = (response: Notifications.NotificationResponse | null) => {
      if (!response) return;
      const id = response.notification.request.identifier;
      if (handled.current.has(id)) return;
      handled.current.add(id);
      const data = response.notification.request.content.data as Partial<NotificationPayload> | undefined;
      // Only a notification of the server this app is signed in to opens one of its sessions.
      if (!data?.sessionId || data.origin !== origin) return;
      router.push({ pathname: "/session/[id]", params: { id: data.sessionId } });
    };
    void Notifications.getLastNotificationResponseAsync().then(open).catch(() => {});
    const subscription = Notifications.addNotificationResponseReceivedListener(open);
    return () => subscription.remove();
  }, [origin, router]);
}
