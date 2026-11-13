import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, sep } from "node:path";
import { isDeepStrictEqual } from "node:util";
import test, { type TestContext } from "node:test";
import type { ToolExecutionApi, ToolRegistration } from "@earendil-works/pi-durable";
import {
  createEditToolDefinition, createGrepToolDefinition, createLsToolDefinition, createReadToolDefinition, createWriteToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { defaultHostConfig } from "../packages/shared/src/host-config.js";
import type { RunnerBinding } from "../packages/shared/src/types.js";
import { EDIT_ROOT, editTarget, grepText, lsText, prepareEditArguments, readText, runPiEdit } from "../apps/runner/src/pi-file-tools.js";
import { RunnerError } from "../apps/runner/src/protocol.js";
import { wholeForScripts } from "../apps/runner/src/script-output.js";
import { ToolCalls } from "../apps/runner/src/session/tools/calls.js";
import type { ToolContext } from "../apps/runner/src/session/tools/context.js";
import { fileTools } from "../apps/runner/src/session/tools/files.js";
import type { Metadata } from "../apps/runner/src/session/state.js";
import type { SessionWorkspace } from "../apps/runner/src/workspace.js";
import { workspaceKinds } from "./helpers/workspaces.js";

process.env.PI_OFFLINE = "1";

const ripgrep = spawnSync("rg", ["--version"], { stdio: "ignore" }).error === undefined;
const attribution = { initiatedBy: "github:2", actingAs: "github:1", mode: "write" };

type Outcome = { text: string; details?: unknown; images?: number } | { error: string };
type Run = (name: string, args: Record<string, unknown>) => Promise<Outcome>;

function state(): Metadata {
  return { binding: {} as RunnerBinding, branches: [], approvals: {}, toolActors: {},
    runs: { r1: { key: "r1", initiatedBy: "github:2", ownerId: "github:1", mode: "write", conversationId: 1, content: "", contentHash: "", status: "running", startEntry: 0,
      admissionId: "admission" } } };
}

function api(metadata: Metadata, script = false): ToolExecutionApi {
  return { taskId: 1, callId: "call-1", conversationId: 1,
    snapshot: async () => ({ json: JSON.stringify(metadata) }),
    getTask: async () => ({ input: script ? { kind: "nested" } : { kind: "call" } }),
    retainedOutput: () => ({ text: "", truncated: false }),
    commit: async (change: (tx: { doc(): Promise<{ json: string }> }) => Promise<void>) => {
      const doc = { json: JSON.stringify(metadata) };
      await change({ doc: async () => doc });
      Object.assign(metadata, JSON.parse(doc.json));
    } } as unknown as ToolExecutionApi;
}

function pikibunTools(sandbox: SessionWorkspace, metadata = state()): (name: string) => ToolRegistration {
  const calls = new ToolCalls({ ownerId: "github:1", sandbox, hostCommands: {} as never, authorize: async () => {}, metadata: async () => structuredClone(metadata),
    hostConfig: async () => defaultHostConfig, requireOwnerTool: async () => {}, requireSenderTool: async () => {} });
  const context = { sandbox, calls, onHost: false, hostConfig: async () => defaultHostConfig } as unknown as ToolContext;
  const registered = fileTools(context).map(wholeForScripts);
  return name => registered.find(tool => tool.name === name)!;
}

function ours(sandbox: SessionWorkspace, script = false): Run {
  const metadata = state();
  const tool = pikibunTools(sandbox, metadata);
  return async (name, args) => {
    try {
      const registration = tool(name);
      const prepared = registration.prepareArguments ? registration.prepareArguments(args) : args;
      const result = await registration.execute(prepared as never, api(metadata, script), {} as never);
      const output = result.output ?? [];
      const { pikibun, ...details } = (result.details ?? {}) as Record<string, unknown>;
      assert.deepEqual(pikibun, attribution, "who the call acts for is in details.pikibun");
      return { text: output.flatMap(part => part.type === "text" ? [part.text] : []).join("\n"), ...(Object.keys(details).length ? { details } : {}),
        ...(output.some(part => part.type === "image") ? { images: output.filter(part => part.type === "image").length } : {}) };
    } catch (error) { return { error: error instanceof Error ? error.message : String(error) }; }
  };
}

function pi(root: string): Run {
  const definitions = { read: createReadToolDefinition(root), write: createWriteToolDefinition(root), edit: createEditToolDefinition(root),
    ls: createLsToolDefinition(root), grep: createGrepToolDefinition(root) } as Record<string, { execute: Function; prepareArguments?: (args: unknown) => unknown }>;
  return async (name, args) => {
    const definition = definitions[name]!;
    try {
      const prepared = definition.prepareArguments ? definition.prepareArguments(structuredClone(args)) : args;
      const result = await definition.execute("call", prepared, undefined, undefined, undefined) as { content: { type: string; text?: string }[]; details?: unknown };
      const details = result.details === undefined ? undefined : JSON.parse(JSON.stringify(result.details));
      return { text: result.content.flatMap(part => part.type === "text" ? [part.text!] : []).join("\n"), ...(details && Object.keys(details).length ? { details } : {}),
        ...(result.content.some(part => part.type === "image") ? { images: result.content.filter(part => part.type === "image").length } : {}) };
    } catch (error) { return { error: error instanceof Error ? error.message : String(error) }; }
  };
}

function similar(actual: unknown, expected: unknown, label: string) {
  if (isDeepStrictEqual(actual, expected)) return;
  const [a, b] = [JSON.stringify(actual) ?? "undefined", JSON.stringify(expected) ?? "undefined"];
  let at = 0;
  while (at < a.length && a[at] === b[at]) at++;
  assert.fail(`${label}: differs at ${at}\n  ours: …${a.slice(Math.max(0, at - 80), at + 120)}\n  Pi's: …${b.slice(Math.max(0, at - 80), at + 120)}`);
}

const lines = (count: number, line: (index: number) => string) => Array.from({ length: count }, (_, index) => line(index + 1)).join("\n");

const corpus: Record<string, string> = {
  "a.txt": "one\ntwo\nthree\n",
  "noeol.txt": "x\ny",
  "crlf.txt": "alpha\r\nbeta\r\ngamma\r\n",
  "bom.txt": "\uFEFFline1\nline2\n",
  "empty.txt": "",
  "big.txt": `${lines(2500, index => `line ${index}`)}\n`,
  "wide.txt": `${lines(300, index => `${String(index).padStart(4, "0")} ${"w".repeat(295)}`)}\n`,
  "longline.txt": `${"z".repeat(60 * 1024)}\nnext\n`,
  "unicode.txt": "caf\u00e9 \u{1F600}\n\u65e5\u672c\u8a9e\n",
  "dir/B.txt": "b\n", "dir/a.txt": "a\n", "dir/.hidden": "h\n", "dir/sub/x.txt": "x\n", "dir/Zeta/y.txt": "y\n", "dir/_under": "u\n",
  "src/app.ts": "const a = 1;\nexport function hello() {\n  return \"hi\";\n}\n",
  "src/lib/util.ts": "export const HELLO = 2;\r\nexport const other = 3;\r\n",
  "src/long.ts": `const x = "${"y".repeat(700)}";\nconst short = "x";\n`,
  "src/ctx.ts": `${lines(20, index => index === 5 || index === 7 || index === 15 ? `hit ${index}` : `plain ${index}`)}\n`,
  "src/many.ts": `${lines(150, index => `match ${index}`)}\n`,
  "src/Mixed.ts": "Needle\nneedle\nNEEDLE (a.b)\n",
};
for (let index = 0; index < 600; index++) corpus[`many/f${String(index).padStart(3, "0")}.txt`] = "";

async function lay(root: string) {
  for (const [path, content] of Object.entries(corpus)) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), content);
  }
  await mkdir(join(root, "emptydir"), { recursive: true });
}

