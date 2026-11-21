import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { getSystemMessageText } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, type FauxResponseFactory } from "@earendil-works/pi-ai/providers/faux";
import { connectorPikiExtension, managedSource } from "../apps/runner/src/extensions/piki/index.js";
import { RunnerService } from "../apps/runner/src/server.js";
import { agentInstructions } from "../apps/runner/src/session/instructions.js";
import { piText } from "../apps/runner/src/session/pi-text.js";
import { MAX_DESCRIPTION, readSkills, SessionSkills, skillBlock, skillCandidates, SKILL_FILES, skillsPrompt, type Skill } from "../apps/runner/src/session/skills.js";
import { sha256 } from "../packages/shared/src/crypto.js";
import { parseWorkspaceExtensions, withSessionToolsListed } from "../packages/shared/src/host-extensions.js";
import { extensionSwitchOn, pikiExtension, sessionToolsOff } from "../packages/shared/src/piki-extensions.js";
import type { RunnerAction, RunnerBinding } from "../packages/shared/src/types.js";

test("skills are the files Pi would take, under .pi, .agents or .claude, in the worktree and one clone down", () => {
  assert.equal(SKILL_FILES, "{,*/}{.pi,.agents,.claude}/skills/{*.md,**/SKILL.md}");
  assert.deepEqual(skillCandidates([
    "app/.pi/skills/release/SKILL.md", "app/.pi/skills/release/extra/SKILL.md", "app/.pi/skills/release/notes.md", "app/.agents/skills/lint.md",
    ".agents/skills/group/audit/SKILL.md", "app/.pi/skills/SKILL.md", "app/.pi/prompts/review.md", "app/.claude/skills/deploy/SKILL.md", "app/.pi/skills/release/",
    "app/.pi/skills/.hidden/SKILL.md", "app/.pi/skills/vendor/node_modules/x/SKILL.md", "app/.pi/skills/.draft.md", "app/docs/.pi/skills/deep/SKILL.md",
  ]), [
    { path: "app/.agents/skills/lint.md", owner: "app", fallback: "lint", declared: false },
    { path: ".agents/skills/group/audit/SKILL.md", owner: "", fallback: "audit", declared: true },
    { path: "app/.claude/skills/deploy/SKILL.md", owner: "app", fallback: "deploy", declared: true },
    { path: "app/.pi/skills/release/SKILL.md", owner: "app", fallback: "release", declared: true },
  ], "a skill's own folders hold no further skills, and folders that start with a dot or are node_modules are skipped, as in Pi");
});

const frontmatter = async () => (await piText()).frontmatter;
const candidate = (path: string, declared = path.endsWith("/SKILL.md")) =>
  ({ path, owner: path.split("/")[0]!.startsWith(".") ? "" : path.split("/")[0]!, fallback: declared ? path.split("/").at(-2)! : path.split("/").at(-1)!.slice(0, -3), declared });

