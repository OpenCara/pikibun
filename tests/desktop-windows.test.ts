import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { HostInspection } from "../apps/runner/src/desktop-protocol.js";
import { HostController } from "../apps/desktop/src/main/host-controller.js";
import { HostLaunchError, HostProcess, stdioHost } from "../apps/desktop/src/main/host-process.js";
import { parseConnectionCall, parseSandbox } from "../apps/desktop/src/main/requests.js";
import { remoteView } from "../apps/desktop/src/main/remote-view.js";
import { parseSettings, SettingsStore } from "../apps/desktop/src/main/settings.js";
import { chooseDistro, parseWslList, wslCommand, wslHostArgs, wslStateDir } from "../apps/desktop/src/main/wsl.js";

// The Windows app's choice of sandbox for each host, WSL2 or native Windows, and the WSL2 host it runs through wsl.exe:
// everything but wsl.exe itself, which only Windows has.

const repository = fileURLToPath(new URL("../", import.meta.url));

test("WSL's distributions are read from wsl.exe's list, in UTF-16 or UTF-8, whatever the header's language", () => {
  const listing = "  NAME                   STATE           VERSION\r\n* Ubuntu-24.04           Running         2\r\n  Debian                 Stopped         1\r\n  docker-desktop         Running         2\r\n  docker-desktop-data    Stopped         2\r\n";
  const expected = [{ name: "Ubuntu-24.04", version: 2, default: true }, { name: "Debian", version: 1, default: false }];
  assert.deepEqual(parseWslList(listing), expected);
  // wsl.exe without WSL_UTF8 writes UTF-16LE, which reads as text with NULs between the characters.
  assert.deepEqual(parseWslList(`\uFEFF${listing}`.split("").join("\u0000")), expected);
  // A localized header and state, with spaces in it.
  assert.deepEqual(parseWslList("  NAME      ZUSTAND             VERSION\n* Ubuntu    Wird ausgeführt     2\n"), [{ name: "Ubuntu", version: 2, default: true }]);
  // wsl.exe's messages (no distribution yet, WSL not installed) are not distributions.
  assert.deepEqual(parseWslList("Windows Subsystem for Linux has no installed distributions.\nUse 'wsl.exe --list --online' to list available distributions\n"), []);
  assert.deepEqual(parseWslList("* bad;name    Running    2\n"), []);
});

test("a WSL2 host runs in the chosen distribution, else WSL's default WSL2 one, and never on WSL 1", () => {
  const distros = [{ name: "Debian", version: 1, default: true }, { name: "Ubuntu", version: 2, default: false }, { name: "Fedora", version: 2, default: false }];
  assert.deepEqual(chooseDistro({ installed: true, distros }, undefined), { ok: true, name: "Ubuntu" });
  assert.deepEqual(chooseDistro({ installed: true, distros }, "Fedora"), { ok: true, name: "Fedora" });
  assert.match((chooseDistro({ installed: true, distros }, "Debian") as { error: string }).error, /WSL 1.*wsl --set-version Debian 2/);
  assert.match((chooseDistro({ installed: true, distros }, "Arch") as { error: string }).error, /no longer has/);
  assert.match((chooseDistro({ installed: false, distros: [] }, undefined) as { error: string }).error, /wsl --install.*Native Windows/);
  assert.match((chooseDistro({ installed: true, distros: [{ name: "Debian", version: 1, default: true }] }, undefined) as { error: string }).error, /WSL 1/);

  // wsl.exe gets the distribution, the app's connector directory (which --cd translates) and the build, never a secret.
  assert.deepEqual(wslHostArgs({ distro: "Ubuntu", connector: "C:\\Program Files\\Pikibun\\resources\\connector", build: "1.2.3", stateDir: wslStateDir("0123456789ab", false) }),
    ["--distribution", "Ubuntu", "--cd", "C:\\Program Files\\Pikibun\\resources\\connector", "--exec", "/bin/sh", "dist/wsl-host.sh", "1.2.3",
      "--state-dir", "~/.local/share/pikibun/connections/0123456789ab"]);
  assert.deepEqual(wslHostArgs({ distro: "Ubuntu", connector: "C:\\app", build: "1.2.3-dev.17" }).slice(-2), ["dist/wsl-host.sh", "1.2.3-dev.17"]);
  assert.equal(wslStateDir("default", true), undefined, "the primary host uses the CLI's own state in WSL2");
  assert.throws(() => wslHostArgs({ distro: "Ubuntu --exec rm", connector: "C:\\app", build: "1" }));
  assert.throws(() => wslHostArgs({ distro: "Ubuntu", connector: "C:\\app", build: "1; rm -rf ~" }));
  assert.equal(wslCommand("Ubuntu", "https://pikibun.com", undefined, value => value), "wsl -d Ubuntu -- npx pikibun@latest connect --server https://pikibun.com");
});

