import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HostInspection } from "../apps/runner/src/desktop-protocol.js";
import { resolveAdmins } from "../apps/desktop/src/main/admins.js";
import { HostController } from "../apps/desktop/src/main/host-controller.js";
import type { HostProcess } from "../apps/desktop/src/main/host-process.js";
import { navigationDecision, parseServerOrigin, sameServerLink, windowOpenDecision } from "../apps/desktop/src/main/origin.js";
import { isLocalPage, parseConnectionCall, parseCreateAdmin, parseLocalStartInput, parseModels, parseStartInput } from "../apps/desktop/src/main/requests.js";
import { parseSettings, SettingsStore } from "../apps/desktop/src/main/settings.js";

const pairingId = "1b9d6bcd-bbfd-4b2d-9b5d-ab8dfbbd4bed";
const code = "Z3AQnmLC6x9-xm2HZqXObhdMmKQhqLOKk3ST1ZuBYIw";

test("the configured server is an HTTPS origin, or plain HTTP on localhost and 127.0.0.1 only", () => {
  assert.deepEqual(parseServerOrigin(" https://pikibun.example/ "), { ok: true, origin: "https://pikibun.example" });
  assert.deepEqual(parseServerOrigin("http://127.0.0.1:8789"), { ok: true, origin: "http://127.0.0.1:8789" });
  assert.deepEqual(parseServerOrigin("http://localhost:3000/"), { ok: true, origin: "http://localhost:3000" });
  for (const refused of ["http://pikibun.example", "http://[::1]:8789", "http://constructor/", "http://10.0.0.2", "ftp://pikibun.example",
    "https://pikibun.example/app", "https://pikibun.example/?a=1", "https://pikibun.example/#x", "https://user:pass@pikibun.example", "pikibun.example", ""]) {
    assert.equal(parseServerOrigin(refused).ok, false, refused);
  }
});

test("the Pikibun window stays on its server and GitHub; other web links leave for the browser, anything else goes nowhere", () => {
  const server = "https://pikibun.example";
  assert.equal(navigationDecision("https://pikibun.example/sessions/1", server), "allow");
  assert.equal(navigationDecision("https://github.com/login/oauth/authorize?client_id=x", server), "allow");
  for (const external of ["https://github.com.evil.example/login", "http://github.com/login", "https://gist.github.com/x", "https://pikibun.example.evil/", "http://pikibun.example/", "mailto:a@b.example"]) {
    assert.equal(navigationDecision(external, server), "external", external);
  }
  for (const denied of ["file:///etc/passwd", "javascript:alert(1)", "pikibun-app://local/host.html", "data:text/html,x", "https://user@pikibun.example/", "not a url"]) {
    assert.equal(navigationDecision(denied, server), "deny", denied);
  }
  assert.equal(windowOpenDecision("https://github.com/o/r/pull/1"), "external");
  assert.equal(windowOpenDecision("file:///Applications"), "deny");
  assert.equal(windowOpenDecision("https://a:b@example.com/"), "deny");
  // Links of the window's own server that ask for a window open in another Pikibun window: a session beside the list.
  assert.equal(sameServerLink("https://pikibun.example/w/1/sessions/2", server), true);
  for (const other of ["https://pikibun.example.evil/", "http://pikibun.example/", "https://u@pikibun.example/", "javascript:alert(1)", "not a url"]) {
    assert.equal(sameServerLink(other, server), false, other);
  }
});

test("bridge calls are honored only from the app's own page", () => {
  assert.equal(isLocalPage("pikibun-app://local/host.html", "host.html"), true);
  assert.equal(isLocalPage("pikibun-app://local/host.html?x#y", "host.html"), true);
  assert.equal(isLocalPage("pikibun-app://local/settings.html", "host.html"), false);
  assert.equal(isLocalPage("pikibun-app://other/host.html", "host.html"), false);
  assert.equal(isLocalPage("https://pikibun.example/host.html", "host.html"), false);
  assert.equal(isLocalPage("file:///host.html", "host.html"), false);
});

