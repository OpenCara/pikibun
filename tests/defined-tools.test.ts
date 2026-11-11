import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { RunnerService } from "../apps/runner/src/server.js";
import type { RunnerSession } from "../apps/runner/src/session.js";
import { brokeredArguments, brokeredTarget, knownDefinedProgramTool, programCommand, programRequest, refusedCommand } from "../apps/runner/src/defined-tools.js";
import { ToolDefinitionsSource, TOOL_DEFINITIONS_TTL_MS } from "../apps/runner/src/tool-definitions-source.js";
import { validateOperation } from "../apps/runner/src/protocol.js";
import { parseOperation } from "../apps/server/src/authority/operations.js";
import { connectorWorkspaceExtensions } from "../apps/server/src/extensions.js";
import { bundledToolDefinitions, parseToolDefinition, parseToolDefinitions, reservedToolNames, type BrokeredToolDefinition, type ProgramToolDefinition,
  type ToolDefinition } from "../packages/shared/src/tool-definitions.js";
import { pikiExtension, pikiSessionToolExtensions } from "../packages/shared/src/piki-extensions.js";
import { pikibunToolDescriptions } from "../packages/shared/src/workspace-tools.js";
import { parseWorkspaceExtensions, type WorkspaceExtensionsAnswer } from "../packages/shared/src/host-extensions.js";
import { toolNames, type ApprovalRecord, type AuthorizationRequest, type RunnerAction, type RunnerBinding, type RunnerTicket } from "../packages/shared/src/types.js";
import { sha256 } from "../packages/shared/src/crypto.js";
import { writeFile } from "node:fs/promises";
import { loadInstalled } from "../apps/runner/src/extensions/load.js";
import { ExtensionStore, parseExtensionSource } from "../apps/runner/src/extensions/store.js";

const jvm: ProgramToolDefinition = {
  kind: "program", name: "jvm", extensions: ["piki:jvm"], description: "Run Maven or Gradle in the session worktree without a shell.",
  programs: ["mvn", "gradle"], example: '["test"]', environment: [["MAVEN_OPTS", "-Djava.awt.headless=true"], ["NO_COLOR", "1"]], path: ["/usr/share/maven/bin", "/opt/gradle/bin"],
  grammar: {
    mvn: { valued: ["-f", "--file", "-s", "--settings"], refuse: [{ words: [["deploy", "release:perform"]], command: "mvn {0}" }] },
    gradle: { valued: ["-p", "--project-dir"], refuse: [{ words: [["publish", "publishToMavenCentral"]], command: "gradle {0}" }] },
  },
  refusal: "acts on a package repository as an account, which sessions don't have", windowsSandbox: false,
  summary: { programs: "mvn and gradle", example: "jvm {program: \"mvn\", args: [\"test\"], directory: \"<name>\"}" },
};
const notes: BrokeredToolDefinition = {
  kind: "brokered", name: "notes_read", extensions: ["piki:notes"], description: "Read one of the workspace's notes as the session owner.",
  parameters: { note: { type: "string", required: true, pattern: "^[a-z0-9-]{1,64}$", invalid: "note is a note's id" }, line: { type: "integer", minimum: 1, maximum: 1000 } },
  target: ["note", "line"], route: "notes/read", write: false, instructions: "Read the workspace's notes with notes_read {note}.",
};

async function records(session: RunnerSession): Promise<ApprovalRecord[]> {
  return Object.values((await (session as unknown as { metadata(): Promise<{ approvals: Record<string, ApprovalRecord> }> }).metadata()).approvals);
}

test("the bundled definitions are data: they round-trip through the parser a connector reads them with", () => {
  const sent = JSON.parse(JSON.stringify({ tools: bundledToolDefinitions }));
  assert.deepEqual(parseToolDefinitions(sent), bundledToolDefinitions);
  assert.deepEqual(bundledToolDefinitions.map(item => item.name), ["node", "rust", "go", "dotnet", "make", "source_read"]);
  for (const definition of [jvm, notes]) assert.deepEqual(parseToolDefinition(JSON.parse(JSON.stringify(definition))), definition);
});

