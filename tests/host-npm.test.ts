import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertPrerequisites, npmPrerequisite } from "../apps/runner/src/connect-setup.js";
import { fixes } from "../apps/runner/src/prerequisite-fixes.js";
import { ExtensionSourceError, npmFailure } from "../apps/runner/src/extensions/store.js";
import { loginShellPath, mergePath, parseShellPath, withLoginShellPath } from "../apps/desktop/src/main/shell-path.js";
import { listedPrerequisites } from "../packages/shared/src/host-prerequisites.js";

// Installing extensions needs npm on the host's PATH. A Mac app started from Finder has only launchd's PATH, so the app
// gives its hosts the owner's login-shell PATH, the host lists npm as an optional prerequisite, and a missing npm says so.

test("npm missing from PATH says so and how to get it; other failures keep npm's own output", () => {
  const missing = Object.assign(new Error("spawn npm ENOENT"), { code: "ENOENT" });
  const mac = npmFailure(missing, ["install"], "darwin", "/usr/bin:/bin");
  assert.ok(mac instanceof ExtensionSourceError);
  assert.match(mac.message, /npm, which installs extensions from npm and Git, wasn't found on this host's PATH \(\/usr\/bin:\/bin\)/);
  assert.match(mac.message, /brew install node/);
  assert.match(npmFailure({ code: 1, stderr: "'npm' is not recognized as an internal or external command," }, ["install"], "win32").message, /winget install OpenJS\.NodeJS\.LTS/);
  assert.match(npmFailure({ code: 127, stderr: "" }, ["install"], "linux", "").message, /PATH \(empty\)/);
  assert.match(npmFailure({ code: 127, stderr: "env: node: No such file or directory" }, ["install"], "darwin").message, /wasn't found/,
    "npm without Node.js on PATH counts as missing");
  const failed = npmFailure({ code: 1, stderr: "npm error 404 Not Found - GET https://registry.npmjs.org/nope" }, ["install"], "darwin");
  assert.equal(failed.message, "npm install failed:\nnpm error 404 Not Found - GET https://registry.npmjs.org/nope");
  assert.equal(npmFailure({ code: 1 }, ["install"], "darwin").message, "npm install failed.");
});

test("the login shell's PATH is read from env's own line between the marks, ahead of the app's", async () => {
  const output = "Last login: today\n__PIKIBUN_ENV__\nHOME=/Users/a\nPATH=/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin\nSHELL=/bin/zsh\n__PIKIBUN_ENV__\nbye\n";
  assert.equal(parseShellPath(output), "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin");
  assert.equal(parseShellPath("PATH=/x\n"), undefined, "nothing outside the marks counts");
  assert.equal(parseShellPath("__PIKIBUN_ENV__\nHOME=/a\n__PIKIBUN_ENV__\n"), undefined);
  assert.equal(mergePath("/opt/homebrew/bin:/usr/bin:relative::/bin", "/usr/bin:/bin:/usr/sbin:/sbin"), "/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin");
  assert.deepEqual(await withLoginShellPath({ PATH: "/usr/bin:/bin", HOME: "/h" }, async () => "/opt/homebrew/bin:/usr/bin"), { PATH: "/opt/homebrew/bin:/usr/bin:/bin", HOME: "/h" });
  const unchanged = { PATH: "/usr/bin" };
  assert.equal(await withLoginShellPath(unchanged, async () => undefined), unchanged, "a shell that didn't answer leaves the app's PATH");
  assert.equal(await withLoginShellPath(unchanged, async () => { throw new Error("no"); }), unchanged);
  assert.equal(await loginShellPath("zsh"), undefined, "only a shell named by its absolute path runs");
  assert.equal(await loginShellPath("/nonexistent/shell"), undefined);
});

test("a real login shell answers its PATH", { skip: !existsSync("/bin/bash") && "needs /bin/bash" }, async () => {
  const path = await loginShellPath("/bin/bash");
  assert.ok(path && path.split(":").some(entry => entry === "/bin" || entry === "/usr/bin"), String(path));
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
