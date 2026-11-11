import { randomBytes, randomUUID } from "node:crypto";
import { Buffer } from "node:buffer";
import { mkdir, realpath, lstat, open, link, rename, unlink } from "node:fs/promises";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { WebSocket as CompressingSocket } from "ws";
import { z } from "zod";
import type { ConnectorCapabilities, ConnectorCredentials, ConnectorRpcRequest, ConnectorRpcResponse, LocalModelSummary, RestoreDescriptor } from "../../../packages/shared/src/connector.js";
import { connectorLimits, connectorRequestTimeoutMs } from "../../../packages/shared/src/connector.js";
import { sha256, signToken } from "../../../packages/shared/src/crypto.js";
import { ToolDefinitionsSource } from "./tool-definitions-source.js";
import { bundledToolDefinitions } from "../../../packages/shared/src/tool-definitions.js";
import type { AuthorizationRequest, AuthorizationResult, GitHubEffectAuthority, GitHubIssueView, RunnerAction, RunnerBinding, ScheduleToolResult, SessionActivity, SessionBranch } from "../../../packages/shared/src/types.js";
import type { SessionsToolResult } from "../../../packages/shared/src/cross-session.js";
import { MAX_CLONE_BRANCHES } from "./clone-branches.js";
import { sessionActivities } from "../../../packages/shared/src/types.js";
import { buildVersion, CONNECTOR_VERSION_HEADER, DEVELOPMENT_CONNECTOR_VERSION } from "../../../packages/shared/src/version.js";
import { acquireRunnerLease } from "./lease.js";
import type { SandboxBackendConfig } from "./sandbox-backend.js";
import { CREATE_FILE, exactMode, OPEN_DIRECTORY, OPEN_FILE, windows } from "./platform.js";
import type { LocalModels } from "./local-pi.js";
import { modelSummary } from "./local-pi.js";
import { assertId, ConnectorSetupError, RunnerError, verifyRunnerTicket } from "./protocol.js";
import { parseEgressGrant, relayGitRequest, relayPath } from "./egress.js";
import { withHostToolCapabilities } from "./host-capabilities.js";
import { HostCredentialError, hostGitAuthorization } from "./git-credentials.js";
import { detectGpu, HostConfigSource } from "./host-config.js";
import type { GpuKind, RepositoryCacheMode } from "../../../packages/shared/src/host-config.js";
import { recoverResourceOrphans } from "./resources.js";
import { RepositoryCache } from "./repo-cache.js";
import { RunnerService, createRunnerApp } from "./server.js";
import type { RunnerConfig } from "./session.js";
import { HostExtensions } from "./extensions/host.js";
import { ExtensionStore } from "./extensions/store.js";
import { parseExtensionsSyncAnswer, type ExtensionRequestResult } from "../../../packages/shared/src/host-extensions.js";
import { browserDownloads, HostBrowserSource, type HostBrowserOptions } from "./browser-host.js";
import { cloudflaredDownloads, HostTunnels, HostTunnelSource, type HostTunnelOptions } from "./tunnel-host.js";
import type { SessionTunnelReport } from "../../../packages/shared/src/tunnel.js";

const STATE_FILE = "connector.json";
const CALLBACK_LIMIT = 64 * 1024;
const EXTENSION_SYNC_MS = 30_000;
const WORKSPACE_EXTENSIONS_LIMIT = 1024 * 1024;
const GITHUB_READ_LIMIT = 128 * 1024;
const BROKERED_LIMIT = 1024 * 1024;
const TOOL_DEFINITIONS_LIMIT = 1024 * 1024;
const BROKERED_ROUTE = /^[a-z0-9-]+(?:\/[a-z0-9-]+){0,3}$/;
const HOST_CONFIG_LIMIT = 128 * 1024;
const SCHEDULES_LIMIT = 4 * 1024 * 1024;
const SESSIONS_LIMIT = 2 * 1024 * 1024;
const RPC_TIMEOUT = 30_000;
const DRAIN_TIMEOUT = 30_000;
const RECONNECT_WAIT = 15_000;
const TOKEN = /^[A-Za-z0-9_-]{32,512}$/;
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const encoder = new TextEncoder();
const credentialsSchema = z.object({
  connectorId: z.string().regex(IDENTIFIER), token: z.string().regex(TOKEN), controlPlaneUrl: z.string(),
}).strict();
const welcomeSchema = z.object({
  type: z.literal("welcome"), connectorId: z.string().regex(IDENTIFIER), connectionToken: z.string().regex(TOKEN),
}).strict();
const actorSchema = z.string().min(1).max(200).regex(/^[^\x00-\x1f\x7f]+$/);
const ticketSchema = z.object({
  aud: z.literal("runner"), sessionId: z.string().regex(IDENTIFIER), actorId: actorSchema, ownerId: actorSchema,
  action: z.enum(["create", "view", "events", "submit", "ask", "backup", "restart", "restore", "stop", "files", "revert", "fork", "pack", "unpack", "withdraw", "upload", "tunnel", "image"]),
  policyVersion: z.number().int().positive(), iat: z.number().int(), exp: z.number().int(),
  jti: z.string().regex(IDENTIFIER), bodyHash: z.string().regex(/^[A-Za-z0-9_-]{43}$/), connectorId: z.string().regex(IDENTIFIER),
}).strict();
const requestSchema = z.object({
  type: z.literal("request"), id: z.string().regex(IDENTIFIER), method: z.enum(["GET", "POST"]),
  path: z.string().max(512), body: z.string().max(connectorLimits.requestBytes), ticket: ticketSchema,
}).strict();

export function controlPlaneOrigin(value: string, allowInsecureLoopback = false): string {
  if (typeof value !== "string" || /[\s\\\x00-\x1f\x7f]/.test(value)) throw new Error("Invalid control-plane origin");
  let url: URL;
  try { url = new URL(value); } catch { throw new Error("Invalid control-plane origin"); }
  const loopback = ["127.0.0.1", "[::1]", "localhost"].includes(url.hostname);
  if (url.username || url.password || url.search || url.hash || url.pathname !== "/"
    || (value !== url.origin && value !== `${url.origin}/`)
    || (url.protocol !== "https:" && !(allowInsecureLoopback && loopback && url.protocol === "http:"))) {
    throw new Error("Use an HTTPS origin; HTTP requires explicit loopback development opt-in");
  }
  return url.origin;
}

function credentials(value: unknown, origin?: string, allowInsecureLoopback = false): ConnectorCredentials {
  const c = credentialsSchema.parse(value);
  const controlPlaneUrl = controlPlaneOrigin(c.controlPlaneUrl, allowInsecureLoopback);
  if (origin && controlPlaneUrl !== origin) throw new ConnectorSetupError("Connector state is bound to a different control-plane origin; use its saved server or a separate --state-dir");
  return { connectorId: c.connectorId, token: c.token, controlPlaneUrl };
}

async function privateDirectory(directory: string): Promise<string> {
  const path = resolve(directory);
  await mkdir(path, { recursive: true, mode: 0o700 });
  const stat = await lstat(path);
  if (!stat.isDirectory() || stat.isSymbolicLink() || !exactMode(stat, 0o700) || await realpath(path) !== path) {
    throw new ConnectorSetupError("Connector state directory must be an owned, non-symlink mode0700 directory");
  }
  return path;
}

export async function readConnectorState(directory: string, origin?: string, allowInsecureLoopback = false): Promise<ConnectorCredentials | undefined> {
  const path = join(await privateDirectory(directory), STATE_FILE);
  let file;
  try { file = await open(path, OPEN_FILE); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw new Error("Cannot safely open connector state"); }
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.nlink !== 1 || !exactMode(stat, 0o600) || stat.size > 4096) throw new Error("Connector state must be an owned mode0600 regular file");
    const state = JSON.parse(await file.readFile("utf8"));
    if (state.version !== 1) throw new Error("Unsupported connector state version");
    return credentials(state.credentials, origin, allowInsecureLoopback);
  } finally { await file.close(); }
}