test("start requests from the page are checked field by field, and a pasted code never passes as a pairing ID", () => {
  assert.deepEqual(parseStartInput({ replacePairing: false }), { ok: true, value: { replacePairing: false } });
  assert.deepEqual(parseStartInput({ pairing: { id: ` ${pairingId} `, code: `${code}\n` }, replacePairing: true }),
    { ok: true, value: { pairing: { id: pairingId, code }, replacePairing: true } });
  const refused = (value: unknown) => { const parsed = parseStartInput(value); assert.equal(parsed.ok, false, JSON.stringify(value)); return parsed.ok ? "" : parsed.error; };
  refused(undefined);
  refused([]);
  refused({ replacePairing: "yes" });
  refused({ replacePairing: false, unsandboxedConsent: true });
  refused({ replacePairing: false, pairing: { id: pairingId, code, server: "https://evil.example" } });
  refused({ replacePairing: false, pairing: { id: pairingId, code: 42 } });
  assert.match(refused({ replacePairing: true }), /new pairing ID and code/);
  assert.match(refused({ replacePairing: false, pairing: { id: code, code } }), /looks like the single-use pairing code/);
  assert.match(refused({ replacePairing: false, pairing: { id: "abc", code } }), /pairing ID/);
  assert.match(refused({ replacePairing: false, pairing: { id: pairingId, code: "" } }), /Enter the single-use pairing code/);
  assert.match(refused({ replacePairing: false, pairing: { id: pairingId, code: "short" } }), /not valid/);
  assert.match(refused({ replacePairing: false, pairing: { id: pairingId, code: "has spaces in it" } }), /not valid/);
});

test("Pikibun on this computer starts with the GitHub OAuth app the page sent, checked, or with the saved one", () => {
  const secret = "0123456789abcdef0123456789abcdef01234567";
  assert.deepEqual(parseLocalStartInput({}), { ok: true, value: { mode: "local" } });
  assert.deepEqual(parseLocalStartInput({ mode: "local", github: { clientId: " ", clientSecret: "" } }), { ok: true, value: { mode: "local" } });
  assert.deepEqual(parseLocalStartInput({ github: { clientId: " Ov23liAbC ", clientSecret: `${secret}\n` } }),
    { ok: true, value: { mode: "local", github: { clientId: "Ov23liAbC", clientSecret: secret } } });
  for (const value of [undefined, [], { github: { clientId: "a" } }, { github: { clientId: "a", clientSecret: "b", extra: 1 } }, { github: {}, port: 1 }]) {
    assert.equal(parseLocalStartInput(value).ok, false, JSON.stringify(value));
  }
  const refused = (value: unknown) => { const parsed = parseLocalStartInput(value); return parsed.ok ? "" : parsed.error; };
  assert.match(refused({ github: { clientId: "has space", clientSecret: secret } }), /client ID/);
  assert.match(refused({ github: { clientId: "Ov23liAbC", clientSecret: "" } }), /client secret/);
});

