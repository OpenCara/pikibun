#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const root = process.env.PIKIBUN_EVAL_FORGE ?? "";
const args = process.argv.slice(2);
const HOST = "https://forge.eval.test";

function fail(message, code = 1) {
  process.stderr.write(`${message}\n`);
  process.exit(code);
}

function git(directory, words) {
  try { return execFileSync("git", words, { cwd: directory, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim(); }
  catch { return ""; }
}

if (!root) fail("gh: the eval's forge is not set up (PIKIBUN_EVAL_FORGE)");
const current = JSON.parse(readFileSync(join(root, "current.json"), "utf8"));
const names = Object.keys(current.repositories);

const valued = new Set(["-R", "--repo", "-t", "--title", "-b", "--body", "-F", "--body-file", "-H", "--head", "-B", "--base", "--json", "-q", "--jq", "-i", "--interval",
  "--match-head-commit", "-s", "--state", "-L", "--limit", "--subject", "-a", "--assignee", "-l", "--label", "-r", "--reviewer", "--template", "--branch", "--commit",
  "--workflow", "-w", "--event", "-u", "--user", "--job", "-S", "--search", "-A", "--author", "-m", "--milestone", "--required", "-X", "--method", "-f", "-H", "--hostname"]);
if (args.includes("merge")) for (const short of ["-s", "-r", "-m"]) valued.delete(short);
const options = new Map();
const words = [];
for (let index = 0; index < args.length; index++) {
  const word = args[index];
  if (word.startsWith("--") && word.includes("=")) { options.set(word.slice(0, word.indexOf("=")), word.slice(word.indexOf("=") + 1)); continue; }
  if (word.startsWith("-") && word.length > 1) {
    if (valued.has(word)) { options.set(word, args[index + 1] ?? ""); index++; } else options.set(word, true);
    continue;
  }
  words.push(word);
}
const option = (...keys) => { for (const key of keys) if (options.has(key)) return options.get(key); return undefined; };
const flag = (...keys) => keys.some(key => options.get(key) === true || options.get(key) === "true");

function repositoryName() {
  const named = option("-R", "--repo");
  if (typeof named === "string" && named) {
    const name = named.replace(/\.git$/, "").split("/").filter(Boolean).at(-1);
    if (name && names.includes(name)) return name;
    fail(`GraphQL: Could not resolve to a Repository with the name '${named}'. This forge has ${names.map(name => current.repositories[name].slug).join(", ")}.`);
  }
  const origin = git(process.cwd(), ["config", "--get", "remote.origin.url"]).replace(/^file:\/\//, "").replace(/\/+$/, "");
  const match = names.find(name => current.repositories[name].remote === origin);
  if (match) return match;
  if (names.length === 1) return names[0];
  fail(`gh: not in a clone of one of this forge's repositories: name one with --repo (${names.map(name => current.repositories[name].slug).join(", ")})`);
}

const [group, command, ...rest] = words;
const record = { at: new Date().toISOString(), args, cwd: process.cwd() };

if (flag("--version") || group === "version") {
  process.stdout.write("gh version 2.74.0 (pikibun eval forge)\n");
  process.exit(0);
}
if (group === "auth" && command === "status") {
  process.stdout.write("forge.eval.test\n  ✓ Logged in to forge.eval.test account eval-owner\n");
  process.exit(0);
}

const name = repositoryName();
const repository = current.repositories[name];
const statePath = join(root, "state", `${name}.json`);
const state = JSON.parse(readFileSync(statePath, "utf8"));
const save = () => writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`);
appendFileSync(join(root, "calls.jsonl"), `${JSON.stringify({ ...record, repository: name })}\n`);

const url = pull => `${HOST}/${repository.slug}/pull/${pull.number}`;
const remoteRef = branch => git(repository.remote, ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`]);

function checksOf(pull) {
  const checks = state.scenario.checks ?? [{ name: "test", state: "SUCCESS" }];
  const pendingMs = state.scenario.checksPendingMs ?? 0;
  pull.checksSince ??= Date.now();
  const done = pull.checksDone === true || Date.now() - pull.checksSince >= pendingMs;
  return checks.map(check => ({ name: check.name, state: done ? check.state : "PENDING", workflow: "CI", link: `${HOST}/${repository.slug}/actions/runs/${9000 + pull.number}` }));
}

function reviewsOf(pull) {
  return pull.draft ? [] : state.scenario.reviews ?? [];
}

function decision(pull) {
  const reviews = reviewsOf(pull);
  if (reviews.some(review => review.state === "CHANGES_REQUESTED")) return "CHANGES_REQUESTED";
  if (reviews.some(review => review.state === "APPROVED")) return "APPROVED";
  return "";
}

function fields(pull) {
  const checks = checksOf(pull);
  return {
    number: pull.number, url: url(pull), title: pull.title, body: pull.body, state: pull.state, isDraft: pull.draft, closed: pull.state !== "OPEN",
    headRefName: pull.head, baseRefName: pull.base, headRefOid: remoteRef(pull.head), author: { login: "eval-owner" },
    reviewDecision: decision(pull), reviews: reviewsOf(pull).map(review => ({ author: { login: review.author }, state: review.state, body: review.body })),
    latestReviews: reviewsOf(pull).map(review => ({ author: { login: review.author }, state: review.state, body: review.body })),
    comments: pull.comments ?? [], mergeable: "MERGEABLE", mergeStateStatus: decision(pull) === "CHANGES_REQUESTED" ? "BLOCKED" : "CLEAN",
    mergedAt: pull.mergedAt ?? null, statusCheckRollup: checks.map(check => ({ name: check.name, status: check.state === "PENDING" ? "IN_PROGRESS" : "COMPLETED",
      conclusion: check.state === "PENDING" ? "" : check.state, workflowName: check.workflow })),
  };
}

function path(value, expression) {
  if (!/^(\.[A-Za-z_][A-Za-z0-9_]*)+$/.test(expression)) return undefined;
  let found = value;
  for (const key of expression.slice(1).split(".")) found = found === null || typeof found !== "object" ? undefined : found[key];
  return found;
}

function json(value) {
  const wanted = option("--json");
  const picked = typeof wanted === "string" && wanted
    ? (Array.isArray(value) ? value.map(item => Object.fromEntries(wanted.split(",").map(key => [key, item[key] ?? null])))
      : Object.fromEntries(wanted.split(",").map(key => [key, value[key] ?? null])))
    : value;
  const query = option("-q", "--jq");
  const narrowed = typeof query === "string" && query !== "." ? path(picked, query) : undefined;
  if (narrowed !== undefined) process.stdout.write(`${typeof narrowed === "string" ? narrowed : JSON.stringify(narrowed)}\n`);
  else process.stdout.write(`${JSON.stringify(picked)}\n`);
}

function selected(selector) {
  const open = state.pulls.filter(pull => pull.state === "OPEN");
  if (selector) {
    const number = /^#?(\d+)$/.exec(selector)?.[1] ?? /\/pull\/(\d+)/.exec(selector)?.[1];
    const found = number ? state.pulls.find(pull => pull.number === Number(number)) : state.pulls.findLast(pull => pull.head === selector);
    return found ?? fail(`GraphQL: Could not resolve to a PullRequest with the number of ${selector}. (repository.pullRequest)`);
  }
  const branch = git(process.cwd(), ["rev-parse", "--abbrev-ref", "HEAD"]);
  const mine = state.pulls.findLast(pull => pull.head === branch);
  if (mine) return mine;
  if (open.length === 1) return open[0];
  return fail(`no pull requests found for branch "${branch || "HEAD"}"`);
}

function describe(pull) {
  const reviews = reviewsOf(pull);
  const lines = [
    `title:\t${pull.title}`, `state:\t${pull.draft && pull.state === "OPEN" ? "DRAFT" : pull.state}`, "author:\teval-owner", `number:\t${pull.number}`, `url:\t${url(pull)}`,
    `head:\t${pull.head}`, `base:\t${pull.base}`, `review decision:\t${decision(pull) || "REVIEW_REQUIRED"}`, "--", pull.body || "No description provided",
  ];
  if (reviews.length || flag("--comments", "-c")) {
    for (const review of reviews) lines.push("--", `review by ${review.author}: ${review.state}`, review.body);
    for (const comment of pull.comments ?? []) lines.push("--", `comment by ${comment.author.login}:`, comment.body);
  }
  return `${lines.join("\n")}\n`;
}

async function checks(pull) {
  const watch = flag("--watch");
  if (watch) {
    const wait = Math.max(0, (state.scenario.checksPendingMs ?? 0) - (Date.now() - (pull.checksSince ?? Date.now())));
    await delay(Math.min(wait, state.scenario.watchMs ?? 3000));
    pull.checksDone = true;
    save();
  }
  const list = checksOf(pull);
  save();
  if (option("--json")) return json(list.map(check => ({ name: check.name, state: check.state, bucket: check.state === "SUCCESS" ? "pass" : check.state === "PENDING" ? "pending" : "fail",
    workflow: check.workflow, link: check.link })));
  const failed = list.filter(check => check.state === "FAILURE").length;
  const pending = list.filter(check => check.state === "PENDING").length;
  const passed = list.filter(check => check.state === "SUCCESS").length;
  const head = failed ? "Some checks were not successful" : pending ? "Some checks are still pending" : "All checks were successful";
  process.stdout.write(`${head}\n0 cancelled, ${failed} failing, ${passed} successful, 0 skipped, and ${pending} pending checks\n\n`
    + list.map(check => `${check.state === "SUCCESS" ? "✓" : check.state === "PENDING" ? "*" : "X"}\t${check.name}\t${check.state === "PENDING" ? "pending" : check.state === "SUCCESS" ? "pass" : "fail"}\t${check.link}`).join("\n") + "\n");
  process.exit(failed ? 1 : pending ? 8 : 0);
}

async function main() {
  if (group === "repo" && command === "view") {
    if (option("--json")) return json({ name, nameWithOwner: repository.slug, url: `${HOST}/${repository.slug}`, defaultBranchRef: { name: "main" } });
    return void process.stdout.write(`name:\t${repository.slug}\ndescription:\tA fixture repository of Pikibun's eval\n`);
  }
  if (group === "pr") {
    if (command === "create" || command === "new") {
      const base = option("-B", "--base") ?? "main";
      const head = String(option("-H", "--head") ?? git(process.cwd(), ["rev-parse", "--abbrev-ref", "HEAD"])).replace(/^[^:]+:/, "");
      if (!head || head === "HEAD") fail("could not determine the current branch: name the pull request's branch with --head");
      if (head === base) fail(`pull request create failed: head branch "${head}" is the same as base branch "${base}", cannot create a pull request`);
      if (!remoteRef(head)) fail(`aborted: you must first push the current branch to a remote, or use the --head flag (no branch "${head}" on ${repository.slug})`);
      const existing = state.pulls.find(pull => pull.head === head && pull.state === "OPEN");
      if (existing) fail(`a pull request for branch "${head}" into branch "${base}" already exists:\n${url(existing)}`);
      const file = option("-F", "--body-file");
      const body = typeof file === "string" ? readFileSync(file, "utf8") : String(option("-b", "--body") ?? "");
      const title = String(option("-t", "--title") ?? git(repository.remote, ["log", "-1", "--format=%s", `refs/heads/${head}`]));
      const pull = { number: Math.max(0, ...state.pulls.map(item => item.number)) + 1, title, body, head, base, draft: flag("-d", "--draft"), state: "OPEN" };
      state.pulls.push(pull);
      save();
      return void process.stdout.write(`${url(pull)}\n`);
    }
    if (command === "list") {
      const wanted = String(option("-s", "--state") ?? "open").toUpperCase();
      const head = option("-H", "--head");
      const list = state.pulls.filter(pull => (wanted === "ALL" || pull.state === wanted) && (!head || pull.head === head));
      if (option("--json")) return json(list.map(fields));
      if (!list.length) return void process.stdout.write(`no ${wanted.toLowerCase()} pull requests in ${repository.slug}\n`);
      return void process.stdout.write(list.map(pull => `${pull.number}\t${pull.title}\t${pull.head}\t${pull.draft ? "DRAFT" : pull.state}`).join("\n") + "\n");
    }
    if (command === "status") {
      const open = state.pulls.filter(pull => pull.state === "OPEN");
      return void process.stdout.write(`Relevant pull requests in ${repository.slug}\n\n`
        + (open.map(pull => `  #${pull.number}  ${pull.title} [${pull.head}]${pull.draft ? " (draft)" : ""}`).join("\n") || "  There are no open pull requests") + "\n");
    }
    const pull = selected(rest[0]);
    if (command === "view") return option("--json") ? json(fields(pull)) : void process.stdout.write(describe(pull));
    if (command === "checks") return checks(pull);
    if (command === "ready") {
      if (pull.state !== "OPEN") fail(`Pull request #${pull.number} is closed`);
      pull.draft = flag("--undo");
      save();
      return void process.stdout.write(pull.draft ? `✓ Pull request #${pull.number} is converted to "draft"\n` : `✓ Pull request #${pull.number} is marked as "ready for review"\n`);
    }
    if (command === "edit") {
      if (option("-t", "--title") !== undefined) pull.title = String(option("-t", "--title"));
      const file = option("-F", "--body-file");
      if (typeof file === "string") pull.body = readFileSync(file, "utf8");
      else if (option("-b", "--body") !== undefined) pull.body = String(option("-b", "--body"));
      save();
      return void process.stdout.write(`${url(pull)}\n`);
    }
    if (command === "comment" || command === "review") {
      const file = option("-F", "--body-file");
      const body = typeof file === "string" ? readFileSync(file, "utf8") : String(option("-b", "--body") ?? "");
      (pull.comments ??= []).push({ author: { login: "eval-owner" }, body });
      save();
      return void process.stdout.write(`${url(pull)}#issuecomment-${pull.comments.length}\n`);
    }
    if (command === "diff") return void process.stdout.write(`${git(repository.remote, ["diff", `refs/heads/${pull.base}...refs/heads/${pull.head}`])}\n`);
    if (command === "close") {
      pull.state = "CLOSED";
      save();
      return void process.stdout.write(`✓ Closed pull request #${pull.number}\n`);
    }
    if (command === "merge") {
      if (pull.state === "MERGED") return void process.stdout.write(`! Pull request #${pull.number} was already merged\n`);
      if (pull.state !== "OPEN") fail(`Pull request #${pull.number} is closed`);
      if (pull.draft) fail(`X Pull request #${pull.number} is still a draft: mark it ready for review first (gh pr ready ${pull.number})`);
      const expected = option("--match-head-commit");
      const head = remoteRef(pull.head);
      if (typeof expected === "string" && expected !== head) fail(`X Pull request #${pull.number}: head commit ${head} does not match ${expected}`);
      if (flag("--auto")) {
        pull.autoMerge = true;
        save();
        return void process.stdout.write(`✓ Pull request #${pull.number} will be automatically merged when all requirements are met\n`);
      }
      if (pull.draft === false && flag("-d", "--delete-branch")) pull.branchDeleted = true;
      const method = flag("--squash", "-s") ? "Squashed and merged" : flag("--rebase", "-r") ? "Rebased and merged" : "Merged";
      pull.mergedOver = decision(pull);
      pull.method = flag("--squash", "-s") ? "squash" : flag("--rebase", "-r") ? "rebase" : "merge";
      pull.state = "MERGED";
      pull.mergedAt = new Date().toISOString();
      git(repository.remote, ["update-ref", `refs/heads/${pull.base}`, head]);
      save();
      return void process.stdout.write(`✓ ${method} pull request #${pull.number} (${pull.title})\n`);
    }
  }
  if (group === "run") {
    const runs = state.pulls.map(pull => ({ id: 9000 + pull.number, pull }));
    if (command === "list") {
      const list = runs.map(run => { const [check] = checksOf(run.pull); return { databaseId: run.id, name: "CI", headBranch: run.pull.head, status: check.state === "PENDING" ? "in_progress" : "completed",
        conclusion: check.state === "PENDING" ? "" : check.state.toLowerCase(), workflowName: "CI", event: "pull_request" }; });
      save();
      if (option("--json")) return json(list);
      return void process.stdout.write(list.map(run => `${run.status}\t${run.conclusion}\t${run.name}\t${run.headBranch}\t${run.databaseId}`).join("\n") + "\n");
    }
    const run = runs.find(item => String(item.id) === rest[0]) ?? (runs.length === 1 ? runs[0] : undefined);
    if (!run) fail(`could not find a run${rest[0] ? ` with the ID ${rest[0]}` : ": name its ID"}`);
    if (command === "watch") { options.set("--watch", true); return checks(run.pull); }
    if (command === "view") return checks(run.pull);
  }
  fail(`gh: the eval's forge serves pr (create, view, list, status, checks, ready, edit, comment, review, diff, merge, close), run (list, watch, view), repo view and auth status; `
    + `not "${words.slice(0, 2).join(" ")}"`);
}

await main();
