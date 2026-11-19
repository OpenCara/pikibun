import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { Model } from "@earendil-works/pi-ai";
import type { ModelRegistry } from "@earendil-works/pi-coding-agent";
import { ProcessChannel, type LaunchHandlers, type WorkerLaunch } from "../apps/runner/src/extensions/process.js";
import { completeAnswerOf, completeLimits, completeRequestOf, completeWith, modelCallSources } from "../apps/runner/src/extensions/complete.js";
import { bundledOnlySources, managedSource } from "../apps/runner/src/extensions/piki/index.js";
import type { CompleteAnswer, CompleteRequest } from "../apps/runner/src/extensions/protocol.js";
import { SessionExtensions, type ExtensionHost } from "../apps/runner/src/extensions/adapter.js";
import type { LoadedSource } from "../apps/runner/src/extensions/load.js";
import { refusedChannel } from "../apps/runner/src/extensions/process.js";

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
