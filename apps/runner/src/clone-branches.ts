import { lstat, open, readdir } from "node:fs/promises";
import { constants } from "node:fs";
import { join } from "node:path";
import { validPushBranch } from "../../../packages/shared/src/repositories.js";
import type { EgressRepository } from "../../../packages/shared/src/network.js";
import { repositoryForRemote } from "./egress.js";

const MAX_DEPTH = 3;
const MAX_DIRECTORIES = 2000;
export const MAX_CLONE_BRANCHES = 20;
const MAX_METADATA_BYTES = 64 * 1024;
const SKIPPED = new Set(["node_modules", "vendor", "target", "dist", "build"]);

export interface CloneBranch { directory: string; origin: string; branch: string }

async function readSmall(path: string): Promise<string | undefined> {
  let handle;
  try { handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
  catch { return undefined; }
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size > MAX_METADATA_BYTES) return undefined;
    const data = Buffer.alloc(info.size);
    const { bytesRead } = await handle.read(data, 0, info.size, 0);
    return data.subarray(0, bytesRead).toString("utf8");
  } catch { return undefined; } finally { await handle.close(); }
}

export function headBranch(head: string | undefined, prefix = "refs/heads/"): string | undefined {
  const match = /^ref: (\S+)\s*$/.exec(head ?? "");
  if (!match || !match[1]!.startsWith(prefix)) return undefined;
  const branch = match[1]!.slice(prefix.length);
  return validPushBranch(branch) ? branch : undefined;
}

export function originUrl(config: string): string | undefined {
  let inOrigin = false;
  let url: string | undefined;
  for (const raw of config.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#") || line.startsWith(";")) continue;
    const section = /^\[\s*([A-Za-z0-9.-]+)(?:\s+"((?:[^"\\]|\\.)*)")?\s*\]/.exec(line);
    if (section) {
      inOrigin = section[1]!.toLowerCase() === "remote" && section[2] === "origin";
      continue;
    }
    if (!inOrigin) continue;
    const entry = /^url\s*=\s*(.*)$/i.exec(line);
    if (entry && url === undefined) url = configValue(entry[1]!);
  }
  return url || undefined;
}

function configValue(raw: string): string {
  let value = "";
  let quoted = false;
  let pending = "";
  for (let index = 0; index < raw.length; index++) {
    const char = raw[index]!;
    if (char === "\\") {
      const next = raw[++index];
      value += pending + (next === "n" ? "\n" : next === "t" ? "\t" : next === "b" ? "\b" : next ?? "");
      pending = "";
    } else if (char === '"') quoted = !quoted;
    else if (!quoted && (char === "#" || char === ";")) break;
    else if (!quoted && /\s/.test(char)) pending += char;
    else { value += pending + char; pending = ""; }
  }
  return value.trim();
}

export async function readCloneBranches(worktree: string): Promise<CloneBranch[]> {
  const found: CloneBranch[] = [];
  let visited = 0;
  const visit = async (directory: string, relative: string, depth: number): Promise<void> => {
    if (depth > MAX_DEPTH || visited++ >= MAX_DIRECTORIES || found.length >= MAX_CLONE_BRANCHES) return;
    let names: string[];
    try { names = (await readdir(directory)).sort(); } catch { return; }
    const metadata = relative && names.includes(".git") ? await lstat(join(directory, ".git")).catch(() => undefined) : undefined;
    if (metadata && !metadata.isDirectory()) return;
    if (metadata) {
      const git = join(directory, ".git");
      const branch = headBranch(await readSmall(join(git, "HEAD")));
      const origin = originUrl(await readSmall(join(git, "config")) ?? "");
      const defaultBranch = headBranch(await readSmall(join(git, "refs", "remotes", "origin", "HEAD")), "refs/remotes/origin/");
      if (branch && origin && (defaultBranch ? branch !== defaultBranch : !["main", "master"].includes(branch))) {
        found.push({ directory: relative, origin, branch });
      }
      return;
    }
    for (const name of names) {
      if (name.startsWith(".") || SKIPPED.has(name)) continue;
      const path = join(directory, name);
      if (!(await lstat(path).catch(() => undefined))?.isDirectory()) continue;
      await visit(path, relative ? `${relative}/${name}` : name, depth + 1);
    }
  };
  await visit(worktree, "", 0);
  return found;
}

export function reportedBranches(clones: readonly CloneBranch[], repositories: readonly EgressRepository[]): { repository: string; branch: string }[] {
  const branches = new Map<string, { repository: string; branch: string }>();
  for (const clone of clones) {
    const repository = repositoryForRemote(repositories, clone.origin);
    if (!repository || repository.provider !== "github" || repository.host !== "github.com") continue;
    branches.set(`${repository.fullName}\n${clone.branch}`, { repository: repository.fullName, branch: clone.branch });
  }
  return [...branches.entries()].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([, value]) => value).slice(0, MAX_CLONE_BRANCHES);
}
