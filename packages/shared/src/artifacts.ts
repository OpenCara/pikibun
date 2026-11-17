export const artifactKinds = ["html", "svg", "markdown", "text"] as const;
export type ArtifactKind = (typeof artifactKinds)[number];

export const artifactLimits = {
  bytes: 1024 * 1024,
  totalBytes: 16 * 1024 * 1024,
  names: 256,
  versions: 256,
  title: 120,
} as const;

export const ARTIFACT_NAME = /^[a-z0-9][a-z0-9_-]{0,63}$/;

export interface ArtifactVersionInfo {
  version: number;
  kind: ArtifactKind;
  title: string;
  size: number;
  createdAt: string;
}

export interface ArtifactSummary {
  name: string;
  versions: ArtifactVersionInfo[];
}

export interface Artifact extends ArtifactVersionInfo {
  name: string;
  content: string;
}

export type ArtifactRequest = Record<string, never> | { name: string; version: number };

export interface ArtifactRef {
  name: string;
  version: number;
  kind: ArtifactKind;
  title?: string;
}

const encoder = new TextEncoder();

export function artifactBytes(content: string): number {
  return encoder.encode(content).length;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

export function validArtifactName(value: unknown): value is string {
  return typeof value === "string" && ARTIFACT_NAME.test(value);
}

export function validArtifactVersion(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 1 && (value as number) <= artifactLimits.versions;
}

export function isArtifactKind(value: unknown): value is ArtifactKind {
  return typeof value === "string" && (artifactKinds as readonly string[]).includes(value);
}

export function artifactTitle(value: unknown, name: string): string {
  const title = typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
  return Array.from(title || name).slice(0, artifactLimits.title).join("");
}

export function artifactRequest(value: unknown): ArtifactRequest | undefined {
  const input = record(value);
  if (!input) return undefined;
  const keys = Object.keys(input);
  if (!keys.length) return {};
  if (keys.length !== 2 || !validArtifactName(input.name) || !validArtifactVersion(input.version)) return undefined;
  return { name: input.name, version: input.version };
}

function checkVersionInfo(value: unknown): ArtifactVersionInfo | undefined {
  const info = record(value);
  if (!info || !validArtifactVersion(info.version) || !isArtifactKind(info.kind) || typeof info.title !== "string" || !info.title
    || Array.from(info.title).length > artifactLimits.title || /[\r\n]/.test(info.title)
    || !Number.isSafeInteger(info.size) || (info.size as number) < 0 || (info.size as number) > artifactLimits.bytes
    || typeof info.createdAt !== "string" || info.createdAt.length > 40 || Number.isNaN(Date.parse(info.createdAt))) return undefined;
  return { version: info.version, kind: info.kind, title: info.title, size: info.size as number, createdAt: info.createdAt };
}

export function checkArtifactList(value: unknown): ArtifactSummary[] | undefined {
  if (!Array.isArray(value) || value.length > artifactLimits.names) return undefined;
  const names = new Set<string>();
  const list: ArtifactSummary[] = [];
  for (const item of value) {
    const summary = record(item);
    if (!summary || !validArtifactName(summary.name) || names.has(summary.name) || !Array.isArray(summary.versions)
      || !summary.versions.length || summary.versions.length > artifactLimits.versions) return undefined;
    const versions = summary.versions.map(checkVersionInfo);
    if (versions.some((info, index) => !info || info.version !== index + 1)) return undefined;
    names.add(summary.name);
    list.push({ name: summary.name, versions: versions as ArtifactVersionInfo[] });
  }
  return list;
}

export function checkArtifact(value: unknown, request: { name: string; version: number }): Artifact | undefined {
  const artifact = record(value);
  const info = checkVersionInfo(artifact);
  if (!artifact || !info || artifact.name !== request.name || info.version !== request.version || typeof artifact.content !== "string"
    || artifactBytes(artifact.content) > artifactLimits.bytes) return undefined;
  return { name: request.name, ...info, content: artifact.content };
}

export function artifactResultText(artifact: { name: string; version: number; kind: ArtifactKind; title: string }): string {
  return `Published artifact ${artifact.name} version ${artifact.version} (${artifact.kind}).\nTitle: ${artifact.title}\n`
    + "People see it in the transcript and in the session panel's Artifacts tab.";
}

const RESULT_LINE = /^Published artifact ([a-z0-9][a-z0-9_-]{0,63}) version (\d{1,3}) \((html|svg|markdown|text)\)\.$/;

export function artifactResult(text: string): ArtifactRef | undefined {
  const [first, second] = text.split("\n");
  const match = RESULT_LINE.exec(first ?? "");
  if (!match || !validArtifactVersion(Number(match[2]))) return undefined;
  const title = second?.startsWith("Title: ") ? second.slice(7).trim() : "";
  return { name: match[1]!, version: Number(match[2]), kind: match[3] as ArtifactKind, ...(title ? { title } : {}) };
}

export const artifactFramePolicy = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; "
  + "media-src data: blob:; connect-src 'none'; frame-src 'none'; worker-src 'none'; form-action 'none'; base-uri 'none'";

export function artifactFrame(kind: "html" | "svg", content: string): string {
  const head = `<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${artifactFramePolicy}">`
    + "<meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">";
  if (kind === "html") return `${head}\n${content}`;
  return `${head}<style>html,body{margin:0;height:100%;background:#fff}body{display:flex;align-items:center;justify-content:center}`
    + `img{max-width:100%;max-height:100%}</style><img alt="" src="data:image/svg+xml;charset=utf-8,${encodeURIComponent(content)}">`;
}
