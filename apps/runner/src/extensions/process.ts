import { spawn } from "node:child_process";
import { existsSync, realpathSync, rmSync } from "node:fs";
import { connect } from "node:net";
import { dirname, isAbsolute, join, sep } from "node:path";
import { createInterface } from "node:readline";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { shellQuote } from "../program-command.js";
import { pinServiceSocket, SANDBOX_SERVICE_SOCKETS, type ServiceProcess } from "../session-service.js";
import { lineReader } from "./lines.js";
import type { ExtensionAnswer, ExtensionChannel, ExtensionMethod, ExtensionParams } from "./protocol.js";

export interface WorkerCommand {
  program: string;
  args: string[];
  env?: NodeJS.ProcessEnv;
  cwd?: string;
}

type Reply = { id: number; value?: unknown; handlers?: string[]; error?: string } | { warn: { source: string; message: string } };

export interface WorkerLink {
  send(message: unknown, failed: (error: Error) => void): void;
  hold(held: boolean): void;
  kill(): void;
  readonly exited: Promise<void>;
}

export interface LaunchHandlers {
  reply(reply: Reply): void;
  log(line: string): void;
  ended(reason: string): void;
}

export type WorkerLaunch = (handlers: LaunchHandlers, mounts: readonly string[]) => Promise<WorkerLink>;

export interface ProcessChannelOptions {
  directory: string;
  warn(source: string, message: string): void;
  command?: (directory: string) => WorkerCommand;
  launch?: WorkerLaunch;
  mountAllowed?(path: string): boolean;
  log?(line: string): void;
}

const SHUTDOWN_GRACE_MS = 2000;
export const START_TIMEOUT_MS = 60_000;
export const CANCEL_GRACE_MS = 5000;
export const EXTENSION_SOCKET = "extensions.sock";

export function workerEntry(): string[] {
  for (const name of ["./extension-worker.js", "../extension-worker.js"]) {
    const url = new URL(name, import.meta.url);
    if (existsSync(url)) return [fileURLToPath(url)];
  }
  const source = new URL("./child.ts", import.meta.url);
  if (existsSync(source)) return ["--import", import.meta.resolve("tsx"), fileURLToPath(source)];
  throw new Error("This connector has no extension worker to start");
}

export function workerCommand(directory: string): WorkerCommand {
  return { program: process.execPath, args: [...workerEntry(), directory], cwd: directory, env: process.env };
}

export function codeRoot(file: string): string {
  const parts = file.split(sep);
  const at = parts.indexOf("node_modules");
  if (at > 0) return parts.slice(0, at + 1).join(sep);
  for (let directory = dirname(file); directory !== dirname(directory); directory = dirname(directory)) {
    if (existsSync(join(directory, "node_modules"))) return directory;
  }
  return dirname(file);
}

export function workerCodeMounts(): string[] {
  const roots = new Set<string>();
  const add = (file: string) => {
    try { roots.add(codeRoot(realpathSync(file))); } catch { }
  };
  for (const arg of workerEntry()) {
    const file = arg.startsWith("file:") ? fileURLToPath(arg) : arg;
    if (isAbsolute(file)) add(file);
  }
  for (const name of ["@earendil-works/pi-coding-agent", "@earendil-works/pi-ai"]) {
    try { add(fileURLToPath(import.meta.resolve(name))); } catch { }
  }
  return [...roots];
}

