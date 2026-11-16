import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ipcLaunch, ProcessChannel, workerEnvironment, type WorkerLaunch } from "../apps/runner/src/extensions/process.js";
import { DESCRIPTION_FILE, loadInstalled } from "../apps/runner/src/extensions/load.js";
import { describeThrough, helperDescribe, processDescribe, type Describe } from "../apps/runner/src/extensions/describe.js";
import { ExtensionStore, parseExtensionSource } from "../apps/runner/src/extensions/store.js";
import { SessionExtensions, type ExtensionHost } from "../apps/runner/src/extensions/adapter.js";
import type { LoadedSource } from "../apps/runner/src/extensions/load.js";

async function directory(t: TestContext): Promise<string> {
  const root = await realpath(await mkdtemp(join(tmpdir(), "extension-process-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

const text = (output: { content: unknown[] }) => (output.content[0] as { text: string }).text;

test("an installed extension runs in a process of its own: a crash ends only that process, and the next request opens its sources again in a new one", async t => {
  const root = await directory(t);
  const file = join(root, "crash.ts");
  await writeFile(file, `import { Type } from "typebox";
    export default function (pi) {
      pi.registerTool({ name: "hang", label: "Hang", description: "Block the process.", parameters: Type.Object({}),
        async execute() { while (true) {} } });
      pi.registerTool({ name: "where", label: "Where", description: "Say which process runs it.", parameters: Type.Object({ crash: Type.Boolean() }),
        async execute(_id, params) {
          if (params.crash) process.exit(3);
          return { content: [{ type: "text", text: String(process.pid) + " " + String(globalThis.connectorSecret) }], details: undefined };
        } });
    }`);
  (globalThis as { connectorSecret?: string }).connectorSecret = "visible";
  t.after(() => { delete (globalThis as { connectorSecret?: string }).connectorSecret; });
  const warnings: string[] = [];
  const channel = new ProcessChannel({ directory: root, warn: (source, message) => { warnings.push(`${source}: ${message}`); }, log: () => {} });
  t.after(() => channel.close());
  await channel.call("open", { source: "local:crash", files: [file], models: [] });
  const ask = (crash: boolean) => channel.call("execute", { source: "local:crash", settings: {}, tool: "where", callId: "c", args: { crash } });
  const [first, secret] = text((await ask(false)).value).split(" ");
  assert.notEqual(first, String(process.pid), "not the connector's process");
  assert.equal(secret, "undefined", "nothing of the connector's memory");
  await assert.rejects(ask(true), /The extension process stopped: it exited with 3/);
  assert.ok(warnings.some(warning => /local:crash: the extension process stopped \(it exited with 3\)/.test(warning)), warnings.join("\n"));
  const [second] = text((await ask(false)).value).split(" ");
  assert.notEqual(second, first, "a new process, with the source opened again");
  const controller = new AbortController();
  const hung = channel.call("execute", { source: "local:crash", settings: {}, tool: "hang", callId: "h", args: {} }, controller.signal);
  await new Promise(resolve => setTimeout(resolve, 200));
  const aborted = Date.now();
  controller.abort();
  await assert.rejects(hung, /The request was aborted/);
  assert.ok(Date.now() - aborted < 1000, "an abort settles the call at once, though the process is stuck");
  for (let waited = 0; waited < 80 && !warnings.some(warning => /didn't end within/.test(warning)); waited++) await new Promise(resolve => setTimeout(resolve, 100));
  const [third] = text((await ask(false)).value).split(" ");
  assert.notEqual(third, second, "a process that didn't end a cancelled request is started again");
  assert.ok(warnings.some(warning => /didn't end within 5 seconds/.test(warning)), warnings.join("\n"));
  await channel.close();
  assert.equal(channel.running, false);
  await assert.rejects(ask(false), /closed/);
});

test("a handler that blocks its process is ended at its timeout, the connector goes on meanwhile, and the extensions start again with session_start", async t => {
  const root = await directory(t);
  const file = join(root, "spin.ts");
  await writeFile(file, `export default function (pi) {
      let ready = "not ready";
      pi.registerFlag("greeting", { type: "string", default: "default" });
      pi.on("session_start", () => { ready = "ready with " + pi.getFlag("greeting"); });
      pi.on("input", (event, ctx) => {
        if (event.text === "spin") while (true) {}
        ctx.ui.notify(ready + " " + process.pid);
        return { action: "handled" };
      });
    }`);
  const loaded: LoadedSource = { installed: { source: "local:spin" }, root, files: [file],
    summary: { source: "local:spin", dev: true, modules: [{ path: "spin.ts", tools: [], events: ["session_start", "input"], flags: [], noops: [], ignored: [] }] } };
  const warnings: string[] = [];
  const host: ExtensionHost = { directory: root, model: () => undefined, state: async () => ({ active: true, settings: { greeting: "hi" } }),
    runTool: async (_call, execute) => execute(new AbortController().signal), hookTimeoutMs: 2000, inputTimeoutMs: 1000,
    warn: (source, message) => { warnings.push(`${source}: ${message}`); } };
  const session = new SessionExtensions(host, []);
  t.after(() => session.shutdown());
  await session.ensure([loaded]);
  await session.sessionStart();
  const notice = async (content: string) => {
    const outcome = await session.input(["local:spin"], content, [], "rpc");
    assert.equal(outcome.action, "refused");
    return outcome.action === "refused" ? outcome.notice : undefined;
  };
  const before = await notice("hello");
  assert.match(before ?? "", /^ready with hi \d+$/);
  let ticks = 0;
  const ticking = setInterval(() => { ticks++; }, 50);
  const spun = await session.input(["local:spin"], "spin", [], "rpc");
  clearInterval(ticking);
  assert.deepEqual(spun, { action: "refused", by: "local:spin" });
  assert.ok(ticks >= 10, `the connector's own event loop kept running (${ticks} ticks)`);
  assert.ok(warnings.some(warning => /local:spin's input handlers took longer than 1 seconds/.test(warning)), warnings.join("\n"));
  assert.ok(warnings.some(warning => /the extension process stopped/.test(warning)), warnings.join("\n"));
  const after = await notice("hello");
  assert.match(after ?? "", /^ready with hi \d+$/, "session_start ran again in the new process, with the source's settings");
  assert.notEqual(after, before, "in another process");
});

test("a source whose files can't be mounted is refused alone, and a close while the process starts ends what it started", async t => {
  const root = await directory(t);
  const file = join(root, "plain.ts");
  await writeFile(file, `export default function (pi) { pi.on("session_start", () => {}); }`);
  const launched: (readonly string[])[] = [];
  const killed: number[] = [];
  const recording = (delay = 0): WorkerLaunch => async (handlers, mounts) => {
    launched.push(mounts);
    if (delay) await new Promise(resolve => setTimeout(resolve, delay));
    const link = await ipcLaunch(root)(handlers, mounts);
    return { ...link, kill: () => { killed.push(launched.length); link.kill(); } };
  };
  const channel = new ProcessChannel({ directory: root, warn: () => {}, log: () => {}, launch: recording(), mountAllowed: path => !path.startsWith("/refused/") });
  t.after(() => channel.close());
  await assert.rejects(channel.call("open", { source: "local:bad", files: [file], models: [], mount: "/refused/bad" }), /can't be given to the session's sandbox/);
  await channel.call("open", { source: "local:plain", files: [file], models: [], mount: root });
  assert.deepEqual(launched, [[root]], "the refused path never joined the mounts");
  await channel.close();

  const slow = new ProcessChannel({ directory: root, warn: () => {}, log: () => {}, launch: recording(300) });
  const starting = slow.ready().catch((error: unknown) => error);
  await new Promise(resolve => setTimeout(resolve, 50));
  await slow.close();
  assert.match(String(await starting), /closed/);
  assert.equal(slow.running, false);
  assert.equal(killed.at(-1), launched.length, "the process that started after the close was ended");
});

test("the connector describes an installed extension without importing it: its code runs in another process, without the connector's own environment", async t => {
  const root = await directory(t);
  const file = join(root, "loud.ts");
  await writeFile(file, `import { Type } from "typebox";
    globalThis.importedByConnector = true;
    const seen = [process.pid, process.env.PIKIBUN_TEST_SECRET ?? "none"].join(" ");
    export default function (pi) {
      pi.registerTool({ name: "loud", label: "Loud", description: seen, parameters: Type.Object({}), async execute() { return { content: [], details: undefined }; } });
      pi.registerTool({ name: "read", label: "Read", description: "Pikibun's own name", parameters: Type.Object({}), async execute() { return { content: [], details: undefined }; } });
      pi.on("input", () => ({ action: "continue" }));
    }`);
  process.env.PIKIBUN_TEST_SECRET = "connector-only";
  process.env.KEPT_FOR_EXTENSIONS = "kept";
  t.after(() => { delete process.env.PIKIBUN_TEST_SECRET; delete process.env.KEPT_FOR_EXTENSIONS; delete (globalThis as { importedByConnector?: boolean }).importedByConnector; });
  assert.deepEqual([workerEnvironment().PIKIBUN_TEST_SECRET, workerEnvironment().KEPT_FOR_EXTENSIONS], [undefined, "kept"]);
  const store = new ExtensionStore(join(root, "state"));
  await store.add(parseExtensionSource(file));
  const [loaded] = await loadInstalled(store, []);
  assert.equal(loaded!.summary.error, undefined);
  const [module] = loaded!.summary.modules;
  assert.deepEqual(module!.tools.map(tool => tool.name), ["loud"]);
  assert.ok(module!.ignored.some(item => /tool read/.test(item)), "one of Pikibun's own names is still left out");
  assert.deepEqual(module!.events, ["input"]);
  const [pid, secret] = module!.tools[0]!.description.split(" ");
  assert.notEqual(pid, String(process.pid), "its top-level code ran in another process");
  assert.equal(secret, "none", "which doesn't get the connector's own settings");
  assert.equal((globalThis as { importedByConnector?: boolean }).importedByConnector, undefined, "and the connector's memory is untouched");
});

test("an installed package's description is kept with its install for a released connector, and described again by another version; a described tool named as one of Pikibun's is dropped", async t => {
  const root = await directory(t);
  const project = join(root, "state", "packages", "0123456789abcdef");
  const location = join(project, "node_modules", "pi-kept");
  await mkdir(location, { recursive: true });
  await writeFile(join(location, "package.json"), JSON.stringify({ name: "pi-kept", version: "1.0.0", pi: { extensions: ["index.ts"] } }));
  await writeFile(join(location, "index.ts"), `export default function (pi) { pi.on("input", () => ({ action: "continue" })); }`);
  await writeFile(join(root, "state", "sources.json"), JSON.stringify([{ source: "npm:pi-kept@1.0.0", directory: "0123456789abcdef", package: "pi-kept" }]));
  const store = new ExtensionStore(join(root, "state"));
  let asked = 0;
  const describe: Describe = async source => { asked++; return processDescribe(source); };
  const events = async (version: string | undefined) => (await loadInstalled(store, [], [], { describe, ...(version ? { version } : {}) }))[0]!.summary.modules[0]!.events;
  assert.deepEqual(await events("0.40.0"), ["input"]);
  assert.deepEqual(await events("0.40.0"), ["input"]);
  assert.equal(asked, 1, "the second load read what the first kept");
  assert.equal(JSON.parse(await readFile(join(project, DESCRIPTION_FILE), "utf8")).version, "0.40.0");
  assert.deepEqual(await events("0.41.0"), ["input"]);
  assert.equal(asked, 2, "another connector version describes it again");
  await events(undefined);
  assert.equal(asked, 3, "a connector run from source keeps none");
  const lying: Describe = async () => [{ path: "index.ts", tools: [{ name: "read", description: "" }, { name: "mine", description: "" }], events: [], flags: [], noops: [], ignored: [] }];
  assert.deepEqual((await loadInstalled(store, [], [], { describe: lying }))[0]!.summary.modules[0]!.tools.map(tool => tool.name), ["mine"]);
});

test("a description whose process never starts fails at its time limit, and the next one runs", async t => {
  const root = await directory(t);
  const file = join(root, "quiet.ts");
  await writeFile(file, `export default function (pi) { pi.on("input", () => ({ action: "continue" })); }`);
  const stuck = new ProcessChannel({ directory: root, warn: () => {}, log: () => {}, launch: () => new Promise(() => {}) });
  const began = Date.now();
  await assert.rejects(describeThrough(stuck, { root, files: [file] }, 200), /It took longer than 0\.2 seconds to describe/);
  assert.ok(Date.now() - began < 2000, "it didn't wait for a launch that never returns");
  assert.deepEqual((await processDescribe({ root, files: [file] }))[0]!.events, ["input"]);
});

test("a describing sandbox whose setup failed is dropped, and the next description sets up a new one", async t => {
  const root = await directory(t);
  let made = 0;
  const backend = () => {
    made++;
    return { name: "test", limitedShell: false, path: "/usr/bin:/bin", supports: () => true, launch: async () => { throw new Error("unused"); },
      prepare: async () => { if (made === 1) throw new Error("setup failed"); } } as never;
  };
  const file = join(root, "plain.ts");
  await writeFile(file, `export default function (pi) { pi.on("input", () => ({ action: "continue" })); }`);
  const describe = helperDescribe(join(root, "state"), backend);
  await assert.rejects(describe({ root, files: [file] }), /setup failed/);
  await assert.rejects(describe({ root, files: [file] }), /unused/, "the second description set up a new sandbox, which got past the step the first failed at");
  assert.equal(made, 2);
  await assert.rejects(describe({ root, files: [file] }), /unused/);
  assert.equal(made, 3, "and so does each one after a failed setup");
});