test("every definition is switched by Pikibun extensions the workspace page lists, and described for people", () => {
  for (const definition of bundledToolDefinitions) {
    assert.ok(!reservedToolNames.includes(definition.name), definition.name);
    assert.ok((toolNames as readonly string[]).includes(definition.name), `${definition.name}: older connectors' tool, the same name`);
    assert.ok(pikibunToolDescriptions[definition.name], definition.name);
    for (const source of definition.extensions) {
      const extension = pikiExtension(source);
      assert.ok(extension?.sessionTools?.includes(definition.name) && !extension.retired, `${definition.name}: ${source}`);
    }
  }
});

test("a definition is checked as data: what could change what runs, or isn't a word, is refused", () => {
  const program = (change: Record<string, unknown>) => () => parseToolDefinition({ ...JSON.parse(JSON.stringify(jvm)), ...change });
  for (const [why, change] of [
    ["a tool of Pikibun's own", { name: "git" }], ["a shell", { name: "bash" }], ["a name that isn't one", { name: "Jvm Tool" }],
    ["PATH", { environment: [["PATH", "/tmp"]] }], ["a preload", { environment: [["LD_PRELOAD", "/tmp/x.so"]] }], ["Node's options", { environment: [["NODE_OPTIONS", "--require=x"]] }],
    ["Git's configuration", { environment: [["GIT_CONFIG_COUNT", "1"]] }], ["a value the shell would read", { environment: [["MAVEN_OPTS", "$(touch x)"]] }],
    ["a value with a space", { environment: [["MAVEN_OPTS", "a b"]] }], ["a relative directory", { path: ["bin"] }], ["a directory with ..", { path: ["/usr/../tmp"] }],
    ["a program that isn't a word", { programs: ["mvn; rm -rf ~"] }], ["no extension", { extensions: [] }], ["another kind of extension", { extensions: ["npm:x@1.0.0"] }],
    ["an unknown field", { run: "sh -c x" }], ["an unknown toolchain", { toolchain: "python" }], ["a bad pattern", { grammar: { mvn: { refuse: [{ words: [["x"]], anyArgument: "(", command: "x" }] } } }],
    ["a grammar field it doesn't know", { grammar: { mvn: { exec: "x" } } }], ["a deep runner", { grammar: { mvn: { runners: [{ words: ["exec"], skip: 9 }] } } }],
  ] as const) assert.throws(program(change), /Invalid tool definition/, why);
  const brokered = (change: Record<string, unknown>) => () => parseToolDefinition({ ...JSON.parse(JSON.stringify(notes)), ...change });
  for (const [why, change] of [
    ["a route out of its place", { route: "../internal/sources/read" }], ["an absolute route", { route: "/api/admin" }], ["a target it has no parameter for", { target: ["owner"] }],
    ["a parameter name colliding with the request's own", { parameters: { sessionId: { type: "string" } } }], ["a parameter of no known type", { parameters: { x: { type: "object" } } }],
  ] as const) assert.throws(brokered(change), /Invalid tool definition/, why);
  assert.deepEqual(parseToolDefinitions({ tools: [{ kind: "mcp", name: "x" }, { ...jvm, name: "bash" }, jvm, { ...jvm, description: "Again." }, notes] }).map(item => item.name), ["jvm", "notes_read"]);
  assert.throws(() => parseToolDefinitions({ tools: Array.from({ length: 65 }, () => jvm) }), /Invalid tool definitions/);
});

