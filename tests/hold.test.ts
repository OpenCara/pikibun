import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { holdHandles } from "../apps/runner/src/hold.js";

test("holding a process whose pipes have closed leaves no listener on them, and still holds the ones that are open", async t => {
  const child = spawn(process.execPath, ["-e", "process.stdin.resume(); setInterval(() => {}, 1000)"], { stdio: ["pipe", "pipe", "pipe"] });
  t.after(() => { child.kill("SIGKILL"); });
  const warnings: Error[] = [];
  const warned = (warning: Error) => { warnings.push(warning); };
  process.on("warning", warned);
  t.after(() => { process.off("warning", warned); });
  const timer = setTimeout(() => {}, 60_000);
  t.after(() => clearTimeout(timer));
  const handles = [child, child.stdin, child.stdout, child.stderr, timer, null, undefined];

  child.stdin.end("the request\n");
  if (!child.stdin.destroyed) await once(child.stdin, "close");
  for (let request = 0; request < 20; request++) {
    holdHandles(handles, true);
    holdHandles(handles, false);
  }
  assert.equal(child.stdin.listenerCount("connect"), 0, "a closed pipe is left alone");
  assert.equal(child.stdout.listenerCount("connect"), 0);
  assert.equal(timer.hasRef(), false, "what is still open is let go");
  holdHandles(handles, true);
  assert.equal(timer.hasRef(), true, "and held again");

  child.kill("SIGKILL");
  if (child.exitCode === null && child.signalCode === null) await once(child, "close");
  for (let request = 0; request < 20; request++) {
    holdHandles(handles, true);
    holdHandles(handles, false);
  }
  for (const stream of [child.stdin, child.stdout, child.stderr]) assert.equal(stream.listenerCount("connect"), 0, "nor are the pipes of a process that ended");
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(warnings.filter(warning => warning.name === "MaxListenersExceededWarning"), []);
});
