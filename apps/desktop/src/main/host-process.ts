import { spawn } from "node:child_process";
import { STDIO_FRAME, type HostEvent, type HostRequest } from "../../../runner/src/desktop-protocol.js";

// Runs a connector host and talks to it: dist/host/desktop-host.mjs (see scripts/build.mjs) in an Electron utility
// process (utility-host.ts), or, on Windows, the same host inside WSL2 through wsl.exe, over its stdin and stdout
// (stdioHost, wsl.ts). It is started on demand and never restarted by itself: an unexpected exit is reported and the
// next request starts a fresh one. Nothing here needs Electron, so tests run it with Node.

type Request = HostRequest extends infer R ? R extends HostRequest ? Omit<R, "id"> : never : never;
export type HostResult = Extract<HostEvent, { type: "result" }>;

const eventTypes: Record<HostEvent["type"], true> = { ready: true, result: true, status: true, log: true, failed: true };
const isHostEvent = (value: unknown): value is HostEvent => typeof value === "object" && value !== null
  && "type" in value && typeof value.type === "string" && Object.hasOwn(eventTypes, value.type);

/** A line a launcher writes to stderr about what this computer lacks (wsl-host.sh): shown to the owner as is. */
export const SETUP_PREFIX = "pikibun-setup: ";

/** Why a host could not be launched at all (WSL2 missing, say): its message is shown to the owner as is. */
export class HostLaunchError extends Error {}

/** One running host process, however it was started. */
export interface HostChild {
  readonly pid: number | undefined;
  postMessage(message: unknown): void;
  onMessage(listener: (value: unknown) => void): void;
  /** Lines it printed outside the protocol, e.g. library warnings, at most 1000 characters each. */
  onOutput(listener: (line: string) => void): void;
  /** A failure the process reports before it exits (a fatal V8 error, a launcher that can't start). */
  onError(listener: (detail: string) => void): void;
  onceExit(listener: (code: number) => void): void;
  /** Asks it to end: SIGTERM to a utility process, the end of its stdin to a WSL2 host. */
  terminate(): void;
  /** Ends it now. */
  kill(): void;
}

/** Splits a stream into lines, handing each complete one (at most 1000 characters) to `line`. */
export function lines(stream: NodeJS.ReadableStream | null | undefined, line: (text: string) => void, limit = 4096): void {
  let buffered = "";
  stream?.setEncoding("utf8");
  stream?.on("data", (chunk: string) => {
    buffered += chunk;
    const parts = buffered.split("\n");
    buffered = parts.pop()!;
    if (buffered.length > limit) buffered = buffered.slice(-limit);
    for (const part of parts) line(part.replace(/\r$/, ""));
  });
}

export const outputLine = (listener: (line: string) => void) => (line: string) => { if (line.trim()) listener(line.slice(0, 1000)); };

/**
 * The host behind a pipe-only launcher (wsl.exe): requests are JSON lines on its stdin, and its stdout's lines that
 * start with STDIO_FRAME are its events. Other lines, on either stream, are output.
 */
export function stdioHost(command: string, args: string[], env?: NodeJS.ProcessEnv): HostChild {
  const child = spawn(command, args, { stdio: ["pipe", "pipe", "pipe"], windowsHide: true, ...(env ? { env } : {}) });
  const messages: ((value: unknown) => void)[] = [];
  const output: ((line: string) => void)[] = [];
  const say = (line: string) => { for (const listener of output) outputLine(listener)(line); };
  // Events may be as large as an inspection with every model; a stray line without an end is cut at 4 MiB.
  lines(child.stdout, line => {
    if (!line.startsWith(STDIO_FRAME)) { say(line); return; }
    let value: unknown;
    try { value = JSON.parse(line.slice(STDIO_FRAME.length)); } catch { say("The host sent a malformed message."); return; }
    for (const listener of messages) listener(value);
  }, 4 * 1024 * 1024);
  lines(child.stderr, say);
  child.stdin.on("error", () => { /* The host has gone; its exit follows. */ });
  return {
    get pid() { return child.pid; },
    postMessage: message => { if (child.stdin.writable) child.stdin.write(`${JSON.stringify(message)}\n`); },
    onMessage: listener => { messages.push(listener); },
    onOutput: listener => { output.push(listener); },
    onError: listener => { child.on("error", error => listener(`The host could not be started: ${error.message}`)); },
    // A launcher that never started reports "error" without "exit".
    onceExit: listener => {
      let done = false;
      const once = (code: number | null) => { if (!done) { done = true; listener(code ?? 1); } };
      child.once("exit", once);
      child.once("error", () => once(1));
    },
    terminate: () => { child.stdin.end(); },
    kill: () => { child.kill(); },
  };
}