test("each server's sandbox is saved with it, checked field by field", () => {
  const parsed = parseSettings({ connections: [
    { id: "default", server: "https://pikibun.com", windows: { sandbox: "native" } },
    { id: "0123456789ab", server: "https://a.example", windows: { sandbox: "wsl2", distro: "Ubuntu-24.04" } },
    { id: "abcdefabcdef", server: "https://b.example", windows: { sandbox: "wsl2", distro: "x --exec y" } },
    { id: "fedcba987654", server: "https://c.example", windows: { sandbox: "native", distro: "Ubuntu" } },
    { id: "a1b2c3d4e5f6", server: "https://d.example", windows: { sandbox: "hyper-v" } },
  ] });
  assert.deepEqual(parsed.connections.map(connection => connection.windows), [{ sandbox: "native" }, { sandbox: "wsl2", distro: "Ubuntu-24.04" }, undefined, undefined, undefined]);
  assert.deepEqual(parseSandbox({ sandbox: "wsl2" }), { ok: true, value: { sandbox: "wsl2" } });
  assert.deepEqual(parseSandbox({ sandbox: "native" }), { ok: true, value: { sandbox: "native" } });
  for (const value of [undefined, "native", { sandbox: "wsl2", distro: "" }, { sandbox: "wsl2", extra: 1 }, { sandbox: "wsl1" }]) assert.equal(parseSandbox(value).ok, false, JSON.stringify(value));
  assert.equal(parseConnectionCall({ id: "default", choice: { sandbox: "native" } }, ["choice"]).ok, true);
});

