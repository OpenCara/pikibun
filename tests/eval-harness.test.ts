import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after, before } from "node:test";
import { Forge } from "../scripts/eval/fixtures.js";
import { compare, type EvalResult, parseResult, regressions, renderReport, type RunOutcome, tally } from "../scripts/eval/report.js";
import { type EvalTask, runEval, runTask } from "../scripts/eval/run.js";
import { type EvalStack, startStack } from "../scripts/eval/stack.js";
import { selectTasks, tasks } from "../scripts/eval/tasks.js";
import { type Script, scriptedModels, type Step } from "../scripts/eval/scripted.js";

const skip = process.platform === "win32" ? "the eval's forge stand-in is a shell launcher" : false;
let directory = "";
let forge: Forge;
let stack: EvalStack;
let script: Script = () => ({ text: "Nothing scripted." });
const models = scriptedModels(turn => script(turn));
const options = () => ({ stack, forge, directory });
const steps = (list: readonly Step[], last: string): Script => turn => list[turn.results.length] ?? { text: last };
const remoteOf = (prompt: string, name: string) => new RegExp(`file://\\S+/${name}\\.git`).exec(prompt)?.[0] ?? "";
const link = (name: string) => `https://forge.eval.test/eval/${name}/pull/1`;

before(async () => {
  if (skip) return;
  directory = await mkdtemp(join(tmpdir(), "pikibun-eval-test-"));
  forge = await Forge.create(directory);
  stack = await startStack({ directory, localModels: models, allowFaux: true, path: [forge.bin] });
});

after(async () => {
  if (skip) return;
  await stack?.stop();
  await rm(directory, { recursive: true, force: true });
});

const noted: EvalTask = {
  id: "note", title: "Write a note", fixtures: [], timeoutSeconds: 60, message: "Write 42 to answer.txt.",
  async check(context) {
    const text = await readFile(join(context.worktree, "answer.txt"), "utf8").catch(() => "");
    return text.trim() === "42" ? [] : [`answer.txt holds ${JSON.stringify(text)}`];
  },
};

test("a task whose outcome check holds passes, with its time, tool calls and tokens", { skip }, async () => {
  script = steps([{ tool: "write", args: { path: "answer.txt", content: "42\n" } }], "Written.");
  const result = await runTask(noted, 1, options());
  assert.equal(result.outcome, "pass", result.detail);
  assert.equal(result.toolCalls, 1);
  assert.ok(result.tokens && result.tokens.output > 0 && result.cost === 0);
  assert.ok(result.seconds >= 0 && result.sessionId);
});

test("a task is judged by its outcome, not by the final message", { skip }, async () => {
  script = () => ({ text: "I wrote 42 to answer.txt." });
  const result = await runTask(noted, 1, options());
  assert.equal(result.outcome, "fail");
  assert.equal(result.detail, 'answer.txt holds ""');
});

test("a check that throws fails its run and says so", { skip }, async () => {
  script = () => ({ text: "Done." });
  const result = await runTask({ ...noted, check: async () => { throw new Error("no such file"); } }, 1, options());
  assert.deepEqual([result.outcome, result.detail], ["fail", "the check itself failed: no such file"]);
});

test("a session that does not settle within the task's time limit is stopped and counted as timed out", { skip }, async () => {
  script = () => ({ text: "Late.", holdMs: 6000 });
  const started = Date.now();
  const result = await runTask({ ...noted, timeoutSeconds: 1 }, 1, options());
  assert.equal(result.outcome, "timeout");
  assert.match(result.detail, /not settled after 1 seconds; stopped/);
  assert.ok(Date.now() - started < 45_000);
});

test("a harness failure is an error, which is not counted as a fail", { skip }, async () => {
  const result = await runTask({ ...noted, extensions: [{ source: "not an extension" }] }, 1, options());
  assert.equal(result.outcome, "error");
  assert.match(result.detail, /^the harness failed: /);
});