test("a tool only the control plane defines runs with no code of the connector's: its grammar refuses, its command is exact", () => {
  assert.equal(refusedCommand(jvm, "mvn", ["-f", "deploy/pom.xml", "deploy"]), "mvn deploy", "past an option's value named like the command");
  assert.equal(refusedCommand(jvm, "mvn", ["--file=pom.xml", "release:perform"]), "mvn release:perform");
  assert.equal(refusedCommand(jvm, "mvn", ["test", "-Ddeploy=true"]), undefined);
  assert.equal(refusedCommand(jvm, "gradle", ["-p", "app", "publish"]), "gradle publish");
  assert.equal(refusedCommand(jvm, "gradle", ["build", "--", "publish"]), undefined, "past --, the command's words end");
  assert.throws(() => programRequest(jvm, { program: "gradle", args: ["publish"] }), /gradle publish acts on a package repository as an account, which sessions don't have: the jvm tool doesn't run it/);
  assert.throws(() => programRequest(jvm, { program: "java", args: [] }), /program is one of mvn, gradle/);
  const request = programRequest(jvm, { program: "mvn", args: ["test", "$(rm -rf ~)"], directory: "app" });
  assert.deepEqual(request, { tool: "jvm", program: "mvn", directory: "app", args: ["test", "$(rm -rf ~)"] });
  assert.equal(programCommand(jvm, request),
    "cd -- './app' && PATH=\"${PATH:-/usr/bin:/bin}\":'/usr/share/maven/bin':'/opt/gradle/bin' MAVEN_OPTS=-Djava.awt.headless=true NO_COLOR=1 mvn 'test' '$(rm -rf ~)' </dev/null 2>&1");
  const chain: ProgramToolDefinition = { ...jvm, grammar: { ...jvm.grammar, wrap: { launcher: {} } } };
  assert.equal(refusedCommand(chain, "wrap", ["wrap", "wrap", "mvn", "deploy"]), "mvn deploy");
  assert.equal(refusedCommand(chain, "wrap", ["wrap", "wrap", "wrap", "wrap", "wrap", "mvn", "deploy"]), undefined);
  assert.equal(refusedCommand(chain, "wrap", ["sh", "-c", "mvn deploy"]), undefined, "a program outside the definition isn't followed");
});

test("a brokered tool's arguments are checked against its parameters, and its target is what the control plane checks", () => {
  const sources = bundledToolDefinitions.find(item => item.name === "source_read") as BrokeredToolDefinition;
  assert.deepEqual(brokeredArguments(sources, { source: "src-1", item: "  https://www.notion.so/x  " }), { source: "src-1", item: "https://www.notion.so/x" });
  assert.equal(brokeredTarget(sources, { source: "src-1", item: "abc" }), "src-1: abc");
  assert.equal(brokeredTarget(sources, { source: "src-1" }), "src-1");
  assert.throws(() => brokeredArguments(sources, { source: "../x" }), /source must be a source id, as the instructions list it/);
  assert.throws(() => brokeredArguments(sources, { source: "src-1", item: "a\nb" }), /item must be an id or link of one line/);
  assert.throws(() => brokeredArguments(sources, { source: "src-1", item: "   " }), /item must be an id or link of one line/);
  assert.throws(() => brokeredArguments(sources, {}), /source must be a source id/);
  assert.throws(() => brokeredArguments(sources, { source: "src-1", sessionId: "other" }), /source_read takes no sessionId/);
  assert.deepEqual(brokeredArguments(notes, { note: "n-1", line: 3 }), { note: "n-1", line: 3 });
  assert.throws(() => brokeredArguments(notes, { note: "n-1", line: 0 }), /line is not a valid integer/);
  assert.equal(brokeredTarget(notes, { note: "n-1", line: 3 }), "n-1: 3");
});

test("a connector asks for the definitions once a minute, and keeps the last ones while it can't", async () => {
  let now = 0;
  let answer: () => unknown = () => ({ tools: [jvm] });
  let asked = 0;
  const source = new ToolDefinitionsSource(async () => { asked++; return answer(); }, () => now);
  assert.deepEqual((await source.get())?.map(item => item.name), ["jvm"]);
  assert.deepEqual((await source.get())?.map(item => item.name), ["jvm"]);
  assert.equal(asked, 1);
  now += TOOL_DEFINITIONS_TTL_MS;
  answer = () => { throw new Error("404 Not Found"); };
  assert.deepEqual((await source.get())?.map(item => item.name), ["jvm"], "the last read, while it can't be asked");
  assert.equal(asked, 2);
  assert.deepEqual((await source.get())?.map(item => item.name), ["jvm"]);
  assert.equal(asked, 2, "not asked again at once after a failure");
  const fresh = new ToolDefinitionsSource(async () => { throw new Error("404 Not Found"); }, () => now);
  assert.equal(await fresh.get(), undefined, "a control plane that predates them: the bundled ones");
});

