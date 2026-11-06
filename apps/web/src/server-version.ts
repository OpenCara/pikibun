import { useResource } from "./ui";

/** The release the server runs, as /api/health reports it; null in development, or until it loads. */
export function useServerVersion(): string | null {
  return useResource<{ version?: string | null }>("/api/health").data?.version ?? null;
}
