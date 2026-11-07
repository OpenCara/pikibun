import { host, platform, signal } from "nsh";

/**
 * Where the app is, as the address bar shows it on the web: the web app's routes, kept so links people already have
 * (and the server's own: notifications, share and invite links) open the same place. Native platforms have no
 * address; the app navigates the same way without one.
 */
export type PageRoute =
  | { name: "home" }
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
    case "session": return `#/s/${encodeURIComponent(route.sessionId)}`;
    case "new": return `#/w/${encodeURIComponent(route.workspaceId)}/new`;
    case "settings": return `#/settings${route.section ? `/${encodeURIComponent(route.section)}` : ""}${route.section && route.id ? `/${encodeURIComponent(route.id)}` : ""}`;
    case "shared": return `#/shared/${encodeURIComponent(route.token)}`;
    case "join": return `#/join/${encodeURIComponent(route.token)}`;
  }
}

/** On the web, the page's host (web/host.js) tells the address and follows the app. */
const hasPage = () => platform.os === "web" && host.available();

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
