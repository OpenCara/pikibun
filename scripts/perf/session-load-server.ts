/**
 * Measures what the NSH desktop client waits for when it opens a session, against a real server and a real connector host
 * on this machine (as `pnpm dev:native` runs them, the host offering the deterministic fixture model): the requests it
 * made in order before (GET /api/sessions/:id, GET /view, then the first event of /events: shownMs), and at once now
 * (the metadata beside /events, whose first event is the whole view: atOnceShownMs), with its bearer token, as the
 * session's transcript grows.
 *
 *   node --import tsx scripts/perf/session-load-server.ts [--port 8799] [--turns 25,125] [--cold]
 *
 * Each turn adds 4 entries (the message, the tool call, a 4 KB tool result, the reply), until the host compacts the
 * conversation: views hold only the transcript since the last compaction. --cold also measures a first open after the
 * server dropped the session's feed (nobody read it for a minute), which costs a minute's wait per size.
 *
 * Everything runs on this machine, so this is the server's and the host's own work without network; see
 * nsh-session-load.test.tsx for the client's, with network delays.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { createConnector } from "../../apps/runner/src/connector.js";
import { createFauxLocalModels } from "../../apps/runner/src/local-pi.js";

const { values } = parseArgs({ options: { port: { type: "string", default: "8799" }, turns: { type: "string", default: "25,125" }, cold: { type: "boolean" } } });
const repository = fileURLToPath(new URL("../../", import.meta.url));
const origin = `http://127.0.0.1:${Number(values.port)}`;
const secret = () => Buffer.from(randomBytes(32)).toString("base64url");
const testSecret = secret();
const temporary = await realpath(await mkdtemp(join(tmpdir(), "pikibun-perf-")));
let server: ChildProcess | undefined;
let stopHost = async () => {};

const median = (list: number[]) => [...list].sort((a, b) => a - b)[Math.floor(list.length / 2)]!;

try {
  await mkdir(join(temporary, "backups"));
  server = spawn(process.execPath, ["--import", "tsx", "apps/server/src/main.ts"], { cwd: repository, detached: true, stdio: ["ignore", "ignore", "inherit"], env: {
    ...process.env, DATABASE_URL: `sqlite://${join(temporary, "pikibun.sqlite")}`, STORAGE_URL: `file://${join(temporary, "backups")}`,
    APP_ORIGIN: origin, HOST: "127.0.0.1", PORT: String(Number(values.port)), TRUST_PROXY: "false", RUNNER_URL: "",
    TEST_AUTH_ENABLED: "true", TEST_AUTH_SECRET: testSecret, TEST_AUTH_EXPIRES_AT: new Date(Date.now() + 24 * 3600_000).toISOString(),
    SESSION_SECRET: secret(), RUNNER_SHARED_SECRET: secret(), VAULT_KEY: secret(), STATIC_DIR: join(repository, "dist", "web"),
  } });
  for (const deadline = Date.now() + 90_000; ;) {
    if (server.exitCode !== null) throw new Error("The server exited during start-up");
    const health = await fetch(`${origin}/api/health`).then(response => response.json() as Promise<{ testMode?: boolean }>).catch(() => undefined);
    if (health?.testMode) break;
    if (Date.now() > deadline) throw new Error("The server did not start");
    await delay(200);
  }
  // The desktop app's sign-in: a native bearer token.
  const native = await fetch(`${origin}/api/auth/test`, { method: "POST", body: JSON.stringify({ id: "dev", client: "native", deviceName: "Perf" }),
    headers: { Authorization: `Bearer ${testSecret}`, "Content-Type": "application/json" } }).then(response => response.json() as Promise<{ token: string }>);
  const api = async <T>(method: string, path: string, body?: unknown): Promise<T> => {
    const response = await fetch(`${origin}${path}`, { method, body: body === undefined ? undefined : JSON.stringify(body),
      headers: { Authorization: `Bearer ${native.token}`, ...(body === undefined ? {} : { "Content-Type": "application/json" }) } });
    const value = await response.json() as T & { error?: unknown };
    if (!response.ok) throw new Error(`${method} ${path} failed (${response.status}): ${JSON.stringify(value.error ?? "")}`);
    return value;
  };
  const { workspace } = await api<{ workspace: { id: string } }>("POST", "/api/workspaces", { name: "Perf workspace" });
  const { pairing } = await api<{ pairing: { id: string; code: string } }>("POST", "/api/connectors/pairings", { name: "Fixture host" });
  const host = createConnector({
    server: origin, dataDir: join(temporary, "connector"), pairing: { id: pairing.id, code: pairing.code },
    localModels: createFauxLocalModels("faux-1"), allowFaux: true, allowTestShell: true, allowInsecureLoopback: true,
    unsandboxed: true, capabilities: { platform: process.platform, sandbox: false, productionShell: false },
  });
  stopHost = () => host.stop();
  await host.start();
  const { models } = await api<{ models: { id: string }[] }>("GET", `/api/workspaces/${workspace.id}/models`);
  const { session } = await api<{ session: { id: string } }>("POST", "/api/sessions", { workspaceId: workspace.id, modelId: models[0]!.id, title: "Perf session" });
  const base = `/api/sessions/${session.id}`;

  type View = { entries: unknown[]; busy: boolean; queue?: { status: string }[] };
  const idle = async () => {
    for (const deadline = Date.now() + 600_000; ;) {
      const { view } = await api<{ view: View }>("GET", `${base}/view`).catch(() => ({ view: null as View | null }));
      if (view && !view.busy && !(view.queue ?? []).some(item => ["queued", "admitting", "running"].includes(item.status))) return view;
      if (Date.now() > deadline) throw new Error("The session did not settle");
      await delay(150);
    }
  };
  await idle();
  // A 4 KB file each turn reads: its output is the tool result, and the fixture model echoes it in its reply.
  const content = Array.from({ length: 50 }, (_, line) => `src/module-${line}.ts:${line + 1}: export function step${line}(input) { return input.trim(); }`).join("\n");
  await api("POST", `${base}/submit`, { content: `TEST_WRITE notes.txt\n${content}`, requestId: randomBytes(8).toString("hex") });
  await idle();

  /** One open of the session, as the client does it: metadata, then the view, then the stream's first event. */
  async function openOnce() {
    const started = performance.now();
    await api("GET", base);
    const meta = performance.now() - started;
    const viewStart = performance.now();
    const response = await fetch(`${origin}${base}/view`, { headers: { Authorization: `Bearer ${native.token}` } });
    const text = await response.text();
    const viewMs = performance.now() - viewStart;
    const { view, revision } = JSON.parse(text) as { view: View; revision: string };
    const shown = performance.now() - started;
    const eventsStart = performance.now();
    const controller = new AbortController();
    const events = await fetch(`${origin}${base}/events?since=${revision}`, { headers: { Authorization: `Bearer ${native.token}` }, signal: controller.signal });
    const reader = events.body!.getReader();
    let firstEvent = Number.NaN;
    for (let buffered = ""; ;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffered += Buffer.from(value).toString();
      if (/\nevent: (view|patch)\n|^event: (view|patch)\n/.test(buffered)) { firstEvent = performance.now() - eventsStart; break; }
    }
    controller.abort();
    return { entries: view.entries.length, viewKB: Math.round(text.length / 1024), meta, viewMs, shown, firstEvent };
  }

  /** One open as the client does it now: the metadata and the stream at once, the stream's first snapshot the whole view. */
  async function openAtOnce() {
    const started = performance.now();
    const controller = new AbortController();
    const metadata = api("GET", base);
    const events = await fetch(`${origin}${base}/events?since=`, { headers: { Authorization: `Bearer ${native.token}` }, signal: controller.signal });
    const reader = events.body!.getReader();
    let snapshot: { view?: View; revision?: string } | undefined;
    for (let buffered = ""; ;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffered += Buffer.from(value).toString();
      const event = /(?:^|\n)event: view\ndata: ([^\n]*)\n\n/.exec(buffered);
      if (event) { snapshot = JSON.parse(event[1]!); break; }
    }
    controller.abort();
    await metadata;
    if (!snapshot?.view || !snapshot.revision) throw new Error("The stream's first event was not a whole view with its revision");
    return { entries: snapshot.view.entries.length, shown: performance.now() - started };
  }

  let turns = 0;
  const round = (value: number) => Math.round(value);
  for (const target of values.turns.split(",").map(Number)) {
    // Many at a time: the host queues them, and each runs in turn.
    while (turns < target) {
      const batch = Math.min(25, target - turns);
      for (let index = 0; index < batch; index++) await api("POST", `${base}/submit`, { content: "TEST_READ notes.txt", requestId: randomBytes(8).toString("hex") });
      turns += batch;
      await idle();
    }
    let cold: Awaited<ReturnType<typeof openOnce>> | undefined;
    if (values.cold) {
      await delay(61_000);
      cold = await openOnce();
    }
    const warm = [];
    const atOnce = [];
    for (let run = 0; run < 7; run++) {
      warm.push(await openOnce());
      await delay(1_100);
      atOnce.push(await openAtOnce());
      if (atOnce.at(-1)!.entries !== warm.at(-1)!.entries) throw new Error("The stream's view differs from GET /view's");
      await delay(1_100);
    }
    const result = {
      turns, entries: warm[0]!.entries, viewKB: warm[0]!.viewKB,
      ...(cold ? { coldMetaMs: round(cold.meta), coldViewMs: round(cold.viewMs), coldShownMs: round(cold.shown) } : {}),
      metaMs: round(median(warm.map(item => item.meta))), viewMs: round(median(warm.map(item => item.viewMs))),
      shownMs: round(median(warm.map(item => item.shown))), eventsFirstMs: round(median(warm.map(item => item.firstEvent))),
      atOnceShownMs: round(median(atOnce.map(item => item.shown))),
    };
    console.log(`PERF ${JSON.stringify(result)}`);
  }
} finally {
  await stopHost().catch(() => {});
  if (server?.pid && server.exitCode === null) {
    try { process.kill(-server.pid, "SIGTERM"); } catch { /* Already gone. */ }
    await delay(500);
  }
  await rm(temporary, { recursive: true, force: true });
}
