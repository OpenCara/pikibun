import { platform, signal, Storage, untracked, type Accessor } from "nsh";
import { ApiError, createApi, errorMessage, type Api, type RequestOptions, type UserProfile } from "../shared";
import { clearDrafts } from "./drafts";
import { currentOrigin, DEFAULT_ORIGIN, displayOrigin, parseOrigin, usesBrowserSession } from "./server";

const TOKEN_KEY = "pikibun.token";
const EXPIRES_KEY = "pikibun.tokenExpires";
const ORIGIN_KEY = "pikibun.origin";
const SERVERS_KEY = "pikibun.servers";
export const SIGN_IN_SCHEME = "pikibun";
const deviceName = () => `Pikibun (${platform.os})`;

export type SignupMode = "open" | "invite" | "off";

export interface SignInMethods {
  githubConfigured?: boolean;
  codeSignIn?: boolean;
  githubSignup?: SignupMode;
  passwordAuth?: boolean;
  passwordSignup?: SignupMode;
  testMode?: boolean;
  localServer?: { claimed: boolean };
}

export type AuthState =
  | { status: "loading" }
  | { status: "signedOut"; origin: string; notice?: string; adding?: boolean; fresh?: boolean }
  | { status: "unreachable"; origin: string; error: string }
  | { status: "signedIn"; origin: string; token: string | null; expiresAt: string | null; user: UserProfile; api: Api };

export type SignedIn = Extract<AuthState, { status: "signedIn" }>;

const authState = signal<AuthState>({ status: "loading" });
export const auth: Accessor<AuthState> = authState;

const account = (value: AuthState) => (value.status === "signedIn" ? `${value.origin} ${value.user.id}` : null);

function setAuth(next: AuthState) {
  const previous = account(untracked(authState));
  if (previous !== null && previous !== account(next)) clearDrafts();
  authState.set(next);
}

export function session(): SignedIn {
  const state = auth();
  if (state.status !== "signedIn") throw new Error("This screen needs a signed-in user.");
  return state;
}

export function updateUser(user: UserProfile): void {
  const current = untracked(authState);
  if (current.status === "signedIn" && current.user.id === user.id) authState.set({ ...current, user });
}

export interface SavedServer { origin: string; token: string; expiresAt: string | null; account: string }

const savedServers = signal<SavedServer[]>([]);
export const servers: Accessor<SavedServer[]> = savedServers;

function validServer(value: unknown): value is SavedServer {
  const item = value as Partial<SavedServer> | null;
  return !!item && typeof item === "object" && typeof item.origin === "string" && "origin" in parseOrigin(item.origin) && typeof item.token === "string" && !!item.token
    && (item.expiresAt === null || typeof item.expiresAt === "string") && typeof item.account === "string";
}

async function loadServers(): Promise<void> {
  let list: SavedServer[] = [];
  try {
    const parsed: unknown = JSON.parse(await Storage.getItem(SERVERS_KEY) ?? "[]");
    if (Array.isArray(parsed)) list = parsed.filter(validServer).filter(item => !item.expiresAt || !(Date.parse(item.expiresAt) <= Date.now()));
  } catch {
    list = [];
  }
  savedServers.set(list.filter((item, index) => list.findIndex(other => other.origin === item.origin) === index));
}

async function storeServers(list: SavedServer[]): Promise<void> {
  savedServers.set(list);
  if (list.length) await Storage.setItem(SERVERS_KEY, JSON.stringify(list));
  else await Storage.removeItem(SERVERS_KEY);
}

const forgetServers = (drop: (item: SavedServer) => boolean) => storeServers(untracked(savedServers).filter(item => !drop(item)));

const accountName = (user: UserProfile) => (user.username || user.githubLogin ? `@${user.username || user.githubLogin}` : user.displayName);

let liveToken: string | null = null;
const EXPIRED = "Your sign-in expired or was revoked. Sign in again to continue.";

async function clearCredentials() {
  await Promise.all([Storage.removeItem(TOKEN_KEY), Storage.removeItem(EXPIRES_KEY)]);
}

function expire(token: string | null) {
  if (liveToken !== token) return;
  liveToken = null;
  void clearCredentials();
  if (token) void forgetServers(item => item.token === token);
  const current = auth();
  if (current.status === "signedIn" && current.token === token) setAuth({ status: "signedOut", origin: current.origin, notice: EXPIRED });
}

function guarded(inner: Api, token: string | null): Api {
  return async function api<T>(path: string, options?: RequestOptions): Promise<T> {
    try {
      return await inner<T>(path, options);
    } catch (reason) {
      if (reason instanceof ApiError && reason.status === 401) expire(token);
      throw reason;
    }
  };
}

async function pageOrigin(): Promise<string> {
  try {
    const response = await fetch("/api/health", { credentials: "same-origin" });
    return new URL(response.url).origin;
  } catch {
    return "";
  }
}

const browserApi = () => createApi({ baseUrl: "", auth: "cookie" });

