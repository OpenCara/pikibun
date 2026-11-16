import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, type FauxResponseFactory } from "@earendil-works/pi-ai/providers/faux";
import { loadInstalled } from "../apps/runner/src/extensions/load.js";
import { ExtensionStore, parseExtensionSource } from "../apps/runner/src/extensions/store.js";
import { RunnerService } from "../apps/runner/src/server.js";
import { COMMAND_FILES, commandFiles, COMPACTED, COMPACTION_STARTED, compactionFailed, NOTHING_TO_COMPACT, parseCommand, piExpansion, SessionCommands,
  type SessionCommandsOptions } from "../apps/runner/src/session/commands.js";
import type { Run } from "../apps/runner/src/session/state.js";
import { sha256 } from "../packages/shared/src/crypto.js";
import { parseWorkspaceExtensions } from "../packages/shared/src/host-extensions.js";
import { parseSessionCommands } from "../packages/shared/src/session-commands.js";
import type { RunnerAction, RunnerBinding } from "../packages/shared/src/types.js";

test("a message is a command when it starts with a slash and a name, whatever follows", () => {
  assert.deepEqual(parseCommand("/compact"), { name: "compact", args: "" });
  assert.deepEqual(parseCommand("/compact keep the API notes\nand the plan"), { name: "compact", args: "keep the API notes\nand the plan" });
  assert.deepEqual(parseCommand("/skill:release  v1.2 "), { name: "skill:release", args: "v1.2" });
  for (const text of ["", "compact", " /compact", "/", "/usr/local/bin is missing", "//comment", "/-x", "say /compact"]) assert.equal(parseCommand(text), undefined, JSON.stringify(text));
});

test("prompt templates and skills are the files Pi would take, in the worktree and one clone down", () => {
  assert.deepEqual(commandFiles([
    "app/.pi/prompts/review.md", ".pi/prompts/review.md", ".pi/prompts/notes.txt", "app/.pi/prompts/deep/nested.md", "app/.pi/prompts/ship it.md",
    "app/.pi/skills/release/SKILL.md", "app/.pi/skills/release/extra/SKILL.md", "app/.pi/skills/release/notes.md", "app/.agents/skills/lint.md",
    ".agents/skills/group/audit/SKILL.md", "app/.pi/skills/SKILL.md", "app/docs/.pi/prompts/deep.md", "app/src/prompts/x.md", "app/.pi/skills/release/",
  ]), [
    { kind: "prompt", name: "review", path: ".pi/prompts/review.md" },
    { kind: "skill", name: "lint", path: "app/.agents/skills/lint.md" },
    { kind: "skill", name: "audit", path: ".agents/skills/group/audit/SKILL.md" },
    { kind: "skill", name: "release", path: "app/.pi/skills/release/SKILL.md" },
  ]);
  assert.match(COMMAND_FILES, /\.pi\/prompts/);
});

test("the list of commands a client gets keeps only well-formed entries", () => {
  assert.deepEqual(parseSessionCommands([
    { name: "compact", kind: "host", description: "Summarize", argument: "instructions" },
    { name: "skill:release", kind: "skill", description: "  two\nlines\u0007 " },
    { name: "compact", kind: "prompt" }, { name: "bad name", kind: "prompt" }, { name: "x", kind: "nope" }, { name: "/x", kind: "prompt" }, null, "x",
    { name: "y".repeat(200), kind: "prompt" }, { name: "long", kind: "extension", description: "d".repeat(500) },
  ]), [
    { name: "compact", kind: "host", description: "Summarize", argument: "instructions" },
    { name: "skill:release", kind: "skill", description: "two lines" },
    { name: "long", kind: "extension", description: "d".repeat(300) },
  ]);
  assert.deepEqual(parseSessionCommands({ name: "compact" }), []);
  assert.deepEqual(parseSessionCommands(undefined), []);
});

function fakeCommands(overrides: Partial<SessionCommandsOptions> = {}) {
  const log: string[] = [];
  const files: Record<string, string> = {
    ".pi/prompts/review.md": "---\ndescription: Review a file\nargument-hint: <file>\n---\nReview $1 closely. All: $ARGUMENTS. Focus: ${2:-everything}",
    "app/.pi/skills/release/SKILL.md": "---\nname: release\ndescription: Cut a release\n---\n# Releasing\n\nRun scripts/tag.sh.\n",
  };
  let now = 0;
  const commands = new SessionCommands({
    compact: async (_run, instructions) => { log.push(`compact ${instructions ?? ""}`.trim()); },
    extensionCommands: async () => [{ source: "npm:greeter@1.0.0", name: "greet", description: "Say hello" }, { source: "npm:greeter@1.0.0", name: "ask" }],
    runExtensionCommand: async (_run, command, args) => {
      log.push(`${command.name} ${args}`);
      if (args === "boom") throw new Error("it broke\nbadly");
      return command.name === "ask" ? { notices: ["ignored"], messages: [`Asked: ${args}`, " "] } : { notices: args ? [`Hello ${args}`] : [], messages: [] };
    },
    find: async () => { log.push("find"); return Object.keys(files); },
    read: async path => { if (!(path in files)) throw new Error("missing"); return files[path]!; },
    expansion: piExpansion,
    now: () => now,
    ...overrides,
  });
  return { commands, log, files, advance: (ms: number) => { now += ms; } };
}

