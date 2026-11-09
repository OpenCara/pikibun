import { existsSync } from "node:fs";
import { isAbsolute, join, relative } from "node:path";
import type { ExtensionContext, ExtensionFactory, ToolResultEvent } from "@earendil-works/pi-coding-agent";

/*
 * The pull request flow (docs/design/piki-extensions.md): a Pi extension that has the agent carry each change to a
 * repository through a pull request (a merge request on GitLab), from the first edit to the merge:
 *
 * 1. A draft as soon as the session starts changing a clone's files.
 * 2. Ready for review once the change is done.
 * 3. A review window of the workspace's choosing (`review-minutes`), again after each pushed fix (a re-review), in which
 *    the agent fixes the review points it judges valid and answers the others; 0 merges as soon as it is ready.
 * 4. The merge.
 *
 * It registers no tool: the agent does each step with the session's own tools (git, git_push with
 * `pull_request.draft`, github_read with `wait`, github_comment, github_merge), each approved as it always is. What it
 * adds is the flow, as a prompt section for each message (`before_agent_start`), and a note on the tool results where a
 * step is due (`tool_result`): the first change in a clone without a pull request, a draft opened, a pull request made
 * ready (with the review window's end, as a time), a push after that (a new window), a merge.
 *
 * It keeps what it saw in memory, per session (Pikibun runs an extension's factory once per session): a connector that
 * restarts forgets its notes, never the flow, which the prompt section restates with every message.
 *
 * Like the prompt audit, it is a Pi package of its own (this directory), importing nothing but Pi's packages and Node's,
 * so it loads in Pi as it does in Pikibun; Pikibun's connector bundles it as `piki:pr-flow`.
 */

/** The extension's settings (Pi flags), and what each means. */
export const prFlowFlags = Object.freeze({
  "review-minutes": "How long to wait for reviews once a pull request is ready for review, and again for a re-review after pushed fixes, in minutes. 0 merges it as soon as it is ready, without waiting for reviews",
  "merge-method": "How to merge: squash (default), merge or rebase",
  "wait-for-checks": "Wait for the pull request's checks to finish, and fix failing ones, before merging",
});

export const DEFAULT_REVIEW_MINUTES = 30;
/** A week: a window longer than that is a pull request left for people, not a wait. */
export const MAX_REVIEW_MINUTES = 7 * 24 * 60;
/** The longest github_read wait, in seconds. */
const GITHUB_WAIT_SECONDS = 1800;

export type MergeMethod = "squash" | "merge" | "rebase";
export interface PrFlowSettings { reviewMinutes: number; mergeMethod: MergeMethod; waitForChecks: boolean }

/** The review window from its setting: whole minutes, 0 up to a week (more is a week); anything else is the default. */
export function reviewMinutes(setting: unknown): number {
  const text = typeof setting === "number" ? String(setting) : typeof setting === "string" ? setting.trim() : "";
  if (!/^\d+$/.test(text)) return DEFAULT_REVIEW_MINUTES;
  return Math.min(Number(text), MAX_REVIEW_MINUTES);
}

/** The merge method from its setting; squash unless it names another. */
export function mergeMethod(setting: unknown): MergeMethod {
  const value = typeof setting === "string" ? setting.trim().toLowerCase() : "";
  return value === "merge" || value === "rebase" ? value : "squash";
}

/** A clone's pull request, as far as this session saw it. */
export interface PullRequestFlow {
  /** The clone's directory in the worktree, such as `app`. */
  directory: string;
  /** The pull request, once a push opened or found it. */
  pull?: { number: number; url: string };
  /** Its head branch, as the push that opened or found it named it; pushes to others don't touch it. */
  branch?: string;
  /** Whether it is a draft, as the last push that asked said. */
  draft?: boolean;
  /** When its review window began: when it was made ready, or a push since then. */
  windowStart?: number;
  merged?: boolean;
  /** Closed without merging, as github_read said. */
  closed?: boolean;
  /** Whether the agent was already told to open its draft. */
  told?: boolean;
}

