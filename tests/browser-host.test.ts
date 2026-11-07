import assert from "node:assert/strict";
import { chmod, mkdtemp, readdir, realpath, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { HostBrowserSource, removeBrowserDownloads } from "../apps/runner/src/browser-host.ts";
import { browserUnavailableReason, browserUnavailableText, hostBrowserStatusLimits, legacyBrowserConfig, parseHostBrowserConfig, parseHostBrowserStatus } from "../packages/shared/src/browser.ts";
import { parseHostExtensionsReport } from "../packages/shared/src/host-extensions.ts";

const ELF = Buffer.from([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1, 0, ...Array(56).fill(0)]);

async function temporary(t: TestContext, name: string): Promise<string> {
  const root = await mkdtemp(join(await realpath(tmpdir()), name));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

test("a host finds the Chromium its owner installed, or says how to install one; off is none", async () => {
  let found: { executable: string; directory: string } | undefined;
  const source = new HostBrowserSource({ supported: true, platform: "linux", detect: () => found });
  const missing = await source.apply({ source: "auto" });
  assert.deepEqual([missing.source, missing.state, missing.downloadable], ["auto", "missing", false]);
  assert.match(missing.error!, /sudo apt install chromium/);
  assert.equal(source.current(), undefined);
  // Installed meanwhile: found as the choice is next applied, with no restart.
  found = { executable: "/usr/lib/chromium/chromium", directory: "/usr/lib/chromium" };
  assert.deepEqual(await source.apply({ source: "auto" }), { source: "auto", state: "ready", executable: "/usr/lib/chromium/chromium", downloadable: false });
  assert.deepEqual(source.current(), found);
  assert.deepEqual([await source.apply({ source: "off" }), source.current()], [{ source: "off", state: "off", downloadable: false }, undefined]);
});

test("a host's browser stands as its sandbox allows: none outside the Linux sandbox, and a path that isn't an installation says why", async t => {
  const root = await temporary(t, "browser-host-");
  const unsupported = new HostBrowserSource({ supported: false, detect: () => ({ executable: "/usr/lib/chromium/chromium", directory: "/usr/lib/chromium" }) });
  assert.deepEqual(await unsupported.apply({ source: "auto" }), { source: "auto", state: "unsupported", downloadable: false,
    error: "Sessions on this host have no Linux sandbox, which the browser runs in" });
  assert.equal(unsupported.current(), undefined);
  // A path that isn't a Chromium installation says why, for the host's owner.
  const directory = join(root, "chrome");
  await mkdir(directory);
  await writeFile(join(directory, "chrome"), "#!/bin/sh\nexec chromium \"$@\"\n", { mode: 0o755 });
  await writeFile(join(directory, "icudtl.dat"), "");
  const path = new HostBrowserSource({ supported: true, platform: "linux", home: join(root, "home") });
  assert.match((await path.apply({ source: "path", path: join(directory, "missing") })).error!, /^Nothing is at /);
  assert.match((await path.apply({ source: "path", path: join(directory, "chrome") })).error!, /isn't a program but a script/);
  await writeFile(join(directory, "chrome"), ELF);
  await chmod(join(directory, "chrome"), 0o644);
  assert.match((await path.apply({ source: "path", path: join(directory, "chrome") })).error!, /isn't executable/);
  const home = new HostBrowserSource({ supported: true, platform: "linux", home: directory });
  await chmod(join(directory, "chrome"), 0o755);
  assert.match((await home.apply({ source: "path", path: join(directory, "chrome") })).error!, /home directory/);
  assert.deepEqual(await path.apply({ source: "path", path: join(directory, "chrome") }), { source: "path", state: "ready", executable: join(directory, "chrome"), downloadable: false });
  // However long the path its owner gave, what the connector reports is within what the control plane takes.
  const long = await path.apply({ source: "path", path: `/${"a".repeat(4000)}/chrome` });
  assert.deepEqual([long.state, long.error!.length, long.error!.startsWith("Nothing is at /aaa"), long.error!.endsWith("…")], ["missing", hostBrowserStatusLimits.text, true, true]);
  assert.deepEqual(parseHostBrowserStatus(long), long);
});

test("what older connectors downloaded is removed, and nothing else of their state", async t => {
  const state = await temporary(t, "browser-state-");
  await mkdir(join(state, "browser", "131.0.6778.85", "chrome-headless-shell-linux64"), { recursive: true });
  await writeFile(join(state, "browser", "131.0.6778.85", "chrome-headless-shell-linux64", "chrome-headless-shell"), ELF);
  await writeFile(join(state, "connector.json"), "{}");
  await removeBrowserDownloads(state);
  assert.deepEqual(await readdir(state), ["connector.json"]);
  await removeBrowserDownloads(state);
  assert.deepEqual(await readdir(state), ["connector.json"], "none there is nothing to do");
});

test("a download, chosen before connectors stopped downloading, reads as found on the host, and is never chosen again", () => {
  assert.deepEqual(parseHostBrowserConfig(legacyBrowserConfig({ source: "download" })), { source: "auto" });
  for (const config of [{ source: "auto" }, { source: "off" }, { source: "path", path: "/usr/lib/chromium/chromium" }]) {
    assert.deepEqual(parseHostBrowserConfig(legacyBrowserConfig(config)), config);
  }
  // Only that legacy setting itself: anything more is as invalid as it was.
  assert.throws(() => parseHostBrowserConfig(legacyBrowserConfig({ source: "download", path: "/opt/chrome/chrome" })), /browser/);
  assert.throws(() => parseHostBrowserConfig({ source: "download" }), /The browser comes from auto, path, off/);
});

test("a host's browser status is reported within bounds, and a session's reason to have none is a fixed one", () => {
  const status = { source: "path", state: "missing", error: "Nothing is at /opt/chrome/chrome", downloadable: false };
  assert.deepEqual(parseHostBrowserStatus(status), status);
  const { downloadable: _, ...withoutDownloadable } = status;
  assert.deepEqual(parseHostBrowserStatus(withoutDownloadable), withoutDownloadable, "connectors may leave it out one day");
  assert.deepEqual(parseHostExtensionsReport({ installed: [], remoteInstalls: true, browser: status }), { installed: [], remoteInstalls: true, browser: status });
  assert.deepEqual(parseHostExtensionsReport({ installed: [], remoteInstalls: true }), { installed: [], remoteInstalls: true });
  // Older connectors' download states, as any state the control plane doesn't know: the connector reports without it.
  for (const invalid of [{ ...status, state: "broken" }, { ...status, state: "downloading" }, { ...status, state: "failed" }, { ...status, source: "web" },
    { ...status, source: "download" }, { ...status, downloadable: "yes" }, { ...status, error: "x".repeat(1025) },
    { ...status, executable: 1 }, { ...status, extra: true }, null, []]) {
    assert.throws(() => parseHostBrowserStatus(invalid), /browser status/, JSON.stringify(invalid));
    assert.throws(() => parseHostExtensionsReport({ installed: [], remoteInstalls: true, browser: invalid }));
  }
  assert.deepEqual(["ready", "missing", "off", "unsupported"].map(state => browserUnavailableReason(state as never)), [undefined, "missing", "off", "sandbox"]);
  assert.match(browserUnavailableText("missing"), /no Chromium/);
  assert.match(browserUnavailableText("downloading"), /can't use the browser/, "an older runner's reason reads as any unknown one");
  assert.match(browserUnavailableText("something new"), /can't use the browser/);
});
