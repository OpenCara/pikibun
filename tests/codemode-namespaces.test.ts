import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxToolCall, type FauxResponseFactory } from "@earendil-works/pi-ai/providers/faux";
import { defineTool, type ToolRegistration } from "@earendil-works/pi-durable";
import { obj } from "@earendil-works/pi-schema";
import { SessionExtensions, type ExtensionHost } from "../apps/runner/src/extensions/adapter.js";
import { loadInstalled } from "../apps/runner/src/extensions/load.js";
import { ExtensionStore, parseExtensionSource } from "../apps/runner/src/extensions/store.js";
import { RunnerService } from "../apps/runner/src/server.js";
import { extensionNamespace, namespaceExtensions, remoteNamespaces, reservedNamespaceKeys, selectedNamespaces, sessionNamespaces, toolNamespaces } from "../apps/runner/src/session/namespaces.js";
import { sha256 } from "../packages/shared/src/crypto.js";
import { parseWorkspaceExtensions, parseWorkspaceExtensionsAnswer } from "../packages/shared/src/host-extensions.js";
import { parseRemoteMcpServers, remoteMcpDefinitions, remoteMcpRoutePrefix } from "../packages/shared/src/remote-mcp.js";
import { bundledToolDefinitions, type BrokeredToolDefinition } from "../packages/shared/src/tool-definitions.js";
import { toolNames, type RunnerAction, type RunnerBinding } from "../packages/shared/src/types.js";

const tool = (name: string): ToolRegistration => defineTool({ name, description: `The ${name} tool.`, parameters: obj({}, { open: true }),
  execute: async () => ({ output: [{ type: "text", text: name }] }) });

const tracker = remoteMcpDefinitions({ name: "Tracker", prefix: "tracker", readOnlyTools: ["search_issues"], tools: [
  { name: "search_issues", description: "Search the tracker's issues.", inputSchema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] } },
] });

