import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HostInspection } from "../apps/runner/src/desktop-protocol.js";
import { HostController } from "../apps/desktop/src/main/host-controller.js";
import { connectCommand } from "../apps/desktop/src/main/connect-command.js";
import type { HostProcess } from "../apps/desktop/src/main/host-process.js";
import { parseSandbox } from "../apps/desktop/src/main/requests.js";
import { remoteView } from "../apps/desktop/src/main/remote-view.js";
import { parseSettings, SettingsStore } from "../apps/desktop/src/main/settings.js";

// The Mac app's choice of sandbox for each host: macOS's own Seatbelt sandbox (experimental), or none after consent,
// as Macs ran before they had the choice. Everything but sandbox-exec itself, which only macOS has.

test("a Mac host's sandbox is saved with its server, and only a Mac's choice goes in its place", () => {
  const parsed = parseSettings({ connections: [
    { id: "default", server: "https://pikibun.com", mac: { sandbox: "seatbelt" } },
    { id: "0123456789ab", server: "https://a.example", mac: { sandbox: "none" } },
    { id: "abcdefabcdef", server: "https://b.example", mac: { sandbox: "native" } },
    { id: "fedcba987654", server: "https://c.example", mac: { sandbox: "seatbelt", extra: true } },
    { id: "a1b2c3d4e5f6", server: "https://d.example", windows: { sandbox: "seatbelt" } },
  ] });
  assert.deepEqual(parsed.connections.map(connection => connection.mac), [{ sandbox: "seatbelt" }, { sandbox: "none" }, undefined, undefined, undefined]);
  assert.equal(parsed.connections[4]?.windows, undefined, "a Mac's choice is never a Windows host's");
  assert.deepEqual(parseSandbox({ sandbox: "seatbelt" }), { ok: true, value: { sandbox: "seatbelt" } });
  assert.deepEqual(parseSandbox({ sandbox: "none" }), { ok: true, value: { sandbox: "none" } });
  for (const value of ["seatbelt", { sandbox: "seatbelt", distro: "Ubuntu" }, { sandbox: "sandbox-exec" }]) assert.equal(parseSandbox(value).ok, false, JSON.stringify(value));
});

