import { redactPatch } from "./pull-request-review.js";
import { redactSecrets } from "./redaction.js";
import type { PullRequestCommitView, PullRequestFileStatus, PullRequestFileView } from "./types.js";

declare module "./connector.js" {
  interface ConnectorCapabilities {
    localChanges?: boolean;
  }
}

export const localChangesLimits = {
  repositories: 20, commits: 100, files: 300, untracked: 200, patchBytes: 256 * 1024, totalPatchBytes: 2 * 1024 * 1024, outputBytes: 3_500_000,
} as const;

export interface LocalRepository {
  directory: string;
  branch: string | null;
  head: string | null;
}
export interface LocalCommit extends PullRequestCommitView {
  unpushed?: true;
}
export interface LocalChanges {
  repositories: LocalRepository[];
  directory: string | null;
  commit: string | null;
  files: PullRequestFileView[];
  commits: LocalCommit[];
  additions: number;
  deletions: number;
  omitted?: { files?: number };
  truncated?: true;
}
export interface LocalChangesRequest {
  directory?: string;
  commit?: string;
}

const encoder = new TextEncoder();
const statuses: readonly PullRequestFileStatus[] = ["added", "modified", "removed", "renamed", "copied"];
const count = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);

export class InvalidLocalChanges extends Error {
  constructor() { super("Invalid local changes response"); }
}
function invalid(): never { throw new InvalidLocalChanges(); }

export function validChangesDirectory(value: unknown): value is string {
  if (typeof value !== "string" || !value || value.length > 512 || /[\x00-\x1f\x7f\\]/.test(value)) return false;
  if (value === ".") return true;
  return !value.startsWith("/") && value.split("/").every(part => part !== "" && part !== "." && part !== ".." && part !== ".git");
}

export const validChangesCommit = (value: unknown): value is string => typeof value === "string" && /^[0-9a-f]{40}([0-9a-f]{24})?$/.test(value);

export function localChangesRequest(input: unknown): LocalChangesRequest {
  if (!object(input) || Object.keys(input).some(key => key !== "directory" && key !== "commit")
    || (input.directory !== undefined && !validChangesDirectory(input.directory))
    || (input.commit !== undefined && (!validChangesCommit(input.commit) || input.directory === undefined))) throw new Error("Invalid local changes request");
  return { ...(input.directory !== undefined ? { directory: input.directory as string } : {}), ...(input.commit !== undefined ? { commit: input.commit as string } : {}) };
}

function text(value: unknown, limit: number): string {
  if (typeof value !== "string" || value.length > limit) invalid();
  return value;
}

export function checkLocalChanges(value: unknown): LocalChanges {
  if (!object(value)) invalid();
  const { repositories, files, commits } = value;
  if (!Array.isArray(repositories) || repositories.length > localChangesLimits.repositories || !Array.isArray(files) || files.length > localChangesLimits.files
    || !Array.isArray(commits) || commits.length > localChangesLimits.commits || !count(value.additions) || !count(value.deletions)
    || (value.directory !== null && !validChangesDirectory(value.directory)) || (value.commit !== null && !validChangesCommit(value.commit))
    || (value.truncated !== undefined && value.truncated !== true)) invalid();
  const omitted = value.omitted;
  if (omitted !== undefined && (!object(omitted) || Object.keys(omitted).some(key => key !== "files") || (omitted.files !== undefined && !count(omitted.files)))) invalid();
  let held = 0;
  return {
    repositories: repositories.map((item: unknown): LocalRepository => {
      if (!object(item) || !validChangesDirectory(item.directory) || (item.branch !== null && typeof item.branch !== "string")
        || (item.head !== null && !validChangesCommit(item.head))) invalid();
      return { directory: item.directory, branch: item.branch === null ? null : text(item.branch, 255), head: item.head as string | null };
    }),
    directory: value.directory as string | null, commit: value.commit as string | null,
    files: files.map((item: unknown): PullRequestFileView => {
      if (!object(item) || !statuses.includes(item.status as PullRequestFileStatus) || !count(item.additions) || !count(item.deletions)
        || (item.truncated !== undefined && item.truncated !== true)) invalid();
      const path = text(item.path, 4096);
      if (!path) invalid();
      const patch = item.patch === undefined ? undefined : text(item.patch, localChangesLimits.patchBytes);
      if (patch !== undefined) {
        held += encoder.encode(patch).length;
        if (!patch.startsWith("@@") || held > localChangesLimits.totalPatchBytes) invalid();
      }
      return { path, ...(item.previousPath !== undefined ? { previousPath: text(item.previousPath, 4096) } : {}), status: item.status as PullRequestFileStatus,
        additions: item.additions, deletions: item.deletions, ...(patch !== undefined ? { patch } : {}), ...(item.truncated ? { truncated: true as const } : {}) };
    }),
    commits: commits.map((item: unknown): LocalCommit => {
      if (!object(item) || !validChangesCommit(item.sha) || (item.author !== null && typeof item.author !== "string")
        || (item.unpushed !== undefined && item.unpushed !== true)) invalid();
      return { sha: item.sha, message: text(item.message, 1000), author: item.author === null ? null : text(item.author, 255), date: text(item.date, 64),
        ...(item.unpushed ? { unpushed: true as const } : {}) };
    }),
    additions: value.additions as number, deletions: value.deletions as number,
    ...(omitted && (omitted as { files?: number }).files ? { omitted: { files: (omitted as { files: number }).files } } : {}),
    ...(value.truncated ? { truncated: true as const } : {}),
  };
}

export function redactLocalChanges(changes: LocalChanges): LocalChanges {
  return { ...changes,
    files: changes.files.map(file => {
      if (file.patch === undefined) return file;
      const patch = redactPatch(file.patch);
      return patch === file.patch ? file : { ...file, patch, redacted: true as const };
    }),
    commits: changes.commits.map(commit => ({ ...commit, message: redactSecrets(commit.message) })) };
}
