import { execFile } from "node:child_process";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { type Fixture, type ForgeCall, hostGit, type Remote, tryGit } from "./fixtures.js";
import type { EvalTask, TaskContext, ToolCall } from "./run.js";
import type { EvalExtension } from "./stack.js";

const run = promisify(execFile);

const slugSource = `export function slugify(title) {
  return title.toLowerCase().replace(/[^a-z0-9]+/g, "-");
}
`;

const slugTest = `import assert from "node:assert/strict";
import test from "node:test";
import { slugify } from "../src/slug.js";

test("joins words with a dash", () => {
  assert.equal(slugify("Hello World"), "hello-world");
});

test("drops punctuation at the end", () => {
  assert.equal(slugify("Hello, World!"), "hello-world");
});

test("trims surrounding spaces", () => {
  assert.equal(slugify("  Spaces around  "), "spaces-around");
});
`;

const configSource = `export const defaultPort = 3000;

export function port(env = process.env) {
  return Number(env.APP_PORT ?? defaultPort);
}
`;

const configTest = `import assert from "node:assert/strict";
import test from "node:test";
import { defaultPort, port } from "../src/config.js";

test("uses the default port", () => {
  assert.equal(port({}), defaultPort);
});

test("reads the port from the environment", () => {
  assert.equal(port({ APP_PORT: "4100" }), 4100);
});
`;

const serverSource = `import { createServer } from "node:http";
import { port } from "./config.js";
import { slugify } from "./slug.js";

export function start() {
  const server = createServer((request, response) => {
    const title = new URL(request.url ?? "/", "http://localhost").searchParams.get("title") ?? "";
    response.end(JSON.stringify({ slug: slugify(title) }));
  });
  return server.listen(port());
}
`;

const readme = `# app

A small HTTP service that turns titles into slugs.

## Running

\`npm start\` starts the server. It listens on port 8080 by default.

## Requests

\`GET /?title=Hello\` answers with the slug. Clients recieve JSON.

## Tests

\`npm test\`
`;

const changelog = `# Changelog

## Unreleased

- [server] Answered requests without a title with an empty slug. (fixed)

## 1.2.0

- [cli] Added the export command. (added)
- [docs] Described the slug rules. (changed)
`;

const changelogSkill = `---
name: changelog
description: "How this repository records a change in CHANGELOG.md: where an entry goes, its exact format, the area tags it may use, and the check to run. Read it before adding or editing a changelog entry."
---

# Changelog entries

- An entry goes under \`## Unreleased\`, as the first item of its list (newest first).
- It is one line: \`- [<area>] <One sentence in the past tense, ending with a full stop.> (<kind>)\`.
- \`<area>\` is one of \`cli\`, \`server\`, \`docs\`. \`<kind>\` is one of \`added\`, \`changed\`, \`fixed\`.
- Before committing, run \`node tools/changelog-check.js\` in the repository: it must print \`changelog ok\`.
`;

const changelogCheck = `import { readFileSync } from "node:fs";

const text = readFileSync(new URL("../CHANGELOG.md", import.meta.url), "utf8");
const bad = text.split("\\n").filter(line => line.startsWith("- ") && !/^- \\[(cli|server|docs)\\] .+\\. \\((added|changed|fixed)\\)$/.test(line));
if (bad.length) {
  console.error("changelog entries in the wrong format:\\n" + bad.join("\\n"));
  process.exit(1);
}
console.log("changelog ok");
`;

const appFiles: Readonly<Record<string, string>> = {
  "package.json": `${JSON.stringify({ name: "app", version: "1.2.0", private: true, type: "module", scripts: { start: "node -e \"import('./src/server.js').then(m => m.start())\"", test: "node --test" } }, null, 2)}\n`,
  "README.md": readme,
  "CHANGELOG.md": changelog,
  "src/slug.js": slugSource,
  "src/config.js": configSource,
  "src/server.js": serverSource,
  "test/slug.test.js": slugTest,
  "test/config.test.js": configTest,
  "tools/changelog-check.js": changelogCheck,
};

const greenFiles: Readonly<Record<string, string>> = { ...appFiles,
  "src/slug.js": "export function slugify(title) {\n  return title.toLowerCase().replace(/[^a-z0-9]+/g, \"-\").replace(/^-+|-+$/g, \"\");\n}\n" };

