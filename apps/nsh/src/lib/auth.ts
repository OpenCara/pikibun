import { platform, signal, Storage, untracked, type Accessor } from "nsh";
import { ApiError, createApi, errorMessage, type Api, type RequestOptions, type UserProfile } from "../shared";
import { clearDrafts } from "./drafts";
import { createPkce } from "./pkce";
import { DEFAULT_ORIGIN, usesBrowserSession } from "./server";

/** Why the server refused a new account (its SIGNUP setting), by the code it returns to the app's callback. */
const signInRefusals: Record<string, string> = {
  invite_required: "This server takes new accounts only through a workspace's invite link. Open the link in a browser to create your account, then sign in here.",
  signup_closed: "This server doesn't take new accounts. Ask its operator to add you.",
  too_many_pending: "The workspace that invited you has too many people waiting to join. Ask an owner or admin.",
};

// NSH's Storage is the app's own key-value file, not the Keychain or Keystore (longbridge/nsh#1061): a sign-in kept
// here is readable by anything that can read the app's data directory. The Expo app keeps it in expo-secure-store.
const TOKEN_KEY = "pikibun.token";
const EXPIRES_KEY = "pikibun.tokenExpires";
/** The server is a preference, not a credential: it stays after sign-out so signing in again goes to the same place. */
const ORIGIN_KEY = "pikibun.origin";
/**
 * Where the server hands a sign-in back after GitHub when asked with `callback=page` (see the native sign-in API): a
 * page of its own the web view navigates to, since NSH's web views load only http and https and the app has no URL
 * scheme to be sent to.
 */
const CALLBACK_PATH = "/api/auth/native/done";

/** What the server offers on its sign-in page (GET /api/health). */
export interface SignInMethods {
  githubConfigured?: boolean;
  passwordAuth?: boolean;
  testMode?: boolean;
}

export type AuthState =
  | { status: "loading" }
  /** `notice` explains why the app signed out on its own, or what the last sign-out could not do. */
  | { status: "signedOut"; origin: string; notice?: string }
  /** A stored sign-in whose server could not be reached at launch; nothing is known about the user yet. */
  | { status: "unreachable"; origin: string; error: string }
  /** `token` is null for the web's browser session (cookies). */
  | { status: "signedIn"; origin: string; token: string | null; expiresAt: string | null; user: UserProfile; api: Api };

export type SignedIn = Extract<AuthState, { status: "signedIn" }>;

const authState = signal<AuthState>({ status: "loading" });
/** Where sign-in stands (reactive). Only this module changes it, through setAuth. */
export const auth: Accessor<AuthState> = authState;

/** Whose sign-in a state is: the server and the user, or null while nobody is signed in. */
const account = (value: AuthState) => (value.status === "signedIn" ? `${value.origin} ${value.user.id}` : null);

/**
 * Every change of sign-in goes through here. What belongs to the account signed in until now (unsent drafts) goes when
 * it signs out, its sign-in ends or another account signs in, so the next person on this device never sees it.
 */
function setAuth(next: AuthState) {
  const previous = account(untracked(authState));
  if (previous !== null && previous !== account(next)) clearDrafts();
  authState.set(next);
}

/** The signed-in state; only screens behind the signed-in guard call it (untracked use in handlers is fine). */
export function session(): SignedIn {
  const state = auth();
  if (state.status !== "signedIn") throw new Error("This screen needs a signed-in user.");
  return state;
}

/** The token whose 401 may sign out: an answer to an older sign-in's request must not end a newer one. */
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

/** An API client whose 401 answers sign the app out: the sign-in is gone. */
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

/** The origin the web client was served from, as an absolute URL (the requests themselves stay relative). */
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

/** The web: the page's own browser session, if it has one. */
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