/** A tool call and its result, as `tool_result` gives them. */
export interface ObservedCall {
  toolName: string;
  input: Record<string, unknown>;
  content: readonly { type: string; text?: string }[];
  isError: boolean;
}

/** The file tools that change files, and the arguments that name what they change. */
const changingTools: Readonly<Record<string, readonly string[]>> = Object.freeze({
  write_file: ["path"], edit_file: ["path"], move_file: ["from", "to"], copy_file: ["to"], delete_file: ["path"],
});

/** A push's result saying nothing moved: Git's own, and git_push's summary (runner push.ts). */
const upToDate = /\bEverything up-to-date\b|\bis already up to date\b/;

/**
 * The branches a `git push` names as its destinations (`git push origin HEAD:x`, `git push origin x`), without
 * `refs/heads/` or a force `+`; none where it names no refspec, and so pushes the branch's upstream. `HEAD` (or `@`)
 * stays as it is: the checked-out branch, whichever it is.
 */
export function pushedBranches(args: readonly unknown[]): string[] {
  const positional = args.slice(1).filter((arg): arg is string => typeof arg === "string" && !arg.startsWith("-"));
  return positional.slice(1).map(refspec => {
    const destination = refspec.includes(":") ? refspec.slice(refspec.lastIndexOf(":") + 1) : refspec;
    const branch = destination.replace(/^\+/, "").replace(/^refs\/heads\//, "");
    return branch === "@" ? "HEAD" : branch;
  }).filter(Boolean);
}

/** Whether a push naming `branches` (pushedBranches) may have moved `branch`. */
function pushMoves(branches: readonly string[], branch: string | undefined): boolean {
  return !branch || !branches.length || branches.includes(branch) || branches.includes("HEAD");
}

/** Whether `url` is a pull request of the forge `tool` acts on, so a number it names means that one. */
export function forgeOwns(tool: string, url: string): boolean {
  if (tool === "glab") return /\/merge_requests\/\d+$/.test(url);
  if (tool === "az") return /\/pullrequest\/\d+$/.test(url);
  return tool === "gh" && /\/pull\/\d+$/.test(url);
}

/** A pull or merge request's web address in a forge tool's output, and its number. */
export function pullRequestAddress(text: string): { number: number; url: string } | undefined {
  const match = /https:\/\/\S+?\/(?:pull|merge_requests|pullrequest|pull-requests)\/(\d+)/.exec(text);
  return match ? { number: Number(match[1]), url: match[0] } : undefined;
}

/** What a call of a forge's command-line tool (gh, glab, az) does to a pull request, from its arguments. */
export function forgeStep(tool: string, args: readonly unknown[]): "create" | "ready" | "merge" | undefined {
  const words = args.filter((arg): arg is string => typeof arg === "string");
  const has = (...options: string[]) => words.some(word => options.some(option => word === option || word.startsWith(`${option}=`)));
  const [first, second, third] = words;
  if (tool === "gh" && first === "pr") {
    if (second === "create") return "create";
    if (second === "ready" && !has("--undo")) return "ready";
    // --auto only queues the merge for when its requirements are met.
    if (second === "merge" && !has("--auto", "--disable-auto")) return "merge";
  }
  if (tool === "glab" && first === "mr") {
    if (second === "create" || second === "new") return "create";
    // --ready has no short form (glab's -r is something else).
    if (second === "update" && has("--ready")) return "ready";
    // It merges at once, or once a running pipeline succeeds: its output tells (see scheduledMerge).
    if (second === "merge" || second === "accept") return "merge";
  }
  if (tool === "az" && first === "repos" && second === "pr") {
    if (third === "create") return "create";
    const status = words[words.indexOf("--status") + 1];
    if (third === "update" && words.includes("--status") && status === "completed" && !has("--auto-complete")) return "merge";
    if (third === "update" && has("--draft") && words[words.indexOf("--draft") + 1] === "false") return "ready";
  }
  return undefined;
}

/** A merge command's output saying the merge is only scheduled (glab's auto-merge, once the pipeline succeeds). */
const scheduledMerge = /when (?:the )?pipeline succeeds|auto-?merge|will be merged/i;

/**
 * Whether a create command asked for a draft: gh's --draft (-d), glab's --draft or --wip (its -d is --description), az's
 * --draft with a value (true unless false).
 */
export function asksDraft(tool: string, args: readonly unknown[]): boolean {
  const words = args.filter((arg): arg is string => typeof arg === "string");
  if (tool === "gh") return words.some(word => word === "--draft" || word === "-d" || word === "--draft=true");
  if (tool === "glab") return words.some(word => word === "--draft" || word === "--wip" || word === "--draft=true");
  const at = words.findIndex(word => word === "--draft" || word.startsWith("--draft="));
  if (at < 0) return false;
  const word = words[at]!;
  return (word.startsWith("--draft=") ? word.slice(8) : words[at + 1]) !== "false";
}

/** The head branch a create command names (gh --head/-H, glab and az --source-branch/-s); none for the checked-out one. */
export function createdBranch(tool: string, args: readonly unknown[]): string | undefined {
  const words = args.filter((arg): arg is string => typeof arg === "string");
  const options = tool === "gh" ? ["--head", "-H"] : ["--source-branch", "-s"];
  for (let index = 0; index < words.length; index++) {
    const word = words[index]!;
    if (options.includes(word)) return words[index + 1]?.replace(/^refs\/heads\//, "") || undefined;
    const long = options.find(option => option.startsWith("--") && word.startsWith(`${option}=`));
    if (long) return word.slice(long.length + 1).replace(/^refs\/heads\//, "") || undefined;
  }
  return undefined;
}

/** The pull request number a forge tool's arguments name: a number, a web address, or az's --id. */
function namedPull(args: readonly unknown[]): number | undefined {
  const words = args.filter((arg): arg is string => typeof arg === "string");
  const id = words.indexOf("--id");
  if (id >= 0 && /^\d+$/.test(words[id + 1] ?? "")) return Number(words[id + 1]);
  for (const word of words.slice(2)) {
    if (/^!?\d+$/.test(word)) return Number(word.replace("!", ""));
    const address = pullRequestAddress(word);
    if (address) return address.number;
  }
  return undefined;
}

/** Git subcommands that change a clone's history: as good as a file change for the flow. */
const changingGit = new Set(["commit", "merge", "rebase", "cherry-pick", "revert", "am", "apply", "mv", "rm"]);

/**
 * The clone a worktree path is in: its nearest directory above it (its first segments) holding `.git`, as `isClone`
 * tells. Paths are the file tools' (relative to the worktree, or absolute inside it); one outside, or into `.git`, is in
 * none.
 */
export function cloneOf(path: unknown, worktree: string | undefined, isClone: (directory: string) => boolean): string | undefined {
  if (typeof path !== "string" || !path || path.includes("\0")) return undefined;
  let relativePath = path;
  if (isAbsolute(path)) {
    if (!worktree) return undefined;
    relativePath = relative(worktree, path);
    if (!relativePath || isAbsolute(relativePath)) return undefined;
  }
  const parts = relativePath.split(/[\\/]+/).filter(part => part && part !== ".");
  if (parts.some(part => part === ".." || part.toLowerCase() === ".git")) return undefined;
  for (let length = 1; length < parts.length; length++) {
    const directory = parts.slice(0, length).join("/");
    if (isClone(directory)) return directory;
  }
  return undefined;
}

/** A clone directory as the git and git_push tools name it, normalized as cloneOf names one. */
function directoryOf(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const parts = value.split(/[\\/]+/).filter(part => part && part !== ".");
  return parts.length && !parts.some(part => part === "..") ? parts.join("/") : undefined;
}

/** What an approved operation's tool result says: its status and result text, or the raw text. */
export function operationOutcome(content: ObservedCall["content"]): { status?: string; result: string } {
  const text = content.flatMap(part => part.type === "text" && typeof part.text === "string" ? [part.text] : []).join("\n");
  try {
    const value = JSON.parse(text) as { status?: unknown; result?: unknown } | null;
    if (value && typeof value === "object" && !Array.isArray(value)) {
      return { ...(typeof value.status === "string" ? { status: value.status } : {}), result: typeof value.result === "string" ? value.result : text };
    }
  } catch { /* Not an approval's JSON. */ }
  return { result: text };
}

/** The pull request line of a push's summary (runner push.ts, pullRequestLine). */
export function pushedPullRequest(result: string): { number: number; url: string; draft?: boolean } | undefined {
  const match = /Pull request #(\d+) (?:opened|already open)(, a draft|, ready for review)?: (https:\/\/\S+)/.exec(result);
  if (!match) return undefined;
  return { number: Number(match[1]), url: match[3]!, ...(match[2] ? { draft: match[2] === ", a draft" } : {}) };
}

/** owner/name of a github.com pull request URL, for github_read and github_merge. */
export function githubRepository(url: string): string | undefined {
  return /^https:\/\/github\.com\/([A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9_.-]+)\/pull\/\d+/.exec(url)?.[1];
}

/** The note once `flow`'s draft is open: keep pushing, then `readyCall` once done. */
function draftNote(flow: PullRequestFlow, readyCall: string): string {
  const pull = flow.pull!;
  return `[pr-flow] Draft #${pull.number} is open: ${pull.url}. Tell the person its link. Keep committing and pushing to the session branch as you work; `
    + `once the change is done (its tests pass, its last commit pushed), make it ready for review: ${readyCall}.`;
}

/** Whether `flow`'s pull request is done with: merged, or closed. */
function done(flow: PullRequestFlow | undefined): boolean {
  return flow?.merged === true || flow?.closed === true;
}

/** A time as the agent reads it: UTC, to the minute's second. */
function clock(at: number): string {
  return new Date(at).toISOString().replace(/\.\d{3}Z$/, "Z");
}

function minutes(count: number): string {
  return count === 1 ? "1 minute" : `${count} minutes`;
}

/** A window of `count` minutes, as an adjective: `30-minute`. */
function minuteWindow(count: number): string {
  return `${count}-minute`;
}

/** How to merge `flow`'s pull request, in a sentence's words. */
function mergeCall(flow: PullRequestFlow, settings: PrFlowSettings): string {
  const repository = flow.pull ? githubRepository(flow.pull.url) : undefined;
  return repository
    ? `github_merge {repository: "${repository}", pull: ${flow.pull!.number}, sha: <its head commit, as github_read reports it>, method: "${settings.mergeMethod}"}`
    : `the forge's tool (glab mr merge, az repos pr update --status completed), as a ${settings.mergeMethod} merge`;
}

/** How to wait for `flow`'s reviews, in a sentence's words. */
function waitCall(flow: PullRequestFlow, settings: PrFlowSettings): string {
  const repository = flow.pull ? githubRepository(flow.pull.url) : undefined;
  const seconds = Math.min(settings.reviewMinutes * 60, GITHUB_WAIT_SECONDS);
  return repository
    ? `github_read {repository: "${repository}", issue: ${flow.pull!.number}, wait: "change", timeout_seconds: ${seconds}} (again until then, at most ${GITHUB_WAIT_SECONDS} seconds a call; a code mode script can loop)`
    : "reading its reviews and discussions with the forge's tool (glab, az) until then";
}

const checksStep = (settings: PrFlowSettings) => settings.waitForChecks
  ? " Before merging, let its checks finish (on GitHub, github_read with wait: \"checks\") and fix any that fail, pushing the fix as you would for a review point."
  : "";

/** The sentence after a pull request becomes ready, or gets a push once it is: its review window, and how to end it. */
function reviewNote(flow: PullRequestFlow, settings: PrFlowSettings, again: boolean): string {
  const pull = flow.pull ? `#${flow.pull.number}` : "The pull request";
  if (settings.reviewMinutes === 0) {
    return again ? "" : `[pr-flow] ${pull} is ready for review. This workspace's review window is 0 minutes: merge it now, without waiting for reviews, with ${mergeCall(flow, settings)}.${checksStep(settings)}`;
  }
  const until = clock(flow.windowStart! + settings.reviewMinutes * 60_000);
  return `[pr-flow] ${pull} ${again ? "has new commits, so its re-review window starts again" : "is ready for review"}: wait for reviews until ${until} `
    + `(${minutes(settings.reviewMinutes)}) with ${waitCall(flow, settings)}. Fix the review points you judge valid, push, and answer each point; `
    + `a pushed fix starts a new ${minuteWindow(settings.reviewMinutes)} window. Merge, with ${mergeCall(flow, settings)}, once it is approved with nothing left `
    + `to address, or once the window ends with nothing new to address.${checksStep(settings)}`;
}

/** What the session has seen of its pull requests, and the note each step calls for. */
export class PrFlowState {
  readonly #flows = new Map<string, PullRequestFlow>();

  get flows(): PullRequestFlow[] { return [...this.#flows.values()]; }

  #flow(directory: string): PullRequestFlow {
    let flow = this.#flows.get(directory);
    if (!flow) this.#flows.set(directory, flow = { directory });
    return flow;
  }

  /**
   * Takes in one tool call's result; returns the note to add to it, if a step of the flow is due. `isClone` tells
   * whether a worktree directory is a clone (holds `.git`).
   */
  observe(call: ObservedCall, settings: PrFlowSettings, worktree: string | undefined, isClone: (directory: string) => boolean, now: number): string | undefined {
    if (call.isError) return undefined;
    const changing = changingTools[call.toolName];
    if (changing) {
      const clones = new Set(changing.flatMap(key => { const clone = cloneOf(call.input[key], worktree, isClone); return clone ? [clone] : []; }));
      return this.#changed([...clones]);
    }
    if (call.toolName === "git") return this.#git(call, settings, now);
    if (call.toolName === "git_push") return this.#pushed(call, settings, now);
    if (call.toolName === "github_merge") return this.#merged(call);
    if (call.toolName === "github_read") return this.#read(call);
    if (call.toolName === "gh" || call.toolName === "glab" || call.toolName === "az") return this.#forge(call, settings, now);
    return undefined;
  }

  #changed(clones: readonly string[]): string | undefined {
    // A change after its pull request merged is new work: a new pull request, from its own draft.
    for (const directory of clones) if (done(this.#flows.get(directory))) this.#flows.delete(directory);
    const due = clones.map(directory => this.#flow(directory)).filter(flow => !flow.pull && !flow.told);
    for (const flow of due) flow.told = true;
    if (!due.length) return undefined;
    const names = due.map(flow => flow.directory).join(", ");
    const opens = due.map(flow => `git_push {directory: "${flow.directory}", branch: <the session branch>, pull_request: {title, body, draft: true}}`).join(", and ");
    return `[pr-flow] This is the session's first change in ${names}, which has no pull request yet. Before going further, open ${due.length === 1 ? "it" : "each"} `
      + "as a draft: commit what you have with git, push it to the session's own branch (git push origin HEAD:<the session branch>), then "
      + `${opens}. Leave this out only if the person asked for no pull request.`;
  }

  #git(call: ObservedCall, settings: PrFlowSettings, now: number): string | undefined {
    const args = Array.isArray(call.input.args) ? call.input.args : [];
    const directory = directoryOf(call.input.directory);
    if (!directory || operationOutcome(call.content).status !== "executed") return undefined;
    const subcommand = typeof args[0] === "string" ? args[0] : "";
    if (changingGit.has(subcommand)) return this.#changed([directory]);
    if (subcommand !== "push") return undefined;
    const flow = this.#flows.get(directory);
    const branches = pushedBranches(args);
    // A push of other branches leaves the pull request as it is; one naming none pushes the checked-out branch's upstream,
    // and one naming HEAD the checked-out branch: either may be its branch.
    if (!pushMoves(branches, flow?.branch)) return undefined;
    return this.#pushedAgain(flow, operationOutcome(call.content).result, settings, now);
  }

  /** A push to a pull request that is ready: new commits for its reviewers, so a new review window. Not one that moved nothing. */
  #pushedAgain(flow: PullRequestFlow | undefined, result: string, settings: PrFlowSettings, now: number): string | undefined {
    if (!flow || flow.windowStart === undefined || done(flow) || upToDate.test(result)) return undefined;
    flow.windowStart = now;
    return reviewNote(flow, settings, true) || undefined;
  }

  #pushed(call: ObservedCall, settings: PrFlowSettings, now: number): string | undefined {
    const directory = directoryOf(call.input.directory);
    const outcome = operationOutcome(call.content);
    if (!directory || outcome.status !== "executed" || call.input.tag !== undefined) return undefined;
    const flow = this.#flow(directory);
    const pull = pushedPullRequest(outcome.result);
    const request = call.input.pull_request && typeof call.input.pull_request === "object" ? call.input.pull_request as Record<string, unknown> : undefined;
    const branch = typeof call.input.branch === "string" ? call.input.branch : undefined;
    // A push with no pull request (none asked, or none opened): only new commits on the branch of one that is ready.
    if (!pull) return request || (flow.branch && branch !== flow.branch) ? undefined : this.#pushedAgain(flow, outcome.result, settings, now);
    const same = flow.pull?.number === pull.number;
    const wasReady = flow.windowStart !== undefined && same;
    const wasDraft = flow.draft === true && same;
    flow.pull = { number: pull.number, url: pull.url };
    if (branch) flow.branch = branch;
    if (pull.draft !== undefined) flow.draft = pull.draft;
    if (flow.draft === true) {
      // Said once per draft: later pushes to it only update it.
      if (wasDraft) return undefined;
      return draftNote(flow, `git_push {directory: "${directory}", branch: <the session branch>, pull_request: {title, body, draft: false}}, `
        + "with a title and body for the finished change");
    }
    if (flow.draft === false || request?.draft === false) return this.#ready(flow, wasReady, settings, now);
    return undefined;
  }

  /** `flow`'s pull request is ready for review: its window starts (again, if `again`). */
  #ready(flow: PullRequestFlow, again: boolean, settings: PrFlowSettings, now: number): string | undefined {
    flow.draft = false;
    flow.windowStart = now;
    return reviewNote(flow, settings, again) || undefined;
  }

  /**
   * A forge's command-line tool opening, readying or merging a pull request: where the session has no git_push, and on
   * forges github_merge doesn't reach (GitLab, Azure DevOps). Its call already succeeded (`isError` is false).
   */
  #forge(call: ObservedCall, settings: PrFlowSettings, now: number): string | undefined {
    const args = Array.isArray(call.input.args) ? call.input.args : [];
    const step = forgeStep(call.toolName, args);
    if (!step) return undefined;
    const output = operationOutcome(call.content).result;
    if (step === "create") {
      const directory = directoryOf(call.input.directory);
      const pull = pullRequestAddress(output);
      if (!directory || !pull) return undefined;
      if (done(this.#flows.get(directory))) this.#flows.delete(directory);
      const flow = this.#flow(directory);
      if (flow.pull?.number === pull.number) return undefined;
      flow.pull = pull;
      const branch = createdBranch(call.toolName, args);
      if (branch) flow.branch = branch;
      flow.draft = asksDraft(call.toolName, args);
      if (!flow.draft) return this.#ready(flow, false, settings, now);
      return draftNote(flow, call.toolName === "glab" ? `glab mr update ${pull.number} --ready (with --title and --description for the finished change)`
        : call.toolName === "az" ? `az repos pr update --id ${pull.number} --draft false (with --title and --description for the finished change)`
        : `gh pr ready ${pull.number} (after gh pr edit ${pull.number} --title --body for the finished change)`);
    }
    // Readying and merging name the pull request by number, or (gh, glab) mean the checked-out branch's. A call in a clone
    // with a pull request is about that one only, never another clone's. Elsewhere, only open pull requests of this
    // tool's forge count (GitHub's #4 and GitLab's !4 are different ones), and only one the call singles out.
    const number = namedPull(args);
    const own = (() => { const directory = directoryOf(call.input.directory); return directory ? this.#flows.get(directory) : undefined; })();
    const usable = (item: PullRequestFlow | undefined) => !!item?.pull && !done(item) && forgeOwns(call.toolName, item.pull.url)
      && (number === undefined || item.pull.number === number);
    const others = this.flows.filter(usable);
    const flow = own?.pull ? (usable(own) ? own : undefined) : others.length === 1 ? others[0] : undefined;
    if (!flow) return undefined;
    if (step === "ready") return flow.draft === false ? undefined : this.#ready(flow, false, settings, now);
    return scheduledMerge.test(output) ? undefined : this.#merge(flow);
  }

  #merge(flow: PullRequestFlow): string {
    flow.merged = true;
    return `[pr-flow] #${flow.pull!.number} is merged. Tell the person, with its link: ${flow.pull!.url}.`;
  }

  /** github_read of one of the session's pull requests: merged or closed some other way (by a person, say). */
  #read(call: ObservedCall): string | undefined {
    let view: { url?: unknown; state?: unknown; pullRequest?: { merged?: unknown } } | null;
    try { view = JSON.parse(operationOutcome(call.content).result); } catch { return undefined; }
    if (!view || typeof view !== "object" || typeof view.url !== "string") return undefined;
    const flow = this.flows.find(item => item.pull?.url === view!.url && !done(item));
    if (!flow) return undefined;
    if (view.pullRequest && typeof view.pullRequest === "object" && view.pullRequest.merged === true) return this.#merge(flow);
    if (view.state !== "closed") return undefined;
    flow.closed = true;
    return `[pr-flow] #${flow.pull!.number} was closed without merging. Tell the person, with its link: ${flow.pull!.url}; don't reopen it unless they ask.`;
  }

  #merged(call: ObservedCall): string | undefined {
    const outcome = operationOutcome(call.content);
    if (outcome.status !== "executed") return undefined;
    const repository = typeof call.input.repository === "string" ? call.input.repository : "";
    const flow = this.flows.find(item => item.pull && item.pull.number === call.input.pull && githubRepository(item.pull.url) === repository);
    return flow ? this.#merge(flow) : undefined;
  }
}

/** Where each of the session's pull requests stands, for the prompt. */
function flowLine(flow: PullRequestFlow, settings: PrFlowSettings, now: number): string {
  if (!flow.pull) return `- ${flow.directory}: changed, no pull request yet: open its draft now.`;
  const pull = `#${flow.pull.number} (${flow.pull.url})`;
  if (flow.merged) return `- ${flow.directory}: ${pull} is merged.`;
  if (flow.closed) return `- ${flow.directory}: ${pull} was closed without merging.`;
  if (flow.draft === true) return `- ${flow.directory}: draft ${pull}: make it ready for review once the change is done.`;
  // Found by a push that didn't say whether it is a draft.
  if (flow.draft === undefined) return `- ${flow.directory}: ${pull} is open; if it is still a draft, make it ready for review once the change is done.`;
  if (flow.windowStart === undefined) return `- ${flow.directory}: ${pull} is open.`;
  if (settings.reviewMinutes === 0) return `- ${flow.directory}: ${pull} is ready for review: merge it.`;
  const end = flow.windowStart + settings.reviewMinutes * 60_000;
  return end > now
    ? `- ${flow.directory}: ${pull} is ready for review; its review window ends at ${clock(end)}.`
    : `- ${flow.directory}: ${pull} is ready for review; its review window ended at ${clock(end)}: address what reviews came in, or merge.`;
}

/** The flow, as the prompt section of each message: the steps, the workspace's settings, and where things stand. */
export function prFlowPrompt(settings: PrFlowSettings, flows: readonly PullRequestFlow[] = [], now = Date.now()): string {
  const window = minutes(settings.reviewMinutes);
  const merge = `merge it: on GitHub with github_merge {repository, pull, sha: its head commit as github_read reports it, method: "${settings.mergeMethod}"}; `
    + "elsewhere with the forge's tool (glab mr merge, az repos pr update --status completed).";
  const review = settings.reviewMinutes === 0
    ? [`4. Merge at once. This workspace's review window is 0 minutes: as soon as the pull request is ready, ${merge}${checksStep(settings)} Don't wait for reviews.`]
    : [
      `4. Wait for review: ${window}. From when it is ready, wait up to ${window} for reviews: on GitHub, github_read {repository, issue, wait: "change", timeout_seconds} `
        + `(at most ${GITHUB_WAIT_SECONDS} seconds a call, so call it again, or loop in a code mode script, until the window ends); elsewhere read its reviews and `
        + "discussions with the forge's tool (glab, az).",
      "   - Judge each review point and comment on its merits. Fix the valid ones (a real bug, a reasonable request within the task), commit, push to the session "
        + "branch and answer the point with what you changed; answer one you judge invalid with why, briefly, and leave the code as it is. On GitHub, answer "
        + `with github_comment. A pushed fix starts a new ${minuteWindow(settings.reviewMinutes)} window, for re-review.`,
      `   - Approved with nothing left to address: ${merge} Don't wait out the window. The window ends with nothing new to address: merge it the same way.`,
      "   - Never merge over a request for changes you didn't make: if a reviewer's latest review still requests changes once the re-review window ends, "
        + "leave the pull request open and tell the person why.",
      ...(settings.waitForChecks ? [`   -${checksStep(settings)}`] : []),
    ];
  const lines = [
    "## Pull request flow",
    "",
    "This workspace carries each change to a repository through a pull request (a merge request on GitLab), from the first edit to the merge. Follow it whenever "
      + "you change files in a clone of one of the workspace's repositories, unless the person asks for something else (no pull request, no merge, another branch). "
      + "Questions, reviews and explorations that change nothing need none of it.",
    "",
    "1. A draft at the first change. As soon as you start changing a clone, before going further: commit with git, push to the session's own branch "
      + "(git push origin HEAD:<the session branch>), and open a draft with git_push {directory, branch: <the session branch>, pull_request: {title, body, draft: true}}. "
      + "One pull request per clone; later pushes to the session branch update it.",
    "2. Keep it current: commit and push to the session branch as the work goes on.",
    "3. Ready for review when done. Once the change is complete, its tests pass and its last commit is pushed, make it ready: git_push {directory, branch: "
      + "<the session branch>, pull_request: {title, body, draft: false}}, with a title and body for the finished change.",
    ...review,
    "5. If the forge refuses the merge (branch protection, required reviews or checks), say so and stop rather than work around it.",
    "6. Tell the person the pull request's link when it opens, when it is ready, and when it is merged or left open.",
    "",
    "Where there is no git_push (a host whose sessions push with git itself), do the same with the forge's tool: gh pr create --draft, gh pr ready and "
      + "gh pr merge; glab mr create --draft, glab mr update --ready and glab mr merge.",
  ];
  const known = flows.filter(flow => flow.pull || flow.told);
  if (known.length) lines.push("", `This session's pull requests, as of ${clock(now)}:`, ...known.map(flow => flowLine(flow, settings, now)));
  return lines.join("\n");
}

export const prFlowExtension: ExtensionFactory = pi => {
  pi.registerFlag("review-minutes", { type: "string", default: String(DEFAULT_REVIEW_MINUTES), description: prFlowFlags["review-minutes"] });
  pi.registerFlag("merge-method", { type: "string", default: "squash", description: prFlowFlags["merge-method"] });
  pi.registerFlag("wait-for-checks", { type: "boolean", default: true, description: prFlowFlags["wait-for-checks"] });
  const settings = (): PrFlowSettings => ({
    reviewMinutes: reviewMinutes(pi.getFlag("review-minutes")),
    mergeMethod: mergeMethod(pi.getFlag("merge-method")),
    waitForChecks: pi.getFlag("wait-for-checks") !== false,
  });
  const state = new PrFlowState();

  pi.on("before_agent_start", event => ({ systemPrompt: `${event.systemPrompt}\n\n${prFlowPrompt(settings(), state.flows)}` }));

  pi.on("tool_result", (event: ToolResultEvent, ctx: ExtensionContext) => {
    const worktree = ctx?.cwd;
    const note = state.observe({ toolName: event.toolName, input: (event.input ?? {}) as Record<string, unknown>, content: event.content ?? [], isError: event.isError === true },
      settings(), worktree, directory => !!worktree && existsSync(join(worktree, directory, ".git")), Date.now());
    if (!note) return undefined;
    return { content: [...(event.content ?? []), { type: "text" as const, text: note }] };
  });
};
