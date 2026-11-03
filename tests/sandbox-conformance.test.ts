import assert from "node:assert/strict";
import { link, mkdir, readdir, readFile, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import type { SessionWorkspace } from "../apps/runner/src/workspace.js";
import { workspaceKinds } from "./helpers/workspaces.js";

/*
 * One set of rules for a session's files, held against every implementation of them (tests/helpers/workspaces.ts): the
 * Linux sandbox's and macOS sandbox's Python helper, the Windows sandbox's Node helper, and the unsandboxed host's
 * TypeScript. A new file operation, or a fix to one, adds its cases here, so each implementation is checked by the same
 * table rather than reviewed three times. A kind that can't run on this machine is skipped with its reason.
 *
 * Each worktree starts with:
 *   inside/a.txt                a file
 *   in-dir -> inside, in-file -> inside/a.txt, nested/in-file -> ../inside/a.txt
 *   out-dir -> ../outside, out-file -> ../outside/secret.txt, up -> .., dangling -> ../outside/new.txt (missing)
 * Links are relative, as a repository's are: the Linux sandbox mounts the worktree at another path than the host's.
 *   git-link -> .git, loop -> loop
 *   hard.txt                    a hard link to ../outside/secret.txt
 * beside an `outside` directory holding secret.txt, which nothing may read, change or add to.
 */

const allow = async () => {};

type Operation = (workspace: SessionWorkspace) => Promise<unknown>;
/** A case: what it does, and what it gives (`ok`, or a refusal whose message matches). */
type Case = [name: string, operation: Operation, expected: { ok: unknown } | { refused: RegExp }];

const read = (path: string): Operation => workspace => workspace.readFile(path, allow);
const write = (path: string, content = "written"): Operation => workspace => workspace.writeFile(path, content, allow);
const list = (path: string): Operation => async workspace => (await workspace.listFiles(path, allow)).filter(name => name !== "n");
const browse = (path: string): Operation => workspace => workspace.browse(path, allow);
const content = (path: string): Operation => workspace => workspace.readContent(path, allow);
const upload = (directory: string, name: string, data = "uploaded"): Operation => workspace => workspace.importFile(directory, name, Buffer.from(data), allow);

const TRAVERSAL = /path traversal is not allowed/;
const ABSOLUTE = /invalid relative path/;
const GIT = /Git metadata is protected/;
const ESCAPES = /path escapes the worktree/;
const NOT_REGULAR = /only regular, non-hardlinked files are supported/;
/** Refused, for a reason each implementation words its own way (its platform's error, say). */
const REFUSED = /./;

const cases: Case[] = [
  // Paths are plain relative paths in the worktree: nothing that climbs out, no absolute paths, nothing empty.
  ["writes a file, making its directories", write("new/deeper/file.txt"), { ok: undefined }],
  ["reads it back", read("new/deeper/file.txt"), { ok: "written" }],
  ["refuses ./ in a path", read("./inside/a.txt"), { refused: TRAVERSAL }],
  ["refuses an empty component", read("inside//a.txt"), { refused: TRAVERSAL }],
  ["refuses .. even where it would stay inside", read("inside/../inside/a.txt"), { refused: TRAVERSAL }],
  ["refuses reading above the worktree", read("../outside/secret.txt"), { refused: TRAVERSAL }],
  ["refuses writing above the worktree", write("../outside/new.txt"), { refused: TRAVERSAL }],
  ["refuses listing above the worktree", list(".."), { refused: TRAVERSAL }],
  ["refuses browsing above the worktree", browse(".."), { refused: TRAVERSAL }],
  ["refuses an absolute path to read", read("/etc/hostname"), { refused: ABSOLUTE }],
  ["refuses an absolute path to write", write("/tmp/pikibun-conformance-escape.txt"), { refused: ABSOLUTE }],
  ["refuses an empty path", read(""), { refused: /Invalid path/ }],
  ["refuses a NUL in a path", read("a\0b"), { refused: /Invalid path/ }],

  // Git's metadata is the session's own, never the agent's to write, in any spelling or through any link.
  ["protects .git/config", write(".git/config"), { refused: GIT }],
  ["protects .git itself", write(".git"), { refused: GIT }],
  ["protects .git in another case", write(".GIT/x"), { refused: GIT }],
  ["protects a nested repository's .git", write("inside/.git/config"), { refused: GIT }],
  ["protects .git through a link to it", write("git-link/config"), { refused: REFUSED }],

  // Symlinks are followed only while they stay in the worktree.
  ["reads through a link to a file inside", read("in-file"), { ok: "A" }],
  ["reads through a link climbing back into the worktree", read("nested/in-file"), { ok: "A" }],
  ["reads through a link to a directory inside", read("in-dir/a.txt"), { ok: "A" }],
  ["lists through a link to a directory inside", list("in-dir"), { ok: ["a.txt"] }],
  ["refuses reading through a link to a file outside", read("out-file"), { refused: ESCAPES }],
  ["refuses reading through a link to a directory outside", read("out-dir/secret.txt"), { refused: ESCAPES }],
  ["refuses reading through a link to the worktree's parent", read("up/outside/secret.txt"), { refused: ESCAPES }],
  ["refuses an image read through a link outside", content("out-file"), { refused: ESCAPES }],
  ["refuses listing through a link outside", list("out-dir"), { refused: ESCAPES }],
  ["refuses browsing through a link to a directory outside", browse("out-dir"), { refused: ESCAPES }],
  ["refuses browsing through a link to a file outside", browse("out-file"), { refused: ESCAPES }],
  ["refuses writing through a link to a file outside", write("out-file"), { refused: ESCAPES }],
  ["refuses writing into a link to a directory outside", write("out-dir/new.txt"), { refused: ESCAPES }],
  ["refuses writing through a dangling link to outside", write("dangling"), { refused: REFUSED }],
  ["refuses a link to itself", read("loop"), { refused: REFUSED }],

  // Only regular files, never one hard-linked from elsewhere.
  ["refuses reading a hard link", read("hard.txt"), { refused: NOT_REGULAR }],
  ["refuses writing a hard link", write("hard.txt"), { refused: NOT_REGULAR }],
  ["refuses reading a directory as a file", read("inside"), { refused: NOT_REGULAR }],
  ["refuses writing over a directory", write("inside"), { refused: NOT_REGULAR }],
  ["refuses a missing file", read("missing.txt"), { refused: REFUSED }],

  // Attached files go only into a real directory of the worktree, as a new file: never over another one.
  ["imports into a directory", upload("inside", "report.pdf", "first"), { ok: "inside/report.pdf" }],
  ["imports a second file of that name beside it, leaving the first", upload("inside", "report.pdf", "second"), { ok: "inside/report (2).pdf" }],
  ["kept the first import as it was", read("inside/report.pdf"), { ok: "first" }],
  ["refuses importing into a link to a directory inside", upload("in-dir", "x.txt"), { refused: /path component is not a real directory/ }],
  ["refuses importing into a link to a directory outside", upload("out-dir", "x.txt"), { refused: ESCAPES }],
  ["refuses importing above the worktree", upload("..", "x.txt"), { refused: /Invalid file import/ }],
  ["refuses importing into .git", upload(".git", "x.txt"), { refused: /Invalid file import/ }],
  ["refuses importing into a missing directory", upload("missing/deeper", "x.txt"), { refused: /Invalid file import/ }],
  ["refuses an import named with ..", upload("inside", "../x.txt"), { refused: /Invalid file import/ }],
  ["refuses an import named with a path", upload("inside", "a/b.txt"), { refused: /Invalid file import/ }],
  ["refuses an import named .git", upload(".", ".git"), { refused: /Invalid file import/ }],

  // Writing through a link inside the worktree changes its target, which is in the worktree too.
  ["writes through a link to a directory inside", write("in-dir/through.txt", "through"), { ok: undefined }],
  ["wrote into the directory the link names", read("inside/through.txt"), { ok: "through" }],
];

for (const kind of workspaceKinds) {
  test(`${kind.name}: a session's files follow the same rules`, { skip: kind.missing }, async t => {
    const workspace = await kind.open(t);
    const root = workspace.worktree;
    const outside = join(root, "..", "outside");
    await mkdir(outside, { recursive: true });
    await writeFile(join(outside, "secret.txt"), "secret");
    await mkdir(join(root, "inside"));
    await writeFile(join(root, "inside", "a.txt"), "A");
    await mkdir(join(root, "nested"));
    await symlink("inside", join(root, "in-dir"));
    await symlink("inside/a.txt", join(root, "in-file"));
    await symlink("../inside/a.txt", join(root, "nested", "in-file"));
    await symlink("../outside", join(root, "out-dir"));
    await symlink("../outside/secret.txt", join(root, "out-file"));
    await symlink("..", join(root, "up"));
    await symlink("../outside/new.txt", join(root, "dangling"));
    await symlink(".git", join(root, "git-link"));
    await symlink("loop", join(root, "loop"));
    await link(join(outside, "secret.txt"), join(root, "hard.txt"));
    const git = await readdir(join(root, ".git")).catch(() => readFile(join(root, ".git"), "utf8"));

    for (const [name, operation, expected] of cases) {
      let outcome: { ok: unknown } | { error: string };
      try { outcome = { ok: await operation(workspace) }; }
      catch (error) { outcome = { error: error instanceof Error ? error.message : String(error) }; }
      if ("ok" in expected) assert.deepEqual(outcome, { ok: expected.ok }, name);
      else {
        assert.ok("error" in outcome, `${name}: refused, not ${JSON.stringify(outcome).slice(0, 200)}`);
        assert.match(outcome.error, expected.refused, name);
      }
    }

    // Nothing outside the worktree, nor its Git metadata, changed.
    assert.deepEqual(await readdir(outside), ["secret.txt"]);
    assert.equal(await readFile(join(outside, "secret.txt"), "utf8"), "secret");
    assert.deepEqual(await readdir(join(root, ".git")).catch(() => readFile(join(root, ".git"), "utf8")), git);
  });
}