export async function writeConnectorState(directory: string, value: ConnectorCredentials, allowInsecureLoopback = false, replace = false): Promise<void> {
  const path = await privateDirectory(directory);
  const saved = credentials(value, undefined, allowInsecureLoopback);
  const temporary = join(path, `.connector-${randomUUID()}.tmp`);
  const file = await open(temporary, CREATE_FILE, 0o600);
  try {
    await file.writeFile(JSON.stringify({ version: 1, credentials: saved }));
    await file.sync();
  } finally { await file.close(); }
  if (replace) {
    try { await rename(temporary, join(path, STATE_FILE)); } catch (error) { await unlink(temporary); throw error; }
  } else {
    try {
      await link(temporary, join(path, STATE_FILE));
    } finally { await unlink(temporary); }
  }
  if (windows) return;
  const directoryHandle = await open(path, OPEN_DIRECTORY);
  try { await directoryHandle.sync(); } finally { await directoryHandle.close(); }
}

async function boundedBody(response: Response, maximum: number, signal?: AbortSignal): Promise<Uint8Array> {
  const declared = response.headers.get("content-length");
  if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > maximum)) {
    await response.body?.cancel();
    throw new Error("Response exceeds connector limit");
  }
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  const abort = () => { void reader.cancel().catch(() => {}); };
  signal?.addEventListener("abort", abort, { once: true });
  try {
    while (true) {
      signal?.throwIfAborted();
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maximum) throw new Error("Response exceeds connector limit");
      chunks.push(value);
    }
    signal?.throwIfAborted();
    const result = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.byteLength; }
    return result;
  } finally {
    signal?.removeEventListener("abort", abort);
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

class CallbackRefused extends Error {
  constructor(readonly status: number) { super("Scoped connector callback denied or unavailable"); }
}

const refusedReport = (error: unknown) => error instanceof CallbackRefused && error.status === 400;

function decodeJson(bytes: Uint8Array): unknown {
  try { return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); }
  catch { throw new Error("Invalid control-plane response"); }
}

export async function connectorManifest(localModels: LocalModels, allowFaux = false): Promise<LocalModelSummary[]> {
  const models = (await localModels.manifest()).map(modelSummary);
  if (models.length > connectorLimits.models) throw new Error("Too many local models");
  const seen = new Set<string>();
  for (const model of models) {
    const key = JSON.stringify([model.provider, model.modelId]);
    if (seen.has(key) || (model.provider === "faux" && !allowFaux)) throw new Error("Invalid or disabled local model");
    seen.add(key);
  }
  return models;
}

function capabilities(value?: ConnectorCapabilities, mode: { unsandboxed?: boolean; repositoryCache?: boolean; gpu?: GpuKind } = {}): ConnectorCapabilities {
  const result = value ?? { platform: process.platform, sandbox: false, productionShell: false };
  if (typeof result.platform !== "string" || !/^[A-Za-z0-9_-]{1,40}$/.test(result.platform)
    || typeof result.sandbox !== "boolean" || typeof result.productionShell !== "boolean"
    || (result.productionShell && !result.sandbox)) throw new Error("Invalid connector capabilities");
  const cache = mode.repositoryCache ? { repositoryCache: true } : {};
  if (mode.unsandboxed) return { platform: result.platform, sandbox: false, productionShell: false, unsandboxed: true, chatOptions: true, chatImages: true, gitProviders: true, gitServers: true, gitPush: true,
    github: true, githubIssues: true, sources: true, schedules: true, crossSessions: true, plainGit: true, sessionBranches: true, conversationBackups: true, hostConfig: true, compactionConfig: true, ...cache };
  return { platform: result.platform, sandbox: result.sandbox, productionShell: result.productionShell, chatOptions: true, chatImages: true, gitProviders: true, gitServers: true, gitPush: true,
    github: true, githubIssues: true, sources: true, schedules: true, crossSessions: true, plainGit: true, cloneBackups: true, sessionBranches: true, conversationBackups: true, hostConfig: true, compactionConfig: true, ...cache,
    sessionPacking: true, ...(mode.gpu ? { gpu: mode.gpu } : {}) };
}

export async function claimConnectorPairing(options: {
  server: string; pairing: { id: string; code: string }; localModels: LocalModels;
  capabilities?: ConnectorCapabilities; unsandboxed?: boolean; gpu?: GpuKind; allowFaux?: boolean; allowInsecureLoopback?: boolean; fetch?: typeof fetch; signal?: AbortSignal;
}): Promise<ConnectorCredentials> {
  const origin = controlPlaneOrigin(options.server, options.allowInsecureLoopback);
  const { id, code } = options.pairing;
  assertId(id);
  if (typeof code !== "string" || !/^[A-Za-z0-9_-]{8,256}$/.test(code)) throw new Error("Invalid pairing code");
  const response = await (options.fetch ?? fetch)(`${origin}/api/connectors/pairings/${id}/claim`, {
    method: "POST", redirect: "error", credentials: "omit",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ code, models: await connectorManifest(options.localModels, options.allowFaux), capabilities: withHostToolCapabilities(capabilities(options.capabilities, options)) }),
    signal: AbortSignal.any([AbortSignal.timeout(15_000), ...(options.signal ? [options.signal] : [])]),
  });
  if (!response.ok) { await response.body?.cancel(); throw new ConnectorSetupError("Pairing rejected or unavailable: the code may be wrong, expired (codes last 10 minutes) or already used. Create a new pairing code and try again."); }
  const bytes = await boundedBody(response, CALLBACK_LIMIT, AbortSignal.any([AbortSignal.timeout(15_000), ...(options.signal ? [options.signal] : [])]));
  const value = z.object({ credentials: credentialsSchema }).strict().parse(decodeJson(bytes));
  return credentials(value.credentials, origin, options.allowInsecureLoopback);
}

export async function validateRelayRequest(value: unknown, connectorId: string, verifierSecret: string): Promise<{ rpc: ConnectorRpcRequest; authorization: string }> {
  const rpc = requestSchema.parse(value);
  if (encoder.encode(rpc.body).length > connectorLimits.requestBytes) throw new Error("Invalid relay request");
  let action: RunnerAction;
  let sessionId: string;
  if (rpc.path === "/v1/sessions" && rpc.method === "POST") {
    action = "create";
    let binding: RunnerBinding;
    try { binding = JSON.parse(rpc.body); } catch { throw new Error("Invalid create binding"); }
    sessionId = assertId(binding?.session?.id ?? "");
    if (binding.session.connectorId !== connectorId || binding.model?.connectorId !== connectorId
      || binding.owner?.id !== rpc.ticket?.ownerId || binding.session.ownerId !== rpc.ticket?.ownerId) throw new Error("Foreign connector binding");
  } else {
    const match = /^\/v1\/sessions\/([A-Za-z0-9][A-Za-z0-9_-]{0,127})\/(view|view\/[0-9a-f]{32}|submit|ask|restart|backup|restore|stop|files|revert|fork|pack|unpack|withdraw|upload|tunnel|image)$/.exec(rpc.path);
    if (!match) throw new Error("Relay path is not allowed");
    sessionId = match[1]!;
    action = match[2]!.startsWith("view/") ? "view" : match[2] as RunnerAction;
    if (rpc.method !== (action === "view" ? "GET" : "POST")) throw new Error("Relay method is not allowed");
    if (action === "restore") {
      const input = decodeJson(encoder.encode(rpc.body)) as { binding?: RunnerBinding };
      if (input.binding?.session?.id !== sessionId || input.binding.session.connectorId !== connectorId
        || input.binding.model?.connectorId !== connectorId || input.binding.owner?.id !== rpc.ticket?.ownerId
        || input.binding.session.ownerId !== rpc.ticket?.ownerId) throw new Error("Foreign restore binding");
    }
  }
  const ticket = rpc.ticket;
  if (ticket.connectorId !== connectorId
    || (rpc.method === "GET" && rpc.body !== "")
    || (["create", "restore", "restart", "fork", "pack", "unpack"].includes(action) && ticket.actorId !== ticket.ownerId)) throw new Error("Invalid relay ticket");
  const authorization = await signToken(ticket, verifierSecret);
  await verifyRunnerTicket(authorization, verifierSecret, action, sessionId, rpc.body);
  return { rpc, authorization };
}

