import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import type { ExtensionAnswer, ExtensionChannel, ExtensionMethod, ExtensionParams } from "./protocol.js";

export interface WorkerCommand {
  program: string;
  args: string[];
  env?: NodeJS.ProcessEnv;
  cwd?: string;
}

export interface ProcessChannelOptions {
  directory: string;
  warn(source: string, message: string): void;
  command?: (directory: string) => WorkerCommand;
  log?(line: string): void;
}

const SHUTDOWN_GRACE_MS = 2000;
export const START_TIMEOUT_MS = 60_000;
export const CANCEL_GRACE_MS = 5000;

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

type Pending = { method: ExtensionMethod; resolve(answer: ExtensionAnswer<ExtensionMethod>): void; reject(error: Error): void };
type Reply = { id: number; value?: unknown; handlers?: string[]; error?: string } | { warn: { source: string; message: string } };

export class ProcessChannel implements ExtensionChannel {
  #live?: ChildProcess;
  #ready?: ChildProcess;
  #starting?: Promise<ChildProcess>;
  #next = 1;
  #starts = 0;
  #closed = false;
  readonly #pending = new Map<number, Pending>();
  readonly #opened = new Map<string, ExtensionParams<"open">>();
  readonly #started = new Map<string, ExtensionParams<"emit">>();
  readonly #unopened = new Set<string>();
  readonly #cancelled = new Set<number>();

  constructor(private readonly options: ProcessChannelOptions) {}