test("a skill's name and description are its front matter's, as in Pi", async () => {
  const parse = await frontmatter();
  assert.deepEqual(readSkills([
    { candidate: candidate("app/.pi/skills/cutting/SKILL.md"), content: "---\nname: release\ndescription: |\n  Cut a release,\n  and tag it.\n---\nBody" },
    { candidate: candidate("app/.pi/skills/plain/SKILL.md"), content: "No front matter at all" },
    { candidate: candidate("app/.pi/skills/manual/SKILL.md"), content: "---\ndescription: Only when asked\ndisable-model-invocation: true\n---\nBody" },
    { candidate: candidate("app/.pi/skills/notes.md"), content: "# Notes without a description" },
    { candidate: candidate("app/.pi/skills/lint.md"), content: "---\ndescription: Lint the code\n---\nRun the linter." },
    { candidate: candidate("app/.pi/skills/odd/SKILL.md"), content: "---\nname: has spaces\ndescription: A name that isn't one\n---\n" },
    { candidate: candidate("app/.pi/skills/broken/SKILL.md"), content: "---\ndescription: [unclosed\n---\n" },
  ], parse), [
    { name: "release", title: "release", path: "app/.pi/skills/cutting/SKILL.md", description: "Cut a release, and tag it.", listed: true },
    { name: "plain", title: "plain", path: "app/.pi/skills/plain/SKILL.md", listed: false },
    { name: "manual", title: "manual", path: "app/.pi/skills/manual/SKILL.md", description: "Only when asked", listed: false },
    { name: "lint", title: "lint", path: "app/.pi/skills/lint.md", description: "Lint the code", listed: true },
    { name: "odd", title: "odd", path: "app/.pi/skills/odd/SKILL.md", description: "A name that isn't one", listed: true },
    { name: "broken", title: "broken", path: "app/.pi/skills/broken/SKILL.md", listed: false },
  ], "a SKILL.md without a description answers to /skill: but isn't listed; a loose file without one isn't a skill; disable-model-invocation keeps one off the list");
  assert.deepEqual(readSkills([
    { candidate: candidate("web/.pi/skills/a/SKILL.md"), content: "---\nname: ship\ndescription: Ship the web app\n---\n" },
    { candidate: candidate("api/.pi/skills/b/SKILL.md"), content: "---\nname: ship\ndescription: Ship the API\n---\n" },
    { candidate: candidate("api/.agents/skills/ship.md"), content: "---\ndescription: Shadowed in its own clone\n---\n" },
  ], parse).map(skill => [skill.name, skill.title, skill.path]), [
    ["web:ship", "ship", "web/.pi/skills/a/SKILL.md"],
    ["api:ship", "ship", "api/.pi/skills/b/SKILL.md"],
  ], "names from front matter are qualified as folder names were: a clone's first file of a name wins, and a name two clones claim goes under each clone's name");
  assert.equal(readSkills([{ candidate: candidate("app/.pi/skills/long/SKILL.md"), content: `---\ndescription: ${"d".repeat(5000)}\n---\n` }], parse)[0]!.description!.length,
    MAX_DESCRIPTION);
});

const skill = (name: string, description: string | undefined, listed = true): Skill =>
  ({ name, title: name, path: `app/.pi/skills/${name}/SKILL.md`, ...(description ? { description } : {}), listed });

