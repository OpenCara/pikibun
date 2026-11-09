import { Storage } from "nsh";
import { parseRoute, type PageRoute } from "./page";

// What a browser sign-in carries across GitHub's redirect, which returns to the app's root and loses the fragment: the
// invite link it started from, or the page it was started again from (sign-in-again.ts), as the web app keeps them.

const INVITE_KEY = "pikibun.pendingInvite";
const RETURN_KEY = "pikibun.returnAfterSignIn";
/** Kept for a sign-in under way, not for later visits. */
const TTL_MS = 60 * 60 * 1000;

async function put(key: string, value: string): Promise<void> {
  try { await Storage.setItem(key, JSON.stringify({ value, at: Date.now() })); } catch { /* Not kept: the link can be opened again. */ }
}

/** The value kept under `key`, once: reading it forgets it. */
async function take(key: string): Promise<string | null> {
  try {
    const raw = await Storage.getItem(key);
    if (raw === null) return null;
    await Storage.removeItem(key);
    const { value, at } = JSON.parse(raw) as { value?: unknown; at?: unknown };
    return typeof value === "string" && typeof at === "number" && Date.now() - at < TTL_MS ? value : null;
  } catch {
    return null;
  }
}

/** Remembers the invite link a signed-out visitor opened, for after they sign in. */
export const rememberInvite = (token: string) => put(INVITE_KEY, token);

/** The invite token a sign-in started from, once. */
export const takeRememberedInvite = () => take(INVITE_KEY);

/** Remembers the page (its address, `#/…`) a sign-in is started again from, to come back to. */
export const rememberReturn = (hash: string) => put(RETURN_KEY, hash);

/** The page a sign-in started again returns to, once; null after any other sign-in. */
export async function takeReturn(): Promise<PageRoute | null> {
  const hash = await take(RETURN_KEY);
  return hash?.startsWith("#/") ? parseRoute(hash) : null;
}
