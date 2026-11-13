import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxToolCall, type FauxResponseFactory } from "@earendil-works/pi-ai/providers/faux";
import { loadInstalled, pikibunOwn } from "../apps/runner/src/extensions/load.js";
import { ExtensionStore, parseExtensionSource } from "../apps/runner/src/extensions/store.js";
import { RunnerService } from "../apps/runner/src/server.js";
import type { RunnerSession } from "../apps/runner/src/session.js";
import { renamedToolNote } from "../apps/runner/src/session/renamed-tools.js";
import { sha256 } from "../packages/shared/src/crypto.js";
import { parseWorkspaceExtensions } from "../packages/shared/src/host-extensions.js";
import { reservedToolNames } from "../packages/shared/src/tool-definitions.js";
import { canonicalToolName, canonicalToolNames, legacyToolNames, renamedToolNames, retiredToolNames, toolNames, withLegacyToolNames,
  type RunnerAction, type RunnerBinding } from "../packages/shared/src/types.js";
import { storedToolResults } from "./helpers/tool-results.js";

const unix = { skip: !["linux", "darwin"].includes(process.platform) };

async function directory(t: TestContext): Promise<string> {
  const path = await realpath(await mkdtemp(join(tmpdir(), "pikibun-tool-names-")));
  t.after(() => rm(path, { recursive: true, force: true }));
  return path;
}

function binding(id: string, tools: string[]): RunnerBinding {
  return {
    session: { id, workspaceId: "workspace", ownerId: "test:alice", agentVersionId: "version-1", title: "Names", policyVersion: 1, status: "ready",
      createdAt: "2026-01-01T00:00:00Z", repositories: [], repositoryMode: "clone", connectorId: "host-connector", connectorOwnerId: "test:alice" },
    owner: { id: "test:alice", githubId: null, githubLogin: "alice", displayName: "Alice", gitName: "Alice", gitEmail: "alice@example.test", env: {}, githubConnected: false },
    agent: { id: "version-1", agentId: "agent", authorId: "test:alice", workspaceId: "workspace", version: 1, name: "Agent", description: "", instructions: "Use tools.",
      tools, modelId: "model-1", createdAt: "2026-01-01T00:00:00Z" },
    model: { id: "model-1", workspaceId: "workspace", name: "Model", provider: "faux", modelId: "faux-1", connectorId: "host-connector", connectorOwnerId: "test:alice" },
  };
}

type Call = { tool: string; args: Record<string, unknown> };

