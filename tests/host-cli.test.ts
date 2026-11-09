import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { HostProcess, stdioHost } from "../apps/desktop/src/main/host-process.js";

// `pikibun host --stdio`: the host the Native Shell app's This Computer runs (apps/nsh/src/lib/this-computer.ts), the same
// as the Electron app's bundled one, from the published CLI.

const repository = fileURLToPath(new URL("../", import.meta.url));
const cli = join(repository, "packages/cli/src/cli.ts");

test("pikibun host --stdio speaks the desktop host's protocol over stdin and stdout, and ends with its stdin", async t => {
  if (process.platform === "win32") { t.skip("runs a POSIX state directory"); return; }
  const home = await realpath(await mkdtemp(join(tmpdir(), "pikibun-host-cli-")));
  t.after(() => rm(home, { recursive: true, force: true }));
  const exits: [number, boolean][] = [];
  const host = new HostProcess({
    launch: () => stdioHost(process.execPath, ["--import", "tsx", cli, "host", "--stdio", "--state-dir", "~/state"],
      { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: home, ...(process.env.TMPDIR ? { TMPDIR: process.env.TMPDIR } : {}) }),
    onEvent: () => {}, onOutput: () => {}, onExit: (code, expected) => exits.push([code, expected]),
  });
  t.after(() => host.shutdown(10_000));
  const inspected = await host.request({ type: "inspect", allowFaux: true });
  assert.ok(inspected.ok && inspected.inspection);
  assert.equal(inspected.inspection.stateDir, join(home, "state"));
  assert.deepEqual(inspected.inspection.models.map(model => model.provider), ["faux"]);
  assert.equal(inspected.inspection.pairedServer, undefined);
  // Starting without a pairing is refused as the Electron app's host refuses it.
  const start = await host.request({ type: "start", server: "https://pikibun.example", allowFaux: true, unsandboxedConsent: true });
  assert.equal(start.ok ? undefined : start.error.code, "not-paired");
  await host.shutdown(10_000);
  assert.deepEqual(exits, [[0, true]]);
});

test("pikibun host is only for the app: without --stdio it says to run pikibun connect, and --help explains it", () => {
  const run = (...args: string[]) => spawnSync(process.execPath, ["--import", "tsx", cli, ...args], { cwd: repository, encoding: "utf8" });
  const bare = run("host");
  assert.equal(bare.status, 1);
  assert.match(bare.stderr, /run by the Pikibun app, over --stdio\. To connect this computer from a terminal, run "pikibun connect"/);
  const help = run("host", "--help");
  assert.equal(help.status, 0);
  assert.match(help.stdout, /^Usage: pikibun host --stdio/);
  const unknown = run("host", "--stdio", "--bogus");
  assert.equal(unknown.status, 1);
  assert.match(unknown.stderr, /Unknown option/);
  assert.match(run("--help").stdout, /host {8}This computer's host for the Pikibun app/);
});
