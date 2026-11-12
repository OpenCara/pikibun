import { defineTool, type ToolRegistration } from "@earendil-works/pi-durable";
import { bool, obj, opt, str } from "@earendil-works/pi-schema";
import { repositoryPath, validCloneDirectory, validPushTag } from "../../../../../packages/shared/src/repositories.js";
import type { GitPushOperation } from "../../../../../packages/shared/src/types.js";
import { repositoryForRemote } from "../../egress.js";
import { RunnerError } from "../../protocol.js";
import { isolatedWorkspace } from "../../workspace.js";
import { text, type ToolContext } from "./context.js";

export function clonePushTool(context: ToolContext): ToolRegistration {
  const { calls } = context;
  return defineTool({ name: "git_push", description: "Push the checked-out commit of a clone in the worktree (its directory, such as app) as it is to a branch of the workspace repository it was cloned from, fast-forward only, optionally opening a pull request as the owner. pull_request.draft true opens it as a draft; false opens it ready for review, or marks the branch's open draft ready for review with this title and body. With tag, push no branch: create that tag at the checked-out commit, which must already be on the remote's branch (such as a release tag on main); tags are never moved. Commit with git first.", parameters: obj({
    directory: str(), branch: str(), tag: opt(str()),
    pull_request: opt(obj({ title: str(), body: str(), base: opt(str()), draft: opt(bool()) }, { open: true })),
  }, { open: true }), execute: async (args, api, _call) => {
    await context.requireSessionTool("git_push");
    const attribution = await calls.actor(api, true);
    await calls.check(api, "git_push", { write: true });
    if (!validCloneDirectory(args.directory)) throw new RunnerError(400, "directory must be a clone's path in the worktree, such as app or src/app");
    if (args.tag !== undefined && !validPushTag(args.tag)) throw new RunnerError(400, "tag must be a plain tag name, such as v1.2.3, not refs/tags/v1.2.3");
    if (args.tag !== undefined && args.pull_request) throw new RunnerError(400, "a tag push opens no pull request");
    const head = await isolatedWorkspace(context.sandbox).cloneHead(args.directory, () => calls.recheck(attribution));
    if (!head.origin) throw new RunnerError(400, `${args.directory} has no origin remote; push only clones of this workspace's repositories`);
    const repository = repositoryForRemote((await context.grant()).repositories, head.origin);
    if (!repository) throw new RunnerError(403, `${args.directory} was cloned from ${head.origin.slice(0, 200)}, which is not one of this workspace's repositories`);
    const request = args.pull_request;
    const operation: GitPushOperation = { kind: "git.push", repository: repositoryPath(repository), directory: args.directory, branch: args.branch,
      ...(args.tag !== undefined ? { tag: args.tag } : {}), commit: head.commit,
      ...(request ? { pullRequest: { title: request.title, body: request.body, ...(request.base !== undefined ? { base: request.base } : {}),
        ...(request.draft !== undefined ? { draft: request.draft } : {}) } } : {}) };
    const approval = await context.operations.run(attribution.initiatedBy, operation, String(api.taskId));
    return text({ ...approval, admissionId: undefined });
  } });
}
