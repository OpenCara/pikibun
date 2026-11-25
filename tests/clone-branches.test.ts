import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { headBranch, originUrl, readCloneBranches, reportedBranches } from "../apps/runner/src/clone-branches.js";
import type { EgressRepository } from "../packages/shared/src/network.js";

async function clone(root: string, path: string, options: { branch?: string; detached?: boolean; url?: string; remoteHead?: string | null }): Promise<void> {
  const git = join(root, path, ".git");
  await mkdir(join(git, "refs", "remotes", "origin"), { recursive: true });
  await writeFile(join(git, "HEAD"), options.detached ? `${"a".repeat(40)}\n` : `ref: refs/heads/${options.branch ?? "main"}\n`);
  await writeFile(join(git, "config"), options.url === undefined ? "[core]\n\tbare = false\n"
    : `[core]\n\tbare = false\n[remote "upstream"]\n\turl = https://github.com/elsewhere/repo.git\n[remote "origin"]\n\turl = ${options.url}\n\tfetch = +refs/heads/*:refs/remotes/origin/*\n[branch "main"]\n\tremote = origin\n`);
  if (options.remoteHead !== null) await writeFile(join(git, "refs", "remotes", "origin", "HEAD"), `ref: refs/remotes/origin/${options.remoteHead ?? "main"}\n`);
}

test("a clone's branch, origin and default branch are read from its Git files", () => {
  assert.equal(headBranch("ref: refs/heads/feature/x\n"), "feature/x");
  assert.equal(headBranch(`${"a".repeat(40)}\n`), undefined, "detached");
  assert.equal(headBranch("ref: refs/heads/-option\n"), undefined);
  assert.equal(headBranch("ref: refs/remotes/origin/main\n", "refs/remotes/origin/"), "main");
  assert.equal(originUrl('[remote "origin"]\n\turl = git@github.com:owner/repo.git\n\turl = https://second.example/repo\n'), "git@github.com:owner/repo.git");
  assert.equal(originUrl('[remote "upstream"]\n\turl = https://github.com/a/b\n'), undefined);
  assert.equal(originUrl('[Remote "origin"] \n  URL = "https://github.com/owner/repo"\n'), "https://github.com/owner/repo");
  assert.equal(originUrl('[remote "origin"]\n\turl = C:\\\\Users\\\\me\\\\upstream\n'), "C:\\Users\\me\\upstream");
  assert.equal(originUrl('[remote "origin"]\n\turl = "https://x.example/a b" ; a comment\n'), "https://x.example/a b");
  assert.equal(originUrl('[remote "origin"]\n\turl = git@github.com:owner/repo.git # a comment\n'), "git@github.com:owner/repo.git");
});

