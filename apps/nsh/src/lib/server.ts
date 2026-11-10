import { platform } from "nsh";

export const DEFAULT_ORIGIN = "https://pikibun.com";

const movedOrigins: Record<string, string> = { "https://preview.pikibun.com": "https://pikibun.com" };

export const currentOrigin = (origin: string) => movedOrigins[origin] ?? origin;

const localHosts = ["localhost", "127.0.0.1"];

export const usesBrowserSession = platform.os === "web";

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

export const displayOrigin = (origin: string) => origin.replace(/^https:\/\//, "") || "this server";