  get running(): boolean { return !!this.#live; }

  async call<M extends ExtensionMethod>(method: M, params: ExtensionParams<M>, signal?: AbortSignal): Promise<ExtensionAnswer<M>> {
    if (this.#closed) throw new Error("The extension process is closed");
    const child = await this.#ensure();
    const source = (params as { source?: unknown }).source;
    if (method !== "open" && typeof source === "string" && this.#unopened.has(source)) await this.#reopen(child, source);
    const answer = await this.#send(child, method, params, signal);
    if (method === "open" && typeof source === "string") this.#opened.set(source, params as ExtensionParams<"open">);
    if (method === "emit" && typeof source === "string" && (params as ExtensionParams<"emit">).event.type === "session_start") this.#started.set(source, params as ExtensionParams<"emit">);
    return answer;
  }

  async ready(): Promise<void> {
    if (!this.#closed) await this.#ensure();
  }

  restart(reason: string): void {
    const child = this.#live;
    if (!child) return;
    this.#ended(child, reason);
    child.kill("SIGKILL");
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    const child = this.#live ?? await this.#starting?.catch(() => undefined);
    if (!child) return;
    this.#hold(child, true);
    const exited = new Promise<void>(resolve => { if (child.exitCode !== null || child.signalCode !== null) resolve(); else child.once("exit", () => resolve()); });
    const grace = new Promise<void>(resolve => { setTimeout(resolve, SHUTDOWN_GRACE_MS); });
    await Promise.race([this.#send(child, "shutdown", {}).catch(() => undefined), grace]);
    child.kill("SIGKILL");
    this.#ended(child, "it was closed");
    await Promise.race([exited, grace]);
  }

  #ensure(): Promise<ChildProcess> {
    if (this.#ready) return Promise.resolve(this.#ready);
    this.#starting ??= this.#start().finally(() => { this.#starting = undefined; });
    return this.#starting;
  }

  async #start(): Promise<ChildProcess> {
    const { directory } = this.options;
    const command = (this.options.command ?? workerCommand)(directory);
    const child = spawn(command.program, command.args, { cwd: command.cwd ?? directory, env: command.env ?? process.env,
      stdio: ["ignore", "pipe", "pipe", "ipc"], serialization: "json", windowsHide: true });
    this.#live = child;
    const log = this.options.log ?? (line => { process.stderr.write(`Extension process: ${line.replace(/[\x00-\x1f\x7f]/g, " ").slice(0, 1000)}\n`); });
    for (const stream of [child.stdout, child.stderr]) if (stream) createInterface({ input: stream }).on("line", log);
    this.#hold(child, false);
    child.on("message", (reply: Reply) => this.#reply(reply));
    child.once("exit", (code, signal) => this.#ended(child, signal ? `it was ended by ${signal}` : `it exited with ${code}`));
    child.once("error", error => this.#ended(child, `it couldn't run: ${error.message}`));
    await new Promise<void>((resolve, reject) => {
      child.once("spawn", () => resolve());
      child.once("error", reject);
    });
    if (this.#starts++ > 0) {
      const timer = setTimeout(() => this.restart(`it took longer than ${START_TIMEOUT_MS / 1000} seconds to open its extensions again`), START_TIMEOUT_MS);
      timer.unref();
      try { await this.#replay(child); } finally { clearTimeout(timer); }
    }
    if (this.#live !== child) throw new Error("The extension process stopped as it started");
    this.#ready = child;
    return child;
  }

  async #replay(child: ChildProcess): Promise<void> {
    for (const source of this.#opened.keys()) {
      try { await this.#reopen(child, source); }
      catch (error) {
        this.options.warn(source, `didn't open again in the new extension process, and is tried again at its next request: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }

  async #reopen(child: ChildProcess, source: string): Promise<void> {
    this.#unopened.add(source);
    await this.#send(child, "open", this.#opened.get(source)!);
    this.#unopened.delete(source);
    const started = this.#started.get(source);
    if (started) await this.#send(child, "emit", started);
  }

  #send<M extends ExtensionMethod>(child: ChildProcess, method: M, params: ExtensionParams<M>, signal?: AbortSignal): Promise<ExtensionAnswer<M>> {
    return new Promise((resolve, reject) => {
      if (this.#live !== child) {
        reject(new Error("The extension process stopped"));
        return;
      }
      const id = this.#next++;
      const cancel = () => {
        if (!this.#pending.has(id)) return;
        if (child.connected) child.send({ cancel: id }, () => {});
        this.#cancelled.add(id);
        setTimeout(() => {
          if (this.#cancelled.delete(id) && this.#live === child) this.restart(`a request it was asked to cancel didn't end within ${CANCEL_GRACE_MS / 1000} seconds`);
        }, CANCEL_GRACE_MS).unref();
        this.#pending.get(id)?.reject(new Error("The request was aborted"));
      };
      const done = () => { this.#pending.delete(id); signal?.removeEventListener("abort", cancel); if (!this.#pending.size && !this.#closed) this.#hold(child, false); };
      this.#pending.set(id, {
        method,
        resolve: answer => { done(); resolve(answer as ExtensionAnswer<M>); },
        reject: error => { done(); reject(error); },
      });
      signal?.addEventListener("abort", cancel, { once: true });
      this.#hold(child, true);
      try {
        child.send({ id, method, params }, error => { if (error) this.#pending.get(id)?.reject(new Error(`The extension process couldn't be asked: ${error.message}`)); });
      } catch (error) {
        this.#pending.get(id)?.reject(new Error(`The extension process couldn't be asked: ${error instanceof Error ? error.message : String(error)}`));
        return;
      }
      if (signal?.aborted) cancel();
    });
  }

  #hold(child: ChildProcess, held: boolean): void {
    const handles = [child, child.channel, child.stdout, child.stderr] as ({ ref?(): unknown; unref?(): unknown } | null | undefined)[];
    for (const handle of handles) {
      if (held) handle?.ref?.();
      else handle?.unref?.();
    }
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

  #ended(child: ChildProcess, reason: string): void {
    if (this.#live !== child) return;
    this.#live = undefined;
    if (this.#ready === child) this.#ready = undefined;
    const pending = [...this.#pending.values()];
    this.#pending.clear();
    for (const item of pending) item.reject(new Error(`The extension process stopped: ${reason}`));
    if (this.#closed) return;
    for (const source of this.#opened.keys()) {
      this.options.warn(source, `the extension process stopped (${reason}); its extensions start again at the next request, without what they kept in memory`);
    }
  }
}
