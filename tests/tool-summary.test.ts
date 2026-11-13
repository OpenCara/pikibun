import assert from "node:assert/strict";
import test from "node:test";
import { callHeadline, pairToolResults, resultOutcome, resultOutput, toolCallRows } from "../packages/client/src/tool-rows.js";
import { briefEntry } from "../packages/shared/src/transcript-display.js";
import { callArguments, callTarget, readable, resultBody, resultNotes, resultSummary } from "../packages/shared/src/tool-summary.js";
import type { EntryView } from "../packages/shared/src/types.js";

const attribution = { initiatedBy: "github:1", actingAs: "github:1", mode: "write" };
const answer = (fields: Record<string, unknown>) => JSON.stringify({ ...attribution, ...fields });
const card = (status: string, result?: string, extra: Record<string, unknown> = {}) =>
  answer({ id: "tool-9", sessionId: "s1", requestedBy: "github:1", operation: { kind: "program", tool: "git", command: "git --no-pager 'status'" }, status,
    ...(result === undefined ? {} : { result }), createdAt: "2026-01-01T00:00:00Z", ...extra });
const call = (name: string, args: Record<string, unknown>) => `${name}(${JSON.stringify(args)})`;
const target = (name: string, args: Record<string, unknown>) => callTarget(name, callArguments(call(name, args)));

test("a call's target is the command line it runs, or what it reads, searches or changes", () => {
  assert.equal(target("git", { args: ["clone", "https://github.com/a/b.git"], directory: "b" }), "git clone https://github.com/a/b.git");
  assert.equal(target("node", { program: "npx", args: ["-y", "pnpm@10", "test", "--filter", "a b"] }), 'npx -y pnpm@10 test --filter "a b"');
  assert.equal(target("gh", { args: ["pr", "view", "12", "--repo", "a/b"] }), "gh pr view 12 --repo a/b");
  assert.equal(target("read_file", { path: "src/a.ts", offset: 60, limit: 30 }), "src/a.ts L60–89");
  assert.equal(target("read_file", { path: "src/a.ts", offset: 60 }), "src/a.ts L60–");
  assert.equal(target("read_file", { path: "src/a.ts" }), "src/a.ts");
  assert.equal(target("edit_file", { path: "a.ts", edits: [{ oldText: "a", newText: "b" }, { oldText: "c", newText: "d" }] }), "a.ts (2 edits)");
  assert.equal(target("search", { pattern: "toolResult", path: "src", glob: "*.ts" }), '"toolResult" in src *.ts');
  assert.equal(target("move_file", { from: "a", to: "b" }), "a → b");
  assert.equal(target("delete_file", { path: "out", recursive: true }), "out (recursive)");
  assert.equal(target("github_read", { repository: "a/b", issue: 7 }), "a/b#7");
  assert.equal(target("git_push", { directory: "app", branch: "main", tag: "v1" }), "app → tag v1");
  assert.equal(target("browser", { url: "http://localhost:5173/", actions: [{}, {}] }), "http://localhost:5173/ · 2 actions");
  assert.equal(target("sessions", { action: "read", session: "s2" }), "read s2");
  assert.equal(target("custom", { text: "first\nsecond" }), "first second", "a tool it doesn't know: its first text");
  assert.equal(target("identity", {}), "");
  assert.equal(callArguments('write({"path":"a.ts","content":"xx…})'), undefined);
  assert.equal(callTarget("write", undefined), "");
  assert.equal(callHeadline("git", "git status"), "git status");
  assert.equal(callHeadline("node", "npx tsc"), "node · npx tsc");
  assert.equal(callHeadline("identity", ""), "identity");
});

