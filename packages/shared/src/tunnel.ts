/*
 * The tunnel tool (piki:tunnel; docs/design/tunnel.md): a session puts the web server it builds online at a public
 * https:// address. The server runs in the session's sandbox as a session service, which outlives the call that started
 * it; Cloudflare's `cloudflared` runs in the connector, on the host, and reaches the service through a Unix socket the
 * connector forwards into the sandbox. What the connector, the control plane and the apps all need.
 */

/** What the tool does: start the service and its tunnel, say how they stand, or stop both. */
export const tunnelActions = Object.freeze(["start", "status", "stop"] as const);
export type TunnelAction = (typeof tunnelActions)[number];

/** Where a quick tunnel's addresses are: a name of Cloudflare's under trycloudflare.com. */
export const QUICK_TUNNEL_DOMAIN = "trycloudflare.com";
/**
 * A quick tunnel's address, as cloudflared prints it once Cloudflare gave it one, from one line of its output; undefined
 * for any other line. `api.trycloudflare.com`, which it asks for the address and names in its errors, is never one.
 */
export function quickTunnelUrl(line: string): string | undefined {
  for (const match of line.matchAll(/https:\/\/([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)\.trycloudflare\.com(?![a-z0-9.-])/g)) {
    if (match[1] !== "api") return `https://${match[1]}.${QUICK_TUNNEL_DOMAIN}`;
  }
  return undefined;
}

/**
 * The longest a session service runs, in seconds (HostConfig.serviceLifetimeSeconds): its host's owner and admins set
 * it, from 5 minutes to a day, 4 hours by default. A service that reaches it stops, and its tunnel with it.
 */
export const serviceLifetimeLimits = Object.freeze({ min: 300, max: 86_400, default: 14_400 });

/** How many of a service's last lines `status` and the panel show, and how long each may be. */
export const serviceOutputLimits = Object.freeze({ lines: 40, lineLength: 500, bytes: 64 * 1024 });

/*
 * Where a host's cloudflared comes from (HostConfig.tunnel), as its owner chooses on its page: found on the host, at a
 * path they give, downloaded by the connector, or none: `off` refuses tunnels on the host whatever its workspaces chose.
 */
export const tunnelSources = Object.freeze(["auto", "path", "download", "off"] as const);
export type TunnelSource = (typeof tunnelSources)[number];

export interface HostTunnelConfig {
  /**
   * auto: the connector looks for one (PIKIBUN_CLOUDFLARED, then cloudflared on its PATH and where packages install it,
   * then one it downloaded); path: the cloudflared executable at `path`, or none; download: the connector downloads
   * Cloudflare's release for the host and keeps it up to date; off: no tunnels on this host.
   */
  source: TunnelSource;
  /** With `path`: the executable's absolute path on the host. */
  path?: string;
}

export const defaultHostTunnelConfig: Readonly<HostTunnelConfig> = Object.freeze({ source: "auto" });
const TUNNEL_PATH_LIMIT = 4096;
const TUNNEL_TEXT_LIMIT = 1024;

const isObject = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);

/** A host's tunnel setting: a known source, and an absolute path with `path` only. */
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

/**
 * How a host's cloudflared stands, as its connector reports it with its extensions:
 * - ready: sessions in its sandbox get the tunnel tool, where their workspace turns it on;
 * - missing: none was found, or the path its owner gave isn't cloudflared (`error` says which);
 * - downloading: the connector is downloading it (`error` says why the last try failed, if it did);
 * - failed: its download failed (`error`), and is tried again later;
 * - off: its owner refuses tunnels on the host;
 * - unsupported: its sessions have no Linux sandbox for the service (macOS and Windows sandboxes, hosts without one).
 */
export const tunnelStates = Object.freeze(["ready", "missing", "downloading", "failed", "off", "unsupported"] as const);
export type TunnelState = (typeof tunnelStates)[number];

export interface HostTunnelStatus {
  source: TunnelSource;
  state: TunnelState;
  /** The cloudflared the connector runs, as its host has it: its owner's to see, not its admins' or the workspaces'. */
  executable?: string;
  /** Its version, where the connector knows it. */
  version?: string;
  /** What went wrong, for its owner alone too: it may name a path they gave. */
  error?: string;
  /** The connector can download it on this host (Linux on x86-64 or ARM64, which Cloudflare builds a lone binary for). */
  downloadable: boolean;
}

export const hostTunnelStatusLimits = Object.freeze({ executable: TUNNEL_PATH_LIMIT, text: TUNNEL_TEXT_LIMIT });

/** A reported tunnel status, as the control plane accepts it. */
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

/**
 * Why a session whose workspace has the tunnel tool on can't use it (SessionView.extensions.unavailable): fixed reasons,
 * so nothing of its host's files or errors reaches the session's viewers.
 */
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

/** What to tell a session's people, and its agent, of why it has no tunnel. */
export function tunnelUnavailableText(reason: string): string {
  return tunnelUnavailableTexts[reason as TunnelUnavailableReason] ?? "This session can't put a server online from its host.";
}

/** The reason a session on a host whose cloudflared stands at `state` has no tunnel; undefined when it has one. */
export function tunnelUnavailableReason(state: TunnelState): TunnelUnavailableReason | undefined {
  return state === "ready" ? undefined : state === "unsupported" ? "sandbox" : state;
}

/**
 * Why a session's service and tunnel stopped, as its host reports it with `session.tunnel.stopped`: its tool's `stop` or
 * the panel's Stop button (stop), a newer `start` (replaced), someone stopping the session's work, the session closing (a
 * restart, a backup, its host stopping) or being archived, the session no longer letting the one who started it write
 * (revoked: an archive its host learnt of by itself, say), the host's service lifetime, its program exiting, or
 * cloudflared failing.
 */
export const tunnelStopReasons = Object.freeze(["stop", "replaced", "session-stop", "closed", "archived", "revoked", "lifetime", "exited", "failed"] as const);
export type TunnelStopReason = (typeof tunnelStopReasons)[number];

/** What the session panel shows of a session that is online (SessionView.tunnel). */
export interface SessionTunnelView {
  /** The public address. */
  url: string;
  /** Who started it: their message's call was approved as a host command. */
  startedBy: string;
  startedAt: string;
  /** When the host's service lifetime stops it. */
  expiresAt: string;
  /** What serves it: the program and its arguments, and the port it listens on in the sandbox. */
  command: string;
  port: number;
  /** cloudflared holds at least one connection to Cloudflare's edge. */
  connected: boolean;
}

/** A session that is online, as the session list shows it (SessionRecord.tunnel), until its host says it stopped. */
export interface SessionTunnelRecord {
  url: string;
  expiresAt: string;
}

/** Connector → control plane (`POST /api/connectors/self/tunnel`): a session's tunnel started or stopped. */
export interface SessionTunnelReport {
  sessionId: string;
  event: "started" | "stopped";
  url: string;
  /** Who started it (started) or stopped it (stopped, where a person did). */
  actorId?: string;
  /** started: when the host's service lifetime stops it. */
  expiresAt?: string;
  /** stopped: why. */
  reason?: TunnelStopReason;
}

const QUICK_URL = /^https:\/\/[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.trycloudflare\.com$/;

/** Whether `url` is an address a session's tunnel may have: a quick tunnel's, for now. */
export function validTunnelUrl(url: unknown): url is string {
  return typeof url === "string" && QUICK_URL.test(url) && url !== `https://api.${QUICK_TUNNEL_DOMAIN}`;
}

/** A report, as the control plane accepts it. */
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
