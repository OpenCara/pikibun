import { host, platform, signal } from "nsh";

/**
 * Where the app is, as the address bar shows it on the web: the web app's routes, kept so links people already have
 * (and the server's own: notifications, share and invite links) open the same place. Native platforms have no
 * address; the app navigates the same way without one.
 */
export type PageRoute =
  | { name: "home" }
  /** Every session, searchable. */
  | { name: "sessions" }
  | { name: "session"; sessionId: string }
  | { name: "new"; workspaceId: string }
  | { name: "settings"; section?: string; id?: string }
  /** A session's share link: the token lives in the fragment, so opening the link never sends it to the server. */
  | { name: "shared"; token: string }
  /** A workspace's invite link, also with its token in the fragment. */
  | { name: "join"; token: string };

function decode(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try { return decodeURIComponent(value); } catch { return undefined; }
}

export function parseRoute(hash: string): PageRoute {
  const [head, first, second] = hash.replace(/^#\/?/, "").split("/").filter(Boolean);
  if (head === "s" && decode(first)) return { name: "session", sessionId: decode(first)! };
  if (head === "sessions") return { name: "sessions" };
  if (head === "shared" && decode(first)) return { name: "shared", token: decode(first)! };
  if (head === "join" && decode(first)) return { name: "join", token: decode(first)! };
  if (head === "w" && decode(first) && second === "new") return { name: "new", workspaceId: decode(first)! };
  if (head === "settings") {
    const section = decode(first);
    const id = decode(second);
    return { name: "settings", ...(section ? { section } : {}), ...(id ? { id } : {}) };
  }
  return { name: "home" };
}

export function routeHash(route: PageRoute): string {
  switch (route.name) {
    case "home": return "#/";
    case "sessions": return "#/sessions";
    case "session": return `#/s/${encodeURIComponent(route.sessionId)}`;
    case "new": return `#/w/${encodeURIComponent(route.workspaceId)}/new`;
    case "settings": return `#/settings${route.section ? `/${encodeURIComponent(route.section)}` : ""}${route.section && route.id ? `/${encodeURIComponent(route.id)}` : ""}`;
    case "shared": return `#/shared/${encodeURIComponent(route.token)}`;
    case "join": return `#/join/${encodeURIComponent(route.token)}`;
  }
}

/** On the web, the page's host (web/host.js) tells the address and follows the app. */
const hasPage = () => platform.os === "web" && host.available();

/** Whether the app runs in a browser's page, whose host does what NSH's web runtime can't (pick any file, draw an image). */
export const pageAvailable = hasPage;

/** The route the page was opened at, or the user went to by editing the address or following a link. */
export const pageRoute = signal<PageRoute>({ name: "home" });

/** Reads the page's address and follows its changes. Call once, from the root component. */
export function startPage(): void {
  if (!hasPage()) return;
  host.call<string>("page.route").then(hash => pageRoute.set(parseRoute(hash ?? "")), () => undefined);
  host.on<string>("page.route", hash => pageRoute.set(parseRoute(hash ?? "")));
}

/**
 * Shows where the app is in the address bar (no history entry of its own; Native Shell keeps those, and the page's host
 * keeps their addresses right as Native Shell pushes and pops them: see web/host.js).
 */
export function showRoute(route: PageRoute): void {
  if (!hasPage()) return;
  host.call("page.setRoute", { hash: routeHash(route) }).catch(() => undefined);
}

/** Opens one of the server's own pages in place of the app (the web's GitHub sign-in). False where there is no page. */
export function openServerPage(path: string): boolean {
  if (!hasPage()) return false;
  host.call("page.open", { path }).catch(() => undefined);
  return true;
}

/**
 * The page's query (`?error=…`), where the server's GitHub sign-in sends the browser back when it refused. Empty where
 * there is no page.
 */
export async function pageQuery(): Promise<URLSearchParams> {
  if (!hasPage()) return new URLSearchParams();
  try {
    return new URLSearchParams((await host.call<string>("page.query")) ?? "");
  } catch {
    return new URLSearchParams();
  }
}

/** Goes to GitHub's authorization page the server answered with, in place of the app. False where there is no page. */
export function authorizeInPage(url: string): boolean {
  if (!hasPage()) return false;
  host.call("page.authorize", { url }).catch(() => undefined);
  return true;
}

/** A file picked in the page: its bytes (base64), or none when it was larger than the pick allowed. */
export interface PageFile {
  name: string;
  type: string;
  size: number;
  data?: string;
}

/** The browser's own file chooser (web only): the files the person picked, `[]` when they cancelled. */
export async function pickFilesInPage(options: { accept?: string; maxBytes: number }): Promise<PageFile[]> {
  // The person takes their time choosing: no time limit.
  return (await host.call<PageFile[]>("page.pickFiles", { multiple: true, ...options }, { timeout: 0 })) ?? [];
}

/**
 * An image drawn again in the page (web only), within `maxEdge` pixels and `budget` characters of base64, as the web
 * app's chat box does: PNG where it fits, else JPEG compressed a little more each time.
 */
export async function encodeImageInPage(options: { data: string; maxEdge: number; budget: number }): Promise<{ mimeType: "image/png" | "image/jpeg"; data: string }> {
  const result = await host.call<{ mimeType: "image/png" | "image/jpeg"; data: string }>("page.encodeImage", options, { timeout: 60_000 });
  if (!result || typeof result.data !== "string") throw new Error("An attached image is too large to send, even scaled down.");
  return result;
}
