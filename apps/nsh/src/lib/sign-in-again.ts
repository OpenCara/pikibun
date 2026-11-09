import { ApiError, type UserProfile } from "../shared";
import { session } from "./auth";
import { openServerLink, opensServerPages } from "./links";
import { routeHash, shownRoute } from "./page";
import { rememberReturn } from "./sign-in-memory";

// What needs a recent GitHub sign-in (setting a password without the current one), as the web app's sign-in-again.ts.

/** Whether signing in with GitHub again can be offered here: on the web, through the server's own sign-in page. */
export const canSignInAgain = opensServerPages;

/**
 * Signs in with GitHub again, in the page (web only), and comes back to the page it started from: GitHub's callback
 * lands on the app's root, which loses the fragment.
 */
export async function signInWithGitHubAgain(): Promise<void> {
  await rememberReturn(routeHash(shownRoute()));
  openServerLink("/api/auth/github");
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

/** Chooses the signed-in account's username, once, with an optional password; answers with the updated profile. */
export async function chooseUsername(username: string, password?: string): Promise<UserProfile> {
  const body: Record<string, string> = { username: username.trim().toLowerCase() };
  if (password) body.password = password;
  return (await session().api<{ user: UserProfile }>("/api/me/username", { method: "POST", body })).user;
}
