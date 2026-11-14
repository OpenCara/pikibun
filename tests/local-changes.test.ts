import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HostWorkspace } from "../apps/runner/src/host-workspace.js";
import { localChangesCommand, NotARepository, parseLocalChanges, parsePatchFiles, unquoteGitPath } from "../apps/runner/src/local-changes.js";
import { Sandbox, type SandboxAuthorize } from "../apps/runner/src/sandbox.js";
import {
  checkLocalChanges, InvalidLocalChanges, localChangesLimits, localChangesRequest, redactLocalChanges, validChangesDirectory, type LocalChanges, type LocalChangesRequest,
} from "../packages/shared/src/local-changes.js";
import type { RunnerBinding } from "../packages/shared/src/types.js";
import { linuxSandboxMissing } from "./helpers/workspaces.js";

const authorize: SandboxAuthorize = async () => {};
const sandboxed = !linuxSandboxMissing();
const hostMode = { skip: !["linux", "darwin"].includes(process.platform) || spawnSync("git", ["--version"]).status !== 0 };
const marker = "0123456789abcdef0123456789abcdef";

function binding(id: string): RunnerBinding {
  return {
    session: { id, workspaceId: "workspace", ownerId: "test:alice", agentVersionId: "version-1", title: "Changes", policyVersion: 1, status: "ready", createdAt: "2026-01-01T00:00:00Z", repositoryMode: "clone" },
    owner: { id: "test:alice", githubId: null, githubLogin: "alice", displayName: "Alice", gitName: "Alice Owner", gitEmail: "alice@example.test", env: {}, githubConnected: false },
    agent: { id: "version-1", agentId: "agent", authorId: "test:alice", workspaceId: "workspace", version: 1, name: "Agent", description: "", instructions: "Use tools.", tools: ["read_file"], modelId: "model-1", createdAt: "2026-01-01T00:00:00Z" },
    model: { id: "model-1", workspaceId: "workspace", name: "Model", provider: "openai", modelId: "local" },
  };
}

const setup = [
  "git init -q app && cd app && git symbolic-ref HEAD refs/heads/work && git config user.name Tester && git config user.email tester@example.test && git config commit.gpgsign false",
  "printf 'one\\ntwo\\n' > a.txt && printf 'x\\n' > gone.txt && printf 'r\\n1\\n2\\n3\\n' > old.txt && git add -A && git commit -q -m 'First commit'",
  "printf 'b\\n' > b.txt && git add b.txt && git commit -q -m 'Second\tcommit'",
  "printf 'one\\nTWO\\n' > a.txt && git rm -q gone.txt && git mv old.txt new.txt && printf 'fresh\\n' > untracked.txt && printf 'ignored\\n' > skip.log",
  "printf '*.log\\n' > .gitignore && git add .gitignore && mkdir 'dir with space' && printf 's\\n' > 'dir with space/f.txt' && printf 'q\\n' > 'quo\"te.txt'",
  "git update-ref refs/remotes/origin/work HEAD~1 && ln -s app ../linked",
  `head -c ${localChangesLimits.patchBytes + 10} /dev/zero | tr '\\0' 'x' > huge.txt && ln -s a.txt link`,
  "git config diff.external 'touch ../ran-external' && git config core.fsmonitor 'touch ../ran-fsmonitor' && printf 'a.txt diff=conv\\n' > .git/info/attributes && git config diff.conv.textconv 'touch ../ran-textconv; cat'",
].join(" && ");

type Run = (command: string, readOnly: boolean) => Promise<string>;

