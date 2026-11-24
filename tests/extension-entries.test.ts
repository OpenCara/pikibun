import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxToolCall, type FauxResponseFactory } from "@earendil-works/pi-ai/providers/faux";
import type { ModelRegistry } from "@earendil-works/pi-coding-agent";
import { createRegistry, defineExtension, Harness, MemoryStorage } from "@earendil-works/pi-durable";
import { SessionExtensions, type ExtensionHost } from "../apps/runner/src/extensions/adapter.js";
import { boundEntries, entriesKey, entryLimits, SessionEntries, storedEntries, storedEntry, type EntryStorage } from "../apps/runner/src/extensions/entries.js";
import { loadInstalled, type LoadedSource } from "../apps/runner/src/extensions/load.js";
import { ProcessChannel, replyOf, type WorkerLaunch } from "../apps/runner/src/extensions/process.js";
import type { StoredEntry } from "../apps/runner/src/extensions/protocol.js";
import { ExtensionStore, parseExtensionSource } from "../apps/runner/src/extensions/store.js";
import { RunnerService } from "../apps/runner/src/server.js";
import { sha256 } from "../packages/shared/src/crypto.js";
import type { RunnerAction, RunnerBinding } from "../packages/shared/src/types.js";

const context = BACKGROUND_CONTEXT;

