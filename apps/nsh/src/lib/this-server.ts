import { signal, Storage, untracked } from "nsh";
import type { ServerEvent, ServerInspection, ServerRequest, ServerStatus } from "../../../../packages/shared/src/app-server-protocol";
import { auth, restore, servers, signInToLocalServer, switchServer } from "./auth";
import { CommandChannel, commandProblem, pikibunCommand, spawnPikibun, type CommandLink, type LaunchProblem, type LogLine } from "./pikibun-command";
import { computerName, computerTitle, hostsHere, thisComputer } from "./this-computer";

const SERVE_ARGS = ["serve", "--stdio"];
const SAVED_KEY = "pikibun.thisServer";
const LOG_LIMIT = 200;
const STOPPED: ServerStatus = { state: "stopped", host: "off" };
const OLD_COMMAND = /^Add your GitHub OAuth app first/;

export function serverCommand(os: string, shell: string | undefined, cli?: string | null): { command: string; args: string[] } {
  return pikibunCommand(os, shell, cli, SERVE_ARGS);
}

export type ServerLauncher = () => CommandLink;
export const spawnServer: ServerLauncher = () => spawnPikibun(SERVE_ARGS);

let launcher: ServerLauncher = spawnServer;
export function setServerLauncher(next: ServerLauncher): void { launcher = next; }

export function serverLaunchProblem(lines: readonly string[], code: number | null | undefined): LaunchProblem {
  return commandProblem(lines, code, /Unknown command: serve|Unknown option '--stdio'|Pikibun failed\. Check --help/, "Pikibun");
}

export interface Outcome { ok: boolean; error?: string }
interface Saved { resume?: { unsandboxedConsent: boolean } }

export class ThisServer {
  readonly status = signal<ServerStatus>(STOPPED);
  readonly inspection = signal<ServerInspection | null>(null);
  readonly inspecting = signal(false);
  readonly problem = signal<LaunchProblem | null>(null);
  readonly error = signal("");
  readonly logs = signal<LogLine[]>([]);
  private resume: Saved["resume"];
  private loaded?: Promise<void>;
  private readonly channel = new CommandChannel<ServerEvent, ServerRequest>({
    launch: () => launcher(), before: () => thisComputer().commandUpdated(), eventTypes: new Set(["ready", "result", "status", "log"]), problem: serverLaunchProblem, subject: "Pikibun",
    failure: (id, message) => ({ type: "result", id, ok: false, error: { message } }),
    onEvent: event => {
      if (event.type === "log") { this.log(event.level, event.message); return; }
      const { type: _type, ...status } = event;
      this.status.set(status);
    },
    onOutput: line => this.log("info", line),
    onExit: (code, expected) => {
      const wasRunning = untracked(this.status).state !== "stopped";
      this.status.set(STOPPED);
      if (!expected && wasRunning) this.fail(`Pikibun on ${computerName} stopped unexpectedly (code ${code ?? "unknown"}). Start it again when ready.`);
    },
  });

  constructor(private readonly confirmUnsandboxed: (warning: string) => Promise<boolean>) {}

  running(): string | undefined {
    const status = this.status();
    return status.state === "running" ? status.origin : undefined;
  }

  signInTokenFor(origin: string): string | undefined {
    const status = this.status();
    return status.state === "running" && status.origin === origin ? status.signInToken : undefined;
  }

  requireSignInToken(origin: string): string {
    const token = untracked(() => this.signInTokenFor(origin));
    if (!token) throw new Error(`Pikibun on ${computerName} didn't give this app its sign-in token. Stop it and start it again here, updating pikibun if this page offers to.`);
    return token;
  }

  load(): Promise<void> {
    this.loaded ??= Storage.getItem(SAVED_KEY).then(raw => {
      if (!raw) return;
      const saved = JSON.parse(raw) as Saved;
      if (saved.resume) this.resume = { unsandboxedConsent: saved.resume.unsandboxedConsent === true };
    }).catch(() => undefined);
    return this.loaded;
  }

  private setResume(resume: Saved["resume"]): void {
    this.resume = resume;
    Storage.setItem(SAVED_KEY, JSON.stringify(resume ? { resume } : {})).catch(() => undefined);
  }

  log(level: LogLine["level"], message: string): void {
    this.logs.update(lines => [...lines, { time: Date.now(), level, message }].slice(-LOG_LIMIT));
  }

  private fail(message: string): void {
    if (this.resume) this.setResume(undefined);
    this.error.set(message);
    this.log("error", message);
  }

