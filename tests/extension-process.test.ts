import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProcessChannel } from "../apps/runner/src/extensions/process.js";
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
