import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { findInWorker, findRequest, searchInWorker, searchRequest } from "../apps/runner/src/search.js";

test("search: Pi's grep arguments become a request, with Pi's defaults, lowered to Pikibun's limits, or say what is wrong", () => {
  assert.deepEqual(searchRequest({ pattern: "x" }), { kind: "search", path: ".", pattern: "x", literal: false, ignoreCase: false, context: 0, maxResults: 100, all: false });
  assert.deepEqual(searchRequest({ pattern: "x", path: "src/", glob: "./*.ts", ignoreCase: true, context: 2, limit: 5, literal: true, all: true }),
    { kind: "search", path: "src", pattern: "x", literal: true, ignoreCase: true, glob: "*.ts", context: 2, maxResults: 5, all: true });
  assert.deepEqual(searchRequest({ pattern: "x", context: 9.7, limit: 9000 }), { kind: "search", path: ".", pattern: "x", literal: false, ignoreCase: false, context: 5, maxResults: 500, all: false },
    "context over 5 and limit over 500 are lowered, not refused");
  assert.deepEqual([searchRequest({ pattern: "x", context: -1, limit: 0 }), searchRequest({ pattern: "x", context: 2.9, limit: 2.5 })].map(({ context, maxResults }) => [context, maxResults]),
    [[0, 1], [2, 2]], "as Pi rounds them");
  assert.throws(() => searchRequest({ pattern: "" }), /pattern must be/);
  assert.throws(() => searchRequest({ pattern: "x".repeat(1001) }), /pattern must be/);
  assert.throws(() => searchRequest({ pattern: "x", limit: "5" }), /limit must be a number/);
  assert.throws(() => searchRequest({ pattern: "x", glob: "a\\b" }), /glob must be/);
  assert.throws(() => searchRequest({ pattern: "x", literal: "yes" }), /literal must be/);
});

test("find: Pi's find arguments become a request: fd's prefix for a path pattern, its smart case, Pi's default limit lowered to Pikibun's most", () => {
  assert.deepEqual(findRequest({ pattern: "*.ts" }), { kind: "find", path: ".", pattern: "*.ts", ignoreCase: true, maxResults: 1000, all: false });
  assert.deepEqual(findRequest({ pattern: "src/**/*.Spec.ts", path: "app/", limit: 9000, all: true }),
    { kind: "find", path: "app", pattern: "**/src/**/*.Spec.ts", ignoreCase: false, maxResults: 5000, all: true });
  assert.equal(findRequest({ pattern: "**/x/*.ts" }).pattern, "**/x/*.ts");
  assert.equal(findRequest({ pattern: "/src/*.ts" }).pattern, "src/*.ts", "a leading / is the searched directory's top");
  assert.equal(findRequest({ pattern: "x", limit: 0 }).maxResults, 1);
  assert.throws(() => findRequest({ pattern: "" }), /pattern must be/);
  assert.throws(() => findRequest({ pattern: "a\\b" }), /pattern must be/);
  assert.throws(() => findRequest({ pattern: "x", limit: "9" }), /limit must be a number/);
});

test("find on an unsandboxed host walks in a worker: names at any depth, paths from where it starts, directories with /", async t => {
  const directory = await mkdtemp(join(tmpdir(), "pikibun-find-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await writeFile(join(directory, "A.TS"), "");
  await writeFile(join(directory, "b.tsx"), "");
  assert.deepEqual(await findInWorker(directory, findRequest({ pattern: "*.{ts,tsx}" })), { paths: ["A.TS", "b.tsx"], truncated: false });
  assert.deepEqual(await findInWorker(directory, findRequest({ pattern: "*.TS" })), { paths: ["A.TS"], truncated: false });
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
  await writeFile(join(directory, "a.ts"), "export const answer = 42;\n");
  assert.deepEqual(await searchInWorker(directory, ".", searchRequest({ pattern: "answer", glob: "*.ts" })),
    { matches: [{ path: "a.ts", line: 1, text: "export const answer = 42;" }], files: 1, truncated: false });
});
