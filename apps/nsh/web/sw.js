self.addEventListener("install", () => { self.skipWaiting(); });
self.addEventListener("activate", event => { event.waitUntil(self.clients.claim()); });

function payloadOf(event) {
  try {
    const data = event.data && event.data.json();
    return data && typeof data.title === "string" && typeof data.body === "string" ? data : null;
  } catch {
    return null;
  }
}

function safePath(path) {
  return typeof path === "string" && path.startsWith("/#/") ? path : "/";
}

async function handled(id) {
  if (typeof id !== "string") return;
  try {
    const session = await fetch("/api/auth/csrf", { credentials: "same-origin", headers: { Accept: "application/json" } });
    if (!session.ok) return;
    const { csrfToken } = await session.json();
    await fetch("/api/notifications/handled", {
      method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json", "X-CSRF-Token": csrfToken }, body: JSON.stringify({ ids: [id] }),
    });
  } catch {
  }
}

self.addEventListener("push", event => {
  const payload = payloadOf(event);
  if (!payload || (payload.origin && payload.origin !== self.location.origin)) return;
  const path = safePath(payload.path);
  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    const watching = Boolean(payload.sessionId) && windows.some(client => client.focused && client.visibilityState === "visible"
      && new URL(client.url).hash === path.slice(1));
    const tag = payload.sessionId ? `session:${payload.sessionId}` : `pikibun:${payload.id}`;
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
    await handled(payload.id);
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
      open.postMessage({ type: "pikibun-open", path });
      return;
    }
    await self.clients.openWindow(path);
  })());
});
