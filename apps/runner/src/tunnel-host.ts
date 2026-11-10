import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, readdirSync, readFileSync, readlinkSync, rmSync, writeFileSync } from "node:fs";
import { createServer, connect, type Server, type Socket } from "node:net";
import { join } from "node:path";
import { hostTunnelStatusLimits, quickTunnelUrl, type HostTunnelConfig, type HostTunnelStatus } from "../../../packages/shared/src/tunnel.js";
import { cloudflaredAsset, downloadCloudflared, downloadedCloudflareds, hostCloudflared, inspectCloudflared, pinnedCloudflared, pruneCloudflareds,
  type CloudflaredRelease, type CloudflaredToolchain } from "./cloudflared.js";

const RETRY_MS = 10 * 60_000;
const UPDATE_MS = 24 * 3600_000;

export interface HostTunnelOptions {
  root: string;
  supported: boolean;
  fetch?: typeof fetch;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  arch?: string;
  now?: () => number;
  signal?: AbortSignal;
  detect?: () => CloudflaredToolchain | undefined;
  release?: (asset: string) => CloudflaredRelease;
}

export class HostTunnelSource {
  #config: HostTunnelConfig = { source: "auto" };
  #current: CloudflaredToolchain | undefined;
  #status: HostTunnelStatus;
  #download: Promise<void> | undefined;
  #task: Promise<void> | undefined;
  #failure: { error: string; at: number } | undefined;
  #checked = -Infinity;
  readonly #abort = new AbortController();

  constructor(readonly options: HostTunnelOptions) {
    this.#status = { source: "auto", state: options.supported ? "missing" : "unsupported", downloadable: this.downloadable };
  }

  get downloadable(): boolean { return this.options.supported && cloudflaredAsset(this.options.platform ?? process.platform, this.options.arch ?? process.arch) !== undefined; }

