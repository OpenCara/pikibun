import { openUrl } from "nsh";
import { openServerPage } from "./page";
import { usesBrowserSession } from "./server";

/**
 * Whether the server's own pages that need the browser's sign-in (GitHub sign-in, a document provider's OAuth) can be
 * opened: on the web, where the app runs in the server's page with its session cookie. A native app's sign-in is a
 * token those pages don't see, so it points people at the web app for them.
 */
export const opensServerPages = usesBrowserSession;

/** Goes to one of the server's pages in place of the app (web only; see `opensServerPages`). */
export function openServerLink(path: string): void {
  if (!openServerPage(path)) void openUrl(path).catch(() => undefined);
}

/** Opens an outside address (a pull request, a document) in the browser. */
export function openExternal(url: string): void {
  void openUrl(url).catch(() => undefined);
}