/** Reads the stored sign-in and checks it with the server; the app shows nothing until it knows. */
export async function restore(): Promise<void> {
  setAuth({ status: "loading" });
  if (usesBrowserSession) {
    await establishBrowserSession();
    return;
  }
  const [storedOrigin, token, expiresAt] = await Promise.all([Storage.getItem(ORIGIN_KEY), Storage.getItem(TOKEN_KEY), Storage.getItem(EXPIRES_KEY)]);
  const origin = storedOrigin ?? DEFAULT_ORIGIN;
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

/** What the server's sign-in page offers. */
export async function signInMethods(origin: string): Promise<SignInMethods> {
  return createApi({ baseUrl: origin, auth: () => null })<SignInMethods>("/api/health");
}

/** A native GitHub sign-in in progress: the page to show, and how to finish once the web view reaches its callback. */
export interface GitHubSignIn {
  url: string;
  /** Whether the web view's address is the server's callback page, which finishes the sign-in. */
  isCallback(url: string): boolean;
  finish(callbackUrl: string): Promise<void>;
}

/**
 * Starts the native GitHub sign-in (PKCE). NSH has no system authentication session (longbridge/nsh#1065) and no deep
 * links, so the page runs in the app's own web view, which watches for the server's callback page; the web view can see
 * what is typed into it, unlike ASWebAuthenticationSession. The code it gets back is worth nothing without the verifier,
 * which never leaves the app.
 */
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
      // A callback for another attempt must never complete this one.
      if (params.get("state") !== state) throw new Error("The sign-in response did not match this attempt. Try again.");
      const error = params.get("error");
      if (error) throw new Error(signInRefusals[error] ?? `GitHub sign-in did not complete: ${error.slice(0, 300)}`);
      const code = params.get("code");
      if (!code) throw new Error("The server did not return a sign-in code. Try again.");
      const exchange = await createApi({ baseUrl: origin, auth: () => null })<{ token: string; expiresAt: string; user: UserProfile }>(
        "/api/auth/native/token", { method: "POST", body: { code, verifier, deviceName: `Pikibun NSH (${platform.os})` } });
      await establish(origin, exchange.token, exchange.expiresAt, exchange.user);
    },
  };
}

/** Whether `url` is `origin`'s callback page: the same origin and path, never a page of another site that names it. */
function isCallbackPage(origin: string, url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.origin === new URL(origin).origin && parsed.pathname === CALLBACK_PATH;
  } catch {
    return false;
  }
}

/** A test-mode server's token (POST /api/auth/test), for development and tests. */
export async function signInWithToken(origin: string, token: string): Promise<void> {
  await establish(origin, token.trim(), null);
}

/** The web: a username and password on a server that allows them; the server sets the browser session's cookie. */
export async function signInWithPassword(username: string, password: string): Promise<void> {
  const response = await fetch("/api/auth/password/login", {
    method: "POST",
    credentials: "same-origin",
    headers: { Accept: "application/json", "Content-Type": "application/json" },
    body: JSON.stringify({ username, password }),
  });
  if (!response.ok) {
    let message = `Sign-in failed (HTTP ${response.status}).`;
    try {
      const body = await response.json() as { error?: string | { message?: string } };
      message = typeof body.error === "string" ? body.error : body.error?.message ?? message;
    } catch { /* not JSON */ }
    throw new Error(message);
  }
  if (!await establishBrowserSession()) throw new Error("Signed in, but the server did not keep the session. Check that cookies are allowed.");
}

/** The web: the browser session may have started in another tab (GitHub's redirect lands on the web app). */
export const checkBrowserSession = establishBrowserSession;

/** How long signing out waits for the server to revoke the sign-in. */
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
    // The server may be back by now: revoke the stored sign-in there too.
    const token = await Storage.getItem(TOKEN_KEY);
    if (token) logout = signal => createApi({ baseUrl: origin, auth: () => token })("/api/auth/logout", { method: "POST", signal });
  }
  if (logout) {
    // A server that doesn't answer must not hold up signing out on this device.
    const timeout = new AbortController();
    const timer = setTimeout(() => timeout.abort(), LOGOUT_TIMEOUT_MS);
    try {
      await logout(timeout.signal);
    } catch (reason) {
      // Signing out must work offline; the sign-in stays valid on the server until revoked there.
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