async function runner(t: TestContext, calls: Call[], options: { tools?: string[]; extension?: string; offered?: string[][] } = {}) {
  const root = await directory(t);
  const faux = fauxProvider({ models: [{ id: "faux-1" }] });
  const queue = [...calls];
  const respond: FauxResponseFactory = async request => {
    faux.appendResponses([respond]);
    const available = new Set<string>();
    for (const message of request.messages) {
      if (message.role !== "system") continue;
      for (const removed of message.toolsRemoved ?? []) available.delete(removed.name);
      for (const added of message.toolsAdded ?? []) available.add(added.name);
    }
    options.offered?.push([...available]);
    const next = queue.shift();
    return next ? fauxAssistantMessage(fauxToolCall(next.tool, next.args as Parameters<typeof fauxToolCall>[1]), { stopReason: "toolUse" }) : fauxAssistantMessage("Done.");
  };
  faux.setResponses([respond]);
  const models = createModels();
  models.setProvider(faux.provider);
  let installed: Awaited<ReturnType<typeof loadInstalled>> = [];
  if (options.extension) {
    await writeFile(join(root, "guard.ts"), options.extension);
    const store = new ExtensionStore(join(root, "state"));
    await store.add(parseExtensionSource(join(root, "guard.ts")));
    const [dev] = await loadInstalled(store, []);
    assert.equal(dev!.summary.error, undefined);
    installed = [{ ...dev!, summary: { ...dev!.summary, source: "npm:guard@1.0.0", dev: false } }];
  }
  const service = new RunnerService({
    dataDir: join(root, "runner"), sharedSecret: "tool-names-test-secret-not-for-deployment", controlPlaneUrl: "http://127.0.0.1:8787",
    connectorId: "host-connector", allowFaux: true, unsandboxed: true,
    authorize: async input => ({ allowed: true, ownerId: input.ownerId, policyVersion: 1 }),
    resolveModels: async model => ({ models, provider: model.provider, modelId: model.modelId }),
    ...(options.extension ? { extensions: { installed: () => installed, workspace: async () => ({ extensions: parseWorkspaceExtensions([{ source: "npm:guard@1.0.0" }]), automaticTools: true }) } } : {}),
  });
  await service.initialize();
  t.after(() => service.close());
  const id = `names-${randomUUID().slice(0, 8)}`;
  const claims = async (action: RunnerAction, body = "") => {
    const now = Math.floor(Date.now() / 1000);
    return { aud: "runner" as const, sessionId: id, actorId: "test:alice", ownerId: "test:alice", action, policyVersion: 1, iat: now, exp: now + 60,
      jti: randomUUID(), bodyHash: await sha256(body), connectorId: "host-connector" };
  };
  const session = await service.provision(binding(id, options.tools ?? withLegacyToolNames(toolNames.filter(tool => !retiredToolNames.includes(tool)))), await claims("create"));
  const idle = async (target: RunnerSession) => {
    for (let count = 0; count < 500 && (await target.view()).busy; count++) await delay(20);
    assert.equal((await target.view()).busy, false, "the runner settled");
  };
  const send = async (content: string, mode: "write" | "ask" = "write") => {
    const receipt = await session.submit(await claims(mode === "ask" ? "ask" : "submit"),
      { content, requestId: randomUUID(), ...(mode === "write" ? { admissionId: await sha256(content) } : {}) }, mode);
    await idle(session);
    return receipt;
  };
  return { session, send, root };
}

test("the renamed tools: one map from the old names, which stay Pikibun's own and never retired", () => {
  assert.deepEqual(Object.entries(renamedToolNames), [["read_file", "read"], ["write_file", "write"], ["edit_file", "edit"], ["list_files", "ls"], ["search", "grep"]]);
  assert.deepEqual(["read_file", "read", "search", "git", "bash"].map(canonicalToolName), ["read", "read", "grep", "git", "bash"]);
  assert.deepEqual(legacyToolNames("grep"), ["search"]);
  assert.deepEqual(legacyToolNames("git"), []);
  assert.deepEqual(canonicalToolNames(["read_file", "read", "list_files"]), ["read", "ls"]);
  assert.deepEqual(withLegacyToolNames(["read", "git"]), ["read", "read_file", "git"]);
  for (const name of ["read", "write", "edit", "ls", "grep", "find", "read_file", "write_file", "edit_file", "list_files", "search"]) {
    assert.ok(pikibunOwn(name), `an extension's ${name} is left out, as Pikibun's own`);
    assert.ok(reservedToolNames.includes(name), `a tool definition can't take ${name}`);
  }
  assert.ok(!pikibunOwn("bash"), "a retired name is free for an extension");
  assert.ok(Object.keys(renamedToolNames).every(name => !(retiredToolNames as readonly string[]).includes(name) && !(toolNames as readonly string[]).includes(name)));
});