test("a result's summary says what came of the call, from what Pikibun's tools answer", () => {
  const summary = (text: string, error?: boolean) => resultSummary(text, { error });
  assert.deepEqual(summary(answer({ content: "a\nb\nc\n" })), { text: "3 lines", failed: false });
  assert.deepEqual(summary(answer({ content: "x", lines: { from: 60, to: 89, total: 975 } })), { text: "Lines 60–89 of 975", failed: false });
  assert.deepEqual(summary(answer({ content: "", lines: { from: 11, to: 10, total: 10 } })), { text: "No lines (10 lines in all)", failed: false });
  assert.equal(summary(answer({ path: "a.png", mimeType: "image/png", width: 80, height: 60 }) + "\n[image image/png]").text, "image/png 80×60 · 1 image");
  assert.equal(summary(answer({ files: [".git", "src"] })).text, "2 entries");
  assert.equal(summary(answer({ matches: [{ path: "a.ts", line: 1 }, { path: "a.ts", line: 9 }, { path: "b.ts", line: 2 }], files: 95, truncated: false })).text, "3 matches in 2 files");
  assert.equal(summary(answer({ matches: [], files: 95, truncated: false })).text, "No matches");
  assert.equal(summary(answer({ matches: [{ path: "a.ts" }], truncated: true })).text, "1 match in 1 file (stopped early)");
  assert.equal(summary(answer({ written: "a.ts" })).text, "Written");
  assert.equal(summary(answer({ edited: "a.ts", edits: 2 })).text, "Edited (2 edits)");
  assert.equal(summary(answer({ deleted: "out", entries: 4 })).text, "Deleted (4 entries)");
  assert.equal(summary(answer({ url: "https://x", ok: true, items: [1, 2], nested: { a: 1 } })).text, "url: https://x, ok: true, items: 2 items");
  assert.deepEqual(summary(card("executed", "Cloning into 'b'...\n")), { text: "Cloning into 'b'...", failed: false });
  assert.deepEqual(summary(card("executed", "start\n[… 900 bytes left out here. The whole output is in tool-output/x.txt …]\n# pass 12\n# fail 0\n")), { text: "# fail 0", failed: false });
  assert.deepEqual(summary(card("executed", "")), { text: "Done, no output", failed: false });
  assert.deepEqual(summary(card("failed", "Sandbox process failed (exit 1)\nnpm error 403")), { text: "Sandbox process failed (exit 1)", failed: true });
  assert.deepEqual(summary(card("denied")), { text: "Denied", failed: true });
  assert.deepEqual(summary(card("pending")), { text: "Waiting for approval", failed: false });
  assert.deepEqual(summary(card("executed", "{}", { report: { title: "Home", url: "http://localhost/", status: 200 } })), { text: "Home · HTTP 200", failed: false });
  assert.deepEqual(summary(card("executed", "{}", { report: { error: "No element matched #go", url: "http://localhost/" } })), { text: "No element matched #go", failed: true });
  assert.deepEqual(summary("\n  PASS tests/a.test.ts  \nmore"), { text: "  PASS tests/a.test.ts", failed: false });
  assert.deepEqual(summary("Tool bash is not available", true), { text: "Tool bash is not available", failed: true });
  assert.deepEqual(summary("{not json"), { text: "{not json", failed: false });
  assert.equal(summary("x".repeat(500)).text.length, 201, "cut to one line's worth, with an ellipsis");
});

test("a file tool's result in Pi's words: its summary reads Pi's text and notices, and opens as it is", () => {
  const summary = (tool: string, text: string) => resultSummary(text, { tool }).text;
  assert.equal(summary("read_file", "one\ntwo\nthree"), "3 lines");
  assert.equal(summary("read_file", "{\"name\": \"app\"}\n"), "1 line", "a JSON file read is a file, not an answer");
  assert.equal(summary("read_file", "a\nb\n\n[Showing lines 1-2000 of 2501. Use offset=2001 to continue.]"), "Lines 1–2000 of 2501");
  assert.equal(summary("read_file", "a\n\n[Showing lines 7-9 of 90 (50.0KB limit). Use offset=10 to continue.]"), "Lines 7–9 of 90");
  assert.equal(summary("read_file", "two\nthree\n\n[5 more lines in file. Use offset=4 to continue.]"), "Lines 2–3 of 8");
  assert.equal(summary("read_file", "[Line 3 is 60.0KB, exceeds 50.0KB limit. A code mode script's read gets whole lines.]"), "Line 3 is 60.0KB, too long to show");
  assert.equal(summary("read_file", "Read image file [image/png]\n[image image/png]"), "image/png");
  assert.equal(summary("write_file", "Successfully wrote to a.ts"), "Written");
  assert.equal(summary("edit_file", "Successfully replaced 2 block(s) in a.ts."), "Edited (2 edits)");
  assert.equal(summary("list_files", "a/\nb\n.c"), "3 entries");
  assert.equal(summary("list_files", "a\nb\n\n[2 entries limit reached. Use limit=4 for more]"), "2 entries (more not shown)");
  assert.equal(summary("list_files", "(empty directory)"), "Empty directory");
  assert.equal(summary("search", "src/a-1- before\nsrc/a:2: x\nb.ts:9: y: z\nb.ts-10- after"), "2 matches in 2 files");
  assert.equal(summary("search", "a.ts:1: x\n\n[1 matches limit reached. Use limit=2 for more, or refine pattern]"), "1 match in 1 file (stopped early)");
  assert.equal(summary("search", "No matches found"), "No matches");
  assert.equal(summary("search", answer({ matches: [], files: 95, truncated: false })), "No matches", "a result from before Pi's contract still reads as it did");
  assert.equal(summary("read_file", answer({ content: "a\nb\n" })), "2 lines");
  for (const tool of ["read_file", "list_files", "search", "write_file", "edit_file"]) {
    assert.deepEqual(resultSummary("invalid regular expression", { error: true, tool }), { text: "invalid regular expression", failed: true }, `a failed ${tool} reads as its error`);
  }
  assert.equal(resultBody("{\"name\": \"app\"}\n", { tool: "read_file" }), "{\"name\": \"app\"}\n", "a JSON file opens as it is");
  assert.equal(resultBody(answer({ content: "const a = 1;\n" }), { tool: "read_file" }), "const a = 1;\n");
});