test("operations name the tools this server defines, and connectors take the switches of the extensions they name", () => {
  const command = "PATH=\"${PATH:-/usr/bin:/bin}\" cargo 'test' </dev/null 2>&1";
  assert.deepEqual(parseOperation({ kind: "program", tool: "rust", command }), { kind: "program", tool: "rust", command });
  assert.throws(() => parseOperation({ kind: "program", tool: "jvm", command }), "not one this server defines");
  assert.throws(() => parseOperation({ kind: "permission", tool: "notes_read", target: "x", needs: ["tool"] }));
  assert.deepEqual(parseOperation({ kind: "permission", tool: "source_read", target: "x", needs: ["tool"] }), { kind: "permission", tool: "source_read", target: "x", needs: ["tool"] });
  assert.throws(() => validateOperation({ kind: "program", tool: "jvm", command }), /Invalid operation/);
  assert.equal(knownDefinedProgramTool("rust"), true);
  const off = (source: string) => ({ source, enabled: false, tools: "automatic" as const, settings: {} });
  const installed = [{ source: "piki:gh" }];
  assert.deepEqual(connectorWorkspaceExtensions([off("piki:rust")], installed), [], "an older connector doesn't take it");
  assert.deepEqual(connectorWorkspaceExtensions([off("piki:rust")], installed, { toolDefinitions: true }), [off("piki:rust")]);
  assert.deepEqual(connectorWorkspaceExtensions([off("piki:rust")], undefined, { toolDefinitions: true }), [], "nor one that never reported");
  const regular = Array.from({ length: 32 }, (_, index) => ({ source: `npm:extension-${index}@1.0.0` }));
  assert.equal(parseWorkspaceExtensions([...regular, off("piki:jvm")]).length, 33);
  assert.throws(() => parseWorkspaceExtensions([...regular, { source: "npm:one-too-many@1.0.0" }]), /Invalid extensions/);
  const known = pikiSessionToolExtensions().map(item => off(item.source));
  assert.equal(parseWorkspaceExtensions([...regular, ...known, off("piki:jvm"), off("piki:notes")]).length, 32 + known.length + 2);
});

function binding(id: string): RunnerBinding {
  return {
    session: { id, workspaceId: "workspace", ownerId: "test:alice", agentVersionId: "version-1", title: "Defined", policyVersion: 1, status: "ready", createdAt: "2026-01-01T00:00:00Z", repositories: [], repositoryMode: "clone" },
    owner: { id: "test:alice", githubId: null, githubLogin: "alice", displayName: "Alice", gitName: "Alice Owner", gitEmail: "alice@example.test", env: {}, githubConnected: false },
    agent: { id: "version-1", agentId: "agent", authorId: "test:alice", workspaceId: "workspace", version: 1, name: "Agent", description: "", instructions: "Use tools.",
      tools: [...toolNames, "jvm", "notes_read"], modelId: "model-1", createdAt: "2026-01-01T00:00:00Z" },
    model: { id: "model-1", workspaceId: "workspace", name: "Model", provider: "faux", modelId: "faux-1" },
  };
}

async function ticket(id: string, action: RunnerAction): Promise<RunnerTicket> {
  const now = Math.floor(Date.now() / 1000);
  return { aud: "runner", sessionId: id, actorId: "test:alice", ownerId: "test:alice", action, policyVersion: 1, iat: now, exp: now + 60, jti: randomUUID(), bodyHash: await sha256("") };
}

async function idle(session: RunnerSession): Promise<void> {
  for (let count = 0; count < 1000; count++) {
    if (!(await session.view()).busy) return;
    await delay(20);
  }
  assert.fail("runner did not settle");
}

