import { createHash } from "node:crypto";
import { linkSync, lstatSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BrowserServe } from "../../../packages/shared/src/browser.js";
import { serviceLifetimeLimits, serviceOutputLimits } from "../../../packages/shared/src/tunnel.js";
import { nodePrograms } from "./node-command.js";
import { programShellCommand, shellQuote } from "./program-command.js";
import type { CommandLimits } from "./host-config.js";

export const SANDBOX_SERVICE_DRIVER = "/opt/pikibun/service/pikibun-service";
export const SANDBOX_SERVICE_SOCKETS = "/run/pikibun-service";
export const SERVICE_SOCKET = "http.sock";
export const SERVICE_MARK = "\x1epikibun-service ";

let directory: string | undefined;
export function serviceSocketDirectory(sessionId: string, dataDir: string): string {
  directory ??= mkdtempSync(join(tmpdir().length < 40 ? tmpdir() : "/tmp", "pikibun-service-"));
  const path = join(directory, createHash("sha256").update(`${dataDir}\0${sessionId}`).digest("hex").slice(0, 24));
  mkdirSync(path, { recursive: true, mode: 0o700 });
  return path;
}

export function pinServiceSocket(directory: string, name = SERVICE_SOCKET): string {
  const pinned = `${directory}.connector`;
  mkdirSync(pinned, { recursive: true, mode: 0o700 });
  const target = join(pinned, name);
  rmSync(target, { force: true });
  try { linkSync(join(directory, name), target); }
  catch { throw new Error("The server's socket isn't there"); }
  const info = lstatSync(target);
  if (!info.isSocket() || (process.getuid && info.uid !== process.getuid())) {
    rmSync(target, { force: true });
    throw new Error("The server's socket was replaced with something else, so nothing was put online");
  }
  return target;
}

export function serviceLimits(seconds: number, cpus: number): CommandLimits {
  const bounded = Math.min(Math.max(Math.trunc(Number.isFinite(seconds) ? seconds : serviceLifetimeLimits.default), serviceLifetimeLimits.min), serviceLifetimeLimits.max);
  return { seconds: bounded, cpuSeconds: bounded * Math.max(1, Math.trunc(cpus)), fileBytes: 16 * 1024 * 1024 * 1024, openFiles: 8192 };
}

export function serviceShellCommand(serve: BrowserServe, options: { nodeBin?: string | undefined } = {}): string {
  const node = options.nodeBin && (nodePrograms as readonly string[]).includes(serve.program) ? ["--node-bin", options.nodeBin] : [];
  return programShellCommand({ directory: ".", program: shellQuote(SANDBOX_SERVICE_DRIVER),
    args: ["--socket", `${SANDBOX_SERVICE_SOCKETS}/${SERVICE_SOCKET}`, ...node, JSON.stringify(serve)] });
}

export interface ServiceExit { code: number | null; signal: NodeJS.Signals | null; failure?: string }

export interface ServiceProcess {
  exited: Promise<ServiceExit>;
  kill(): void;
  hold?(held: boolean): void;
}

export type ServiceStopReason = string;

export interface ServiceStop {
  reason: ServiceStopReason;
  exit?: ServiceExit;
}

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
    void this.#readiness.promise.catch(() => {});
  }

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
    if (service.#stop) process.kill();
    void process.exited.then(exit => {
      clearTimeout(service.#timer);
      service.flush();
      if (!service.#ready) service.#readiness.reject(new Error(service.#readyError ?? `The server stopped before its port answered${exit.failure ? ` (${exit.failure})` : ""}`));
      service.#settle({ reason: service.#stop?.reason ?? "exited", exit });
    });
    return service;
  }

  get ready(): Promise<void> { return this.#readiness.promise; }

  get stopped(): Promise<ServiceStop> { return this.#stopped.promise; }

  get running(): boolean { return !this.#settled; }

  lines(): string[] {
    return this.#partial ? [...this.#lines, this.#partial].slice(-serviceOutputLimits.lines) : [...this.#lines];
  }

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
      try { notice = JSON.parse(line.slice(SERVICE_MARK.length)) as typeof notice; } catch { }
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