test("Pikibun's own tools, defined programs and each remote MCP server's tools fall into their namespaces, in an order that doesn't depend on the tools'", () => {
  const tools = ["identity", "read", "git", "python", "node", "jvm_tool", "git_push", "github_read", "gh_like", "schedule", "sessions", "browser", "tunnel", "publish_artifact",
    "source_read", "workspace", "tracker_search_issues", "other_search"].map(tool);
  const other = remoteMcpDefinitions({ name: "files", prefix: "other", readOnlyTools: [], tools: [{ name: "search", description: "", inputSchema: { type: "object" } }] });
  const definitions = [...bundledToolDefinitions, { ...bundledToolDefinitions.find(item => item.name === "node")!, name: "jvm_tool" }, ...tracker, ...other];
  const namespaces = toolNamespaces(tools, definitions, [{ prefix: "tracker", name: "Tracker" }, { prefix: "other", name: "files" }]);
  const of = (name: string) => namespaces.get(name)?.name;
  assert.deepEqual(["identity", "read"].map(of), ["files", "files"]);
  assert.deepEqual(["git", "python", "node", "jvm_tool"].map(of), ["programs", "programs", "programs", "programs"], "a program the control plane defines runs with the others");
  assert.deepEqual(["git_push", "github_read"].map(of), ["github", "github"]);
  assert.deepEqual(["schedule", "sessions", "browser", "tunnel", "publish_artifact", "source_read", "workspace"].map(of),
    ["sessions", "sessions", "browser", "browser", "artifacts", "documents", "workspace"]);
  assert.equal(of("tracker_search_issues"), "Tracker", "a remote MCP server's tools land in its own namespace, by its name");
  assert.equal(of("other_search"), "mcp_other", "a server whose name another namespace has keeps its prefix");
  assert.match(namespaces.get("tracker_search_issues")!.description, /^The workspace's remote MCP server Tracker: its tools, named tracker_\*/);
  assert.equal(of("gh_like"), undefined, "a tool no one groups stays ungrouped");

  const groups = namespaceExtensions(tools, namespaces);
  assert.deepEqual(groups.map(group => group.name), ["workspace-tools:Tracker", "workspace-tools:artifacts", "workspace-tools:browser", "workspace-tools:documents",
    "workspace-tools:files", "workspace-tools:github", "workspace-tools:mcp_other", "workspace-tools:programs", "workspace-tools:sessions", "workspace-tools:workspace"]);
  assert.deepEqual(groups.find(group => group.namespace?.name === "programs")!.tools!.map(item => item.name), ["git", "python", "node", "jvm_tool"], "tools keep their order");
  assert.ok(groups.every(group => !group.hooks?.length), "the hooks stay on workspace-tools alone");
  const reversed = namespaceExtensions([...tools].reverse(), namespaces);
  assert.deepEqual(reversed.map(group => group.name), groups.map(group => group.name));
  assert.deepEqual(selectedNamespaces(groups, ["read", "browser"]).map(group => group.namespace!.name), ["browser", "files"], "a namespace none of whose tools is on is left out");
});

test("remote MCP servers and workspace Pi extensions get namespaces that don't take another's name", () => {
  assert.equal(remoteMcpRoutePrefix("mcp/tracker/0123456789abcdef"), "tracker");
  assert.equal(remoteMcpRoutePrefix("sources/read"), undefined);
  assert.deepEqual(parseRemoteMcpServers([{ prefix: "tracker", name: "Issue\ntracker " }, { prefix: "Bad", name: "x" }, { prefix: "tracker", name: "again" }, "x", { prefix: "docs", name: "" }]),
    [{ prefix: "tracker", name: "Issue tracker" }, { prefix: "docs", name: "docs" }]);
  assert.deepEqual(parseWorkspaceExtensionsAnswer({ extensions: [], automaticTools: false, remoteTools: tracker, remoteServers: [{ prefix: "tracker", name: "Tracker" }] }).remoteServers,
    [{ prefix: "tracker", name: "Tracker" }]);
  assert.equal(parseWorkspaceExtensionsAnswer({ extensions: [], automaticTools: false }).remoteServers, undefined);
  const remote = remoteNamespaces([{ prefix: "b", name: "Same" }, { prefix: "a", name: "same" }, { prefix: "c", name: "GitHub" }], ["c", "b", "a", "d"]);
  assert.deepEqual([...remote].map(([prefix, namespace]) => [prefix, namespace.name]), [["a", "same"], ["b", "mcp_b"], ["c", "mcp_c"], ["d", "mcp_d"]],
    "by prefix, so the first name stays the same whatever order the tools come in");
  const clash = remoteNamespaces([{ prefix: "a", name: "mcp_b" }, { prefix: "b", name: "files" }], ["a", "b"]);
  assert.deepEqual([...clash].map(([prefix, namespace]) => [prefix, namespace.name]), [["a", "mcp_b"], ["b", "mcp_b_2"]],
    "a fallback another server's name took gets a suffix, so two servers never share a namespace");

  assert.equal(extensionNamespace("piki:gh", { name: "GitHub CLI" }, reservedNamespaceKeys), sessionNamespaces.github, "gh joins Pikibun's github tools");
  assert.equal(extensionNamespace("piki:glab", {}, reservedNamespaceKeys)!.name, "gitlab");
  assert.deepEqual(extensionNamespace("npm:pi-shout@1.0.0", { name: "pi-shout", description: "Shouts text.\nLoudly." }, reservedNamespaceKeys),
    { name: "pi-shout", description: "Shouts text. Loudly." });
  assert.deepEqual(extensionNamespace("npm:pi-quiet@1.0.0", { name: "pi-quiet" }, reservedNamespaceKeys), { name: "pi-quiet", description: "The tools of the Pi extension pi-quiet." });
  assert.equal(extensionNamespace("npm:files@1.0.0", { name: "Files" }, reservedNamespaceKeys), undefined, "a name Pikibun's tools have isn't taken");
  assert.equal(extensionNamespace("npm:tracker@1.0.0", { name: "tracker" }, new Set(["tracker"])), undefined);
  assert.equal(extensionNamespace("local:/x/shout.ts", {}, reservedNamespaceKeys), undefined, "nor one without a name");
});

test("a workspace extension's namespace follows the names taken, and a variant the registry no longer holds is installed again when it comes back",
  { skip: !["linux", "darwin"].includes(process.platform) }, async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "pikibun-namespace-variants-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = join(root, "shout.ts");
  await writeFile(file, `import { Type } from "typebox";
    export default function (pi) {
      pi.registerTool({ name: "shout", label: "Shout", description: "Shout text.", parameters: Type.Object({}), async execute() { return { content: [], details: undefined }; } });
    }`);
  const summary = { source: "local:shout", dev: true, name: "shouter", modules: [{ path: "shout.ts", tools: [{ name: "shout", description: "" }], events: [], flags: [], noops: [], ignored: [] }] };
  const host: ExtensionHost = { directory: root, model: () => undefined, state: async () => ({ active: true, settings: {} }),
    runTool: async (_call, execute) => execute(new AbortController().signal), hookTimeoutMs: 5000, warn: () => {} };
  const session = new SessionExtensions(host, []);
  t.after(() => session.shutdown());
  await session.ensure([{ installed: { source: "local:shout" }, root, files: [file], summary } as never]);
  const named = session.select(["local:shout"]);
  assert.equal(named.selected[0]!.extension.namespace?.name, "shouter");
  assert.deepEqual(named.created, [named.selected[0]!.extension]);
  const taken = session.select(["local:shout"], ["shouter"]);
  assert.equal(taken.selected[0]!.extension.namespace, undefined, "a name another namespace has leaves its tools ungrouped");
  assert.equal(taken.selected[0]!.extension.name, named.selected[0]!.extension.name, "under the same registry name");
  assert.deepEqual(taken.created, [taken.selected[0]!.extension]);
  const back = session.select(["local:shout"]);
  assert.equal(back.selected[0]!.extension, named.selected[0]!.extension, "the cached variant comes back");
  assert.deepEqual(back.created, [named.selected[0]!.extension], "and is installed again, as the registry holds the other under its name");
  assert.deepEqual(session.select(["local:shout"]).created, [], "not while the registry holds it");
});

