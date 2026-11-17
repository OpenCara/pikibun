import { artifactResult, type Artifact, type ArtifactRef, type ArtifactSummary } from "../../shared/src/artifacts";
import type { EntryView } from "../../shared/src/types";
import { segment } from "./api";

export type ArtifactPlace = { sessionId: string } | { shared: true };

export function artifactsHref(place: ArtifactPlace, version?: { name: string; version: number }): string {
  const base = "sessionId" in place ? `/api/sessions/${segment(place.sessionId)}/artifacts` : "/api/shared/artifacts";
  return version ? `${base}?name=${encodeURIComponent(version.name)}&version=${version.version}` : base;
}

export function publishedArtifact(result: EntryView | undefined): ArtifactRef | undefined {
  if (!result || result.toolResult?.tool !== "publish_artifact" || result.toolResult.error) return undefined;
  return artifactResult(result.text);
}

export type ArtifactContent = Artifact & { redacted?: true };

export interface ArtifactSource {
  list(): Promise<{ artifacts: ArtifactSummary[] }>;
  read(name: string, version: number): Promise<{ artifact: ArtifactContent }>;
}

export function createArtifactSource(place: ArtifactPlace, load: <T>(href: string) => Promise<T>, limit = 16): ArtifactSource {
  const kept = new Map<string, Promise<{ artifact: ArtifactContent }>>();
  return {
    list: () => load<{ artifacts: ArtifactSummary[] }>(artifactsHref(place)),
    read(name, version) {
      const key = `${name}@${version}`;
      const known = kept.get(key);
      if (known) {
        kept.delete(key);
        kept.set(key, known);
        return known;
      }
      const loading = load<{ artifact: ArtifactContent }>(artifactsHref(place, { name, version }));
      kept.set(key, loading);
      while (kept.size > limit) kept.delete(kept.keys().next().value!);
      loading.catch(() => { if (kept.get(key) === loading) kept.delete(key); });
      return loading;
    },
  };
}