test("the model's list names each skill it may load, escaped and bounded", () => {
  assert.equal(skillsPrompt([]), "");
  assert.equal(skillsPrompt([skill("manual", "Only when asked", false), skill("bare", undefined, false)]), "");
  const prompt = skillsPrompt([skill("release", "Cut a <release> & \"tag\" it"), skill("manual", "Only when asked", false)]);
  assert.match(prompt, /^## Skills\n/);
  assert.match(prompt, /read its file with read/);
  assert.match(prompt, /There is no shell/);
  assert.ok(prompt.includes("<available_skills>\n  <skill>\n    <name>release</name>\n    <description>Cut a &lt;release&gt; &amp; &quot;tag&quot; it</description>\n"
    + "    <location>app/.pi/skills/release/SKILL.md</location>\n  </skill>\n</available_skills>"), prompt);
  assert.doesNotMatch(prompt, /manual/);
  const many = Array.from({ length: 40 }, (_, index) => skill(`s${index}`, "x".repeat(100)));
  const cut = skillsPrompt(many, 2_000);
  assert.ok(cut.length < 2_200, String(cut.length));
  assert.match(cut, /\d+ more skills aren't listed, over the limit of 2000 characters/);
});

test("a skill sent with /skill: comes in Pi's block", () => {
  assert.equal(skillBlock({ title: "release", path: "app/.pi/skills/release/SKILL.md" }, "\nRun scripts/tag.sh.\n", "v1.2"),
    '<skill name="release" location="app/.pi/skills/release/SKILL.md">\nReferences are relative to app/.pi/skills/release.\n\nRun scripts/tag.sh.\n</skill>\n\nv1.2');
  assert.equal(skillBlock({ title: 'say "hi"', path: ".pi/skills/x.md" }, "Body", ""), "<skill name=\"say 'hi'\" location=\".pi/skills/x.md\">\nReferences are relative to .pi/skills.\n\nBody\n</skill>");
});

test("a session's skills are read through its file access, looked at again when stale, and given time-bounded for a prompt", async () => {
  const files: Record<string, string> = { "app/.pi/skills/release/SKILL.md": "---\ndescription: Cut a release\n---\nRun scripts/tag.sh." };
  const log: string[] = [];
  let now = 0;
  let stall: Promise<void> | undefined;
  const skills = new SessionSkills({
    find: async () => { log.push("find"); await stall; return Object.keys(files); },
    read: async path => { log.push(`read ${path}`); if (!(path in files)) throw new Error("gone"); return files[path]!; },
    text: piText, now: () => now,
  });
  assert.deepEqual(skills.listed(), [], "the first list doesn't wait");
  await delay(5);
  assert.deepEqual(skills.listed().map(item => item.name), ["release"]);
  files["app/.agents/skills/lint/SKILL.md"] = "---\ndescription: Lint\n---\n";
  assert.deepEqual(skills.listed().map(item => item.name), ["release"], "within two minutes, what it found last");
  assert.deepEqual((await skills.current()).map(item => item.name), ["lint", "release"], "a prompt looks again");
  assert.equal(await skills.expand("lint", "now"), "<skill name=\"lint\" location=\"app/.agents/skills/lint/SKILL.md\">\nReferences are relative to app/.agents/skills/lint.\n\n\n</skill>\n\nnow");
  assert.equal(await skills.expand("nope", ""), undefined);
  delete files["app/.agents/skills/lint/SKILL.md"];
  assert.equal(await skills.expand("lint", ""), undefined, "one that can't be read stays as typed");
  let release!: () => void;
  stall = new Promise(resolve => { release = resolve; });
  now += 1;
  const started = Date.now();
  assert.deepEqual((await skills.current(50)).map(item => item.name), ["lint", "release"], "a slow look gives way to the last list");
  assert.ok(Date.now() - started < 1_000);
  release();
  await delay(5);
  assert.deepEqual(skills.known().map(item => item.name), ["release"]);
  now += 200_000;
  log.length = 0;
  skills.listed();
  await delay(5);
  assert.ok(log.includes("find"), "a stale list is looked at again");
});

test("piki:skills is the workspace's switch for listing skills: off until added, with no package and no tools", () => {
  const info = pikiExtension("piki:skills")!;
  assert.equal(info.optIn, true);
  assert.deepEqual(info.sessionTools, []);
  assert.equal(extensionSwitchOn("piki:skills", []), false);
  assert.equal(extensionSwitchOn("piki:skills", [{ source: "piki:skills", enabled: false }]), false);
  assert.equal(extensionSwitchOn("piki:skills", [{ source: "piki:skills", enabled: true }]), true);
  assert.deepEqual(withSessionToolsListed([]).filter(item => item.source === "piki:skills"), [{ source: "piki:skills", enabled: false, tools: "automatic", settings: {} }],
    "the Pikibun server lists it, off, for every workspace");
  assert.deepEqual([...sessionToolsOff([{ source: "piki:skills", enabled: true }])].filter(tool => tool === "skill"), []);
  assert.ok(connectorPikiExtension("piki:skills"), "every connector has it built in");
  assert.equal(managedSource("piki:skills"), false, "nothing to fetch from npm");
});

const base = { base: "Base.", agentTools: [], mode: "write" as const, off: new Set<string>(), browserUnavailable: undefined, tunnelUnavailable: undefined,
  kindsOff: new Set<never>(), extensionTools: new Set<string>(), clone: false, sandboxed: false, branch: "b", cloneRepositories: [], lfsRepositories: [],
  cloneFailures: [], definitions: [], sources: [], conversationOnlyRestore: false, missing: [], linuxSandbox: false, nodeBin: false, codemode: false, browser: false };

test("the instructions list skills only where the session can read their files", () => {
  const listed = [skill("release", "Cut a release")];
  assert.match(agentInstructions({ ...base, tools: ["read"], skills: listed }), /<available_skills>/);
  assert.match(agentInstructions({ ...base, mode: "read", tools: ["read"], skills: listed }), /<available_skills>/);
  assert.doesNotMatch(agentInstructions({ ...base, tools: [], skills: listed }), /<available_skills>/);
  assert.doesNotMatch(agentInstructions({ ...base, tools: ["read"] }), /## Skills/);
});

test("a session lists its worktree's skills in the system prompt only where the workspace turned on piki:skills", { skip: !["linux", "darwin"].includes(process.platform) }, async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "pikibun-skills-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  let answer = { extensions: parseWorkspaceExtensions([]), automaticTools: false };
  const prompts: string[] = [];
  const faux = fauxProvider({ models: [{ id: "faux-1", contextWindow: 1_000_000 }] });
  const respond: FauxResponseFactory = async request => {
    faux.appendResponses([respond]);
    prompts.push(request.messages.flatMap(message => message.role === "system" ? [getSystemMessageText(message)] : []).join("\n"));
    return fauxAssistantMessage("ok");
  };
  faux.setResponses([respond]);
  const models = createModels(); models.setProvider(faux.provider);
  const target: RunnerBinding = {
    session: { id: "skills-session", workspaceId: "workspace", ownerId: "test:alice", agentVersionId: "version-1", title: "Skills", policyVersion: 1, status: "ready",
      createdAt: "2026-01-01T00:00:00Z", repositories: [], repositoryMode: "clone", connectorId: "host-connector", connectorOwnerId: "test:alice" },
    owner: { id: "test:alice", githubId: null, githubLogin: "alice", displayName: "Alice", gitName: "Alice", gitEmail: "alice@example.test", env: {}, githubConnected: false },
    agent: { id: "version-1", agentId: "agent", authorId: "test:alice", workspaceId: "workspace", version: 1, name: "Agent", description: "", instructions: "Answer.", tools: ["read_file"], modelId: "model-1", createdAt: "2026-01-01T00:00:00Z" },
    model: { id: "model-1", workspaceId: "workspace", name: "Model", provider: "faux", modelId: "faux-1", connectorId: "host-connector", connectorOwnerId: "test:alice" },
  };
  const service = new RunnerService({
    dataDir: join(root, "runner"), sharedSecret: "skills-test-secret-not-for-deployment", controlPlaneUrl: "http://127.0.0.1:8787",
    connectorId: "host-connector", allowFaux: true, unsandboxed: true,
    authorize: async input => ({ allowed: true, ownerId: input.ownerId, policyVersion: 1 }),
    resolveModels: async model => ({ models, provider: model.provider, modelId: model.modelId }),
    extensions: { installed: () => [], workspace: async () => answer },
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
  await mkdir(join(worktree, "app", ".pi", "skills", "release"), { recursive: true });
  await writeFile(join(worktree, "app", ".pi", "skills", "release", "SKILL.md"), "---\nname: release\ndescription: Cut a release\n---\nRun scripts/tag.sh.");
  await mkdir(join(worktree, "app", ".claude", "skills", "manual"), { recursive: true });
  await writeFile(join(worktree, "app", ".claude", "skills", "manual", "SKILL.md"), "---\ndescription: Only when asked\ndisable-model-invocation: true\n---\nBody");
  let sent = 0;
  const send = async (content: string) => {
    const requestId = `r${sent++}`;
    await session.submit(await claims("submit"), { content, requestId, admissionId: await sha256(requestId), options: { access: "auto" } }, "write");
    for (let count = 0; count < 500 && (await session.view()).busy; count++) await delay(20);
  };

  await send("hello");
  assert.doesNotMatch(prompts.at(-1)!, /available_skills/, "off until the workspace adds piki:skills");
  answer = { ...answer, extensions: parseWorkspaceExtensions([{ source: "piki:skills" }]) };
  await delay(10);
  await send("again");
  const prompt = prompts.at(-1)!;
  assert.match(prompt, /<name>release<\/name>\n    <description>Cut a release<\/description>\n    <location>app\/.pi\/skills\/release\/SKILL.md<\/location>/);
  assert.doesNotMatch(prompt, /manual/, "one that disables model invocation isn't listed");
  assert.deepEqual((await session.view()).commands?.filter(command => command.kind === "skill").map(command => [command.name, command.description]),
    [["skill:manual", "Only when asked"], ["skill:release", "Cut a release"]], "both still answer to /skill:");
});
