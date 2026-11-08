import { ApiError } from "./api";

const RETURN_KEY = "pikibun.return-after-sign-in";

/**
 * Signs in with GitHub again, for what needs a recent GitHub sign-in (setting a password without the current one), and
 * comes back to the page it started from: GitHub's callback lands on the app's root, which loses the fragment.
 */
export function signInWithGitHubAgain(): void {
  try { sessionStorage.setItem(RETURN_KEY, window.location.hash); } catch { /* Private mode: it lands on the root. */ }
  window.location.assign("/api/auth/github");
}

/** The page a sign-in signInWithGitHubAgain started returns to, once; null after any other sign-in. */
export function takeReturnAfterSignIn(): string | null {
  try {
    const value = sessionStorage.getItem(RETURN_KEY);
    sessionStorage.removeItem(RETURN_KEY);
    return value?.startsWith("#/") ? value : null;
  } catch {
    return null;
  }
}

/** Whether the server refused a change for want of a recent GitHub sign-in. */
export function needsRecentSignIn(reason: unknown): boolean {
  return reason instanceof ApiError && reason.code === "recent_sign_in_required";
}

/** What a username can be, as the server checks it: 3 to 39 letters, digits, - and _, starting with a letter or digit. */
export const USERNAME_PATTERN = /^[a-z0-9][a-z0-9_-]{2,38}$/;

/** A first guess at a username: the GitHub login, where it is one. The person can type another. */
export function suggestedUsername(githubLogin: string | null): string {
  const login = githubLogin?.toLowerCase() ?? "";
  return USERNAME_PATTERN.test(login) ? login : "";
}