test("a Windows host's sandbox changes only while it is stopped, and native Windows asks the host for its own sandbox", async t => {
  const directory = await mkdtemp(join(tmpdir(), "pikibun-desktop-sandbox-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const settings = new SettingsStore(join(directory, "settings.json"));
  const requests: Record<string, unknown>[] = [];
  let launches = 0;
  let unsupported: string | undefined;
  const host = {
    running: true,
    async request(message: Record<string, unknown>) {
      requests.push(message);
      if (unsupported && message.type === "inspect") return { type: "result", id: 0, ok: false, error: { code: "unsupported", message: unsupported } };
      const inspection: HostInspection = { platform: "win32", stateDir: directory, mode: "sandboxed", sandbox: "windows", prerequisites: [], models: [], pairedServer: settings.server };
      return { type: "result", id: 0, ok: true, ...(message.type === "inspect" ? { inspection } : {}) };
    },
    async shutdown() { launches++; },
  };
  const controller = new HostController({ id: "default", settings, fixtureModels: false, command: server => `connect ${server}`,
    confirmUnsandboxed: async () => false, sandbox: () => settings.connection("default")?.windows ?? { sandbox: "wsl2" } });
  controller.attach(host as unknown as HostProcess);

  assert.deepEqual(controller.view().windows, { sandbox: "wsl2" });
  await controller.refresh();
  assert.equal(requests.at(-1)?.experimentalSandbox, undefined, "a WSL2 host is Linux: bubblewrap is its sandbox");

  // While the host runs, its sandbox stays as it is.
  controller.handleStatus("connected", { server: settings.server, unsandboxed: false, sandbox: "windows", connectorId: "c1" });
  assert.deepEqual(controller.view().running, { server: settings.server, unsandboxed: false, sandbox: "windows", connectorId: "c1" });
  assert.match((await controller.setSandbox({ sandbox: "native" }) as { error: string }).error, /Stop the host first/);
  controller.handleStatus("stopped", {});

  // Stopped: the choice is saved, resuming at launch ends, and the idle host process of the old choice is ended.
  settings.updateConnection("default", { resumeHost: { unsandboxedConsent: true } });
  assert.deepEqual(await controller.setSandbox({ sandbox: "native" }), { ok: true });
  assert.deepEqual(settings.connection("default")?.windows, { sandbox: "native" });
  assert.equal(settings.connection("default")?.resumeHost, undefined);
  assert.equal(launches, 1);
  assert.deepEqual(await controller.setSandbox({ sandbox: "native" }), { ok: true });
  assert.equal(launches, 1, "the same choice changes nothing");
  assert.deepEqual(await controller.start({ replacePairing: false }), { ok: true });
  assert.ok(requests.filter(request => request.type === "inspect").at(-1)?.experimentalSandbox);
  assert.equal(requests.at(-1)?.type, "start");
  assert.equal(requests.at(-1)?.experimentalSandbox, true);
  controller.handleStatus("stopped", {});

  // A host that can't be launched as chosen (no WSL2 here) says what to do, as an inspection would.
  assert.deepEqual(await controller.setSandbox({ sandbox: "wsl2", distro: "Ubuntu" }), { ok: true });
  unsupported = "WSL2 isn't set up on this computer.";
  await controller.refresh();
  assert.equal(controller.view().inspection?.unsupported, unsupported);
  assert.deepEqual(await controller.start({ replacePairing: false }), { ok: false, error: unsupported });

  // A host elsewhere offers no choice.
  const mac = new HostController({ id: "default", settings, fixtureModels: false, command: () => "", confirmUnsandboxed: async () => false });
  assert.equal(mac.view().windows, undefined);
  assert.match((await mac.setSandbox({ sandbox: "native" }) as { error: string }).error, /Only Windows/);
});

test("another server's page sees a host's sandbox, but still not its connector id", () => {
  const view = remoteView({ title: "This Computer", origin: "https://a.example", primaryServer: "https://pikibun.com", defaultServer: "https://pikibun.com", version: "1.0.0",
    local: { enabled: false, mode: "local", status: { state: "stopped", host: "none" }, logs: [] } as never,
    hosts: { title: "This Computer", fixtureModels: false, wsl: { installed: true, distros: [] }, connections: [
      { id: "default", primary: true, server: "https://pikibun.com", state: "connected", inspecting: false, logs: [], command: "", windows: { sandbox: "native" },
        running: { server: "https://pikibun.com", unsandboxed: false, sandbox: "windows", connectorId: "secret-host" } },
    ] } });
  assert.deepEqual(view.hosts.connections[0]?.running, { server: "https://pikibun.com", unsandboxed: false, sandbox: "windows" });
  assert.deepEqual(view.hosts.connections[0]?.windows, { sandbox: "native" });
  assert.deepEqual(view.hosts.wsl, { installed: true, distros: [] });
});

test("the desktop host speaks over stdin and stdout with --stdio, in a state directory under its own home, and ends with its stdin", async t => {
  if (process.platform === "win32") { t.skip("the WSL2 host is Linux"); return; }
  const home = await realpath(await mkdtemp(join(tmpdir(), "pikibun-stdio-host-")));
  t.after(() => rm(home, { recursive: true, force: true }));
  const exits: [number, boolean][] = [];
  const host = new HostProcess({
    launch: () => stdioHost(process.execPath, ["--import", "tsx", join(repository, "apps/runner/src/desktop-host.ts"), "--stdio", "--state-dir", "~/.local/share/pikibun/connections/0123456789ab"],
      { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: home, ...(process.env.TMPDIR ? { TMPDIR: process.env.TMPDIR } : {}) }),
    onEvent: () => {}, onOutput: () => {}, onExit: (code, expected) => exits.push([code, expected]),
  });
  const inspected = await host.request({ type: "inspect", allowFaux: true, experimentalSandbox: true });
  assert.ok(inspected.ok && inspected.inspection);
  assert.equal(inspected.inspection.stateDir, join(home, ".local/share/pikibun/connections/0123456789ab"));
  assert.deepEqual(inspected.inspection.models.map(model => model.provider), ["faux"]);
  // Linux ignores the native-sandbox request: bubblewrap is its sandbox where it is installed.
  if (inspected.inspection.mode === "sandboxed") assert.equal(inspected.inspection.sandbox, "bubblewrap");
  assert.equal(inspected.inspection.unsupported, undefined);
  const refused = await host.request({ type: "stop", extra: true } as never);
  assert.deepEqual(refused.ok ? undefined : refused.error.code, "invalid-request");
  await host.shutdown(10_000);
  assert.deepEqual(exits, [[0, true]]);
});

test("a launcher's setup problem, or one that can't launch at all, is shown as is", async t => {
  if (process.platform === "win32") { t.skip("uses /bin/sh"); return; }
  const setup = new HostProcess({
    launch: () => stdioHost("/bin/sh", ["-c", "echo 'pikibun-setup: Node.js 24 or newer isn'\"'\"'t installed in WSL2 (Ubuntu).' >&2; exit 78"]),
    onEvent: () => {}, onOutput: () => {}, onExit: () => {},
  });
  assert.deepEqual(await setup.request({ type: "inspect" }), { type: "result", id: 0, ok: false, error: { code: "unsupported", message: "Node.js 24 or newer isn't installed in WSL2 (Ubuntu)." } });
  const missing = new HostProcess({ launch: () => { throw new HostLaunchError("WSL2 isn't set up on this computer."); }, onEvent: () => {}, onOutput: () => {}, onExit: () => {} });
  assert.deepEqual(await missing.request({ type: "inspect" }), { type: "result", id: 0, ok: false, error: { code: "unsupported", message: "WSL2 isn't set up on this computer." } });
  const absent = new HostProcess({ launch: () => stdioHost("/nonexistent/wsl.exe", []), onEvent: () => {}, onOutput: () => {}, onExit: () => {} });
  const result = await absent.request({ type: "inspect" });
  assert.ok(!result.ok && result.error.code === "unsupported" && /could not be started/.test(result.error.message));
});

test("wsl-host.sh copies the connector into WSL2's home once per build, finds Node.js, and starts the host with its options", async t => {
  if (process.platform === "win32") { t.skip("uses /bin/sh"); return; }
  const root = await realpath(await mkdtemp(join(tmpdir(), "pikibun-wsl-host-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  // A connector as the app stages it, whose host only reports what it was started with.
  const connector = join(root, "connector");
  mkdirSync(join(connector, "dist", "web"), { recursive: true });
  mkdirSync(join(connector, "node_modules", "dep"), { recursive: true });
  writeFileSync(join(connector, "node_modules", "dep", "index.js"), "");
  writeFileSync(join(connector, "dist", "web", "index.html"), "");
  writeFileSync(join(connector, "dist", "desktop-host.mjs"), "process.stdout.write(JSON.stringify({ argv: process.argv.slice(2), here: import.meta.url }) + \"\\n\");\n");
  writeFileSync(join(connector, "dist", "wsl-host.sh"), readFileSync(join(repository, "apps/desktop/src/wsl/wsl-host.sh")));
  const home = join(root, "home");
  mkdirSync(home);
  // Node.js where wsl.exe's own PATH has it.
  const bin = join(root, "bin");
  mkdirSync(bin);
  writeFileSync(join(bin, "node"), `#!/bin/sh\nexec "${process.execPath}" "$@"\n`);
  chmodSync(join(bin, "node"), 0o755);
  const run = (build: string, ...args: string[]) => spawnSync("/bin/sh", ["dist/wsl-host.sh", build, ...args],
    { cwd: connector, encoding: "utf8", input: "", env: { HOME: home, PATH: `${bin}:/usr/bin:/bin`, WSL_DISTRO_NAME: "Ubuntu" } });

  const first = run("1.2.3", "--state-dir", "~/.local/share/pikibun/connections/0123456789ab");
  assert.equal(first.status, 0, first.stderr);
  const started = JSON.parse(first.stdout) as { argv: string[]; here: string };
  assert.deepEqual(started.argv, ["--stdio", "--state-dir", "~/.local/share/pikibun/connections/0123456789ab"]);
  const copy = join(home, ".local/share/pikibun/desktop/connector-1.2.3");
  assert.equal(started.here, `file://${copy}/dist/desktop-host.mjs`, "the host runs from WSL2's own copy");
  assert.ok(existsSync(join(copy, "node_modules", "dep", "index.js")));
  assert.ok(!existsSync(join(copy, "dist", "web")), "the web app stays behind: Pikibun on this computer runs on Windows");
  assert.match(first.stderr, /Copying Pikibun 1\.2\.3's connector into WSL2/);
  assert.doesNotMatch(run("1.2.3").stderr, /Copying/, "a build is copied once");
  assert.equal(run("1.2.4").status, 0);
  assert.deepEqual(readdirSync(join(home, ".local/share/pikibun/desktop")), ["connector-1.2.4"], "earlier builds' copies go");

  const invalid = run("1.2.3;rm");
  assert.equal(invalid.status, 78);
  assert.match(invalid.stderr, /^pikibun-setup: /m);
  // Without Node.js 24: what to install, and where.
  writeFileSync(join(bin, "node"), "#!/bin/sh\necho 20\n");
  // (This machine's own Node.js in /usr/bin stays out of the script's list for this run.)
  const script = readFileSync(join(connector, "dist", "wsl-host.sh"), "utf8").replace(" /usr/local/bin/node /usr/bin/node; do", "; do");
  assert.ok(!script.includes("/usr/bin/node"));
  writeFileSync(join(root, "no-system-node.sh"), script);
  const old = spawnSync("/bin/sh", [join(root, "no-system-node.sh"), "1.2.4"],
    { cwd: connector, encoding: "utf8", input: "", env: { HOME: home, PATH: `${bin}:/nonexistent`, WSL_DISTRO_NAME: "Ubuntu" } });
  assert.equal(old.status, 78);
  assert.match(old.stderr, /^pikibun-setup: Node\.js 24 or newer isn't installed in WSL2 \(Ubuntu\)/m);
  // The script stays line-feed only, as /bin/sh needs it.
  assert.ok(!readFileSync(join(repository, "apps/desktop/src/wsl/wsl-host.sh"), "utf8").includes("\r"));
});