async function establish(origin: string, token: string, expiresAt: string | null, user?: UserProfile) {
  const api = guarded(createApi({ baseUrl: origin, auth: () => token }), token);
  liveToken = token;
  let profile = user;
  try {
    profile ??= (await api<{ user: UserProfile }>("/api/me")).user;
  } catch (reason) {
    if (liveToken === token) liveToken = null;
    throw reason;
  }
  await Promise.all([
    Storage.setItem(TOKEN_KEY, token),
    Storage.setItem(ORIGIN_KEY, origin),
    expiresAt ? Storage.setItem(EXPIRES_KEY, expiresAt) : Storage.removeItem(EXPIRES_KEY),
    storeServers([...untracked(savedServers).filter(item => item.origin !== origin), { origin, token, expiresAt, account: accountName(profile) }]
      .sort((a, b) => a.origin.localeCompare(b.origin))),
  ]);
  setAuth({ status: "signedIn", origin, token, expiresAt, user: profile, api });
}

async function establishBrowserSession(): Promise<boolean> {
  const origin = await pageOrigin();
  const api = browserApi();
  try {
    const { user } = await api<{ user: UserProfile }>("/api/me");
    liveToken = null;
    setAuth({ status: "signedIn", origin, token: null, expiresAt: null, user, api: guarded(api, null) });
    return true;
  } catch (reason) {
    if (reason instanceof ApiError && reason.status === 401) {
      setAuth({ status: "signedOut", origin });
      return false;
    }
    setAuth({ status: "unreachable", origin, error: errorMessage(reason) });
    return false;
  }
}

export async function restore(): Promise<void> {
  setAuth({ status: "loading" });
  if (usesBrowserSession) {
    await establishBrowserSession();
    return;
  }
  const [storedOrigin, token, expiresAt] = await Promise.all([Storage.getItem(ORIGIN_KEY), Storage.getItem(TOKEN_KEY), Storage.getItem(EXPIRES_KEY), loadServers()]);
  const origin = storedOrigin == null ? DEFAULT_ORIGIN : currentOrigin(storedOrigin);
  if (storedOrigin != null && origin !== storedOrigin) await Storage.setItem(ORIGIN_KEY, origin);
  if (!token) return setAuth({ status: "signedOut", origin, ...(storedOrigin == null ? { fresh: true } : {}) });
  try {
    await establish(origin, token, expiresAt);
  } catch (reason) {
    if (reason instanceof ApiError && reason.status === 401) {
      await Promise.all([clearCredentials(), forgetServers(item => item.origin === origin)]);
      setAuth({ status: "signedOut", origin, notice: EXPIRED });
    } else {
      setAuth({ status: "unreachable", origin, error: errorMessage(reason) });
    }
  }
}

export async function rememberServer(origin: string): Promise<void> {
  await Storage.setItem(ORIGIN_KEY, origin);
}

export async function signInMethods(origin: string): Promise<SignInMethods> {
  return createApi({ baseUrl: origin, auth: () => null })<SignInMethods>("/api/health");
}

const SIGN_IN_CODE = /^[A-Za-z0-9_-]{43}$/;

export interface SignInCode { origin: string | null; code: string }

export function parseSignInCode(input: string): SignInCode | null {
  const text = input.trim();
  if (SIGN_IN_CODE.test(text)) return { origin: null, code: text };
  if (!isCodeLink(text)) return null;
  const params = new URL(text).searchParams;
  const code = params.get("code") ?? "";
  if (!SIGN_IN_CODE.test(code)) return null;
  const server = params.get("server");
  if (server === null) return { origin: null, code };
  const parsed = parseOrigin(server);
  return "origin" in parsed ? { origin: currentOrigin(parsed.origin), code } : null;
}

export function isCodeLink(url: string): boolean {
  try {
    const parsed = new URL(url.trim());
    return parsed.protocol === `${SIGN_IN_SCHEME}:` && parsed.host === "auth" && parsed.pathname === "/code";
  } catch {
    return false;
  }
}

export async function signInWithCode(origin: string, code: string): Promise<void> {
  const signIn = await createApi({ baseUrl: origin, auth: () => null })<{ token: string; expiresAt: string; user: UserProfile }>(
    "/api/auth/native/code", { method: "POST", body: { code, deviceName: deviceName() } });
  await establish(origin, signIn.token, signIn.expiresAt, signIn.user);
}

export async function signInWithToken(origin: string, token: string): Promise<void> {
  await establish(origin, token.trim(), null);
}

const LOCAL_TOKEN = /^[A-Za-z0-9_-]{43}$/;

export function localSignInToken(origin: string, link: string): string | null {
  const typed = link.trim();
  if (LOCAL_TOKEN.test(typed)) return typed;
  try {
    const url = new URL(typed);
    const token = url.searchParams.get("token") ?? "";
    return url.origin === new URL(origin).origin && url.pathname === "/api/auth/local" && LOCAL_TOKEN.test(token) ? token : null;
  } catch {
    return null;
  }
}