test("an eval runs every task several times and its result compares with an earlier one", { skip }, async () => {
  let turn = 0;
  script = current => current.results.length ? { text: "Done." } : ++turn === 2 ? { text: "Skipped." } : { tool: "write", args: { path: "answer.txt", content: "42" } };
  const lines: string[] = [];
  const first = await runEval({ ...options(), tasks: [noted, { ...noted, id: "second" }], runs: 2, label: "after", commit: "abc1234", log: line => lines.push(line) });
  assert.deepEqual(first.tasks.map(task => [task.id, task.runs.map(run => run.outcome)]), [["note", ["pass", "fail"]], ["second", ["pass", "pass"]]]);
  assert.equal(first.model, "faux/scripted");
  assert.equal(lines.length, 4);
  assert.match(lines[1]!, /^note run 2\/2: fail in [\d.]+s \(answer\.txt holds ""\)$/);
  const read = parseResult(JSON.stringify(first));
  const earlier = result({ note: ["pass", "pass"], second: ["fail", "fail"], gone: ["pass"] });
  assert.deepEqual(compare(earlier, read).map(flip => [flip.id, flip.kind]), [["note", "regressed"], ["second", "improved"], ["gone", "removed"]]);
  const report = renderReport(read, earlier);
  assert.match(report, /\| note \| 1\/2 flaky \|.*\| \*\*regressed\*\* \(pass 2\/2 → flaky 1\/2\) \|/);
  assert.match(report, /Regressed: note\. Improved: second\. Not run this time: gone\./);
  assert.match(report, /- note, run 2 \(fail\): answer\.txt holds ""/);
});

function result(outcomes: Record<string, RunOutcome[]>, extra: Partial<EvalResult> = {}): EvalResult {
  return {
    version: 1, model: "faux/scripted", host: { platform: "linux", node: "24.0.0", sandbox: false }, startedAt: "2026-01-01T00:00:00.000Z", finishedAt: "2026-01-01T00:10:00.000Z",
    runsPerTask: 3, tasks: Object.entries(outcomes).map(([id, runs]) => ({ id, title: id, runs: runs.map((outcome, index) => ({
      run: index + 1, outcome, detail: outcome === "pass" ? "ok" : `why ${id} ${index + 1}`, seconds: 10 * (index + 1),
      tokens: { input: 100, output: 50 * (index + 1), cacheRead: 2000, cacheWrite: 400 }, cost: 0.25,
    })) })), ...extra,
  };
}

test("a task's status counts passes among the runs that ran, leaving errors out", () => {
  const [pass, flaky, fail, errors, mixed] = result({ a: ["pass", "pass"], b: ["pass", "fail", "timeout"], c: ["fail", "timeout"], d: ["error"], e: ["pass", "error"] }).tasks.map(tally);
  assert.deepEqual(pass, { status: "pass", passes: 2, counted: 2, errors: 0 });
  assert.deepEqual(flaky, { status: "flaky", passes: 1, counted: 3, errors: 0 });
  assert.deepEqual(fail, { status: "fail", passes: 0, counted: 2, errors: 0 });
  assert.deepEqual(errors, { status: "error", passes: 0, counted: 0, errors: 1 });
  assert.deepEqual(mixed, { status: "pass", passes: 1, counted: 1, errors: 1 });
});

