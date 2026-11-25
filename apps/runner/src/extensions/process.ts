import { spawn } from "node:child_process";
import { existsSync, realpathSync, rmSync } from "node:fs";
import { connect, type Socket } from "node:net";
import { dirname, isAbsolute, join, sep } from "node:path";
import { createInterface } from "node:readline";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { holdHandles } from "../hold.js";
import { CONNECTOR_ENVIRONMENT } from "../connector-environment.js";
import { shellQuote } from "../program-command.js";
import { pinServiceSocket, SANDBOX_SERVICE_SOCKETS, type ServiceProcess } from "../session-service.js";
import { lineReader } from "./lines.js";
import type { AppendedHandler, CompleteHandler, CompleteRequest, ExtensionAnswer, ExtensionChannel, ExtensionMethod, ExtensionParams, ExtensionToolDescription, StoredEntry } from "./protocol.js";
import { completeLimits, completeRequestOf } from "./complete.js";
import type { FileBind } from "./files.js";

export type WorkerCommandFor = (directory: string, mounts: readonly string[]) => WorkerCommand | Promise<WorkerCommand>;

export interface WorkerCommand {
  program: string;
  args: string[];
  env?: NodeJS.ProcessEnv;
  cwd?: string;
}

type Reply = { id: number; value?: unknown; handlers?: string[]; tools?: ExtensionToolDescription[]; toolsSignature?: string; pending?: true; error?: string }
  | { warn: { source: string; message: string } } | { entry: { source: string; value: unknown } }
  | { ask: number; complete?: CompleteRequest; invalid?: true } | { cancelAsk: number };

const isObject = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const isStrings = (value: unknown): value is string[] => Array.isArray(value) && value.every(item => typeof item === "string");

function toolDescription(value: unknown): value is ExtensionToolDescription {
  return isObject(value) && typeof value.name === "string" && typeof value.description === "string" && isObject(value.parameters)
    && (value.executionMode === undefined || value.executionMode === "sequential" || value.executionMode === "parallel")
    && (value.promptSnippet === undefined || typeof value.promptSnippet === "string")
    && (value.promptGuidelines === undefined || isStrings(value.promptGuidelines));
}

export function replyOf(value: unknown): Reply | undefined {
  if (!isObject(value)) return undefined;
  if ("warn" in value) {
    const warn = value.warn;
    return isObject(warn) && typeof warn.source === "string" && typeof warn.message === "string" ? { warn: { source: warn.source, message: warn.message } } : undefined;
  }
  if ("entry" in value) {
    const entry = value.entry;
    return isObject(entry) && typeof entry.source === "string" ? { entry: { source: entry.source, value: entry.value } } : undefined;
  }
  if ("ask" in value) {
    if (typeof value.ask !== "number" || !Number.isSafeInteger(value.ask)) return undefined;
    const complete = completeRequestOf(value.complete);
    return complete ? { ask: value.ask, complete } : { ask: value.ask, invalid: true };
  }
  if ("cancelAsk" in value) return typeof value.cancelAsk === "number" && Number.isSafeInteger(value.cancelAsk) ? { cancelAsk: value.cancelAsk } : undefined;
  const { id, error, handlers, tools, toolsSignature, pending } = value;
  if (typeof id !== "number" || !Number.isSafeInteger(id)) return undefined;
  if (error !== undefined) return typeof error === "string" ? { id, error } : undefined;
  if ((handlers !== undefined && !isStrings(handlers)) || (tools !== undefined && !(Array.isArray(tools) && tools.every(toolDescription)))
    || (toolsSignature !== undefined && typeof toolsSignature !== "string")) return undefined;
  return { id, value: value.value, ...(handlers ? { handlers } : {}), ...(tools ? { tools: tools as ExtensionToolDescription[] } : {}),
    ...(toolsSignature !== undefined ? { toolsSignature } : {}), ...(pending === true ? { pending: true as const } : {}) };
}

function deliver(handlers: LaunchHandlers, value: unknown): void {
  const reply = replyOf(value);
  if (!reply) return;
  try { handlers.reply(reply); } catch (error) { handlers.log(`An extension process's answer couldn't be taken: ${error instanceof Error ? error.message : String(error)}`); }
}

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