async function exercise(run: Run, outside?: string): Promise<void> {
  await run(setup, false);
  if (outside) await run(`git init -q '${outside}/repo' && ln -s '${outside}/repo' escape`, false);
  const read = async (request: LocalChangesRequest): Promise<LocalChanges> => checkLocalChanges(parseLocalChanges(await run(localChangesCommand(request, marker), true), marker, request));

  const first = await read({});
  assert.equal(first.directory, "app");
  assert.deepEqual(first.repositories.map(repository => repository.directory).filter(name => name !== "."), ["app"], "a link to a repository isn't listed as another");
  if (outside) await assert.rejects(read({ directory: "escape" }), NotARepository, "a link that leads out of the worktree isn't read");
  const app = first.repositories.find(repository => repository.directory === "app");
  assert.equal(app?.branch, "work");
  assert.match(app?.head ?? "", /^[0-9a-f]{40}$/);
  assert.equal(first.commit, null);
  assert.deepEqual(first.commits.map(commit => [commit.message, commit.author, commit.unpushed]), [["Second\tcommit", "Alice Owner", true], ["First commit", "Alice Owner", undefined]]);
  assert.ok(!Number.isNaN(Date.parse(first.commits[0]!.date)));
  assert.deepEqual(first.files.map(file => [file.path, file.status, file.additions, file.deletions, file.previousPath, file.truncated]), [
    [".gitignore", "added", 1, 0, undefined, undefined],
    ["a.txt", "modified", 1, 1, undefined, undefined],
    ["gone.txt", "removed", 0, 1, undefined, undefined],
    ["new.txt", "renamed", 0, 0, "old.txt", undefined],
    ["dir with space/f.txt", "added", 1, 0, undefined, undefined],
    ["huge.txt", "added", 0, 0, undefined, true],
    ["link", "added", 0, 0, undefined, undefined],
    ["quo\"te.txt", "added", 1, 0, undefined, undefined],
    ["untracked.txt", "added", 1, 0, undefined, undefined],
  ]);
  assert.equal(first.files[1]!.patch, "@@ -1,2 +1,2 @@\n one\n-two\n+TWO");
  assert.equal(first.files[4]!.patch, "@@ -0,0 +1 @@\n+s");
  assert.equal(first.files[3]!.patch, undefined);
  assert.deepEqual([first.additions, first.deletions], [5, 2]);
  assert.deepEqual(await read({ directory: "app" }), first);

  const second = await read({ directory: "app", commit: first.commits[0]!.sha });
  assert.equal(second.commit, first.commits[0]!.sha);
  assert.deepEqual(second.files, [{ path: "b.txt", status: "added", additions: 1, deletions: 0, patch: "@@ -0,0 +1 @@\n+b" }]);
  const root = await read({ directory: "app", commit: first.commits[1]!.sha });
  assert.deepEqual(root.files.map(file => [file.path, file.status]), [["a.txt", "added"], ["gone.txt", "added"], ["old.txt", "added"]]);

  await assert.rejects(read({ directory: "missing" }), NotARepository);
  await assert.rejects(read({ directory: "app/dir with space" }), NotARepository);
  const listing = await run("ls", true);
  assert.ok(!/ran-/.test(listing), `the repository's own programs must not run: ${listing}`);
}

async function directory(t: TestContext): Promise<string> {
  const path = await realpath(await mkdtemp(join(tmpdir(), "pikibun-changes-")));
  t.after(() => rm(path, { recursive: true, force: true }));
  return path;
}

test("a host's shell reads a clone's uncommitted changes, its commits and one commit's changes, without running the repository's programs", hostMode, async t => {
  const base = await directory(t);
  const workspace = new HostWorkspace(binding("changes-host"), join(base, "session"));
  t.after(() => workspace.close());
  await workspace.initialize();
  await exercise(command => workspace.execute({ kind: "program", tool: "git", command }, false, authorize), await directory(t));
});

test("the sandbox reads the same changes, with the worktree read-only", { skip: !sandboxed }, async t => {
  const base = await directory(t);
  const sandbox = new Sandbox(binding("changes-sandbox"), join(base, "session"));
  t.after(() => sandbox.close());
  await sandbox.initialize();
  await exercise((command, readOnly) => sandbox.execute({ kind: "program", tool: "git", command }, readOnly, authorize, { unbounded: true }));
});

