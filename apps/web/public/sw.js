// Pikibun's service worker: it shows the notifications the server pushes (docs/notifications.md), even when no Pikibun
// tab is open, and opens the session one is about when it is clicked. It caches nothing and handles no requests.

self.addEventListener("install", () => { self.skipWaiting(); });
self.addEventListener("activate", event => { event.waitUntil(self.clients.claim()); });

/** The payload the server sends (NotificationPayload in packages/shared/src/notifications.ts), or null. */
function payloadOf(event) {
  try {
    const data = event.data && event.data.json();
    return data && typeof data.title === "string" && typeof data.body === "string" ? data : null;
  } catch {
    return null;
  }
}

/** A path on this server the app routes: the session, or the notification settings. */
function safePath(path) {
  return typeof path === "string" && path.startsWith("/#/") ? path : "/";
}

self.addEventListener("push", event => {
  const payload = payloadOf(event);
  if (!payload || (payload.origin && payload.origin !== self.location.origin)) return;
  const path = safePath(payload.path);
  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    const watching = Boolean(payload.sessionId) && windows.some(client => client.focused && client.visibilityState === "visible"
      && new URL(client.url).hash === path.slice(1));
    // One notification per session: a newer one about it replaces the last, and still alerts.
    const tag = payload.sessionId ? `session:${payload.sessionId}` : `pikibun:${payload.id}`;
    // Every push shows a notification (subscriptions are userVisibleOnly: browsers penalize or revoke ones that
    // don't). Someone looking at that very session gets a silent one, closed at once.
    await self.registration.showNotification(payload.title, {
      body: payload.body,
      icon: "/favicon.svg",
      tag,
      renotify: !watching,
      silent: watching,
      requireInteraction: payload.kind === "approval" && !watching,
      data: { path },
    });
    if (watching) for (const shown of await self.registration.getNotifications({ tag })) shown.close();
  })());
});

self.addEventListener("notificationclick", event => {
  event.notification.close();
  const path = safePath(event.notification.data && event.notification.data.path);
  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    const open = windows.find(client => new URL(client.url).origin === self.location.origin);
    if (open) {
      await open.focus();
      // The page moves to the session itself (notifications.ts), keeping whatever it had loaded.
      open.postMessage({ type: "pikibun-open", path });
      return;
    }
    await self.clients.openWindow(path);
  })());
});
