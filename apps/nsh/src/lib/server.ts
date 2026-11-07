import { platform } from "nsh";

export const DEFAULT_ORIGIN = "https://pikibun.com";

/** Hosts reachable over plain HTTP: a server running on this machine (a simulator shares its network). */
const localHosts = ["localhost", "127.0.0.1"];

/**
 * On the web the client is served by the Pikibun server itself (under /nsh/) and signs in with that server's browser
 * session, as the React web app does: same-origin cookies and a CSRF token. Native platforms keep a bearer token.
 */
export const usesBrowserSession = platform.os === "web";

/** A server origin from what the user typed: scheme and host (with port), no path. HTTPS, or HTTP to this machine. */
export function parseOrigin(input: string): { origin: string } | { error: string } {
  let text = input.trim().replace(/\/+$/, "");
  if (!text) return { error: "Enter the server address, e.g. https://pikibun.com." };
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) text = `https://${text}`;
  const match = /^(https?):\/\/(\[[0-9a-f:.]+\]|[a-z0-9.-]+)(:\d{1,5})?$/i.exec(text);
  if (!match) return { error: "Enter only the server address (scheme and host), without a path." };
  const scheme = match[1]!.toLowerCase();
  const host = match[2]!.toLowerCase();
  const origin = `${scheme}://${host}${match[3] ?? ""}`;
  if (scheme === "https" || localHosts.includes(host)) return { origin };
  return { error: "Use https://, or http:// only for localhost or 127.0.0.1." };
}

/** The origin without its scheme, for compact display. */
export const displayOrigin = (origin: string) => origin.replace(/^https:\/\//, "") || "this server";
