export const HOST_DIRECTORY_MAX_LENGTH = 1024;

export function validHostDirectory(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= HOST_DIRECTORY_MAX_LENGTH && value === value.trim()
    && !/[\x00-\x1f\x7f]/.test(value)
    && (value.startsWith("/") || /^~(?:[\\/]|$)/.test(value) || /^[A-Za-z]:[\\/]/.test(value));
}

export const hostDirectoryRule = "an absolute path on the host (/..., or C:\\... on Windows), or one in its user's home (~ or ~/...)";

export const HOST_DIRECTORIES_PATH = "/v1/directories";
export const HOST_DIRECTORIES_TICKET_SESSION = "directories";
export const HOST_DIRECTORIES_LIMIT = 1000;

export type HostDirectoryProblem = "missing" | "denied" | "not-directory" | "refused";
export const hostDirectoryProblems: readonly HostDirectoryProblem[] = ["missing", "denied", "not-directory", "refused"];

export interface HostDirectoryEntry {
  name: string;
  path: string;
}

export type HostDirectoryListing =
  | { path: string; parent: string | null; home: string; entries: HostDirectoryEntry[]; truncated: boolean }
  | { path: string; parent: string | null; home: string; problem: HostDirectoryProblem };

export interface HostDirectoriesRequest {
  path: string;
}

function listedPath(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= HOST_DIRECTORY_MAX_LENGTH && !/[\x00-\x1f\x7f]/.test(value)
    && (value.startsWith("/") || /^[A-Za-z]:[\\/]/.test(value));
}

function listedName(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 255 && value !== "." && value !== ".."
    && !/[\x00-\x1f\x7f/\\]/.test(value);
}

export function parseHostDirectoriesRequest(value: unknown): HostDirectoriesRequest | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const keys = Object.keys(value);
  const path = (value as Record<string, unknown>).path;
  return keys.length === 1 && keys[0] === "path" && validHostDirectory(path) ? { path } : null;
}

export function checkHostDirectoryListing(value: unknown): HostDirectoryListing | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const listing = value as Record<string, unknown>;
  if (!listedPath(listing.path) || !listedPath(listing.home) || (listing.parent !== null && !listedPath(listing.parent))) return null;
  const base = { path: listing.path, parent: listing.parent as string | null, home: listing.home };
  if ("problem" in listing) {
    const keys = Object.keys(listing).sort().join(",");
    if (keys !== "home,parent,path,problem" || !hostDirectoryProblems.includes(listing.problem as HostDirectoryProblem)) return null;
    return { ...base, problem: listing.problem as HostDirectoryProblem };
  }
  if (Object.keys(listing).sort().join(",") !== "entries,home,parent,path,truncated" || typeof listing.truncated !== "boolean"
    || !Array.isArray(listing.entries) || listing.entries.length > HOST_DIRECTORIES_LIMIT) return null;
  const entries: HostDirectoryEntry[] = [];
  for (const entry of listing.entries as unknown[]) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry) || Object.keys(entry).sort().join(",") !== "name,path") return null;
    const { name, path } = entry as Record<string, unknown>;
    if (!listedName(name) || !listedPath(path)) return null;
    entries.push({ name, path });
  }
  return { ...base, entries, truncated: listing.truncated };
}