  current(): CloudflaredToolchain | undefined { return this.#current; }

  status(): HostTunnelStatus { return this.#status; }

  async apply(config: HostTunnelConfig): Promise<HostTunnelStatus> {
    if (config.source !== this.#config.source || config.path !== this.#config.path) this.#failure = undefined;
    this.#config = config;
    await this.evaluate();
    return this.#status;
  }

  close(): void { this.#abort.abort(); }

  private set(status: Omit<HostTunnelStatus, "source" | "downloadable">, cloudflared?: CloudflaredToolchain): void {
    this.#current = status.state === "ready" ? cloudflared : undefined;
    const clip = (text: string) => text.length > hostTunnelStatusLimits.text ? `${text.slice(0, hostTunnelStatusLimits.text - 1)}…` : text;
    const executable = cloudflared && status.state === "ready" && cloudflared.executable.length <= hostTunnelStatusLimits.executable ? cloudflared.executable : undefined;
    const version = status.version ?? (status.state === "ready" ? cloudflared?.version : undefined);
    this.#status = { source: this.#config.source, downloadable: this.downloadable, state: status.state,
      ...(executable ? { executable } : {}), ...(version ? { version: clip(version) } : {}), ...(status.error ? { error: clip(status.error) } : {}) };
  }

  private async evaluate(): Promise<void> {
    const config = this.#config;
    const platform = this.options.platform;
    if (!this.options.supported) return this.set({ state: "unsupported", error: "Sessions on this host have no Linux sandbox, which session services run in" });
    if (config.source === "off") return this.set({ state: "off" });
    if (config.source === "path") {
      const inspected = inspectCloudflared(config.path ?? "", platform ? { platform } : {});
      return "cloudflared" in inspected ? this.set({ state: "ready" }, inspected.cloudflared) : this.set({ state: "missing", error: inspected.error });
    }
    const downloads = await downloadedCloudflareds(this.options.root);
    if (config.source === "auto") {
      const found = (this.options.detect ? this.options.detect() : hostCloudflared({ env: this.options.env ?? process.env, ...(platform ? { platform } : {}) })) ?? downloads[0];
      return found ? this.set({ state: "ready" }, found)
        : this.set({ state: "missing", error: "No cloudflared found on this host: install Cloudflare's cloudflared package, give the path of one, or download one here" });
    }
    if (!this.downloadable) return this.set({ state: "missing", error: "Cloudflare builds a lone cloudflared for Linux on x86-64 and ARM64 only: install its package and find it on the host" });
    const now = (this.options.now ?? Date.now)();
    const newest = downloads.find(download => download.version === this.release().version) ?? downloads[0];
    if (newest) {
      this.set({ state: "ready" }, newest);
      if (!this.#download && now - this.#checked >= UPDATE_MS) this.startDownload(newest.version);
      return;
    }
    const retried = this.#failure ? { error: this.#failure.error } : {};
    if (this.#download) return this.set({ state: "downloading", ...retried });
    if (this.#failure && now - this.#failure.at < RETRY_MS) return this.set({ state: "failed", error: this.#failure.error });
    this.startDownload();
    this.set({ state: "downloading", ...retried });
  }

  private startDownload(have?: string): void {
    const now = this.options.now ?? Date.now;
    this.#checked = now();
    const signal = this.options.signal ? AbortSignal.any([this.#abort.signal, this.options.signal]) : this.#abort.signal;
    const options = { ...(this.options.fetch ? { fetch: this.options.fetch } : {}), signal };
    const task = (async () => {
      try {
        const release = this.release();
        await pruneCloudflareds(this.options.root, have ? [have, release.version] : [release.version]);
        if (release.version !== have) await downloadCloudflared(this.options.root, release, options);
        this.#failure = undefined;
      } catch (error) {
        if (!have) this.#failure = { error: (error instanceof Error ? error.message : String(error)).slice(0, 500), at: now() };
      } finally {
        this.#download = undefined;
      }
      if (this.#config.source === "download") await this.evaluate().catch(() => {});
    })();
    this.#download = task;
    this.#task = task;
  }

  private release(): CloudflaredRelease {
    const asset = cloudflaredAsset(this.options.platform ?? process.platform, this.options.arch ?? process.arch)!;
    return (this.options.release ?? pinnedCloudflared)(asset);
  }

  settled(): Promise<void> { return this.#task ?? Promise.resolve(); }
}

export function cloudflaredDownloads(directory: string): string { return join(directory, "cloudflared"); }

export interface QuickTunnel {
  readonly url: string;
  connected(): boolean;
  readonly closed: Promise<void>;
  close(): Promise<void>;
}

export interface HostTunnelsOptions {
  cloudflared: () => CloudflaredToolchain | undefined;
  directory: string;
  addressMs?: number;
  connectMs?: number;
  log?: (line: string) => void;
}

export const NO_ADDRESS = "cloudflared couldn't get an address from Cloudflare. The host needs to reach Cloudflare's edge on port 7844 (UDP or TCP) and api.trycloudflare.com on 443; its owner finds cloudflared's errors in the connector's log";

export class HostTunnels {
  readonly #open = new Set<QuickTunnel>();
  readonly #config: string;
  readonly #home: string;
  readonly #processes: string;

  constructor(readonly options: HostTunnelsOptions) {
    mkdirSync(options.directory, { recursive: true, mode: 0o700 });
    this.#config = join(options.directory, "config.yml");
    this.#home = join(options.directory, "home");
    this.#processes = join(options.directory, "processes");
    mkdirSync(this.#home, { recursive: true, mode: 0o700 });
    mkdirSync(this.#processes, { recursive: true, mode: 0o700 });
    writeFileSync(this.#config, "{}\n", { mode: 0o600 });
    this.reap();
  }

  get available(): boolean { return this.options.cloudflared() !== undefined; }

  private reap(): void {
    for (const name of readdirSync(this.#processes)) {
      const path = join(this.#processes, name);
      const pid = Number(/^(\d{1,10})$/.exec(name)?.[1]);
      try {
        const executable = readFileSync(path, "utf8");
        if (pid > 1 && process.platform === "linux" && readlinkSync(`/proc/${pid}/exe`) === executable) process.kill(pid, "SIGKILL");
      } catch { }
      rmSync(path, { force: true });
    }
  }

  async open(socket: string, signal?: AbortSignal): Promise<QuickTunnel> {
    const cloudflared = this.options.cloudflared();
    if (!cloudflared) throw new Error("This host has no cloudflared for the tunnel");
    const connections = new Set<Socket>();
    const forward: Server = createServer({ allowHalfOpen: true }, client => {
      const upstream = connect({ path: socket, allowHalfOpen: true });
      connections.add(client);
      connections.add(upstream);
      const end = () => { client.destroy(); upstream.destroy(); connections.delete(client); connections.delete(upstream); };
      client.on("error", end).on("close", end);
      upstream.on("error", end).on("close", end);
      client.pipe(upstream);
      upstream.pipe(client);
    });
    await new Promise<void>((resolve, reject) => { forward.once("error", reject); forward.listen(0, "127.0.0.1", () => { forward.off("error", reject); resolve(); }); });
    forward.on("error", error => this.options.log?.(`ERR forwarding: ${error instanceof Error ? error.message : String(error)}`));
    const port = (forward.address() as { port: number }).port;
    const closeForward = () => new Promise<void>(resolve => {
      for (const connection of connections) connection.destroy();
      forward.close(() => resolve());
    });
    const env: NodeJS.ProcessEnv = { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: this.#home, LANG: "C.UTF-8",
      ...Object.fromEntries(["SSL_CERT_FILE", "SSL_CERT_DIR", "SYSTEMROOT"].flatMap(name => process.env[name] ? [[name, process.env[name]]] : [])) };
    let child: ChildProcess;
    try {
      child = spawn(cloudflared.executable, ["tunnel", "--no-autoupdate", "--config", this.#config, "--url", `http://127.0.0.1:${port}`],
        { cwd: this.#home, env, stdio: ["ignore", "pipe", "pipe"] });
    } catch (error) {
      await closeForward();
      throw error;
    }
    const record = child.pid ? join(this.#processes, String(child.pid)) : undefined;
    if (record) { try { writeFileSync(record, cloudflared.executable, { mode: 0o600 }); } catch { } }
    const exited = new Promise<void>(resolve => {
      child.once("close", () => resolve());
      child.once("error", () => resolve());
    }).then(async () => {
      if (record) rmSync(record, { force: true });
      await closeForward();
    });
    let url: string | undefined;
    let connections_ = 0;
    const address = Promise.withResolvers<string>();
    const edge = Promise.withResolvers<void>();
    const read = (stream: NodeJS.ReadableStream | null) => {
      let partial = "";
      stream?.on("data", (chunk: Buffer) => {
        const lines = (partial + chunk.toString("utf8")).split("\n");
        partial = (lines.pop() ?? "").slice(-4096);
        for (const line of lines) {
          this.options.log?.(line);
          const found = url === undefined ? quickTunnelUrl(line) : undefined;
          if (found) { url = found; address.resolve(found); }
          if (/Registered tunnel connection/i.test(line)) { connections_++; edge.resolve(); }
          if (/Unregistered tunnel connection|Connection terminated/i.test(line)) connections_ = Math.max(0, connections_ - 1);
        }
      });
    };
    read(child.stdout);
    read(child.stderr);
    void exited.then(() => address.reject(new Error(NO_ADDRESS)));
    void address.promise.catch(() => {});
    const stop = async () => {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGTERM");
        const timer = setTimeout(() => child.kill("SIGKILL"), 5000);
        await exited;
        clearTimeout(timer);
      }
      await exited;
    };
    const abort = () => { void stop(); };
    signal?.addEventListener("abort", abort, { once: true });
    const timeout = setTimeout(() => address.reject(new Error(NO_ADDRESS)), this.options.addressMs ?? 60_000);
    try {
      await address.promise;
      if (signal?.aborted) throw new Error("The tunnel was stopped before it was online");
    } catch (error) {
      await stop();
      throw error;
    } finally {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", abort);
    }
    await Promise.race([edge.promise, exited, new Promise(resolve => setTimeout(resolve, this.options.connectMs ?? 15_000).unref())]);
    const tunnel: QuickTunnel = {
      url: url!, connected: () => connections_ > 0 && child.exitCode === null && child.signalCode === null,
      closed: exited, close: stop,
    };
    this.#open.add(tunnel);
    void exited.then(() => this.#open.delete(tunnel));
    return tunnel;
  }

  async close(): Promise<void> {
    await Promise.allSettled([...this.#open].map(tunnel => tunnel.close()));
  }
}