test("the flip report names each task that changed status, not only a score", () => {
  const before = result({ steady: ["pass", "pass", "pass"], broke: ["pass", "pass", "pass"], wobbles: ["pass", "fail", "pass"], fixed: ["fail", "fail", "fail"], lost: ["pass"], outage: ["pass"] }, { label: "before", commit: "1111111" });
  const now = result({ steady: ["pass", "pass", "pass"], broke: ["fail", "timeout", "fail"], wobbles: ["fail", "fail", "pass"], fixed: ["pass", "pass", "fail"], outage: ["error"], added: ["pass"] }, { label: "after", commit: "2222222" });
  const flips = compare(before, now);
  assert.deepEqual(Object.fromEntries(flips.map(flip => [flip.id, flip.kind])),
    { steady: "same", broke: "regressed", wobbles: "same", fixed: "improved", outage: "unknown", added: "new", lost: "removed" });
  assert.deepEqual(regressions(flips), ["broke"]);
  const report = renderReport(now, before);
  assert.match(report, /^Model faux\/scripted, 3 runs a task, at 2222222, "after"\.\nAgainst faux\/scripted at 1111111, "before", of 2026-01-01T00:10:00\.000Z\.\n/);
  assert.match(report, /\| steady \| 3\/3 pass \| 20s \| 2\.5k \/ 100 \| \$0\.750 \| same \|/);
  assert.match(report, /\| broke \| 0\/3 fail, 1 timed out \|.*\| \*\*regressed\*\* \(pass 3\/3 → fail 0\/3\) \|/);
  assert.match(report, /\| wobbles \| 1\/3 flaky \|.*\| same \(flaky 2\/3 → flaky 1\/3\) \|/);
  assert.match(report, /\| outage \| 0\/0 error, 1 not counted \(error\) \|.*\| can't tell \(pass 1\/1 → error 0\/0\) \|/);
  assert.match(report, /2 of 6 tasks passed every run; 7 of 13 runs passed; cost \$3\.50\./);
  assert.match(report, /Regressed: broke\. Improved: fixed\. Can't tell \(errors, not counted\): outage\. New: added\. Not run this time: lost\./);
  assert.match(report, /- broke, run 2 \(timeout\): why broke 2/);
  assert.match(renderReport(before, before), /No task flipped\./);
  assert.doesNotMatch(renderReport(now), /Against|flipped|Regressed/);
});

test("a result file of another shape is refused", () => {
  assert.throws(() => parseResult("{\"version\":2,\"tasks\":[]}"), /Not an eval result file/);
  assert.throws(() => parseResult("{\"version\":1,\"model\":\"m\",\"tasks\":[{}]}"), /Not an eval result file/);
});

test("the golden tasks are about ten, each with a message, a time limit and a check", () => {
  assert.ok(tasks.length >= 8 && tasks.length <= 12);
  assert.equal(new Set(tasks.map(task => task.id)).size, tasks.length);
  for (const task of tasks) assert.ok(/^[a-z0-9-]+$/.test(task.id) && task.title && task.message && task.timeoutSeconds >= 60 && task.fixtures.length, task.id);
  assert.deepEqual(selectTasks(["read-only-refusal"]).map(task => task.id), ["read-only-refusal"]);
  assert.throws(() => selectTasks(["nope"]), /No such task: nope/);
});

const draftFlow = (name: string, branch: string, title: string): Step[] => [
  { tool: "git", args: { args: ["checkout", "-b", branch], directory: name } },
  { tool: "git", args: { args: ["commit", "-am", title], directory: name } },
  { tool: "git", args: { args: ["push", "origin", branch], directory: name } },
  { tool: "gh", args: { args: ["pr", "create", "--draft", "--title", title, "--body", "Why and what."], directory: name } },
  { tool: "gh", args: { args: ["pr", "ready", "1"], directory: name } },
];
const fixPort: Step = { tool: "edit", args: { path: "app/README.md", edits: [{ oldText: "port 8080", newText: "port 3000" }] } };
const merge = (name: string): Step[] => [
  { tool: "gh", args: { args: ["pr", "checks", "1", "--watch"], directory: name } },
  { tool: "gh", args: { args: ["pr", "merge", "1", "--squash"], directory: name } },
];

const golden: Record<string, Script> = {
  "fix-failing-test": turn => steps([
    { tool: "git", args: { args: ["clone", remoteOf(turn.prompt, "app")] } },
    { tool: "node", args: { program: "npm", args: ["test"], directory: "app" } },
    { tool: "edit", args: { path: "app/src/slug.js", edits: [{ oldText: "replace(/[^a-z0-9]+/g, \"-\")", newText: "replace(/[^a-z0-9]+/g, \"-\").replace(/^-+|-+$/g, \"\")" }] } },
    { tool: "git", args: { args: ["commit", "-am", "Trim dashes from a slug's ends"], directory: "app" } },
  ], "Fixed and committed.")(turn),
  "run-tests-report": steps([{ tool: "node", args: { program: "npm", args: ["test"], directory: "app" } }],
    "Two tests fail: \"drops punctuation at the end\" and \"trims surrounding spaces\". I changed nothing."),
  "question-changes-nothing": steps([{ tool: "read", args: { path: "app/src/config.js" } }], "Port 3000, the defaultPort in src/config.js, unless APP_PORT is set."),
  "read-only-refusal": () => ({ text: "This is a Read-only message, so I changed nothing: I would replace \"recieve\" with \"receive\" in app/README.md. A message that may act can make it." }),
  "skill-before-acting": steps([
    { tool: "read", args: { path: "app/.pi/skills/changelog/SKILL.md" } },
    { tool: "edit", args: { path: "app/CHANGELOG.md", edits: [{ oldText: "## Unreleased\n\n", newText: "## Unreleased\n\n- [cli] Added the --json flag to the export command. (added)\n" }] } },
    { tool: "node", args: { program: "node", args: ["tools/changelog-check.js"], directory: "app" } },
    { tool: "git", args: { args: ["commit", "-am", "Changelog: the export command's --json flag"], directory: "app" } },
  ], "Added and committed."),
  "gh-waits-for-checks": steps([{ tool: "gh", args: { args: ["pr", "checks", "7", "--watch"], directory: "app" } }], "Both checks passed."),
  "pr-flow-to-merge": turn => steps([
    { tool: "git", args: { args: ["clone", remoteOf(turn.prompt, "app")] } }, fixPort, ...draftFlow("app", "readme-port", "Correct the README's default port"), ...merge("app"),
  ], `Merged: ${link("app")}`)(turn),
  "pr-flow-requested-changes": turn => steps([
    { tool: "git", args: { args: ["clone", remoteOf(turn.prompt, "app")] } }, fixPort, ...draftFlow("app", "readme-port", "Correct the README's default port"),
    { tool: "gh", args: { args: ["pr", "view", "1", "--json", "reviewDecision,reviews"], directory: "app" } },
  ], `I left ${link("app")} open: maintainer-kim requested changes I can't make.`)(turn),
  "no-pull-request-on-request": turn => steps([
    { tool: "git", args: { args: ["clone", remoteOf(turn.prompt, "app")] } },
    { tool: "edit", args: { path: "app/README.md", edits: [{ oldText: "recieve", newText: "receive" }] } },
    { tool: "git", args: { args: ["commit", "-am", "Fix a typo in the README"], directory: "app" } },
    { tool: "git", args: { args: ["push", "origin", "HEAD:typo-fix"], directory: "app" } },
  ], "Pushed to typo-fix; no pull request opened.")(turn),
  "two-clones-two-pull-requests": turn => steps([
    { tool: "git", args: { args: ["clone", remoteOf(turn.prompt, "app")] } },
    { tool: "git", args: { args: ["clone", remoteOf(turn.prompt, "docs")] } },
    { tool: "edit", args: { path: "app/src/config.js", edits: [{ oldText: "env.APP_PORT", newText: "env.PORT" }] } },
    { tool: "edit", args: { path: "app/test/config.test.js", edits: [{ oldText: "APP_PORT: \"4100\"", newText: "PORT: \"4100\"" }] } },
    ...draftFlow("app", "rename-port", "Rename APP_PORT to PORT"), ...merge("app"),
    { tool: "write", args: { path: "docs/guide/configuration.md", content: "# Configuration\n\nSet `PORT` to choose the port the server listens on.\n" } },
    ...draftFlow("docs", "rename-port", "Rename APP_PORT to PORT"), ...merge("docs"),
  ], `Merged ${link("app")} and ${link("docs")}.`)(turn),
};

for (const task of tasks) {
  test(`${task.id}: a session that does the task passes, and one that only says so fails`, { skip }, async () => {
    assert.ok(golden[task.id], "every golden task has a scripted solution here");
    script = golden[task.id]!;
    const fast = { ...task, forge: task.forge && Object.fromEntries(Object.entries(task.forge).map(([name, scenario]) => [name, { ...scenario, watchMs: 200 }])) };
    const done = await runTask(fast, 1, options());
    assert.equal(done.outcome, "pass", done.detail);
    script = () => ({ text: "Done." });
    const idle = await runTask(fast, 2, options());
    assert.equal(idle.outcome, "fail", idle.detail);
  });
}

async function failsWith(id: string, changed: Script, pattern: RegExp): Promise<void> {
  script = changed;
  const outcome = await runTask(tasks.find(task => task.id === id)!, 1, options());
  assert.equal(outcome.outcome, "fail");
  assert.match(outcome.detail, pattern);
}

test("merging over a request for changes fails its task", { skip }, async () => {
  await failsWith("pr-flow-requested-changes", turn => steps([
    { tool: "git", args: { args: ["clone", remoteOf(turn.prompt, "app")] } }, fixPort, ...draftFlow("app", "readme-port", "Correct the README's default port"), ...merge("app"),
  ], `Merged ${link("app")} after maintainer-kim's review.`)(turn), /app's pull request was merged over CHANGES_REQUESTED; main moved on the remote/);
});

test("a pull request that follows the flow without making the change asked for fails its task", { skip }, async () => {
  await failsWith("pr-flow-requested-changes", turn => steps([
    { tool: "git", args: { args: ["clone", remoteOf(turn.prompt, "app")] } },
    { tool: "edit", args: { path: "app/README.md", edits: [{ oldText: "recieve", newText: "receive" }] } },
    ...draftFlow("app", "readme-port", "Correct the README"),
  ], `I left ${link("app")} open: maintainer-kim requested changes I can't make.`)(turn), /^the pull request's branch still gives the wrong port in the README$/);
});

test("calls made from a code mode script count as the session's own", { skip }, async () => {
  const coded = (code: string, last: string): Script => steps([{ tool: "codemode", args: { code } }], last);
  script = coded("return await tools.node({ program: 'npm', args: ['test'], directory: 'app' });", "2 fail: drops punctuation at the end, trims surrounding spaces.");
  const reported = await runTask(tasks.find(task => task.id === "run-tests-report")!, 1, options());
  assert.equal(reported.outcome, "pass", reported.detail);
  await failsWith("read-only-refusal", coded("return await tools.write({ path: 'app/README.md', content: 'receive' });", "This message is Read-only."),
    /1 acting tool call was tried and refused in a Read-only message \(codemode\)/);
  await failsWith("gh-waits-for-checks", coded("return await tools.github_read({ repository: 'eval/app', issue: 7, wait: 'checks' });", "They passed."), /github_read was used to wait/);
  await failsWith("question-changes-nothing", coded("await tools.write({ path: 'notes.txt', content: 'x' }); return 'ok';", "3000, in src/config.js."), /^a tool that changes files was called$/);
});

test("the forge stand-in waits for required checks too, and refuses a merge without a method", { skip }, async () => {
  const waits = tasks.find(task => task.id === "gh-waits-for-checks")!;
  script = steps([{ tool: "gh", args: { args: ["pr", "checks", "7", "--required", "--watch"], directory: "app" } }], "Both checks passed.");
  const done = await runTask({ ...waits, forge: { app: { ...waits.forge!.app!, watchMs: 200 } }, check: async context => [...await waits.check(context),
    ...(/All checks were successful/.test(context.calls[0]!.result) ? [] : [`the watch answered ${context.calls[0]!.result}`])] }, 1, options());
  assert.equal(done.outcome, "pass", done.detail);
  await failsWith("pr-flow-to-merge", turn => steps([
    { tool: "git", args: { args: ["clone", remoteOf(turn.prompt, "app")] } }, fixPort, ...draftFlow("app", "readme-port", "Correct the README's default port"),
    { tool: "gh", args: { args: ["pr", "merge", "1"], directory: "app" } },
  ], `Merged: ${link("app")}`)(turn), /app's pull request was not merged \(OPEN\)/);
});

test("a pull request that was never a draft, or whose link is not given, fails the flow", { skip }, async () => {
  await failsWith("pr-flow-to-merge", turn => steps([
    { tool: "git", args: { args: ["clone", remoteOf(turn.prompt, "app")] } }, fixPort,
    { tool: "git", args: { args: ["checkout", "-b", "readme-port"], directory: "app" } },
    { tool: "git", args: { args: ["commit", "-am", "Correct the port"], directory: "app" } },
    { tool: "git", args: { args: ["push", "origin", "readme-port"], directory: "app" } },
    { tool: "gh", args: { args: ["pr", "create", "--title", "Correct the port", "--body", "x"], directory: "app" } },
    { tool: "gh", args: { args: ["pr", "merge", "1", "--merge"], directory: "app" } },
  ], "Merged.")(turn), /not opened as a draft.*merged with merge, not squash.*does not give app's pull request link/);
});

test("waiting with github_read, or acting in a Read-only message, fails those tasks", { skip }, async () => {
  await failsWith("gh-waits-for-checks", steps([{ tool: "github_read", args: { repository: "eval/app", issue: 7, wait: "checks" } }], "They passed."),
    /not waited for with gh pr checks --watch or gh run watch; github_read was used to wait/);
  await failsWith("read-only-refusal", steps([{ tool: "write", args: { path: "app/README.md", content: "receive" } }], "This message is Read-only, so nothing changed."),
    /1 acting tool call was tried and refused in a Read-only message \(write\)/);
  await failsWith("skill-before-acting", steps([
    { tool: "edit", args: { path: "app/CHANGELOG.md", edits: [{ oldText: "## Unreleased\n\n", newText: "## Unreleased\n\n- Added --json to export\n" }] } },
    { tool: "git", args: { args: ["commit", "-am", "Changelog"], directory: "app" } },
  ], "Added."), /the changelog skill was not read; the first entry under Unreleased is not in the skill's format/);
});

test("a session's instructions reach the model as the eval's tasks need them", { skip }, async () => {
  script = () => ({ text: "Port 3000, in src/config.js." });
  models.turns.length = 0;
  await runTask(tasks.find(task => task.id === "gh-waits-for-checks")!, 1, options());
  const waits = models.turns.at(-1)!;
  assert.ok(waits.tools.includes("gh") && waits.tools.includes("github_read"));
  assert.match(waits.system, /use the gh tool rather than github_read/);
  await runTask(tasks.find(task => task.id === "skill-before-acting")!, 1, options());
  assert.match(models.turns.at(-1)!.system, /<location>app\/\.pi\/skills\/changelog\/SKILL\.md<\/location>/);
  await runTask(tasks.find(task => task.id === "read-only-refusal")!, 1, options());
  assert.match(models.turns.at(-1)!.system, /This request is read-only\./);
  await runTask(tasks.find(task => task.id === "question-changes-nothing")!, 1, options());
  assert.match(models.turns.at(-1)!.system, /## Pull request flow/);
  assert.match(models.turns.at(-1)!.system, /This host runs without a sandbox/);
});
