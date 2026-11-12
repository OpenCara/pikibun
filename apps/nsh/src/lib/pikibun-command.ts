import { platform } from "nsh";
import { homedir } from "os";
import nshProcess from "process";

const STDIO_FRAME = "\u001epikibun ";
const SHELLS = ["zsh", "bash", "sh"];
const CMD = "cmd";
const CLI_FOLDER = "cli";
export const INSTALL_COMMAND = "npm install -g pikibun@latest";

export function loginShell(os: string, shell: string | undefined): string {
  const name = shell?.split("/").pop();
  return name && SHELLS.includes(name) ? name : os === "macos" ? "zsh" : "bash";
}

const shellWord = (text: string) => `'${text.replace(/'/g, "'\\''")}'`;

export function appCliFolder(os: string, dataDir: string | null | undefined): string | null {
  if (!dataDir) return null;
  const separator = os === "windows" ? "\\" : "/";
  return `${dataDir.replace(/[\\/]+$/, "")}${separator}${CLI_FOLDER}`;
}

export function pikibunCommand(os: string, shell: string | undefined, cli: string | null | undefined, args: readonly string[]): { command: string; args: string[] } {
  if (os === "windows") {
    if (!cli) return { command: CMD, args: ["/d", "/c", "pikibun", ...args] };
    const own = `${CLI_FOLDER}\\node_modules\\.bin\\pikibun.cmd`;
    return { command: CMD, args: ["/d", "/c", "if", "exist", own, "(", own, ...args, ")", "else", "pikibun", ...args] };
  }
  const path = cli ? `PATH=${shellWord(`${cli}/node_modules/.bin`)}:"$PATH"; export PATH; ` : "";
  return { command: loginShell(os, shell), args: ["-ilc", `${path}exec pikibun ${args.join(" ")}`] };
}

export function installCommand(os: string, shell: string | undefined, cli?: string | null): { command: string; args: string[]; line: string } {
  const own = ["npm", "install", "--prefix", os === "windows" ? CLI_FOLDER : cli ?? "", "--no-audit", "--no-fund", "pikibun@latest"];
  if (os === "windows") {
    const words = cli ? own : INSTALL_COMMAND.split(" ");
    return { command: CMD, args: ["/d", "/c", ...words], line: words.join(" ") };
  }
  const line = cli ? own.map((word, index) => (index === 3 ? shellWord(word) : word)).join(" ") : INSTALL_COMMAND;
  return { command: loginShell(os, shell), args: ["-ilc", line], line };
}

export function commandDirectory(): string | undefined {
  if (nshProcess.dataDir) return undefined;
  try { return homedir(); } catch { return undefined; }
}

export interface CommandLink {
  send(message: object): void;
  onMessage(listener: (value: unknown) => void): void;
  onOutput(listener: (line: string) => void): void;
  onExit(listener: (result: { code?: number | null; error?: string | null }) => void): void;
  end(): void;
  kill(): void;
}

export function spawnPikibun(args: readonly string[]): CommandLink {
  const { command, args: words } = pikibunCommand(platform.os, nshProcess.env.SHELL, appCliFolder(platform.os, nshProcess.dataDir), args);
  const cwd = commandDirectory();
  const child = nshProcess.spawn(command, words, { stdin: "pipe", lines: true, ...(cwd ? { cwd } : {}) });
  const messages: ((value: unknown) => void)[] = [];
  const output: ((line: string) => void)[] = [];
  const say = (line: string) => { if (line.trim()) for (const listener of output) listener(line.slice(0, 1000)); };
  child.on("stdout", line => {
    if (!line.startsWith(STDIO_FRAME)) { say(line); return; }
    let value: unknown;
    try { value = JSON.parse(line.slice(STDIO_FRAME.length)); } catch { say("Pikibun's command sent a malformed message."); return; }
    for (const listener of messages) listener(value);
  });
  child.on("stderr", say);
  return {
    send: message => { try { child.write(`${JSON.stringify(message)}\n`); } catch { } },
    onMessage: listener => { messages.push(listener); },
    onOutput: listener => { output.push(listener); },
    onExit: listener => { child.on("exit", result => listener(result)); },
    end: () => { try { child.end(); } catch { } },
    kill: () => { try { child.kill(); } catch { } },
  };
}

export type LaunchProblem =
  | { kind: "missing" }
  | { kind: "outdated" }
  | { kind: "failed"; message: string };

export function commandProblem(lines: readonly string[], code: number | null | undefined, outdated: RegExp, subject: string): LaunchProblem {
  const text = lines.join("\n");
  if (outdated.test(text)) return { kind: "outdated" };
  if (code === 127 || code === 9009 || /pikibun: (command )?not found|not found: pikibun|'pikibun' is not recognized/i.test(text)) return { kind: "missing" };
  const node = lines.find(line => line.startsWith("pikibun needs Node.js"));
  if (node) return { kind: "failed", message: `${node} Install Node.js 24 (from https://nodejs.org, or nvm install 24), then choose Refresh.` };
  const last = lines.filter(line => line.trim()).slice(-3).join(" ");
  return { kind: "failed", message: last ? `${subject} could not start: ${last}` : `${subject} could not start (exit code ${code ?? "unknown"}).` };
}

