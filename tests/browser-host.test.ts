import assert from "node:assert/strict";
import { chmod, mkdtemp, readdir, readFile, realpath, rm, stat, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { crc32, deflateRawSync } from "node:zlib";
import { CHROME_FOR_TESTING_VERSIONS, downloadedHeadlessShells, downloadHeadlessShell, extractZip, latestHeadlessShell } from "../apps/runner/src/browser-download.ts";
import { HostBrowserSource } from "../apps/runner/src/browser-host.ts";
import { browserUnavailableReason, browserUnavailableText, hostBrowserStatusLimits, parseHostBrowserStatus } from "../packages/shared/src/browser.ts";
import { parseHostExtensionsReport } from "../packages/shared/src/host-extensions.ts";

const ELF = Buffer.from([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1, 0, ...Array(56).fill(0)]);

interface Entry { name: string; data?: Buffer; mode?: number; deflate?: boolean; crc?: number; flags?: number }

function zip(entries: Entry[]): Buffer {
  const parts: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name);
    const data = entry.data ?? Buffer.alloc(0);
    const body = entry.deflate ? deflateRawSync(data) : data;
    const crc = entry.crc ?? crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(entry.flags ?? 0, 6); local.writeUInt16LE(entry.deflate ? 8 : 0, 8);
    local.writeUInt32LE(crc, 14); local.writeUInt32LE(body.length, 18); local.writeUInt32LE(data.length, 22); local.writeUInt16LE(name.length, 26);
    const header = Buffer.alloc(46);
    header.writeUInt32LE(0x02014b50, 0); header.writeUInt16LE(0x0314, 4); header.writeUInt16LE(20, 6); header.writeUInt16LE(entry.flags ?? 0, 8);
    header.writeUInt16LE(entry.deflate ? 8 : 0, 10); header.writeUInt32LE(crc, 16); header.writeUInt32LE(body.length, 20); header.writeUInt32LE(data.length, 24);
    header.writeUInt16LE(name.length, 28); header.writeUInt32LE(((entry.mode ?? (entry.name.endsWith("/") ? 0o40755 : 0o100644)) << 16) >>> 0, 38); header.writeUInt32LE(offset, 42);
    parts.push(local, name, body);
    central.push(header, name);
    offset += 30 + name.length + body.length;
  }
  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10); end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, directory, end]);
}

const shellZip = (extra: Entry[] = []) => zip([
  { name: "chrome-headless-shell-linux64/" },
  { name: "chrome-headless-shell-linux64/chrome-headless-shell", data: ELF, mode: 0o100755, deflate: true },
  { name: "chrome-headless-shell-linux64/icudtl.dat", data: Buffer.from("icu".repeat(1000)), deflate: true },
  { name: "chrome-headless-shell-linux64/LICENSE.headless_shell", data: Buffer.from("license") },
  ...extra,
]);

const download = (version: string) => `https://storage.googleapis.com/chrome-for-testing-public/${version}/linux64/chrome-headless-shell-linux64.zip`;
const versions = (version: string, url = download(version)) => ({ timestamp: "2026-11-01T00:00:00.000Z", channels: {
  Stable: { channel: "Stable", version, revision: "1", downloads: { chrome: [{ platform: "linux64", url: url.replace(/headless-shell/g, "x") }],
    "chrome-headless-shell": [{ platform: "mac-arm64", url: url.replace("linux64", "mac-arm64") }, { platform: "linux64", url }] } },
  Beta: { channel: "Beta", version: "999.0.0.0", revision: "2", downloads: {} } } });

function chromeForTesting(state: { version: string; zips: Record<string, Buffer>; fail?: boolean; fetched: string[] }): typeof fetch {
  return (async (input: string | URL | Request) => {
    const url = String(input instanceof Request ? input.url : input);
    state.fetched.push(url);
    if (state.fail) throw new TypeError("fetch failed", { cause: Object.assign(new Error("getaddrinfo ENOTFOUND"), { code: "ENOTFOUND" }) });
    if (url === CHROME_FOR_TESTING_VERSIONS) return Response.json(versions(state.version));
    const version = Object.keys(state.zips).find(item => url === download(item));
    return version ? new Response(new Uint8Array(state.zips[version]!), { headers: { "content-length": String(state.zips[version]!.length) } }) : new Response("missing", { status: 404 });
  }) as typeof fetch;
}