test("an opened result reads as the tool printed it, without who asked", () => {
  assert.equal(resultBody(card("executed", "line one\nline two\n")), "line one\nline two\n");
  assert.equal(resultBody(card("failed", "Sandbox process failed (exit 1)")), "(failed)\nSandbox process failed (exit 1)");
  assert.equal(resultBody(card("denied")), "(denied)");
  assert.equal(resultBody(answer({ content: "const a = 1;\n" })), "const a = 1;\n");
  assert.equal(resultBody(answer({ matches: [{ path: "a.ts", line: 3, text: "x" }], files: 9, truncated: false })),
    "matches:\n  - path: a.ts\n    line: 3\n    text: x\nfiles: 9\ntruncated: false");
  assert.equal(resultBody("plain output\n"), "plain output\n");
  assert.equal(readable({ path: "a.ts", edits: [{ oldText: "a\nb", newText: "c" }], args: ["status", "-s"], empty: {} }),
    "path: a.ts\nedits:\n  - oldText:\n      a\n      b\n    newText: c\nargs: [\"status\",\"-s\"]\nempty: {}");
});

const harness = (...lines: string[]) => `<harness>\n${lines.join("\n")}\n</harness>`;

test("a call that failed in the harness reads as the reason it failed, not as its <harness> tags", () => {
  const thrown = harness("[error] Request failed: ECONNRESET");
  assert.deepEqual(resultSummary(thrown, { error: true }), { text: "Request failed: ECONNRESET", failed: true });
  assert.equal(resultBody(thrown), "Error: Request failed: ECONNRESET");
  assert.deepEqual(resultNotes(thrown), { output: "", notes: [{ severity: "error", message: "Request failed: ECONNRESET" }] });

  const multi = `partial output\n${harness("[warn] Output truncated", "[error] git exited 128:", "fatal: not a git repository")}`;
  assert.deepEqual(resultSummary(multi), { text: "git exited 128:", failed: true }, "the first error, even after output and warnings");
  assert.equal(resultBody(multi), "partial output\nWarning: Output truncated\nError: git exited 128:\nfatal: not a git repository");

  const noted = `${answer({ content: "a\nb\n" })}\n${harness("[info] Output truncated to its beginning")}`;
  assert.deepEqual(resultSummary(noted), { text: "2 lines", failed: false }, "a note alone leaves the output's own summary");
  assert.equal(resultBody(noted), "a\nb\nNote: Output truncated to its beginning");
  assert.deepEqual(resultSummary(harness("[warn] Nothing printed")), { text: "Nothing printed", failed: false });

  for (const text of ["<harness>\nnot a note\n</harness>", "plain\n</harness>", "<harness>"]) {
    assert.deepEqual(resultNotes(text), { output: text, notes: [] }, `left as it is: ${JSON.stringify(text)}`);
  }
  const brief = briefEntry(entry("0:7", "toolResult", thrown, { toolResult: { callId: "c1", tool: "gh", error: true } }));
  assert.equal(brief.text, "Request failed: ECONNRESET", "brief tool output keeps the reason too");
});

