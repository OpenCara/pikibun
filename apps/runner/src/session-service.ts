import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BrowserServe } from "../../../packages/shared/src/browser.js";
import { serviceLifetimeLimits, serviceOutputLimits } from "../../../packages/shared/src/tunnel.js";
import { nodePrograms } from "./node-command.js";
import { programShellCommand, shellQuote } from "./program-command.js";
import type { CommandLimits } from "./host-config.js";

/*
 * Session services (docs/design/tunnel.md): a process a session starts in its sandbox whose lifetime is the session's
 * rather than one tool call's. A sandboxed command's processes end with it, so a server can't outlive the call that
 * started it; a service is one sandboxed command of its own instead, outside the session's queue of operations, with
 * the session's files, network and limits, that runs until something stops it: its tool's `stop`, a newer start,
 * stopping the session's work, the session closing or being archived, or the host's service lifetime
 * (HostConfig.serviceLifetimeSeconds). One per session. It keeps its last lines of output for its tool's status.
 *
 * The tunnel tool (piki:tunnel) runs its server as one; the browser tool's `serve` could too, for a browser that lives
 * across calls.
 */

/** Where the Linux sandbox puts the service's driver (sandbox-python/service.py). */
export const SANDBOX_SERVICE_DRIVER = "/opt/pikibun/service/pikibun-service";
/** Where the Linux sandbox puts the directory the service's socket is in, shared with the connector. */
export const SANDBOX_SERVICE_SOCKETS = "/run/pikibun-service";
/** The service's socket in that directory, which the connector connects to. */
export const SERVICE_SOCKET = "http.sock";
/** How the driver's own notices start (service.py MARK): the program's lines never do. */
export const SERVICE_MARK = "\x1epikibun-service ";

let directory: string | undefined;
/**
 * The directory a session's service listens in, on the host: in one short private directory per process, as Unix socket
 * paths are limited to about 100 bytes (egressSocketPath). It is the session's own, made here, and the Linux sandbox
 * mounts it writable at SANDBOX_SERVICE_SOCKETS for the service alone.
 */
export function serviceSocketDirectory(sessionId: string, dataDir: string): string {
  directory ??= mkdtempSync(join(tmpdir().length < 40 ? tmpdir() : "/tmp", "pikibun-service-"));
  const path = join(directory, createHash("sha256").update(`${dataDir}\0${sessionId}`).digest("hex").slice(0, 24));
  mkdirSync(path, { recursive: true, mode: 0o700 });
  return path;
}

/**
 * What bounds a service that may run `seconds`, as commandLimits bounds a long command: the whole time, each process may
 * use every CPU, write files of up to 16 GiB and open 8192 files. The host's provisioned resources, where it has them,
 * bound the service as a whole, as they do each command.
 */
export function serviceLimits(seconds: number, cpus: number): CommandLimits {
  const bounded = Math.min(Math.max(Math.trunc(Number.isFinite(seconds) ? seconds : serviceLifetimeLimits.default), serviceLifetimeLimits.min), serviceLifetimeLimits.max);
  return { seconds: bounded, cpuSeconds: bounded * Math.max(1, Math.trunc(cpus)), fileBytes: 16 * 1024 * 1024 * 1024, openFiles: 8192 };
}

/**
 * The shell command that runs `serve` as a service: the driver, the socket it listens on, the connector's own Node.js
 * where the session's commands get it (as the node tool and the browser's serve do), and the program as JSON.
 */
export function serviceShellCommand(serve: BrowserServe, options: { nodeBin?: string | undefined } = {}): string {
  const node = options.nodeBin && (nodePrograms as readonly string[]).includes(serve.program) ? ["--node-bin", options.nodeBin] : [];
  return programShellCommand({ directory: ".", program: shellQuote(SANDBOX_SERVICE_DRIVER),
    args: ["--socket", `${SANDBOX_SERVICE_SOCKETS}/${SERVICE_SOCKET}`, ...node, JSON.stringify(serve)] });
}

/** How a service's sandboxed command ended. */
export interface ServiceExit { code: number | null; signal: NodeJS.Signals | null; failure?: string }

/** A service's sandboxed command as it runs (Sandbox.startService). */
export interface ServiceProcess {
  /** Settles once the command has ended, never rejects. */
  exited: Promise<ServiceExit>;
  /** Ends the command, and everything it started: its PID namespace and, with resource limits, its cgroup. */
  kill(): void;
}

/** Why a service stopped: its tool's reasons (TunnelStopReason), its program exiting, or failing to start. */
export type ServiceStopReason = string;

export interface ServiceStop {
  reason: ServiceStopReason;
  exit?: ServiceExit;
}

