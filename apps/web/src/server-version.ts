import { useResource } from "./ui";

/** The release the server runs, as /api/health reports it; null in development, or until it loads. */
export function useServerVersion(): string | null {
  return useResource<{ version?: string | null }>("/api/health").data?.version ?? null;
}

function release(version: string): number[] | undefined {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
  return match ? match.slice(1).map(Number) : undefined;
}

/**
 * Whether a connector's version is an older release than the server's. The CLI's releases share the server's version
 * numbers; anything else (the desktop app's own versions, prereleases, a development server) is never called older.
 */
export function olderThanServer(connector: string, server: string | null): boolean {
  const ours = release(connector), theirs = server ? release(server) : undefined;
  if (!ours || !theirs) return false;
  for (let index = 0; index < 3; index++) if (ours[index] !== theirs[index]) return ours[index]! < theirs[index]!;
  return false;
}
