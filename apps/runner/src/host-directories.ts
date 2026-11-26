import { readdir, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { HOST_DIRECTORIES_LIMIT, HOST_DIRECTORY_MAX_LENGTH, type HostDirectoryEntry, type HostDirectoryListing, type HostDirectoryProblem } from "../../../packages/shared/src/host-directory.js";
import { chosenWorktree } from "./host-workspace.js";

const MAX_SCANNED = 100_000;

export interface HostDirectoriesOptions {
  refused: readonly string[];
  home?: string;
}

function problemOf(error: unknown): HostDirectoryProblem {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  if (code === "ENOENT" || code === "ELOOP") return "missing";
  if (code === "ENOTDIR") return "not-directory";
  return "denied";
}

function within(outer: string, inner: string): boolean {
  const path = relative(outer, inner);
  return !path || (path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path));
}

function shownName(name: string): boolean {
  return name.length > 0 && name.length <= 255 && !/[\x00-\x1f\x7f/\\]/.test(name);
}

function order(a: HostDirectoryEntry, b: HostDirectoryEntry): number {
  const hidden = Number(a.name.startsWith(".")) - Number(b.name.startsWith("."));
  if (hidden) return hidden;
  const left = a.name.toLowerCase(), right = b.name.toLowerCase();
  return left < right ? -1 : left > right ? 1 : a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
}

export async function listHostDirectories(path: string, options: HostDirectoriesOptions): Promise<HostDirectoryListing> {
  const home = resolve(options.home ?? homedir());
  const target = chosenWorktree(path, home);
  const up = dirname(target);
  const base = { path: target, parent: up === target ? null : up, home };
  const refused = await Promise.all(options.refused.map(async item => {
    const resolved = resolve(item);
    return realpath(resolved).catch(() => resolved);
  }));
  let real: string;
  try {
    real = await realpath(target);
    if (!(await stat(real)).isDirectory()) return { ...base, problem: "not-directory" };
  } catch (error) {
    return { ...base, problem: problemOf(error) };
  }
  if (refused.some(storage => within(storage, real))) return { ...base, problem: "refused" };
  let names;
  try { names = await readdir(real, { withFileTypes: true }); }
  catch (error) { return { ...base, problem: problemOf(error) }; }
  const entries: HostDirectoryEntry[] = [];
  for (const entry of names.slice(0, MAX_SCANNED)) {
    if (!shownName(entry.name)) continue;
    const shown = join(target, entry.name);
    if (shown.length > HOST_DIRECTORY_MAX_LENGTH) continue;
    let actual = join(real, entry.name);
    if (entry.isSymbolicLink()) {
      try {
        actual = await realpath(actual);
        if (!(await stat(actual)).isDirectory()) continue;
      } catch { continue; }
    } else if (!entry.isDirectory()) continue;
    if (refused.some(storage => within(storage, actual))) continue;
    entries.push({ name: entry.name, path: shown });
  }
  entries.sort(order);
  const usable = real !== resolve(real, "..") && !refused.some(storage => within(real, storage));
  return { ...base, entries: entries.slice(0, HOST_DIRECTORIES_LIMIT), truncated: entries.length > HOST_DIRECTORIES_LIMIT || names.length > MAX_SCANNED, usable };
}