test("a session's code mode section lists its tools by namespace, the same from turn to turn, and scripts find them with describeNamespace and searchTools",
  { skip: !["linux", "darwin"].includes(process.platform) }, async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "pikibun-namespaces-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, "shout.ts"), `import { Type } from "typebox";
    export default function (pi) {
      pi.registerTool({ name: "shout", label: "Shout", description: "Shout text.", parameters: Type.Object({ text: Type.String() }),
        async execute(_id, params) { return { content: [{ type: "text", text: params.text.toUpperCase() + "!" }], details: undefined }; } });
    }`);
  const store = new ExtensionStore(join(root, "state"));
  await store.add(parseExtensionSource(join(root, "shout.ts")));
  const [dev] = await loadInstalled(store, []);
  const installed = [{ ...dev!, summary: { ...dev!.summary, source: "npm:pi-shout@1.0.0", dev: false, name: "pi-shout", description: "Shouts text, loudly." } }];
  const remoteTools: BrokeredToolDefinition[] = tracker;
  const answer = { extensions: parseWorkspaceExtensions([{ source: "npm:pi-shout@1.0.0" }]), automaticTools: true, remoteTools, remoteServers: [{ prefix: "tracker", name: "Tracker" }] };
  const script = [
    "const files = await describeNamespace('files');",
    "const tracker = await describeNamespace('Tracker');",
    "const shout = await describeNamespace('pi-shout');",
    "const issues = await searchTools('search issues', { namespace: 'Tracker' });",
    "const git = await searchTools('commit with git', { namespace: 'programs' });",
    "const elsewhere = await searchTools('shout text', { namespace: 'programs' });",
    "return JSON.stringify({ files: files.tools, filesDescription: files.description, tracker: tracker.tools, shout: shout.tools,",
    "  issues: issues.map(item => item.name), git: git.map(item => item.name), elsewhere: elsewhere.map(item => item.name) });",
  ].join("\n");
  const sections: string[] = [];
  const faux = fauxProvider({ models: [{ id: "faux-1" }] });
  const respond: FauxResponseFactory = async request => {
    faux.appendResponses([respond]);
    const shown = new Map<string, string>();
    for (const message of request.messages) {
      if (message.role !== "system" || !("sections" in message) || !message.sections) continue;
      for (const [key, value] of Object.entries(message.sections as Record<string, string | null>)) {
        if (value === null) shown.delete(key); else shown.set(key, value);
      }
    }
    sections.push(shown.get("codemode") ?? "");
    const last = request.messages.findLast(message => message.role !== "system");
    if (last?.role === "toolResult") return fauxAssistantMessage(`done: ${last.content.map(part => part.type === "text" ? part.text : "").join("")}`);
    return fauxAssistantMessage(fauxToolCall("codemode", { code: script }), { stopReason: "toolUse" });
  };
  faux.setResponses([respond]);
  const models = createModels(); models.setProvider(faux.provider);
  const target: RunnerBinding = {
    session: { id: "namespace-session", workspaceId: "workspace", ownerId: "test:alice", agentVersionId: "version-1", title: "Namespaces", policyVersion: 1, status: "ready",
      createdAt: "2026-01-01T00:00:00Z", repositories: [], repositoryMode: "clone", connectorId: "host-connector", connectorOwnerId: "test:bob" },
    owner: { id: "test:alice", githubId: null, githubLogin: "alice", displayName: "Alice", gitName: "Alice", gitEmail: "alice@example.test", env: {}, githubConnected: false },
    agent: { id: "version-1", agentId: "agent", authorId: "test:alice", workspaceId: "workspace", version: 1, name: "Agent", description: "", instructions: "Use tools.",
      tools: [...toolNames], modelId: "model-1", createdAt: "2026-01-01T00:00:00Z" },
    model: { id: "model-1", workspaceId: "workspace", name: "Model", provider: "faux", modelId: "faux-1", connectorId: "host-connector", connectorOwnerId: "test:bob" },
  };
  const service = new RunnerService({
    dataDir: join(root, "runner"), sharedSecret: "namespace-test-secret-not-for-deployment-00", controlPlaneUrl: "http://127.0.0.1:8787",
    connectorId: "host-connector", allowFaux: true, unsandboxed: true,
    authorize: async input => ({ allowed: true, ownerId: input.ownerId, policyVersion: 1 }),
    resolveModels: async model => ({ models, provider: model.provider, modelId: model.modelId }),
    extensions: { installed: () => installed, workspace: async () => answer },
    toolDefinitions: async () => bundledToolDefinitions,
    brokered: async () => ({ result: "3 issues" }),
  });
  await service.initialize();
  t.after(() => service.close());
  const claims = async (action: RunnerAction) => {
    const now = Math.floor(Date.now() / 1000);
    return { aud: "runner" as const, sessionId: target.session.id, actorId: "test:alice", ownerId: "test:alice", action, policyVersion: 1, iat: now, exp: now + 60,
      jti: randomUUID(), bodyHash: await sha256(""), connectorId: "host-connector" };
  };
  const session = await service.provision(target, await claims("create"));
  const send = async (content: string) => {
    await session.submit(await claims("submit"), { content, requestId: content, admissionId: await sha256(content) }, "write");
    for (let count = 0; count < 500 && (await session.view()).busy; count++) await delay(20);
  };

  await send("first");
  const section = sections[0]!;
  const headings = [...section.matchAll(/^## (.+)$/gm)].map(match => match[1]);
  assert.deepEqual(headings, ["documents", "files", "github", "pi-shout", "programs", "sessions", "Tracker"], section);
  assert.ok(section.includes(`## files\n${sessionNamespaces.files.description}`));
  assert.ok(section.includes("## pi-shout\nShouts text, loudly."));
  assert.match(section, /## Tracker\nThe workspace's remote MCP server Tracker/);
  assert.ok(section.indexOf("### `identity`") > section.indexOf("## files") && section.indexOf("### `identity`") < section.indexOf("## github"), "identity is listed under files");
  assert.ok(section.indexOf("### `shout`") > section.indexOf("## pi-shout"), "a workspace extension's tool is listed under its namespace");
  assert.ok(section.indexOf("### `tracker_search_issues`") > section.indexOf("## Tracker"), "a remote MCP server's tool under its server's");
  assert.ok(!/^### /m.test(section.slice(0, section.indexOf("## documents"))), "no session tool is left ungrouped");
  assert.doesNotMatch(section, /^## (browser|artifacts|workspace)$/m, "a namespace whose tools are all off isn't listed");

  const result = (await session.view()).entries.filter(entry => entry.role === "toolResult").map(entry => entry.text).at(-1)!;
  const found = JSON.parse(/\{"files"[\s\S]*\}/.exec(result)?.[0] ?? "null") as Record<string, unknown>;
  assert.ok(found, result);
  assert.deepEqual(found.files, ["identity", "read", "ls", "grep", "find", "write", "edit", "move_file", "copy_file", "delete_file"],
    "describeNamespace finds the tools the section leaves out for space");
  assert.equal(found.filesDescription, sessionNamespaces.files.description);
  assert.deepEqual(found.tracker, ["tracker_search_issues"]);
  assert.deepEqual(found.shout, ["shout"]);
  assert.deepEqual(found.issues, ["tracker_search_issues"]);
  assert.equal((found.git as string[])[0], "git");
  assert.ok(!(found.elsewhere as string[]).includes("shout"), "a namespace's search finds only its own tools");

  await send("second");
  assert.ok(sections.length >= 4);
  assert.ok(sections.every(item => item === section), "the section stays the same from turn to turn while the tools do");
});