const run = (content: string, extra: Partial<Run> = {}): Run => ({ key: "k", initiatedBy: "test:alice", ownerId: "test:alice", mode: "write", conversationId: 1, content,
  contentHash: "", status: "queued", startEntry: 0, ...extra });

test("a host lists /compact, its extensions' commands, and the worktree's templates and skills once it has looked", async () => {
  const { commands, log } = fakeCommands();
  assert.deepEqual((await commands.list()).map(command => command.name), ["compact", "greet", "ask"], "the first list doesn't wait for the worktree");
  await delay(5);
  assert.deepEqual(await commands.list(), [
    { name: "compact", kind: "host", description: "Summarize the older messages now, to free the model's context", argument: "instructions" },
    { name: "greet", kind: "extension", description: "Say hello" },
    { name: "ask", kind: "extension", description: "A command of npm:greeter@1.0.0" },
    { name: "review", kind: "prompt", description: "Prompt template .pi/prompts/review.md", argument: "arguments" },
    { name: "skill:release", kind: "skill", description: "Skill app/.pi/skills/release/SKILL.md", argument: "arguments" },
  ]);
  await commands.list();
  assert.equal(log.filter(item => item === "find").length, 1, "the worktree is looked at again only after a while");
});

test("/compact and an extension's command run on the host, and never in a side ask or a Read-only message", async () => {
  const { commands, log } = fakeCommands();
  assert.deepEqual(await commands.before(run("/compact keep the plan")), { action: "command", name: "compact", notice: COMPACTION_STARTED });
  assert.deepEqual(await commands.before(run("/greet Ada")), { action: "command", name: "greet", notice: "Hello Ada" });
  assert.deepEqual(await commands.before(run("/greet")), { action: "command", name: "greet", notice: "It ran, and said nothing." });
  assert.deepEqual(await commands.before(run("/ask what next?")), { action: "message", text: "Asked: what next?" }, "what a command sends is the message");
  assert.deepEqual(log, ["compact keep the plan", "greet Ada", "greet ", "ask what next?"]);
  assert.equal(await commands.before(run("/review api.ts")), undefined, "a template isn't run before the extensions screen the message");
  assert.equal(await commands.before(run("hello /compact")), undefined);
  assert.deepEqual(await commands.before(run("/greet boom")), { action: "refused", by: "npm:greeter@1.0.0", notice: "/greet (npm:greeter@1.0.0) failed: it broke badly" });
  for (const extra of [{ mode: "ask" as const }, { options: { access: "read" as const } }]) {
    const compact = await commands.before(run("/compact", extra));
    assert.equal(compact?.action, "refused");
    assert.match(compact!.action === "refused" ? compact!.notice : "", /^\/compact changes the session, which a side ask or a Read-only message doesn't do/);
    const greet = await commands.before(run("/greet Ada", extra));
    assert.match(greet!.action === "refused" ? greet!.notice : "", /^\/greet is a command of an extension \(npm:greeter@1\.0\.0\), which changes the session/);
  }
  assert.equal(log.length, 5, "nothing ran for them");
  const failing = fakeCommands({ compact: async () => { throw new Error("storage is gone"); } });
  assert.deepEqual(await failing.commands.before(run("/compact")), { action: "refused", by: "", notice: "The host couldn't start compacting this conversation. Try again shortly." });
});

test("a template fills in its arguments as Pi does, a skill comes in Pi's block, and other text stays as typed", async () => {
  const { commands, log, files } = fakeCommands();
  assert.equal(await commands.expand('/review api.ts "the auth flow"'), "Review api.ts closely. All: api.ts the auth flow. Focus: the auth flow");
  assert.equal(await commands.expand("/review api.ts"), "Review api.ts closely. All: api.ts. Focus: everything");
  assert.equal(await commands.expand("/skill:release v1.2"),
    '<skill name="release" location="app/.pi/skills/release/SKILL.md">\nReferences are relative to app/.pi/skills/release.\n\n# Releasing\n\nRun scripts/tag.sh.\n</skill>\n\nv1.2');
  assert.equal(log.filter(item => item === "find").length, 1);
  assert.equal(await commands.expand("/release v1.2"), "/release v1.2", "a skill isn't a template");
  assert.equal(await commands.expand("/skill:review"), "/skill:review");
  assert.equal(await commands.expand("/etc/hosts is wrong"), "/etc/hosts is wrong");
  assert.equal(await commands.expand("plain text"), "plain text");
  files[".pi/prompts/new.md"] = "Brand new: $@";
  assert.equal(await commands.expand("/new thing"), "Brand new: thing", "a template added since the last look is found");
  delete files[".pi/prompts/review.md"];
  assert.equal(await commands.expand("/review api.ts"), "/review api.ts", "one that can't be read stays as typed");
});

test("a session runs /compact, extension commands, templates and skills from its messages, and lists them in its view", { skip: !["linux", "darwin"].includes(process.platform) }, async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "pikibun-commands-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, "greeter.ts"), `export default function (pi) {
      pi.registerCommand("greet", { description: "Say hello", handler: async (args, ctx) => { ctx.ui.notify("Hello " + (args || "there")); } });
      pi.registerCommand("ask", { description: "Ask the model", handler: async (args) => { pi.sendUserMessage("Asked: " + args); } });
    }`);
  const store = new ExtensionStore(join(root, "state"));
  await store.add(parseExtensionSource(join(root, "greeter.ts")));
  const [dev] = await loadInstalled(store, []);
  const installed = [{ ...dev!, summary: { ...dev!.summary, source: "npm:greeter@1.0.0", dev: false } }];
  let answer = { extensions: parseWorkspaceExtensions([{ source: "npm:greeter@1.0.0" }]), automaticTools: false };
  const faux = fauxProvider({ models: [{ id: "faux-1", contextWindow: 1_000_000 }] });
  const respond: FauxResponseFactory = async request => {
    faux.appendResponses([respond]);
    const last = request.messages.findLast(message => message.role === "user");
    const said = typeof last?.content === "string" ? last.content : (last?.content ?? []).map(part => part.type === "text" ? part.text : "").join("");
    return fauxAssistantMessage(`saw: ${said.slice(0, 200)}`);
  };
  faux.setResponses([respond]);
  const models = createModels(); models.setProvider(faux.provider);
  const target: RunnerBinding = {
    session: { id: "command-session", workspaceId: "workspace", ownerId: "test:alice", agentVersionId: "version-1", title: "Commands", policyVersion: 1, status: "ready",
      createdAt: "2026-01-01T00:00:00Z", repositories: [], repositoryMode: "clone", connectorId: "host-connector", connectorOwnerId: "test:bob" },
    owner: { id: "test:alice", githubId: null, githubLogin: "alice", displayName: "Alice", gitName: "Alice", gitEmail: "alice@example.test", env: {}, githubConnected: false },
    agent: { id: "version-1", agentId: "agent", authorId: "test:alice", workspaceId: "workspace", version: 1, name: "Agent", description: "", instructions: "Answer.", tools: ["read_file"], modelId: "model-1", createdAt: "2026-01-01T00:00:00Z" },
    model: { id: "model-1", workspaceId: "workspace", name: "Model", provider: "faux", modelId: "faux-1", connectorId: "host-connector", connectorOwnerId: "test:bob" },
  };
  const service = new RunnerService({
    dataDir: join(root, "runner"), sharedSecret: "command-test-secret-not-for-deployment", controlPlaneUrl: "http://127.0.0.1:8787",
    connectorId: "host-connector", allowFaux: true, unsandboxed: true,
    authorize: async input => ({ allowed: true, ownerId: input.ownerId, policyVersion: 1 }),
    resolveModels: async model => ({ models, provider: model.provider, modelId: model.modelId }),
    extensions: { installed: () => installed, workspace: async () => answer },
  });
  await service.initialize();
  t.after(() => service.close());
  const claims = async (action: RunnerAction) => {
    const now = Math.floor(Date.now() / 1000);
    return { aud: "runner" as const, sessionId: target.session.id, actorId: "test:alice", ownerId: "test:alice", action, policyVersion: 1, iat: now, exp: now + 60,
      jti: randomUUID(), bodyHash: await sha256(""), connectorId: "host-connector" };
  };
  const session = await service.provision(target, await claims("create"));
  const worktree = (session as unknown as { sandbox: { hostWorktree: string } }).sandbox.hostWorktree;
  await mkdir(join(worktree, ".pi", "prompts"), { recursive: true });
  await writeFile(join(worktree, ".pi", "prompts", "review.md"), "---\ndescription: Review a file\n---\nReview $1 for $ARGUMENTS");
  await mkdir(join(worktree, "app", ".pi", "skills", "release"), { recursive: true });
  await writeFile(join(worktree, "app", ".pi", "skills", "release", "SKILL.md"), "---\nname: release\ndescription: Cut a release\n---\nRun scripts/tag.sh.");
  let sent = 0;
  const send = async (content: string, access: "read" | "auto" = "auto") => {
    const requestId = `r${sent++}`;
    await session.submit(await claims("submit"), { content, requestId, admissionId: await sha256(requestId), options: { access } }, "write");
    for (let count = 0; count < 500 && (await session.view()).busy; count++) await delay(20);
    return session.view();
  };
  const texts = (view: Awaited<ReturnType<typeof session.view>>, kind: string) => view.entries.filter(entry => entry.kind === kind).map(entry => entry.text);
  const users = (view: Awaited<ReturnType<typeof session.view>>) => view.entries.filter(entry => entry.role === "user").map(entry => entry.text);
  const compacted = async () => {
    for (let count = 0; count < 500; count++) {
      const text = texts(await session.view(), "workspace.run-command").findLast(item => item.startsWith("/compact: "));
      if (text && text !== `/compact: ${COMPACTION_STARTED}`) return text;
      await delay(20);
    }
    return assert.fail("the compaction's outcome never showed");
  };

  let view = await send("hello");
  assert.deepEqual(users(view), ["hello"]);
  for (let count = 0; count < 100 && !(await session.view()).commands?.some(command => command.kind === "skill"); count++) await delay(20);
  assert.deepEqual((await session.view()).commands, [
    { name: "compact", kind: "host", description: "Summarize the older messages now, to free the model's context", argument: "instructions" },
    { name: "greet", kind: "extension", description: "Say hello" },
    { name: "ask", kind: "extension", description: "Ask the model" },
    { name: "review", kind: "prompt", description: "Prompt template .pi/prompts/review.md", argument: "arguments" },
    { name: "skill:release", kind: "skill", description: "Skill app/.pi/skills/release/SKILL.md", argument: "arguments" },
  ]);

  view = await send("/compact keep the plan");
  assert.ok([`/compact: ${COMPACTION_STARTED}`, `/compact: ${NOTHING_TO_COMPACT}`].includes(texts(view, "workspace.run-command")[0]!), texts(view, "workspace.run-command").join("\n"));
  assert.equal(texts(view, "workspace.run-command").length, 1);
  assert.deepEqual(users(view), ["hello"], "the command isn't a message to the model");
  assert.equal(view.queue?.at(-1)?.status, "command");
  assert.equal(view.activity, "done", "the session's status is the last message's, not the command's");
  assert.equal(view.entries.find(entry => entry.kind === "workspace.run-command")?.actorId, "test:alice");
  assert.equal(await compacted(), `/compact: ${NOTHING_TO_COMPACT}`, "the line ends with how the compaction went");

  view = await send("/greet Ada");
  assert.match(texts(view, "workspace.run-refused").at(-1)!, /^\/greet is a command of an extension \(npm:greeter@1\.0\.0\), which runs on the host's own machine/,
    "the session's owner has no host command grant on this host");
  answer = { ...answer, automaticTools: true };
  await delay(10);
  view = await send("/greet Ada");
  assert.equal(texts(view, "workspace.run-command").at(-1), "/greet: Hello Ada");
  view = await send("/ask what next?");
  assert.equal(users(view).at(-1), "Asked: what next?");
  assert.match(view.entries.at(-1)!.text, /saw: Asked: what next\?/);

  view = await send("/review api.ts");
  assert.equal(users(view).at(-1), "Review api.ts for api.ts");
  view = await send("/skill:release v1.2");
  assert.equal(users(view).at(-1), '<skill name="release" location="app/.pi/skills/release/SKILL.md">\nReferences are relative to app/.pi/skills/release.\n\nRun scripts/tag.sh.\n</skill>\n\nv1.2');
  view = await send("/nope stays as typed");
  assert.equal(users(view).at(-1), "/nope stays as typed");
  view = await send("/usr/bin/env is missing");
  assert.equal(users(view).at(-1), "/usr/bin/env is missing");

  view = await send("/compact", "read");
  assert.match(texts(view, "workspace.run-refused").at(-1)!, /^\/compact changes the session, which a side ask or a Read-only message doesn't do/);
  view = await send("/review notes.md", "read");
  assert.equal(users(view).at(-1), "Review notes.md for notes.md", "a template is only text, so a Read-only message takes it");
  assert.equal(texts(view, "workspace.run-command").length, 2);

  for (let index = 0; index < 3; index++) await send(`${index} ${"x".repeat(99_000)}`);
  view = await send("/compact keep the numbers");
  assert.equal(await compacted(), `/compact: ${COMPACTED}`);
  view = await session.view();
  assert.ok(view.entries.some(entry => /compaction/.test(entry.kind)), `the summary is in the transcript: ${view.entries.map(entry => entry.kind).join(", ")}`);
  assert.equal(texts(view, "workspace.run-command").length, 3);
  assert.equal(compactionFailed("529 overloaded\nretry later"), "Compaction failed: 529 overloaded retry later. The conversation is as it was.");
});
