const page = typeof location !== "undefined" && typeof history !== "undefined";

const route = () => (page ? location.hash : "");

let shown = null;
const depthOf = state => (typeof state?.nsh === "number" ? state.nsh : 0);
let depth = 0;
let traversedAt = 0;

const functions = new Map([
  ["page.route", () => route()],
  ["page.setRoute", args => {
    const hash = typeof args?.hash === "string" && /^#\/[^\s]*$/.test(args.hash) ? args.hash : "#/";
    shown = hash;
    if (page && (location.hash !== hash || !history.state?.pikibun)) history.replaceState({ ...(history.state ?? {}), pikibun: true }, "", hash);
    return null;
  }],
  ["page.open", args => {
    const path = args?.path;
    if (typeof path !== "string" || !path.startsWith("/") || path.startsWith("//") || path.includes("\\")) throw new Error("Only this server's own paths open.");
    if (page) location.assign(path);
    return null;
  }],
  ["page.query", () => (page ? location.search : "")],
  ["page.authorize", args => {
    const url = args?.url;
    if (typeof url !== "string" || !url.startsWith("https://github.com/login/oauth/authorize?")) throw new Error("Only GitHub's authorization page opens.");
    if (page) location.assign(url);
    return null;
  }],
  ["page.pickFiles", args => pickFiles(args)],
  ["page.encodeImage", args => encodeImage(args)],
  ["page.notifications.support", args => notificationSupport(args?.webPushKey)],
  ["page.notifications.permit", () => notificationPermission()],
  ["page.notifications.subscribe", args => subscribePush(args?.webPushKey)],
  ["page.notifications.unsubscribe", () => unsubscribePush()],
  ["page.notifications.show", args => showNotification(args)],
]);

function notificationSupport(webPushKey) {
  if (!page || typeof Notification === "undefined") return { kind: "unsupported", reason: "This browser can't show notifications.", permission: "denied" };
  const push = typeof webPushKey === "string" && webPushKey && isSecureContext && "serviceWorker" in navigator && "PushManager" in window;
  return { kind: push ? "push" : "page", permission: Notification.permission };
}

async function notificationPermission() {
  if (!page || typeof Notification === "undefined") return "denied";
  return Notification.permission === "default" ? Notification.requestPermission() : Notification.permission;
}

function keyBytes(base64url) {
  const base64 = base64url.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(base64 + "=".repeat((4 - base64.length % 4) % 4));
  return Uint8Array.from(binary, char => char.charCodeAt(0));
}

function deviceName() {
  const agent = navigator.userAgent;
  const browser = /Edg\//.test(agent) ? "Edge" : /Firefox\//.test(agent) ? "Firefox" : /Chrome\//.test(agent) ? "Chrome" : /Safari\//.test(agent) ? "Safari" : "Browser";
  const system = /iPhone|iPad/.test(agent) ? "iOS" : /Android/.test(agent) ? "Android" : /Mac OS X/.test(agent) ? "macOS" : /Windows/.test(agent) ? "Windows"
    : /Linux/.test(agent) ? "Linux" : "";
  return system ? `${browser} on ${system}` : browser;
}

async function subscribePush(webPushKey) {
  if (!page) throw new Error("Notifications need a browser.");
  if (typeof webPushKey !== "string" || !("serviceWorker" in navigator)) return { name: deviceName() };
  const registration = await navigator.serviceWorker.register("/sw.js");
  await navigator.serviceWorker.ready;
  const key = keyBytes(webPushKey);
  let subscription = await registration.pushManager.getSubscription();
  const current = subscription?.options.applicationServerKey;
  const same = current && new Uint8Array(current).length === key.length && new Uint8Array(current).every((byte, index) => byte === key[index]);
  if (subscription && !same) {
    await subscription.unsubscribe();
    subscription = null;
  }
  subscription ??= await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
  const { endpoint, keys } = subscription.toJSON();
  return { endpoint, keys: { p256dh: keys?.p256dh, auth: keys?.auth }, name: deviceName() };
}

async function unsubscribePush() {
  if (!page || !("serviceWorker" in navigator)) return null;
  const registration = await navigator.serviceWorker.getRegistration("/sw.js").catch(() => undefined);
  await (await registration?.pushManager?.getSubscription().catch(() => null))?.unsubscribe().catch(() => false);
  return null;
}