test("the worktree's clones report their checked-out branches of the workspace's github.com and Azure DevOps repositories", async t => {
  const root = await mkdtemp(join(tmpdir(), "clone-branches-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, ".git"), { recursive: true });
  await writeFile(join(root, ".git", "HEAD"), "ref: refs/heads/session\n");
  await clone(root, "app", { branch: "fix/login", url: "https://github.com/Owner/Repo.git" });
  await clone(root, "src/tools", { branch: "feature", url: "git@github.com:owner/tools.git" });
  await clone(root, "work/a/b/c/deep", { branch: "too-deep", url: "https://github.com/owner/repo" });
  await clone(root, "on-main", { branch: "main", url: "https://github.com/owner/repo" });
  await clone(root, "develop-default", { branch: "main", url: "https://github.com/owner/repo", remoteHead: "develop" });
  await clone(root, "no-remote-head", { branch: "master", url: "https://github.com/owner/repo", remoteHead: null });
  await clone(root, "detached", { detached: true, url: "https://github.com/owner/repo" });
  await clone(root, "no-origin", { branch: "feature" });
  await clone(root, "node_modules/dependency", { branch: "feature", url: "https://github.com/owner/repo" });
  await clone(root, "elsewhere", { branch: "x", url: "https://gitlab.com/owner/repo.git" });
  await clone(root, "app/nested", { branch: "inner", url: "https://github.com/owner/repo" });
  await mkdir(join(root, "linked-worktree"), { recursive: true });
  await writeFile(join(root, "linked-worktree", ".git"), "gitdir: /elsewhere/.git/worktrees/linked\n");
  await clone(root, "linked-worktree/inner", { branch: "inner", url: "https://github.com/owner/repo" });
  await clone(join(root, ".."), `${root.split("/").at(-1)}-outside`, { branch: "outside", url: "https://github.com/owner/repo" });
  t.after(() => rm(`${root}-outside`, { recursive: true, force: true }));
  await symlink(`${root}-outside`, join(root, "linked"));

  const clones = await readCloneBranches(root);
  assert.deepEqual(clones, [
    { directory: "app", origin: "https://github.com/Owner/Repo.git", branch: "fix/login" },
    { directory: "detached", origin: "https://github.com/owner/repo" },
    { directory: "develop-default", origin: "https://github.com/owner/repo", branch: "main" },
    { directory: "elsewhere", origin: "https://gitlab.com/owner/repo.git", branch: "x" },
    { directory: "no-remote-head", origin: "https://github.com/owner/repo" },
    { directory: "on-main", origin: "https://github.com/owner/repo" },
    { directory: "src/tools", origin: "git@github.com:owner/tools.git", branch: "feature" },
  ], "a clone on its default branch or detached has no branch of its own, but counts");
  const repositories: EgressRepository[] = [
    { bindingId: "binding-1", provider: "github", host: "github.com", fullName: "owner/repo" },
    { bindingId: "binding-2", provider: "github", host: "github.com", fullName: "owner/tools" },
    { bindingId: "binding-3", provider: "gitlab", host: "gitlab.com", fullName: "owner/repo" },
  ];
  assert.deepEqual(reportedBranches(clones, repositories), [
    { repository: "owner/repo", branch: "fix/login" },
    { repository: "owner/repo", branch: "main" },
    { repository: "owner/tools", branch: "feature" },
  ], "only github.com repositories of the workspace, by the workspace's name, sorted");
  assert.deepEqual(reportedBranches(clones, []), []);
  assert.deepEqual(reportedBranches(clones, repositories, "pikibun/fix-abc"), [
    { repository: "owner/repo", branch: "fix/login" },
    { repository: "owner/repo", branch: "main" },
    { repository: "owner/repo", branch: "pikibun/fix-abc" },
    { repository: "owner/tools", branch: "feature" },
    { repository: "owner/tools", branch: "pikibun/fix-abc" },
  ], "the session's branch, for each workspace repository cloned");
  assert.deepEqual(reportedBranches([{ directory: "app", origin: "https://github.com/owner/repo" }], repositories, "pikibun/fix-abc"),
    [{ repository: "owner/repo", branch: "pikibun/fix-abc" }], "a clone on main that pushed HEAD to the session's branch");
  assert.deepEqual(reportedBranches([{ directory: "app", origin: "https://github.com/owner/repo", branch: "pikibun/fix-abc" }], repositories, "pikibun/fix-abc"),
    [{ repository: "owner/repo", branch: "pikibun/fix-abc" }], "once");
  const azure: EgressRepository[] = [...repositories, { bindingId: "binding-4", provider: "azure-devops", host: "dev.azure.com", fullName: "contoso/My Project/app" }];
  assert.deepEqual(reportedBranches([
    { directory: "azure", origin: "https://contoso@dev.azure.com/contoso/My%20Project/_git/app", branch: "feature" },
    { directory: "gitlab", origin: "https://gitlab.com/owner/repo.git", branch: "x" },
  ], azure, "pikibun/fix-abc"), [
    { repository: "contoso/My Project/app", branch: "feature" },
    { repository: "contoso/My Project/app", branch: "pikibun/fix-abc" },
  ], "Azure DevOps repositories too, whose pull requests Pikibun also finds");
  const crowded = await mkdtemp(join(tmpdir(), "clone-branches-many-"));
  t.after(() => rm(crowded, { recursive: true, force: true }));
  for (let index = 0; index < 25; index++) await clone(crowded, `c${String(index).padStart(2, "0")}`, { url: "https://github.com/owner/other" });
  await clone(crowded, "z", { url: "https://github.com/owner/repo" });
  assert.deepEqual(reportedBranches(await readCloneBranches(crowded), repositories, "pikibun/fix-abc"), [{ repository: "owner/repo", branch: "pikibun/fix-abc" }],
    "clones on their default branch don't use up the branches reported");
  const many = Array.from({ length: 25 }, (_, index) => ({ directory: `c${index}`, origin: "https://github.com/owner/repo", branch: `b${String(index).padStart(2, "0")}` }));
  const kept = reportedBranches(many, repositories, "pikibun/fix-abc");
  assert.equal(kept.length, 20);
  assert.ok(kept.some(item => item.branch === "pikibun/fix-abc"), "the session's branch is kept within the limit");
});

test("a clone reports the branches it pushed to, from its remote-tracking reflogs, even once it left them", async t => {
  const root = await mkdtemp(join(tmpdir(), "clone-branches-pushed-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await clone(root, "app", { branch: "main", url: "https://github.com/owner/repo" });
  const logs = join(root, "app", ".git", "logs", "refs", "remotes", "origin");
  const line = (message: string) => `${"0".repeat(40)} ${"a".repeat(40)} Someone <s@example.com> 1700000000 +0000\t${message}\n`;
  await mkdir(join(logs, "fix"), { recursive: true });
  await writeFile(join(logs, "host-session-directory"), line("update by push"));
  await writeFile(join(logs, "fix", "login"), line("fetch: storing head") + line("update by push"));
  await writeFile(join(logs, "fetched-only"), line("fetch: storing head"));
  await writeFile(join(logs, "main"), line("update by push"));
  await writeFile(join(logs, "HEAD"), line("update by push"));
  assert.deepEqual(await readCloneBranches(root), [
    { directory: "app", origin: "https://github.com/owner/repo", pushed: ["fix/login", "host-session-directory"] },
  ], "pushed branches, not fetched ones, the default branch or HEAD");
  const repositories: EgressRepository[] = [{ bindingId: "binding-1", provider: "github", host: "github.com", fullName: "owner/repo" }];
  assert.deepEqual(reportedBranches(await readCloneBranches(root), repositories, "pikibun/fix-abc"), [
    { repository: "owner/repo", branch: "fix/login" },
    { repository: "owner/repo", branch: "host-session-directory" },
    { repository: "owner/repo", branch: "pikibun/fix-abc" },
  ]);
  const many = [{ directory: "app", origin: "https://github.com/owner/repo", branch: "checked-out",
    pushed: Array.from({ length: 25 }, (_, index) => `p${String(index).padStart(2, "0")}`) }];
  const kept = reportedBranches(many, repositories, "pikibun/fix-abc");
  assert.equal(kept.length, 20);
  assert.ok(kept.some(item => item.branch === "pikibun/fix-abc") && kept.some(item => item.branch === "checked-out"),
    "the session's and the checked-out branch come before pushed ones");
});
