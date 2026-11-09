import type { PullRequestState, SessionPullRequest } from "./types.js";

export const pullRequestStates: readonly PullRequestState[] = ["draft", "open", "failing", "changes_requested", "merged", "closed"];

/** How lists and headers name a pull request's state. */
export const pullRequestStateLabels: Record<PullRequestState, string> = {
  draft: "Draft",
  open: "Open",
  failing: "CI failed",
  changes_requested: "Changes requested",
  merged: "Merged",
  closed: "Closed",
};

/** The tone a state shows in: needing work is danger, merged is its own (purple, as on GitHub). */
export const pullRequestStateTones: Record<PullRequestState, "neutral" | "success" | "danger" | "merged"> = {
  draft: "neutral",
  open: "success",
  failing: "danger",
  changes_requested: "danger",
  merged: "merged",
  closed: "neutral",
};

export function isPullRequestState(value: unknown): value is PullRequestState {
  return typeof value === "string" && (pullRequestStates as readonly string[]).includes(value);
}

/** "#12", or "PR" for a pull request URL with no number. */
export function pullRequestLabel(pull: SessionPullRequest): string {
  return pull.number === undefined ? "PR" : `#${pull.number}`;
}

/**
 * The repository a pull request URL names, as "owner/repo", or undefined when its path isn't one of the known shapes:
 * GitHub, Gitea, GitLab, Bitbucket Cloud and Server, Azure DevOps.
 */
export function pullRequestRepository(url: string): string | undefined {
  let path: string[];
  try { path = new URL(url).pathname.split("/").filter(Boolean).map(decodeURIComponent); } catch { return undefined; }
  const marker = path.findIndex(part => ["pull", "pulls", "-", "pull-requests", "merge_requests", "pullrequest"].includes(part));
  if (marker < 2) return undefined;
  const before = path.slice(0, marker);
  const repos = before.lastIndexOf("repos");
  if (repos >= 2 && repos === before.length - 2 && ["projects", "users"].includes(before[repos - 2]!)) return `${before[repos - 1]}/${before[repos + 1]}`;
  return before.filter(part => part !== "_git").join("/");
}
