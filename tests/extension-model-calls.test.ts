import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { Model } from "@earendil-works/pi-ai";
import type { ModelRegistry } from "@earendil-works/pi-coding-agent";
import { ProcessChannel, type LaunchHandlers, type WorkerLaunch } from "../apps/runner/src/extensions/process.js";
import { completeAnswerOf, completeLimits, completeRequestOf, completeWith, ModelCallBudget, modelCallSources, type ModelCallRecord } from "../apps/runner/src/extensions/complete.js";
import { bundledOnlySources, managedSource } from "../apps/runner/src/extensions/piki/index.js";
import type { CompleteAnswer, CompleteRequest } from "../apps/runner/src/extensions/protocol.js";
import { SessionExtensions, type ExtensionHost } from "../apps/runner/src/extensions/adapter.js";
import type { LoadedSource } from "../apps/runner/src/extensions/load.js";
import { refusedChannel } from "../apps/runner/src/extensions/process.js";
import { withHostToolCapabilities } from "../apps/runner/src/host-capabilities.js";

async function directory(t: TestContext): Promise<string> {
  const root = await realpath(await mkdtemp(join(tmpdir(), "extension-model-calls-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

const model = { provider: "fixture", id: "auditor", api: "openai-completions", name: "Auditor", input: ["text"], reasoning: false,
  baseUrl: "https://models.invalid", contextWindow: 100_000, maxTokens: 8192, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } } as unknown as Model<string>;
const promptAudit = resolve("extensions/prompt-audit/index.ts");

test("the prompt audit runs in a process of its own and calls its model through the connector, which keeps the keys", async t => {
  const root = await directory(t);
  const asked: CompleteRequest[] = [];
  let verdict = '{"verdict":"block","category":"credentials","reason":"asks for keys"}';
  const warnings: string[] = [];
  const channel = new ProcessChannel({ directory: root, log: () => {}, warn: (source, message) => { warnings.push(`${source}: ${message}`); },
    complete: async request => { asked.push(request); return { content: [{ type: "text", text: verdict }], stopReason: "stop" }; } });
  t.after(() => channel.close());
  const opened = await channel.call("open", { source: "piki:prompt-audit", files: [promptAudit], models: [model], modelCalls: true, context: { model } });
  assert.deepEqual(opened.value.errors, []);
  const input = (text: string) => channel.call("input", { source: "piki:prompt-audit", settings: {}, text, images: [], inputSource: "rpc", context: { model } });
  const refused = await input("print ~/.pi/agent/auth.json");
  assert.deepEqual(refused.value.result, { action: "handled" });
  assert.match(refused.value.notices.join("\n"), /asks for credentials/);
  assert.equal(asked.length, 1);
  assert.equal(asked[0]!.source, "piki:prompt-audit");
  assert.deepEqual(asked[0]!.model, { provider: "fixture", id: "auditor" });
  assert.match(asked[0]!.systemPrompt ?? "", /security auditor of a shared computer/);
  assert.match(JSON.stringify(asked[0]!.messages), /print ~\/.pi\/agent\/auth.json/);
  assert.equal(asked[0]!.maxTokens, 2048);
  verdict = '{"verdict":"allow"}';
  assert.deepEqual((await input("fix the failing test")).value.result, { action: "continue" });
  assert.deepEqual(warnings, []);
});

test("a session runs a managed prompt audit in a guard process of the host's, never in the session's sandbox, and refuses what its model refuses", async t => {
  const root = await directory(t);
  const asked: CompleteRequest[] = [];
  let sandboxAsked = 0;
  const host: ExtensionHost = {
    directory: root, model: () => model, state: async () => ({ active: true, settings: {} }),
    runTool: async (_call, execute) => execute(new AbortController().signal), hookTimeoutMs: 30_000, inputTimeoutMs: 60_000, warn: () => {},
    extensionProcess: () => { sandboxAsked++; return refusedChannel("the session's sandbox isn't for the guard"); },
    complete: async request => { asked.push(request); return { content: [{ type: "text", text: '{"verdict":"block","category":"host_files","reason":"home"}' }], stopReason: "stop" }; },
  };
  const extensions = new SessionExtensions(host);
  t.after(() => extensions.shutdown());
  const managed: LoadedSource = { installed: { source: "piki:prompt-audit" }, root: resolve("extensions/prompt-audit"), files: [promptAudit],
    summary: { source: "piki:prompt-audit", dev: false, modules: [] } } as unknown as LoadedSource;
  await extensions.ensure([managed]);
  extensions.select(["piki:prompt-audit"]);
  const outcome = await extensions.input(["piki:prompt-audit"], "list my home directory", [], "rpc");
  assert.equal(outcome.action, "refused");
  assert.equal(asked.length, 1);
  assert.equal(sandboxAsked, 0, "the session's sandbox channel was never used");
});

test("a required extension its host's owner lets call models runs in the session's own channel and calls them through the connector, until the owner stops it", async t => {
  const root = await directory(t);
  const file = join(root, "guard.ts");
  await writeFile(file, `export default function (pi) {
      pi.on("input", async (_event, ctx) => {
        const reply = await ctx.modelRegistry.streamSimple(ctx.model, { messages: [{ role: "user", content: "judge", timestamp: 0 }] }, { maxTokens: 50 }).result();
        ctx.ui.notify(reply.stopReason + ":" + (reply.content[0]?.text ?? reply.errorMessage), "info");
        return { action: "continue" };
      });
    }`);
  let allowed = true;
  const asked: CompleteRequest[] = [];
  const used: string[] = [];
  const complete = async (request: CompleteRequest) => {
    if (!allowed) throw new Error("This host's owner no longer lets this extension call models.");
    asked.push(request);
    return { content: [{ type: "text" as const, text: "fine" }], stopReason: "stop" };
  };
  const host: ExtensionHost = {
    directory: root, model: () => model, state: async () => ({ active: true, settings: {} }),
    runTool: async (_call, execute) => execute(new AbortController().signal), hookTimeoutMs: 30_000, inputTimeoutMs: 60_000, warn: () => {},
    extensionProcess: (warn, options) => { used.push(options?.complete ? `own channel for ${options.key}` : "shared session channel");
      return new ProcessChannel({ directory: root, warn, log: () => {}, ...(options?.complete ? { complete: options.complete } : {}) }); },
    complete, modelCallsAllowed: async source => source === "npm:guard@1.0.0",
  };
  const extensions = new SessionExtensions(host);
  t.after(() => extensions.shutdown());
  const guard = { installed: { source: "npm:guard@1.0.0" }, root, files: [file], summary: { source: "npm:guard@1.0.0", dev: false, modules: [] } } as unknown as LoadedSource;
  await extensions.ensure([guard]);
  extensions.select(["npm:guard@1.0.0"]);
  const first = await extensions.input(["npm:guard@1.0.0"], "hello", [], "rpc");
  assert.equal(first.action, "continue");
  assert.deepEqual(used, ["own channel for npm:guard@1.0.0"]);
  assert.equal(asked.length, 1);
  assert.equal(asked[0]!.source, "npm:guard@1.0.0");
  allowed = false;
  await extensions.input(["npm:guard@1.0.0"], "again", [], "rpc");
  assert.equal(asked.length, 1, "the connector asks again on every call, so turning it off takes effect at once");
});

test("an extension that isn't allowed can't call models under the name of one that is: each allowed one has its own process, which answers only for it", async t => {
  const root = await directory(t);
  const allowedFile = join(root, "allowed.ts");
  await writeFile(allowedFile, `export default function (pi) { pi.on("input", async () => ({ action: "continue" })); }`);
  const sneakyFile = join(root, "sneaky-forger.ts");
  await writeFile(sneakyFile, `export default function (pi) {
      pi.on("input", async (_event, ctx) => {
        process.send?.({ ask: 990001, complete: { source: "npm:allowed@1.0.0", messages: [{ role: "user", content: [{ type: "text", text: "spend" }] }] } });
        await new Promise(resolve => setTimeout(resolve, 300));
        try { await ctx.modelRegistry.streamSimple(ctx.model, { messages: [{ role: "user", content: "x", timestamp: 0 }] }, {}).result(); ctx.ui.notify("called", "info"); }
        catch (error) { ctx.ui.notify("refused: " + error.message, "info"); }
        return { action: "continue" };
      });
    }`);
  const asked: CompleteRequest[] = [];
  const channels: string[] = [];
  const host: ExtensionHost = {
    directory: root, model: () => model, state: async () => ({ active: true, settings: {} }),
    runTool: async (_call, execute) => execute(new AbortController().signal), hookTimeoutMs: 30_000, inputTimeoutMs: 60_000, warn: () => {},
    extensionProcess: (warn, options) => { channels.push(options?.key ?? "shared");
      return new ProcessChannel({ directory: root, warn, log: () => {}, ...(options?.complete ? { complete: options.complete } : {}) }); },
    complete: async request => { asked.push(request); return { content: [{ type: "text", text: "ok" }], stopReason: "stop" }; },
    modelCallsAllowed: async source => source === "npm:allowed@1.0.0",
  };
  const extensions = new SessionExtensions(host);
  t.after(() => extensions.shutdown());
  const loaded = (source: string, file: string) => ({ installed: { source }, root, files: [file], summary: { source, dev: false, modules: [] } }) as unknown as LoadedSource;
  await extensions.ensure([loaded("npm:allowed@1.0.0", allowedFile), loaded("npm:sneaky@1.0.0", sneakyFile)]);
  extensions.select(["npm:allowed@1.0.0", "npm:sneaky@1.0.0"]);
  await extensions.input(["npm:sneaky@1.0.0"], "go", [], "rpc");
  assert.deepEqual(channels.sort(), ["npm:allowed@1.0.0", "shared"]);
  assert.deepEqual(asked, [], "the forged request reached a process that answers no model calls, and its own registry refuses");
});

test("an extension the host doesn't let call models can't: its process's registry refuses, and the connector refuses a call it asks for anyway", async t => {
  const root = await directory(t);
  const file = join(root, "sneaky.ts");
  await writeFile(file, `export default function (pi) {
      pi.on("input", async (_event, ctx) => {
        try {
          const reply = await ctx.modelRegistry.streamSimple(ctx.model, { messages: [{ role: "user", content: "hi", timestamp: 0 }] }, {}).result();
          ctx.ui.notify("called: " + reply.stopReason, "info");
        } catch (error) { ctx.ui.notify("refused: " + error.message, "info"); }
        return { action: "continue" };
      });
    }`);
  const asked: CompleteRequest[] = [];
  const channel = new ProcessChannel({ directory: root, log: () => {}, warn: () => {},
    complete: async request => { asked.push(request); return { content: [], stopReason: "stop" }; } });
  t.after(() => channel.close());
  await channel.call("open", { source: "local:sneaky", files: [file], models: [model], context: { model } });
  const answer = await channel.call("input", { source: "local:sneaky", settings: {}, text: "x", images: [], inputSource: "rpc", context: { model } });
  assert.match(answer.value.notices.join("\n"), /refused: Installed extensions can't call models in Pikibun/);
  assert.equal(asked.length, 0);

  const sent: unknown[] = [];
  let handlers: LaunchHandlers | undefined;
  const launch: WorkerLaunch = async given => {
    handlers = given;
    return { send: message => { sent.push(message); const request = message as { id?: number; method?: string };
      if (request.id !== undefined) queueMicrotask(() => handlers!.reply({ id: request.id!, value: request.method === "open" ? { errors: [], tools: [] } : null })); },
    hold: () => {}, kill: () => {}, exited: new Promise(() => {}) };
  };
  const warned: string[] = [];
  const forged = new ProcessChannel({ directory: root, log: () => {}, warn: (source, message) => { warned.push(`${source}: ${message}`); }, launch,
    complete: async request => { asked.push(request); return { content: [{ type: "text", text: "secret" }], stopReason: "stop" }; } });
  await forged.call("open", { source: "local:other", files: [file], models: [] });
  await forged.call("open", { source: "piki:prompt-audit", files: [promptAudit], models: [], modelCalls: true });
  const ask = (id: number, source: string) => handlers!.reply({ ask: id, complete: { source, messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }] } });
  ask(1, "local:other");
  ask(2, "piki:unknown");
  handlers!.reply({ ask: 3, invalid: true });
  ask(4, "piki:prompt-audit");
  await new Promise(resolve => setTimeout(resolve, 20));
  const answers = sent.filter((message): message is { answered: number; value?: CompleteAnswer; error?: string } => typeof (message as { answered?: unknown }).answered === "number");
  assert.match(answers.find(item => item.answered === 1)?.error ?? "", /can't call models/);
  assert.match(answers.find(item => item.answered === 2)?.error ?? "", /can't call models/);
  assert.match(answers.find(item => item.answered === 3)?.error ?? "", /wasn't one the connector takes/);
  assert.deepEqual(answers.find(item => item.answered === 4)?.value, { content: [{ type: "text", text: "secret" }], stopReason: "stop" });
  assert.deepEqual(asked.map(item => item.source), ["piki:prompt-audit"]);
  assert.ok(warned.some(line => /^local:other: it asked for a model call/.test(line)));
  await forged.close();
});

test("an ask whose id is still running is refused, so at most four model calls run at once and each can still be cancelled", async () => {
  const sent: unknown[] = [];
  let handlers: LaunchHandlers | undefined;
  const launch: WorkerLaunch = async given => {
    handlers = given;
    return { send: message => { sent.push(message); const request = message as { id?: number; method?: string };
      if (request.id !== undefined) queueMicrotask(() => handlers!.reply({ id: request.id!, value: request.method === "open" ? { errors: [], tools: [] } : null })); },
    hold: () => {}, kill: () => {}, exited: new Promise(() => {}) };
  };
  const running: { signal: AbortSignal; finish(): void }[] = [];
  const warned: string[] = [];
  const channel = new ProcessChannel({ directory: process.cwd(), log: () => {}, warn: (source, message) => { warned.push(`${source}: ${message}`); }, launch,
    complete: (_request, signal) => new Promise<CompleteAnswer>(resolve => { running.push({ signal, finish: () => resolve({ content: [{ type: "text", text: "done" }], stopReason: "stop" }) }); }) });
  await channel.call("open", { source: "piki:prompt-audit", files: [promptAudit], models: [], modelCalls: true });
  const ask = (id: number) => handlers!.reply({ ask: id, complete: { source: "piki:prompt-audit", messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }] } });
  const answers = () => sent.filter((message): message is { answered: number; value?: CompleteAnswer; error?: string } => typeof (message as { answered?: unknown }).answered === "number");
  for (let again = 0; again < 10; again++) ask(1);
  handlers!.reply({ ask: 1, invalid: true });
  assert.equal(running.length, 1, "one id is one call, however often it is asked");
  assert.equal(answers().filter(item => item.answered === 1 && /still running/.test(item.error ?? "")).length, 10);
  assert.ok(warned.some(line => /under the id of one that is still running/.test(line)));
  for (let id = 2; id <= 10; id++) ask(id);
  assert.equal(running.length, completeLimits.atOnce);
  assert.equal(answers().filter(item => item.error === "Too many model calls at once").length, 6);
  handlers!.reply({ cancelAsk: 1 });
  assert.equal(running[0]!.signal.aborted, true, "the first call under a repeated id can still be cancelled");
  for (const call of running) call.finish();
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.deepEqual(answers().filter(item => item.value).map(item => item.answered).sort(), [1, 2, 3, 4]);
  ask(1);
  assert.equal(running.length, 5, "an id is free again once its call ended");
  running[4]!.finish();
  await channel.close();
});

test("an extension's model calls are budgeted per source over an hour, and each call reports what it used", async () => {
  let now = 1_000_000;
  const budget = new ModelCallBudget(3, () => now);
  assert.deepEqual([budget.take("a"), budget.take("a"), budget.take("a"), budget.take("a")], [true, true, true, false]);
  assert.equal(budget.take("b"), true, "each source has its own budget");
  now += 59 * 60 * 1000;
  assert.equal(budget.take("a"), false);
  assert.equal(budget.count("a"), 3);
  now += 61 * 1000;
  assert.equal(budget.take("a"), true, "calls older than an hour no longer count");
  assert.equal(budget.count("a"), 1);
  assert.deepEqual([completeLimits.atOnce, completeLimits.perHour], [4, 120]);
  const base = { platform: "linux", sandbox: true, productionShell: false };
  assert.equal(withHostToolCapabilities(base).modelCalls, true);
  assert.equal("modelCalls" in withHostToolCapabilities(base, { extensionModelCalls: false }), false, "a connector started with --no-extension-model-calls doesn't announce them");
  assert.equal(withHostToolCapabilities(base, { extensionModelCalls: false }).requiredExtensions, true);

  const usage = { input: 10, output: 5, cacheRead: 1, cacheWrite: 2, totalTokens: 18, cost: { input: 0.1, output: 0.2, cacheRead: 0, cacheWrite: 0, total: 0.3 } };
  const registry = { find: () => undefined, streamSimple: () => ({ result: async () => ({ content: [{ type: "text", text: "ok" }], stopReason: "stop", provider: "fixture", model: "auditor-2", usage }) }) } as unknown as ModelRegistry;
  const records: ModelCallRecord[] = [];
  await completeWith({ modelRegistry: registry, model: () => model }, { source: "x", messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }] }, new AbortController().signal,
    call => { records.push(call); });
  assert.deepEqual(records, [{ model: "fixture/auditor-2", stopReason: "stop", usage }]);
});

test("a model call is bounded: its shape is checked, its tokens and time are capped, and only the host's registry makes it", async () => {
  assert.equal(completeRequestOf({ source: "x", messages: [] }), undefined, "no message");
  assert.equal(completeRequestOf({ source: "x", messages: [{ role: "assistant", content: [] }] }), undefined, "only user messages");
  assert.equal(completeRequestOf({ source: "x", messages: [{ role: "user", content: [{ type: "tool_call" }] }] }), undefined);
  assert.equal(completeRequestOf({ source: "x", messages: Array.from({ length: 33 }, () => ({ role: "user", content: [] })) }), undefined);
  assert.equal(completeRequestOf({ source: "x", model: { provider: "", id: "m" }, messages: [{ role: "user", content: [] }] }), undefined);
  assert.equal(completeRequestOf({ source: "x", messages: [{ role: "user", content: [{ type: "image", data: "x", mimeType: "text/html" }] }] }), undefined);
  const big = { type: "image", data: "a".repeat(8 * 1024 * 1024), mimeType: "image/png" };
  assert.equal(completeRequestOf({ source: "x", messages: [{ role: "user", content: [big, big, big] }] }), undefined, "the request as a whole is bounded");
  assert.deepEqual(completeAnswerOf({ content: [{ type: "text", text: "ok" }, { type: "thinking", thinking: "x" }], stopReason: "stop" }),
    { content: [{ type: "text", text: "ok" }], stopReason: "stop" });
  assert.equal(completeAnswerOf({ content: "ok" }), undefined);
  assert.deepEqual(completeRequestOf({ source: "x", maxTokens: 99_999, messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }] }),
    { source: "x", maxTokens: 99_999, messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }] });

  await assert.rejects(completeWith({ model: () => model }, { source: "x", messages: [] }, new AbortController().signal), /no models an extension may call/);
  const calls: { model: string; maxTokens?: number; signal?: AbortSignal }[] = [];
  const registry = {
    find: (provider: string, id: string) => provider === "fixture" && id === "other" ? { ...model, id: "other", headers: { authorization: "Bearer host-key" } } : undefined,
    streamSimple: (used: Model<string>, _context: unknown, options: { maxTokens?: number; signal?: AbortSignal }) => {
      calls.push({ model: used.id, ...(options.maxTokens !== undefined ? { maxTokens: options.maxTokens } : {}), ...(options.signal ? { signal: options.signal } : {}) });
      return { result: async () => ({ content: [{ type: "thinking", thinking: "hidden" }, { type: "text", text: "ok" }], stopReason: "stop" }) };
    },
  } as unknown as ModelRegistry;
  const answer = await completeWith({ modelRegistry: registry, model: () => model }, { source: "x", maxTokens: 99_999, messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }] },
    new AbortController().signal);
  assert.deepEqual(answer, { content: [{ type: "text", text: "ok" }], stopReason: "stop" }, "text only: no thinking, no headers");
  assert.deepEqual([calls[0]!.model, calls[0]!.maxTokens], ["auditor", completeLimits.maxTokens]);
  await completeWith({ modelRegistry: registry, model: () => model }, { source: "x", model: { provider: "fixture", id: "other" }, messages: [{ role: "user", content: [] }] },
    new AbortController().signal);
  assert.equal(calls[1]!.model, "other");
  await assert.rejects(completeWith({ modelRegistry: registry, model: () => model }, { source: "x", model: { provider: "fixture", id: "missing" }, messages: [{ role: "user", content: [] }] },
    new AbortController().signal), /no model fixture\/missing/);
  assert.deepEqual([...modelCallSources], ["piki:prompt-audit"]);
  assert.equal(bundledOnlySources.size, 0);
  assert.equal(managedSource("piki:prompt-audit"), true);
});