function showNotification(args) {
  if (!page || typeof Notification === "undefined" || Notification.permission !== "granted") return false;
  const { id, title, body, path, sessionId } = args ?? {};
  if (typeof title !== "string" || typeof body !== "string" || typeof path !== "string" || !path.startsWith("/#/")) return false;
  const watching = Boolean(sessionId) && document.visibilityState === "visible" && document.hasFocus() && location.hash === path.slice(1);
  if (watching) return false;
  const shown = new Notification(title, { body, tag: typeof id === "string" ? id : undefined, icon: "/favicon.svg" });
  shown.onclick = () => {
    window.focus();
    location.hash = path.slice(1);
    shown.close();
  };
  return true;
}

function base64(bytes) {
  let binary = "";
  for (let index = 0; index < bytes.length; index += 0x8000) binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  return btoa(binary);
}

function pickFiles(args) {
  if (!page || typeof document === "undefined") return [];
  const maxBytes = typeof args?.maxBytes === "number" ? args.maxBytes : Infinity;
  return new Promise((resolve, reject) => {
    const input = document.createElement("input");
    input.type = "file";
    input.multiple = args?.multiple !== false;
    if (typeof args?.accept === "string") input.accept = args.accept;
    input.style.display = "none";
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      input.remove();
      Promise.all(Array.from(input.files ?? []).map(async file => ({
        name: file.name, type: file.type, size: file.size,
        ...(file.size <= maxBytes ? { data: base64(new Uint8Array(await file.arrayBuffer())) } : {}),
      }))).then(resolve, reject);
    };
    input.addEventListener("change", finish);
    input.addEventListener("cancel", finish);
    document.body.append(input);
    input.click();
  });
}

async function encodeImage(args) {
  if (!page || typeof document === "undefined") throw new Error("Images can't be drawn here.");
  const { data, maxEdge, budget } = args ?? {};
  if (typeof data !== "string" || typeof maxEdge !== "number" || typeof budget !== "number") throw new Error("Invalid image.");
  const binary = atob(data);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
  const png = bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47;
  let bitmap;
  try { bitmap = await createImageBitmap(new Blob([bytes])); }
  catch { throw new Error("An attached image can't be read. Attach a PNG or JPEG."); }
  try {
    let scale = Math.min(1, maxEdge / Math.max(bitmap.width, bitmap.height));
    for (let attempt = 0; attempt < 6; attempt++, scale *= 0.75) {
      const width = Math.max(1, Math.round(bitmap.width * scale));
      const height = Math.max(1, Math.round(bitmap.height * scale));
      const attempts = [...(png ? [{ mimeType: "image/png" }] : []),
        { mimeType: "image/jpeg", quality: 0.85 }, { mimeType: "image/jpeg", quality: 0.7 }, { mimeType: "image/jpeg", quality: 0.55 }];
      for (const { mimeType, quality } of attempts) {
        const canvas = document.createElement("canvas");
        canvas.width = width;
        canvas.height = height;
        const context = canvas.getContext("2d");
        if (!context) continue;
        if (mimeType === "image/jpeg") {
          context.fillStyle = "#fff";
          context.fillRect(0, 0, width, height);
        }
        context.imageSmoothingQuality = "high";
        context.drawImage(bitmap, 0, 0, width, height);
        const blob = await new Promise(done => canvas.toBlob(done, mimeType, quality));
        if (blob && Math.ceil(blob.size / 3) * 4 <= budget) return { mimeType, data: base64(new Uint8Array(await blob.arrayBuffer())) };
      }
    }
  } finally {
    bitmap.close();
  }
  throw new Error("An attached image is too large to send, even scaled down.");
}

export async function createHost(player) {
  if (page && typeof addEventListener === "function") {
    depth = depthOf(history.state);
    for (const name of ["pushState", "replaceState"]) {
      const original = history[name].bind(history);
      history[name] = (state, unused, url) => {
        original(state, unused, url);
        depth = depthOf(state);
      };
    }
    addEventListener("popstate", event => {
      const left = depth;
      depth = depthOf(event.state);
      const known = Boolean(event.state?.pikibun || event.state?.nshSession);
      const between = known && depth !== left;
      traversedAt = between ? Date.now() : 0;
      if (between && shown && location.hash !== shown) history.replaceState(history.state, "", shown);
    });
    addEventListener("hashchange", () => {
      const traversed = traversedAt && Date.now() - traversedAt < 1000;
      traversedAt = 0;
      if (traversed) return;
      player.hostEvent("page.route", route());
    });
    if ("serviceWorker" in navigator) {
      navigator.serviceWorker.addEventListener("message", event => {
        const data = event.data;
        if (data?.type === "pikibun-open" && typeof data.path === "string" && data.path.startsWith("/#/")) location.hash = data.path.slice(1);
      });
    }
  }
  return {
    call(name, args) {
      const fn = functions.get(name);
      if (!fn) throw new Error(`No host function ${name}.`);
      return fn(args);
    },
  };
}
