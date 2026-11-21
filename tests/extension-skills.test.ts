import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { access, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { getSystemMessageText } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, type FauxResponseFactory } from "@earendil-works/pi-ai/providers/faux";
import { SessionExtensions, type ExtensionHost } from "../apps/runner/src/extensions/adapter.js";
import { loadInstalled, packageEntries, packageSkills } from "../apps/runner/src/extensions/load.js";
import { connectorPikiExtensions } from "../apps/runner/src/extensions/piki/index.js";
import { collectSkills, discoveredPath } from "../apps/runner/src/extensions/skills.js";
import { ExtensionStore } from "../apps/runner/src/extensions/store.js";
import { RunnerService } from "../apps/runner/src/server.js";
import { EXTENSION_SKILLS_DIRECTORY, ExtensionSkillFiles, extensionOwner, planSkills, skillFilePath } from "../apps/runner/src/session/extension-skills.js";
import { piText } from "../apps/runner/src/session/pi-text.js";
import { skillsPrompt } from "../apps/runner/src/session/skills.js";
import { sha256 } from "../packages/shared/src/crypto.js";
import { parseWorkspaceExtensions } from "../packages/shared/src/host-extensions.js";
import type { RunnerAction, RunnerBinding } from "../packages/shared/src/types.js";
import { PR_FLOW_SKILL, prFlowPrompt, prFlowRule, prFlowSkill, type PrFlowSettings } from "../extensions/pr-flow/pr-flow.ts";
import { readSettings, SUB_AGENTS_SKILL, subAgentsPrompt, subAgentsRule, subAgentsSkill, SubAgentsState } from "../extensions/sub-agents/sub-agents.ts";

async function scratch(t: { after(fn: () => unknown): void }, name = "pikibun-extension-skills-"): Promise<string> {
  const root = await realpath(await mkdtemp(join(tmpdir(), name)));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

async function put(path: string, text: string | Buffer): Promise<void> {
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, text);
}

const skillText = (name: string, description: string, body = "Do it.") => `---\nname: ${name}\ndescription: ${description}\n---\n${body}\n`;

test("a package's skills are what Pi takes: pi.skills in its package.json, else its skills/ folder, never outside it", async t => {
  const root = await scratch(t);
  await put(join(root, "skills", "deploy", "SKILL.md"), skillText("deploy", "Deploy it"));
  await put(join(root, "docs", "one.md"), skillText("one", "One"));
  await put(join(root, "docs", "skip.md"), skillText("skip", "Skip"));
  await put(join(root, "index.ts"), "export default function () {}");
  assert.deepEqual(await packageSkills(root, { pi: { skills: ["skills", "docs/*.md", "!docs/skip.md", "missing", "index.ts"] } }),
    [join(root, "skills"), join(root, "docs", "one.md")], "globs and exclusions as in pi.extensions; only folders and Markdown files that exist");
  assert.deepEqual(await packageSkills(root, { pi: { extensions: ["index.ts"] } }), [], "a manifest that lists resources but no skills has none");
  assert.deepEqual(await packageSkills(root, {}), [join(root, "skills")], "without one, the skills/ folder by convention");
  assert.deepEqual(await packageSkills(root, { pi: { image: "x.png" } }), [join(root, "skills")], "a pi object of metadata only still uses the convention");
  await assert.rejects(packageSkills(root, { pi: { skills: ["../elsewhere"] } }), /outside the package/);
  await assert.rejects(packageSkills(root, { pi: { skills: "skills" } }), /lists paths/);
  await writeFile(join(root, "package.json"), JSON.stringify({ name: "demo", version: "1.0.0", pi: { extensions: ["index.ts"], skills: ["skills"] } }));
  assert.deepEqual(await packageEntries(root, true), { files: [join(root, "index.ts")], skills: [join(root, "skills")], name: "demo", version: "1.0.0" });
});

