import { join } from "node:path";
import { BrowserWindow, clipboard, Menu, net, protocol, screen, session, shell, type MenuItemConstructorOptions, type Session, type WebContents } from "electron";
import { pathToFileURL } from "node:url";
import { navigationDecision, sameServerLink, windowOpenDecision } from "./origin.js";
import { APP_HOST, APP_SCHEME } from "./requests.js";
import type { Bounds, SettingsStore } from "./settings.js";

// Two kinds of windows. Pikibun windows show a server's web app (the primary server, another one this computer connects
// to, or Pikibun on this computer), with no preload and no Node, in their own persistent session; each stays on its one
// server, and links within it can open in a window of their own (a session beside the list, say). Local windows (This
// Mac, Settings) show pages bundled with the app, served by the app's own scheme in the default session, with a preload
// exposing only the typed bridge.

export const REMOTE_PARTITION = "persist:pikibun";
const CSP = "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";
const LOCAL_FILES: Record<string, string> = {
  "/host.html": "text/html; charset=utf-8",
  "/host.js": "text/javascript; charset=utf-8",
  "/settings.html": "text/html; charset=utf-8",
  "/settings.js": "text/javascript; charset=utf-8",
  "/style.css": "text/css; charset=utf-8",
};

/** Before `ready`: the local scheme behaves like a secure, standard origin so CSP 'self' and relative URLs work. */
export function registerLocalScheme(): void {
  protocol.registerSchemesAsPrivileged([{ scheme: APP_SCHEME, privileges: { standard: true, secure: true } }]);
}

/** Serves only the bundled renderer files, on the default session; the remote session cannot load them. */
export function serveLocalPages(rendererDirectory: string): void {
  protocol.handle(APP_SCHEME, async request => {
    const url = new URL(request.url);
    const type = Object.hasOwn(LOCAL_FILES, url.pathname) ? LOCAL_FILES[url.pathname] : undefined;
    if (url.host !== APP_HOST || !type || request.method !== "GET") return new Response("Not found", { status: 404 });
    const file = await net.fetch(pathToFileURL(join(rendererDirectory, url.pathname.slice(1))).href);
    return new Response(file.body, { headers: { "content-type": type, "content-security-policy": CSP, "x-content-type-options": "nosniff" } });
  });
}

/** The remote session grants no permissions beyond clipboard writes (Copy buttons) for the servers the app shows. */
export function hardenRemoteSession(isServer: (origin: string) => boolean): Session {
  const remote = session.fromPartition(REMOTE_PARTITION);
  const allowed = (permission: string, origin: string) => permission === "clipboard-sanitized-write" && isServer(origin);
  remote.setPermissionRequestHandler((_contents, permission, callback, details) => callback(allowed(permission, URL.parse(details.requestingUrl)?.origin ?? "")));
  remote.setPermissionCheckHandler((_contents, permission, origin) => allowed(permission, URL.parse(origin)?.origin ?? ""));
  return remote;
}

function openExternally(url: string): void {
  void shell.openExternal(url).catch(() => {});
}

/**
 * Keeps the remote window on the server and GitHub OAuth; other links open in the default browser, and links of the
 * same server that ask for a new window (target=_blank, a middle click) open in another Pikibun window.
 */
function guardRemote(contents: WebContents, server: () => string, openWindow: (url: string) => void): void {
  const guard = (event: { preventDefault(): void; url: string; isMainFrame: boolean }) => {
    if (!event.isMainFrame) return;
    const decision = navigationDecision(event.url, server());
    if (decision === "allow") return;
    event.preventDefault();
    if (decision === "external") openExternally(event.url);
  };
  contents.on("will-navigate", guard);
  contents.on("will-redirect", guard);
  contents.setWindowOpenHandler(({ url }) => {
    if (sameServerLink(url, server())) openWindow(url);
    else if (windowOpenDecision(url) === "external") openExternally(url);
    return { action: "deny" };
  });
}

/** Local pages never navigate or open windows. */
function guardLocal(contents: WebContents): void {
  contents.on("will-navigate", event => event.preventDefault());
  contents.on("will-redirect", event => event.preventDefault());
  contents.setWindowOpenHandler(() => ({ action: "deny" }));
}

/** Restores saved bounds only when they still fit on a connected display, else just the size, within the display. */
function visibleBounds(bounds: Bounds | undefined): Partial<Bounds> {
  if (!bounds) return {};
  const area = screen.getDisplayMatching(bounds).workArea;
  const fits = bounds.x >= area.x - 50 && bounds.y >= area.y - 50 && bounds.x + bounds.width <= area.x + area.width + 50 && bounds.y + bounds.height <= area.y + area.height + 50;
  return fits ? bounds : { width: Math.min(bounds.width, area.width), height: Math.min(bounds.height, area.height) };
}

/**
 * The browser's own right-click menu: on a link, opening it in a new Pikibun window (the server's own) or the browser;
 * spelling suggestions; then the edit commands that apply where you clicked.
 */
