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

export const artifactCacheBytes = 2 * 1024 * 1024;

export function createArtifactSource(place: ArtifactPlace, load: <T>(href: string) => Promise<T>, budget = artifactCacheBytes): ArtifactSource {
  const kept = new Map<string, { loading: Promise<{ artifact: ArtifactContent }>; bytes: number }>();
  const trim = () => {
    let total = [...kept.values()].reduce((sum, item) => sum + item.bytes, 0);
    while (total > budget && kept.size > 1) {
      const [oldest, item] = kept.entries().next().value!;
      kept.delete(oldest);
      total -= item.bytes;
    }
  };
  return {
    list: () => load<{ artifacts: ArtifactSummary[] }>(artifactsHref(place)),
    read(name, version) {
      const key = `${name}@${version}`;
      const known = kept.get(key);
      if (known) {
        kept.delete(key);
        kept.set(key, known);
        return known.loading;
      }
      const item = { loading: load<{ artifact: ArtifactContent }>(artifactsHref(place, { name, version })), bytes: 0 };
      kept.set(key, item);
      item.loading.then(result => {
        if (kept.get(key) !== item) return;
        item.bytes = result.artifact.content.length * 2;
        trim();
      }, () => { if (kept.get(key) === item) kept.delete(key); });
      return item.loading;
    },
  };
}
