import { platform, Storage } from "nsh";
import { APP_VERSION } from "../app-version";

export interface PushPress {
  id: string;
  threadId: string;
  payload: unknown;
}

export interface PushPresentation {
  banner?: boolean;
  list?: boolean;
  sound?: boolean;
  badge?: boolean;
}

export interface PushModule {
  available(): Promise<boolean>;
  register(): Promise<{ token: string }>;
  setForegroundPresentation(presentation?: PushPresentation | null, thread?: { threadId: string } | null): void;
  on(event: "token", listener: (token: { token: string }) => void): () => void;
  on(event: "press", listener: (press: PushPress) => void): () => void;
}

const MODULE = "nsh-extra";
const EXPO_TOKEN_URL = "https://exp.host/--/api/v2/push/getExpoPushToken";
const EXPO_PROJECT_ID = "a8f1f8fe-f8a6-446d-8864-a8bc5df1e437";
const APP_ID = "com.pikibun.app";
const INSTALL_KEY = "pikibun.pushInstall";
const EXPO_TOKEN = /^Expo(?:nent)?PushToken\[[A-Za-z0-9_-]{10,200}\]$/;
const REGISTER_TIMEOUT_MS = 20_000;

let configured: PushModule | null | undefined;
let loading: Promise<PushModule | null> | undefined;

export function configurePush(module: PushModule | null | undefined): void {
  configured = module;
  loading = undefined;
}

export function pushModule(): Promise<PushModule | null> {
  if (configured !== undefined) return Promise.resolve(configured);
  loading ??= (async () => {
    if (platform.os !== "ios") return null;
    try {
      const { Push } = await import(MODULE) as { Push?: PushModule };
      return Push && await Push.available() ? Push : null;
    } catch {
      return null;
    }
  })();
  return loading;
}

async function installId(): Promise<string> {
  const known = await Storage.getItem(INSTALL_KEY).catch(() => null);
  if (known && /^[0-9a-f-]{36}$/.test(known)) return known;
  const made = crypto.randomUUID().toLowerCase();
  await Storage.setItem(INSTALL_KEY, made);
  return made;
}

export async function deviceToken(push: PushModule): Promise<string> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("Apple's push service didn't answer. Check the connection, then try again.")), REGISTER_TIMEOUT_MS);
  });
  try {
    return (await Promise.race([push.register(), late])).token;
  } finally {
    clearTimeout(timer);
  }
}

export async function expoPushToken(token: string): Promise<string> {
  const timeout = new AbortController();
  const timer = setTimeout(() => timeout.abort(), REGISTER_TIMEOUT_MS);
  try {
    const response = await fetch(EXPO_TOKEN_URL, {
      method: "POST", signal: timeout.signal, headers: { Accept: "application/json", "Content-Type": "application/json" },
      body: JSON.stringify({ type: "apns", deviceId: await installId(), development: APP_VERSION === "dev", appId: APP_ID, deviceToken: token, projectId: EXPO_PROJECT_ID }),
    });
    const answer = await response.json().catch(() => null) as { data?: { expoPushToken?: unknown } } | null;
    const expo = answer?.data?.expoPushToken;
    if (!response.ok || typeof expo !== "string" || !EXPO_TOKEN.test(expo)) throw new Error(`Expo's push service didn't take this device (HTTP ${response.status}).`);
    return expo;
  } catch (reason) {
    if (timeout.signal.aborted) throw new Error("Expo's push service didn't answer. Check the connection, then try again.");
    throw reason;
  } finally {
    clearTimeout(timer);
  }
}