export interface ConnectorSocket {
  readonly readyState: number;
  readonly bufferedAmount: number;
  readonly protocol: string;
  addEventListener(type: string, listener: (event: Event) => void): void;
  send(data: string): void;
  close(code?: number, reason?: string): void;
}

export interface ConnectorRuntime {
  fetch(request: Request): Response | Promise<Response>;
  close(): Promise<void>;
  resume?(): Promise<void>;
}

export interface ConnectorOptions {
  dataDir: string;
  server?: string;
  pairing?: { id: string; code: string };
  replacePairing?: boolean;
  localModels: LocalModels;
  allowInsecureLoopback?: boolean;
  allowFaux?: boolean;
  allowTestShell?: boolean;
  capabilities?: ConnectorCapabilities;
  resources?: RunnerConfig["resources"];
  unsandboxed?: boolean;
  directUploads?: boolean;
  sandboxBackend?: SandboxBackendConfig;
  gpu?: GpuKind | null;
  version?: string;
  fetch?: typeof fetch;
  createSocket?: (url: string, protocols: string[]) => ConnectorSocket;
  runtimeFactory?: (config: RunnerConfig) => Promise<ConnectorRuntime>;
  browser?: Partial<Omit<HostBrowserOptions, "root" | "signal">>;
  tunnel?: Partial<Omit<HostTunnelOptions, "root" | "signal">>;
  acquireLease?: typeof acquireRunnerLease;
  reconnectDelayMs?: number;
  extensions?: HostExtensions;
  remoteExtensionInstalls?: boolean;
  onStatus?: (status: "connecting" | "connected" | "disconnected" | "stopped", reason?: string) => void;
  onWarning?: (warning: "resources-unavailable") => void;
}

type Runtime = { value: ConnectorRuntime; repositoryCache: RepositoryCacheMode; resumed: boolean };

type Generation = {
  socket: ConnectorSocket;
  abort: AbortController;
  done: PromiseWithResolvers<void>;
  welcome: PromiseWithResolvers<string>;
  connectionToken?: string;
  active: Set<Promise<void>>;
  tail: Promise<void>;
  waiting: Set<PromiseWithResolvers<"restarting">>;
  incomingBytes: number;
  reason?: string;
  runtimeReady: PromiseWithResolvers<void>;
};

function effectAuthority(request: GitHubEffectAuthority): { capability: string } | { admissionId: string } {
  return request.capability !== undefined ? { capability: request.capability } : { admissionId: request.admissionId! };
}

export class LocalConnector {
  readonly ready: Promise<void>;
  private readonly readiness = Promise.withResolvers<void>();
  private readonly lifetime = new AbortController();
  private readonly secret = Buffer.from(randomBytes(48)).toString("base64url");
  private readonly seen = new Map<string, number>();
  private generation?: Generation;
  private welcomed?: Generation;
  private online = Promise.withResolvers<Generation>();
  private runtime?: Runtime;
  private restarting = false;
  private readonly executing = new Set<Promise<void>>();
  private readonly hostConfig = new HostConfigSource(async () => (await this.callback(await this.connection(), "/api/connectors/self/config", {}, HOST_CONFIG_LIMIT) as { config?: unknown } | undefined)?.config);
  private lastReason?: string;
  private loop?: Promise<void>;
  private starting?: Promise<void>;
  private stopping?: Promise<void>;
  private releaseLease?: () => Promise<void>;
  private state?: ConnectorCredentials;
  private directory = "";
  private browser: HostBrowserSource | undefined;
  private tunnel: HostTunnelSource | undefined;
  private tunnels: HostTunnels | undefined;
  private readonly repositoryCaches = new Map<Exclude<RepositoryCacheMode, "off">, RepositoryCache>();
  private readonly gpu?: GpuKind;
  private hostExtensions?: HostExtensions;
  private toolDefinitionsSource?: ToolDefinitionsSource;

  constructor(private readonly options: ConnectorOptions) {
    this.ready = this.readiness.promise;
    const gpu = options.unsandboxed ? undefined : options.gpu === undefined ? detectGpu() : options.gpu;
    if (gpu) this.gpu = gpu;
    void this.ready.catch(() => {});
    if (options.allowTestShell && !options.allowFaux) throw new Error("Test shell requires explicit faux test mode");
    if (options.reconnectDelayMs !== undefined && (!Number.isFinite(options.reconnectDelayMs) || options.reconnectDelayMs < 1 || options.reconnectDelayMs > 30_000)) throw new Error("Invalid reconnect delay");
  }

  get connectorId(): string | undefined { return this.state?.connectorId; }

  start(): Promise<void> {
    if (this.lifetime.signal.aborted) return Promise.reject(new Error("Connector has stopped"));
    this.starting ??= this.initialize().catch(async (error: unknown) => {
      const failure = error instanceof ConnectorSetupError ? error
        : new Error("Connector initialization failed; verify private state, pairing, local models and lease prerequisites");
      this.readiness.reject(failure);
      await this.releaseLease?.();
      this.releaseLease = undefined;
      throw failure;
    });
    return this.starting.then(() => this.ready);
  }

  private async initialize(): Promise<void> {
    if (!this.options.runtimeFactory && !["linux", "darwin", "win32"].includes(process.platform)) throw new Error("Connected runner requires Linux, macOS or Windows; no host-shell fallback");
    if (!this.options.runtimeFactory && process.platform !== "linux" && !this.options.unsandboxed && !this.options.sandboxBackend)
      throw new Error("This platform has no sandbox unless one is chosen (sandboxBackend); no host-shell fallback");
    this.directory = await privateDirectory(this.options.dataDir);
    this.browser = new HostBrowserSource({ supported: process.platform === "linux" && !this.options.unsandboxed && !this.options.sandboxBackend,
      ...this.options.browser, root: browserDownloads(this.directory), signal: this.lifetime.signal });
    this.tunnel = new HostTunnelSource({ supported: process.platform === "linux" && !this.options.unsandboxed && !this.options.sandboxBackend,
      ...this.options.tunnel, root: cloudflaredDownloads(this.directory), signal: this.lifetime.signal });
    const tunnel = this.tunnel;
    this.tunnels = new HostTunnels({ cloudflared: () => tunnel.current(), directory: join(this.directory, "tunnels"),
      log: line => { if (/\b(ERR|WRN)\b/.test(line)) process.stderr.write(`cloudflared: ${line.slice(0, 1000)}\n`); } });
    this.hostExtensions = this.options.extensions
      ?? new HostExtensions(ExtensionStore.forStateDir(this.directory), { remoteInstalls: this.options.remoteExtensionInstalls !== false });
    await this.hostExtensions.load();
    this.releaseLease = await (this.options.acquireLease ?? acquireRunnerLease)(this.directory, () => {
      this.lifetime.abort();
      this.disconnect(this.generation, "Runner lease lost");
      void this.stop().catch(() => {});
    });
    this.lifetime.signal.throwIfAborted();
    if (this.options.resources) {
      try { await recoverResourceOrphans(this.options.resources); }
      catch { this.options.onWarning?.("resources-unavailable"); }
    }
    const origin = this.options.server === undefined ? undefined : controlPlaneOrigin(this.options.server, this.options.allowInsecureLoopback);
    const replace = this.options.pairing !== undefined && this.options.replacePairing === true;
    this.state = replace ? undefined : await readConnectorState(this.directory, origin, this.options.allowInsecureLoopback);
    if (this.state && this.options.pairing) throw new ConnectorSetupError("This machine is already paired; run without --pairing-id, add --force to replace the saved pairing, or use a separate --state-dir for another connection");
    if (!this.state) {
      if (!origin || !this.options.pairing) throw new ConnectorSetupError("First connection requires --server and --pairing-id");
      this.state = await claimConnectorPairing({ ...this.options, gpu: this.gpu, server: origin, pairing: this.options.pairing, signal: this.lifetime.signal });
      await writeConnectorState(this.directory, this.state, this.options.allowInsecureLoopback, replace);
    }
    this.lifetime.signal.throwIfAborted();
    this.loop = this.connectLoop();
    void this.loop.catch(() => { this.readiness.reject(new Error("Connector stopped before becoming ready")); });
  }

