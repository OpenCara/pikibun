import { setTimeout as sleep } from "node:timers/promises";
import { StringEnum } from "@earendil-works/pi-ai";
import { defineTool, type ToolRegistration } from "@earendil-works/pi-durable";
import { int, obj, opt, str } from "@earendil-works/pi-schema";
import { GITHUB_ISSUE_BODY_LIMIT, GITHUB_ISSUE_TITLE_LIMIT, githubMergeMethods, type GitHubIssueView, type GitHubReadRequest } from "../../../../../packages/shared/src/types.js";
import { githubWaitLimits, githubWaits, waitForGitHub } from "../../github-wait.js";
import { RunnerError } from "../../protocol.js";
import { githubRepository } from "../operations.js";
import { approvalText, text, type ToolContext } from "./context.js";

export function githubTools(context: ToolContext): ToolRegistration[] {
  const { binding, calls, config } = context;
  return [
    defineTool({ name: "github_read", description: "Read a GitHub issue or pull request of one of the workspace's github.com repositories (owner/name) as the session owner, through Pikibun: its description and comments and, for a pull request, its merge state, head commit, reviews, review comments and checks. Long threads keep their newest items. The sandbox has no network, so use this instead of curl. Each read spends the session owner's own GitHub rate limit: "
      + "where the session has the gh tool, read and wait for checks with gh instead, and use this to wait for any other change. Read-only; no credentials enter tools. "
      + `To wait for CI or a review instead of sleeping, pass wait: "checks" answers once every check of the head commit has completed (or the pull request is closed, or its head has no checks after ${githubWaitLimits.noChecksSeconds} seconds); "change" answers once anything changes: a comment, review, review comment, push, check or its state. It reads again every ${githubWaitLimits.pollSeconds} seconds for up to timeout_seconds (${githubWaitLimits.defaultSeconds} by default, at most ${githubWaitLimits.maxSeconds}), and its result's waited says how it ended (checks-completed, no-checks, changed, closed or timeout).`,
      parameters: obj({ repository: str(), issue: int({ minimum: 1 }), wait: opt(StringEnum(githubWaits)),
        timeout_seconds: opt(int({ minimum: githubWaitLimits.minSeconds, maximum: githubWaitLimits.maxSeconds })) }, { open: true }), execute: async (args, api, call) => {
      await context.requireSessionTool("github_read");
      const attribution = await calls.actor(api, false);
      const repository = githubRepository(args.repository);
      await calls.check(api, "github_read");
      const state = await context.metadata();
      const run = state.runs[state.toolActors[String(api.taskId)]!.runKey]!;
      if (!run.admissionId) throw new RunnerError(403, "GitHub reads need a write message");
      const request: GitHubReadRequest = { sessionId: binding.session.id, actorId: run.initiatedBy, admissionId: run.admissionId, callId: String(api.taskId), repository, issue: args.issue };
      const read = async () => {
        await context.authorize(run.initiatedBy, "write");
        return config.githubRead ? await config.githubRead(request) : await context.operations.internalGitHub("read", request) as GitHubIssueView;
      };
      const first = await read();
      if (!args.wait) return text({ ...attribution, ...first });
      const { view, waited } = await waitForGitHub({ wait: args.wait, first, read, timeoutMs: (args.timeout_seconds ?? githubWaitLimits.defaultSeconds) * 1000,
        pollMs: config.githubWaitPollMs ?? githubWaitLimits.pollSeconds * 1000, now: Date.now, sleep: ms => sleep(ms, undefined, { signal: call.abortSignal }) });
      return text({ ...attribution, ...view, waited });
    } }),
    defineTool({ name: "github_comment", description: "Post an exact GitHub comment as the session owner through the owner's broker. Use this where the gh tool can't write (gh pr comment, gh issue comment). The result carries the outcome; no credentials enter tools.", parameters: obj({ repository: str(), issue: int({ minimum: 1 }), body: str() }, { open: true }), execute: async (args, api, _call) => {
      await context.requireSessionTool("github_comment");
      const attribution = await calls.actor(api, true);
      await calls.check(api, "github_comment", { write: true });
      return approvalText(await context.operations.run(attribution.initiatedBy, { kind: "github.comment", ...args }, String(api.taskId)));
    } }),
    defineTool({ name: "github_merge", description: "Merge a pull request of one of the workspace's github.com repositories (owner/name) as the session owner, through the owner's broker: only while its head is still commit sha, as github_read reports it, with method merge, squash or rebase. Use this where the gh tool can't write (gh pr merge --match-head-commit). The result carries the outcome; no credentials enter tools.", parameters: obj({ repository: str(), pull: int({ minimum: 1 }), sha: str(), method: StringEnum(githubMergeMethods) }, { open: true }), execute: async (args, api, _call) => {
      await context.requireSessionTool("github_merge");
      const attribution = await calls.actor(api, true);
      const repository = githubRepository(args.repository);
      if (!/^[0-9a-f]{40}$/.test(args.sha)) throw new RunnerError(400, "sha must be the pull request's full 40-character head commit, as github_read reports it");
      await calls.check(api, "github_merge", { write: true });
      return approvalText(await context.operations.run(attribution.initiatedBy, { kind: "github.merge", repository, pull: args.pull, sha: args.sha, method: args.method }, String(api.taskId)));
    } }),
    defineTool({ name: "github_issue", description: "Open a GitHub issue with exactly this title (one line) and body (Markdown) in one of the workspace's github.com repositories (owner/name), as the session owner, through the owner's broker. Use this where the gh tool can't write (gh issue create): the sandbox holds no GitHub credentials. The result carries the new issue's number and URL; no credentials enter tools.", parameters: obj({ repository: str(), title: str(), body: str() }, { open: true }), execute: async (args, api, _call) => {
      await context.requireSessionTool("github_issue");
      const attribution = await calls.actor(api, true);
      const repository = githubRepository(args.repository);
      if (!args.title.trim() || /[\r\n]/.test(args.title) || args.title.length > GITHUB_ISSUE_TITLE_LIMIT) throw new RunnerError(400, `title must be one non-empty line of at most ${GITHUB_ISSUE_TITLE_LIMIT} characters`);
      if (args.body.length > GITHUB_ISSUE_BODY_LIMIT) throw new RunnerError(400, `body must be at most ${GITHUB_ISSUE_BODY_LIMIT} characters`);
      if (args.title.includes("\0") || args.body.includes("\0")) throw new RunnerError(400, "title and body must not contain NUL characters");
      await calls.check(api, "github_issue", { write: true });
      return approvalText(await context.operations.run(attribution.initiatedBy, { kind: "github.issue", repository, title: args.title, body: args.body }, String(api.taskId)));
    } }),
  ];
}