test("a call to an old name, which the harness refuses as unavailable, is told which tool to call instead", async t => {
  const { session, send } = await runner(t, [{ tool: "read_file", args: { path: "a.txt" } }]);
  const receipt = await send("Read a.txt.");
  const results = await storedToolResults(session, receipt.conversationId);
  assert.equal(results.length, 1);
  assert.equal(results[0]!.isError, true);
  const transcript = (await session.view()).entries.filter(entry => entry.role === "toolResult").map(entry => entry.text).join("\n");
  assert.match(transcript, /read_file is not available/, "the harness refuses the old name");
  assert.match(transcript, /read_file is called read now, with the parameters and answers of Pi's own read: call read instead\./);
  assert.equal(renamedToolNote("git", { isError: true, diagnostics: [{ severity: "error", code: "tool_unavailable", message: "Tool git is not available" }] }), undefined);
  assert.equal(renamedToolNote("read_file", { isError: true, diagnostics: [{ severity: "error", code: "blocked", message: "No." }] }), undefined);
});

test("a binding from before the rename still gives the new tools, side asks included", async t => {
  const offered: string[][] = [];
  const { session, send } = await runner(t, [{ tool: "write", args: { path: "a.txt", content: "old binding\n" } }, { tool: "read", args: { path: "a.txt" } }],
    { tools: ["identity", "read_file", "write_file", "list_files", "search"], offered });
  await send("Write and read a.txt.");
  const transcript = (await session.view()).entries.filter(entry => entry.role === "toolResult").map(entry => entry.text);
  assert.deepEqual(transcript.slice(-2), ["Successfully wrote to a.txt", "old binding\n"]);
  assert.ok(["read", "write", "ls", "grep", "identity"].every(tool => offered[0]!.includes(tool)), offered[0]!.join());
  assert.ok(!["read_file", "write_file", "list_files", "search"].some(tool => offered[0]!.includes(tool)), "each message offers only the new names");
  offered.length = 0;
  await send("What is in a.txt?", "ask");
  const asked = offered.at(-1)!;
  assert.ok(["identity", "read", "ls", "grep"].every(tool => asked.includes(tool)), `a side ask reads with the new tools: ${asked.join()}`);
  assert.ok(!asked.includes("write"));
});

test("an extension's hooks match Pikibun's file tools by Pi's names: a write blocked by path, a read rewritten, read's and edit's results read with Pi's type guards", unix, async t => {
  const log: string[] = [];
  (globalThis as { __piToolNames?: string[] }).__piToolNames = log;
  t.after(() => { delete (globalThis as { __piToolNames?: string[] }).__piToolNames; });
  const extension = `import { isEditToolResult, isReadToolResult, isToolCallEventType } from "@earendil-works/pi-coding-agent";
    export default function (pi) {
      const log = line => globalThis.__piToolNames.push(line);
      pi.on("tool_call", event => {
        if (isToolCallEventType("write", event) && event.input.path === "secret.txt") return { block: true, reason: "No secrets." };
        if (isToolCallEventType("read", event) && event.input.path === "alias.txt") event.input.path = "real.txt";
      });
      pi.on("tool_result", event => {
        if (isReadToolResult(event)) log("read " + JSON.stringify(event.content[0].text) + " " + JSON.stringify(event.details?.pikibun?.actingAs));
        if (isEditToolResult(event)) log("edit " + JSON.stringify(event.details?.diff) + " " + event.details?.firstChangedLine + " " + event.details?.patch.includes("+bye"));
      });
    }`;
  const { session, send, root } = await runner(t, [
    { tool: "write", args: { path: "secret.txt", content: "leaked" } },
    { tool: "write", args: { path: "real.txt", content: "hello\n" } },
    { tool: "read", args: { path: "alias.txt" } },
    { tool: "edit", args: { path: "real.txt", edits: [{ oldText: "hello", newText: "bye" }] } },
  ], { extension });
  await send("Go.");
  const results = (await session.view()).entries.filter(entry => entry.role === "toolResult").map(entry => entry.text);
  assert.match(results[0]!, /No secrets\./, "the guard for write fires on Pikibun's write");
  await assert.rejects(readFile(join(root, "runner", "sessions", session.binding.session.id, "sandbox", "worktree", "secret.txt")), { code: "ENOENT" });
  assert.equal(await session.sandbox.readFile("real.txt", async () => {}), "bye\n");
  assert.deepEqual(log, ['read "hello\\n" "test:alice"', 'edit "-1 hello\\n+1 bye" 1 true'],
    "the read was rewritten to real.txt, and the results reached the handlers with Pi's content and details, and Pikibun's");
});
