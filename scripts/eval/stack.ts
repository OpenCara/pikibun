import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdir, realpath } from "node:fs/promises";
import { createServer } from "node:net";
import { delimiter, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { createConnector } from "../../apps/runner/src/connector.js";
import type { LocalModels } from "../../apps/runner/src/local-pi.js";
import type { ExtensionSettings } from "../../packages/shared/src/host-extensions.js";
import type { ChatOptions, ModelDefinition, SessionView } from "../../packages/shared/src/types.js";

export interface EvalExtension { source: string; settings?: ExtensionSettings }

export interface StackOptions {
  directory: string;
  localModels: LocalModels;
  allowFaux?: boolean;
  model?: { provider: string; modelId: string };
  path?: readonly string[];
  log?: (line: string) => void;
}

export interface EvalSession { id: string; worktree: string }

export interface EvalStack {
  origin: string;
  model: { provider: string; modelId: string };
  workspace(extensions: readonly EvalExtension[]): Promise<string>;
  session(workspaceId: string, title: string): Promise<EvalSession>;
  submit(sessionId: string, content: string, options?: ChatOptions): Promise<void>;
  view(sessionId: string): Promise<SessionView>;
  settle(sessionId: string, timeoutMs: number): Promise<{ view: SessionView; timedOut: boolean }>;
  stopSession(sessionId: string): Promise<void>;
  stop(): Promise<void>;
}

const repository = fileURLToPath(new URL("../../", import.meta.url));
const secret = () => Buffer.from(randomBytes(32)).toString("base64url");
const active = ["queued", "admitting", "running"];

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      probe.close(() => typeof address === "object" && address ? resolve(address.port) : reject(new Error("No free port")));
    });
  });
}

export function settled(view: SessionView): boolean {
  return !view.busy && !(view.queue ?? []).some(item => active.includes(item.status));
}

