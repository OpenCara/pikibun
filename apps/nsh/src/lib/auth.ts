import { platform, signal, Storage, untracked, type Accessor } from "nsh";
import { ApiError, createApi, errorMessage, type Api, type RequestOptions, type UserProfile } from "../shared";
import { clearDrafts } from "./drafts";
import { createPkce } from "./pkce";
import { currentOrigin, DEFAULT_ORIGIN, usesBrowserSession } from "./server";

const signInRefusals: Record<string, string> = {
  invite_required: "This server takes new accounts only through a workspace's invite link. Open the link in a browser to create your account, then sign in here.",
  signup_closed: "This server doesn't take new accounts. Ask its operator to add you.",
  too_many_pending: "The workspace that invited you has too many people waiting to join. Ask an owner or admin.",
};

const TOKEN_KEY = "pikibun.token";
const EXPIRES_KEY = "pikibun.tokenExpires";
const ORIGIN_KEY = "pikibun.origin";
const CALLBACK_PATH = "/api/auth/native/done";
const deviceName = () => `Pikibun NSH (${platform.os})`;

export type SignupMode = "open" | "invite" | "off";

export interface SignInMethods {
  githubConfigured?: boolean;
  githubSignup?: SignupMode;
  passwordAuth?: boolean;
  passwordSignup?: SignupMode;
  testMode?: boolean;
  localServer?: { claimed: boolean };
}

export type AuthState =
  | { status: "loading" }
  | { status: "signedOut"; origin: string; notice?: string }
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

let liveToken: string | null = null;
const EXPIRED = "Your sign-in expired or was revoked. Sign in again to continue.";

async function clearCredentials() {
  await Promise.all([Storage.removeItem(TOKEN_KEY), Storage.removeItem(EXPIRES_KEY)]);
}

function expire(token: string | null) {
  if (liveToken !== token) return;
  liveToken = null;
  void clearCredentials();
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
  const [storedOrigin, token, expiresAt] = await Promise.all([Storage.getItem(ORIGIN_KEY), Storage.getItem(TOKEN_KEY), Storage.getItem(EXPIRES_KEY)]);
  const origin = storedOrigin == null ? DEFAULT_ORIGIN : currentOrigin(storedOrigin);
  if (storedOrigin != null && origin !== storedOrigin) await Storage.setItem(ORIGIN_KEY, origin);
  if (!token) return setAuth({ status: "signedOut", origin });
  try {
    await establish(origin, token, expiresAt);
  } catch (reason) {
    if (reason instanceof ApiError && reason.status === 401) {
      await clearCredentials();
      setAuth({ status: "signedOut", origin, notice: EXPIRED });
    } else {
      setAuth({ status: "unreachable", origin, error: errorMessage(reason) });
    }
  }
}

export async function signInMethods(origin: string): Promise<SignInMethods> {
  return createApi({ baseUrl: origin, auth: () => null })<SignInMethods>("/api/health");
}

export interface GitHubSignIn {
  url: string;
  isCallback(url: string): boolean;
  finish(callbackUrl: string): Promise<void>;
}

export async function startGitHubSignIn(origin: string): Promise<GitHubSignIn> {
  const health = await signInMethods(origin);
  if (health.githubConfigured === false) {
    throw new Error("GitHub sign-in is not configured on this server. The operator needs to configure the GitHub OAuth app and the server's GITHUB_CLIENT_ID, GITHUB_CLIENT_SECRET and VAULT_KEY settings.");
  }
  const { verifier, challenge, state } = await createPkce();
  return {
    url: `${origin}/api/auth/native/start?challenge=${challenge}&state=${state}&callback=page`,
    isCallback: url => isCallbackPage(origin, url),
    async finish(callbackUrl: string) {
      if (!isCallbackPage(origin, callbackUrl)) throw new Error("The sign-in ended somewhere unexpected. Try again.");
      const params = new URL(callbackUrl).searchParams;
      if (params.get("state") !== state) throw new Error("The sign-in response did not match this attempt. Try again.");
      const error = params.get("error");
      if (error) throw new Error(signInRefusals[error] ?? `GitHub sign-in did not complete: ${error.slice(0, 300)}`);
      const code = params.get("code");
      if (!code) throw new Error("The server did not return a sign-in code. Try again.");
      const exchange = await createApi({ baseUrl: origin, auth: () => null })<{ token: string; expiresAt: string; user: UserProfile }>(
        "/api/auth/native/token", { method: "POST", body: { code, verifier, deviceName: deviceName() } });
      await establish(origin, exchange.token, exchange.expiresAt, exchange.user);
    },
  };
}

function isCallbackPage(origin: string, url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.origin === new URL(origin).origin && parsed.pathname === CALLBACK_PATH;
  } catch {
    return false;
  }
}

export async function signInWithToken(origin: string, token: string): Promise<void> {
  await establish(origin, token.trim(), null);
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

export async function signInWithPassword(origin: string, username: string, password: string): Promise<void> {
  if (!usesBrowserSession) {
    const signIn = await createApi({ baseUrl: origin, auth: () => null })<{ token: string; expiresAt: string; user: UserProfile }>(
      "/api/auth/native/password", { method: "POST", body: { username, password, deviceName: deviceName() } });
    await establish(origin, signIn.token, signIn.expiresAt, signIn.user);
    return;
  }
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

export async function signOut(): Promise<void> {
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
  await clearCredentials();
  setAuth({ status: "signedOut", origin, notice });
}