function editContextMenu(window: BrowserWindow, server: () => string, openWindow: (url: string) => void): void {
  window.webContents.on("context-menu", (_event, params) => {
    const link = params.linkURL;
    const linking: MenuItemConstructorOptions[] = link ? [
      ...(sameServerLink(link, server()) ? [{ label: "Open Link in New Window", click: () => openWindow(link) }] : []),
      ...(windowOpenDecision(link) === "external" ? [{ label: "Open Link in Browser", click: () => openExternally(link) }] : []),
      { label: "Copy Link", click: () => clipboard.writeText(link) },
      { type: "separator" },
    ] : [];
    const spelling: MenuItemConstructorOptions[] = params.misspelledWord ? [
      ...params.dictionarySuggestions.map(word => ({ label: word, click: () => window.webContents.replaceMisspelling(word) })),
      { label: "Add to Dictionary", click: () => window.webContents.session.addWordToSpellCheckerDictionary(params.misspelledWord) },
      { type: "separator" },
    ] : [];
    const { canCut, canCopy, canPaste, canSelectAll } = params.editFlags;
    const editing: MenuItemConstructorOptions[] = [
      ...(params.isEditable ? [{ role: "cut", enabled: canCut } as const] : []),
      { role: "copy", enabled: canCopy },
      ...(params.isEditable ? [{ role: "paste", enabled: canPaste } as const] : []),
      { type: "separator" },
      { role: "selectAll", enabled: canSelectAll },
    ];
    Menu.buildFromTemplate([...linking, ...spelling, ...editing]).popup({ window });
  });
}

export interface RemoteWindowOptions {
  icon: string | undefined;
  /** The origin the window shows; the main window's follows Pikibun on this computer while it runs. */
  server: () => string;
  /** The first page: the server, a session in it, or a local server's sign-in link. */
  start?: string;
  /** The main window keeps its bounds in the settings; other windows cascade from the focused one. */
  settings?: SettingsStore;
  /** Shown after the page's title, to tell servers apart. */
  label?: () => string | undefined;
  /** A same-server link that asked for a new window. */
  openWindow(url: string): void;
}

function cascade(): Partial<Bounds> {
  const focused = BrowserWindow.getFocusedWindow();
  if (!focused || focused.isFullScreen()) return {};
  const bounds = focused.getNormalBounds();
  return visibleBounds({ x: bounds.x + 28, y: bounds.y + 28, width: bounds.width, height: bounds.height });
}

/** A Pikibun window: a server's web app, as in a browser, kept on that server. */
export function createRemoteWindow(options: RemoteWindowOptions): BrowserWindow {
  const { settings, server } = options;
  const window = new BrowserWindow({
    width: 1280, height: 860, minWidth: 420, minHeight: 480, title: "Pikibun", show: false,
    ...(options.icon ? { icon: options.icon } : {}),
    ...(settings ? visibleBounds(settings.get().windowBounds) : cascade()),
    webPreferences: { partition: REMOTE_PARTITION, contextIsolation: true, sandbox: true, nodeIntegration: false, webviewTag: false, spellcheck: true },
  });
  guardRemote(window.webContents, server, options.openWindow);
  editContextMenu(window, server, options.openWindow);
  if (options.label) {
    window.on("page-title-updated", (event, title) => {
      const label = options.label?.();
      if (!label) return;
      event.preventDefault();
      window.setTitle(`${title} — ${label}`);
    });
  }
  if (settings) {
    let saving: NodeJS.Timeout | undefined;
    const save = () => {
      clearTimeout(saving);
      saving = setTimeout(() => { if (!window.isDestroyed() && !window.isMinimized() && !window.isFullScreen()) settings.update({ windowBounds: window.getNormalBounds() }); }, 400);
    };
    window.on("resize", save);
    window.on("move", save);
    window.on("close", () => { clearTimeout(saving); if (!window.isMinimized() && !window.isFullScreen()) settings.update({ windowBounds: window.getNormalBounds() }); });
  }
  window.once("ready-to-show", () => window.show());
  // A slow server still gets a visible window rather than none.
  setTimeout(() => { if (!window.isDestroyed() && !window.isVisible()) window.show(); }, 3000);
  // An unreachable server would leave a blank window: say so, with a link back that the navigation guard allows.
  window.webContents.on("did-fail-load", (_event, code, _description, url, isMainFrame) => {
    if (!isMainFrame || code === -3 || URL.parse(url)?.origin !== server()) return;
    void window.loadURL(offlinePage(server())).catch(() => {});
  });
  void window.loadURL(options.start ?? server()).catch(() => {});
  return window;
}

function offlinePage(server: string): string {
  const escaped = server.replace(/[&<>"']/g, char => `&#${char.charCodeAt(0)};`);
  const html = `<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'"><title>Pikibun</title>`
    + `<style>body{font:15px -apple-system,system-ui,sans-serif;margin:0;display:grid;place-items:center;min-height:100vh;background:#f6f5f1;color:#1d1f1d}`
    + `@media(prefers-color-scheme:dark){body{background:#111311;color:#e8e6e1}}main{max-width:28rem;padding:2rem;text-align:center}a{color:#c0491d}</style>`
    + `<main><h1>Pikibun can't reach the server</h1><p>${escaped} did not answer. Check your connection (for Pikibun shared from this computer, its proxy or tunnel), or change the server in Pikibun's Settings.</p><p><a href="${escaped}/">Try again</a></p></main>`;
  return `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;
}

export function createLocalWindow(page: string, options: { title: string; width: number; height: number; preload: string; icon: string | undefined }): BrowserWindow {
  const window = new BrowserWindow({
    width: options.width, height: options.height, minWidth: 380, minHeight: 360, title: options.title, show: false,
    ...(options.icon ? { icon: options.icon } : {}),
    webPreferences: { preload: options.preload, contextIsolation: true, sandbox: true, nodeIntegration: false, webviewTag: false, spellcheck: false },
  });
  guardLocal(window.webContents);
  window.once("ready-to-show", () => window.show());
  void window.loadURL(`${APP_SCHEME}://${APP_HOST}/${page}`).catch(() => {});
  return window;
}
