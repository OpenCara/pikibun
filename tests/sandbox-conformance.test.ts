import assert from "node:assert/strict";
import { link, mkdir, readdir, readFile, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import type { SessionWorkspace } from "../apps/runner/src/workspace.js";
import { findRequest, searchRequest } from "../apps/runner/src/search.js";
import { fileOperationRequest } from "../apps/runner/src/file-operations.js";
import { workspaceKinds } from "./helpers/workspaces.js";

const allow = async () => {};

type Operation = (workspace: SessionWorkspace) => Promise<unknown>;
type Case = [name: string, operation: Operation, expected: { ok: unknown } | { refused: RegExp }];

const read = (path: string): Operation => workspace => workspace.readFile(path, allow);
const write = (path: string, content = "written"): Operation => workspace => workspace.writeFile(path, content, allow);
const list = (path: string): Operation => async workspace => (await workspace.listFiles(path, allow)).filter(name => name !== "n");
const browse = (path: string): Operation => workspace => workspace.browse(path, allow);
const content = (path: string): Operation => workspace => workspace.readContent(path, allow);
const upload = (directory: string, name: string, data = "uploaded"): Operation => workspace => workspace.importFile(directory, name, Buffer.from(data), allow);
const find = (args: Parameters<typeof searchRequest>[0]): Operation => workspace => workspace.search(searchRequest(args), allow);
const move = (from: string, to: string): Operation => workspace => workspace.fileOperation(fileOperationRequest("move", { from, to }), allow);
const copy = (from: string, to: string): Operation => workspace => workspace.fileOperation(fileOperationRequest("copy", { from, to }), allow);
const remove = (path: string, recursive = false): Operation => workspace => workspace.fileOperation(fileOperationRequest("delete", { path, recursive }), allow);
const names = (path: string): Operation => async workspace => (await workspace.listFiles(path, allow)).filter(name => name !== "n");
const entries = (path: string, only?: readonly string[]): Operation => async workspace => (await workspace.listEntries(path, allow)).filter(name => !only || only.includes(name.replace(/\/$/, "")));
const located = (args: Parameters<typeof findRequest>[0]): Operation => workspace => workspace.find(findRequest(args), allow);
const found = (args: Parameters<typeof searchRequest>[0]): Operation => async workspace => (await workspace.search(searchRequest(args), allow)).matches;

const TRAVERSAL = /path traversal is not allowed/;
const ABSOLUTE = /invalid relative path/;
const GIT = /Git metadata is protected/;
const ESCAPES = /path escapes the worktree/;
const NOT_REGULAR = /only regular, non-hardlinked files are supported/;
const REFUSED = /./;

const cases: Case[] = [
  ["writes a file, making its directories", write("new/deeper/file.txt"), { ok: undefined }],
  ["reads it back", read("new/deeper/file.txt"), { ok: "written" }],
  ["writes a byte order mark", write("bom.txt", "\uFEFFmarked\r\n"), { ok: undefined }],
  ["reads the byte order mark back, for an edit to keep", read("bom.txt"), { ok: "\uFEFFmarked\r\n" }],
  ["reads the byte order mark back as the file's content", content("bom.txt"), { ok: { text: "\uFEFFmarked\r\n" } }],
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

  ["protects .git/config", write(".git/config"), { refused: GIT }],
  ["protects .git itself", write(".git"), { refused: GIT }],
  ["protects .git in another case", write(".GIT/x"), { refused: GIT }],
  ["protects a nested repository's .git", write("inside/.git/config"), { refused: GIT }],
  ["protects .git through a link to it", write("git-link/config"), { refused: REFUSED }],

  ["reads through a link to a file inside", read("in-file"), { ok: "A" }],
  ["reads through a link climbing back into the worktree", read("nested/in-file"), { ok: "A" }],
  ["reads through a link to a directory inside", read("in-dir/a.txt"), { ok: "A" }],
  ["lists through a link to a directory inside", list("in-dir"), { ok: ["a.txt"] }],
  ["lists entries with / after a directory, and a link as it is", entries(".", ["inside", "nested", "in-dir", "in-file", "dangling", "loop"]),
    { ok: ["dangling", "in-dir", "in-file", "inside/", "loop", "nested/"] }],
  ["lists entries through a link to a directory inside", entries("in-dir"), { ok: ["a.txt"] }],
  ["refuses listing entries through a link outside", entries("out-dir"), { refused: ESCAPES }],
  ["refuses listing entries above the worktree", entries(".."), { refused: TRAVERSAL }],
  ["refuses listing the entries of a file", entries("inside/a.txt"), { refused: REFUSED }],
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

  ["refuses reading a hard link", read("hard.txt"), { refused: NOT_REGULAR }],
  ["refuses writing a hard link", write("hard.txt"), { refused: NOT_REGULAR }],
  ["refuses reading a directory as a file", read("inside"), { refused: NOT_REGULAR }],
  ["refuses writing over a directory", write("inside"), { refused: NOT_REGULAR }],
  ["refuses a missing file", read("missing.txt"), { refused: REFUSED }],

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

  ["writes through a link to a directory inside", write("in-dir/through.txt", "through"), { ok: undefined }],
  ["wrote into the directory the link names", read("inside/through.txt"), { ok: "through" }],

  ["writes files to search", async workspace => {
    await workspace.writeFile("src/app.ts", "const a = 1;\nexport function hello() {\n  return \"hi\";\n}\n", allow);
    await workspace.writeFile("src/lib/util.ts", "export const HELLO = 2;\r\n", allow);
    await workspace.writeFile("node_modules/dep/index.js", "hello dep\n", allow);
    await workspace.writeFile("long.txt", `${"x".repeat(600)}needle\n`, allow);
    await workspace.writeFile("bin.dat", "needle\0", allow);
  }, { ok: undefined }],
  ["searches a directory", find({ pattern: "hello", path: "src" }), { ok: { matches: [{ path: "src/app.ts", line: 2, text: "export function hello() {" }], files: 2, truncated: false } }],
  ["searches ignoring case, by file name, without the line's CR", found({ pattern: "hello", ignoreCase: true, glob: "*.ts" }),
    { ok: [{ path: "src/app.ts", line: 2, text: "export function hello() {" }, { path: "src/lib/util.ts", line: 1, text: "export const HELLO = 2;" }] }],
  ["searches by path glob", found({ pattern: "HELLO", glob: "src/**/*.ts" }), { ok: [{ path: "src/lib/util.ts", line: 1, text: "export const HELLO = 2;" }] }],
  ["matches a path glob from the path searched, not the worktree's top", found({ pattern: "HELLO", path: "src", glob: "lib/*.ts" }),
    { ok: [{ path: "src/lib/util.ts", line: 1, text: "export const HELLO = 2;" }] }],
  ["finds nothing for a glob written from the worktree's top under a path", found({ pattern: "HELLO", path: "src", glob: "src/**/*.ts" }), { ok: [] }],
  ["searches literal text", found({ pattern: "hello()", literal: true, path: "src" }), { ok: [{ path: "src/app.ts", line: 2, text: "export function hello() {" }] }],
  ["searches one file, with context", find({ pattern: "return", path: "src/app.ts", context: 1 }),
    { ok: { matches: [{ path: "src/app.ts", line: 3, text: "  return \"hi\";", before: ["export function hello() {"], after: ["}"] }], files: 1, truncated: false } }],
  ["finds one match past its limit, which says the limit cut something off, then stops", find({ pattern: "e", path: "src", limit: 1 }),
    { ok: { matches: [{ path: "src/app.ts", line: 2, text: "export function hello() {" }, { path: "src/app.ts", line: 3, text: "  return \"hi\";" }], files: 1, truncated: true } }],
  ["goes on past its limit, to the next file, for that one more match", find({ pattern: "hello", ignoreCase: true, path: "src", limit: 1 }),
    { ok: { matches: [{ path: "src/app.ts", line: 2, text: "export function hello() {" }, { path: "src/lib/util.ts", line: 1, text: "export const HELLO = 2;" }], files: 2, truncated: false } }],
  ["reaches its limit with nothing more to find, and isn't cut off", find({ pattern: "hello", path: "src", limit: 1 }),
    { ok: { matches: [{ path: "src/app.ts", line: 2, text: "export function hello() {" }], files: 2, truncated: false } }],
  ["stops at its text budget, and says so", async workspace => {
    for (let index = 0; index < 10; index++) await workspace.writeFile(`wide/${index}.txt`, `${"\u{1F600}".repeat(300)}\n`.repeat(100), allow);
    const result = await workspace.search(searchRequest({ pattern: ".", path: "wide", limit: 500, context: 5 }), allow);
    return { matches: result.matches.length, truncated: result.truncated };
  }, { ok: { matches: 80, truncated: true } }],
  ["shortens a long line", found({ pattern: "needle", path: "long.txt" }), { ok: [{ path: "long.txt", line: 1, text: `${"x".repeat(500)}\u2026` }] }],
  ["skips node_modules", find({ pattern: "dep", glob: "*.js" }), { ok: { matches: [], files: 0, truncated: false } }],
  ["searches node_modules with all", found({ pattern: "dep", glob: "*.js", all: true }), { ok: [{ path: "node_modules/dep/index.js", line: 1, text: "hello dep" }] }],
  ["skips binary files", find({ pattern: "needle", glob: "bin.dat" }), { ok: { matches: [], files: 0, truncated: false } }],
  ["never finds what lies outside, through links or a hard link", found({ pattern: "secret" }), { ok: [] }],
  ["skips .git as it walks", found({ pattern: "HEAD|ref", path: "." }), { ok: [] }],
  ["refuses searching above the worktree", find({ pattern: "secret", path: "../outside" }), { refused: TRAVERSAL }],
  ["refuses searching through a link outside", find({ pattern: "secret", path: "out-dir" }), { refused: ESCAPES }],
  ["refuses an invalid regular expression", find({ pattern: "(", path: "src" }), { refused: /invalid regular expression/ }],
  ["searches with a glob of alternatives and a class", found({ pattern: "hello|dep", ignoreCase: true, glob: "*.{ts,js}", all: true }),
    { ok: [{ path: "node_modules/dep/index.js", line: 1, text: "hello dep" }, { path: "src/app.ts", line: 2, text: "export function hello() {" },
      { path: "src/lib/util.ts", line: 1, text: "export const HELLO = 2;" }] }],
  ["finds files by name at any depth, from the path searched", located({ pattern: "*.ts", path: "src" }), { ok: { paths: ["app.ts", "lib/util.ts"], truncated: false } }],
  ["finds directories too, with / after them", located({ pattern: "lib", path: "src" }), { ok: { paths: ["lib/"], truncated: false } }],
  ["finds by a path below the path searched", located({ pattern: "lib/*.ts", path: "src" }), { ok: { paths: ["lib/util.ts"], truncated: false } }],
  ["finds with alternatives and a class, in either case for an all-lowercase pattern", located({ pattern: "[a-u]*.{TS,js}", path: "src" }), { ok: { paths: [], truncated: false } }],
  ["finds an all-lowercase pattern in either case", located({ pattern: "util.ts", path: "src" }), { ok: { paths: ["lib/util.ts"], truncated: false } }],
  ["skips node_modules unless all", located({ pattern: "*.js" }), { ok: { paths: [], truncated: false } }],
  ["finds in node_modules with all", located({ pattern: "*.js", all: true }), { ok: { paths: ["node_modules/dep/index.js"], truncated: false } }],
  ["finds one past its limit, which says the limit cut something off", located({ pattern: "*", path: "src", limit: 1 }), { ok: { paths: ["app.ts", "lib/"], truncated: true } }],
  ["lists a link as it is, and never follows it", located({ pattern: "in-*" }), { ok: { paths: ["in-dir", "in-file", "nested/in-file"], truncated: false } }],
  ["never finds what lies outside, through links", located({ pattern: "secret*" }), { ok: { paths: [], truncated: false } }],
  ["refuses finding in a file", located({ pattern: "*", path: "long.txt" }), { refused: /not a directory/ }],
  ["refuses finding through a link outside", located({ pattern: "*", path: "out-dir" }), { refused: ESCAPES }],
  ["refuses finding above the worktree", located({ pattern: "*", path: "../outside" }), { refused: TRAVERSAL }],

  ["writes a tree to copy", write("tree/x/y.txt", "Y"), { ok: undefined }],
  ["copies a file, making its directories", copy("inside/a.txt", "copies/a.txt"), { ok: { entries: 1, bytes: 1 } }],
  ["copied it", read("copies/a.txt"), { ok: "A" }],
  ["copies a directory with everything in it", copy("tree", "tree-copy"), { ok: { entries: 3, bytes: 1 } }],
  ["copied its files", read("tree-copy/x/y.txt"), { ok: "Y" }],
  ["copies a link as a link", copy("in-file", "in-file-copy"), { ok: { entries: 1, bytes: 0 } }],
  ["which still points inside", read("in-file-copy"), { ok: "A" }],
  ["copies a link to outside as a link only", copy("out-file", "out-file-copy"), { ok: { entries: 1, bytes: 0 } }],
  ["which still can't be read through", read("out-file-copy"), { refused: ESCAPES }],
  ["refuses copying over something", copy("inside/a.txt", "in-file"), { refused: /the destination exists already/ }],
  ["refuses copying a directory into itself", copy("tree", "tree/inner"), { refused: /the destination is the source or inside it/ }],
  ["refuses copying a hard link", copy("hard.txt", "hard-copy.txt"), { refused: NOT_REGULAR }],
  ["refuses copying from outside through a link", copy("out-dir/secret.txt", "stolen.txt"), { refused: ESCAPES }],
  ["refuses copying from above the worktree", copy("../outside/secret.txt", "stolen.txt"), { refused: TRAVERSAL }],
  ["refuses copying .git", copy(".git", "git-copy"), { refused: GIT }],
  ["refuses copying out of .git through a link", copy("git-link/HEAD", "head-copy"), { refused: REFUSED }],
  ["refuses copying a clone's .git", copy("clone", "clone-copy"), { refused: /Git metadata is protected/ }],
  ["left nothing of the copy it refused", async workspace => (await workspace.listFiles(".", allow)).filter(name => name.startsWith("clone")), { ok: ["clone"] }],
  ["refuses copying into .git", copy("inside/a.txt", ".git/a.txt"), { refused: GIT }],
  ["moves a file, making its directories", move("copies/a.txt", "moved/b.txt"), { ok: { entries: 1, bytes: 0 } }],
  ["moved it", read("moved/b.txt"), { ok: "A" }],
  ["from where it was", names("copies"), { ok: [] }],
  ["moves a link itself", move("in-file-copy", "moved/link"), { ok: { entries: 1, bytes: 0 } }],
  ["which now points to moved/inside/a.txt, missing", read("moved/link"), { refused: REFUSED }],
  ["refuses moving over something", move("tree", "inside"), { refused: /the destination exists already/ }],
  ["refuses moving a directory into itself", move("tree", "tree/x/tree"), { refused: /the destination is the source or inside it/ }],
  ["refuses moving out of the worktree", move("tree", "../outside/tree"), { refused: TRAVERSAL }],
  ["refuses moving out through a link", move("tree", "out-dir/tree"), { refused: ESCAPES }],
  ["refuses moving in from outside through a link", move("out-dir/secret.txt", "stolen.txt"), { refused: ESCAPES }],
  ["refuses moving .git", move(".git", "git-moved"), { refused: GIT }],
  ["refuses moving a clone's .git", move("clone/.git", "git-moved"), { refused: GIT }],
  ["refuses moving into .git", move("tree", ".git/tree"), { refused: GIT }],
  ["refuses moving the worktree", move(".", "elsewhere"), { refused: /the worktree itself/ }],
  ["refuses a missing source", move("missing.txt", "other.txt"), { refused: /no such file or directory/ }],
  ["moves a directory", move("tree-copy", "moved/tree"), { ok: { entries: 1, bytes: 0 } }],
  ["moved everything in it", read("moved/tree/x/y.txt"), { ok: "Y" }],
  ["moves a hard link, never touching what it shares", move("hard.txt", "moved/hard.txt"), { ok: { entries: 1, bytes: 0 } }],
  ["refuses a copy into itself before making anything", copy("tree", "tree/sub/x"), { refused: /the destination is the source or inside it/ }],
  ["made no directory for it", names("tree"), { ok: ["x"] }],
  ["refuses a move of what isn't there before making anything", move("missing.txt", "made-for-nothing/x"), { refused: /no such file or directory/ }],
  ["made no directory for it either", list("made-for-nothing"), { refused: REFUSED }],
  ["deletes a file", remove("moved/b.txt"), { ok: { entries: 1, bytes: 0 } }],
  ["deleted it", read("moved/b.txt"), { refused: REFUSED }],
  ["deletes a link to outside itself, not what it points to", remove("out-file"), { ok: { entries: 1, bytes: 0 } }],
  ["refuses a directory with something in it, without recursive", remove("tree"), { refused: /the directory is not empty/ }],
  ["deletes a directory with recursive", remove("tree", true), { ok: { entries: 3, bytes: 0 } }],
  ["deleted everything in it", read("tree/x/y.txt"), { refused: REFUSED }],
  ["deletes an empty directory", remove("copies"), { ok: { entries: 1, bytes: 0 } }],
  ["deletes a clone, its .git with it", remove("clone", true), { ok: { entries: 4, bytes: 0 } }],
  ["refuses deleting .git", remove(".git", true), { refused: GIT }],
  ["refuses deleting in .git through a link", remove("git-link/HEAD"), { refused: REFUSED }],
  ["refuses deleting outside through a link", remove("out-dir/secret.txt"), { refused: ESCAPES }],
  ["refuses deleting above the worktree", remove("../outside/secret.txt"), { refused: TRAVERSAL }],
  ["refuses deleting the worktree", remove(".", true), { refused: /the worktree itself/ }],
  ["refuses deleting what isn't there", remove("missing.txt"), { refused: /no such file or directory/ }],
  ["refuses deleting in a directory that isn't there, in the same words", remove("missing-dir/x.txt"), { refused: /no such file or directory/ }],
  ["refuses moving from a directory that isn't there, in the same words", move("missing-dir/x.txt", "x.txt"), { refused: /no such file or directory/ }],
];

for (const kind of workspaceKinds) {
  test(`${kind.name}: a session's files follow the same rules`, { skip: kind.missing }, async t => {
    const { workspace, worktree: root } = await kind.open(t);
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
    await mkdir(join(root, "clone", ".git"), { recursive: true });
    await writeFile(join(root, "clone", ".git", "HEAD"), "ref: refs/heads/main\n");
    await writeFile(join(root, "clone", "README"), "clone");
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

    assert.deepEqual(await readdir(outside), ["secret.txt"]);
    assert.equal(await readFile(join(outside, "secret.txt"), "utf8"), "secret");
    assert.deepEqual(await readdir(join(root, ".git")).catch(() => readFile(join(root, ".git"), "utf8")), git);
  });
}
