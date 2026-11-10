import { openUrl } from "nsh";
import { openServerPage } from "./page";
import { usesBrowserSession } from "./server";

export const opensServerPages = usesBrowserSession;

export function openServerLink(path: string): void {
  if (!openServerPage(path)) void openUrl(path).catch(() => undefined);
}

export function openExternal(url: string): void {
  void openUrl(url).catch(() => undefined);
}

export function messageLinkTarget(url: string): string | null {
  const address = url.trim();
  return /^(https?:\/\/|mailto:)/i.test(address) ? address : null;
}

export function openMessageLink(url: string): void {
  const address = messageLinkTarget(url);
  if (address) openExternal(address);
}