/**
 * One session service, from its start until it stops. `start` launches the sandboxed command, handing it the function
 * its output goes to; the service then waits for the driver to say its port answers (`ready`), keeps its output's last
 * lines, and stops at `lifetimeMs` whatever else. Its first stop's reason stands.
 */
export class SessionService {
  readonly startedAt: number;
  readonly expiresAt: number;
  readonly #lines: string[] = [];
  #partial = "";
  #process: ServiceProcess | undefined;
  #stop: ServiceStop | undefined;
  #ready = false;
  #settled = false;
  #readyError: string | undefined;
  readonly #readiness = Promise.withResolvers<void>();
  readonly #stopped = Promise.withResolvers<ServiceStop>();
  readonly #timer: NodeJS.Timeout;
  readonly #stopping = new AbortController();

  private constructor(lifetimeMs: number, now: number) {
    this.startedAt = now;
    this.expiresAt = now + lifetimeMs;
    this.#timer = setTimeout(() => { void this.stop("lifetime"); }, lifetimeMs);
    this.#timer.unref?.();
    // Handled here: a caller that never waits for readiness doesn't leave it unhandled.
    void this.#readiness.promise.catch(() => {});
  }

  /** Starts a service: `start` runs its command and gives back its process (Sandbox.startService). */
  static async start(options: { start: (onOutput: (chunk: Buffer) => void, signal: AbortSignal) => Promise<ServiceProcess>; lifetimeMs: number; now?: () => number }): Promise<SessionService> {
    const service = new SessionService(options.lifetimeMs, (options.now ?? Date.now)());
    let process: ServiceProcess;
    try {
      process = await options.start(chunk => service.output(chunk), service.#stopping.signal);
    } catch (error) {
      clearTimeout(service.#timer);
      service.#settle({ reason: "failed" });
      throw error;
    }
    service.#process = process;
    // Stopped while it started (its lifetime, a stop): it goes at once.
    if (service.#stop) process.kill();
    void process.exited.then(exit => {
      clearTimeout(service.#timer);
      service.flush();
      if (!service.#ready) service.#readiness.reject(new Error(service.#readyError ?? `The server stopped before its port answered${exit.failure ? ` (${exit.failure})` : ""}`));
      service.#settle({ reason: service.#stop?.reason ?? "exited", exit });
    });
    return service;
  }

  /** Settles once the driver says the port answers and it listens for the connector; rejects with why it didn't. */
  get ready(): Promise<void> { return this.#readiness.promise; }

  /** Settles once the service has stopped, and why. */
  get stopped(): Promise<ServiceStop> { return this.#stopped.promise; }

  /** Whether it still runs. */
  get running(): boolean { return !this.#settled; }

  /** The program's last lines of output, oldest first. */
  lines(): string[] {
    return this.#partial ? [...this.#lines, this.#partial].slice(-serviceOutputLimits.lines) : [...this.#lines];
  }

  /** Stops the service, unless it stopped already, for `reason`, and waits until it has. */
  async stop(reason: ServiceStopReason): Promise<ServiceStop> {
    this.#stop ??= { reason };
    clearTimeout(this.#timer);
    this.#stopping.abort();
    this.#process?.kill();
    return this.#stopped.promise;
  }

  #settle(stop: ServiceStop): void {
    if (this.#settled) return;
    this.#settled = true;
    this.#stopped.resolve(stop);
  }

  private output(chunk: Buffer): void {
    const text = this.#partial + chunk.toString("utf8");
    const lines = text.split("\n");
    this.#partial = (lines.pop() ?? "").slice(-serviceOutputLimits.bytes);
    for (const line of lines) this.line(line);
  }

  private flush(): void {
    if (this.#partial) this.line(this.#partial);
    this.#partial = "";
  }

  private line(raw: string): void {
    const line = raw.replace(/\r$/, "");
    if (line.startsWith(SERVICE_MARK)) {
      let notice: { kind?: unknown; message?: unknown } = {};
      try { notice = JSON.parse(line.slice(SERVICE_MARK.length)) as typeof notice; } catch { /* Not a notice of the driver's. */ }
      if (notice.kind === "ready" && !this.#ready) {
        this.#ready = true;
        this.#readiness.resolve();
      } else if (notice.kind === "error" && typeof notice.message === "string") this.#readyError = notice.message.slice(0, serviceOutputLimits.lineLength);
      return;
    }
    this.#lines.push(line.length > serviceOutputLimits.lineLength ? `${line.slice(0, serviceOutputLimits.lineLength - 1)}…` : line);
    if (this.#lines.length > serviceOutputLimits.lines) this.#lines.splice(0, this.#lines.length - serviceOutputLimits.lines);
  }
}