test("sharing Pikibun from this computer takes a public HTTPS address, administrators by login or user ID, and a checked GitHub app", async () => {
  const secret = "0123456789abcdef0123456789abcdef01234567";
  const shared = { origin: " https://pikibun.example.com/ ", listen: "loopback", trustProxy: true, signup: "invite", passwordAuth: true, admins: [" octocat ", "github:12345", "password:admin", "octocat", ""] };
  assert.deepEqual(parseLocalStartInput({ mode: "shared", shared }), { ok: true, value: { mode: "shared", shared: {
    origin: "https://pikibun.example.com", listen: "loopback", trustProxy: true, signup: "invite", passwordAuth: true, admins: ["octocat", "github:12345", "password:admin"] } } });
  assert.equal(parseLocalStartInput({ mode: "shared", shared: { ...shared, github: { clientId: "Ov23li", clientSecret: secret } } }).ok, true);
  const refused = (value: unknown) => { const parsed = parseLocalStartInput(value); return parsed.ok ? "" : parsed.error; };
  assert.match(refused({ mode: "shared", shared: { ...shared, origin: "http://192.168.1.4:7878" } }), /HTTPS/);
  assert.match(refused({ mode: "shared", shared: { ...shared, origin: "https://pikibun.example.com/app" } }), /HTTPS address/);
  assert.match(refused({ mode: "shared", shared: { ...shared, admins: [] } }), /at least one administrator/);
  assert.match(refused({ mode: "shared", shared: { ...shared, admins: ["not a login!"] } }), /not a GitHub login/);
  assert.match(refused({ mode: "shared", shared: { ...shared, github: { clientId: "has space", clientSecret: secret } } }), /client ID/);
  for (const value of [{ mode: "shared" }, { mode: "shared", shared: { ...shared, listen: "lan" } }, { mode: "shared", shared, github: {} }, { mode: "other" },
    { mode: "shared", shared: { ...shared, signup: "maybe" } }]) {
    assert.equal(parseLocalStartInput(value).ok, false, JSON.stringify(value));
  }

  // GitHub logins become user IDs; user IDs stay; a login GitHub doesn't know, or an unreachable GitHub, stops the start.
  const lookups: string[] = [];
  const lookup = async (login: string) => { lookups.push(login); return login === "octocat" ? 583231 : undefined; };
  assert.deepEqual(await resolveAdmins(["@octocat", "github:12345", "password:admin", "octocat"], lookup), { ok: true, admins: ["github:583231", "github:12345", "password:admin"] });
  assert.deepEqual(lookups, ["octocat", "octocat"]);
  assert.deepEqual(await resolveAdmins(["ghost-account"], lookup), { ok: false, error: "GitHub has no account ghost-account." });
  assert.match((await resolveAdmins(["octocat"], async () => { throw new Error("offline"); }) as { error: string }).error, /github:12345/);

  assert.deepEqual(parseCreateAdmin({ username: " password:Admin ", password: "a long enough password" }), { ok: true, value: { username: "Admin", password: "a long enough password" } });
  for (const value of [{ username: "admin" }, { username: "", password: "x" }, { username: "admin", password: "" }, { username: "admin", password: "x", extra: 1 }]) {
    assert.equal(parseCreateAdmin(value).ok, false, JSON.stringify(value));
  }
});

test("a damaged settings file falls back to defaults field by field, never to an unchecked server", () => {
  const primary = { id: "default", server: "https://pikibun.com" };
  assert.deepEqual(parseSettings(undefined), { connections: [primary] });
  assert.deepEqual(parseSettings({ server: "http://evil.example", windowBounds: { x: 0, y: 0, width: 10, height: 10 }, resumeHost: {} }),
    { connections: [primary] });
  // An older version's single server becomes the primary connection; Git credentials it kept here are dropped.
  assert.deepEqual(parseSettings({ server: "http://127.0.0.1:8789/", gitCredentials: true, windowBounds: { x: 10, y: 20, width: 900, height: 700 }, resumeHost: { unsandboxedConsent: true } }),
    { connections: [{ id: "default", server: "http://127.0.0.1:8789", resumeHost: { unsandboxedConsent: true } }], windowBounds: { x: 10, y: 20, width: 900, height: 700 } });
  assert.deepEqual(parseSettings({ localServer: { unsandboxedConsent: false } }), { connections: [primary], localServer: { unsandboxedConsent: false } });
  assert.deepEqual(parseSettings({ localServer: { unsandboxedConsent: true, mode: "shared" } }), { connections: [primary], localServer: { unsandboxedConsent: true, mode: "shared" } });
  assert.deepEqual(parseSettings({ localServer: true }), { connections: [primary] });
  // Connections: checked one by one, the primary first, no server twice, unknown ids and bad model lists dropped.
  const models = [{ provider: "anthropic", modelId: "claude" }];
  assert.deepEqual(parseSettings({ connections: [
    { id: "0123456789ab", server: "https://team.example/", models, resumeHost: { unsandboxedConsent: false } },
    { id: "default", server: "https://pikibun.example" },
    { id: "../escape", server: "https://other.example" },
    { id: "abcdefabcdef", server: "https://team.example" },
    { id: "abcdef012345", server: "http://lan.example" },
    { id: "fedcba987654", server: "https://models.example", models: [{ provider: "", modelId: "x" }] },
  ] }), { connections: [
    { id: "default", server: "https://pikibun.example" },
    { id: "0123456789ab", server: "https://team.example", resumeHost: { unsandboxedConsent: false }, models },
    { id: "fedcba987654", server: "https://models.example" },
  ] });
  // Without a primary connection, one for the default server comes first.
  assert.deepEqual(parseSettings({ connections: [{ id: "0123456789ab", server: "https://pikibun.com" }, { id: "abcdefabcdef", server: "https://team.example" }] }).connections,
    [primary, { id: "abcdefabcdef", server: "https://team.example" }]);
});