export type WorkerLaunch = (handlers: LaunchHandlers, mounts: readonly string[], files?: readonly FileBind[]) => Promise<WorkerLink>;

export interface ProcessChannelOptions {
  directory: string;
  sandboxed?: boolean;
  warn(source: string, message: string): void;
  command?: WorkerCommandFor;
  launch?: WorkerLaunch;
  mountAllowed?(path: string): boolean;
  files?(source: string): Promise<readonly FileBind[]>;
  now?(): number;
  log?(line: string): void;
  complete?: CompleteHandler;
  appended?: AppendedHandler;
  entries?(source: string): StoredEntry[] | undefined;
}

const SHUTDOWN_GRACE_MS = 2000;
export const START_TIMEOUT_MS = 60_000;
export const CANCEL_GRACE_MS = 5000;
export const EXTENSION_SOCKET = "extensions.sock";
export const FILES_REFRESH_MS = 30_000;

export function workerEntry(): string[] {
  for (const name of ["./extension-worker.js", "../extension-worker.js"]) {
    const url = new URL(name, import.meta.url);
    if (existsSync(url)) return [fileURLToPath(url)];
  }
  const source = new URL("./child.ts", import.meta.url);
  if (existsSync(source)) return ["--import", import.meta.resolve("tsx"), fileURLToPath(source)];
  throw new Error("This connector has no extension worker to start");
}

export function workerEnvironment(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(base).filter(([name]) => !CONNECTOR_ENVIRONMENT.test(name)));
}

export function workerCommand(directory: string): WorkerCommand {
  return { program: process.execPath, args: [...workerEntry(), directory], cwd: directory, env: workerEnvironment() };
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

export function ipcLaunch(directory: string, command: WorkerCommandFor = workerCommand): WorkerLaunch {
  return async (handlers, mounts) => {
    const run = await command(directory, mounts);
    const child = spawn(run.program, run.args, { cwd: run.cwd ?? directory, env: run.env ?? process.env,
      stdio: ["ignore", "pipe", "pipe", "ipc"], serialization: "json", windowsHide: true });
    for (const stream of [child.stdout, child.stderr]) if (stream) createInterface({ input: stream }).on("line", handlers.log);
    child.on("message", (reply: unknown) => deliver(handlers, reply));
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
      hold: held => holdHandles([child, child.channel, child.stdout, child.stderr], held),
      kill: () => { child.kill("SIGKILL"); },
      exited,
    };
    link.hold(false);
    return link;
  };
}

function readReplies(socket: Socket, handlers: LaunchHandlers, overflow: () => void): void {
  socket.on("data", lineReader(line => {
    let reply: unknown;
    try { reply = JSON.parse(line); } catch { return; }
    deliver(handlers, reply);
  }, overflow));
  socket.on("error", () => {});
}

export const PIPE_FD = 3;

export function pipeLaunch(directory: string, command: WorkerCommandFor = workerCommand): WorkerLaunch {
  return async (handlers, mounts) => {
    const run = await command(directory, mounts);
    const child = spawn(run.program, run.args, { cwd: run.cwd ?? directory, env: run.env ?? process.env,
      stdio: ["ignore", "pipe", "pipe", "pipe"], windowsHide: true });
    for (const stream of [child.stdout, child.stderr]) if (stream) stream.on("data", lineReader(handlers.log, () => {}, 64 * 1024));
    let stopped = false;
    const end = (reason: string) => {
      if (stopped) return;
      stopped = true;
      handlers.ended(reason);
    };
    const exited = new Promise<void>(resolve => { child.once("exit", () => resolve()); });
    child.once("exit", (code, signal) => end(signal ? `it was ended by ${signal}` : `it exited with ${code}`));
    child.once("error", error => end(`it couldn't run: ${error.message}`));
    await new Promise<void>((resolve, reject) => {
      child.once("spawn", () => resolve());
      child.once("error", reject);
    });
    const channel = child.stdio[PIPE_FD] as Socket;
    readReplies(channel, handlers, () => {
      end("it sent more than a message may hold");
      channel.destroy();
      child.kill("SIGKILL");
    });
    const link: WorkerLink = {
      send: (message, failed) => {
        if (channel.destroyed || !channel.writable) failed(new Error("its channel is closed"));
        else channel.write(`${JSON.stringify(message)}\n`, error => { if (error) failed(error); });
      },
      hold: held => holdHandles([child, channel, child.stdout, child.stderr], held),
      kill: () => {
        channel.destroy();
        child.kill("SIGKILL");
      },
      exited,
    };
    link.hold(false);
    return link;
  };
}