export async function signInToLocalServer(origin: string, token: string, options: { switching?: boolean } = {}): Promise<void> {
  const signIn = await createApi({ baseUrl: origin, auth: () => null })<{ token: string; expiresAt: string; user: UserProfile }>(
    "/api/auth/native/local", { method: "POST", body: { token, deviceName: deviceName() } });
  if (options.switching) await establishInstead(origin, signIn.token, signIn.expiresAt, signIn.user);
  else await establish(origin, signIn.token, signIn.expiresAt, signIn.user);
}

async function establishInstead(origin: string, token: string, expiresAt: string | null, user: UserProfile): Promise<void> {
  setAuth({ status: "loading" });
  try {
    await establish(origin, token, expiresAt, user);
  } catch (reason) {
    await restore();
    throw reason;
  }
}

export async function switchServer(origin: string): Promise<void> {
  const saved = untracked(savedServers).find(item => item.origin === origin);
  if (!saved) throw new Error(`This app isn't signed in to ${displayOrigin(origin)} any more. Add it again.`);
  let user: UserProfile;
  try {
    user = (await createApi({ baseUrl: origin, auth: () => saved.token })<{ user: UserProfile }>("/api/me")).user;
  } catch (reason) {
    if (reason instanceof ApiError && reason.status === 401) {
      await forgetServers(item => item.origin === origin);
      throw new Error(`Your sign-in to ${displayOrigin(origin)} expired or was revoked. Add it again to sign in.`);
    }
    throw new Error(`Can't reach ${displayOrigin(origin)}: ${errorMessage(reason)}`);
  }
  await establishInstead(origin, saved.token, saved.expiresAt, user);
}

export function addServer(): void {
  const state = untracked(authState);
  if (state.status !== "signedIn" || usesBrowserSession) return;
  setAuth({ status: "signedOut", origin: state.origin, adding: true });
}

async function signedOutRequest<T>(path: string, body: Record<string, string>, failed: string): Promise<T> {
  const response = await fetch(path, {
    method: "POST",
    credentials: "same-origin",
    headers: { Accept: "application/json", "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const answer = await response.json().catch(() => null) as { error?: string | { message?: string } } | null;
  if (!response.ok) {
    const error = answer?.error;
    throw new Error(typeof error === "string" ? error : error?.message ?? `${failed} (HTTP ${response.status}).`);
  }
  return answer as T;
}

export async function signInWithPassword(username: string, password: string): Promise<void> {
  await signedOutRequest("/api/auth/password/login", { username, password }, "Sign-in failed");
  if (!await establishBrowserSession()) throw new Error("Signed in, but the server did not keep the session. Check that cookies are allowed.");
}

export async function signUpWithPassword(username: string, password: string, inviteToken?: string): Promise<void> {
  await signedOutRequest("/api/auth/password/signup", { username, password, ...(inviteToken !== undefined ? { inviteToken } : {}) }, "Creating the account failed");
  if (!await establishBrowserSession()) throw new Error("Account created, but the server did not keep the session. Check that cookies are allowed.");
}

export async function startGitHubInviteSignIn(inviteToken: string): Promise<string> {
  const { url } = await signedOutRequest<{ url?: unknown }>("/api/auth/github/start", { inviteToken }, "GitHub sign-in could not start");
  if (typeof url !== "string") throw new Error("GitHub sign-in could not start.");
  return url;
}

export const checkBrowserSession = establishBrowserSession;

const LOGOUT_TIMEOUT_MS = 10_000;

export async function signOut(next: { origin?: string } = {}): Promise<void> {
  const state = auth();
  if (state.status !== "signedIn" && state.status !== "unreachable") return;
  const origin = state.origin;
  let notice: string | undefined;
  let logout: ((signal: AbortSignal) => Promise<unknown>) | null = null;
  if (state.status === "signedIn") {
    liveToken = null;
    logout = signal => state.api("/api/auth/logout", { method: "POST", signal });
  } else if (!usesBrowserSession) {
    const token = await Storage.getItem(TOKEN_KEY);
    if (token) logout = signal => createApi({ baseUrl: origin, auth: () => token })("/api/auth/logout", { method: "POST", signal });
  }
  if (logout) {
    const timeout = new AbortController();
    const timer = setTimeout(() => timeout.abort(), LOGOUT_TIMEOUT_MS);
    try {
      await logout(timeout.signal);
    } catch (reason) {
      if (!(reason instanceof ApiError && reason.status === 401)) {
        const why = timeout.signal.aborted ? "it didn't answer" : errorMessage(reason);
        notice = `Signed out on this device, but the server could not revoke the sign-in (${why}). Revoke it under Settings › Profile on the web.`;
      }
    } finally {
      clearTimeout(timer);
    }
  }
  await Promise.all([clearCredentials(), forgetServers(item => item.origin === origin)]);
  setAuth({ status: "signedOut", origin: next.origin ?? origin, notice });
}
