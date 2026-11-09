import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { SessionExtensions, type ExtensionHost } from "../apps/runner/src/extensions/adapter.js";
import { loadInstalled } from "../apps/runner/src/extensions/load.js";
import { connectorPikiExtension, connectorPikiExtensions } from "../apps/runner/src/extensions/piki/index.js";
import { ExtensionStore } from "../apps/runner/src/extensions/store.js";
import { pullRequestLine } from "../apps/runner/src/push.js";
import { pikiExtension, pikiWorkflowExtensions } from "../packages/shared/src/piki-extensions.js";
import {
  cloneOf, DEFAULT_REVIEW_MINUTES, githubRepository, MAX_REVIEW_MINUTES, mergeMethod, operationOutcome, prFlowExtension, prFlowPrompt, PrFlowState,
  pushedPullRequest, reviewMinutes, type ObservedCall, type PrFlowSettings,
} from "../extensions/pr-flow/pr-flow.js";

async function directory(t: test.TestContext): Promise<string> {
  const root = await realpath(await mkdtemp(join(tmpdir(), "pikibun-pr-flow-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

const settings = (reviewMinutes = 30, more: Partial<PrFlowSettings> = {}): PrFlowSettings => ({ reviewMinutes, mergeMethod: "squash", waitForChecks: true, ...more });
const isClone = (directory: string) => directory === "app" || directory === "libs/core";
/** An approved operation's tool result, as the session's tools answer. */
const executed = (result: string) => [{ type: "text", text: JSON.stringify({ id: "a1", status: "executed", result }) }];
const call = (toolName: string, input: Record<string, unknown>, content: ObservedCall["content"] = [{ type: "text", text: "{}" }], isError = false): ObservedCall =>
  ({ toolName, input, content, isError });
const url = "https://github.com/acme/app/pull/12";
const pushed = (pull?: { created: boolean; draft?: boolean }) =>
  executed(`Pushed 1 commit to pikibun/s (new branch at abc).${pull ? `\n${pullRequestLine({ url, number: 12, ...pull })}` : ""}`);

test("its settings: whole minutes from 0 to a week, squash unless another method, and the defaults for anything else", () => {
  assert.equal(reviewMinutes("0"), 0);
  assert.equal(reviewMinutes(" 45 "), 45);
  assert.equal(reviewMinutes(15), 15);
  assert.equal(reviewMinutes("999999"), MAX_REVIEW_MINUTES);
  for (const bad of ["", "-5", "1.5", "soon", undefined, true]) assert.equal(reviewMinutes(bad), DEFAULT_REVIEW_MINUTES, String(bad));
  assert.equal(mergeMethod("Rebase"), "rebase");
  assert.equal(mergeMethod("merge"), "merge");
  assert.equal(mergeMethod("fast-forward"), "squash");
  assert.equal(mergeMethod(undefined), "squash");
});

test("a file tool's path is in the clone that holds it; the worktree's own files, paths outside it and .git are in none", () => {
  assert.equal(cloneOf("app/src/index.ts", "/w", isClone), "app");
  assert.equal(cloneOf("./libs/core/x.ts", "/w", isClone), "libs/core");
  assert.equal(cloneOf("/w/app/README.md", "/w", isClone), "app");
  assert.equal(cloneOf("/elsewhere/app/README.md", "/w", isClone), undefined);
  assert.equal(cloneOf("notes.md", "/w", isClone), undefined);
  assert.equal(cloneOf("app", "/w", isClone), undefined, "the clone itself, moved or deleted, is no change in it");
  assert.equal(cloneOf("app/.git/config", "/w", isClone), undefined);
  assert.equal(cloneOf("app/../app/x", "/w", isClone), undefined);
  assert.equal(cloneOf(5, "/w", isClone), undefined);
});

test("what a push says of its pull request, and an approval's outcome, are read back from the tool's result", () => {
  assert.deepEqual(pushedPullRequest(pullRequestLine({ url, number: 12, created: true, draft: true })), { number: 12, url, draft: true });
  assert.deepEqual(pushedPullRequest(pullRequestLine({ url, number: 12, created: false, draft: false })), { number: 12, url, draft: false });
  assert.deepEqual(pushedPullRequest(pullRequestLine({ url, number: 12, created: false })), { number: 12, url });
  assert.equal(pushedPullRequest("Branch x is already up to date."), undefined);
  assert.deepEqual(operationOutcome(executed("done")), { status: "executed", result: "done" });
  assert.deepEqual(operationOutcome([{ type: "text", text: "plain" }]), { result: "plain" });
  assert.equal(githubRepository(url), "acme/app");
  assert.equal(githubRepository("https://gitlab.com/g/p/-/merge_requests/3"), undefined);
});

test("the flow, step by step: a draft at the first change, ready once done, a review window and a new one after each push, then the merge", () => {
  const state = new PrFlowState();
  const at = Date.parse("2026-11-09T19:00:00Z");
  const observe = (item: ObservedCall, minutes = 30, now = at) => state.observe(item, settings(minutes), "/w", isClone, now);

  // Changes outside a clone, failed calls and reads say nothing.
  assert.equal(observe(call("write_file", { path: "notes.md" })), undefined);
  assert.equal(observe(call("write_file", { path: "app/x.ts" }, [], true)), undefined);
  assert.equal(observe(call("read_file", { path: "app/x.ts" })), undefined);

  // The first change in a clone: open the draft now. Said once.
  const first = observe(call("edit_file", { path: "app/src/x.ts" }))!;
  assert.match(first, /first change in app/);
  assert.match(first, /git_push \{directory: "app", branch: <the session branch>, pull_request: \{title, body, draft: true\}\}/);
  assert.equal(observe(call("write_file", { path: "app/src/y.ts" })), undefined);
  assert.equal(observe(call("git", { directory: "app", args: ["commit", "-m", "x"] }, executed("ok"))), undefined);

  // The draft opens: keep pushing, make it ready when done. A later push to the draft says nothing more.
  const draft = observe(call("git_push", { directory: "app", branch: "pikibun/s", pull_request: { title: "T", body: "B", draft: true } }, pushed({ created: true, draft: true })))!;
  assert.match(draft, /Draft #12 is open: https:\/\/github\.com\/acme\/app\/pull\/12/);
  assert.match(draft, /draft: false/);
  assert.equal(observe(call("git_push", { directory: "app", branch: "pikibun/s", pull_request: { title: "T", body: "B", draft: true } }, pushed({ created: false, draft: true }))), undefined);
  assert.match(prFlowPrompt(settings(), state.flows, at), /- app: draft #12 .*make it ready for review once the change is done/);

  // Ready for review: the window's end, as a time, and how to wait and merge on GitHub.
  const ready = observe(call("git_push", { directory: "app", branch: "pikibun/s", pull_request: { title: "T", body: "B", draft: false } }, pushed({ created: false, draft: false })))!;
  assert.match(ready, /#12 is ready for review: wait for reviews until 2026-11-09T19:30:00Z \(30 minutes\)/);
  assert.match(ready, /github_read \{repository: "acme\/app", issue: 12, wait: "change", timeout_seconds: 1800\}/);
  assert.match(ready, /github_merge \{repository: "acme\/app", pull: 12, sha: <its head commit, as github_read reports it>, method: "squash"\}/);
  assert.match(ready, /checks finish/);
  assert.match(prFlowPrompt(settings(), state.flows, at + 60_000), /#12 .* is ready for review; its review window ends at 2026-11-09T19:30:00Z/);
  assert.match(prFlowPrompt(settings(), state.flows, at + 31 * 60_000), /its review window ended at 2026-11-09T19:30:00Z: address what reviews came in, or merge/);

  // A fix pushed with plain git: a new window, for the re-review.
  const later = at + 20 * 60_000;
  const again = observe(call("git", { directory: "app", args: ["push", "origin", "HEAD:pikibun/s"] }, executed("ok")), 30, later)!;
  assert.match(again, /#12 has new commits, so its re-review window starts again: wait for reviews until 2026-11-09T19:50:00Z/);
  // And with git_push without a pull request.
  assert.match(observe(call("git_push", { directory: "app", branch: "pikibun/s" }, pushed()), 30, later)!, /re-review window starts again/);
  // A push that failed says nothing.
  assert.equal(observe(call("git", { directory: "app", args: ["push"] }, [{ type: "text", text: JSON.stringify({ status: "failed", result: "rejected" }) }])), undefined);

  // The merge.
  assert.equal(observe(call("github_merge", { repository: "acme/other", pull: 12, sha: "a".repeat(40), method: "squash" }, executed("Merged"))), undefined);
  assert.match(observe(call("github_merge", { repository: "acme/app", pull: 12, sha: "a".repeat(40), method: "squash" }, executed("Merged")))!, /#12 is merged/);
  assert.match(prFlowPrompt(settings(), state.flows, at), /- app: #12 .* is merged\./);
  // No more windows once merged; a new change is new work, with its own draft.
  assert.equal(observe(call("git", { directory: "app", args: ["push"] }, executed("ok"))), undefined);
  assert.match(observe(call("write_file", { path: "app/z.ts" }))!, /first change in app/);
});

test("a review window of 0 minutes merges as soon as the pull request is ready, without waiting for reviews", () => {
  const state = new PrFlowState();
  const observe = (item: ObservedCall, more: Partial<PrFlowSettings> = {}) => state.observe(item, settings(0, more), "/w", isClone, 0);
  observe(call("write_file", { path: "app/x.ts" }));
  const ready = observe(call("git_push", { directory: "app", branch: "s", pull_request: { title: "T", body: "B", draft: false } }, pushed({ created: true, draft: false })))!;
  assert.match(ready, /review window is 0 minutes: merge it now, without waiting for reviews, with github_merge/);
  assert.doesNotMatch(ready, /github_read \{repository/);
  // Nothing to wait for after a push either.
  assert.equal(observe(call("git", { directory: "app", args: ["push"] }, executed("ok"))), undefined);

  const prompt = prFlowPrompt(settings(0, { waitForChecks: false, mergeMethod: "rebase" }), state.flows, 0);
  assert.match(prompt, /4\. Merge at once\. This workspace's review window is 0 minutes/);
  assert.match(prompt, /method: "rebase"/);
  assert.doesNotMatch(prompt, /checks finish/);
  assert.match(prompt, /- app: #12 .* is ready for review: merge it\./);
});

test("the prompt holds the whole flow with the workspace's window, and fixes valid review points before merging", () => {
  const prompt = prFlowPrompt(settings(45, { mergeMethod: "merge" }));
  for (const step of [/1\. A draft at the first change/, /draft: true/, /3\. Ready for review when done/, /draft: false/, /4\. Wait for review: 45 minutes/,
    /Fix the valid ones/, /answer one you judge invalid with why/, /A pushed fix starts a new 45-minute window, for re-review/,
    /Approved with nothing left to address/, /Never merge over a request for changes you didn't make/, /method: "merge"/, /gh pr create --draft/]) {
    assert.match(prompt, step);
  }
  assert.doesNotMatch(prompt, /This session's pull requests/, "nothing to report before any change");
});

test("piki:pr-flow is the connector's, offered as a workflow, and adds its prompt with the workspace's settings to each message", async t => {
  assert.equal(connectorPikiExtension("piki:pr-flow")!.factory, (await import("../extensions/pr-flow/index.ts")).default);
  assert.equal(connectorPikiExtension("piki:pr-flow")!.factory, prFlowExtension);
  assert.deepEqual(pikiWorkflowExtensions().map(item => item.source), ["piki:pr-flow"]);
  assert.equal(pikiExtension("piki:pr-flow")!.tool, undefined);

  const root = await directory(t);
  const [loaded] = await loadInstalled(new ExtensionStore(join(root, "state")), connectorPikiExtensions.filter(item => item.info.name === "pr-flow"));
  assert.equal(loaded!.summary.source, "piki:pr-flow");
  const host: ExtensionHost = {
    directory: root, model: () => undefined, state: async () => ({ active: true, settings: { "review-minutes": "0", "merge-method": "rebase" } }),
    runTool: async (_call, execute) => execute(new AbortController().signal), hookTimeoutMs: 2000, warn: () => {},
  };
  const session = new SessionExtensions(host, []);
  await session.ensure([loaded!]);
  t.after(() => session.shutdown());
  const prompts = await session.beforeAgentStart("Fix the parser", undefined);
  assert.match(prompts["piki:pr-flow"]!, /## Pull request flow/);
  assert.match(prompts["piki:pr-flow"]!, /review window is 0 minutes/);
  assert.match(prompts["piki:pr-flow"]!, /method: "rebase"/);
});

test("its tool_result handler adds the note to the result, finding clones by their .git in the session's worktree", async t => {
  const root = await directory(t);
  await mkdir(join(root, "app", ".git"), { recursive: true });
  const handlers = new Map<string, (event: unknown, ctx: unknown) => unknown>();
  const flags = new Map<string, unknown>([["review-minutes", "30"], ["merge-method", "squash"], ["wait-for-checks", true]]);
  prFlowExtension({
    registerFlag: () => {}, getFlag: (name: string) => flags.get(name),
    on: (event: string, handler: (event: unknown, ctx: unknown) => unknown) => { handlers.set(event, handler); },
  } as never);
  const toolResult = handlers.get("tool_result")!;
  const content = [{ type: "text", text: "{\"path\":\"app/x.ts\"}" }];
  const result = await toolResult({ toolName: "write_file", input: { path: "app/x.ts" }, content, isError: false }, { cwd: root }) as { content: { text: string }[] };
  assert.equal(result.content.length, 2);
  assert.equal(result.content[0], content[0]);
  assert.match(result.content[1]!.text, /\[pr-flow\] This is the session's first change in app/);
  assert.equal(await toolResult({ toolName: "write_file", input: { path: "other/x.ts" }, content, isError: false }, { cwd: root }), undefined, "no .git there");
  const started = await handlers.get("before_agent_start")!({ systemPrompt: "Base." }, {}) as { systemPrompt: string };
  assert.match(started.systemPrompt, /^Base\.\n\n## Pull request flow/);
  assert.match(started.systemPrompt, /- app: changed, no pull request yet: open its draft now\./);
});
