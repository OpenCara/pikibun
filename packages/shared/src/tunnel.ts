export const tunnelActions = Object.freeze(["start", "status", "stop"] as const);
export type TunnelAction = (typeof tunnelActions)[number];

export const QUICK_TUNNEL_DOMAIN = "trycloudflare.com";
export function quickTunnelUrl(line: string): string | undefined {
  for (const match of line.matchAll(/https:\/\/([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)\.trycloudflare\.com(?![a-z0-9.-])/g)) {
    if (match[1] !== "api") return `https://${match[1]}.${QUICK_TUNNEL_DOMAIN}`;
  }
  return undefined;
}

export const serviceLifetimeLimits = Object.freeze({ min: 300, max: 86_400, default: 14_400 });

export const serviceOutputLimits = Object.freeze({ lines: 40, lineLength: 500, bytes: 64 * 1024 });

export const tunnelSources = Object.freeze(["auto", "path", "download", "off"] as const);
export type TunnelSource = (typeof tunnelSources)[number];

export interface HostTunnelConfig {
  source: TunnelSource;
  path?: string;
}

export const defaultHostTunnelConfig: Readonly<HostTunnelConfig> = Object.freeze({ source: "auto" });
const TUNNEL_PATH_LIMIT = 4096;
const TUNNEL_TEXT_LIMIT = 1024;

const isObject = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);

export function parseHostTunnelConfig(value: unknown): HostTunnelConfig {
  if (!isObject(value) || Object.keys(value).some(key => key !== "source" && key !== "path")) throw new Error("Invalid tunnel setting");
  if (!(tunnelSources as readonly unknown[]).includes(value.source)) throw new Error(`cloudflared comes from ${tunnelSources.join(", ")}`);
  const source = value.source as TunnelSource;
  if (source !== "path") {
    if (value.path !== undefined) throw new Error("A cloudflared path goes with source path");
    return { source };
  }
  const path = value.path;
  if (typeof path !== "string" || !(path.startsWith("/") || /^[A-Za-z]:\\/.test(path)) || path.length > TUNNEL_PATH_LIMIT || path.includes("\0") || /[\r\n]/.test(path)) {
    throw new Error("cloudflared's path is the absolute path of its executable on the host, such as /usr/local/bin/cloudflared");
  }
  return { source, path };
}

export const tunnelStates = Object.freeze(["ready", "missing", "downloading", "failed", "off", "unsupported"] as const);
export type TunnelState = (typeof tunnelStates)[number];

export interface HostTunnelStatus {
  source: TunnelSource;
  state: TunnelState;
  executable?: string;
  version?: string;
  error?: string;
  downloadable: boolean;
}

export const hostTunnelStatusLimits = Object.freeze({ executable: TUNNEL_PATH_LIMIT, text: TUNNEL_TEXT_LIMIT });

export function parseHostTunnelStatus(value: unknown): HostTunnelStatus {
  if (!isObject(value) || Object.keys(value).some(key => !["source", "state", "executable", "version", "error", "downloadable"].includes(key))) {
    throw new Error("Invalid tunnel status");
  }
  if (!(tunnelSources as readonly unknown[]).includes(value.source) || !(tunnelStates as readonly unknown[]).includes(value.state)
    || typeof value.downloadable !== "boolean") throw new Error("Invalid tunnel status");
  const status: HostTunnelStatus = { source: value.source as TunnelSource, state: value.state as TunnelState, downloadable: value.downloadable };
  for (const key of ["executable", "version", "error"] as const) {
    const item = value[key];
    if (item === undefined) continue;
    if (typeof item !== "string" || item.length > (key === "executable" ? TUNNEL_PATH_LIMIT : TUNNEL_TEXT_LIMIT) || item.includes("\0")) throw new Error("Invalid tunnel status");
    status[key] = item;
  }
  return status;
}

export const tunnelUnavailableReasons = Object.freeze(["on-host", "sandbox", "off", "missing", "downloading", "failed"] as const);
export type TunnelUnavailableReason = (typeof tunnelUnavailableReasons)[number];

const tunnelUnavailableTexts: Readonly<Record<TunnelUnavailableReason, string>> = Object.freeze({
  "on-host": "The tunnel serves only from a session's sandbox, and this session runs on its host itself.",
  sandbox: "This host's sandbox can't run session services yet: the tunnel works in the Linux sandbox only.",
  off: "This host's owner refuses tunnels on it.",
  missing: "This host has no cloudflared for the tunnel. Its owner can find one installed there, give its path or download one, under Settings → Hosts → the host → Extensions.",
  downloading: "This host is downloading cloudflared for the tunnel: the tool is offered once it is ready, within a few minutes.",
  failed: "This host couldn't download cloudflared for the tunnel. It tries again later; its owner can see why, or set one up another way, under Settings → Hosts → the host → Extensions.",
});

export function tunnelUnavailableText(reason: string): string {
  return tunnelUnavailableTexts[reason as TunnelUnavailableReason] ?? "This session can't put a server online from its host.";
}

export function tunnelUnavailableReason(state: TunnelState): TunnelUnavailableReason | undefined {
  return state === "ready" ? undefined : state === "unsupported" ? "sandbox" : state;
}

export const tunnelStopReasons = Object.freeze(["stop", "replaced", "session-stop", "closed", "archived", "revoked", "lifetime", "exited", "failed"] as const);
export type TunnelStopReason = (typeof tunnelStopReasons)[number];

export interface SessionTunnelView {
  url: string;
  access?: "link" | "public";
  startedBy: string;
  startedAt: string;
  expiresAt: string;
  command: string;
  port: number;
  connected: boolean;
}

export interface SessionTunnelRecord {
  url: string;
  expiresAt: string;
}

export interface SessionTunnelReport {
  sessionId: string;
  event: "started" | "stopped";
  url: string;
  actorId?: string;
  expiresAt?: string;
  reason?: TunnelStopReason;
}

const QUICK_URL = /^https:\/\/[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.trycloudflare\.com$/;

export function validTunnelUrl(url: unknown): url is string {
  return typeof url === "string" && QUICK_URL.test(url) && url !== `https://api.${QUICK_TUNNEL_DOMAIN}`;
}

export function parseSessionTunnelReport(value: unknown): SessionTunnelReport {
  if (!isObject(value) || Object.keys(value).some(key => !["sessionId", "event", "url", "actorId", "expiresAt", "reason"].includes(key))) throw new Error("Invalid tunnel report");
  if (typeof value.sessionId !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(value.sessionId)) throw new Error("Invalid tunnel report");
  if ((value.event !== "started" && value.event !== "stopped") || !validTunnelUrl(value.url)) throw new Error("Invalid tunnel report");
  if (value.actorId !== undefined && (typeof value.actorId !== "string" || !value.actorId || value.actorId.length > 200 || /[\0\r\n]/.test(value.actorId))) throw new Error("Invalid tunnel report");
  if (value.event === "started" && (typeof value.expiresAt !== "string" || !Number.isFinite(Date.parse(value.expiresAt)) || value.expiresAt.length > 64 || value.reason !== undefined)) {
    throw new Error("Invalid tunnel report");
  }
  if (value.event === "stopped" && (!(tunnelStopReasons as readonly unknown[]).includes(value.reason) || value.expiresAt !== undefined)) throw new Error("Invalid tunnel report");
  return { sessionId: value.sessionId, event: value.event, url: value.url,
    ...(value.actorId !== undefined ? { actorId: value.actorId as string } : {}),
    ...(value.event === "started" ? { expiresAt: new Date(value.expiresAt as string).toISOString() } : { reason: value.reason as TunnelStopReason }) };
}
