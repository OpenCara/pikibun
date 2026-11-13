import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { ExtensionWorker, jsonChannel, MODEL_CALLS_REFUSED, modelDescription } from "../apps/runner/src/extensions/worker.js";
import { SessionExtensions, type ExtensionHost } from "../apps/runner/src/extensions/adapter.js";
import type { LoadedSource } from "../apps/runner/src/extensions/load.js";

async function directory(t: TestContext): Promise<string> {
  const root = await realpath(await mkdtemp(join(tmpdir(), "extension-worker-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

const model = { id: "m-1", name: "M", api: "openai-completions", provider: "acme", baseUrl: "https://models.example", reasoning: false, input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 1000, maxTokens: 100, headers: { authorization: "Bearer secret" } } as never;

test("an installed extension sees the host's models without their headers, and can neither call them nor read the host's keys", async t => {
  const root = await directory(t);
  const file = join(root, "probe.ts");
  await writeFile(file, `import { Type } from "typebox";
    export default function (pi) {
      pi.registerTool({ name: "probe", label: "Probe", description: "Probe the context.", parameters: Type.Object({ name: Type.String() }),
        async execute(_id, params, signal, _onUpdate, ctx) {
          const found = ctx.modelRegistry.find("acme", "m-1");
          const refusals = [];
          for (const call of [() => ctx.modelRegistry.getApiKeyForProvider("acme"), () => ctx.modelRegistry.streamSimple(found, { messages: [] })]) {
            try { await call(); refusals.push("ran"); } catch (error) { refusals.push(error.message); }
          }
          return { content: [{ type: "text", text: JSON.stringify({ name: params.name, model: ctx.model, found, refusals, level: pi.getThinkingLevel() }) }], details: { ok: true } };
        } });
    }`);
  const warnings: string[] = [];
  const channel = jsonChannel(new ExtensionWorker({ directory: root, warn: (source, message) => { warnings.push(`${source}: ${message}`); } }));
  t.after(() => channel.close());
  const opened = await channel.call("open", { source: "local:probe", files: [file], models: [modelDescription(model)] });
  assert.deepEqual(opened.value.errors, []);
  assert.deepEqual(opened.value.tools.map(tool => [tool.name, tool.description]), [["probe", "Probe the context."]]);
  const parameters = opened.value.tools[0]!.parameters as { required?: string[]; properties?: Record<string, { type?: string }> };
  assert.deepEqual([parameters.required, parameters.properties?.name?.type], [["name"], "string"], "the schema crosses as plain JSON Schema");
  const answer = await channel.call("execute", { source: "local:probe", settings: {}, tool: "probe", callId: "c1", args: { name: "x" },
    context: { model: modelDescription(model), thinkingLevel: "high" } });
  const seen = JSON.parse((answer.value.content[0] as { text: string }).text);
  assert.equal(seen.name, "x");
  assert.deepEqual([seen.model.provider, seen.model.id, seen.model.headers, seen.level], ["acme", "m-1", undefined, "high"]);
  assert.deepEqual([seen.found.baseUrl, seen.found.headers], ["https://models.example", undefined]);
  assert.deepEqual(seen.refusals, [MODEL_CALLS_REFUSED, MODEL_CALLS_REFUSED]);
  assert.deepEqual(answer.value.details, { ok: true });
  assert.deepEqual(warnings, []);
});

test("handlers an extension adds once it runs are seen, a call's abort reaches its tool, and a request for a source not open fails", async t => {
  const root = await directory(t);
  const file = join(root, "later.ts");
  await writeFile(file, `import { Type } from "typebox";
    export default function (pi) {
      pi.on("session_start", () => { pi.on("input", event => event.text === "stop" ? { action: "handled" } : { action: "continue" }); });
      pi.registerTool({ name: "wait", label: "Wait", description: "Wait to be stopped.", parameters: Type.Object({}),
        execute(_id, _params, signal) {
          return new Promise(resolve => {
            const done = () => resolve({ content: [{ type: "text", text: "aborted" }], details: undefined });
            if (signal.aborted) done(); else signal.addEventListener("abort", done, { once: true });
          });
        } });
    }`);
  const channel = jsonChannel(new ExtensionWorker({ directory: root, warn: () => {} }));
  t.after(() => channel.close());
  const opened = await channel.call("open", { source: "local:later", files: [file], models: [] });
  assert.equal(opened.handlers?.includes("input"), false);
  assert.ok(opened.handlers?.includes("session_start"));
  const started = await channel.call("emit", { source: "local:later", settings: {}, event: { type: "session_start", reason: "startup" } });
  assert.ok(started.handlers?.includes("input"), "the handler added at session_start is reported");
  const stopped = await channel.call("input", { source: "local:later", settings: {}, text: "stop", images: [], inputSource: "rpc" });
  assert.deepEqual(stopped.value.result, { action: "handled" });
  const controller = new AbortController();
  const running = channel.call("execute", { source: "local:later", settings: {}, tool: "wait", callId: "c2", args: {} }, controller.signal);
  controller.abort();
  assert.equal(((await running).value.content[0] as { text: string }).text, "aborted");
  await assert.rejects(channel.call("emit", { source: "local:missing", settings: {}, event: { type: "agent_start" } }), /local:missing isn't open/);
  await assert.rejects(channel.call("open", { source: "local:later", files: [file], models: [] }), /already open/);
});

test("a session's installed extensions get no keys from the host's registry, while the connector's own keep it", async t => {
  const root = await directory(t);
  const probe = `pi => { pi.on("input", async (_event, ctx) => {
    let said;
    try { said = await ctx.modelRegistry.getApiKeyForProvider("acme"); } catch (error) { said = error.message; }
    ctx.ui.notify(String(said));
    return { action: "handled" };
  }); }`;
  const file = join(root, "keys.ts");
  await writeFile(file, `export default ${probe};`);
  const factory = new Function(`return ${probe}`)() as ExtensionFactory;
  const summary = (source: string) => ({ source, dev: false, modules: [{ path: "x", tools: [], events: ["input"], flags: [], noops: [], ignored: [] }] });
  const installed: LoadedSource = { installed: { source: "npm:keys@1.0.0" }, root, files: [file], summary: summary("npm:keys@1.0.0") };
  const builtIn: LoadedSource = { installed: { source: "inline:keys" }, root: "", files: ["<inline>"], factories: [{ path: "<inline>", factory }], summary: summary("inline:keys") };
  const registry = { getAll: () => [model], find: () => model, getApiKeyForProvider: async () => "the-host's-key" };
  const host: ExtensionHost = { directory: root, modelRegistry: registry as never, model: () => undefined, state: async () => ({ active: true, settings: {} }),
    runTool: async (_call, execute) => execute(new AbortController().signal), hookTimeoutMs: 5000, warn: (_source, message) => assert.fail(message) };
  const session = new SessionExtensions(host, []);
  await session.ensure([installed, builtIn]);
  t.after(() => session.shutdown());
  assert.deepEqual(await session.input(["npm:keys@1.0.0"], "hello", [], "rpc"), { action: "refused", by: "npm:keys@1.0.0", notice: MODEL_CALLS_REFUSED });
  assert.deepEqual(await session.input(["inline:keys"], "hello", [], "rpc"), { action: "refused", by: "inline:keys", notice: "the-host's-key" });
});