export interface HostProcessOptions {
  /** Starts the host; throws HostLaunchError when this computer can't run it as configured. */
  launch(): HostChild | Promise<HostChild>;
  onEvent(event: Exclude<HostEvent, HostResult | { type: "ready" }>): void;
  /** Lines the host process printed outside the protocol, e.g. library warnings. */
  onOutput(line: string): void;
  onExit(code: number, expected: boolean): void;
}

export class HostProcess {
  private child?: HostChild;
  private ready?: Promise<void>;
  private readonly pending = new Map<number, (result: HostResult) => void>();
  private nextId = 1;
  private stopping = false;
  /** Why the latest launch failed, for the requests that waited on it. */
  private launchFailure?: string;

  constructor(private readonly options: HostProcessOptions) {}

  get running(): boolean { return this.child !== undefined; }

  private async spawn(): Promise<void> {
    this.launchFailure = undefined;
    let child: HostChild;
    try { child = await this.options.launch(); }
    catch (error) {
      this.launchFailure = error instanceof HostLaunchError ? error.message : "The host process could not start.";
      throw error;
    }
    const ready = Promise.withResolvers<void>();
    this.child = child;
    this.stopping = false;
    let setup: string | undefined;
    child.onOutput(line => {
      if (line.startsWith(SETUP_PREFIX)) setup = line.slice(SETUP_PREFIX.length);
      else this.options.onOutput(line);
    });
    child.onMessage(value => {
      if (!isHostEvent(value)) return;
      if (value.type === "ready") { ready.resolve(); return; }
      if (value.type !== "result") { this.options.onEvent(value); return; }
      const settle = this.pending.get(value.id);
      this.pending.delete(value.id);
      settle?.(value);
    });
    child.onError(detail => { setup ??= detail; this.options.onOutput(detail); });
    child.onceExit(code => {
      if (this.child !== child) return;
      this.child = undefined;
      this.ready = undefined;
      this.launchFailure = setup;
      ready.reject(new Error("exited"));
      for (const [id, settle] of this.pending) settle({ type: "result", id, ok: false, error: { code: "failed", message: "The host process exited before it answered." } });
      this.pending.clear();
      this.options.onExit(code, this.stopping || setup !== undefined);
    });
    return ready.promise;
  }

  async request(message: Request): Promise<HostResult> {
    this.ready ??= this.spawn();
    const starting = this.ready;
    try { await starting; }
    catch {
      if (this.ready === starting) this.ready = undefined;
      const failure = this.launchFailure;
      return { type: "result", id: 0, ok: false, error: failure ? { code: "unsupported", message: failure } : { code: "failed", message: "The host process could not start." } };
    }
    const child = this.child!;
    const id = this.nextId++;
    const result = Promise.withResolvers<HostResult>();
    this.pending.set(id, result.resolve);
    child.postMessage({ ...message, id });
    return result.promise;
  }

  /** Stops the connector cleanly, then ends the process; a host that does not answer in time is killed. */
  async shutdown(timeoutMs: number): Promise<void> {
    const child = this.child;
    if (!child) return;
    this.stopping = true;
    const exited = Promise.withResolvers<void>();
    child.onceExit(() => exited.resolve());
    // terminate() sends SIGTERM (or ends stdin), which a host still stopping its connector waits out, so the deadline
    // kills outright. The connector's lease is released by its guardian process once the host's end of the pipe closes.
    const deadline = setTimeout(() => child.kill(), timeoutMs);
    void this.request({ type: "stop" }).then(() => child.terminate());
    await exited.promise;
    clearTimeout(deadline);
  }
}