test("a worktree without a repository answers with none, and a patch is cut where the output was", () => {
  const none = parseLocalChanges(`${marker}\n\n${marker}\n${marker}\n`, marker, {});
  assert.deepEqual(none, { repositories: [], directory: null, commit: null, files: [], commits: [], additions: 0, deletions: 0 });
  assert.throws(() => parseLocalChanges(`${marker}\n\n${marker}\n${marker}\n`, marker, { directory: "app" }), NotARepository);
  assert.throws(() => parseLocalChanges(`${marker}\napp\n${marker}\n${marker}\n`, marker, { directory: "app" }), NotARepository);
  const pushed = parseLocalChanges(`app\twork\t${"b".repeat(40)}\n${marker}\napp\n${marker}\n${marker}\n${marker}\ndiff --git a/a.txt b/a.txt\n--- a/a.txt\n+++ b/a.txt\n@@ -1 +1 @@\n-a\n+b\n${marker}\n`, marker, {});
  assert.deepEqual([pushed.commits, pushed.files.map(file => file.path), pushed.truncated], [[], ["a.txt"], undefined], "empty sections stay sections");
  const cutShort = parseLocalChanges(`app\twork\t\n${marker}\napp\n${marker}\n${marker}\n${marker}\ndiff --git a/a.txt b/a.txt\n--- a/a.txt\n+++ b/a.txt\n@@ -1 +1 @@\n-a\n+\xe9`, marker, {});
  assert.deepEqual([cutShort.truncated, cutShort.files], [true, [{ path: "a.txt", status: "modified", additions: 1, deletions: 1, truncated: true }]], "output without its last line was cut");
  assert.equal(unquoteGitPath('"b/caf\\303\\251 \\"x\\"\\ty"'), 'b/café "x"\ty');
  assert.deepEqual(parsePatchFiles('diff --git "a/x\\ty" "b/x\\ty"\n--- "a/x\\ty"\n+++ "b/x\\ty"\n@@ -1 +1 @@\n-a\n+b\ndiff --git "a/o\\"ld" b/new\nrename from "o\\"ld"\nrename to new').files.map(file => [file.path, file.previousPath]),
    [["x\ty", undefined], ["new", 'o"ld']]);
  assert.throws(() => parseLocalChanges(`app\twork\t\n${marker}\nother\n${marker}\n\n${marker}\n\n${marker}\n`, marker, { directory: "app" }), NotARepository);
  const sha = "b".repeat(40);
  const listed = (rows: string, selected: string) => parseLocalChanges(`${rows}${marker}\n${selected}\n${marker}\n${marker}\n${marker}\n${marker}\n`, marker, {}).repositories.map(item => item.directory);
  assert.deepEqual(listed(`app\twork\t${sha}\n.\tmain\t\n`, "app"), ["app"], "the worktree's own empty repository is left out beside a clone");
  assert.deepEqual(listed(`app\twork\t${sha}\n.\tmain\t${sha}\n`, "app"), ["app", "."]);
  assert.deepEqual(listed(".\tmain\t\n", "."), ["."]);
  const two = "diff --git a/a.txt b/a.txt\n--- a/a.txt\n+++ b/a.txt\n@@ -1 +1 @@\n-a\n+b\ndiff --git a/b.txt b/b.txt\n--- a/b.txt\n+++ b/b.txt\n@@ -1 +1 @@\n-c\n+d";
  assert.deepEqual(parsePatchFiles(two).files.map(file => file.patch), ["@@ -1 +1 @@\n-a\n+b", "@@ -1 +1 @@\n-c\n+d"]);
  assert.deepEqual(parsePatchFiles(two, false).files.map(file => [file.patch, file.truncated]), [["@@ -1 +1 @@\n-a\n+b", undefined], [undefined, true]]);
  const forged = parsePatchFiles("diff --git a/a.txt b/a.txt\n--- a/a.txt\n+++ b/a.txt\n@@ -1,2 +1,3 @@\n a\n+diff --git a/x b/x\n+pikibun-too-large\n-b");
  assert.deepEqual(forged.files, [{ path: "a.txt", status: "modified", additions: 2, deletions: 1, patch: "@@ -1,2 +1,3 @@\n a\n+diff --git a/x b/x\n+pikibun-too-large\n-b" }]);
  const many = Array.from({ length: localChangesLimits.files + 2 }, (_, index) => `diff --git a/f${index} b/f${index}\nnew file mode 100644\n--- /dev/null\n+++ b/f${index}\n@@ -0,0 +1 @@\n+x`).join("\n");
  const cut = parsePatchFiles(many);
  assert.deepEqual([cut.files.length, cut.omitted, cut.additions], [localChangesLimits.files, 2, localChangesLimits.files + 2]);
});

test("requests and a host's answer are checked, and the answer's secrets are hidden", () => {
  for (const directory of [".", "app", "packages/app", "dir with space"]) assert.ok(validChangesDirectory(directory), directory);
  for (const directory of ["", "/etc", "../x", "a/../b", "a//b", "a/.git", "a\nb", "a\\b", 5]) assert.ok(!validChangesDirectory(directory), String(directory));
  assert.deepEqual(localChangesRequest({ directory: "app", commit: "a".repeat(40) }), { directory: "app", commit: "a".repeat(40) });
  for (const input of [{ commit: "a".repeat(40) }, { directory: "app", commit: "HEAD" }, { directory: "app", extra: 1 }, null, "app"]) assert.throws(() => localChangesRequest(input));
  const sha = "a".repeat(40);
  const answer: LocalChanges = { repositories: [{ directory: "app", branch: "work", head: sha }], directory: "app", commit: null, additions: 1, deletions: 0,
    files: [{ path: ".env", status: "added", additions: 1, deletions: 0, patch: "@@ -0,0 +1 @@\n+API_KEY=sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGHIJ" }],
    commits: [{ sha, message: "Add API_KEY=sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGHIJ", author: "Tester", date: "2026-01-01T00:00:00Z", unpushed: true }] };
  assert.deepEqual(checkLocalChanges({ ...answer, extra: 1 }), answer);
  const rejects = (value: unknown, why: string) => assert.throws(() => checkLocalChanges(value), InvalidLocalChanges, why);
  rejects({ ...answer, directory: "../app" }, "a directory outside the worktree");
  rejects({ ...answer, files: [{ ...answer.files[0], patch: "diff --git a/x b/x" }] }, "a patch that isn't hunks");
  rejects({ ...answer, files: [{ ...answer.files[0], patch: `@@ -0,0 +1 @@\n+${"x".repeat(localChangesLimits.patchBytes)}` }] }, "a patch over the limit");
  rejects({ ...answer, files: [{ ...answer.files[0], status: "changed" }] }, "an unknown status");
  rejects({ ...answer, commits: [{ ...answer.commits[0], sha: "HEAD" }] }, "a commit that isn't a hash");
  rejects({ ...answer, files: Array.from({ length: localChangesLimits.files + 1 }, () => answer.files[0]) }, "too many files");
  const shown = redactLocalChanges(answer);
  assert.ok(!JSON.stringify(shown).includes("abcdefghijklmnopqrstuvwxyz"));
  assert.equal(shown.files[0]!.redacted, true);
});