async function directory(t: TestContext): Promise<string> {
  const root = await realpath(await mkdtemp(join(tmpdir(), "extension-entries-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

const NOTES = `export default function (pi) {
  let notes = [];
  let started = 0;
  pi.on("session_start", (_event, ctx) => {
    started++;
    notes = [];
    for (const entry of ctx.sessionManager.getEntries()) if (entry.type === "custom" && entry.customType === "notes") notes = entry.data.notes;
  });
  pi.on("input", (event, ctx) => {
    const [verb, rest] = event.text.split(" ");
    if (verb === "crash") process.exit(3);
    if (verb === "add") { notes = [...notes, rest]; pi.appendEntry("notes", { notes }); }
    if (verb === "many") for (let index = 0; index < Number(rest); index++) pi.appendEntry("count", index);
    if (verb === "big") pi.appendEntry("big", "x".repeat(Number(rest)));
    if (verb === "bare") pi.appendEntry("bare");
    if (verb === "send") pi.sendUserMessage("never sent");
    const entries = ctx.sessionManager.getEntries();
    const branch = ctx.sessionManager.getBranch();
    ctx.ui.notify(JSON.stringify({ pid: process.pid, started, notes, entries: entries.length, types: [...new Set(entries.map(entry => entry.type + ":" + entry.customType))],
      first: entries[0]?.data, last: entries.at(-1)?.data, chained: branch.length === entries.length, leaf: ctx.sessionManager.getLeafId() === (entries.at(-1)?.id ?? null) }));
    return { action: "handled" };
  });
}`;

function memoryStorage(): EntryStorage & { docs: Map<string, StoredEntry[]>; writes: number } {
  const docs = new Map<string, StoredEntry[]>();
  const storage = { docs, writes: 0,
    read: async (key: string) => structuredClone(docs.get(key)),
    write: async (key: string, entries: StoredEntry[]) => { storage.writes++; docs.set(key, structuredClone(entries)); } };
  return storage;
}

function local(root: string, name: string, file: string, events: string[]): LoadedSource {
  return { installed: { source: name }, root, files: [file], summary: { source: name, dev: true, modules: [{ path: file, tools: [], events, flags: [], noops: [], ignored: [] }] } };
}

type Shown = { pid: number; started: number; notes: string[]; entries: number; types: string[]; first?: unknown; last?: unknown; chained: boolean; leaf: boolean };

function opened(t: TestContext, root: string, storage: EntryStorage | undefined, warnings: string[]) {
  const host: ExtensionHost = { directory: root, model: () => undefined, state: async () => ({ active: true, settings: {} }),
    runTool: async (_call, execute) => execute(new AbortController().signal), hookTimeoutMs: 20_000, inputTimeoutMs: 20_000,
    warn: (source, message) => { warnings.push(`${source}: ${message}`); }, ...(storage ? { entries: storage } : {}) };
  const session = new SessionExtensions(host, []);
  t.after(() => session.shutdown());
  const say = async (source: string, text: string): Promise<Shown> => {
    const outcome = await session.input([source], text, [], "rpc");
    assert.equal(outcome.action, "refused");
    assert.ok(outcome.action === "refused" && outcome.notice, `${source} answered ${text}`);
    return JSON.parse(outcome.notice) as Shown;
  };
  return { session, say };
}

test("appendEntry keeps an extension's entries for its session: they come back through ctx.sessionManager after its process restarts and after the session opens again", async t => {
  const root = await directory(t);
  const file = join(root, "notes.ts");
  await writeFile(file, NOTES);
  const source = local(root, "local:notes", file, ["session_start", "input"]);
  const storage = memoryStorage();
  const warnings: string[] = [];
  const first = opened(t, root, storage, warnings);
  await first.session.ensure([source]);
  await first.session.sessionStart();
  assert.deepEqual((await first.say("local:notes", "show")).notes, []);
  await first.say("local:notes", "add milk");
  const before = await first.say("local:notes", "add eggs");
  assert.deepEqual([before.notes, before.entries, before.types, before.chained, before.leaf], [["milk", "eggs"], 2, ["custom:notes"], true, true]);
  assert.deepEqual(await first.session.input(["local:notes"], "crash", [], "rpc"), { action: "refused", by: "local:notes" });
  const after = await first.say("local:notes", "show");
  assert.notEqual(after.pid, before.pid, "a new process");
  assert.deepEqual([after.notes, after.entries, after.started, after.chained, after.leaf], [["milk", "eggs"], 2, 1, true, true], "session_start read them back in the new process");
  assert.deepEqual((await first.say("local:notes", "bare")).last, undefined, "an entry without data");
  assert.match(JSON.stringify(await first.say("local:notes", "send")), /"entries":3/);
  assert.ok(warnings.some(warning => /sendUserMessage\(\) does nothing outside a command or a message that is running/.test(warning)), warnings.join("\n"));
  await first.session.shutdown();
  const kept = storage.docs.get(entriesKey("local:notes"))!;
  assert.deepEqual(kept.map(entry => [entry.customType, entry.data]), [["notes", '{"notes":["milk"]}'], ["notes", '{"notes":["milk","eggs"]}'], ["bare", ""]]);
  assert.ok(kept.every(entry => /^[0-9a-f]{8}$/.test(entry.id) && !Number.isNaN(Date.parse(entry.timestamp))));

  const second = opened(t, root, storage, warnings);
  await second.session.ensure([source]);
  await second.session.sessionStart();
  const reopened = await second.say("local:notes", "add tea");
  assert.deepEqual([reopened.notes, reopened.entries], [["milk", "eggs", "tea"], 4], "the session's next connector hands them back");
  assert.notEqual(reopened.pid, after.pid);
});

test("one extension never reads another's entries, and each is bounded: an entry's size, an extension's entries and their bytes, and how often they are written", async t => {
  const root = await directory(t);
  const mine = join(root, "mine.ts");
  const theirs = join(root, "theirs.ts");
  await writeFile(mine, NOTES);
  await writeFile(theirs, NOTES);
  const storage = memoryStorage();
  const warnings: string[] = [];
  const { session, say } = opened(t, root, storage, warnings);
  await session.ensure([local(root, "local:mine", mine, ["session_start", "input"]), local(root, "local:theirs", theirs, ["session_start", "input"])]);
  await session.sessionStart();
  await say("local:mine", "add secret");
  const other = await say("local:theirs", "show");
  assert.deepEqual([other.notes, other.entries], [[], 0], "in the same process, with the same entry type, it sees none of the other's");
  assert.deepEqual(await session.input(["local:mine"], "crash", [], "rpc"), { action: "refused", by: "local:mine" });
  assert.deepEqual([(await say("local:theirs", "show")).entries, (await say("local:mine", "show")).notes], [0, ["secret"]], "nor after both were handed theirs back");

  const big = await say("local:mine", `big ${entryLimits.entryBytes + 1}`);
  assert.equal(big.entries, 1, "an entry over the size limit is kept nowhere");
  assert.ok(warnings.some(warning => /local:mine: appendEntry\(\) kept nothing: an entry holds at most 64 KB of JSON/.test(warning)), warnings.join("\n"));
  const writes = storage.writes;
  const many = await say("local:theirs", `many ${entryLimits.perSource + 40}`);
  assert.equal(many.entries, entryLimits.perSource + 40, "its own process keeps what it appended");
  await session.shutdown();
  assert.ok(storage.writes - writes <= 3, `a burst is a few writes, not one per entry (${storage.writes - writes})`);
  const kept = storage.docs.get(entriesKey("local:theirs"))!;
  assert.deepEqual([kept.length, kept[0]!.data, kept.at(-1)!.data], [entryLimits.perSource, "40", String(entryLimits.perSource + 39)], "the oldest are dropped");
  assert.ok(warnings.some(warning => /local:theirs: it keeps more entries than a session holds for an extension/.test(warning)), warnings.join("\n"));
  assert.equal(storage.docs.get(entriesKey("local:mine"))!.length, 1);

  const again = opened(t, root, storage, warnings);
  await again.session.ensure([local(root, "local:theirs", theirs, ["session_start", "input"])]);
  await again.session.sessionStart();
  const restored = await again.say("local:theirs", "show");
  assert.deepEqual([restored.entries, restored.first, restored.last], [entryLimits.perSource, 40, entryLimits.perSource + 39]);
});

test("what an extension process says about entries is checked: their shape, their ids, their size, and whose they are", async () => {
  const entry = (data: string, id = "") => ({ id, timestamp: "2026-01-01T00:00:00.000Z", customType: "t", data });
  assert.deepEqual(storedEntry(entry("1", "abcd1234")), entry("1", "abcd1234"));
  const renamed = storedEntry(entry("1", "abcd1234"), new Set(["abcd1234"]));
  assert.ok(typeof renamed !== "string" && renamed.id !== "abcd1234" && /^[0-9a-f]{8}$/.test(renamed.id), "an id already taken is replaced");
  const dated = storedEntry({ id: "../x", timestamp: "never", customType: "t", data: "" });
  assert.ok(typeof dated !== "string" && /^[0-9a-f]{8}$/.test(dated.id) && !Number.isNaN(Date.parse(dated.timestamp)));
  for (const bad of [null, "x", { customType: "", data: "" }, { customType: "t".repeat(entryLimits.customType + 1), data: "" }, { customType: "t", data: "{" }, { customType: "t", data: 1 },
    { customType: "t", data: JSON.stringify("x".repeat(entryLimits.entryBytes)) }]) assert.equal(typeof storedEntry(bad), "string", JSON.stringify(bad).slice(0, 80));
  assert.equal(storedEntries([entry("1", "a"), "junk", entry("2", "a"), { customType: 3 }]).length, 2);
  assert.equal(storedEntries("junk").length, 0);
  const heavy = Array.from({ length: 40 }, (_item, index) => entry(JSON.stringify("x".repeat(60_000)), `id${index}`));
  const bounded = boundEntries(heavy);
  assert.ok(bounded.length < heavy.length && bounded.at(-1)!.id === "id39" && bounded.reduce((sum, item) => sum + item.data.length, 0) <= entryLimits.sourceBytes);
  assert.equal(entriesKey("npm:todo@1.0.0"), entriesKey("npm:todo@2.0.0"), "another version of a package keeps its entries");
  assert.notEqual(entriesKey("npm:todo@1.0.0"), entriesKey("npm:todos@1.0.0"));
  assert.deepEqual(replyOf({ entry: { source: "local:a", value: { customType: "t" } } }), { entry: { source: "local:a", value: { customType: "t" } } });
  assert.equal(replyOf({ entry: { source: 1, value: {} } }), undefined);
  assert.equal(replyOf({ entry: "x" }), undefined);

  const taken: string[] = [];
  const launch: WorkerLaunch = async handlers => {
    const link = { send: (message: unknown) => {
      const { id, method, params } = message as { id: number; method: string; params: { source?: string } };
      if (method === "open") handlers.reply({ entry: { source: "local:other", value: entry("1") } });
      handlers.reply({ id, value: method === "open" ? { errors: [], tools: [] } : null });
      if (method !== "open") return;
      setImmediate(() => {
        handlers.reply({ entry: { source: params.source!, value: entry("2") } });
        handlers.reply({ entry: { source: "local:other", value: entry("3") } });
      });
    }, hold: () => {}, kill: () => {}, exited: Promise.resolve() };
    return link;
  };
  const channel = new ProcessChannel({ directory: tmpdir(), warn: () => {}, log: () => {}, launch, appended: (source, value) => { taken.push(`${source} ${(value as StoredEntry).data}`); } });
  await channel.call("open", { source: "local:one", files: [], models: [] });
  await delay(10);
  assert.deepEqual(taken, ["local:one 2"], "an entry for a source this process doesn't run is dropped");
  await channel.close();

  const warned: string[] = [];
  const entries = new SessionEntries(undefined, (source, message) => { warned.push(`${source}: ${message}`); });
  entries.append("local:a", entry("1"));
  entries.append("local:a", { customType: "t", data: "{" });
  entries.append("local:a", { customType: "t", data: "{" });
  assert.equal(entries.list("local:a"), undefined, "nothing is listed before the session's own were read");
  assert.deepEqual((await entries.load("local:a")).map(item => item.data), ["1"], "what came before that is kept with them");
  assert.deepEqual(warned, ["local:a: appendEntry() kept nothing: an entry's data must be JSON"], "a refusal is logged once");
});

function runner(t: TestContext, root: string, installed: LoadedSource[], respond: FauxResponseFactory) {
  const faux = fauxProvider({ models: [{ id: "faux-1", reasoning: true }] });
  const again: FauxResponseFactory = async (...args) => { faux.appendResponses([again]); return respond(...args); };
  faux.setResponses([again]);
  const models = createModels();
  models.setProvider(faux.provider);
  const modelRegistry = { find: (provider: string, id: string) => ({ provider, id }), getAll: () => [] } as unknown as ModelRegistry;
  const target: RunnerBinding = {
    session: { id: "entries-session", workspaceId: "workspace", ownerId: "test:alice", agentVersionId: "version-1", title: "Entries", policyVersion: 1, status: "ready",
      createdAt: "2026-01-01T00:00:00Z", repositories: [], repositoryMode: "clone", connectorId: "host-connector", connectorOwnerId: "test:alice" },
    owner: { id: "test:alice", githubId: null, githubLogin: "alice", displayName: "Alice", gitName: "Alice", gitEmail: "alice@example.test", env: {}, githubConnected: false },
    agent: { id: "version-1", agentId: "agent", authorId: "test:alice", workspaceId: "workspace", version: 1, name: "Agent", description: "", instructions: "Use tools.", tools: ["read_file"], modelId: "model-1", createdAt: "2026-01-01T00:00:00Z" },
    model: { id: "model-1", workspaceId: "workspace", name: "Model", provider: "faux", modelId: "faux-1", connectorId: "host-connector", connectorOwnerId: "test:alice" },
  };
  const start = async () => {
    const service = new RunnerService({
      dataDir: join(root, "runner"), sharedSecret: "extension-test-secret-not-for-deployment", controlPlaneUrl: "http://127.0.0.1:8787",
      connectorId: "host-connector", allowFaux: true, unsandboxed: true,
      authorize: async input => ({ allowed: true, ownerId: input.ownerId, policyVersion: 1 }),
      resolveModels: async model => ({ models, provider: model.provider, modelId: model.modelId }),
      extensions: { installed: () => installed, workspace: async () => ({ extensions: [], automaticTools: false }), modelRegistry },
    });
    await service.initialize();
    let closed = false;
    const close = async () => { if (!closed) { closed = true; await service.close(); } };
    t.after(close);
    return { service, close };
  };
  const claims = async (action: RunnerAction) => {
    const now = Math.floor(Date.now() / 1000);
    return { aud: "runner" as const, sessionId: target.session.id, actorId: "test:alice", ownerId: "test:alice", action, policyVersion: 1, iat: now, exp: now + 60,
      jti: randomUUID(), bodyHash: await sha256(""), connectorId: "host-connector" };
  };
  return { target, start, claims };
}

test("a session keeps its extensions' entries in its own store: they are there when its host's connector starts again", { skip: !["linux", "darwin"].includes(process.platform) }, async t => {
  const root = await directory(t);
  await writeFile(join(root, "todo.ts"), `import { Type } from "typebox";
    export default function (pi) {
      pi.registerTool({ name: "todo", label: "Todo", description: "Keep a todo.", parameters: Type.Object({ text: Type.String() }),
        async execute(_id, params, _signal, _onUpdate, ctx) {
          pi.appendEntry("todo", { text: params.text });
          const kept = ctx.sessionManager.getEntries().filter(entry => entry.type === "custom" && entry.customType === "todo").map(entry => entry.data.text);
          return { content: [{ type: "text", text: "todos: " + kept.join(", ") }], details: undefined };
        } });
    }`);
  const store = new ExtensionStore(join(root, "state"));
  await store.add(parseExtensionSource(join(root, "todo.ts")));
  const installed = await loadInstalled(store);
  const r = runner(t, root, installed, async request => {
    const last = request.messages.findLast(message => message.role !== "system");
    if (last?.role === "toolResult") return fauxAssistantMessage(`done: ${last.content.map(part => part.type === "text" ? part.text : "").join("")}`);
    return fauxAssistantMessage(fauxToolCall("todo", { text: last?.role === "user" && typeof last.content === "string" ? last.content : "?" }), { stopReason: "toolUse" });
  });
  const ask = async (session: Awaited<ReturnType<RunnerService["provision"]>>, content: string) => {
    await session.submit(await r.claims("submit"), { content, requestId: content, admissionId: await sha256(content), options: { access: "auto" } }, "write");
    for (let count = 0; count < 500 && (await session.view()).busy; count++) await delay(20);
    return (await session.view()).entries.filter(entry => entry.role === "toolResult").at(-1)!.text;
  };
  const first = await r.start();
  const session = await first.service.provision(r.target, await r.claims("create"));
  assert.match(await ask(session, "write tests"), /todos: write tests$/);
  assert.match(await ask(session, "open the pull request"), /todos: write tests, open the pull request$/);
  await first.close();
  const second = await r.start();
  const reopened = await second.service.get(r.target.session.id);
  assert.match(await ask(reopened, "merge it"), /todos: write tests, open the pull request, merge it$/);
});

test("sendUserMessage in a message that is running sends one more turn of that message, and starts nothing once it has ended", async t => {
  const root = await directory(t);
  const file = join(root, "nudge.ts");
  await writeFile(file, `import { Type } from "typebox";
    export default function (pi) {
      pi.on("session_start", () => { pi.sendUserMessage("at the start"); });
      pi.on("agent_end", () => { pi.sendUserMessage("after the end"); });
      pi.registerTool({ name: "nudge", label: "Nudge", description: "Queue a follow-up.", parameters: Type.Object({ text: Type.String() }),
        async execute(_id, params) {
          if (params.text === "many") for (let index = 0; index < 12; index++) pi.sendUserMessage("follow-up " + index);
          else if (params.text !== "none") pi.sendUserMessage("follow-up: " + params.text);
          return { content: [{ type: "text", text: "queued" }], details: undefined };
        } });
    }`);
  const store = new ExtensionStore(join(root, "state"));
  await store.add(parseExtensionSource(file));
  const loaded = await loadInstalled(store, []);
  const warnings: string[] = [];
  const host: ExtensionHost = { directory: root, model: () => undefined, state: async () => ({ active: true, settings: {} }),
    runTool: async (call, execute) => execute(call.signal), hookTimeoutMs: 20_000, warn: (_source, message) => { warnings.push(message); } };
  const extensions = new SessionExtensions(host, []);
  await extensions.ensure(loaded);
  t.after(() => extensions.shutdown());
  const users: string[] = [];
  const faux = fauxProvider({ models: [{ id: "faux-1", name: "faux" }] });
  const respond: FauxResponseFactory = async request => {
    faux.appendResponses([respond]);
    const last = request.messages.findLast(message => message.role !== "system");
    if (last?.role === "toolResult") return fauxAssistantMessage("called");
    const text = last?.role === "user" ? (typeof last.content === "string" ? last.content : last.content.map(part => part.type === "text" ? part.text : "").join("")) : "";
    users.push(text);
    return text.startsWith("follow-up") ? fauxAssistantMessage("followed") : fauxAssistantMessage(fauxToolCall("nudge", { text }), { stopReason: "toolUse" });
  };
  faux.setResponses([respond]);
  const models = createModels();
  models.setProvider(faux.provider);
  const registry = createRegistry();
  const workspace = defineExtension({ name: "workspace-tools", tools: [] });
  registry.install(workspace);
  const { selected, created } = extensions.select(loaded.map(item => item.summary.source));
  for (const extension of created) registry.install(extension);
  const harness = await Harness.open(new MemoryStorage(), { models, registry }, context);
  t.after(() => harness.close(context));
  const conversation = await harness.root(context, { agent: { model: { provider: "faux", modelId: "faux-1" },
    extensions: [workspace, ...selected.map(item => item.extension)], tools: selected.flatMap(item => item.tools) } });
  await extensions.sessionStart();
  const send = async (content: string) => {
    users.length = 0;
    await extensions.beforeAgentStart(content, undefined);
    const settled = await (await conversation.submit({ type: "input", content }, context)).wait(context);
    assert.equal(settled.status, "done");
    await extensions.agentEnd([], false);
    return [...users];
  };
  assert.deepEqual(await send("check the build"), ["check the build", "follow-up: check the build"], "the follow-up runs as one more turn of the same message");
  assert.deepEqual(await send("none"), ["none"], "nothing queued, nothing sent: neither session_start's nor agent_end's message starts a turn");
  const many = await send("many");
  assert.equal(many.length, 2);
  assert.equal(many[1], Array.from({ length: 8 }, (_item, index) => `follow-up ${index}`).join("\n\n"), "at most 8 are queued for one reply, sent together");
  assert.ok(warnings.some(warning => /sendUserMessage\(\) does nothing outside a command or a message that is running/.test(warning)), warnings.join("\n"));
  assert.ok(warnings.some(warning => /sendUserMessage\(\) queues at most 8 messages for one reply/.test(warning)), warnings.join("\n"));
});