  private disconnect(generation?: Generation, reason = "Connection ended"): void {
    if (!generation || generation.abort.signal.aborted) return;
    generation.reason ??= reason;
    generation.abort.abort();
    if (this.welcomed === generation) {
      this.welcomed = undefined;
      this.online = Promise.withResolvers<Generation>();
    }
    for (const waiting of generation.waiting) waiting.reject(new Error("Connector connection lost"));
    generation.waiting.clear();
    generation.welcome.reject(new Error("Connector connection lost"));
    generation.runtimeReady.reject(new Error("Connector connection lost"));
    generation.done.resolve();
    try { generation.socket.close(1000, "Connection ended"); } catch { }
  }

  private async connectLoop(): Promise<void> {
    let failures = 0;
    while (!this.lifetime.signal.aborted) {
      this.lastReason = undefined;
      try { await this.connectOnce(); failures = 0; }
      catch { failures++; }
      if (this.lifetime.signal.aborted) break;
      this.options.onStatus?.("disconnected", this.lastReason);
      const wait = this.options.reconnectDelayMs ?? Math.min(30_000, 500 * 2 ** Math.min(failures, 6)) + Math.floor(Math.random() * 250);
      try { await delay(wait, undefined, { signal: this.lifetime.signal }); } catch { break; }
    }
  }

  private async connectOnce(): Promise<void> {
    const state = this.state!;
    this.options.onStatus?.("connecting");
    const url = new URL("/api/connectors/socket", state.controlPlaneUrl);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    const socket = (this.options.createSocket ?? defaultSocket)(url.href, ["opencara-pi-v1", `bearer.${state.token}`]);
    const generation: Generation = { socket, abort: new AbortController(), done: Promise.withResolvers<void>(), welcome: Promise.withResolvers<string>(), active: new Set(), tail: Promise.resolve(), waiting: new Set(), incomingBytes: 0, runtimeReady: Promise.withResolvers<void>() };
    void generation.runtimeReady.promise.catch(() => {});
    this.generation = generation;
    const timeout = setTimeout(() => this.disconnect(generation, "Relay did not welcome the connection within 15s"), 15_000);
    let lastPong = Date.now();
    const heartbeat = setInterval(() => {
      if (Date.now() - lastPong > 65_000) return this.disconnect(generation, "No pong from the relay for 65s");
      if (socket.readyState === 1 && socket.bufferedAmount + 4 <= connectorLimits.bufferedBytes) {
        try { socket.send("ping"); } catch { this.disconnect(generation, "Ping could not be sent"); }
      }
    }, 20_000);
    socket.addEventListener("error", () => this.disconnect(generation, "Socket error"));
    socket.addEventListener("close", event => {
      const { code, reason } = event as Partial<CloseEvent>;
      const detail = typeof reason === "string" ? reason.replace(/[^\x20-\x7e]/g, "").slice(0, 120) : "";
      this.disconnect(generation, `Relay closed the connection${typeof code === "number" ? ` (${code}${detail ? ` ${detail}` : ""})` : ""}`);
    });
    socket.addEventListener("message", event => {
      if (generation.abort.signal.aborted) return;
      const data: unknown = "data" in event ? event.data : undefined;
      if (data === "pong") { lastPong = Date.now(); return; }
      if (typeof data !== "string" || encoder.encode(data).length > connectorLimits.frameBytes) return this.disconnect(generation, "Invalid relay frame");
      let value: unknown;
      try { value = JSON.parse(data); } catch { return this.disconnect(generation, "Invalid relay frame"); }
      if (!generation.connectionToken) {
        const welcome = welcomeSchema.safeParse(value);
        if (!welcome.success || welcome.data.connectorId !== state.connectorId
          || socket.protocol !== "opencara-pi-v1") return this.disconnect(generation, "Invalid relay welcome");
        generation.connectionToken = welcome.data.connectionToken;
        this.welcomed = generation;
        this.online.resolve(generation);
        generation.welcome.resolve(welcome.data.connectionToken);
        return;
      }
      this.dispatch(generation, value, encoder.encode(data).length);
    });
    try {
      await generation.welcome.promise;
      clearTimeout(timeout);
      const { config: configured, answered } = await this.hostConfig.refresh();
      this.requireGeneration(generation);
      await this.browser?.apply(configured.browser).catch(() => {});
      await this.tunnel?.apply(configured.tunnel).catch(() => {});
      const runtime = await this.ensureRuntime(generation, answered || !this.runtime ? configured.repositoryCache : this.runtime.repositoryCache);
      this.requireGeneration(generation);
      const advertised = capabilities(this.options.capabilities, { unsandboxed: this.options.unsandboxed, repositoryCache: runtime.repositoryCache !== "off", gpu: this.gpu });
      await this.callback(generation, "/api/connectors/self/manifest", { models: await connectorManifest(this.options.localModels, this.options.allowFaux),
        capabilities: { ...withHostToolCapabilities(advertised), ...(this.options.directUploads ? { directUploads: true } : {}) } });
      this.requireGeneration(generation);
      generation.runtimeReady.resolve();
      void this.syncExtensions(generation);
      this.options.onStatus?.("connected");
      this.readiness.resolve();
      if (!runtime.resumed) {
        runtime.resumed = true;
        void runtime.value.resume?.().catch(() => {});
      }
      await generation.done.promise;
    } catch (error) {
      this.disconnect(generation, "Connection setup failed");
      throw error;
    } finally {
      clearTimeout(timeout);
      clearInterval(heartbeat);
      this.disconnect(generation);
      this.lastReason = generation.reason;
      await Promise.allSettled([...generation.active]);
      if (this.generation === generation) this.generation = undefined;
    }
  }