export function ipcLaunch(directory: string, command: (directory: string) => WorkerCommand = workerCommand): WorkerLaunch {
  return async handlers => {
    const run = command(directory);
    const child = spawn(run.program, run.args, { cwd: run.cwd ?? directory, env: run.env ?? process.env,
      stdio: ["ignore", "pipe", "pipe", "ipc"], serialization: "json", windowsHide: true });
    for (const stream of [child.stdout, child.stderr]) if (stream) createInterface({ input: stream }).on("line", handlers.log);
    child.on("message", (reply: Reply) => handlers.reply(reply));
    const exited = new Promise<void>(resolve => { child.once("exit", () => resolve()); });
    child.once("exit", (code, signal) => handlers.ended(signal ? `it was ended by ${signal}` : `it exited with ${code}`));
    child.once("error", error => handlers.ended(`it couldn't run: ${error.message}`));
    await new Promise<void>((resolve, reject) => {
      child.once("spawn", () => resolve());
      child.once("error", reject);
    });
    const link: WorkerLink = {
      send: (message, failed) => {
        if (!child.connected) failed(new Error("its channel is closed"));
        else child.send(message as never, error => { if (error) failed(error); });
      },
      hold: held => {
        for (const handle of [child, child.channel, child.stdout, child.stderr] as ({ ref?(): unknown; unref?(): unknown } | null | undefined)[]) {
          if (held) handle?.ref?.();
          else handle?.unref?.();
        }
      },
      kill: () => { child.kill("SIGKILL"); },
      exited,
    };
    link.hold(false);
    return link;
  };
}

export interface SandboxWorker {
  socketDirectory: string;
  nodeBin: string;
  worktree: string;
  start(command: string, binds: readonly string[], onOutput: (chunk: Buffer) => void, signal: AbortSignal): Promise<ServiceProcess>;
}

export function sandboxLaunch(worker: SandboxWorker): WorkerLaunch {
  return async (handlers, mounts) => {
    const listening = join(worker.socketDirectory, EXTENSION_SOCKET);
    rmSync(listening, { force: true });
    const command = `exec ${[`${worker.nodeBin}/node`, ...workerEntry(), "--socket", `${SANDBOX_SERVICE_SOCKETS}/${EXTENSION_SOCKET}`, worker.worktree].map(shellQuote).join(" ")} 2>&1`;
    const output = lineReader(handlers.log, () => {}, 64 * 1024);
    const service = await worker.start(command, [...new Set([...workerCodeMounts(), ...mounts])], output, new AbortController().signal);
    let stopped: string | undefined;
    const end = (reason: string) => {
      if (stopped !== undefined) return;
      stopped = reason;
      handlers.ended(reason);
    };
    void service.exited.then(exit => end(exit.failure ?? (exit.signal ? `it was ended by ${exit.signal}` : `it exited with ${exit.code}`)));
    const deadline = Date.now() + START_TIMEOUT_MS;
    while (!existsSync(listening)) {
      if (stopped !== undefined || Date.now() > deadline) {
        service.kill();
        throw new Error(stopped !== undefined ? `It stopped before it listened: ${stopped}` : `It didn't listen within ${START_TIMEOUT_MS / 1000} seconds`);
      }
      await delay(50);
    }
    const socket = connect(pinServiceSocket(worker.socketDirectory, EXTENSION_SOCKET));
    await new Promise<void>((resolve, reject) => {
      socket.once("connect", () => resolve());
      socket.once("error", reject);
    }).catch(error => {
      socket.destroy();
      service.kill();
      throw error;
    });
    socket.on("data", lineReader(line => {
      let reply: Reply;
      try { reply = JSON.parse(line) as Reply; } catch { return; }
      handlers.reply(reply);
    }, () => {
      end("it sent more than a message may hold");
      socket.destroy();
      service.kill();
    }));
    socket.on("error", () => {});
    socket.on("close", () => {
      end("its connection closed");
      service.kill();
    });
    const link: WorkerLink = {
      send: (message, failed) => {
        if (socket.destroyed) failed(new Error("its connection is closed"));
        else socket.write(`${JSON.stringify(message)}\n`, error => { if (error) failed(error); });
      },
      hold: held => {
        if (held) socket.ref();
        else socket.unref();
        service.hold?.(held);
      },
      kill: () => {
        socket.destroy();
        service.kill();
      },
      exited: service.exited.then(() => undefined),
    };
    link.hold(false);
    return link;
  };
}

export function refusedChannel(reason: string): ExtensionChannel {
  return { call: async () => { throw new Error(reason); }, close: async () => {} };
}

type Pending = { method: ExtensionMethod; resolve(answer: ExtensionAnswer<ExtensionMethod>): void; reject(error: Error): void };
type Run = { link?: WorkerLink; opened: Set<string> };

