import { signal, Storage, untracked } from "nsh";
import type { ServerEvent, ServerInspection, ServerRequest, ServerStatus } from "../../../../packages/shared/src/app-server-protocol";
import { auth, restore } from "./auth";
import { CommandChannel, commandProblem, pikibunCommand, spawnPikibun, type CommandLink, type LaunchProblem, type LogLine } from "./pikibun-command";
import { computerName, computerTitle, hostsHere } from "./this-computer";

const SERVE_ARGS = ["serve", "--stdio"];
const SAVED_KEY = "pikibun.thisServer";
const LOG_LIMIT = 200;
const STOPPED: ServerStatus = { state: "stopped", host: "off" };

export const GITHUB_APP_PAGE = "https://github.com/settings/applications/new";
export const LOCAL_HOMEPAGE = "http://127.0.0.1";
export const LOCAL_CALLBACK = "http://127.0.0.1/api/auth/github/callback";

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
export interface GitHubApp { clientId: string; clientSecret: string }
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
    launch: () => launcher(), eventTypes: new Set(["ready", "result", "status", "log"]), problem: serverLaunchProblem, subject: "Pikibun",
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

  claimFor(origin: string): string | undefined {
    const status = this.status();
    return status.state === "running" && status.origin === origin ? status.claim : undefined;
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

  async start(github?: GitHubApp, resume?: { unsandboxedConsent: boolean }): Promise<Outcome> {
    if (untracked(this.status).state !== "stopped") return { ok: false, error: "Pikibun is already running on this computer." };
    const inspection = await this.refresh();
    if (!inspection) return this.refuse(untracked(this.problem) ? "" : untracked(this.error) || `${computerTitle} could not be inspected.`);
    if (!github && !inspection.githubClientId) return this.refuse("Add your GitHub OAuth app's client ID and secret first: Pikibun signs you in with it.");
    let unsandboxedConsent = false;
    if (inspection.hostMode === "unsandboxed" && !inspection.hostProblem) {
      unsandboxedConsent = resume ? resume.unsandboxedConsent : await this.confirmUnsandboxed(inspection.unsandboxedWarning ?? "");
      if (!unsandboxedConsent) {
        return this.refuse(resume ? `Pikibun was not started again: ${computerName} runs your sessions unsandboxed, which needs your consent. Start it to review it.`
          : "Running sessions without a sandbox was not confirmed; nothing was started.");
      }
    }
    this.error.set("");
    const result = await this.channel.request({ type: "start", ...(github ? { github: { clientId: github.clientId, clientSecret: github.clientSecret } } : {}),
      ...(unsandboxedConsent ? { unsandboxedConsent: true } : {}) });
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
    const outcome = await this.start(undefined, resume);
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
