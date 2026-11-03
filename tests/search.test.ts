import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { searchInWorker, searchRequest } from "../apps/runner/src/search.js";
import { lineRange } from "../apps/runner/src/edits.js";

test("search: the tool's arguments become a request, with defaults, or say what is wrong", () => {
  assert.deepEqual(searchRequest({ pattern: "x" }), { kind: "search", path: ".", pattern: "x", literal: false, ignoreCase: false, context: 0, maxResults: 100, all: false });
  assert.deepEqual(searchRequest({ pattern: "x", path: "src/", glob: "*.ts", ignore_case: true, context: 2, max_results: 5, literal: true, all: true }),
    { kind: "search", path: "src", pattern: "x", literal: true, ignoreCase: true, glob: "*.ts", context: 2, maxResults: 5, all: true });
  assert.throws(() => searchRequest({ pattern: "" }), /pattern must be/);
  assert.throws(() => searchRequest({ pattern: "x".repeat(1001) }), /pattern must be/);
  assert.throws(() => searchRequest({ pattern: "x", context: 6 }), /context must be/);
  assert.throws(() => searchRequest({ pattern: "x", max_results: 501 }), /max_results must be/);
  assert.throws(() => searchRequest({ pattern: "x", glob: "a\\b" }), /glob must be/);
  assert.throws(() => searchRequest({ pattern: "x", literal: "yes" }), /literal must be/);
});

test("read_file's line ranges: the lines asked for, with their endings, and where they are in the file", () => {
  const text = "one\ntwo\r\nthree\nfour";
  assert.deepEqual(lineRange(text, 2, 2), { content: "two\r\nthree\n", lines: { from: 2, to: 3, total: 4 } });
  assert.deepEqual(lineRange(text, 3), { content: "three\nfour", lines: { from: 3, to: 4, total: 4 } });
  assert.deepEqual(lineRange(text, undefined, 1), { content: "one\n", lines: { from: 1, to: 1, total: 4 } });
  assert.deepEqual(lineRange(text, 9, 3), { content: "", lines: { from: 5, to: 4, total: 4 } }, "past the end: nothing, and how many lines there are");
  assert.deepEqual(lineRange("a\n", 1, 5), { content: "a\n", lines: { from: 1, to: 1, total: 1 } });
});

test("search on an unsandboxed host: a pattern that backtracks without end stops its worker, never the connector", async t => {
  const directory = await mkdtemp(join(tmpdir(), "pikibun-search-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await writeFile(join(directory, "slow.txt"), `${"a".repeat(40)}!\n`);
  let ticks = 0;
  const ticker = setInterval(() => ticks++, 50);
  t.after(() => clearInterval(ticker));
  const started = Date.now();
  await assert.rejects(searchInWorker(directory, ".", searchRequest({ pattern: "^(a+)+$" }), 1000), /search took too long/);
  assert.ok(Date.now() - started < 5000, "stopped at its time limit");
  assert.ok(ticks >= 10, "the connector's own work went on meanwhile");
  // An ordinary search in a worker answers as the helpers do.
  await writeFile(join(directory, "a.ts"), "export const answer = 42;\n");
  assert.deepEqual(await searchInWorker(directory, ".", searchRequest({ pattern: "answer", glob: "*.ts" })),
    { matches: [{ path: "a.ts", line: 1, text: "export const answer = 42;" }], files: 1, truncated: false });
});