export interface ConfinedWorkspace {
  readonly worktree: string;
  readonly nodeBin?: string | undefined;
  processCommand(program: string, args: readonly string[], readRoots: readonly string[]): { command: string; args: string[]; env: Record<string, string>; cwd: string };
}

export function confinedLaunch(sandbox: ConfinedWorkspace): WorkerLaunch {
  return pipeLaunch(sandbox.worktree, (directory, mounts) => {
    if (!sandbox.nodeBin) throw new Error("The host's Node.js can't be given to the sandbox");
    const launch = sandbox.processCommand(join(sandbox.nodeBin, "node"), [...workerEntry(), "--pipe", directory], [...new Set([...workerCodeMounts(), ...mounts])]);
    return { program: launch.command, args: launch.args, env: launch.env, cwd: launch.cwd };
  });
}

export interface SandboxWorker {
  socketDirectory: string;
  nodeBin: string;
  worktree: string;
  start(command: string, binds: readonly string[], onOutput: (chunk: Buffer) => void, signal: AbortSignal, files?: readonly FileBind[]): Promise<ServiceProcess>;
}

export function sandboxLaunch(worker: SandboxWorker): WorkerLaunch {
  return async (handlers, mounts, files = []) => {
    const listening = join(worker.socketDirectory, EXTENSION_SOCKET);
    rmSync(listening, { force: true });
    const command = `exec ${[`${worker.nodeBin}/node`, ...workerEntry(), "--socket", `${SANDBOX_SERVICE_SOCKETS}/${EXTENSION_SOCKET}`, worker.worktree].map(shellQuote).join(" ")} 2>&1`;
    const output = lineReader(handlers.log, () => {}, 64 * 1024);
    const service = await worker.start(command, [...new Set([...workerCodeMounts(), ...mounts])], output, new AbortController().signal, files);
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
    readReplies(socket, handlers, () => {
      end("it sent more than a message may hold");
      socket.destroy();
      service.kill();
    });
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
        holdHandles([socket], held);
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
type Run = { link?: WorkerLink; opened: Set<string>; asks: Map<number, AbortController> };

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
  readonly #files = new Map<string, readonly FileBind[]>();
  #filesAt = 0;
  readonly #refused = new Set<string>();
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

  get sandboxed(): boolean { return this.options.sandboxed === true; }

  mount(paths: readonly (string | undefined)[]): void {
    if (!this.#mounted) return;
    const added = paths.filter((path): path is string => !!path && !this.#mounts.has(path) && this.#mountAllowed(path));
    for (const path of added) this.#mounts.add(path);
    if (!added.length || !this.#live) return;
    if (this.#live.link) this.restart("it starts again to mount new extensions' files");
    else this.#stale = true;
  }

  bind(source: string, files: readonly FileBind[]): void {
    if (!this.#mounted) return;
    const allowed = files.filter(file => {
      if (this.#mountAllowed(file.source)) return true;
      const key = `${source}\0${file.source}`;
      if (!this.#refused.has(key)) {
        this.#refused.add(key);
        this.options.warn(source, `${file.source}, which the host's owner shares with it, can't be given to the session's sandbox, so it runs without it`);
      }
      return false;
    });
    if (JSON.stringify(this.#files.get(source) ?? []) === JSON.stringify(allowed)) return;
    if (allowed.length) this.#files.set(source, allowed);
    else this.#files.delete(source);
    if (!this.#live) return;
    if (this.#live.link) this.restart("it starts again with the host's files shared with its extensions");
    else this.#stale = true;
  }

  async #refreshFiles(): Promise<void> {
    const now = this.options.now?.() ?? Date.now();
    if (!this.options.files || !this.#mounted || this.#pending.size || now - this.#filesAt < FILES_REFRESH_MS) return;
    this.#filesAt = now;
    for (const source of this.#opened.keys()) {
      const files = await this.options.files(source).catch(() => this.#files.get(source) ?? []);
      if (!this.#pending.size) this.bind(source, files);
    }
  }

  #fileBinds(): FileBind[] {
    const byTarget = new Map<string, FileBind>();
    for (const files of this.#files.values()) for (const file of files) if (!byTarget.has(file.target)) byTarget.set(file.target, file);
    return [...byTarget.values()];
  }

  #mountAllowed(path: string): boolean {
    return this.options.mountAllowed?.(path) ?? true;
  }

  async call<M extends ExtensionMethod>(method: M, params: ExtensionParams<M>, signal?: AbortSignal): Promise<ExtensionAnswer<M>> {
    if (this.#closed) throw new Error("The extension process is closed");
    if (method === "open" || method === "describe") {
      const { mount } = params as ExtensionParams<"open" | "describe">;
      if (this.#mounted && mount && !this.#mountAllowed(mount)) throw new Error(`Its files, in ${mount}, can't be given to the session's sandbox`);
      this.mount([mount]);
      const source = (params as { source?: unknown }).source;
      if (method === "open" && typeof source === "string" && this.options.files) {
        this.#filesAt = this.options.now?.() ?? Date.now();
        this.bind(source, await this.options.files(source).catch(() => this.#files.get(source) ?? []));
      }
    } else await this.#refreshFiles();
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
    const run: Run = { opened: new Set(), asks: new Map() };
    this.#live = run;
    this.#stale = false;
    const log = this.options.log ?? (line => { process.stderr.write(`Extension process: ${line.replace(/[\x00-\x1f\x7f]/g, " ").slice(0, 1000)}\n`); });
    try {
      run.link = await this.#launch({ reply: reply => this.#reply(reply, run), log, ended: reason => this.#ended(run, reason) }, [...this.#mounts],
        this.#fileBinds().map(({ source, target }) => ({ source, target })));
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
      const entries = this.options.entries?.(source);
      if (entries?.length) await this.#send(run, "restore", { source, entries });
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

  #answerAsk(run: Run, ask: number, request: CompleteRequest | undefined): void {
    if (run.asks.has(ask)) {
      if (request) this.options.warn(request.source, "it asked for a model call under the id of one that is still running; the second was dropped");
      return;
    }
    const answer = (message: Record<string, unknown>) => {
      run.asks.delete(ask);
      if (this.#live === run) run.link?.send({ answered: ask, ...message }, () => {});
    };
    if (!request) return answer({ error: "The model call wasn't one the connector takes" });
    const opened = this.#opened.get(request.source);
    if (!this.options.complete || !opened?.modelCalls || !run.opened.has(request.source)) {
      this.options.warn(request.source, "it asked for a model call, which only the extensions the host lets call models may make; it was refused");
      return answer({ error: "Installed extensions can't call models in Pikibun: the host's credentials stay with its connector." });
    }
    if (run.asks.size >= completeLimits.atOnce) return answer({ error: "Too many model calls at once" });
    const controller = new AbortController();
    run.asks.set(ask, controller);
    const timer = setTimeout(() => controller.abort(), completeLimits.timeoutMs + 5000);
    timer.unref();
    void this.options.complete(request, controller.signal)
      .then(value => answer({ value }), (error: unknown) => answer({ error: (error instanceof Error ? error.message : String(error)).slice(0, 2000) }))
      .finally(() => clearTimeout(timer));
  }

  #reply(reply: Reply, run?: Run): void {
    if ("ask" in reply) {
      if (run && this.#live === run) this.#answerAsk(run, reply.ask, reply.complete);
      return;
    }
    if ("cancelAsk" in reply) {
      run?.asks.get(reply.cancelAsk)?.abort();
      return;
    }
    if ("entry" in reply) {
      if (run && this.#live === run && run.opened.has(reply.entry.source)) this.options.appended?.(reply.entry.source, reply.entry.value);
      return;
    }
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
    else pending.resolve({ value: reply.value as never, ...(reply.handlers ? { handlers: reply.handlers } : {}), ...(reply.tools ? { tools: reply.tools } : {}), ...(reply.toolsSignature ? { toolsSignature: reply.toolsSignature } : {}), ...(reply.pending ? { pending: true as const } : {}) });
  }

  #ended(run: Run, reason: string): void {
    for (const controller of run.asks.values()) controller.abort();
    run.asks.clear();
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