async function temporary(t: TestContext, name: string): Promise<string> {
  const root = await mkdtemp(join(await realpath(tmpdir()), name));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

test("a zip is extracted entry by entry: names inside it, regular files and directories, executables kept executable", async t => {
  const root = await temporary(t, "browser-zip-");
  await writeFile(join(root, "shell.zip"), shellZip());
  await extractZip(join(root, "shell.zip"), join(root, "out"));
  const shell = join(root, "out", "chrome-headless-shell-linux64");
  assert.deepEqual((await readdir(shell)).sort(), ["LICENSE.headless_shell", "chrome-headless-shell", "icudtl.dat"]);
  assert.deepEqual(await readFile(join(shell, "chrome-headless-shell")), ELF);
  assert.equal((await stat(join(shell, "chrome-headless-shell"))).mode & 0o777, 0o755);
  assert.equal((await stat(join(shell, "icudtl.dat"))).mode & 0o777, 0o644);
  assert.equal(await readFile(join(shell, "icudtl.dat"), "utf8"), "icu".repeat(1000));

  for (const [entries, error] of [
    [[{ name: "../escape", data: Buffer.from("x") }], /may not/],
    [[{ name: "/etc/escape", data: Buffer.from("x") }], /may not/],
    [[{ name: "a/../../escape", data: Buffer.from("x") }], /may not/],
    [[{ name: "a\\b", data: Buffer.from("x") }], /may not/],
    [[{ name: "link", data: Buffer.from("/etc/passwd"), mode: 0o120777 }], /link or special file/],
    [[{ name: "fifo", mode: 0o010644 }], /link or special file/],
    [[{ name: "file", data: Buffer.from("x"), crc: 1 }], /checksum/],
    [[{ name: "file", data: Buffer.from("x"), deflate: true, crc: 1 }], /checksum/],
    [[{ name: "file", data: Buffer.from("x"), flags: 1 }], /Encrypted/],
  ] as const) {
    const file = join(root, "bad.zip");
    await writeFile(file, zip(entries as unknown as Entry[]));
    await rm(join(root, "bad"), { recursive: true, force: true });
    await assert.rejects(extractZip(file, join(root, "bad")), error, JSON.stringify(entries));
    await assert.rejects(stat(join(root, "escape")));
  }
  await writeFile(join(root, "bad.zip"), "not a zip");
  await assert.rejects(extractZip(join(root, "bad.zip"), join(root, "bad")), /Not a zip/);
});

test("Chrome for Testing's Stable headless shell for Linux is taken from Google's download host only", async () => {
  const state = { version: "131.0.6778.85", zips: {}, fetched: [] as string[] };
  assert.deepEqual(await latestHeadlessShell({ fetch: chromeForTesting(state) }), { version: "131.0.6778.85", url: download("131.0.6778.85") });
  for (const [body, error] of [
    [versions("131.0.6778.85", "https://example.com/131.0.6778.85/linux64/chrome-headless-shell-linux64.zip"), /isn't where its builds are/],
    [versions("131.0.6778.85", download("130.0.0.0")), /isn't where its builds are/],
    [versions("131; rm -rf /"), /no Stable headless shell/],
    [{ channels: {} }, /no Stable headless shell/],
  ] as const) {
    await assert.rejects(latestHeadlessShell({ fetch: (async () => Response.json(body)) as typeof fetch }), error);
  }
  await assert.rejects(latestHeadlessShell({ fetch: (async () => new Response("down", { status: 503 })) as typeof fetch }), /answered 503/);
});

test("a downloaded headless shell is moved into place only whole, and found again without downloading it twice", async t => {
  const root = await temporary(t, "browser-download-");
  const state = { version: "131.0.6778.85", zips: { "131.0.6778.85": shellZip(), "132.0.0.1": zip([{ name: "README", data: Buffer.from("no shell") }]) }, fetched: [] as string[] };
  const fetch = chromeForTesting(state);
  const browser = await downloadHeadlessShell(root, { version: "131.0.6778.85", url: download("131.0.6778.85") }, { fetch });
  assert.deepEqual(browser, { executable: join(root, "131.0.6778.85", "chrome-headless-shell-linux64", "chrome-headless-shell"), directory: join(root, "131.0.6778.85", "chrome-headless-shell-linux64") });
  assert.deepEqual(await readdir(root), ["131.0.6778.85"], "neither the zip nor a partial extraction is left");
  state.fetched.length = 0;
  assert.deepEqual(await downloadHeadlessShell(root, { version: "131.0.6778.85", url: download("131.0.6778.85") }, { fetch }), browser);
  assert.deepEqual(state.fetched, []);
  await assert.rejects(downloadHeadlessShell(root, { version: "132.0.0.1", url: download("132.0.0.1") }, { fetch }), /holds no headless shell/);
  await assert.rejects(downloadHeadlessShell(root, { version: "133.0.0.1", url: download("133.0.0.1") }, { fetch }), /answered 404/);
  await assert.rejects(downloadHeadlessShell(root, { version: "133.0.0.1", url: "https://example.com/shell.zip" }, { fetch }), /Not a Chrome for Testing build/);
  assert.deepEqual(await readdir(root), ["131.0.6778.85"]);
  assert.deepEqual((await downloadedHeadlessShells(root)).map(item => item.version), ["131.0.6778.85"]);
});

test("a host set to download Chromium downloads it in the background, keeps it up to date, and tries a failed download again later", async t => {
  const root = await temporary(t, "browser-host-");
  let now = 1_000_000;
  const state = { version: "131.0.6778.85", zips: { "131.0.6778.85": shellZip(), "132.0.6834.83": shellZip() } as Record<string, Buffer>, fail: true, fetched: [] as string[] };
  const source = new HostBrowserSource({ root, supported: true, platform: "linux", arch: "x64", detect: () => undefined, fetch: chromeForTesting(state), now: () => now });
  assert.deepEqual(await source.apply({ source: "download" }), { source: "download", state: "downloading", downloadable: true });
  await source.settled();
  assert.deepEqual(source.status(), { source: "download", state: "failed", downloadable: true, error: "Couldn't reach googlechromelabs.github.io for Chrome for Testing's versions (ENOTFOUND)" });
  assert.equal(source.current(), undefined);
  state.fail = false;
  now += 60_000;
  assert.equal((await source.apply({ source: "download" })).state, "failed");
  now += 10 * 60_000;
  assert.deepEqual(await source.apply({ source: "download" }), { source: "download", state: "downloading", downloadable: true, error: "Couldn't reach googlechromelabs.github.io for Chrome for Testing's versions (ENOTFOUND)" });
  await source.settled();
  const executable = join(root, "131.0.6778.85", "chrome-headless-shell-linux64", "chrome-headless-shell");
  assert.deepEqual(source.status(), { source: "download", state: "ready", version: "131.0.6778.85", executable, downloadable: true });
  assert.equal(source.current()?.executable, executable);
  state.version = "132.0.6834.83";
  state.fetched.length = 0;
  assert.equal((await source.apply({ source: "download" })).version, "131.0.6778.85");
  assert.deepEqual(state.fetched, [], "not before a day");
  now += 24 * 3600_000;
  assert.equal((await source.apply({ source: "download" })).version, "131.0.6778.85", "the one there stays in use while the next downloads");
  await source.settled();
  assert.equal(source.status().version, "132.0.6834.83");
  assert.equal(source.current()?.executable, join(root, "132.0.6834.83", "chrome-headless-shell-linux64", "chrome-headless-shell"));
  assert.deepEqual((await readdir(root)).sort(), ["131.0.6778.85", "132.0.6834.83"]);
  assert.ok((await stat(executable)).isFile());
  state.version = "133.0.0.1";
  now += 24 * 3600_000;
  await source.apply({ source: "download" });
  await source.settled();
  assert.deepEqual([source.status().state, source.status().version], ["ready", "132.0.6834.83"]);
  assert.deepEqual(await readdir(root), ["132.0.6834.83"]);
  assert.deepEqual(await source.apply({ source: "auto" }), { source: "auto", state: "ready", version: "132.0.6834.83",
    executable: join(root, "132.0.6834.83", "chrome-headless-shell-linux64", "chrome-headless-shell"), downloadable: true });
  assert.deepEqual([await source.apply({ source: "off" }), source.current()], [{ source: "off", state: "off", downloadable: true }, undefined]);
});

test("a host's browser stands as its sandbox and platform allow: none outside the Linux sandbox, no download but on x86-64", async t => {
  const root = await temporary(t, "browser-host-");
  const unsupported = new HostBrowserSource({ root, supported: false, detect: () => ({ executable: "/usr/lib/chromium/chromium", directory: "/usr/lib/chromium" }) });
  assert.deepEqual(await unsupported.apply({ source: "auto" }), { source: "auto", state: "unsupported", downloadable: false,
    error: "Sessions on this host have no Linux sandbox, which the browser runs in" });
  assert.equal(unsupported.current(), undefined);
  const arm = new HostBrowserSource({ root, supported: true, platform: "linux", arch: "arm64", detect: () => undefined, fetch: (async () => { throw new Error("no fetch"); }) as typeof fetch });
  const status = await arm.apply({ source: "download" });
  assert.deepEqual([status.state, status.downloadable], ["missing", false]);
  assert.match(status.error!, /x86-64 only/);
  const directory = join(root, "chrome");
  await mkdir(directory);
  await writeFile(join(directory, "chrome"), "#!/bin/sh\nexec chromium \"$@\"\n", { mode: 0o755 });
  await writeFile(join(directory, "icudtl.dat"), "");
  const path = new HostBrowserSource({ root, supported: true, platform: "linux", arch: "x64", home: join(root, "home") });
  assert.match((await path.apply({ source: "path", path: join(directory, "missing") })).error!, /^Nothing is at /);
  assert.match((await path.apply({ source: "path", path: join(directory, "chrome") })).error!, /isn't a program but a script/);
  await writeFile(join(directory, "chrome"), ELF);
  await chmod(join(directory, "chrome"), 0o644);
  assert.match((await path.apply({ source: "path", path: join(directory, "chrome") })).error!, /isn't executable/);
  const home = new HostBrowserSource({ root, supported: true, platform: "linux", arch: "x64", home: directory });
  await chmod(join(directory, "chrome"), 0o755);
  assert.match((await home.apply({ source: "path", path: join(directory, "chrome") })).error!, /home directory/);
  assert.deepEqual(await path.apply({ source: "path", path: join(directory, "chrome") }), { source: "path", state: "ready", executable: join(directory, "chrome"), downloadable: true });
  const long = await path.apply({ source: "path", path: `/${"a".repeat(4000)}/chrome` });
  assert.deepEqual([long.state, long.error!.length, long.error!.startsWith("Nothing is at /aaa"), long.error!.endsWith("…")], ["missing", hostBrowserStatusLimits.text, true, true]);
  assert.deepEqual(parseHostBrowserStatus(long), long);
});

test("a host's browser status is reported within bounds, and a session's reason to have none is a fixed one", () => {
  const status = { source: "download", state: "failed", error: "fetch failed", downloadable: true };
  assert.deepEqual(parseHostBrowserStatus(status), status);
  assert.deepEqual(parseHostExtensionsReport({ installed: [], remoteInstalls: true, browser: status }), { installed: [], remoteInstalls: true, browser: status });
  assert.deepEqual(parseHostExtensionsReport({ installed: [], remoteInstalls: true }), { installed: [], remoteInstalls: true });
  for (const invalid of [{ ...status, state: "broken" }, { ...status, source: "web" }, { ...status, downloadable: "yes" }, { ...status, error: "x".repeat(1025) },
    { ...status, executable: 1 }, { ...status, extra: true }, null, []]) {
    assert.throws(() => parseHostBrowserStatus(invalid), /browser status/, JSON.stringify(invalid));
    assert.throws(() => parseHostExtensionsReport({ installed: [], remoteInstalls: true, browser: invalid }));
  }
  assert.deepEqual(["ready", "missing", "downloading", "failed", "off", "unsupported"].map(state => browserUnavailableReason(state as never)),
    [undefined, "missing", "downloading", "failed", "off", "sandbox"]);
  assert.match(browserUnavailableText("missing"), /no Chromium/);
  assert.match(browserUnavailableText("something new"), /can't use the browser/);
});
