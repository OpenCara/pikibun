import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative } from "node:path";
import type { ExtensionContext, ExtensionFactory, ToolCallEvent, ToolResultEvent } from "@earendil-works/pi-coding-agent";

export const prFlowFlags = Object.freeze({
  "review-minutes": "How long to wait for reviews once a pull request is ready for review, and again for a re-review after pushed fixes, in minutes. 0 merges it (or, with auto-merge off, hands it over) as soon as it is ready, without waiting for reviews",
  "merge-method": "How to merge: squash (default), merge or rebase",
  "wait-for-checks": "Wait for the pull request's checks to finish, and fix failing ones, before merging",
  "auto-merge": "Merge the pull request once it is approved, or once its review window ends with nothing left to address. Off leaves the merge to people: the agent tells the person it is ready to merge instead",
  "pre-push-check": "A check that must pass in a clone before the session pushes it, after it changed files there: words of the command, such as tests/no-comments.test.ts or pnpm check:fast. A push before a run of a program tool (node, python, rust, go, dotnet, make) whose command holds them passed in that clone is refused. Empty checks nothing",
  "wait-for-review": "Wait review-minutes for reviews once a pull request is ready. Off skips the review window whatever review-minutes says: the agent merges (or, with auto-merge off, hands it over) as soon as it is ready",
  "draft-first": "Open a draft pull request at the first change in a clone. Off has the agent commit and push to the session branch as it works and open the pull request, ready for review, only once the change is done",
  "require-approval": "Merge only a pull request that is approved. A review window that ends without an approval (or, with no window, a pull request not yet approved) is handed over to people instead of merged",
});

export const DEFAULT_REVIEW_MINUTES = 30;
export const MAX_REVIEW_MINUTES = 7 * 24 * 60;
const GITHUB_WAIT_SECONDS = 1800;

export type MergeMethod = "squash" | "merge" | "rebase";
export interface PrFlowSettings {
  reviewMinutes: number; mergeMethod: MergeMethod; waitForChecks: boolean; autoMerge: boolean; prePushCheck?: string; draftFirst?: boolean; requireApproval?: boolean;
}

export function prePushCheck(setting: unknown): string {
  return typeof setting === "string" ? setting.replace(/\s+/g, " ").trim().slice(0, 500) : "";
}

export function reviewMinutes(setting: unknown): number {
  const text = typeof setting === "number" ? String(setting) : typeof setting === "string" ? setting.trim() : "";
  if (!/^\d+$/.test(text)) return DEFAULT_REVIEW_MINUTES;
  return Math.min(Number(text), MAX_REVIEW_MINUTES);
}

export function mergeMethod(setting: unknown): MergeMethod {
  const value = typeof setting === "string" ? setting.trim().toLowerCase() : "";
  return value === "merge" || value === "rebase" ? value : "squash";
}

export function switchSetting(setting: unknown, fallback: boolean): boolean {
  if (typeof setting === "boolean") return setting;
  if (typeof setting === "number") return setting !== 0;
  if (typeof setting !== "string") return fallback;
  const value = setting.trim().toLowerCase();
  if (["true", "on", "yes", "1"].includes(value)) return true;
  if (["false", "off", "no", "0"].includes(value)) return false;
  return fallback;
}

export function autoMerge(setting: unknown): boolean {
  return switchSetting(setting, true);
}

const draftFirst = (settings: PrFlowSettings) => settings.draftFirst !== false;
const approvalOnly = (settings: PrFlowSettings) => settings.autoMerge && settings.requireApproval === true;

function list(items: readonly string[]): string {
  return items.length < 2 ? items.join("") : `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`;
}

export interface PullRequestFlow {
  directory: string;
  pull?: { number: number; url: string };
  branch?: string;
  draft?: boolean;
  windowStart?: number;
  merged?: boolean;
  closed?: boolean;
  told?: boolean;
}

export interface ObservedCall {
  toolName: string;
  input: Record<string, unknown>;
  content: readonly { type: string; text?: string }[];
  isError: boolean;
}

const changingTools: Readonly<Record<string, readonly string[]>> = Object.freeze({
  write: ["path"], edit: ["path"], write_file: ["path"], edit_file: ["path"], move_file: ["from", "to"], copy_file: ["to"], delete_file: ["path"],
});