test("an extension's skills are read with Pi's own rules, each with the text files of its folder, bounded, and never through a link", async t => {
  const root = await scratch(t);
  const skills = join(root, "skills");
  await put(join(skills, "deploy", "SKILL.md"), skillText("deploy", "Deploy the app", "Run scripts/go.py."));
  await put(join(skills, "deploy", "scripts", "go.py"), "print('go')\n");
  await put(join(skills, "deploy", ".secret"), "token");
  await put(join(skills, "deploy", "node_modules", "x.js"), "x");
  await put(join(skills, "deploy", "image.bin"), Buffer.from([1, 0, 2]));
  await put(join(skills, "deploy", "big.txt"), "x".repeat(300 * 1024));
  await symlink("/etc/hostname", join(skills, "deploy", "host.txt"));
  await put(join(skills, "notes.md"), skillText("notes", "Notes to follow"));
  await put(join(skills, "plain.md"), "# No description, so not a skill");
  await put(join(skills, "bare", "SKILL.md"), "---\nname: bare\n---\nNo description");
  const found = (await collectSkills([skills])).sort((a, b) => a.name.localeCompare(b.name));
  assert.deepEqual(found.map(skill => [skill.name, skill.description, skill.file, skill.files.map(file => file.path)]), [
    ["deploy", "Deploy the app", "SKILL.md", ["SKILL.md", "scripts/go.py"]],
    ["notes", "Notes to follow", "notes.md", ["notes.md"]],
  ], "dot files, node_modules, binary files, files over 256 KB and links stay out; a skill needs a description");
  assert.equal(found[0]!.files[1]!.text, "print('go')\n");
  assert.deepEqual(await collectSkills([]), []);

  const temporary = await scratch(t, "pikibun-tmp-");
  await put(join(temporary, "SKILL.md"), skillText("everything", "Would copy the whole temporary directory"));
  const before = process.env.TMPDIR;
  process.env.TMPDIR = temporary;
  try { assert.deepEqual(await collectSkills([temporary]), [], "a SKILL.md at the top of the temporary directory would take all of it"); }
  finally { if (before === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = before; }

  assert.equal(discoveredPath("/abs/skill", "<piki:pr-flow>"), "/abs/skill");
  assert.equal(discoveredPath("skills", "/pkg/extensions/index.ts"), "/pkg/extensions/skills");
  assert.equal(discoveredPath("skills", "<piki:pr-flow>"), undefined, "a relative path from a module with no file has nothing to be relative to");
});

test("a session copies an extension's skills under .pikibun/skills, one folder each, named and checked", () => {
  assert.equal(extensionOwner("piki:pr-flow"), "pr-flow");
  assert.equal(extensionOwner("npm:@scope/pkg@1.2.3"), "pkg");
  assert.equal(extensionOwner("npm:pi-web-access@0.46.0"), "pi-web-access");
  assert.equal(extensionOwner("git:github.com/OpenCara/pikibun@abc#extensions/context-files"), "context-files");
  assert.equal(extensionOwner("local:/home/me/my ext.ts"), "my-ext.ts");
  assert.equal(extensionOwner("npm:@@@"), "extension");
  for (const path of ["SKILL.md", "scripts/a.py", "a/b/c.md"]) assert.ok(skillFilePath(path), path);
  for (const path of ["", "../x", ".env", "a/.git/config", "a//b", "/abs", "a\\b", "./x"]) assert.ok(!skillFilePath(path), path);
  const skill = (name: string, extra: Record<string, unknown> = {}) => ({ name, description: `Use ${name}`, disableModelInvocation: false, file: "SKILL.md",
    files: [{ path: "SKILL.md", text: skillText(name, `Use ${name}`) }, { path: "../escape.sh", text: "x" }], ...extra });
  const plan = planSkills([
    { source: "npm:a/pr-flow@1", skills: [skill("one"), skill("one"), skill("bad name"), skill("hidden", { disableModelInvocation: true }), skill("lost", { file: "MISSING.md" })] },
    { source: "piki:pr-flow", skills: [skill("two")] },
  ]);
  assert.deepEqual(plan.items.map(item => [item.name, item.owner, item.path, item.listed, item.origin]), [
    ["one", "pr-flow", ".pikibun/skills/pr-flow/one/SKILL.md", true, "npm:a/pr-flow@1"],
    ["hidden", "pr-flow", ".pikibun/skills/pr-flow/hidden/SKILL.md", false, "npm:a/pr-flow@1"],
    ["two", plan.items[2]!.owner, `.pikibun/skills/${plan.items[2]!.owner}/two/SKILL.md`, true, "piki:pr-flow"],
  ], "a name twice, an invalid name, or a skill file that isn't among its files is left out");
  assert.match(plan.items[2]!.owner, /^pr-flow-[0-9a-f]{6}$/, "two extensions with one name get folders of their own");
  assert.ok(![...plan.files.keys()].some(path => path.includes("escape")), "a file path that leaves its folder isn't copied");
});

test("copies are written only when they change, and a skill that goes away is removed; one that couldn't be written isn't listed", async () => {
  const ops: string[] = [];
  const failing = new Set<string>();
  const files = new ExtensionSkillFiles({
    write: async path => { if (failing.has(path)) throw new Error("read-only"); ops.push(`write ${path}`); },
    remove: async path => { ops.push(`remove ${path}`); },
  });
  const skill = (name: string, script = "print(1)") => ({ name, description: `Use ${name}`, disableModelInvocation: false, file: "SKILL.md",
    files: [{ path: "SKILL.md", text: skillText(name, `Use ${name}`) }, { path: "scripts/run.py", text: script }] });
  const at = (name: string, file = "SKILL.md") => `${EXTENSION_SKILLS_DIRECTORY}/pr-flow/${name}/${file}`;
  assert.deepEqual((await files.sync([{ source: "piki:pr-flow", skills: [skill("a"), skill("b")] }])).map(item => item.path), [at("a"), at("b")]);
  assert.deepEqual(ops, [`remove ${EXTENSION_SKILLS_DIRECTORY}`, `write ${at("a")}`, `write ${at("a", "scripts/run.py")}`, `write ${at("b")}`, `write ${at("b", "scripts/run.py")}`],
    "the first sync clears what an earlier run of the session left");
  ops.length = 0;
  await files.sync([{ source: "piki:pr-flow", skills: [skill("a"), skill("b")] }]);
  assert.deepEqual(ops, [], "nothing changed, nothing written");
  await files.sync([{ source: "piki:pr-flow", skills: [skill("a", "print(2)")] }]);
  assert.deepEqual(ops, [`write ${at("a", "scripts/run.py")}`, `remove ${EXTENSION_SKILLS_DIRECTORY}/pr-flow/b`]);
  ops.length = 0;
  failing.add(at("c"));
  assert.deepEqual((await files.sync([{ source: "piki:pr-flow", skills: [skill("a", "print(2)"), skill("c")] }])).map(item => item.name), ["a"]);
  ops.length = 0;
  await files.sync([]);
  assert.deepEqual(ops.sort(), [`remove ${EXTENSION_SKILLS_DIRECTORY}/pr-flow/a`, `remove ${EXTENSION_SKILLS_DIRECTORY}/pr-flow/c`].sort());
});

test("the model's list says where extension skills come from, apart from the repositories' own", () => {
  const prompt = skillsPrompt([
    { name: "pull-request-flow", title: "pull-request-flow", path: ".pikibun/skills/pr-flow/pull-request-flow/SKILL.md", description: "The flow", listed: true, origin: "piki:pr-flow" },
  ]);
  assert.match(prompt, /under \.pikibun\/skills come with the workspace's extensions/);
  assert.doesNotMatch(prompt, /repositories of this session's worktree/);
  assert.match(skillsPrompt([{ name: "release", title: "release", path: "app/.pi/skills/release/SKILL.md", description: "Cut a release", listed: true }]),
    /The other skills are in the repositories/);
});

const prSettings: PrFlowSettings = { reviewMinutes: 30, mergeMethod: "squash", waitForChecks: true, autoMerge: true };

test("piki:pr-flow's skill is its whole procedure, filled in from the workspace's settings, and its prompt keeps the short rule", async () => {
  const { frontmatter } = await piText();
  const parsed = frontmatter(prFlowSkill(prSettings));
  assert.equal(parsed.frontmatter.name, PR_FLOW_SKILL);
  assert.match(String(parsed.frontmatter.description), /pull request flow/);
  assert.match(parsed.body, /^# Pull request flow\n/);
  assert.match(parsed.body, /4\. Wait for review: 30 minutes\./);
  assert.match(parsed.body, /github_merge \{repository, pull, sha/);
  const rule = prFlowRule(prSettings);
  for (const part of [/^## Pull request flow/, /read the pull-request-flow skill/, /a 30-minute review window/, /merge it \(squash\) once its checks pass/,
    /never over a request for changes you didn't make/, /Tell the person its link/]) assert.match(rule, part);
  assert.doesNotMatch(rule, /github_merge|4\. Wait/);
  assert.ok(rule.length * 2 < prFlowPrompt(prSettings).length, `${rule.length} against ${prFlowPrompt(prSettings).length}`);
  assert.match(prFlowRule({ ...prSettings, autoMerge: false }), /never merge it yourself, nor queue an automatic merge/);
  assert.doesNotMatch(prFlowRule({ ...prSettings, autoMerge: false }), /merge it \(squash\)/);
  assert.match(prFlowRule({ ...prSettings, reviewMinutes: 0 }), /merge it \(squash\) as soon as it is ready once its checks pass, without waiting for reviews/);
  assert.match(prFlowRule({ ...prSettings, reviewMinutes: 0, autoMerge: false }), /as soon as it is ready, tell the person it is ready for them to merge/);
  assert.match(prFlowRule({ ...prSettings, prePushCheck: "pnpm check:fast" }), /run `pnpm check:fast` there/);
  assert.match(prFlowRule(prSettings, [{ directory: "app", pull: { number: 7, url: "https://github.com/o/r/pull/7" }, draft: true }]), /draft #7/);
  assert.match(frontmatter(prFlowSkill({ ...prSettings, autoMerge: false })).body, /4\. Wait for review[\s\S]*hand it over/);
});

test("piki:sub-agents' skill is its policy, and its prompt keeps when, and how many", async () => {
  const settings = readSettings(name => ({ "max-sub-agents": "3", placement: "gpu=true" } as Record<string, unknown>)[name]);
  const state = new SubAgentsState();
  const { frontmatter } = await piText();
  const parsed = frontmatter(subAgentsSkill(settings, state));
  assert.equal(parsed.frontmatter.name, SUB_AGENTS_SKILL);
  assert.match(parsed.body, /^# Sub-agents\n[\s\S]*conditions gpu=true/);
  const rule = subAgentsRule(settings, state);
  for (const part of [/^## Sub-agents/, /- When: split work/, /at most 3 sub-agents per message/, /read the sub-agents skill/]) assert.match(rule, part);
  assert.doesNotMatch(rule, /gpu=true/);
  const none = readSettings(name => (name === "max-sub-agents" ? "0" : undefined));
  assert.equal(subAgentsRule(none, state), subAgentsPrompt(none, state), "with none allowed, the one line says so, and there is no skill to read");
});

test("in a session's extensions, pr-flow and sub-agents offer their skills through resources_discover, and shorten their prompts once a host asked", async t => {
  const root = await scratch(t);
  const loaded = (await loadInstalled(new ExtensionStore(join(root, "state")), connectorPikiExtensions.filter(item => ["pr-flow", "sub-agents"].includes(item.info.name))));
  let subAgents: Record<string, string> = { "max-sub-agents": "2" };
  const host: ExtensionHost = {
    directory: root, model: () => undefined, runTool: async (_call, execute) => execute(new AbortController().signal), hookTimeoutMs: 5000, warn: () => {},
    state: async source => ({ active: true, settings: source === "piki:sub-agents" ? subAgents : { "review-minutes": "45" } }),
  };
  const session = new SessionExtensions(host, []);
  await session.ensure(loaded);
  t.after(() => session.shutdown());
  const first = await session.beforeAgentStart("Fix the parser", undefined);
  assert.match(first["piki:pr-flow"]!, /4\. Wait for review: 45 minutes/, "a host that never asks for skills gets the whole procedure, as connectors from before this do");
  assert.match(first["piki:sub-agents"]!, /- Where: Pikibun places each sub-agent/);
  const provided = await session.skills(["piki:pr-flow", "piki:sub-agents", "piki:gh"]);
  assert.deepEqual(provided.map(item => [item.source, item.skills.map(skill => [skill.name, skill.file, skill.files.map(file => file.path)])]), [
    ["piki:pr-flow", [["pull-request-flow", "SKILL.md", ["SKILL.md"]]]],
    ["piki:sub-agents", [["sub-agents", "SKILL.md", ["SKILL.md"]]]],
  ]);
  assert.match(provided[0]!.skills[0]!.files[0]!.text, /4\. Wait for review: 45 minutes/, "filled in from the settings");
  const next = await session.beforeAgentStart("Fix the parser", undefined);
  assert.match(next["piki:pr-flow"]!, /read the pull-request-flow skill/);
  assert.doesNotMatch(next["piki:pr-flow"]!, /4\. Wait for review/);
  assert.match(next["piki:sub-agents"]!, /read the sub-agents skill/);
  subAgents = { "max-sub-agents": "0" };
  assert.deepEqual((await session.skills(["piki:sub-agents"])).length, 0, "with no sub-agents allowed there is nothing to read");
  assert.match((await session.beforeAgentStart("x", undefined))["piki:sub-agents"]!, /lets no message start sub-agent sessions/);
});

test("a session copies its extensions' skills into the worktree and lists them for the model, with or without piki:skills, and /skill: sends them", { skip: !["linux", "darwin"].includes(process.platform) }, async t => {
  const root = await scratch(t);
  const loaded = (await loadInstalled(new ExtensionStore(join(root, "extensions")))).filter(item => item.summary.source === "piki:pr-flow");
  let answer = { extensions: parseWorkspaceExtensions([{ source: "piki:pr-flow" }]), automaticTools: true };
  const prompts: string[] = [];
  const faux = fauxProvider({ models: [{ id: "faux-1", contextWindow: 1_000_000 }] });
  const respond: FauxResponseFactory = async request => {
    faux.appendResponses([respond]);
    prompts.push(request.messages.flatMap(message => message.role === "system" ? [getSystemMessageText(message)] : []).at(-1) ?? "");
    return fauxAssistantMessage("ok");
  };
  faux.setResponses([respond]);
  const models = createModels(); models.setProvider(faux.provider);
  const target: RunnerBinding = {
    session: { id: "extension-skills", workspaceId: "workspace", ownerId: "test:alice", agentVersionId: "version-1", title: "Skills", policyVersion: 1, status: "ready",
      createdAt: "2026-01-01T00:00:00Z", repositories: [], repositoryMode: "clone", connectorId: "host-connector", connectorOwnerId: "test:alice" },
    owner: { id: "test:alice", githubId: null, githubLogin: "alice", displayName: "Alice", gitName: "Alice", gitEmail: "alice@example.test", env: {}, githubConnected: false },
    agent: { id: "version-1", agentId: "agent", authorId: "test:alice", workspaceId: "workspace", version: 1, name: "Agent", description: "", instructions: "Answer.", tools: ["read_file"], modelId: "model-1", createdAt: "2026-01-01T00:00:00Z" },
    model: { id: "model-1", workspaceId: "workspace", name: "Model", provider: "faux", modelId: "faux-1", connectorId: "host-connector", connectorOwnerId: "test:alice" },
  };
  const service = new RunnerService({
    dataDir: join(root, "runner"), sharedSecret: "extension-skills-test-secret-not-for-deployment", controlPlaneUrl: "http://127.0.0.1:8787",
    connectorId: "host-connector", allowFaux: true, unsandboxed: true,
    authorize: async input => ({ allowed: true, ownerId: input.ownerId, policyVersion: 1 }),
    resolveModels: async model => ({ models, provider: model.provider, modelId: model.modelId }),
    extensions: { installed: () => loaded, workspace: async () => answer },
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
  await put(join(worktree, ".pikibun", "skills", "stale", "old", "SKILL.md"), skillText("old", "Left by an earlier run"));
  let sent = 0;
  const send = async (content: string) => {
    const requestId = `r${sent++}`;
    await session.submit(await claims("submit"), { content, requestId, admissionId: await sha256(requestId), options: { access: "auto" } }, "write");
    for (let count = 0; count < 500 && (await session.view()).busy; count++) await delay(20);
    return session.view();
  };
  const copy = join(worktree, ".pikibun", "skills", "pr-flow", "pull-request-flow", "SKILL.md");

  await send("hello");
  const prompt = prompts.at(-1)!;
  assert.match(prompt, /<name>pull-request-flow<\/name>[\s\S]*<location>\.pikibun\/skills\/pr-flow\/pull-request-flow\/SKILL\.md<\/location>/,
    "listed without piki:skills: an extension's skill is on with the extension");
  assert.match(prompt, /read the pull-request-flow skill/, "and pr-flow's prompt is the short rule");
  assert.doesNotMatch(prompt, /4\. Wait for review/);
  assert.match(await readFile(copy, "utf8"), /# Pull request flow[\s\S]*4\. Wait for review: 30 minutes/);
  await assert.rejects(access(join(worktree, ".pikibun", "skills", "stale")), "what an earlier run left is cleared");
  assert.deepEqual((await session.view()).commands?.filter(command => command.kind === "skill").map(command => command.name), ["skill:pull-request-flow"]);

  const view = await send("/skill:pull-request-flow the parser fix");
  const sentText = view.entries.filter(entry => entry.role === "user").at(-1)!.text;
  assert.match(sentText, /^<skill name="pull-request-flow" location="\.pikibun\/skills\/pr-flow\/pull-request-flow\/SKILL\.md">\nReferences are relative to \.pikibun\/skills\/pr-flow\/pull-request-flow\.\n\n# Pull request flow/);
  assert.match(sentText, /<\/skill>\n\nthe parser fix$/);

  answer = { ...answer, extensions: parseWorkspaceExtensions([{ source: "piki:pr-flow", enabled: false }]) };
  await delay(10);
  await send("again");
  assert.doesNotMatch(prompts.at(-1)!, /pull-request-flow/, "turned off, its skill goes with it");
  await assert.rejects(access(copy), "and its copy is removed");
});
