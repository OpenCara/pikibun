import { randomBytes, randomUUID } from "node:crypto";
import { Buffer } from "node:buffer";
import { mkdir, realpath, lstat, open, link, rename, unlink } from "node:fs/promises";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { WebSocket as CompressingSocket } from "ws";
import { z } from "zod";
import type { ConnectorCapabilities, ConnectorCredentials, LocalModelSummary } from "../../../packages/shared/src/connector.js";
import { connectorLimits } from "../../../packages/shared/src/connector.js";
import { acquireRunnerLease } from "./lease.js";
import type { SandboxBackendConfig } from "./sandbox-backend.js";
import { CREATE_FILE, exactMode, OPEN_DIRECTORY, OPEN_FILE, windows } from "./platform.js";
import type { LocalModels } from "./local-pi.js";
import { modelSummary } from "./local-pi.js";
import { assertId, ConnectorSetupError } from "./protocol.js";
import { withHostToolCapabilities } from "./host-capabilities.js";
import { detectGpu, HostConfigSource } from "./host-config.js";
import type { GpuKind, RepositoryCacheMode } from "../../../packages/shared/src/host-config.js";
import { recoverResourceOrphans } from "./resources.js";
import { RepositoryCache } from "./repo-cache.js";
import { RunnerService, createRunnerApp } from "./server.js";
import { ControlPlaneCalls } from "./connector/control-plane.js";
import type { ConnectorSocket, Generation } from "./connector/generation.js";
import { connectorRunnerConfig } from "./connector/runner-config.js";
import { RelayFrames } from "./connector/frames.js";
import { validateRelayRequest } from "./connector/relay-request.js";
import { boundedBody, CALLBACK_LIMIT, decodeJson, encoder, IDENTIFIER, refusedReport, TOKEN } from "./connector/wire.js";
import type { RunnerConfig } from "./session.js";
import { HostExtensions } from "./extensions/host.js";
import { ExtensionStore } from "./extensions/store.js";
import { parseExtensionsSyncAnswer, type ExtensionRequestResult } from "../../../packages/shared/src/host-extensions.js";
import { browserDownloads, HostBrowserSource, type HostBrowserOptions } from "./browser-host.js";
import { cloudflaredDownloads, HostTunnels, HostTunnelSource, type HostTunnelOptions } from "./tunnel-host.js";
import type { LocalPage, LocalView } from "../../../packages/shared/src/app-host-protocol.js";

