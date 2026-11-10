import { host, platform, signal } from "nsh";

export type PageRoute =
  | { name: "home" }
  | { name: "sessions" }
  | { name: "session"; sessionId: string }
  | { name: "new"; workspaceId: string }
  | { name: "settings"; section?: string; id?: string }
  | { name: "shared"; token: string }
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

const hasPage = () => platform.os === "web" && host.available();

export const pageAvailable = hasPage;

export const pageRoute = signal<PageRoute>({ name: "home" });

export function startPage(): void {
  if (!hasPage()) return;
  host.call<string>("page.route").then(hash => pageRoute.set(parseRoute(hash ?? "")), () => undefined);
  host.on<string>("page.route", hash => pageRoute.set(parseRoute(hash ?? "")));
}

export function showRoute(route: PageRoute): void {
  shown = route;
  if (!hasPage()) return;
  host.call("page.setRoute", { hash: routeHash(route) }).catch(() => undefined);
}

let shown: PageRoute = { name: "home" };
export const shownRoute = (): PageRoute => shown;

export function openServerPage(path: string): boolean {
  if (!hasPage()) return false;
  host.call("page.open", { path }).catch(() => undefined);
  return true;
}

export async function pageQuery(): Promise<URLSearchParams> {
  if (!hasPage()) return new URLSearchParams();
  try {
    return new URLSearchParams((await host.call<string>("page.query")) ?? "");
  } catch {
    return new URLSearchParams();
  }
}

export function authorizeInPage(url: string): boolean {
  if (!hasPage()) return false;
  host.call("page.authorize", { url }).catch(() => undefined);
  return true;
}

export interface PageFile {
  name: string;
  type: string;
  size: number;
  data?: string;
}

export async function pickFilesInPage(options: { accept?: string; maxBytes: number }): Promise<PageFile[]> {
  return (await host.call<PageFile[]>("page.pickFiles", { multiple: true, ...options }, { timeout: 0 })) ?? [];
}

export async function encodeImageInPage(options: { data: string; maxEdge: number; budget: number }): Promise<{ mimeType: "image/png" | "image/jpeg"; data: string }> {
  const result = await host.call<{ mimeType: "image/png" | "image/jpeg"; data: string }>("page.encodeImage", options, { timeout: 60_000 });
  if (!result || typeof result.data !== "string") throw new Error("An attached image is too large to send, even scaled down.");
  return result;
}