test("servers are added once each, the primary one stays, and host-page calls name a known kind of connection", async t => {
  const directory = await mkdtemp(join(tmpdir(), "pikibun-desktop-connections-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const settings = new SettingsStore(join(directory, "settings.json"));
  assert.deepEqual(settings.addConnection("https://team.example", "0123456789ab"), { ok: true });
  assert.deepEqual(settings.addConnection("https://team.example", "abcdefabcdef"), { ok: false, error: "https://team.example is already in the list." });
  assert.deepEqual(settings.addConnection("https://other.example", "../x"), { ok: false, error: "Invalid connection." });
  settings.updateConnection("0123456789ab", { resumeHost: { unsandboxedConsent: true } });
  settings.updateConnection("0123456789ab", { resumeHost: undefined, models: [{ provider: "p", modelId: "m" }] });
  settings.removeConnection("default");
  assert.deepEqual(new SettingsStore(join(directory, "settings.json")).get().connections,
    [{ id: "default", server: "https://pikibun.com" }, { id: "0123456789ab", server: "https://team.example", models: [{ provider: "p", modelId: "m" }] }]);
  settings.removeConnection("0123456789ab");
  assert.deepEqual(settings.get().connections.map(connection => connection.id), ["default"]);
  for (let index = 1; index < 10; index++) assert.equal(settings.addConnection(`https://s${index}.example`, `${index}`.repeat(12)).ok, true);
  assert.match((settings.addConnection("https://one-more.example", "a".repeat(12)) as { error: string }).error, /at most 10/);

  assert.deepEqual(parseConnectionCall({ id: "default" }), { ok: true, value: { id: "default" } });
  assert.deepEqual(parseConnectionCall({ id: "0123456789ab", models: null }, ["models"]), { ok: true, value: { id: "0123456789ab", models: null } });
  for (const value of [{ id: "../x" }, { id: "default", extra: 1 }, "default", null]) assert.equal(parseConnectionCall(value).ok, false, JSON.stringify(value));
  assert.deepEqual(parseModels(null), { ok: true, value: null });
  assert.deepEqual(parseModels([{ provider: "p", modelId: "m" }, { provider: "p", modelId: "m" }]), { ok: true, value: [{ provider: "p", modelId: "m" }] });
  for (const value of [[], [{ provider: "p" }], [{ provider: "p", modelId: "m", extra: 1 }], "p/m"]) assert.equal(parseModels(value).ok, false, JSON.stringify(value));
});

test("resuming at launch reuses only the consent given at the owner's last start; a failure or the owner's stop ends it", async t => {
  const directory = await mkdtemp(join(tmpdir(), "pikibun-desktop-settings-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const settings = new SettingsStore(join(directory, "settings.json"));
  let mode: HostInspection["mode"] = "unsandboxed";
  // Whether each start the host received carried the owner's unsandboxed consent, and which models it offered.
  const consent: boolean[] = [];
  const offered: unknown[] = [];
  // The host process, answering as the real host does once this computer is paired with the configured server.
  const host = {
    running: true,
    async request(message: { type: string; unsandboxedConsent?: boolean; models?: unknown }) {
      if (message.type === "start") { consent.push(message.unsandboxedConsent === true); offered.push(message.models); }
      const inspection: HostInspection = { platform: "darwin", stateDir: directory, mode, prerequisites: [], models: [],
        pairedServer: settings.server, ...(mode === "unsandboxed" ? { unsandboxedWarning: "Runs directly as you" } : {}) };
      return { type: "result", id: 0, ok: true, ...(message.type === "inspect" ? { inspection } : {}) };
    },
  };
  const asked: string[] = [];
  let accept = false;
  const controller = new HostController({ id: "default", settings, fixtureModels: false, command: server => `connect ${server}`,
    confirmUnsandboxed: async warning => { asked.push(warning); return accept; } });
  controller.attach(host as unknown as HostProcess);
  const resumeHost = () => settings.connection("default")?.resumeHost;

  // The owner's own start shows the CLI's warning, and declining it starts nothing.
  assert.deepEqual(await controller.start({ replacePairing: false }), { ok: false, error: "Unsandboxed mode was not confirmed; nothing was started." });
  accept = true;
  assert.deepEqual(await controller.start({ replacePairing: false }), { ok: true });
  assert.deepEqual(asked, ["Runs directly as you", "Runs directly as you"]);
  assert.deepEqual(consent, [true]);
  assert.deepEqual(resumeHost(), { unsandboxedConsent: true });

  // The next launch starts again without asking; quitting keeps that, a host failure ends it.
  await controller.resume();
  assert.equal(asked.length, 2);
  assert.deepEqual(consent, [true, true]);
  controller.handleExit(0, true);
  assert.deepEqual(resumeHost(), { unsandboxedConsent: true });
  controller.handleExit(1, false);
  assert.equal(resumeHost(), undefined);

  // A start that needed no consent (sandboxed) never covers a later unsandboxed one.
  mode = "sandboxed";
  assert.deepEqual(await controller.start({ replacePairing: false }), { ok: true });
  assert.deepEqual(resumeHost(), { unsandboxedConsent: false });
  mode = "unsandboxed";
  await controller.resume();
  assert.deepEqual(consent, [true, true, false], "nothing more was started");
  assert.equal(asked.length, 2, "and nobody was asked at launch");
  assert.equal(resumeHost(), undefined);

  // Stopping the host ends resuming too.
  assert.deepEqual(await controller.start({ replacePairing: false }), { ok: true });
  assert.deepEqual(resumeHost(), { unsandboxedConsent: true });
  assert.deepEqual(await controller.stop(), { ok: true });
  assert.equal(resumeHost(), undefined);

  // The owner's model choice goes with every start from then on; Pi's own choice is the default.
  assert.deepEqual(offered[0], undefined);
  assert.deepEqual(controller.setModels([{ provider: "p", modelId: "m" }]), { ok: true });
  assert.deepEqual(await controller.start({ replacePairing: false }), { ok: true });
  assert.deepEqual(offered.at(-1), [{ provider: "p", modelId: "m" }]);
  assert.deepEqual(controller.view().models, [{ provider: "p", modelId: "m" }]);
  assert.equal(controller.view().command, "connect https://pikibun.com");
});

test("each server's host has its own resume state: one connection's start and stop leave the others alone", async t => {
  const directory = await mkdtemp(join(tmpdir(), "pikibun-desktop-hosts-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const settings = new SettingsStore(join(directory, "settings.json"));
  settings.addConnection("https://team.example", "0123456789ab");
  const starts: string[] = [];
  const controllers = ["default", "0123456789ab"].map(id => {
    const controller = new HostController({ id, settings, fixtureModels: false, command: server => server, confirmUnsandboxed: async () => true });
    controller.attach({
      running: true,
      async request(message: { type: string; server?: string }) {
        if (message.type === "start") starts.push(message.server!);
        const inspection: HostInspection = { platform: "linux", stateDir: id, mode: "sandboxed", prerequisites: [], models: [], pairedServer: settings.connection(id)!.server };
        return { type: "result", id: 0, ok: true, ...(message.type === "inspect" ? { inspection } : {}) };
      },
    } as unknown as HostProcess);
    return controller;
  });
  const [primary, team] = controllers as [HostController, HostController];
  assert.deepEqual(await team.start({ replacePairing: false }), { ok: true });
  assert.deepEqual(starts, ["https://team.example"]);
  assert.deepEqual(settings.connection("0123456789ab")?.resumeHost, { unsandboxedConsent: false });
  assert.equal(settings.connection("default")?.resumeHost, undefined);
  assert.deepEqual(await primary.stop(), { ok: true });
  assert.deepEqual(settings.connection("0123456789ab")?.resumeHost, { unsandboxedConsent: false });
  assert.equal(team.view().primary, false);
  assert.equal(primary.view().primary, true);
  // A removed server's host keeps its server for its last messages, and starts no more.
  settings.removeConnection("0123456789ab");
  assert.equal(team.server, "https://team.example");
  assert.deepEqual(await team.start({ replacePairing: false }), { ok: false, error: "The host is unavailable." });
});

test("a server's Settings page sees the app's settings, but only its own activity, and never pairs or takes secrets for another", async () => {
  const { remoteView } = await import("../apps/desktop/src/main/remote-view.js");
  const { parsePairHere, parseRemoteLocalStart } = await import("../apps/desktop/src/main/requests.js");
  const log = [{ time: 1, level: "info" as const, message: "Connected." }];
  const connection = (id: string, server: string, primary = false) => ({ id, primary, server, state: "connected" as const, inspecting: false, logs: log, command: "" });
  const hosts = { title: "This Mac", fixtureModels: false, connections: [connection("default", "https://pikibun.com", true), connection("0123456789ab", "https://team.example")] };
  const local = { enabled: true, mode: "local" as const, status: { state: "running" as const, origin: "http://127.0.0.1:7878", host: "connected" as const }, logs: log };
  const base = { title: "This Mac", primaryServer: "https://pikibun.com", defaultServer: "https://pikibun.com", hosts, local };
  const team = remoteView({ ...base, origin: "https://team.example" });
  assert.equal(team.connectionHere, "0123456789ab");
  assert.deepEqual(team.hosts.connections.map(entry => entry.logs.length), [0, 1]);
  assert.equal(team.local.logs.length, 0);
  const own = remoteView({ ...base, origin: "http://127.0.0.1:7878" });
  assert.equal(own.connectionHere, undefined);
  assert.deepEqual([own.hosts.connections.map(entry => entry.logs.length), own.local.logs.length], [[0, 0], 1]);

  assert.deepEqual(parsePairHere({ pairing: { id: pairingId, code }, replacePairing: false }), { ok: true, value: { pairing: { id: pairingId, code }, replacePairing: false } });
  for (const value of [{ replacePairing: false }, { pairing: { id: pairingId, code }, replacePairing: false, id: "0123456789ab" }, { pairing: { id: "x", code }, replacePairing: false }]) {
    assert.equal(parsePairHere(value).ok, false, JSON.stringify(value));
  }
  const secret = { clientId: "Ov23li", clientSecret: "0123456789abcdef0123456789abcdef01234567" };
  const shared = { origin: "https://pikibun.example.com", listen: "loopback", trustProxy: true, signup: "invite", passwordAuth: true, admins: ["octocat"] };
  assert.deepEqual(parseRemoteLocalStart({ mode: "local" }), { ok: true, value: { mode: "local" } });
  assert.equal(parseRemoteLocalStart({ mode: "shared", shared }).ok, true);
  assert.match((parseRemoteLocalStart({ mode: "local", github: secret }) as { error: string }).error, /own Settings window/);
  assert.match((parseRemoteLocalStart({ mode: "shared", shared: { ...shared, github: secret } }) as { error: string }).error, /own Settings window/);
});