const STATE_FILE = "connector.json";
const EXTENSION_SYNC_MS = 30_000;
const HOST_CONFIG_LIMIT = 128 * 1024;
const RECONNECT_WAIT = 15_000;
const credentialsSchema = z.object({
  connectorId: z.string().regex(IDENTIFIER), token: z.string().regex(TOKEN), controlPlaneUrl: z.string(),
}).strict();
const welcomeSchema = z.object({
  type: z.literal("welcome"), connectorId: z.string().regex(IDENTIFIER), connectionToken: z.string().regex(TOKEN),
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
    sessionPacking: true, packIgnoredFiles: true, ...(mode.gpu ? { gpu: mode.gpu } : {}) };
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

export { validateRelayRequest };

export type { ConnectorSocket };

export interface ConnectorRuntime {
  fetch(request: Request): Response | Promise<Response>;
  close(): Promise<void>;
  resume?(): Promise<void>;
  view?(sessionId: string, options: { since?: string; brief?: boolean }): Promise<LocalView>;
  entries?(sessionId: string, options: { conversation: string; before: string; limit: number; brief?: boolean }): Promise<LocalPage | null>;
}

export class LocalViewUnavailable extends Error {
  constructor() { super("The host isn't serving sessions yet"); }
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

export class LocalConnector {
  readonly ready: Promise<void>;
  private readonly readiness = Promise.withResolvers<void>();
  private readonly lifetime = new AbortController();
  private readonly secret = Buffer.from(randomBytes(48)).toString("base64url");
  private generation?: Generation;
  private welcomed?: Generation;
  private online = Promise.withResolvers<Generation>();
  private runtime?: Runtime;
  private restarting = false;
  private readonly frames: RelayFrames;
  private readonly calls: ControlPlaneCalls;
  private readonly hostConfig = new HostConfigSource(async () => (await this.calls.callback(await this.connection(), "/api/connectors/self/config", {}, HOST_CONFIG_LIMIT) as { config?: unknown } | undefined)?.config);
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

  constructor(private readonly options: ConnectorOptions) {
    this.ready = this.readiness.promise;
    this.calls = new ControlPlaneCalls({ credentials: () => this.state!, settings: options, lifetime: this.lifetime.signal,
      requireGeneration: generation => this.requireGeneration(generation), connection: () => this.connection() });
    this.frames = new RelayFrames({ secret: this.secret, state: () => this.state, restarting: () => this.restarting, runtime: () => this.runtime?.value,
      welcomed: () => this.welcomed, calls: this.calls, disconnect: (generation, reason) => this.disconnect(generation, reason),
      requireGeneration: generation => this.requireGeneration(generation) });
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
      this.frames.dispatch(generation, value, encoder.encode(data).length);
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
      await this.calls.callback(generation, "/api/connectors/self/manifest", { models: await connectorManifest(this.options.localModels, this.options.allowFaux),
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
        const sync = async () => parseExtensionsSyncAnswer(await this.calls.callback(generation, "/api/connectors/self/extensions", { report: report(), results }));
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
    await this.frames.settled();
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

  private runnerConfig(repositoryCache: RepositoryCache | undefined): RunnerConfig {
    return connectorRunnerConfig({
      credentials: this.state!, directory: this.directory, secret: this.secret, options: this.options, lifetime: this.lifetime.signal,
      hostConfig: this.hostConfig, hostExtensions: this.hostExtensions, browser: () => this.browser, tunnel: () => this.tunnel, tunnels: () => this.tunnels,
      calls: this.calls, connection: () => this.connection(), requireGeneration: generation => this.requireGeneration(generation),
    }, repositoryCache);
  }

  private repositoryCacheFor(scope: Exclude<RepositoryCacheMode, "off">): RepositoryCache {
    let cache = this.repositoryCaches.get(scope);
    if (!cache) this.repositoryCaches.set(scope, cache = new RepositoryCache({ root: join(this.directory, "repo-cache"), scope }));
    return cache;
  }

  private requireGeneration(generation: Generation): void {
    if (this.lifetime.signal.aborted || generation.abort.signal.aborted || this.generation !== generation || !generation.connectionToken) throw new Error("Connector generation is no longer authorized");
  }

  direct(input: { grant: string; body: string }): Promise<{ status: number; body: string }> {
    return this.frames.direct(input);
  }

  async localView(sessionId: string, options: { since?: string; brief?: boolean }): Promise<LocalView> {
    const runtime = this.localRuntime();
    return runtime.view!(assertId(sessionId), options);
  }

  async localEntries(sessionId: string, options: { conversation: string; before: string; limit: number; brief?: boolean }): Promise<LocalPage | null> {
    const runtime = this.localRuntime();
    return runtime.entries!(assertId(sessionId), options);
  }

  private localRuntime(): ConnectorRuntime {
    const runtime = this.runtime?.value;
    if (this.lifetime.signal.aborted || this.restarting || !runtime?.view || !runtime.entries) throw new LocalViewUnavailable();
    return runtime;
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
  return {
    fetch: request => app.fetch(request), close: () => service.close(), resume: () => service.resume(),
    view: (sessionId, options) => service.localView(sessionId, options),
    entries: (sessionId, options) => service.localEntries(sessionId, options),
  };
}

export function createConnector(options: ConnectorOptions): LocalConnector { return new LocalConnector(options); }
