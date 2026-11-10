import { Storage } from "nsh";
import { parseRoute, type PageRoute } from "./page";

const INVITE_KEY = "pikibun.pendingInvite";
const RETURN_KEY = "pikibun.returnAfterSignIn";
const TTL_MS = 60 * 60 * 1000;

async function put(key: string, value: string): Promise<void> {
  try { await Storage.setItem(key, JSON.stringify({ value, at: Date.now() })); } catch { }
}

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

export const rememberInvite = (token: string) => put(INVITE_KEY, token);

export const takeRememberedInvite = () => take(INVITE_KEY);

export const rememberReturn = (hash: string) => put(RETURN_KEY, hash);

export async function takeReturn(): Promise<PageRoute | null> {
  const hash = await take(RETURN_KEY);
  return hash?.startsWith("#/") ? parseRoute(hash) : null;
}
