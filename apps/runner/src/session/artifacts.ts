import { defineDoc, defineDocFamily, type Tx } from "@earendil-works/pi-durable";
import {
  artifactBytes, artifactLimits, type Artifact, type ArtifactKind, type ArtifactSummary, type ArtifactVersionInfo,
} from "../../../../packages/shared/src/artifacts.js";
import { RunnerError } from "../protocol.js";

type StoredVersion = { version: number; kind: ArtifactKind; title: string; size: number; createdAt: string; callId: string };
type StoredIndex = { artifacts: Record<string, StoredVersion[]> };

export const ArtifactIndex = defineDoc<StoredIndex>({ kind: "workspace.artifacts", version: 1, scope: "session",
  initial: () => ({ artifacts: {} }), checkpointWhen: () => true });
export const ArtifactContent = defineDocFamily<{ content: string }, null>({ kind: "workspace.artifact", version: 1, scope: "session", family: true,
  initial: () => ({ content: "" }), checkpointWhen: () => true });

export interface ArtifactReader {
  index(): Promise<Readonly<StoredIndex> | undefined>;
  content(key: string): Promise<Readonly<{ content: string }> | undefined>;
}

export interface PublishInput {
  name: string;
  kind: ArtifactKind;
  title: string;
  content: string;
  callId: string;
  now: Date;
}

export const artifactKey = (name: string, version: number) => `${name}@${version}`;

function shown({ version, kind, title, size, createdAt }: StoredVersion): ArtifactVersionInfo {
  return { version, kind, title, size, createdAt };
}

export async function publishArtifact(commit: <T>(change: (tx: Tx) => Promise<T>) => Promise<T>, input: PublishInput): Promise<ArtifactVersionInfo & { name: string }> {
  const size = artifactBytes(input.content);
  if (size > artifactLimits.bytes) throw new RunnerError(413, `An artifact holds at most ${artifactLimits.bytes / 1024 / 1024} MiB of UTF-8; this one is ${size} bytes. Make it smaller.`);
  return commit(async tx => {
    const index = await tx.doc(ArtifactIndex);
    const versions = index.artifacts[input.name] ?? [];
    const again = versions.find(item => item.callId === input.callId);
    if (again) return { name: input.name, ...shown(again) };
    if (!versions.length && Object.keys(index.artifacts).length >= artifactLimits.names) {
      throw new RunnerError(422, `This session already has ${artifactLimits.names} artifacts, the most it keeps. Publish a new version of one of them instead.`);
    }
    if (versions.length >= artifactLimits.versions) {
      throw new RunnerError(422, `${input.name} already has ${artifactLimits.versions} versions, the most an artifact keeps. Publish under another name.`);
    }
    const total = Object.values(index.artifacts).flat().reduce((sum, item) => sum + item.size, 0);
    if (total + size > artifactLimits.totalBytes) {
      throw new RunnerError(422, `This session's artifacts would take more than ${artifactLimits.totalBytes / 1024 / 1024} MiB together, the most it keeps. Nothing was published.`);
    }
    const stored: StoredVersion = { version: versions.length + 1, kind: input.kind, title: input.title, size, createdAt: input.now.toISOString(), callId: input.callId };
    (await tx.doc(ArtifactContent, artifactKey(input.name, stored.version), null)).content = input.content;
    index.artifacts[input.name] = [...versions, stored];
    return { name: input.name, ...shown(stored) };
  });
}

export async function listArtifacts(reader: ArtifactReader): Promise<ArtifactSummary[]> {
  const index = await reader.index();
  return Object.entries(index?.artifacts ?? {}).sort(([a], [b]) => a.localeCompare(b))
    .map(([name, versions]) => ({ name, versions: versions.map(shown) }));
}

export async function readArtifact(reader: ArtifactReader, name: string, version: number): Promise<Artifact> {
  const index = await reader.index();
  const info = Object.hasOwn(index?.artifacts ?? {}, name) ? index!.artifacts[name]!.find(item => item.version === version) : undefined;
  const stored = info && await reader.content(artifactKey(name, version));
  if (!info || !stored) throw new RunnerError(404, "That artifact version is not in this session");
  return { name, ...shown(info), content: stored.content };
}