export class ProcessChannel implements ExtensionChannel {
  #live?: Run;
  #ready?: Run;
  #starting?: Promise<Run>;
  #next = 1;
  #starts = 0;
  #closed = false;
  #stale = false;
  readonly #mounted: boolean;
  readonly #launch: WorkerLaunch;
  readonly #mounts = new Set<string>();
  readonly #pending = new Map<number, Pending>();
  readonly #opened = new Map<string, ExtensionParams<"open">>();
  readonly #started = new Map<string, ExtensionParams<"emit">>();
  readonly #unopened = new Set<string>();
  readonly #cancelled = new Set<number>();

  constructor(private readonly options: ProcessChannelOptions) {
    this.#mounted = options.launch !== undefined;
    this.#launch = options.launch ?? ipcLaunch(options.directory, options.command);
  }

  get running(): boolean { return !!this.#live; }

  mount(paths: readonly (string | undefined)[]): void {
    if (!this.#mounted) return;
    const added = paths.filter((path): path is string => !!path && !this.#mounts.has(path) && this.#mountAllowed(path));
    for (const path of added) this.#mounts.add(path);
    if (!added.length || !this.#live) return;
    if (this.#live.link) this.restart("it starts again to mount new extensions' files");
    else this.#stale = true;
  }

  #mountAllowed(path: string): boolean {
    return this.options.mountAllowed?.(path) ?? true;
  }

  async call<M extends ExtensionMethod>(method: M, params: ExtensionParams<M>, signal?: AbortSignal): Promise<ExtensionAnswer<M>> {
    if (this.#closed) throw new Error("The extension process is closed");
    if (method === "open") {
      const { mount } = params as ExtensionParams<"open">;
      if (this.#mounted && mount && !this.#mountAllowed(mount)) throw new Error(`Its files, in ${mount}, can't be given to the session's sandbox`);
      this.mount([mount]);
    }
    const run = await this.#ensure();
    const source = (params as { source?: unknown }).source;
    if (method !== "open" && typeof source === "string" && this.#unopened.has(source)) await this.#reopen(run, source);
    const answer = await this.#send(run, method, params, signal);
    if (method === "open" && typeof source === "string") {
      this.#opened.set(source, params as ExtensionParams<"open">);
      run.opened.add(source);
    }
    if (method === "emit" && typeof source === "string" && (params as ExtensionParams<"emit">).event.type === "session_start") this.#started.set(source, params as ExtensionParams<"emit">);
    return answer;
  }

  async ready(): Promise<void> {
    if (!this.#closed) await this.#ensure();
  }

  restart(reason: string): void {
    const run = this.#live;
    if (!run) return;
    this.#ended(run, reason);
    run.link?.kill();
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    const run = this.#live?.link ? this.#live : await this.#starting?.catch(() => undefined);
    const link = run?.link;
    if (!run || !link) return;
    link.hold(true);
    const grace = new Promise<void>(resolve => { setTimeout(resolve, SHUTDOWN_GRACE_MS); });
    await Promise.race([this.#send(run, "shutdown", {}).catch(() => undefined), grace]);
    link.kill();
    this.#ended(run, "it was closed");
    await Promise.race([link.exited, grace]);
  }

  #ensure(): Promise<Run> {
    if (this.#ready) return Promise.resolve(this.#ready);
    this.#starting ??= this.#start().finally(() => { this.#starting = undefined; });
    return this.#starting;
  }

  async #start(): Promise<Run> {
    const run: Run = { opened: new Set() };
    this.#live = run;
    this.#stale = false;
    const log = this.options.log ?? (line => { process.stderr.write(`Extension process: ${line.replace(/[\x00-\x1f\x7f]/g, " ").slice(0, 1000)}\n`); });
    try {
      run.link = await this.#launch({ reply: reply => this.#reply(reply), log, ended: reason => this.#ended(run, reason) }, [...this.#mounts]);
    } catch (error) {
      if (this.#live === run) this.#live = undefined;
      throw new Error(`The extension process couldn't start: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (this.#live !== run || this.#closed) {
      if (this.#live === run) this.#live = undefined;
      run.link.kill();
      throw new Error(this.#closed ? "The extension process is closed" : "The extension process stopped as it started");
    }
    if (this.#stale) {
      run.link.kill();
      this.#live = undefined;
      return this.#start();
    }
    if (this.#starts++ > 0) {
      const timer = setTimeout(() => this.restart(`it took longer than ${START_TIMEOUT_MS / 1000} seconds to open its extensions again`), START_TIMEOUT_MS);
      timer.unref();
      try { await this.#replay(run); } finally { clearTimeout(timer); }
    }
    if (this.#live !== run) throw new Error("The extension process stopped as it started");
    this.#ready = run;
    return run;
  }

  async #replay(run: Run): Promise<void> {
    for (const source of this.#opened.keys()) {
      try { await this.#reopen(run, source); }
      catch (error) {
        this.options.warn(source, `didn't open again in the new extension process, and is tried again at its next request: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }

  async #reopen(run: Run, source: string): Promise<void> {
    this.#unopened.add(source);
    if (!run.opened.has(source)) {
      await this.#send(run, "open", this.#opened.get(source)!);
      run.opened.add(source);
    }
    const started = this.#started.get(source);
    if (started) await this.#send(run, "emit", started);
    this.#unopened.delete(source);
  }

  #send<M extends ExtensionMethod>(run: Run, method: M, params: ExtensionParams<M>, signal?: AbortSignal): Promise<ExtensionAnswer<M>> {
    return new Promise((resolve, reject) => {
      const link = run.link;
      if (this.#live !== run || !link) {
        reject(new Error("The extension process stopped"));
        return;
      }
      const id = this.#next++;
      const failed = (error: Error) => this.#pending.get(id)?.reject(new Error(`The extension process couldn't be asked: ${error.message}`));
      const cancel = () => {
        if (!this.#pending.has(id)) return;
        link.send({ cancel: id }, () => {});
        this.#cancelled.add(id);
        setTimeout(() => {
          if (this.#cancelled.delete(id) && this.#live === run) this.restart(`a request it was asked to cancel didn't end within ${CANCEL_GRACE_MS / 1000} seconds`);
        }, CANCEL_GRACE_MS).unref();
        this.#pending.get(id)?.reject(new Error("The request was aborted"));
      };
      const done = () => { this.#pending.delete(id); signal?.removeEventListener("abort", cancel); if (!this.#pending.size && !this.#closed) link.hold(false); };
      this.#pending.set(id, {
        method,
        resolve: answer => { done(); resolve(answer as ExtensionAnswer<M>); },
        reject: error => { done(); reject(error); },
      });
      signal?.addEventListener("abort", cancel, { once: true });
      link.hold(true);
      try { link.send({ id, method, params }, failed); }
      catch (error) {
        failed(error instanceof Error ? error : new Error(String(error)));
        return;
      }
      if (signal?.aborted) cancel();
    });
  }

  #reply(reply: Reply): void {
    if ("warn" in reply) {
      const { source, message } = reply.warn;
      if (source) this.options.warn(source, message);
      else for (const opened of this.#opened.keys()) this.options.warn(opened, message);
      return;
    }
    this.#cancelled.delete(reply.id);
    const pending = this.#pending.get(reply.id);
    if (!pending) return;
    if (reply.error !== undefined) pending.reject(new Error(reply.error));
    else pending.resolve({ value: reply.value as never, ...(reply.handlers ? { handlers: reply.handlers } : {}) });
  }

  #ended(run: Run, reason: string): void {
    if (this.#live !== run) return;
    this.#live = undefined;
    if (this.#ready === run) this.#ready = undefined;
    const pending = [...this.#pending.values()];
    this.#pending.clear();
    for (const item of pending) item.reject(new Error(`The extension process stopped: ${reason}`));
    if (this.#closed) return;
    for (const source of this.#opened.keys()) {
      this.options.warn(source, `the extension process stopped (${reason}); its extensions start again at the next request, without what they kept in memory`);
    }
  }
}