export interface LogLine { time: number; level: "info" | "warning" | "error"; message: string }

type Result<Event> = Extract<Event, { type: "result" }>;
type Request<R> = R extends unknown ? Omit<R, "id"> : never;

export interface ChannelOptions<Event extends { type: string }> {
  launch(): CommandLink;
  before?(): Promise<void>;
  eventTypes: ReadonlySet<string>;
  problem(lines: readonly string[], code: number | null | undefined): LaunchProblem;
  failure(id: number, message: string, notReady: boolean): Result<Event>;
  subject: string;
  onEvent(event: Exclude<Event, Result<Event> | { type: "ready" }>): void;
  onOutput(line: string): void;
  onExit(code: number | null | undefined, expected: boolean): void;
}

export class CommandChannel<Event extends { type: string }, Req extends { id: number }> {
  private link?: CommandLink;
  private ready?: Promise<void>;
  private readonly pending = new Map<number, (result: Result<Event>) => void>();
  private nextId = 1;
  private stopping = false;
  private problem?: LaunchProblem;
  private waiting?: Promise<void>;
  private starts = 0;

  constructor(private readonly options: ChannelOptions<Event>) {}

  get running(): boolean { return this.link !== undefined; }

  private isEvent(value: unknown): value is Event {
    return typeof value === "object" && value !== null && "type" in value && typeof value.type === "string" && this.options.eventTypes.has(value.type);
  }

  private spawn(): Promise<void> {
    this.problem = undefined;
    let link: CommandLink;
    try { link = this.options.launch(); }
    catch (error) {
      this.problem = { kind: "failed", message: `${this.options.subject} could not be started: ${error instanceof Error ? error.message : String(error)}` };
      return Promise.reject(error);
    }
    this.link = link;
    this.stopping = false;
    let isReady = false;
    let settled = false;
    const early: string[] = [];
    return new Promise<void>((resolve, reject) => {
      link.onOutput(line => {
        if (isReady) { this.options.onOutput(line); return; }
        early.push(line);
        if (early.length > 40) early.shift();
      });
      link.onMessage(value => {
        if (!this.isEvent(value)) return;
        if (value.type === "ready") { isReady = true; settled = true; resolve(); return; }
        if (value.type !== "result") { this.options.onEvent(value as Exclude<Event, Result<Event> | { type: "ready" }>); return; }
        const result = value as Result<Event> & { id: number };
        const settle = this.pending.get(result.id);
        this.pending.delete(result.id);
        settle?.(result);
      });
      link.onExit(result => {
        if (this.link !== link) return;
        this.link = undefined;
        this.ready = undefined;
        if (!isReady) this.problem = this.options.problem(early, result.code);
        if (!settled) { settled = true; reject(new Error("exited")); }
        for (const [id, settle] of this.pending) settle(this.options.failure(id, `${this.options.subject} exited before it answered.`, false));
        this.pending.clear();
        this.options.onExit(result.code, this.stopping || !isReady);
      });
    });
  }

  private async start(): Promise<void> {
    const start = ++this.starts;
    if (this.options.before) {
      const waiting = this.options.before().catch(() => undefined);
      this.waiting = waiting;
      try { await waiting; } finally { if (this.waiting === waiting) this.waiting = undefined; }
      if (start !== this.starts) throw new Error("stopped");
    }
    return this.spawn();
  }

  get launchFailure(): LaunchProblem | undefined { return this.problem; }

  async request(message: Request<Req>, sent?: (id: number) => void): Promise<Result<Event>> {
    this.ready ??= this.start();
    const starting = this.ready;
    try { await starting; }
    catch {
      if (this.ready === starting) this.ready = undefined;
      const problem = this.problem;
      return this.options.failure(0, problem?.kind === "failed" ? problem.message : "The pikibun command isn't ready on this computer.", true);
    }
    const link = this.link!;
    const id = this.nextId++;
    const result = new Promise<Result<Event>>(resolve => this.pending.set(id, resolve));
    sent?.(id);
    link.send({ ...message, id });
    return result;
  }

  async shutdown(timeoutMs = 10_000): Promise<void> {
    const link = this.link;
    if (!link) {
      const waiting = this.waiting;
      this.starts++;
      this.ready = undefined;
      if (!waiting) return;
      let deadline: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([waiting, new Promise<void>(resolve => { deadline = setTimeout(resolve, timeoutMs); })]);
      clearTimeout(deadline);
      return;
    }
    this.stopping = true;
    const exited = new Promise<void>(resolve => link.onExit(() => resolve()));
    const deadline = setTimeout(() => link.kill(), timeoutMs);
    void this.request({ type: "stop" } as unknown as Request<Req>).then(() => link.end());
    await exited;
    clearTimeout(deadline);
  }
}