export async function startStack(options: StackOptions): Promise<EvalStack> {
  const log = options.log ?? (() => {});
  const port = await freePort();
  const origin = `http://127.0.0.1:${port}`;
  const testSecret = secret();
  const state = join(options.directory, "server");
  await mkdir(join(state, "backups"), { recursive: true });
  const previousPath = process.env.PATH;
  if (options.path?.length) process.env.PATH = [...options.path, previousPath ?? ""].filter(Boolean).join(delimiter);
  let server: ChildProcess | undefined;
  let stopHost = async () => {};
  let output = "";

  async function stop(): Promise<void> {
    await stopHost().catch(() => {});
    if (server?.pid && server.exitCode === null) {
      const exited = new Promise<void>(resolve => server!.once("exit", () => resolve()));
      try { process.kill(-server.pid, "SIGTERM"); } catch { server.kill("SIGTERM"); }
      await Promise.race([exited, delay(5_000)]);
    }
    if (options.path?.length) process.env.PATH = previousPath;
  }

  try {
    server = spawn(process.execPath, ["--import", "tsx", "apps/server/src/main.ts"], { cwd: repository, detached: true, stdio: ["ignore", "pipe", "pipe"], env: {
      ...process.env, DATABASE_URL: `sqlite://${join(state, "pikibun.sqlite")}`, STORAGE_URL: `file://${join(state, "backups")}`,
      APP_ORIGIN: origin, HOST: "127.0.0.1", PORT: String(port), TRUST_PROXY: "false", RUNNER_URL: "",
      TEST_AUTH_ENABLED: "true", TEST_AUTH_SECRET: testSecret, TEST_AUTH_EXPIRES_AT: new Date(Date.now() + 24 * 3600_000).toISOString(),
      SESSION_SECRET: secret(), RUNNER_SHARED_SECRET: secret(), VAULT_KEY: secret(), STATIC_DIR: join(repository, "dist", "client"),
    } });
    const keep = (chunk: Buffer) => { output = (output + chunk.toString()).slice(-4000); };
    server.stdout!.on("data", keep);
    server.stderr!.on("data", keep);
    for (const deadline = Date.now() + 120_000; ;) {
      if (server.exitCode !== null) throw new Error(`The eval's Pikibun server exited during start-up:\n${output}`);
      const health = await fetch(`${origin}/api/health`).then(response => response.json() as Promise<{ testMode?: boolean }>).catch(() => undefined);
      if (health?.testMode) break;
      if (Date.now() > deadline) throw new Error(`The eval's Pikibun server did not start:\n${output}`);
      await delay(200);
    }
    log(`Pikibun server for the eval at ${origin}`);
    const signIn = await fetch(`${origin}/api/auth/test`, { method: "POST",
      body: JSON.stringify({ id: "eval", client: "native", deviceName: "Eval", displayName: "Eval", gitName: "Eval Owner", gitEmail: "eval@example.test" }),
      headers: { Authorization: `Bearer ${testSecret}`, "Content-Type": "application/json" } });
    if (!signIn.ok) throw new Error(`The eval's test sign-in failed (${signIn.status})`);
    const { token } = await signIn.json() as { token: string };
    const api = async <T>(method: string, path: string, body?: unknown): Promise<T> => {
      const response = await fetch(`${origin}${path}`, { method, body: body === undefined ? undefined : JSON.stringify(body),
        headers: { Authorization: `Bearer ${token}`, ...(body === undefined ? {} : { "Content-Type": "application/json" }) } });
      const text = await response.text();
      let value: unknown;
      try { value = JSON.parse(text); } catch { value = { error: text.slice(0, 300) }; }
      if (!response.ok) throw new Error(`${method} ${path} failed (${response.status}): ${JSON.stringify((value as { error?: unknown; message?: unknown }).message ?? (value as { error?: unknown }).error ?? "")}`);
      return value as T;
    };
    const { pairing } = await api<{ pairing: { id: string; code: string } }>("POST", "/api/connectors/pairings", { name: "Eval host" });
    const dataDir = join(await realpath(options.directory), "host");
    const host = createConnector({
      server: origin, dataDir, pairing: { id: pairing.id, code: pairing.code }, localModels: options.localModels,
      allowFaux: options.allowFaux === true, allowInsecureLoopback: true, unsandboxed: true,
      capabilities: { platform: process.platform, sandbox: false, productionShell: false },
    });
    stopHost = () => host.stop();
    await host.start();
    log("The eval's host is connected (unsandboxed)");
    const workspaces = new Map<string, Promise<string>>();
    let chosen: ModelDefinition | undefined;

    async function workspace(extensions: readonly EvalExtension[]): Promise<string> {
      const key = JSON.stringify([...extensions].sort((a, b) => a.source.localeCompare(b.source)));
      let made = workspaces.get(key);
      if (!made) {
        made = (async () => {
          const { workspace: created } = await api<{ workspace: { id: string } }>("POST", "/api/workspaces", { name: `Eval ${workspaces.size + 1}` });
          for (const extension of extensions) {
            await api("PUT", `/api/workspaces/${created.id}/extensions`, { source: extension.source, enabled: true, tools: "automatic", settings: extension.settings ?? {} });
          }
          return created.id;
        })();
        workspaces.set(key, made);
      }
      return made;
    }

    async function session(workspaceId: string, title: string): Promise<EvalSession> {
      const { models } = await api<{ models: ModelDefinition[] }>("GET", `/api/workspaces/${workspaceId}/models`);
      const model = options.model ? models.find(item => item.provider === options.model!.provider && item.modelId === options.model!.modelId) : models[0];
      if (!model) throw new Error(`The eval's host offers no model${options.model ? ` ${options.model.provider}/${options.model.modelId}` : ""}: it offers ${models.map(item => `${item.provider}/${item.modelId}`).join(", ") || "none"}`);
      chosen = model;
      const { session: created } = await api<{ session: { id: string } }>("POST", "/api/sessions", { workspaceId, modelId: model.id, title });
      await settle(created.id, 120_000);
      return { id: created.id, worktree: join(dataDir, "runner", "sessions", created.id, "sandbox", "worktree") };
    }

    async function view(sessionId: string): Promise<SessionView> {
      return (await api<{ view: SessionView }>("GET", `/api/sessions/${sessionId}/view`)).view;
    }

    async function settle(sessionId: string, timeoutMs: number): Promise<{ view: SessionView; timedOut: boolean }> {
      let last: SessionView | undefined;
      for (const deadline = Date.now() + timeoutMs; ;) {
        const current = await view(sessionId).catch(() => undefined);
        if (current) last = current;
        if (current && settled(current)) return { view: current, timedOut: false };
        if (Date.now() > deadline) {
          if (!last) throw new Error("The session's view could not be read");
          return { view: last, timedOut: true };
        }
        await delay(250);
      }
    }

    return {
      origin, workspace, session, view, settle, stop,
      get model() { return chosen ? { provider: chosen.provider, modelId: chosen.modelId } : options.model ?? { provider: "", modelId: "" }; },
      async submit(sessionId, content, chat) {
        await api("POST", `/api/sessions/${sessionId}/submit`, { content, requestId: randomBytes(8).toString("hex"), ...(chat ? { options: chat } : {}) });
      },
      async stopSession(sessionId) { await api("POST", `/api/sessions/${sessionId}/stop`, {}).catch(() => {}); },
    };
  } catch (error) {
    await stop();
    throw error;
  }
}
