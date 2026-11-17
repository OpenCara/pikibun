import { untracked } from "nsh";
import { createApi, createArtifactSource, type ArtifactSource } from "../shared";
import { session } from "./auth";

const sources = new Map<string, ArtifactSource>();

export function sessionArtifacts(sessionId: string): ArtifactSource {
  const known = sources.get(sessionId);
  if (known) return known;
  const source = createArtifactSource({ sessionId }, <T,>(href: string) => untracked(session).api<T>(href));
  sources.set(sessionId, source);
  while (sources.size > 4) sources.delete(sources.keys().next().value!);
  return source;
}

export function sharedArtifacts(token: string, origin = ""): ArtifactSource {
  const api = createApi({ baseUrl: origin, auth: "cookie" });
  return createArtifactSource({ shared: true }, <T,>(href: string) => api<T>(href, { headers: { "X-Share-Token": token } }));
}