const entry = (id: string, role: string, text: string, extra: Partial<EntryView> = {}): EntryView => ({ id, kind: "message", role, text, conversationId: "0", ...extra });

test("each tool call shows with the result that answered it, by its id or in order", () => {
  const calls = entry("0:2", "assistant", `Looking.\n${call("read_file", { path: "a.ts" })}\n${call("git", { args: ["status"] })}`,
    { toolCalls: [{ id: "c1", name: "read_file" }, { id: "c2", name: "git" }] });
  const git = entry("0:3", "toolResult", card("executed", "clean\n"), { toolResult: { callId: "c2", tool: "git" }, durationMs: 40 });
  const read = entry("0:4", "toolResult", answer({ content: "a\n" }), { toolResult: { callId: "c1", tool: "read_file" } });
  const stray = entry("0:5", "toolResult", "answers nothing here", { toolResult: { callId: "c9" } });
  const reply = entry("0:6", "assistant", "Done.");
  const paired = pairToolResults([entry("0:1", "user", "Go"), calls, git, read, stray, reply]);
  assert.deepEqual(paired.entries.map(item => item.id), ["0:1", "0:2", "0:5", "0:6"]);
  assert.deepEqual(paired.results.get("0:2"), [read, git]);
  const rows = toolCallRows(calls, paired.results.get("0:2"));
  assert.deepEqual(rows.map(row => [row.key, callHeadline(row.name, row.target), row.outcome?.text]),
    [["0:2#0", "read_file · a.ts", "1 line"], ["0:2#1", "git status", "clean"]]);
  assert.equal(rows[0]!.args, "path: a.ts");
  assert.equal(resultOutput(rows[1]!.result!), "clean\n");

  const older = entry("1:2", "assistant", `${call("bash", { command: "ls" })}\n${call("bash", { command: "pwd" })}`, { conversationId: "1" });
  const first = entry("1:3", "toolResult", "a b", { conversationId: "1" });
  const running = pairToolResults([older, first]);
  assert.deepEqual(running.entries.map(item => item.id), ["1:2"]);
  assert.deepEqual(running.results.get("1:2"), [first, undefined]);
  assert.deepEqual(toolCallRows(older, running.results.get("1:2")).map(row => row.outcome?.text), ["a b", undefined]);

  const alone = pairToolResults([entry("0:9", "toolResult", "orphan"), entry("0:10", "assistant", call("bash", { command: "ls" })), entry("2:1", "toolResult", "other", { conversationId: "2" })]);
  assert.deepEqual(alone.entries.map(item => item.id), ["0:9", "0:10", "2:1"]);
  assert.deepEqual(alone.results.get("0:10"), [undefined]);
});

test("each call's auto-approve mark goes with its own row", () => {
  const calls = entry("0:1", "assistant", [call("read_file", { path: "a" }), call("node", { program: "npm", args: ["test"] }), call("git", { args: ["log"] })].join("\n"),
    { autoApproved: [{ tool: "node", status: "executed" }, { tool: "git", status: "failed" }] });
  assert.deepEqual(toolCallRows(calls).map(row => row.autoApproved?.status), [undefined, "executed", "failed"]);
  const twice = entry("0:2", "assistant", [call("bash", { command: "a" }), call("bash", { command: "b" })].join("\n"),
    { toolCalls: [{ id: "c1", name: "bash" }, { id: "c2", name: "bash" }], autoApproved: [{ tool: "bash", callId: "c2", status: "executed", unbounded: true }] });
  assert.deepEqual(toolCallRows(twice).map(row => row.autoApproved?.callId), [undefined, "c2"]);
});

test("in brief tool output, a result's line is what came of it, and stays marked where it failed", () => {
  const whole = entry("0:3", "toolResult", card("failed", "Sandbox process failed (exit 1)\nmore"), { toolResult: { callId: "c1", tool: "git" } });
  const brief = briefEntry(whole);
  assert.deepEqual(resultOutcome(brief), { text: "Sandbox process failed (exit 1)", failed: true });
  assert.equal(resultOutput(brief), "Sandbox process failed (exit 1)", "the brief line is all there is to open");
  assert.deepEqual(resultOutcome(whole), resultOutcome(brief));
});