test("a session runs tools the control plane defines that its connector never knew: program and brokered, switched, described, added as they come",
  { skip: process.platform === "win32" }, async t => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "pikibun-defined-")));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const offered: string[][] = [];
  const prompts: string[] = [];
  const noting = (reply: ReturnType<typeof fauxAssistantMessage>) => (context: { messages: { role: string; toolsAdded?: { name: string }[]; toolsRemoved?: { name: string }[] }[] }) => {
    const tools = new Set<string>();
    for (const message of context.messages) {
      if (message.role !== "system") continue;
      for (const tool of message.toolsAdded ?? []) tools.add(tool.name);
      for (const tool of message.toolsRemoved ?? []) tools.delete(tool.name);
    }
    offered.push([...tools]);
    prompts.push(JSON.stringify(context));
    return reply;
  };
  const faux = fauxProvider({ models: [{ id: "faux-1" }] });
  faux.setResponses([
    noting(fauxAssistantMessage([fauxToolCall("jvm", { program: "mvn", args: ["deploy"] })], { stopReason: "toolUse" })),
    fauxAssistantMessage([fauxToolCall("notes_read", { note: "standup", line: 2 })], { stopReason: "toolUse" }),
    fauxAssistantMessage([fauxToolCall("notes_read", { note: "../x" })], { stopReason: "toolUse" }),
    fauxAssistantMessage([fauxToolCall("jvm", { program: "mvn", args: ["test"] })], { stopReason: "toolUse" }),
    fauxAssistantMessage("Asked."),
    noting(fauxAssistantMessage([fauxToolCall("jvm", { program: "mvn", args: ["test"] })], { stopReason: "toolUse" })),
    fauxAssistantMessage("Off."),
  ] as never);
  const models = createModels();
  models.setProvider(faux.provider);
  const shadow: ProgramToolDefinition = { ...jvm, name: "git", programs: ["sh"], grammar: {} };
  let definitions: ToolDefinition[] = [...bundledToolDefinitions, jvm, notes, shadow];
  let answer: WorkspaceExtensionsAnswer = { extensions: [], automaticTools: false };
  const calls: { route: string; request: Record<string, unknown> }[] = [];
  const service = new RunnerService({
    dataDir: directory, sharedSecret: "runner-defined-secret-not-a-production-secret", controlPlaneUrl: "http://127.0.0.1:8787", allowFaux: true, unsandboxed: true,
    authorize: async (input: AuthorizationRequest) => ({ allowed: true, ownerId: input.ownerId, policyVersion: 1 }),
    resolveModels: async model => ({ models, provider: model.provider, modelId: model.modelId }),
    extensions: { installed: () => [], workspace: async () => answer },
    toolDefinitions: async () => definitions,
    brokered: async (route, request) => { calls.push({ route, request }); return { note: request.note, text: "Ship it." }; },
  });
  await service.initialize();
  t.after(() => service.close());
  const id = "defined-session";
  const session = await service.provision(binding(id), await ticket(id, "create"));
  await session.submit(await ticket(id, "submit"), { content: "Deploy.", requestId: "first", admissionId: await sha256("defined first") }, "write");
  await idle(session);
  const approval = (await records(session)).find(record => record.operation.kind === "program" && record.operation.tool === "jvm");
  assert.ok(approval, "the jvm call ran, asking nobody");
  for (const tool of ["jvm", "notes_read", "node", "rust", "source_read", "git"]) assert.ok(offered[0]!.includes(tool), `${tool}: ${offered[0]!.join()}`);
  assert.equal(offered[0]!.filter(tool => tool === "git").length, 1);
  assert.match(prompts[0]!, /Run cargo, rustc, rustup and rustfmt, go and gofmt, dotnet, make, mvn and gradle with the rust, go, dotnet, make, jvm tools/);
  assert.match(prompts[0]!, /Read the workspace's notes with notes_read \{note\}\./);
  assert.deepEqual(approval!.operation, { kind: "program", tool: "jvm",
    command: "PATH=\"${PATH:-/usr/bin:/bin}\":'/usr/share/maven/bin':'/opt/gradle/bin' MAVEN_OPTS=-Djava.awt.headless=true NO_COLOR=1 mvn 'test' </dev/null 2>&1" });
  assert.deepEqual(validateOperation(approval!.operation), approval!.operation, "a tool it read from the control plane is one it validates");
  const transcript = (await session.view()).entries.map(entry => entry.text).join("\n");
  assert.match(transcript, /mvn deploy acts on a package repository as an account, which sessions don't have: the jvm tool doesn't run it/);
  assert.match(transcript, /note is a note's id/);
  assert.match(transcript, /Ship it\./);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.route, "notes/read");
  assert.deepEqual({ ...calls[0]!.request, callId: undefined }, { sessionId: id, actorId: "test:alice", admissionId: await sha256("defined first"), callId: undefined, note: "standup", line: 2 });

  definitions = [...definitions, { ...jvm, name: "lint", extensions: ["piki:lint"], programs: ["eslint"], grammar: {}, summary: undefined }];
  answer = { extensions: [{ source: "piki:jvm", enabled: false, tools: "automatic", settings: {} }], automaticTools: false };
  await session.submit(await ticket(id, "submit"), { content: "Test.", requestId: "second", admissionId: await sha256("defined second") }, "write");
  await idle(session);
  assert.ok(!offered[1]!.includes("jvm"), offered[1]!.join());
  assert.ok(offered[1]!.includes("lint"), offered[1]!.join());
  const count = (text: string, part: string) => text.split(part).length - 1;
  assert.equal(count(prompts[1]!, "mvn and gradle"), count(prompts[0]!, "mvn and gradle"));
  assert.ok(count(prompts[0]!, "mvn and gradle") >= 1);
  assert.match((await session.view()).entries.map(entry => entry.text).join("\n"), /Tool jvm is not available/);
});