  private async syncExtensions(generation: Generation): Promise<void> {
    const extensions = this.hostExtensions;
    if (!extensions) return;
    let results: ExtensionRequestResult[] = [];
    let refusedStatus: string | undefined;
    let pikiExtensions = true;
    const signal = AbortSignal.any([generation.abort.signal, this.lifetime.signal]);
    while (!signal.aborted) {
      try {
        await extensions.refreshIfChanged();
        const current = await this.hostConfig.current();
        if (this.browser) await this.browser.apply(current.browser).catch(() => {});
        if (this.tunnel) await this.tunnel.apply(current.tunnel).catch(() => {});
        const browser = this.browser?.status();
        const tunnel = this.tunnel?.status();
        const statusKey = browser || tunnel ? JSON.stringify({ browser, tunnel }) : undefined;
        let withStatus = statusKey !== undefined && statusKey !== refusedStatus;
        const report = () => {
          const base = pikiExtensions ? extensions.report() : extensions.reportWithoutPikiExtensions();
          return withStatus ? { ...base, ...(browser ? { browser } : {}), ...(tunnel ? { tunnel } : {}) } : base;
        };
        const sync = async () => parseExtensionsSyncAnswer(await this.callback(generation, "/api/connectors/self/extensions", { report: report(), results }));
        let answer: ReturnType<typeof parseExtensionsSyncAnswer> | undefined;
        while (!answer) {
          try { answer = await sync(); }
          catch (error) {
            if (!refusedReport(error) || (!withStatus && !pikiExtensions)) throw error;
            if (withStatus) {
              withStatus = false;
              refusedStatus = statusKey;
            } else pikiExtensions = false;
          }
        }
        results = [];
        if (answer.requests.length) {
          results = await extensions.apply(answer.requests);
          continue;
        }
      } catch { }
      await delay(EXTENSION_SYNC_MS, undefined, { signal }).catch(() => {});
    }
  }

  private async ensureRuntime(generation: Generation, repositoryCache: RepositoryCacheMode): Promise<Runtime> {
    const replacing = this.runtime !== undefined && this.runtime.repositoryCache !== repositoryCache;
    if (replacing) {
      this.restarting = true;
      for (const waiting of generation.waiting) waiting.resolve("restarting");
    }
    try {
      if (replacing) await this.retireRuntime();
      if (!this.runtime) {
        const cache = repositoryCache === "off" || this.options.sandboxBackend ? undefined : this.repositoryCacheFor(repositoryCache);
        this.runtime = { value: await (this.options.runtimeFactory ?? defaultRuntime)(this.runnerConfig(cache)), repositoryCache, resumed: false };
      }
      return this.runtime;
    } finally {
      if (replacing) this.restarting = false;
    }
  }

  private async retireRuntime(): Promise<void> {
    const runtime = this.runtime;
    if (!runtime) return;
    this.runtime = undefined;
    await Promise.allSettled([...this.executing]);
    try { await runtime.value.close(); }
    catch {
      this.lifetime.abort();
      this.readiness.reject(new Error("Connector runtime could not be safely retired"));
      throw new Error("Connector runtime could not be safely retired");
    }
  }

  private async connection(): Promise<Generation> {
    const deadline = AbortSignal.any([this.lifetime.signal, AbortSignal.timeout(RECONNECT_WAIT)]);
    for (;;) {
      const current = this.welcomed;
      if (current && !current.abort.signal.aborted) return current;
      if (deadline.aborted) throw new Error("Connector is not connected");
      const online = this.online.promise;
      await new Promise<void>(resolve => {
        const done = () => { deadline.removeEventListener("abort", done); resolve(); };
        deadline.addEventListener("abort", done, { once: true });
        void online.then(done);
      });
    }
  }

  private runnerExtensions(extensions: HostExtensions): NonNullable<RunnerConfig["extensions"]> {
    return {
      installed: () => extensions.loaded,
      workspace: workspaceId => extensions.workspace(workspaceId, async () =>
        this.callback(await this.connection(), "/api/connectors/self/extensions/workspace", { workspaceId, toolDefinitions: true }, WORKSPACE_EXTENSIONS_LIMIT)),
      lastKnown: workspaceId => extensions.lastKnown(workspaceId),
      ...(this.options.localModels.modelRegistry ? { modelRegistry: this.options.localModels.modelRegistry } : {}),
    };
  }