test("a Mac host runs unsandboxed by default, and in macOS's own sandbox once its owner chooses it while it is stopped", async t => {
  const directory = await mkdtemp(join(tmpdir(), "pikibun-desktop-mac-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const settings = new SettingsStore(join(directory, "settings.json"));
  const requests: Record<string, unknown>[] = [];
  const asked: string[][] = [];
  /** Seatbelt's prerequisites as this Mac has them. */
  let seatbeltReady = true;
  const host = {
    running: true,
    async request(message: Record<string, unknown>) {
      requests.push(message);
      const sandboxed = message.experimentalSandbox === true && seatbeltReady;
      const inspection: HostInspection = { platform: "darwin", stateDir: directory, mode: sandboxed ? "sandboxed" : "unsandboxed",
        ...(sandboxed ? { sandbox: "seatbelt" as const } : { unsandboxedWarning: "Runs directly as you" }),
        ...(message.experimentalSandbox === true ? { sandboxPrerequisites: [{ name: "sandbox-exec", ok: seatbeltReady }] } : {}),
        prerequisites: [], models: [], pairedServer: settings.server };
      return { type: "result", id: 0, ok: true, ...(message.type === "inspect" ? { inspection } : {}) };
    },
    async shutdown() {},
  };
  const controller = new HostController({ id: "default", settings, fixtureModels: false, command: server => `connect ${server}`,
    confirmUnsandboxed: async (_warning, _server, missing) => { asked.push(missing); return true; },
    sandbox: () => settings.connection("default")?.mac ?? { sandbox: "none" } });
  controller.attach(host as unknown as HostProcess);

  // As before: no sandbox, so the start asks for consent and the host isn't asked for Seatbelt.
  assert.deepEqual(controller.view().mac, { sandbox: "none" });
  assert.equal(controller.view().windows, undefined);
  assert.deepEqual(await controller.start({ replacePairing: false }), { ok: true });
  assert.deepEqual(asked, [[]]);
  assert.equal(requests.at(-1)?.type, "start");
  assert.equal(requests.at(-1)?.experimentalSandbox, undefined);
  assert.equal(requests.at(-1)?.unsandboxedConsent, true);

  // While the host runs, its sandbox stays as it is; a Windows choice never applies to a Mac.
  controller.handleStatus("connected", { server: settings.server, unsandboxed: true, connectorId: "c1" });
  assert.match((await controller.setSandbox({ sandbox: "seatbelt" }) as { error: string }).error, /Stop the host first/);
  controller.handleStatus("stopped", {});
  assert.match((await controller.setSandbox({ sandbox: "native" }) as { error: string }).error, /Windows': this computer is a Mac/);
  assert.match(controller.sandboxChoiceRefusal({ sandbox: "wsl2" }) ?? "", /this computer is a Mac/, "a page's change is refused before the owner is asked");
  assert.equal(settings.connection("default")?.windows, undefined);

  // Seatbelt: saved, resuming ends (its consent was for running unsandboxed), and every request asks for Seatbelt.
  assert.deepEqual(settings.connection("default")?.resumeHost, { unsandboxedConsent: true });
  assert.equal(controller.sameSandbox({ sandbox: "seatbelt" }), false);
  assert.deepEqual(await controller.setSandbox({ sandbox: "seatbelt" }), { ok: true });
  assert.equal(controller.sameSandbox({ sandbox: "seatbelt" }), true);
  assert.deepEqual(settings.connection("default")?.mac, { sandbox: "seatbelt" });
  assert.equal(settings.connection("default")?.resumeHost, undefined);
  assert.deepEqual(await controller.start({ replacePairing: false }), { ok: true });
  assert.equal(asked.length, 1, "a sandboxed start needs no consent");
  assert.equal(requests.filter(request => request.type === "inspect").at(-1)?.experimentalSandbox, true);
  assert.equal(requests.at(-1)?.experimentalSandbox, true);
  assert.equal(requests.at(-1)?.unsandboxedConsent, undefined);
  assert.deepEqual(settings.connection("default")?.resumeHost, { unsandboxedConsent: false });
  controller.handleStatus("connected", { server: settings.server, unsandboxed: false, sandbox: "seatbelt", connectorId: "c2" });
  assert.deepEqual(controller.view().running, { server: settings.server, unsandboxed: false, sandbox: "seatbelt", connectorId: "c2" });
  controller.handleStatus("stopped", {});

  // Seatbelt chosen but not ready: the owner is told what is missing before consenting to run without it.
  seatbeltReady = false;
  assert.deepEqual(await controller.start({ replacePairing: false }), { ok: true });
  assert.deepEqual(asked.at(-1), ["sandbox-exec"]);
  assert.equal(requests.at(-1)?.experimentalSandbox, true);
  assert.equal(requests.at(-1)?.unsandboxedConsent, true);
});

test("a Mac host's terminal command names its sandbox, since the CLI on macOS wants one or the other", () => {
  const base = { server: "https://pikibun.com", wslStateDir: undefined, home: "/Users/ada", windows: false };
  assert.equal(connectCommand({ ...base, stateDir: undefined, sandbox: { sandbox: "seatbelt" } }), "npx pikibun@latest connect --server https://pikibun.com --experimental-sandbox");
  assert.equal(connectCommand({ ...base, stateDir: "/Users/ada/.local/share/pikibun/connections/0123456789ab", sandbox: { sandbox: "none" } }),
    "npx pikibun@latest connect --server https://pikibun.com --unsafe-no-sandbox --state-dir ~/.local/share/pikibun/connections/0123456789ab");
});

test("another server's page sees a Mac host's sandbox", () => {
  const view = remoteView({ title: "This Mac", origin: "https://other.example", primaryServer: "https://pikibun.com", defaultServer: "https://pikibun.com",
    hosts: { title: "This Mac", fixtureModels: false, connections: [
      { id: "default", primary: true, server: "https://pikibun.com", state: "connected", inspecting: false, logs: [], command: "", mac: { sandbox: "seatbelt" },
        running: { server: "https://pikibun.com", unsandboxed: false, sandbox: "seatbelt", connectorId: "secret-host" } },
    ] },
    local: { enabled: false, mode: "local", status: { state: "stopped", host: "off" }, logs: [] }, version: "1.0.0" });
  assert.deepEqual(view.hosts.connections[0]?.mac, { sandbox: "seatbelt" });
  assert.deepEqual(view.hosts.connections[0]?.running, { server: "https://pikibun.com", unsandboxed: false, sandbox: "seatbelt" });
});
