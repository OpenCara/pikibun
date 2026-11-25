import assert from "node:assert/strict";
import test from "node:test";
import { sameValue, stableRows } from "../apps/nsh/src/lib/stable-rows.js";

test("sameValue compares plain data deeply", () => {
  assert.equal(sameValue({ a: 1, b: [1, { c: "x" }] }, { a: 1, b: [1, { c: "x" }] }), true);
  assert.equal(sameValue({ a: 1, b: [1, { c: "x" }] }, { a: 1, b: [1, { c: "y" }] }), false);
  assert.equal(sameValue({ a: 1 }, { a: 1, b: undefined }), false);
  assert.equal(sameValue([1, 2], { 0: 1, 1: 2 }), false);
  assert.equal(sameValue(null, {}), false);
  assert.equal(sameValue(Number.NaN, Number.NaN), true);
});

test("stableRows keeps the objects of rows that did not change, so a list diffing by identity keeps their measurements", () => {
  const keep = stableRows<{ key: string; title: string; session?: { status: string } }>();
  const first = keep([{ key: "w", title: "Workspace" }, { key: "a", title: "A", session: { status: "idle" } }, { key: "b", title: "B", session: { status: "idle" } }]);
  const second = keep([{ key: "w", title: "Workspace" }, { key: "a", title: "A", session: { status: "idle" } }, { key: "b", title: "B", session: { status: "running" } }]);
  assert.equal(second[0], first[0]);
  assert.equal(second[1], first[1]);
  assert.notEqual(second[2], first[2]);
  assert.equal(second[2]!.session!.status, "running");
  const third = keep([{ key: "a", title: "A", session: { status: "idle" } }, { key: "b", title: "B", session: { status: "running" } }]);
  assert.equal(third[0], first[1]);
  assert.equal(third[1], second[2]);
  const fourth = keep([{ key: "w", title: "Workspace" }]);
  assert.notEqual(fourth[0], first[0]);
});