async function scratch(t: TestContext, prefix: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

const reads: Record<string, unknown>[] = [
  { path: "a.txt" }, { path: "a.txt", offset: 2 }, { path: "a.txt", offset: 2, limit: 1 }, { path: "a.txt", limit: 0 }, { path: "a.txt", offset: 4 },
  { path: "a.txt", offset: 5 }, { path: "a.txt", offset: 0, limit: 2 }, { path: "a.txt", offset: 1.5, limit: 1.5 }, { path: "a.txt", limit: -1 },
  { path: "noeol.txt" }, { path: "crlf.txt", offset: 2 }, { path: "bom.txt" }, { path: "empty.txt" }, { path: "empty.txt", offset: 2 }, { path: "unicode.txt" },
  { path: "big.txt" }, { path: "big.txt", offset: 1990, limit: 20 }, { path: "big.txt", offset: 2400 }, { path: "wide.txt" }, { path: "wide.txt", offset: 100, limit: 50 },
];

const listings: Record<string, unknown>[] = [
  { path: "dir" }, { path: "dir", limit: 2 }, { path: "dir", limit: 0 }, { path: "dir/" }, { path: "many" }, { path: "many", limit: 10.5 }, { path: "emptydir" },
];

const searches: Record<string, unknown>[] = [
  { pattern: "two", path: "a.txt" }, { pattern: "match", path: "src/many.ts" }, { pattern: "match", path: "src/many.ts", limit: 10, context: 2 },
  { pattern: "match 1", path: "src/many.ts", limit: 3 }, { pattern: "x", path: "src/long.ts" }, { pattern: "hit", path: "src/ctx.ts", context: 2 },
  { pattern: "hit", path: "src/ctx.ts", context: 1, limit: 2 }, { pattern: "needle", path: "src/Mixed.ts", ignoreCase: true },
  { pattern: "(a.b)", path: "src/Mixed.ts", literal: true }, { pattern: "HELLO", path: "src/lib/util.ts" }, { pattern: "zzz", path: "src" },
  { pattern: ".", path: "wide.txt", limit: 400 }, { pattern: "export", path: "src" }, { pattern: "export", path: "src", glob: "lib/*.ts" },
  { pattern: "export", path: "src", glob: "*.ts" }, { pattern: "export", path: "src", glob: "./**/*.ts" }, { pattern: "line[0-9]", path: "bom.txt" },
  { pattern: "\u65e5", path: "unicode.txt" },
];

const edits: { file: string; content: string; args: Record<string, unknown> }[] = [
  { file: "e1.txt", content: "alpha\nbeta\ngamma\n", args: { path: "e1.txt", edits: [{ oldText: "beta", newText: "BETA" }] } },
  { file: "e2.txt", content: "alpha\nbeta\ngamma\ndelta\n", args: { path: "e2.txt", edits: [{ oldText: "alpha\n", newText: "ALPHA\n" }, { oldText: "delta", newText: "DELTA\nEPSILON" }] } },
  { file: "e3.txt", content: "one\r\ntwo\r\nthree\r\n", args: { path: "e3.txt", edits: [{ oldText: "two\nthree", newText: "2\n3" }] } },
  { file: "e4.txt", content: "\uFEFFkeep\nchange\n", args: { path: "e4.txt", edits: [{ oldText: "change", newText: "changed" }] } },
  { file: "e5.txt", content: "say \u201chi\u201d   \nit\u2019s \u2014 done\n", args: { path: "e5.txt", edits: [{ oldText: "say \"hi\"\nit's - done", newText: "said hi\nit is done" }] } },
  { file: "e6.txt", content: "a\nb\n", args: { path: "e6.txt", edits: [{ oldText: "missing", newText: "x" }] } },
  { file: "e7.txt", content: "dup\ndup\n", args: { path: "e7.txt", edits: [{ oldText: "dup", newText: "x" }] } },
  { file: "e8.txt", content: "abc\n", args: { path: "e8.txt", edits: [{ oldText: "abc", newText: "x" }, { oldText: "bc", newText: "y" }] } },
  { file: "e9.txt", content: "same\n", args: { path: "e9.txt", edits: [{ oldText: "same", newText: "same" }] } },
  { file: "e10.txt", content: "x\n", args: { path: "e10.txt", edits: [] } },
  { file: "e11.txt", content: "old\n", args: { path: "e11.txt", edits: JSON.stringify([{ oldText: "old", newText: "new" }]) } },
  { file: "e12.txt", content: "old\n", args: { path: "e12.txt", oldText: "old", newText: "new" } },
  { file: "e13.txt", content: `${lines(80, index => `row ${index}`)}\n`, args: { path: "e13.txt", edits: [{ oldText: "row 10\n", newText: "" }, { oldText: "row 70", newText: "ROW 70" }] } },
];

for (const kind of workspaceKinds) {
  test(`${kind.name}: the file tools answer as Pi's own read, ls, grep, write and edit do`, { skip: kind.missing }, async t => {
    const { workspace, worktree } = await kind.open(t);
    const root = await scratch(t, "pi-tools-");
    await lay(root);
    await lay(worktree);
    const theirs = pi(root);
    const mine = ours(workspace);
    const same = async (name: string, args: Record<string, unknown>, compare: (outcome: Outcome) => unknown = outcome => outcome) => {
      const expected = await theirs(name, args);
      const actual = await mine(name, args);
      similar(compare(actual), compare(expected), `${name} ${JSON.stringify(args)}`);
    };

    for (const args of reads) await same("read", args);
    for (const args of listings) await same("ls", args);

    const longline = await mine("read", { path: "longline.txt" });
    const piLongline = await theirs("read", { path: "longline.txt" });
    assert.ok("text" in longline && "text" in piLongline);
    assert.deepEqual(longline.details, piLongline.details, "a first line over 50 KB: Pi's details");
    assert.match(longline.text, /^\[Line 1 is 60\.0KB, exceeds 50\.0KB limit\. A code mode script's read gets whole lines\.\]$/, "with a notice that doesn't point to bash");

    for (const { file, content, args } of edits) {
      await writeFile(join(root, file), content);
      await writeFile(join(worktree, file), content);
      const expected = await theirs("edit", args);
      const actual = await mine("edit", args);
      similar(actual, expected, `edit ${JSON.stringify(args)}`);
      assert.equal(await readFile(join(worktree, file), "utf8"), await readFile(join(root, file), "utf8"), `${file} as Pi left it`);
    }

    for (const args of [{ path: "w/deep/new.txt", content: "fresh\n" }, { path: "a.txt", content: "over" }]) {
      await same("write", args);
      assert.equal(await readFile(join(worktree, args.path), "utf8"), await readFile(join(root, args.path), "utf8"));
    }

    if (ripgrep) {
      const sorted = (outcome: Outcome) => "text" in outcome ? { ...outcome, text: outcome.text.split("\n").sort() } : outcome;
      for (const args of searches) await same("grep", args, typeof args.path === "string" && args.path.includes(".") ? undefined : sorted);
    } else t.diagnostic("ripgrep (rg) is not installed: Pi's grep can't run, so search isn't compared with it here");
  });
}

test("the file tools' exceptions to Pi's contract: worktree paths, links, Pikibun's limits and scripts", async t => {
  const kind = workspaceKinds.find(item => item.name.startsWith("the unsandboxed host"))!;
  if (kind.missing) return t.skip(kind.missing);
  const { workspace, worktree } = await kind.open(t);
  await lay(worktree);
  const mine = ours(workspace);
  for (const path of ["~", "~/notes.txt"]) {
    for (const [name, args] of [["read", { path }], ["write", { path, content: "x" }], ["ls", { path }], ["grep", { pattern: "x", path }], ["edit", { path, edits: [{ oldText: "a", newText: "b" }] }]] as const) {
      const outcome = await mine(name, args);
      assert.ok("error" in outcome && /not a worktree path/.test(outcome.error), `${name} ${path}: ${JSON.stringify(outcome)}`);
    }
  }
  assert.ok("error" in await mine("read", { path: "/etc/hostname" }), "an absolute path is refused");
  await writeFile(join(worktree, "dir", "data.bin"), Buffer.from([1, 0, 2]));
  await symlink("sub", join(worktree, "dir", "link-to-sub"));
  assert.deepEqual(await mine("ls", { path: "dir" }), { text: "_under\n.hidden\na.txt\nB.txt\ndata.bin\nlink-to-sub\nsub/\nZeta/" }, "a link is listed as it is, without /");
  assert.deepEqual(await mine("grep", { pattern: "match", path: "src/many.ts", limit: 9000 }).then(outcome => "text" in outcome && outcome.text.split("\n").length), 150,
    "a limit over 500 is lowered, not refused");
  assert.deepEqual(await mine("grep", { pattern: "hit 5", path: "src/ctx.ts", context: 99 }), { text: lines(10, index => index === 5 ? "ctx.ts:5: hit 5" : index === 7 ? "ctx.ts-7- hit 7" : `ctx.ts-${index}- plain ${index}`) },
    "context over 5 is lowered, not refused");
  const script = ours(workspace, true);
  const whole = await script("read", { path: "big.txt" });
  assert.ok("text" in whole);
  assert.equal(whole.text, corpus["big.txt"], "a script's read gets the whole file, with no notice");
  assert.deepEqual(await script("read", { path: "big.txt", offset: 2499, limit: 1 }), { text: "line 2499" }, "and the lines it asks for, with no notice");
});

test("search: Pi's grep text from Pikibun's matches, merged context, paths from the path searched, and the limit's notice only when more were found", () => {
  const match = (path: string, line: number, text: string, before: string[] = [], after: string[] = []) => ({ path, line, text, ...(before.length || after.length ? { before, after } : {}) });
  assert.deepEqual(grepText({ matches: [match("src/a.ts", 2, "two", ["one"], ["three"]), match("src/a.ts", 3, "three", ["two"], ["four"])], files: 1, truncated: false }, "src", 100, 500),
    { text: "a.ts-1- one\na.ts:2: two\na.ts:3: three\na.ts-4- four" });
  assert.deepEqual(grepText({ matches: [match("src/a.ts", 2, "two")], files: 1, truncated: false }, "src/a.ts", 100, 500), { text: "a.ts:2: two" }, "a file searched is named by its base name");
  assert.deepEqual(grepText({ matches: [match("a.ts", 1, "x"), match("a.ts", 2, "y")], files: 1, truncated: true }, ".", 1, 500),
    { text: "a.ts:1: x\n\n[1 matches limit reached. Use limit=2 for more, or refine pattern]", details: { matchLimitReached: 1 } });
  assert.deepEqual(grepText({ matches: [match("a.ts", 1, "x"), match("a.ts", 2, "y")], files: 1, truncated: false }, ".", 1, 1).text,
    "a.ts:1: x\n\n[1 matches limit reached. Refine pattern, path or glob]", "at Pikibun's most, no larger limit is offered");
  assert.deepEqual(grepText({ matches: [match("a.ts", 1, "x")], files: 1, truncated: true }, ".", 1, 500),
    { text: "a.ts:1: x\n\n[Search stopped early at Pikibun's file, size or time limit; narrow it with path or glob]" }, "stopped by Pikibun's own limits, which Pi doesn't have");
  assert.deepEqual(grepText({ matches: [], files: 0, truncated: false }, ".", 100, 500), { text: "No matches found" });
});

test("read and ls: Pi's selection, notices and details from the whole text", () => {
  assert.deepEqual(readText("a\nb\nc", 2, 1, false), { text: "b\n\n[1 more lines in file. Use offset=3 to continue.]" });
  assert.throws(() => readText("a\n", 3, undefined, false), /^Error: Offset 3 is beyond end of file \(2 lines total\)$/);
  assert.deepEqual(readText("a\nb\nc", 2, 1, true), { text: "b" }, "a script gets the selection, with no notice");
  assert.deepEqual(lsText(["b", "A/", ".x"], undefined), { text: ".x\nA/\nb" });
  assert.deepEqual(lsText([], 3), { text: "(empty directory)" });
});

test("edit stays off the host: Pi's own edit runs over the worktree, and no path the model gives makes it read, write or probe a path of the host", async () => {
  assert.ok(isAbsolute(EDIT_ROOT) && !existsSync(EDIT_ROOT), "the edit's working directory is made up, absolute, and isn't there");
  const hostile = ["/etc/passwd", "~", "~/.bashrc", "~\\x", "@~/.bashrc", "@/etc/passwd", "@~", "../outside.txt", "a/../../outside.txt", "..", ".", "", "@", "@..", "@../x",
    "file:///etc/passwd", "@file:///etc/passwd", "C:\\Windows\\win.ini", "c:x", "\\\\server\\share\\x", "\\x", "/", "a\0b"];
  for (const path of hostile) {
    const touched: string[] = [];
    assert.throws(() => editTarget(path), /is not a worktree path/, JSON.stringify(path));
    await assert.rejects(runPiEdit({ path, edits: [{ oldText: "a", newText: "b" }] }, { read: async () => { touched.push("read"); return "a"; }, write: async () => { touched.push("write"); } }),
      /is not a worktree path/, JSON.stringify(path));
    assert.deepEqual(touched, [], `${JSON.stringify(path)} reached nothing`);
  }
  for (const [path, inside] of [["a.txt", "a.txt"], ["@a.txt", "a.txt"], ["dir/../a.txt", "a.txt"], ["x\u00A0y.txt", "x y.txt"], ["@@x", "@x"], ["~x", "~x"]] as const) {
    assert.equal(relative(EDIT_ROOT, editTarget(path)), inside.split("/").join(sep), path);
    const written: string[] = [];
    const result = await runPiEdit({ path, edits: [{ oldText: "a", newText: "b" }] }, { read: async () => "a\n", write: async content => { written.push(content); } });
    assert.equal(result.text, `Successfully replaced 1 block(s) in ${path}.`);
    assert.deepEqual(written, ["b\n"]);
  }
  assert.ok(!existsSync(EDIT_ROOT), "and nothing made the made-up directory");
});

test("edit through the tool: a refused path reaches neither the sandbox nor Pi, and the call's own arguments are repaired as Pi repairs them", async () => {
  const touched: string[] = [];
  const sandbox = { readFile: async (path: string) => { touched.push(`read ${path}`); return "a\n"; }, writeFile: async (path: string) => { touched.push(`write ${path}`); } } as unknown as SessionWorkspace;
  const metadata = state();
  const tool = pikibunTools(sandbox, metadata)("edit");
  for (const path of ["/etc/passwd", "~/.bashrc", "@~/x", "../x"]) {
    await assert.rejects(tool.execute({ path, edits: [{ oldText: "a", newText: "b" }] } as never, api(metadata), {} as never),
      (error: unknown) => error instanceof RunnerError && error.status === 400 && /is not a worktree path/.test(error.message));
  }
  assert.deepEqual(touched, []);
  assert.deepEqual(prepareEditArguments({ path: "a", edits: "[{\"oldText\":\"x\",\"newText\":\"y\"}]" }), { path: "a", edits: [{ oldText: "x", newText: "y" }] });
  const args = { path: "a", oldText: "x", newText: "y" };
  assert.deepEqual(prepareEditArguments(args), { path: "a", edits: [{ oldText: "x", newText: "y" }] });
  assert.deepEqual(args, { path: "a", oldText: "x", newText: "y" }, "without changing the call's own arguments");
  await tool.execute({ path: "@a", edits: [{ oldText: "a", newText: "b" }] } as never, api(metadata), {} as never);
  assert.deepEqual(touched, ["read @a", "write @a"], "the worktree path is the one the model gave, read and written by the sandbox");
});