  private refuse(error: string): Outcome {
    return { ok: false, error: error || undefined };
  }

  async refresh(): Promise<ServerInspection | undefined> {
    this.inspecting.set(true);
    try {
      const result = await this.channel.request({ type: "inspect" });
      const problem = this.channel.launchFailure;
      this.problem.set(!result.ok && problem ? problem : null);
      if (result.ok && result.inspection) this.inspection.set(result.inspection);
      else if (!result.ok && !problem) this.error.set(result.error.message);
      return result.ok ? result.inspection : undefined;
    } finally {
      this.inspecting.set(false);
    }
  }

  async start(resume?: { unsandboxedConsent: boolean }): Promise<Outcome> {
    if (untracked(this.status).state !== "stopped") return { ok: false, error: "Pikibun is already running on this computer." };
    const inspection = await this.refresh();
    if (!inspection) return this.refuse(untracked(this.problem) ? "" : untracked(this.error) || `${computerTitle} could not be inspected.`);
    let unsandboxedConsent = false;
    if (inspection.hostMode === "unsandboxed" && !inspection.hostProblem) {
      unsandboxedConsent = resume ? resume.unsandboxedConsent : await this.confirmUnsandboxed(inspection.unsandboxedWarning ?? "");
      if (!unsandboxedConsent) {
        return this.refuse(resume ? `Pikibun was not started again: ${computerName} runs your sessions unsandboxed, which needs your consent. Start it to review it.`
          : "Running sessions without a sandbox was not confirmed; nothing was started.");
      }
    }
    this.error.set("");
    const result = await this.channel.request({ type: "start", ...(unsandboxedConsent ? { unsandboxedConsent: true } : {}) });
    if (!result.ok && OLD_COMMAND.test(result.error.message)) {
      this.problem.set({ kind: "outdated" });
      return this.refuse("");
    }
    if (!result.ok) return this.refuse(result.error.message);
    this.setResume({ unsandboxedConsent });
    void this.refresh();
    return { ok: true };
  }

  async stop(): Promise<Outcome> {
    this.setResume(undefined);
    if (!this.channel.running || untracked(this.status).state === "stopped") return { ok: true };
    const result = await this.channel.request({ type: "stop" });
    return result.ok ? { ok: true } : this.refuse(result.error.message);
  }

  async resumeServing(): Promise<Outcome | undefined> {
    await this.load();
    const resume = this.resume;
    if (!resume) return undefined;
    const outcome = await this.start(resume);
    if (!outcome.ok) this.fail(outcome.error ?? `Pikibun on ${computerName} could not start again: see Recent activity.`);
    return outcome;
  }

  shutdown(): Promise<void> { return this.channel.shutdown(); }
}

let shared: ThisServer | undefined;
let consent: (warning: string) => Promise<boolean> = async () => false;

export function setServerConsent(ask: typeof consent): void { consent = ask; }

export function thisServer(): ThisServer {
  shared ??= new ThisServer(warning => consent(warning));
  return shared;
}

const LOOPBACK = /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/;
export const onThisComputer = (origin: string): boolean => hostsHere && LOOPBACK.test(origin);

export async function signInToThisServer(options: { switching?: boolean } = {}): Promise<string> {
  const server = thisServer();
  await server.load();
  if (untracked(server.status).state === "stopped") {
    const outcome = await server.start();
    if (!outcome.ok) throw new Error(outcome.error ?? `Pikibun's command on ${computerName} has to be installed or updated before Pikibun can start.`);
  }
  for (let tries = 0; tries < 120 && untracked(server.status).state === "starting"; tries++) await new Promise(resolve => setTimeout(resolve, 250));
  const origin = untracked(() => server.running());
  if (!origin) throw new Error(untracked(server.error) || `Pikibun on ${computerName} didn't start: see its Recent activity.`);
  if (options.switching && untracked(servers).some(item => item.origin === origin)) {
    try {
      await switchServer(origin);
      return origin;
    } catch {
      // The saved sign-in no longer works: sign in again with the server's own token.
    }
  }
  await signInToLocalServer(origin, server.requireSignInToken(origin), options);
  return origin;
}

export function resumeThisServer(): void {
  if (!hostsHere) return;
  void thisServer().resumeServing().then(async outcome => {
    const origin = thisServer().running();
    if (!outcome?.ok || !origin) return;
    for (let tries = 0; tries < 40 && auth().status === "loading"; tries++) await new Promise(resolve => setTimeout(resolve, 250));
    const state = auth();
    if (state.status === "unreachable" && state.origin === origin) await restore();
  });
}