const upToDate = /\bEverything up-to-date\b|\bis already up to date\b/;

export function pushedBranches(args: readonly unknown[]): string[] {
  const positional = args.slice(1).filter((arg): arg is string => typeof arg === "string" && !arg.startsWith("-"));
  return positional.slice(1).map(refspec => {
    const destination = refspec.includes(":") ? refspec.slice(refspec.lastIndexOf(":") + 1) : refspec;
    const branch = destination.replace(/^\+/, "").replace(/^refs\/heads\//, "");
    return branch === "@" ? "HEAD" : branch;
  }).filter(Boolean);
}

function pushMoves(branches: readonly string[], branch: string | undefined): boolean {
  return !branch || !branches.length || branches.includes(branch) || branches.includes("HEAD");
}

export function forgeOwns(tool: string, url: string): boolean {
  if (tool === "glab") return /\/merge_requests\/\d+$/.test(url);
  if (tool === "az") return /\/pullrequest\/\d+$/.test(url);
  return tool === "gh" && /\/pull\/\d+$/.test(url);
}

export function pullRequestAddress(text: string): { number: number; url: string } | undefined {
  const match = /https:\/\/\S+?\/(?:pull|merge_requests|pullrequest|pull-requests)\/(\d+)/.exec(text);
  return match ? { number: Number(match[1]), url: match[0] } : undefined;
}

export function forgeStep(tool: string, args: readonly unknown[]): "create" | "ready" | "merge" | undefined {
  const words = args.filter((arg): arg is string => typeof arg === "string");
  const has = (...options: string[]) => words.some(word => options.some(option => word === option || word.startsWith(`${option}=`)));
  const [first, second, third] = words;
  if (tool === "gh" && first === "pr") {
    if (second === "create") return "create";
    if (second === "ready" && !has("--undo")) return "ready";
    if (second === "merge" && !has("--auto", "--disable-auto")) return "merge";
  }
  if (tool === "glab" && first === "mr") {
    if (second === "create" || second === "new") return "create";
    if (second === "update" && has("--ready")) return "ready";
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

const scheduledMerge = /when (?:the )?pipeline succeeds|auto-?merge|will be merged/i;

export function asksDraft(tool: string, args: readonly unknown[]): boolean {
  const words = args.filter((arg): arg is string => typeof arg === "string");
  if (tool === "gh") return words.some(word => word === "--draft" || word === "-d" || word === "--draft=true");
  if (tool === "glab") return words.some(word => word === "--draft" || word === "--wip" || word === "--draft=true");
  const at = words.findIndex(word => word === "--draft" || word.startsWith("--draft="));
  if (at < 0) return false;
  const word = words[at]!;
  return (word.startsWith("--draft=") ? word.slice(8) : words[at + 1]) !== "false";
}

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

const changingGit = new Set(["commit", "merge", "rebase", "cherry-pick", "revert", "am", "apply", "mv", "rm"]);

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

function directoryOf(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const parts = value.split(/[\\/]+/).filter(part => part && part !== ".");
  return parts.length && !parts.some(part => part === "..") ? parts.join("/") : undefined;
}

export function operationOutcome(content: ObservedCall["content"]): { status?: string; result: string } {
  const text = content.flatMap(part => part.type === "text" && typeof part.text === "string" ? [part.text] : []).join("\n");
  try {
    const value = JSON.parse(text) as { status?: unknown; result?: unknown } | null;
    if (value && typeof value === "object" && !Array.isArray(value)) {
      return { ...(typeof value.status === "string" ? { status: value.status } : {}), result: typeof value.result === "string" ? value.result : text };
    }
  } catch { }
  return { result: text };
}

export function pushedPullRequest(result: string): { number: number; url: string; draft?: boolean } | undefined {
  const match = /Pull request #(\d+) (?:opened|already open)(, a draft|, ready for review)?: (https:\/\/\S+)/.exec(result);
  if (!match) return undefined;
  return { number: Number(match[1]), url: match[3]!, ...(match[2] ? { draft: match[2] === ", a draft" } : {}) };
}

export function githubRepository(url: string): string | undefined {
  return /^https:\/\/github\.com\/([A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9_.-]+)\/pull\/\d+/.exec(url)?.[1];
}

function draftNote(flow: PullRequestFlow, readyCall: string): string {
  const pull = flow.pull!;
  return `[pr-flow] Draft #${pull.number} is open: ${pull.url}. Tell the person its link. Keep committing and pushing to the session branch as you work; `
    + `once the change is done (its tests pass, its last commit pushed), make it ready for review: ${readyCall}.`;
}

function done(flow: PullRequestFlow | undefined): boolean {
  return flow?.merged === true || flow?.closed === true;
}

function clock(at: number): string {
  return new Date(at).toISOString().replace(/\.\d{3}Z$/, "Z");
}

function minutes(count: number): string {
  return count === 1 ? "1 minute" : `${count} minutes`;
}

function minuteWindow(count: number): string {
  return `${count}-minute`;
}

function mergeCall(flow: PullRequestFlow, settings: PrFlowSettings): string {
  const repository = flow.pull ? githubRepository(flow.pull.url) : undefined;
  return repository
    ? `github_merge {repository: "${repository}", pull: ${flow.pull!.number}, sha: <its head commit, as github_read reports it>, method: "${settings.mergeMethod}"}`
    : `the forge's tool (glab mr merge, az repos pr update --status completed), as a ${settings.mergeMethod} merge`;
}

function waitCall(flow: PullRequestFlow, settings: PrFlowSettings): string {
  const repository = flow.pull ? githubRepository(flow.pull.url) : undefined;
  const seconds = Math.min(settings.reviewMinutes * 60, GITHUB_WAIT_SECONDS);
  return repository
    ? `github_read {repository: "${repository}", issue: ${flow.pull!.number}, wait: "change", timeout_seconds: ${seconds}} (again until then, at most ${GITHUB_WAIT_SECONDS} seconds a call; a code mode script can loop)`
    : "reading its reviews and discussions with the forge's tool (glab, az) until then";
}

const checksStep = (settings: PrFlowSettings) => settings.waitForChecks
  ? ` Before ${settings.autoMerge ? "merging" : "telling the person it is ready to merge"}, let its checks finish (on GitHub, github_read with wait: "checks") `
    + "and fix any that fail, pushing the fix as you would for a review point."
  : "";

const handOver = "tell the person, with its link, that it is ready for them to merge, and leave it open: don't merge it yourself, nor queue an automatic merge";

function reviewNote(flow: PullRequestFlow, settings: PrFlowSettings, again: boolean): string {
  const pull = flow.pull ? `#${flow.pull.number}` : "The pull request";
  if (settings.reviewMinutes === 0) {
    if (again) return "";
    return settings.autoMerge
      ? `[pr-flow] ${pull} is ready for review. This workspace's review window is 0 minutes: merge it now, without waiting for reviews, with ${mergeCall(flow, settings)}.${checksStep(settings)}`
      : `[pr-flow] ${pull} is ready for review. This workspace's review window is 0 minutes and it leaves merges to people (auto-merge is off): ${handOver}.${checksStep(settings)}`;
  }
  const until = clock(flow.windowStart! + settings.reviewMinutes * 60_000);
  const finish = settings.autoMerge
    ? `Merge, with ${mergeCall(flow, settings)}, once it is approved with nothing left to address, or once the window ends with nothing new to address.`
    : "This workspace leaves merges to people (auto-merge is off): once it is approved with nothing left to address, or once the window ends with nothing new "
      + `to address, ${handOver}.`;
  return `[pr-flow] ${pull} ${again ? "has new commits, so its re-review window starts again" : "is ready for review"}: wait for reviews until ${until} `
    + `(${minutes(settings.reviewMinutes)}) with ${waitCall(flow, settings)}. Fix the review points you judge valid, push, and answer each point; `
    + `a pushed fix starts a new ${minuteWindow(settings.reviewMinutes)} window. ${finish}${checksStep(settings)}`;
}

export class PrFlowState {
  readonly #flows = new Map<string, PullRequestFlow>();

  get flows(): PullRequestFlow[] { return [...this.#flows.values()]; }

  #flow(directory: string): PullRequestFlow {
    let flow = this.#flows.get(directory);
    if (!flow) this.#flows.set(directory, flow = { directory });
    return flow;
  }

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
    if (!pushMoves(branches, flow?.branch)) return undefined;
    return this.#pushedAgain(flow, operationOutcome(call.content).result, settings, now);
  }

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
    if (!pull) return request || (flow.branch && branch !== flow.branch) ? undefined : this.#pushedAgain(flow, outcome.result, settings, now);
    const same = flow.pull?.number === pull.number;
    const wasReady = flow.windowStart !== undefined && same;
    const wasDraft = flow.draft === true && same;
    flow.pull = { number: pull.number, url: pull.url };
    if (branch) flow.branch = branch;
    if (pull.draft !== undefined) flow.draft = pull.draft;
    if (flow.draft === true) {
      if (wasDraft) return undefined;
      return draftNote(flow, `git_push {directory: "${directory}", branch: <the session branch>, pull_request: {title, body, draft: false}}, `
        + "with a title and body for the finished change");
    }
    if (flow.draft === false || request?.draft === false) return this.#ready(flow, wasReady, settings, now);
    return undefined;
  }

  #ready(flow: PullRequestFlow, again: boolean, settings: PrFlowSettings, now: number): string | undefined {
    flow.draft = false;
    flow.windowStart = now;
    return reviewNote(flow, settings, again) || undefined;
  }

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

const programTools = new Set(["node", "python", "rust", "go", "dotnet", "make"]);
const contentGit = new Set(["merge", "rebase", "cherry-pick", "revert", "am", "apply", "pull", "reset", "restore", "checkout", "switch", "stash", "mv", "rm", "clean"]);
const pushValued = new Set(["--repo", "--receive-pack", "--exec", "-o", "--push-option", "--signed", "--force-with-lease"]);

function cloneDirectory(value: unknown, isClone: (directory: string) => boolean): string | undefined {
  const first = directoryOf(value)?.split("/")[0];
  return first && isClone(first) ? first : undefined;
}

export function commandLine(input: Record<string, unknown>): string {
  const args = Array.isArray(input.args) ? input.args.filter((arg): arg is string => typeof arg === "string") : [];
  return [typeof input.program === "string" ? input.program : "", ...args].join(" ").replace(/\s+/g, " ").trim();
}

function pushedClone(toolName: string, input: Record<string, unknown>, isClone: (directory: string) => boolean): string | undefined {
  if (toolName === "git_push") return input.tag === undefined ? cloneDirectory(input.directory, isClone) : undefined;
  if (toolName !== "git" || !Array.isArray(input.args) || input.args[0] !== "push") return undefined;
  const words = input.args.slice(1).filter((arg): arg is string => typeof arg === "string");
  if (words.some(word => ["--delete", "-d", "--dry-run", "-n"].includes(word))) return undefined;
  const positional: string[] = [];
  for (let index = 0; index < words.length; index++) {
    const word = words[index]!;
    if (word.startsWith("-")) { if (!word.includes("=") && pushValued.has(word)) index++; continue; }
    positional.push(word);
  }
  const branches = positional.slice(1).filter(refspec => {
    const spec = refspec.replace(/^\+/, "");
    if (spec.startsWith(":")) return false;
    return !spec.slice(spec.lastIndexOf(":") + 1).startsWith("refs/tags/");
  });
  if (!branches.length && (words.includes("--tags") || positional.length > 1)) return undefined;
  return cloneDirectory(input.directory, isClone);
}

export class PushGate {
  #tick = 0;
  readonly #changed = new Map<string, number>();
  readonly #passed = new Map<string, number>();

  observe(call: ObservedCall, check: string, worktree: string | undefined, isClone: (directory: string) => boolean): void {
    if (!check || call.isError) return;
    const changing = changingTools[call.toolName];
    if (changing) {
      for (const key of changing) { const clone = cloneOf(call.input[key], worktree, isClone); if (clone) this.#changed.set(clone, ++this.#tick); }
      return;
    }
    if (operationOutcome(call.content).status !== "executed") return;
    const clone = cloneDirectory(call.input.directory, isClone);
    if (!clone) return;
    if (call.toolName === "git") {
      const subcommand = Array.isArray(call.input.args) && typeof call.input.args[0] === "string" ? call.input.args[0] : "";
      if (contentGit.has(subcommand)) this.#changed.set(clone, ++this.#tick);
      return;
    }
    if (programTools.has(call.toolName) && commandLine(call.input).includes(check)) this.#passed.set(clone, ++this.#tick);
  }

  refusal(toolName: string, input: Record<string, unknown>, check: string, isClone: (directory: string) => boolean): string | undefined {
    if (!check) return undefined;
    const clone = pushedClone(toolName, input, isClone);
    const changed = clone ? this.#changed.get(clone) : undefined;
    if (!clone || changed === undefined || (this.#passed.get(clone) ?? 0) > changed) return undefined;
    return `[pr-flow] Not pushed: this workspace has \`${check}\` pass in a clone before each push (its pre-push-check), and it hasn't passed in ${clone} `
      + `since this session last changed files there. Run it there (directory: "${clone}"), fix what it finds, then push again.`;
  }
}

function flowLine(flow: PullRequestFlow, settings: PrFlowSettings, now: number): string {
  if (!flow.pull) return `- ${flow.directory}: changed, no pull request yet: open its draft now.`;
  const pull = `#${flow.pull.number} (${flow.pull.url})`;
  if (flow.merged) return `- ${flow.directory}: ${pull} is merged.`;
  if (flow.closed) return `- ${flow.directory}: ${pull} was closed without merging.`;
  if (flow.draft === true) return `- ${flow.directory}: draft ${pull}: make it ready for review once the change is done.`;
  if (flow.draft === undefined) return `- ${flow.directory}: ${pull} is open; if it is still a draft, make it ready for review once the change is done.`;
  if (flow.windowStart === undefined) return `- ${flow.directory}: ${pull} is open.`;
  if (settings.reviewMinutes === 0) {
    return settings.autoMerge ? `- ${flow.directory}: ${pull} is ready for review: merge it.`
      : `- ${flow.directory}: ${pull} is ready for review: tell the person it is ready for them to merge; don't merge it.`;
  }
  const end = flow.windowStart + settings.reviewMinutes * 60_000;
  return end > now
    ? `- ${flow.directory}: ${pull} is ready for review; its review window ends at ${clock(end)}.`
    : `- ${flow.directory}: ${pull} is ready for review; its review window ended at ${clock(end)}: address what reviews came in, or `
      + `${settings.autoMerge ? "merge" : "tell the person it is ready for them to merge; don't merge it"}.`;
}

export function prFlowPrompt(settings: PrFlowSettings, flows: readonly PullRequestFlow[] = [], now = Date.now()): string {
  const window = minutes(settings.reviewMinutes);
  const merge = settings.autoMerge
    ? `merge it: on GitHub with github_merge {repository, pull, sha: its head commit as github_read reports it, method: "${settings.mergeMethod}"}; `
      + "elsewhere with the forge's tool (glab mr merge, az repos pr update --status completed)."
    : `${handOver}.`;
  const review = settings.reviewMinutes === 0
    ? [settings.autoMerge
      ? `4. Merge at once. This workspace's review window is 0 minutes: as soon as the pull request is ready, ${merge}${checksStep(settings)} Don't wait for reviews.`
      : `4. Hand it over at once. This workspace's review window is 0 minutes: as soon as the pull request is ready, ${merge}${checksStep(settings)} Don't wait for reviews.`]
    : [
      `4. Wait for review: ${window}. From when it is ready, wait up to ${window} for reviews: on GitHub, github_read {repository, issue, wait: "change", timeout_seconds} `
        + `(at most ${GITHUB_WAIT_SECONDS} seconds a call, so call it again, or loop in a code mode script, until the window ends); elsewhere read its reviews and `
        + "discussions with the forge's tool (glab, az).",
      "   - Judge each review point and comment on its merits. Fix the valid ones (a real bug, a reasonable request within the task), commit, push to the session "
        + "branch and answer the point with what you changed; answer one you judge invalid with why, briefly, and leave the code as it is. On GitHub, answer "
        + `with github_comment. A pushed fix starts a new ${minuteWindow(settings.reviewMinutes)} window, for re-review.`,
      `   - Approved with nothing left to address: ${merge} Don't wait out the window. The window ends with nothing new to address: `
        + `${settings.autoMerge ? "merge it" : "hand it over"} the same way.`,
      "   - Never merge over a request for changes you didn't make: if a reviewer's latest review still requests changes once the re-review window ends, "
        + "leave the pull request open and tell the person why.",
      ...(settings.waitForChecks ? [`   -${checksStep(settings)}`] : []),
    ];
  const lines = [
    "## Pull request flow",
    "",
    "This workspace carries each change to a repository through a pull request (a merge request on GitLab), from the first edit to the merge"
      + `${settings.autoMerge ? "" : ", which it leaves to people (auto-merge is off)"}. Follow it whenever `
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
    settings.autoMerge
      ? "5. If the forge refuses the merge (branch protection, required reviews or checks), say so and stop rather than work around it."
      : "5. Never merge it yourself, nor queue an automatic merge (gh pr merge --auto, glab mr merge --auto-merge, az repos pr update --auto-complete), "
        + "unless the person asks you to: this workspace leaves merges to people.",
    "6. Tell the person the pull request's link when it opens, when it is ready, and when it is merged or left open.",
    ...(settings.prePushCheck ? [`7. Before each push of a clone you changed, run \`${settings.prePushCheck}\` there (directory: the clone) with the program tool it needs, and fix what it finds: `
      + "a push before it passed is refused."] : []),
    "",
    settings.autoMerge
      ? "Where there is no git_push (a host whose sessions push with git itself), do the same with the forge's tool: gh pr create --draft, gh pr ready and "
        + "gh pr merge; glab mr create --draft, glab mr update --ready and glab mr merge."
      : "Where there is no git_push (a host whose sessions push with git itself), do the same with the forge's tool: gh pr create --draft and gh pr ready; "
        + "glab mr create --draft and glab mr update --ready.",
  ];
  const known = flows.filter(flow => flow.pull || flow.told);
  if (known.length) lines.push("", `This session's pull requests, as of ${clock(now)}:`, ...known.map(flow => flowLine(flow, settings, now)));
  return lines.join("\n");
}

export const PR_FLOW_SKILL = "pull-request-flow";
export const PR_FLOW_SKILL_DESCRIPTION = "This workspace's pull request flow for every change to a repository, step by step: the draft at the first change, "
  + "ready for review once done, the review window and how to answer review points, checks, and the merge or the hand-over. Read it before you change files in a clone.";

export function prFlowSkill(settings: PrFlowSettings): string {
  const body = prFlowPrompt(settings).replace(/^## Pull request flow\n/, "# Pull request flow\n");
  return `---\nname: ${PR_FLOW_SKILL}\ndescription: ${JSON.stringify(PR_FLOW_SKILL_DESCRIPTION)}\n---\n\n${body}\n`;
}

export function prFlowRule(settings: PrFlowSettings, flows: readonly PullRequestFlow[] = [], now = Date.now()): string {
  const checks = settings.waitForChecks ? " once its checks pass" : "";
  const handOver = "tell the person it is ready for them to merge: this workspace leaves merges to people (auto-merge is off), so never merge it yourself, "
    + "nor queue an automatic merge";
  const after = settings.reviewMinutes === 0
    ? (settings.autoMerge ? `merge it (${settings.mergeMethod}) as soon as it is ready${checks}, without waiting for reviews` : `as soon as it is ready, ${handOver}`)
    : `then a ${minuteWindow(settings.reviewMinutes)} review window, in which you fix the review points you judge valid, answer each one, and wait again after `
      + `each pushed fix; then ${settings.autoMerge ? `merge it (${settings.mergeMethod})${checks}, but never over a request for changes you didn't make` : handOver}`;
  const lines = [
    "## Pull request flow",
    "",
    "This workspace carries each change to a repository through a pull request (a merge request on GitLab), from the first edit to the merge. Follow it "
      + "whenever you change files in a clone of one of the workspace's repositories, unless the person asks for something else (no pull request, no merge, "
      + "another branch). Questions, reviews and explorations that change nothing need none of it.",
    "",
    `In short: a draft pull request at your first change in a clone (commit, push to the session's own branch, open it as a draft); keep pushing as you work; `
      + `ready for review once the change is done and its tests pass; ${after}. Tell the person its link when it opens, `
      + `when it is ready, and when it is merged or left open. Before your first change in a clone, read the ${PR_FLOW_SKILL} skill (listed with the skills) `
      + "for each step's calls and its rules; after each step, the note added to the tool's result says what comes next.",
    ...(settings.prePushCheck ? ["", `Before each push of a clone you changed, run \`${settings.prePushCheck}\` there (directory: the clone) with the program tool it needs, `
      + "and fix what it finds: a push before it passed is refused."] : []),
  ];
  const known = flows.filter(flow => flow.pull || flow.told);
  if (known.length) lines.push("", `This session's pull requests, as of ${clock(now)}:`, ...known.map(flow => flowLine(flow, settings, now)));
  return lines.join("\n");
}

export function skillListed(event: unknown, name: string): boolean {
  const skills = (event as { systemPromptOptions?: { skills?: unknown } } | undefined)?.systemPromptOptions?.skills;
  return Array.isArray(skills) && skills.some(item => (item as { name?: unknown } | null)?.name === name);
}

export class SkillFolder {
  #directory: string | undefined;

  constructor(private readonly prefix: string) {}

  write(name: string, content: string): string {
    this.#directory ??= mkdtempSync(join(tmpdir(), this.prefix));
    const folder = join(this.#directory, name);
    mkdirSync(folder, { recursive: true });
    writeFileSync(join(folder, "SKILL.md"), content);
    return folder;
  }

  remove(): void {
    if (this.#directory) rmSync(this.#directory, { recursive: true, force: true });
    this.#directory = undefined;
  }
}

export const prFlowExtension: ExtensionFactory = pi => {
  pi.registerFlag("review-minutes", { type: "string", default: String(DEFAULT_REVIEW_MINUTES), description: prFlowFlags["review-minutes"] });
  pi.registerFlag("merge-method", { type: "string", default: "squash", description: prFlowFlags["merge-method"] });
  pi.registerFlag("wait-for-checks", { type: "boolean", default: true, description: prFlowFlags["wait-for-checks"] });
  pi.registerFlag("auto-merge", { type: "boolean", default: true, description: prFlowFlags["auto-merge"] });
  pi.registerFlag("pre-push-check", { type: "string", default: "", description: prFlowFlags["pre-push-check"] });
  const settings = (): PrFlowSettings => ({
    reviewMinutes: reviewMinutes(pi.getFlag("review-minutes")),
    mergeMethod: mergeMethod(pi.getFlag("merge-method")),
    waitForChecks: pi.getFlag("wait-for-checks") !== false,
    autoMerge: autoMerge(pi.getFlag("auto-merge")),
    prePushCheck: prePushCheck(pi.getFlag("pre-push-check")),
  });
  const state = new PrFlowState();
  const gate = new PushGate();
  const clones = (worktree: string | undefined) => (directory: string) => !!worktree && existsSync(join(worktree, directory, ".git"));

  const skill = new SkillFolder("pi-pr-flow-");

  pi.on("resources_discover", () => {
    try { return { skillPaths: [skill.write(PR_FLOW_SKILL, prFlowSkill(settings()))] }; }
    catch { return undefined; }
  });

  pi.on("session_shutdown", () => { skill.remove(); });

  pi.on("before_agent_start", event => ({
    systemPrompt: `${event.systemPrompt}\n\n${skillListed(event, PR_FLOW_SKILL) ? prFlowRule(settings(), state.flows) : prFlowPrompt(settings(), state.flows)}`,
  }));

  pi.on("tool_call", (event: ToolCallEvent, ctx: ExtensionContext) => {
    const reason = gate.refusal(event.toolName, (event.input ?? {}) as Record<string, unknown>, settings().prePushCheck ?? "", clones(ctx?.cwd));
    return reason ? { block: true, reason } : undefined;
  });

  pi.on("tool_result", (event: ToolResultEvent, ctx: ExtensionContext) => {
    const worktree = ctx?.cwd;
    const call = { toolName: event.toolName, input: (event.input ?? {}) as Record<string, unknown>, content: event.content ?? [], isError: event.isError === true };
    gate.observe(call, settings().prePushCheck ?? "", worktree, clones(worktree));
    const note = state.observe(call, settings(), worktree, clones(worktree), Date.now());
    if (!note) return undefined;
    return { content: [...(event.content ?? []), { type: "text" as const, text: note }] };
  });
};
