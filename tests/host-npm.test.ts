import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertPrerequisites, npmPrerequisite } from "../apps/runner/src/connect-setup.js";
import { fixes } from "../apps/runner/src/prerequisite-fixes.js";
import { ExtensionSourceError, npmFailure } from "../apps/runner/src/extensions/store.js";
import { listedPrerequisites } from "../packages/shared/src/host-prerequisites.js";

// Installing extensions needs npm on the host's PATH: the host lists npm as an optional prerequisite, and a missing npm
// says so.

test("npm missing from PATH says so and how to get it; other failures keep npm's own output", () => {
  const missing = Object.assign(new Error("spawn npm ENOENT"), { code: "ENOENT" });
  const mac = npmFailure(missing, ["install"], "darwin", "/usr/bin:/bin");
  assert.ok(mac instanceof ExtensionSourceError);
  assert.match(mac.message, /npm, which installs extensions from npm and Git, wasn't found on this host's PATH \(\/usr\/bin:\/bin\)/);
  assert.match(mac.message, /brew install node/);
  assert.match(npmFailure({ code: 1, stderr: "'npm' is not recognized as an internal or external command," }, ["install"], "win32").message, /winget install OpenJS\.NodeJS\.LTS/);
  assert.match(npmFailure({ code: "ENOENT" }, ["install"], "linux", "").message, /PATH \(empty\)/);
  assert.match(npmFailure({ code: 127, stderr: "env: node: No such file or directory" }, ["install"], "darwin").message, /wasn't found/,
    "npm without Node.js on PATH counts as missing");
  assert.match(npmFailure({ code: 127, stderr: "/bin/sh: 1: npm: not found" }, ["install"], "linux").message, /wasn't found/);
  assert.match(npmFailure({ code: 127, stderr: "bash: line 1: npm: command not found" }, ["install"], "linux").message, /wasn't found/);
  const failed = npmFailure({ code: 1, stderr: "npm error 404 Not Found - GET https://registry.npmjs.org/nope" }, ["install"], "darwin");
  assert.equal(failed.message, "npm install failed:\nnpm error 404 Not Found - GET https://registry.npmjs.org/nope");
  assert.equal(npmFailure({ code: 1 }, ["install"], "darwin").message, "npm install failed.");

  // Only npm or node itself missing counts: an install script's missing command, or npm's own 127, keeps npm's output.
  const script = "npm error code 127\nnpm error command failed\nnpm error command sh -c node-gyp rebuild\nnpm error sh: 1: node-gyp: not found";
  assert.equal(npmFailure({ code: 127, stderr: script }, ["install"], "linux").message, `npm install failed:\n${script}`);
  const windowsScript = "npm error 'python' is not recognized as an internal or external command,";
  assert.equal(npmFailure({ code: 1, stderr: windowsScript }, ["install"], "win32").message, `npm install failed:\n${windowsScript}`);
  assert.equal(npmFailure({ code: 127, stderr: "" }, ["install"], "linux").message, "npm install failed.");
  assert.equal(npmFailure({ code: 1, stderr: "npm error sh: npm: command not found" }, ["install"], "linux").message, "npm install failed:\nnpm error sh: npm: command not found",
    "a script's own call to npm isn't the host's npm missing");
});

test("npm is an optional prerequisite: listed with its fix when missing, never keeping a host from starting", async t => {
  const empty = await mkdtemp(join(tmpdir(), "pikibun-no-npm-"));
  t.after(() => rm(empty, { recursive: true, force: true }));
  const missing = npmPrerequisite("darwin", empty);
  assert.deepEqual(missing, { name: "Node.js and npm on PATH, to install extensions from npm or Git", ok: false, optional: true, fix: fixes.node("darwin") });
  assert.equal(missing.fix?.command, "brew install node");
  assert.equal(missing.fix?.action, undefined, "the app runs no installer for it: the owner picks Homebrew or nodejs.org");
  assert.doesNotThrow(() => assertPrerequisites([{ name: "lockf", ok: true }, missing], true, ""));
  assert.throws(() => assertPrerequisites([{ name: "lockf", ok: false }, missing], true, ""), (error: Error) => /lockf/.test(error.message) && !/npm/.test(error.message));
  assert.deepEqual(listedPrerequisites({ prerequisites: [missing] }).map(item => item.entry.optional), [true]);
});
