import { validRepositoryName } from "./repositories.js";
import type { PullRequestState, SessionPullRequest } from "./types.js";

export const pullRequestStates: readonly PullRequestState[] = ["draft", "open", "failing", "changes_requested", "merged", "closed"];

export const pullRequestStateLabels: Record<PullRequestState, string> = {
  draft: "Draft",
  open: "Open",
  failing: "CI failed",
  changes_requested: "Changes requested",
  merged: "Merged",
  closed: "Closed",
};

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

export function pullRequestLabel(pull: SessionPullRequest): string {
  return pull.number === undefined ? "PR" : `#${pull.number}`;
}

export interface AzurePullRequestAddress { fullName: string; number: number }

export function azurePullRequest(url: string): AzurePullRequestAddress | undefined {
  let parsed: URL;
  try { parsed = new URL(url); } catch { return undefined; }
  if (parsed.protocol !== "https:" || parsed.host !== "dev.azure.com" || parsed.search || parsed.hash) return undefined;
  let parts: string[];
  try { parts = parsed.pathname.replace(/\/$/, "").split("/").slice(1).map(decodeURIComponent); } catch { return undefined; }
  if (parts.length !== 6 || parts[2] !== "_git" || parts[4]!.toLowerCase() !== "pullrequest" || !/^[1-9]\d{0,8}$/.test(parts[5]!)) return undefined;
  const fullName = `${parts[0]}/${parts[1]}/${parts[3]}`;
  return validRepositoryName("azure-devops", fullName) ? { fullName, number: Number(parts[5]) } : undefined;
}

export function azurePullRequestUrl(fullName: string, number: number): string {
  const [organization, project, repository] = fullName.split("/") as [string, string, string];
  return `https://dev.azure.com/${organization}/${encodeURIComponent(project)}/_git/${encodeURIComponent(repository)}/pullrequest/${number}`;
}

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