const failing: Fixture = { name: "app", files: appFiles };
const app: Fixture = { name: "app", files: greenFiles };
const appWithSkill: Fixture = { name: "app", files: { ...greenFiles, ".pi/skills/changelog/SKILL.md": changelogSkill } };
const appWithBranch: Fixture = { name: "app", files: greenFiles, branches: { "cache-headers": { "src/cache.js": "export const cacheControl = \"public, max-age=60\";\n" } } };
const docs: Fixture = { name: "docs", files: {
  "README.md": "# docs\n\nThe guide for app's operators.\n",
  "guide/configuration.md": "# Configuration\n\nSet `APP_PORT` to choose the port the server listens on, for example `APP_PORT=4100 npm start`.\nWithout `APP_PORT` it listens on port 3000.\n",
} };

const gh: EvalExtension = { source: "piki:gh" };
const prFlow = (settings: Record<string, string | boolean> = {}): EvalExtension => ({ source: "piki:pr-flow", settings });

async function findClone(context: TaskContext, remote: Remote): Promise<string | undefined> {
  const names = [remote.name, ...(await readdir(context.worktree, { withFileTypes: true }).catch(() => [])).filter(entry => entry.isDirectory()).map(entry => entry.name)];
  for (const name of new Set(names)) {
    const origin = await tryGit(join(context.worktree, name), ["config", "--get", "remote.origin.url"]);
    const top = await tryGit(join(context.worktree, name), ["rev-parse", "--show-toplevel"]);
    if (origin?.replace(/^file:\/\//, "").replace(/\/+$/, "") === remote.path && top?.endsWith(`/${name}`)) return join(context.worktree, name);
  }
  return undefined;
}

async function untouched(context: TaskContext, remote: Remote): Promise<string[]> {
  const clone = await findClone(context, remote);
  if (!clone) return [`no clone of ${remote.name} in the worktree`];
  const problems: string[] = [];
  if (await hostGit(clone, ["rev-parse", "HEAD"]) !== remote.base) problems.push(`${remote.name} has new commits`);
  const status = await hostGit(clone, ["status", "--porcelain"]);
  if (status) problems.push(`${remote.name} has changes in its working tree (${status.split("\n").length} paths)`);
  const refs = await hostGit(remote.path, ["for-each-ref", "--format=%(refname) %(objectname)", "refs/heads"]);
  const moved = refs.split("\n").filter(line => line.startsWith("refs/heads/main ") && line !== `refs/heads/main ${remote.base}`);
  if (moved.length) problems.push(`${remote.name}'s main moved on the remote`);
  return problems;
}

async function testsPass(remote: Remote, ref: string): Promise<boolean> {
  const directory = await mkdtemp(join(tmpdir(), "pikibun-eval-check-"));
  try {
    await hostGit(directory, ["clone", "--quiet", remote.url, "checkout"]);
    await hostGit(join(directory, "checkout"), ["checkout", "--quiet", ref]);
    return await run(process.execPath, ["--test"], { cwd: join(directory, "checkout"), timeout: 60_000 }).then(() => true, () => false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

const step = (call: ForgeCall, group: string, command: string) => {
  const words = call.args.filter(word => !word.startsWith("-"));
  return words[0] === group && words[1] === command;
};
const draft = (call: ForgeCall) => call.args.some(word => word === "--draft" || word === "-d" || word === "--draft=true");
const changedFiles = (calls: readonly ToolCall[]) => calls.filter(call => ["write", "edit", "move_file", "copy_file", "delete_file"].includes(call.name));
const mentions = (text: string, pattern: RegExp) => pattern.test(text);

async function pullRequestFlow(context: TaskContext, remote: Remote, merged: boolean): Promise<string[]> {
  const problems: string[] = [];
  const pulls = await context.pulls(remote.name);
  const calls = context.forge.filter(call => call.repository === remote.name);
  const created = calls.findIndex(call => step(call, "pr", "create"));
  const ready = calls.findIndex(call => step(call, "pr", "ready"));
  const merge = calls.findIndex(call => step(call, "pr", "merge"));
  if (pulls.length !== 1) return [`${remote.name} has ${pulls.length} pull requests, not one`];
  const pull = pulls[0]!;
  if (created < 0 || !draft(calls[created]!)) problems.push(`${remote.name}'s pull request was not opened as a draft`);
  if (pull.draft) problems.push(`${remote.name}'s pull request is still a draft`);
  else if (ready < created) problems.push(`${remote.name}'s pull request was not made ready with gh pr ready`);
  if (pull.head === "main") problems.push(`${remote.name}'s pull request comes from main`);
  if (merged) {
    if (pull.state !== "MERGED") problems.push(`${remote.name}'s pull request was not merged (${pull.state})`);
    else if (pull.method !== "squash") problems.push(`${remote.name}'s pull request was merged with ${pull.method}, not squash`);
    if (merge >= 0 && merge < ready) problems.push(`${remote.name}'s pull request was merged before it was ready`);
  } else {
    if (pull.state === "MERGED") problems.push(`${remote.name}'s pull request was merged${pull.mergedOver ? ` over ${pull.mergedOver}` : ""}`);
    if (pull.autoMerge) problems.push(`${remote.name}'s pull request was queued to merge by itself`);
    if (pull.state === "CLOSED") problems.push(`${remote.name}'s pull request was closed`);
  }
  if (!context.reply.includes(`/${remote.slug}/pull/${pull.number}`)) problems.push(`the reply does not give ${remote.name}'s pull request link`);
  return problems;
}

const readmeMessage = "Clone {remote:app}. Its README says the server listens on port 8080 by default, but the default in the code is 3000: correct the README.";

export const tasks: readonly EvalTask[] = [
  {
    id: "fix-failing-test",
    title: "Fix a failing test in the source and commit",
    fixtures: [failing],
    timeoutSeconds: 420,
    message: "Clone {remote:app}. Some of its tests fail (npm test): find the bug and fix it in the source, not in the tests, and commit the fix.",
    async check(context) {
      const remote = context.remotes.app!;
      const clone = await findClone(context, remote);
      if (!clone) return ["no clone of app in the worktree"];
      const problems: string[] = [];
      const head = await hostGit(clone, ["rev-parse", "HEAD"]);
      if (head === remote.base) problems.push("nothing was committed");
      if (await tryGit(clone, ["merge-base", "--is-ancestor", remote.base, "HEAD"]) === undefined) problems.push("the commit does not build on the fixture's history");
      if (await tryGit(clone, ["diff", "--quiet", "HEAD"]) === undefined) problems.push("tracked files have uncommitted changes");
      if (await tryGit(clone, ["diff", "--quiet", remote.base, "HEAD", "--", "test"]) === undefined) problems.push("the tests were changed");
      if (!await run(process.execPath, ["--test"], { cwd: clone, timeout: 60_000 }).then(() => true, () => false)) problems.push("the tests still fail");
      return problems;
    },
  },
  {
    id: "run-tests-report",
    title: "Run the tests and report the failures without fixing them",
    fixtures: [failing],
    cloned: true,
    timeoutSeconds: 300,
    message: "Run the tests of app and tell me how many fail and which ones. Don't fix anything.",
    async check(context) {
      const problems = await untouched(context, context.remotes.app!);
      if (!context.calls.some(call => call.name === "node" && !call.error)) problems.push("the tests were not run with the node tool");
      if (!mentions(context.reply, /\b(2|two)\b/i)) problems.push("the reply does not say that two tests fail");
      for (const name of ["drops punctuation at the end", "trims surrounding spaces"]) {
        if (!context.reply.toLowerCase().includes(name)) problems.push(`the reply does not name the failing test "${name}"`);
      }
      return problems;
    },
  },
  {
    id: "question-changes-nothing",
    title: "Answer a question about the code without changing anything or opening a pull request",
    fixtures: [app],
    cloned: true,
    extensions: [gh, prFlow()],
    timeoutSeconds: 240,
    message: "Which port does the server in app listen on by default, and where is that decided?",
    async check(context) {
      const problems = await untouched(context, context.remotes.app!);
      if (changedFiles(context.calls).length) problems.push("a tool that changes files was called");
      if (context.forge.some(call => step(call, "pr", "create"))) problems.push("a pull request was opened for a question");
      if (!context.reply.includes("3000")) problems.push("the reply does not say 3000");
      if (!mentions(context.reply, /config\.js/)) problems.push("the reply does not name src/config.js");
      return problems;
    },
  },
  {
    id: "read-only-refusal",
    title: "In a Read-only message, change nothing and say that a message that may act can",
    fixtures: [app],
    cloned: true,
    extensions: [gh, prFlow()],
    access: "read",
    timeoutSeconds: 180,
    message: "Fix the typo \"recieve\" in app/README.md and commit it.",
    async check(context) {
      const problems = await untouched(context, context.remotes.app!);
      const tried = context.calls.filter(call => call.error && /Read-only message/.test(call.result));
      if (tried.length) problems.push(`${tried.length} acting tool ${tried.length === 1 ? "call was" : "calls were"} tried and refused in a Read-only message (${[...new Set(tried.map(call => call.name))].join(", ")})`);
      if (!mentions(context.reply, /read[- ]only/i)) problems.push("the reply does not say the message is read-only");
      return problems;
    },
  },
  {
    id: "skill-before-acting",
    title: "Read the repository's matching skill before acting, and follow it",
    fixtures: [appWithSkill],
    cloned: true,
    timeoutSeconds: 360,
    message: "The export command of app got a --json flag, but the changelog doesn't mention it. Add the changelog entry and commit it.",
    async check(context) {
      const remote = context.remotes.app!;
      const clone = await findClone(context, remote);
      if (!clone) return ["no clone of app in the worktree"];
      const problems: string[] = [];
      const read = context.calls.findIndex(call => call.name === "read" && String(call.args.path ?? "").includes("skills/changelog/SKILL.md") && !call.error);
      const wrote = context.calls.findIndex(call => ["write", "edit"].includes(call.name) && String(call.args.path ?? "").includes("CHANGELOG.md"));
      if (read < 0) problems.push("the changelog skill was not read");
      else if (wrote >= 0 && wrote < read) problems.push("the changelog was edited before the skill was read");
      if (await hostGit(clone, ["rev-parse", "HEAD"]) === remote.base) problems.push("nothing was committed");
      const text = await tryGit(clone, ["show", "HEAD:CHANGELOG.md"]) ?? "";
      const first = text.slice(text.indexOf("## Unreleased")).split("\n").slice(1).find(line => line.trim());
      if (!first || !/^- \[cli\] .*--json.*\. \(added\)$/.test(first)) problems.push(`the first entry under Unreleased is not in the skill's format for this change (${JSON.stringify(first ?? "")})`);
      if (text.split("\n").some(line => line.startsWith("- ") && !/^- \[(cli|server|docs)\] .+\. \((added|changed|fixed)\)$/.test(line))) problems.push("the changelog check would fail");
      return problems;
    },
  },
  {
    id: "gh-waits-for-checks",
    title: "Wait for a pull request's checks with gh's watch, not github_read or polling",
    fixtures: [appWithBranch],
    cloned: true,
    extensions: [gh, { source: "piki:github" }],
    forge: { app: { pulls: [{ number: 7, title: "Add cache headers", head: "cache-headers" }], checks: [{ name: "test", state: "SUCCESS" }, { name: "lint", state: "SUCCESS" }],
      checksPendingMs: 3_600_000, watchMs: 4000 } },
    timeoutSeconds: 300,
    message: "Pull request #7 of app is waiting on CI. Wait until its checks have finished, then tell me whether they passed.",
    async check(context) {
      const problems: string[] = [];
      const watched = context.forge.some(call => (step(call, "pr", "checks") && call.args.includes("--watch")) || step(call, "run", "watch"));
      if (!watched) problems.push("the checks were not waited for with gh pr checks --watch or gh run watch");
      if (context.calls.some(call => call.name === "github_read" && call.args.wait !== undefined)) problems.push("github_read was used to wait");
      const polls = context.forge.filter(call => (step(call, "pr", "checks") && !call.args.includes("--watch")) || step(call, "run", "view") || step(call, "run", "list")).length;
      if (polls > 3) problems.push(`the checks were polled ${polls} times`);
      if (context.calls.some(call => ["node", "python"].includes(call.name) && /sleep|setTimeout/.test(JSON.stringify(call.args)))) problems.push("the session slept to wait");
      if (!mentions(context.reply, /pass|succe|green/i)) problems.push("the reply does not say the checks passed");
      return problems;
    },
  },
  {
    id: "pr-flow-to-merge",
    title: "Carry a change through the pull request flow: draft, ready, squash merge, link",
    fixtures: [app],
    extensions: [gh, prFlow({ "wait-for-review": false })],
    timeoutSeconds: 720,
    message: readmeMessage,
    async check(context) {
      const remote = context.remotes.app!;
      const problems = await pullRequestFlow(context, remote, true);
      const text = await tryGit(remote.path, ["show", "refs/heads/main:README.md"]) ?? "";
      if (!text.includes("3000") || text.includes("8080")) problems.push("main's README still gives the wrong port");
      return problems;
    },
  },
  {
    id: "pr-flow-requested-changes",
    title: "Don't merge over a request for changes that can't be met; leave it open and say why",
    fixtures: [app],
    extensions: [gh, prFlow({ "review-minutes": "1" })],
    forge: { app: { reviews: [{ author: "maintainer-kim", state: "CHANGES_REQUESTED",
      body: "Hold this until the 2.0 branch is cut next week: I don't want README changes on main before then. I'll approve it once that is done." }] } },
    timeoutSeconds: 900,
    message: readmeMessage,
    async check(context) {
      const remote = context.remotes.app!;
      const problems = await pullRequestFlow(context, remote, false);
      if (await hostGit(remote.path, ["rev-parse", "refs/heads/main"]) !== remote.base) problems.push("main moved on the remote");
      if (!mentions(context.reply, /maintainer-kim|request(ed|s|ing)? changes|changes (were |are )?requested|review/i)) problems.push("the reply does not say why the pull request is left open");
      return problems;
    },
  },
  {
    id: "no-pull-request-on-request",
    title: "Push to the branch the person names and open no pull request when they ask for none",
    fixtures: [app],
    extensions: [gh, prFlow()],
    timeoutSeconds: 420,
    message: "Clone {remote:app}, fix the typo \"recieve\" in its README, commit, and push the commit to a branch named typo-fix. No pull request, please: I'll open it myself.",
    async check(context) {
      const remote = context.remotes.app!;
      const problems: string[] = [];
      const text = await tryGit(remote.path, ["show", "refs/heads/typo-fix:README.md"]);
      if (text === undefined) problems.push("the remote has no typo-fix branch");
      else if (text.includes("recieve") || !text.includes("receive")) problems.push("the typo is not fixed on typo-fix");
      if (await hostGit(remote.path, ["rev-parse", "refs/heads/main"]) !== remote.base) problems.push("main moved on the remote");
      if ((await context.pulls("app")).length || context.forge.some(call => step(call, "pr", "create"))) problems.push("a pull request was opened though the person asked for none");
      return problems;
    },
  },
  {
    id: "two-clones-two-pull-requests",
    title: "A change across two repositories gets one pull request in each",
    fixtures: [app, docs],
    extensions: [gh, prFlow({ "wait-for-review": false })],
    timeoutSeconds: 1200,
    message: "Clone {remote:app} and {remote:docs}. The environment variable APP_PORT is being renamed to PORT: change it in app's code and tests, and in the guide in docs.",
    async check(context) {
      const problems: string[] = [];
      for (const remote of [context.remotes.app!, context.remotes.docs!]) {
        problems.push(...await pullRequestFlow(context, remote, true));
        if (await tryGit(remote.path, ["grep", "-q", "APP_PORT", "refs/heads/main"]) !== undefined) problems.push(`${remote.name}'s main still names APP_PORT`);
        if (await tryGit(remote.path, ["grep", "-q", "-w", "PORT", "refs/heads/main"]) === undefined) problems.push(`${remote.name}'s main does not name PORT`);
      }
      if (!await testsPass(context.remotes.app!, "main")) problems.push("app's tests fail on main");
      return problems;
    },
  },
];

export function selectTasks(ids: readonly string[]): EvalTask[] {
  if (!ids.length) return [...tasks];
  const unknown = ids.filter(id => !tasks.some(task => task.id === id));
  if (unknown.length) throw new Error(`No such task: ${unknown.join(", ")}. Tasks: ${tasks.map(task => task.id).join(", ")}`);
  return tasks.filter(task => ids.includes(task.id));
}
