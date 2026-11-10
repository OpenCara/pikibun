import { ApiError, type UserProfile } from "../shared";
import { session } from "./auth";
import { openServerLink, opensServerPages } from "./links";
import { routeHash, shownRoute } from "./page";
import { rememberReturn } from "./sign-in-memory";

export const canSignInAgain = opensServerPages;

export async function signInWithGitHubAgain(): Promise<void> {
  await rememberReturn(routeHash(shownRoute()));
  openServerLink("/api/auth/github");
}

export function needsRecentSignIn(reason: unknown): boolean {
  return reason instanceof ApiError && reason.code === "recent_sign_in_required";
}

export const USERNAME_PATTERN = /^[a-z0-9][a-z0-9_-]{2,38}$/;

export function suggestedUsername(githubLogin: string | null): string {
  const login = githubLogin?.toLowerCase() ?? "";
  return USERNAME_PATTERN.test(login) ? login : "";
}

export async function chooseUsername(username: string, password?: string): Promise<UserProfile> {
  const body: Record<string, string> = { username: username.trim().toLowerCase() };
  if (password) body.password = password;
  return (await session().api<{ user: UserProfile }>("/api/me/username", { method: "POST", body })).user;
}