test("a tool the control plane defines after the session opened never takes the name of a workspace extension's tool: the extension keeps it (review of #205)",
  { skip: !["linux", "darwin"].includes(process.platform) }, async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "pikibun-defined-clash-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, "shout.ts"), `import { Type } from "typebox";
    export default function (pi) {
      pi.registerTool({ name: "shout", label: "Shout", description: "Shout text.", parameters: Type.Object({ text: Type.String() }),
        async execute(_id, params) { return { content: [{ type: "text", text: params.text.toUpperCase() + "!" }], details: undefined }; } });
    }`);
  const store = new ExtensionStore(join(root, "state"));
  await store.add(parseExtensionSource(join(root, "shout.ts")));
  const [dev] = await loadInstalled(store, []);
  const installed = [{ ...dev!, summary: { ...dev!.summary, source: "npm:shout@1.0.0", dev: false } }];
  const answer: WorkspaceExtensionsAnswer = { extensions: parseWorkspaceExtensions([{ source: "npm:shout@1.0.0" }]), automaticTools: false };
  const faux = fauxProvider({ models: [{ id: "faux-1" }] });
  faux.setResponses([
    fauxAssistantMessage("Opened."),
    fauxAssistantMessage([fauxToolCall("shout", { text: "hi" })], { stopReason: "toolUse" }),
    fauxAssistantMessage("Shouted."),
  ]);
  const models = createModels();
  models.setProvider(faux.provider);
  let definitions: ToolDefinition[] = [...bundledToolDefinitions];
  const service = new RunnerService({
    dataDir: join(root, "runner"), sharedSecret: "runner-defined-clash-secret-not-for-deployment", controlPlaneUrl: "http://127.0.0.1:8787", allowFaux: true, unsandboxed: true,
    authorize: async (input: AuthorizationRequest) => ({ allowed: true, ownerId: input.ownerId, policyVersion: 1 }),
    resolveModels: async model => ({ models, provider: model.provider, modelId: model.modelId }),
    extensions: { installed: () => installed, workspace: async () => answer },
    toolDefinitions: async () => definitions,
  });
  await service.initialize();
  t.after(() => service.close());
  const id = "defined-clash-session";
  const session = await service.provision(binding(id), await ticket(id, "create"));
  await session.submit(await ticket(id, "submit"), { content: "Hello.", requestId: "first", admissionId: await sha256("clash first") }, "write");
  await idle(session);
  definitions = [...definitions, { ...jvm, name: "shout", extensions: ["piki:shout"], programs: ["sh"], grammar: {}, summary: undefined }];
  await session.submit(await ticket(id, "submit"), { content: "Shout.", requestId: "second", admissionId: await sha256("clash second") }, "write");
  await idle(session);
  const view = await session.view();
  assert.ok(!(await records(session)).some(approval => approval.operation.kind === "program"), JSON.stringify(await records(session)));
  assert.match(view.entries.map(entry => entry.text).join("\n"), /shout comes from an extension, which runs on the host's own machine/);
});

test("a name a defined tool took up after the session opened stays its own when an extension that offers it is turned on later (review of #205)",
  { skip: !["linux", "darwin"].includes(process.platform) }, async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "pikibun-defined-first-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, "shout.ts"), `import { Type } from "typebox";
    export default function (pi) {
      pi.registerTool({ name: "shout", label: "Shout", description: "Shout text.", parameters: Type.Object({ text: Type.String() }),
        async execute(_id, params) { return { content: [{ type: "text", text: params.text.toUpperCase() + "!" }], details: undefined }; } });
    }`);
  const store = new ExtensionStore(join(root, "state"));
  await store.add(parseExtensionSource(join(root, "shout.ts")));
  const [dev] = await loadInstalled(store, []);
  const installed = [{ ...dev!, summary: { ...dev!.summary, source: "npm:shout@1.0.0", dev: false } }];
  let answer: WorkspaceExtensionsAnswer = { extensions: [], automaticTools: false };
  const faux = fauxProvider({ models: [{ id: "faux-1" }] });
  faux.setResponses([
    fauxAssistantMessage("Opened."),
    fauxAssistantMessage("Defined."),
    fauxAssistantMessage([fauxToolCall("shout", { program: "echo", args: ["hi"] })], { stopReason: "toolUse" }),
    fauxAssistantMessage("Asked."),
  ]);
  const models = createModels();
  models.setProvider(faux.provider);
  let definitions: ToolDefinition[] = [...bundledToolDefinitions];
  const service = new RunnerService({
    dataDir: join(root, "runner"), sharedSecret: "runner-defined-first-secret-not-for-deployment", controlPlaneUrl: "http://127.0.0.1:8787", allowFaux: true, unsandboxed: true,
    authorize: async (input: AuthorizationRequest) => ({ allowed: true, ownerId: input.ownerId, policyVersion: 1 }),
    resolveModels: async model => ({ models, provider: model.provider, modelId: model.modelId }),
    extensions: { installed: () => installed, workspace: async () => answer },
    toolDefinitions: async () => definitions,
  });
  await service.initialize();
  t.after(() => service.close());
  const id = "defined-first-session";
  const session = await service.provision(binding(id), await ticket(id, "create"));
  await session.submit(await ticket(id, "submit"), { content: "Hello.", requestId: "first", admissionId: await sha256("first first") }, "write");
  await idle(session);
  definitions = [...definitions, { ...jvm, name: "shout", extensions: ["piki:shout"], programs: ["echo"], grammar: {}, summary: undefined }];
  await session.submit(await ticket(id, "submit"), { content: "Define.", requestId: "second", admissionId: await sha256("first second") }, "write");
  await idle(session);
  answer = { extensions: parseWorkspaceExtensions([{ source: "npm:shout@1.0.0" }]), automaticTools: false };
  await session.submit(await ticket(id, "submit"), { content: "Shout.", requestId: "third", admissionId: await sha256("first third") }, "write");
  await idle(session);
  const ran = (await records(session)).at(-1);
  assert.ok(ran, (await session.view()).entries.map(entry => entry.text).join("\n"));
  assert.equal(ran.operation.kind === "program" && ran.operation.tool, "shout", "the defined tool kept its name; the extension's never ran");
});