  private runnerConfig(repositoryCache: RepositoryCache | undefined): RunnerConfig {
    const state = this.state!;
    const hostConfig = this.hostConfig;
    return {
      dataDir: join(this.directory, "runner"), controlPlaneUrl: state.controlPlaneUrl,
      sharedSecret: this.secret, connectorId: state.connectorId,
      allowFaux: this.options.allowFaux === true, allowTestShell: this.options.allowTestShell === true,
      resources: this.options.resources, unsandboxed: this.options.unsandboxed === true,
      pikiHostSignIn: process.env.PIKIBUN_PIKI_HOST_SIGN_IN === "1",
      ...(this.options.sandboxBackend && !this.options.unsandboxed ? { sandboxBackend: this.options.sandboxBackend } : {}),
      resolveModels: model => {
        if (this.lifetime.signal.aborted) throw new Error("Connector has stopped");
        return this.options.localModels.resolve(model);
      },
      compaction: this.options.localModels.compaction, identity: this.options.localModels.identity,
      ...(this.hostExtensions ? { extensions: this.runnerExtensions(this.hostExtensions) } : {}),
      ...(this.browser ? { browser: () => this.browser?.current(), browserStatus: () => this.browser?.status() } : {}),
      ...(this.tunnels && this.tunnel ? { tunnels: { open: (socket: string, signal?: AbortSignal) => this.tunnels!.open(socket, signal), status: () => this.tunnel?.status() } } : {}),
      reportTunnel: async report => this.reportTunnel(await this.connection(), report),
      authorize: async request => this.authorize(await this.connection(), request),
      reportActivity: async (sessionId, activity) => this.reportActivity(await this.connection(), sessionId, activity),
      reportBranches: async (sessionId, branches) => this.reportBranches(await this.connection(), sessionId, branches),
      githubComment: async request => {
        const payload = {
          sessionId: request.sessionId, actorId: request.actorId, approvalId: request.approvalId, ...effectAuthority(request),
          repository: request.repository, issue: request.issue, body: request.body,
        };
        return z.object({
          id: z.number().int().positive(), url: z.string().max(2048).regex(/^https:\/\/github\.com\//),
        }).strict().parse(await this.callback(await this.connection(), "/api/connectors/self/github/comment", payload));
      },
      githubRead: async request => {
        const payload = { sessionId: request.sessionId, actorId: request.actorId, admissionId: request.admissionId, callId: request.callId, repository: request.repository, issue: request.issue };
        const view = await this.brokerCallback(await this.connection(), "/api/connectors/self/github/read", payload, GITHUB_READ_LIMIT);
        z.looseObject({ repository: z.string(), number: z.number().int().positive(), title: z.string(), comments: z.array(z.unknown()) }).parse(view);
        return view as GitHubIssueView;
      },
      toolDefinitions: async () => {
        this.toolDefinitionsSource ??= new ToolDefinitionsSource(async () =>
          this.callback(await this.connection(), "/api/connectors/self/tools", {}, TOOL_DEFINITIONS_LIMIT));
        return await this.toolDefinitionsSource.get() ?? bundledToolDefinitions;
      },
      brokered: async (route, request) => {
        if (!BROKERED_ROUTE.test(route)) throw new RunnerError(400, "Invalid brokered tool route");
        return z.looseObject({}).parse(await this.brokerCallback(await this.connection(), `/api/connectors/self/${route}`, request, BROKERED_LIMIT));
      },
      githubMerge: async request => {
        const payload = {
          sessionId: request.sessionId, actorId: request.actorId, approvalId: request.approvalId, ...effectAuthority(request),
          repository: request.repository, pull: request.pull, sha: request.sha, method: request.method,
        };
        return z.object({
          sha: z.string().regex(/^[0-9a-f]{40}$/), url: z.string().max(2048).regex(/^https:\/\/github\.com\//),
        }).strict().parse(await this.brokerCallback(await this.connection(), "/api/connectors/self/github/merge", payload));
      },
      githubIssue: async request => {
        const payload = {
          sessionId: request.sessionId, actorId: request.actorId, approvalId: request.approvalId, ...effectAuthority(request),
          repository: request.repository, title: request.title, body: request.body,
        };
        return z.object({
          number: z.number().int().positive(), url: z.string().max(2048).regex(/^https:\/\/github\.com\/[^/]+\/[^/]+\/issues\/\d+$/),
        }).strict().parse(await this.brokerCallback(await this.connection(), "/api/connectors/self/github/issue", payload));
      },
      schedules: async request => {
        const result = await this.brokerCallback(await this.connection(), "/api/connectors/self/schedules", request, SCHEDULES_LIMIT);
        z.union([z.looseObject({ schedules: z.array(z.looseObject({ id: z.string() })) }), z.looseObject({ schedule: z.looseObject({ id: z.string() }) }),
          z.object({ deleted: z.string() }).strict()]).parse(result);
        return result as ScheduleToolResult;
      },
      crossSessions: async request => {
        const result = await this.brokerCallback(await this.connection(), "/api/connectors/self/sessions", request, SESSIONS_LIMIT);
        z.union([z.looseObject({ sessions: z.array(z.looseObject({ id: z.string() })), models: z.array(z.unknown()) }),
          z.looseObject({ session: z.looseObject({ id: z.string() }) }), z.looseObject({ message: z.looseObject({ id: z.string() }) }),
          z.object({ stopped: z.number().int().nonnegative() }).strict(), z.object({ archived: z.string() }).strict(),
          z.object({ consent: z.literal("audience"), target: z.string().max(8192), reason: z.string().max(1024) }).strict()]).parse(result);
        return result as SessionsToolResult;
      },
      pushCredential: async request => {
        const payload = {
          sessionId: request.sessionId, approvalId: request.approvalId, actorId: request.actorId, operation: request.operation,
          ...(request.capability !== undefined ? { capability: request.capability } : {}),
          ...(request.admissionId !== undefined ? { admissionId: request.admissionId } : {}),
        };
        const issued = {
          credentialId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/), remote: z.string().max(2048).regex(/^https:\/\/[^/@\s]+\/\S*$/), expiresAt: z.string().datetime(),
        };
        return z.union([
          z.object({ ...issued, authorization: z.string().regex(/^(Basic|Bearer) [A-Za-z0-9+/=._~-]{1,8000}$/) }).strict(),
          z.object({ ...issued, hostCredentials: z.literal(true) }).strict(),
        ]).parse(await this.brokerCallback(await this.connection(), "/api/connectors/self/git/push/credential", payload));
      },
      hostConfig: () => hostConfig.current(),
      requiredExtensions: () => hostConfig.required(),
      hostGitCredential: async (remote: string, signal?: AbortSignal) => {
        if (!(await hostConfig.current()).gitCredentials) throw new HostCredentialError("This host's owner hasn't turned on its Git credentials in Pikibun (Settings → Hosts → the host → Configuration)");
        return hostGitAuthorization(remote, { signal });
      },
      pushComplete: async request => {
        const payload = {
          sessionId: request.sessionId, approvalId: request.approvalId, credentialId: request.credentialId, outcome: request.outcome,
          ...(request.tip !== undefined ? { tip: request.tip } : {}),
        };
        return z.object({
          pullRequest: z.object({
            url: z.string().max(2048).regex(/^https:\/\/\S+$/), number: z.number().int().positive(), created: z.boolean(), draft: z.boolean().optional(),
          }).strict().optional(),
        }).strict().parse(await this.brokerCallback(await this.connection(), "/api/connectors/self/git/push/complete", payload));
      },
      egressGrant: async sessionId => parseEgressGrant(await this.brokerCallback(await this.connection(), "/api/connectors/self/network", { sessionId })),
      gitDirect: async (sessionId, request) => this.brokerCallback(await this.connection(), "/api/connectors/self/git/direct", { sessionId, ...request }),
      apiCredential: async (sessionId, host, access) => this.brokerCallback(await this.connection(), "/api/connectors/self/api/credential",
        { sessionId, host, ...(access === "write" ? { access } : {}) }),
      gitRelay: async (sessionId, request) => {
        const generation = await this.connection();
        this.requireGeneration(generation);
        const push = request.service === "receive-pack";
        const response = await relayGitRequest(this.options.fetch ?? fetch, `${state.controlPlaneUrl}${relayPath("/api/connectors/self", sessionId, request)}`,
          { authorization: `Bearer ${state.token}`, "x-connection-token": generation.connectionToken! }, request,
          AbortSignal.any([...(push ? [] : [generation.abort.signal]), this.lifetime.signal, AbortSignal.timeout(60 * 60 * 1000)]));
        if (push) return response;
        try { this.requireGeneration(generation); }
        catch (error) { await response.body?.cancel(); throw error; }
        return response;
      },
      readBackup: async (restore, target) => this.readBackup(await this.connection(), restore, target),
      ...(repositoryCache ? { repositoryCache } : {}),
    };
  }

  private repositoryCacheFor(scope: Exclude<RepositoryCacheMode, "off">): RepositoryCache {
    let cache = this.repositoryCaches.get(scope);
    if (!cache) this.repositoryCaches.set(scope, cache = new RepositoryCache({ root: join(this.directory, "repo-cache"), scope }));
    return cache;
  }

  private requireGeneration(generation: Generation): void {
    if (this.lifetime.signal.aborted || generation.abort.signal.aborted || this.generation !== generation || !generation.connectionToken) throw new Error("Connector generation is no longer authorized");
  }

  private async callbackResponse(generation: Generation, path: string, body: unknown, signal = AbortSignal.any([generation.abort.signal, this.lifetime.signal, AbortSignal.timeout(15_000)])): Promise<Response> {
    this.requireGeneration(generation);
    const version = this.options.version ?? buildVersion ?? DEVELOPMENT_CONNECTOR_VERSION;
    const response = await (this.options.fetch ?? fetch)(`${this.state!.controlPlaneUrl}${path}`, {
      method: "POST", redirect: "error", credentials: "omit",
      headers: { authorization: `Bearer ${this.state!.token}`, "x-connection-token": generation.connectionToken!, "content-type": "application/json",
        ...(version ? { [CONNECTOR_VERSION_HEADER]: version } : {}) },
      body: JSON.stringify(body), signal,
    });
    try {
      this.requireGeneration(generation);
      signal.throwIfAborted();
      if (!response.ok) throw new CallbackRefused(response.status);
    } catch (error) {
      await response.body?.cancel();
      throw error;
    }
    return response;
  }

  private async callback(generation: Generation, path: string, body: unknown, limit = CALLBACK_LIMIT): Promise<unknown> {
    const response = await this.callbackResponse(generation, path, body);
    const bytes = await boundedBody(response, limit, AbortSignal.any([generation.abort.signal, AbortSignal.timeout(15_000)]));
    this.requireGeneration(generation);
    return bytes.length ? decodeJson(bytes) : undefined;
  }

  private async brokerCallback(generation: Generation, path: string, body: unknown, limit = CALLBACK_LIMIT): Promise<unknown> {
    this.requireGeneration(generation);
    const signal = AbortSignal.any([generation.abort.signal, this.lifetime.signal, AbortSignal.timeout(RPC_TIMEOUT)]);
    const response = await (this.options.fetch ?? fetch)(`${this.state!.controlPlaneUrl}${path}`, {
      method: "POST", redirect: "error", credentials: "omit",
      headers: { authorization: `Bearer ${this.state!.token}`, "x-connection-token": generation.connectionToken!, "content-type": "application/json" },
      body: JSON.stringify(body), signal,
    });
    const bytes = await boundedBody(response, limit, signal);
    this.requireGeneration(generation);
    const value = bytes.length ? decodeJson(bytes) : undefined;
    if (!response.ok) {
      const error = value && typeof value === "object" && "error" in value ? value.error : undefined;
      throw new RunnerError(response.status, typeof error === "string" && /^[\x20-\x7e\u00a0-\uffff]{1,500}$/.test(error) ? error : "Scoped connector callback denied or unavailable");
    }
    return value;
  }

  private async authorize(generation: Generation, request: AuthorizationRequest): Promise<AuthorizationResult> {
    const payload = { sessionId: request.sessionId, actorId: request.actorId, ownerId: request.ownerId, permission: request.permission, ...(request.host ? { host: true } : {}),
      ...(request.host && request.hostSessions ? { hostSessions: true } : {}), ...(request.archived ? { archived: true } : {}),
      ...(request.autoApprove ? { autoApprove: true } : {}), ...(request.memberAutoApprove ? { memberAutoApprove: true } : {}) };
    const result = z.object({
      allowed: z.boolean(), ownerId: actorSchema, policyVersion: z.number().int().positive(), hostCommands: z.enum(["approve", "auto"]).optional(),
      hostSessions: z.literal(true).optional(), autoApprove: z.literal(true).optional(), memberAutoApprove: z.literal(true).optional(),
    }).strict().parse(await this.callback(generation, "/api/connectors/self/authorize", payload));
    if (result.ownerId !== request.ownerId) throw new Error("Invalid authorization response");
    return result;
  }

  private async reportActivity(generation: Generation, sessionId: string, activity: SessionActivity): Promise<void> {
    if (!IDENTIFIER.test(sessionId) || !sessionActivities.includes(activity)) throw new Error("Invalid activity report");
    this.requireGeneration(generation);
    const signal = AbortSignal.any([generation.abort.signal, this.lifetime.signal, AbortSignal.timeout(15_000)]);
    const response = await (this.options.fetch ?? fetch)(`${this.state!.controlPlaneUrl}/api/connectors/self/activity`, {
      method: "POST", redirect: "error", credentials: "omit",
      headers: { authorization: `Bearer ${this.state!.token}`, "x-connection-token": generation.connectionToken!, "content-type": "application/json" },
      body: JSON.stringify({ sessionId, activity }), signal,
    });
    await response.body?.cancel();
    this.requireGeneration(generation);
    if (!response.ok && (response.status >= 500 || response.status === 408 || response.status === 429)) throw new Error("Activity report unavailable");
  }

  private async reportTunnel(generation: Generation, report: SessionTunnelReport): Promise<void> {
    if (!IDENTIFIER.test(report.sessionId)) throw new Error("Invalid tunnel report");
    this.requireGeneration(generation);
    const signal = AbortSignal.any([generation.abort.signal, this.lifetime.signal, AbortSignal.timeout(15_000)]);
    const response = await (this.options.fetch ?? fetch)(`${this.state!.controlPlaneUrl}/api/connectors/self/tunnel`, {
      method: "POST", redirect: "error", credentials: "omit",
      headers: { authorization: `Bearer ${this.state!.token}`, "x-connection-token": generation.connectionToken!, "content-type": "application/json" },
      body: JSON.stringify(report), signal,
    });
    await response.body?.cancel();
    if (!response.ok && (response.status >= 500 || response.status === 408 || response.status === 429)) throw new Error("Tunnel report unavailable");
  }

  private async reportBranches(generation: Generation, sessionId: string, branches: SessionBranch[]): Promise<void> {
    if (!IDENTIFIER.test(sessionId) || branches.length > MAX_CLONE_BRANCHES) throw new Error("Invalid branch report");
    this.requireGeneration(generation);
    const signal = AbortSignal.any([generation.abort.signal, this.lifetime.signal, AbortSignal.timeout(15_000)]);
    const response = await (this.options.fetch ?? fetch)(`${this.state!.controlPlaneUrl}/api/connectors/self/branches`, {
      method: "POST", redirect: "error", credentials: "omit",
      headers: { authorization: `Bearer ${this.state!.token}`, "x-connection-token": generation.connectionToken!, "content-type": "application/json" },
      body: JSON.stringify({ sessionId, branches: branches.map(({ repository, branch }) => ({ repository, branch })) }), signal,
    });
    await response.body?.cancel();
    this.requireGeneration(generation);
    if (!response.ok && (response.status >= 500 || response.status === 408 || response.status === 429)) throw new Error("Branch report unavailable");
  }

  private async readBackup(generation: Generation, restore: RestoreDescriptor, targetSessionId: string): Promise<Uint8Array> {
    const ids = [restore.id, restore.sourceSessionId, restore.backupId, targetSessionId];
    if (ids.some(id => typeof id !== "string" || !IDENTIFIER.test(id))
      || typeof restore.downloadToken !== "string" || !TOKEN.test(restore.downloadToken)
      || typeof restore.sha256 !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(restore.sha256)
      || !Number.isSafeInteger(restore.size) || restore.size < 1 || restore.size > connectorLimits.responseBytes) throw new Error("Invalid restore descriptor");
    const response = await this.callbackResponse(generation, `/api/connectors/self/restores/${restore.id}/download`, {
      targetSessionId, sourceSessionId: restore.sourceSessionId, backupId: restore.backupId, downloadToken: restore.downloadToken,
    });
    const bytes = await boundedBody(response, restore.size, AbortSignal.any([generation.abort.signal, AbortSignal.timeout(15_000)]));
    this.requireGeneration(generation);
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    if (bytes.length !== restore.size || response.headers.get("x-backup-sha256") !== restore.sha256 || await sha256(text) !== restore.sha256) throw new Error("Backup integrity mismatch");
    return bytes;
  }

  private dispatch(generation: Generation, value: unknown, frameSize: number): void {
    if (generation.active.size >= connectorLimits.pendingRequests) return this.disconnect(generation, "Relay exceeded the pending request limit");
    if (generation.incomingBytes + frameSize > connectorLimits.bufferedBytes) return this.disconnect(generation, "Relay exceeded the queued request byte limit");
    const parsed = requestSchema.safeParse(value);
    if (!parsed.success) return this.disconnect(generation, "Invalid relay request");
    const rpc = parsed.data;
    const now = Date.now();
    for (const [key, expiry] of this.seen) if (expiry <= now) this.seen.delete(key);
    const keys = [`request:${rpc.id}`, `ticket:${rpc.ticket.jti}`];
    if (keys.some(key => this.seen.has(key)) || this.seen.size > 8192) return this.disconnect(generation, "Replayed relay request");
    const replayExpiry = Math.min((rpc.ticket.exp + 5) * 1000, now + 70_000);
    for (const key of keys) this.seen.set(key, replayExpiry);
    generation.incomingBytes += frameSize;
    const previous = generation.tail;
    const task = this.execute(generation, rpc, previous).catch((error: unknown) => {
      const message = error instanceof Error && /^[A-Za-z][A-Za-z ]{0,119}$/.test(error.message) ? error.message : "";
      this.disconnect(generation, message ? `Relay request failed: ${message}` : "Relay request failed");
    }).finally(() => {
      generation.active.delete(task);
      generation.incomingBytes -= frameSize;
    });
    generation.tail = Promise.all([previous, task]).then(() => {});
    generation.active.add(task);
  }

  private async execute(generation: Generation, value: ConnectorRpcRequest, previous: Promise<void>): Promise<void> {
    const { rpc, authorization } = await validateRelayRequest(value, this.state!.connectorId, this.secret);
    this.requireGeneration(generation);
    if (this.restarting) return this.send(generation, this.restartingFrame(rpc));
    const interrupt = Promise.withResolvers<"restarting">();
    generation.waiting.add(interrupt);
    let woke: "ready" | "restarting";
    try {
      woke = await Promise.race([Promise.all([previous, generation.runtimeReady.promise]).then(() => "ready" as const), interrupt.promise]);
    } finally {
      generation.waiting.delete(interrupt);
    }
    this.requireGeneration(generation);
    if (woke === "restarting") return this.send(generation, this.restartingFrame(rpc));
    await this.send(generation, await this.answer(generation, rpc, authorization));
  }

  private async send(generation: Generation, { payload, payloadSize }: { payload: string; payloadSize: number }): Promise<void> {
    const drained = Date.now() + DRAIN_TIMEOUT;
    while (generation.socket.bufferedAmount + payloadSize > connectorLimits.bufferedBytes) {
      if (Date.now() >= drained) return this.disconnect(generation, "Socket output did not drain within 30s");
      await delay(10, undefined, { signal: generation.abort.signal });
      this.requireGeneration(generation);
    }
    generation.socket.send(payload);
  }

  private async answer(generation: Generation, rpc: ConnectorRpcRequest, authorization: string): Promise<{ payload: string; payloadSize: number }> {
    if (rpc.ticket.exp * 1000 <= Date.now()) return this.errorFrame(rpc, 504, "The request waited too long on the host; inspect the session before retrying.");
    const work = this.reply(generation, rpc, authorization);
    const executing = work.then(() => {}, () => {});
    this.executing.add(executing);
    void executing.finally(() => this.executing.delete(executing));
    let timer: NodeJS.Timeout | undefined;
    const expired = new Promise<{ payload: string; payloadSize: number }>(resolve => {
      timer = setTimeout(() => resolve(this.errorFrame(rpc, 504, "The host did not answer in time; inspect the session before retrying.")), connectorRequestTimeoutMs(rpc.ticket.action));
    });
    try { return await Promise.race([work, expired]); }
    finally { clearTimeout(timer); }
  }

  private restartingFrame(rpc: ConnectorRpcRequest): { payload: string; payloadSize: number } {
    return this.errorFrame(rpc, 503, "The host's runner is restarting; try again shortly.");
  }

  private errorFrame(rpc: ConnectorRpcRequest, status: number, error: string): { payload: string; payloadSize: number } {
    const payload = JSON.stringify({
      type: "response", id: rpc.id, status, body: JSON.stringify({ error, code: "connector_reply_error" }),
    } satisfies ConnectorRpcResponse);
    return { payload, payloadSize: Buffer.byteLength(payload, "utf8") };
  }

  private async reply(generation: Generation, rpc: ConnectorRpcRequest, authorization: string): Promise<{ payload: string; payloadSize: number }> {
    const frame = (payload: string) => ({ payload, payloadSize: Buffer.byteLength(payload, "utf8") });
    const failed = (status: number, error: string) => this.errorFrame(rpc, status, error);
    const runtime = this.runtime;
    if (!runtime) return failed(503, "The host's runner is restarting; try again.");
    let result: ConnectorRpcResponse;
    try {
      const response = await runtime.value.fetch(new Request(`http://local.invalid${rpc.path}`, {
        method: rpc.method, headers: { authorization: `Bearer ${authorization}`, "content-type": "application/json" },
        ...(rpc.method === "POST" ? { body: rpc.body } : {}), signal: generation.abort.signal,
      }));
      let bytes: Uint8Array;
      try { bytes = await boundedBody(response, connectorLimits.responseBytes, generation.abort.signal); }
      catch (error) {
        this.requireGeneration(generation);
        if (error instanceof Error && error.message === "Response exceeds connector limit") return failed(502, "The host's reply is too large to relay.");
        throw error;
      }
      result = { type: "response", id: rpc.id, status: response.status, body: new TextDecoder("utf-8", { fatal: true }).decode(bytes) };
    } catch {
      this.requireGeneration(generation);
      return failed(502, "The host could not complete the request.");
    }
    this.requireGeneration(generation);
    const reply = frame(JSON.stringify(result));
    if (reply.payloadSize > connectorLimits.frameBytes) return failed(502, "The host's reply is too large to relay.");
    return reply;
  }

  async direct(input: { grant: string; body: string }): Promise<{ status: number; body: string }> {
    const refused = (status: number, error: string) => ({ status, body: JSON.stringify({ error, code: "connector_reply_error" }) });
    const generation = this.welcomed;
    if (!this.state || !generation || generation.abort.signal.aborted || !generation.connectionToken) return refused(503, "The host is not connected.");
    if (typeof input?.grant !== "string" || input.grant.length > 16_384 || typeof input.body !== "string"
      || encoder.encode(input.body).length > connectorLimits.requestBytes) return refused(400, "Invalid upload request.");
    let verified: { ticket: ConnectorRpcRequest["ticket"]; size: number; path: string };
    try {
      const value = await this.callback(generation, "/api/connectors/self/uploads/verify", { grant: input.grant }) as Record<string, unknown> | undefined;
      const ticket = ticketSchema.parse(value?.ticket);
      if (ticket.action !== "upload" || ticket.connectorId !== this.state.connectorId || !Number.isSafeInteger(value?.size)
        || value?.path !== `/v1/sessions/${ticket.sessionId}/upload`) throw new Error("Invalid upload grant");
      verified = { ticket, size: value.size as number, path: value.path };
    } catch { return refused(403, "The control plane refused the upload grant."); }
    let declared: unknown;
    try { declared = (JSON.parse(input.body) as { size?: unknown } | null)?.size; } catch { declared = undefined; }
    if (declared !== verified.size) return refused(400, "The upload doesn't match its grant.");
    const rpc: ConnectorRpcRequest = { type: "request", id: verified.ticket.jti, method: "POST", path: verified.path, body: input.body, ticket: verified.ticket };
    const now = Date.now();
    for (const [key, expiry] of this.seen) if (expiry <= now) this.seen.delete(key);
    const keys = [`request:${rpc.id}`, `ticket:${rpc.ticket.jti}`];
    if (keys.some(key => this.seen.has(key))) return refused(409, "That upload grant was already used.");
    for (const key of keys) this.seen.set(key, Math.min((rpc.ticket.exp + 5) * 1000, now + 70_000));
    let authorization: string;
    try { ({ authorization } = await validateRelayRequest(rpc, this.state.connectorId, this.secret)); }
    catch { return refused(400, "Invalid upload request."); }
    if (this.restarting) return refused(503, "The host's runner is restarting; try again shortly.");
    try {
      await generation.runtimeReady.promise;
      const { payload } = await this.answer(generation, rpc, authorization);
      const reply = JSON.parse(payload) as ConnectorRpcResponse;
      return { status: reply.status, body: reply.body };
    } catch { return refused(503, "The host lost its connection; inspect the session before retrying."); }
  }

  stop(): Promise<void> {
    this.stopping ??= this.shutdown();
    return this.stopping;
  }

  private async shutdown(): Promise<void> {
    this.lifetime.abort();
    this.disconnect(this.generation);
    this.readiness.reject(new Error("Connector stopped before becoming ready"));
    try {
      await this.starting?.catch(() => {});
      await this.loop;
      await this.retireRuntime().catch(() => {});
      await this.tunnels?.close().catch(() => {});
      this.tunnel?.close();
    } finally { await this.releaseLease?.(); this.releaseLease = undefined; this.options.onStatus?.("stopped"); }
  }
}

export const relaySocketOptions = {
  maxPayload: connectorLimits.frameBytes,
  perMessageDeflate: { threshold: 1024, clientNoContextTakeover: true, serverNoContextTakeover: true },
};

function defaultSocket(url: string, protocols: string[]): ConnectorSocket {
  return new CompressingSocket(url, protocols, relaySocketOptions) as unknown as ConnectorSocket;
}

async function defaultRuntime(config: RunnerConfig): Promise<ConnectorRuntime> {
  const service = new RunnerService(config);
  await service.initialize();
  const app = createRunnerApp(service);
  return { fetch: request => app.fetch(request), close: () => service.close(), resume: () => service.resume() };
}

export function createConnector(options: ConnectorOptions): LocalConnector { return new LocalConnector(options); }
