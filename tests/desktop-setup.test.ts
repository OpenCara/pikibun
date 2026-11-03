import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AuthInteraction } from "@earendil-works/pi-ai";
import type { HostInspection, LoginEvent } from "../apps/runner/src/desktop-protocol.js";
import { aptFix, fixes } from "../apps/runner/src/prerequisite-fixes.js";
import { LoginError, LoginSession, loginEvent, loginFailure, loginProviders, runLogin, type LoginRuntime } from "../apps/runner/src/pi-login.js";
import { HostController } from "../apps/desktop/src/main/host-controller.js";
import type { HostProcess } from "../apps/desktop/src/main/host-process.js";
import { remoteView } from "../apps/desktop/src/main/remote-view.js";
import { SettingsStore } from "../apps/desktop/src/main/settings.js";
import { parseSetupAction, setupPlan } from "../apps/desktop/src/main/setup-actions.js";
import { listedPrerequisites } from "../packages/shared/src/host-prerequisites.js";
import { NVM_INSTALL } from "../apps/desktop/src/main/wsl.js";

// Getting a computer ready to host from the desktop app: each missing prerequisite's fix, what the app runs for it, and
// signing Pi in to a provider through Pi's own sign-in, so no separate Pi install or terminal is needed.

test("a fix's action is one the app knows, apt naming only the sandbox's packages", () => {
  for (const kind of ["xcode-tools", "git-for-windows", "mxc-sdk", "windows-update", "wsl-install", "wsl-node"]) assert.deepEqual(parseSetupAction({ kind }), { kind });
  assert.deepEqual(parseSetupAction({ kind: "apt", packages: ["bubblewrap", "git", "git"] }), { kind: "apt", packages: ["bubblewrap", "git"] });
  for (const value of [undefined, "xcode-tools", { kind: "xcode-tools", extra: 1 }, { kind: "brew" }, { kind: "apt", packages: [] },
    { kind: "apt", packages: ["curl"] }, { kind: "apt", packages: ["git; rm -rf /"] }, { kind: "apt" }]) {
    assert.equal(parseSetupAction(value), undefined, JSON.stringify(value));
  }
});

test("each action runs where its owner sees it, on its own platform only, from a fixed command", () => {
  const mac = setupPlan({ kind: "xcode-tools" }, { platform: "darwin" });
  assert.ok(!("error" in mac));
  assert.deepEqual(mac.step, { type: "run", file: "/usr/bin/xcode-select", args: ["--install"], console: false });
  assert.ok("error" in setupPlan({ kind: "xcode-tools" }, { platform: "win32" }));
  assert.ok("error" in setupPlan({ kind: "git-for-windows" }, { platform: "darwin" }));

  const git = setupPlan({ kind: "git-for-windows" }, { platform: "win32" });
  assert.ok(!("error" in git) && git.step.type === "run");
  assert.equal(git.step.file, "powershell.exe");
  assert.equal(git.step.console, true);
  assert.match(git.step.args.at(-1)!, /^winget install --id Git\.Git -e --source winget/);
  assert.ok(git.step.args.includes("-NoExit"), "the window stays open with its output");

  const update = setupPlan({ kind: "windows-update" }, { platform: "win32" });
  assert.ok(!("error" in update));
  assert.deepEqual(update.step, { type: "open", url: "ms-settings:windowsupdate" });

  // Paths and distributions are quoted for PowerShell, and no double quote reaches its command line.
  const mxc = setupPlan({ kind: "mxc-sdk" }, { platform: "win32", mxcRuntime: "C:\\Users\\O'Brien\\.local\\share\\pikibun\\connector\\mxc" });
  assert.ok(!("error" in mxc) && mxc.step.type === "run");
  assert.match(mxc.step.args.at(-1)!, /^npm install --prefix 'C:\\Users\\O''Brien\\.local\\share\\pikibun\\connector\\mxc' @microsoft\/mxc-sdk@1\.0\.1;/);
  assert.ok("error" in setupPlan({ kind: "mxc-sdk" }, { platform: "win32" }));

  const apt = setupPlan({ kind: "apt", packages: ["bubblewrap", "util-linux"] }, { platform: "win32", distro: "Ubuntu-24.04" });
  assert.ok(!("error" in apt) && apt.step.type === "run");
  assert.match(apt.step.args.at(-1)!, /^wsl\.exe --distribution 'Ubuntu-24\.04' --exec bash -lc 'sudo apt-get update && sudo apt-get install -y bubblewrap util-linux';/);
  assert.ok("error" in setupPlan({ kind: "apt", packages: ["git"] }, { platform: "win32" }), "a WSL2 action needs the host's distribution");
  assert.ok("error" in setupPlan({ kind: "apt", packages: ["git"] }, { platform: "linux", distro: "Ubuntu" }), "Linux shows the command instead");

  const node = setupPlan({ kind: "wsl-node" }, { platform: "win32", distro: "Ubuntu" });
  assert.ok(!("error" in node) && node.step.type === "run");
  assert.ok(node.step.args.at(-1)!.includes(`bash -lc '${NVM_INSTALL}'`));
  assert.throws(() => setupPlan({ kind: "wsl-node" }, { platform: "win32", distro: "Ubuntu --exec rm" }));
  for (const plan of [git, mxc, apt, node]) assert.ok(!("error" in plan) && plan.step.type === "run" && !plan.step.args.some(arg => arg.includes("\"")));
});

test("missing Linux packages share one fix, with apt where the system has it", () => {
  assert.deepEqual(aptFix(["bubblewrap", "git", "bubblewrap"], true), { text: "Install bubblewrap, git with apt.", command: "sudo apt install bubblewrap git", action: { kind: "apt", packages: ["bubblewrap", "git"] } });
  assert.deepEqual(aptFix(["bubblewrap"], false), { text: "Install bubblewrap with this system's package manager." });
  assert.deepEqual(fixes.xcodeTools.action, { kind: "xcode-tools" });
  assert.match(fixes.mxcSdk("C:\\mxc").command!, /npm install --prefix "C:\\mxc" @microsoft\/mxc-sdk@1\.0\.1/);
});

function fakeHost(inspection: () => HostInspection, providers: () => string | undefined = () => undefined) {
  const requests: Record<string, unknown>[] = [];
  let nextId = 1;
  const pending: { message: Record<string, unknown>; resolve: (value: unknown) => void }[] = [];
  const host = {
    running: true,
    async request(message: Record<string, unknown>, sent?: (id: number) => void) {
      requests.push(message);
      const id = nextId++;
      sent?.(id);
      if (message.type === "inspect") return { type: "result", id, ok: true, inspection: inspection() };
      if (message.type === "providers" && providers()) return { type: "result", id, ok: false, error: { code: "unsupported", message: providers() } };
      if (message.type === "providers") return { type: "result", id, ok: true, providers: [{ id: "anthropic", name: "Anthropic", signedIn: false, methods: [{ type: "oauth", name: "Anthropic (Claude Pro/Max)", subscription: true }] }] };
      if (message.type === "login") return new Promise(resolve => pending.push({ message, resolve }));
      return { type: "result", id, ok: true };
    },
    async shutdown() {},
  };
  return { host: host as unknown as HostProcess, requests, pending };
}

test("the app does only the setup the host's latest inspection offers, after its owner confirms", async t => {
  const directory = await mkdtemp(join(tmpdir(), "pikibun-desktop-setup-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const settings = new SettingsStore(join(directory, "settings.json"));
  const ran: unknown[] = [];
  let confirmed = true;
  const { host } = fakeHost(() => ({ platform: "darwin", stateDir: directory, mode: "unsandboxed", models: [],
    prerequisites: [{ name: "Git on PATH", ok: false, fix: fixes.xcodeTools }, { name: "lockf", ok: true, fix: { text: "never shown", action: { kind: "wsl-install" } } }] }));
  const controller = new HostController({ id: "default", settings, fixtureModels: false, command: () => "", confirmUnsandboxed: async () => false,
    runSetup: async action => { ran.push(action); return confirmed ? { ok: true } : { ok: false, error: "Not started." }; } });
  controller.attach(host);
  assert.match((await controller.setup({ kind: "xcode-tools" }) as { error: string }).error, /Refresh/, "nothing offered before an inspection");
  await controller.refresh();
  assert.deepEqual(await controller.setup({ kind: "xcode-tools" }), { ok: true });
  assert.match(controller.view().logs.at(-1)!.message, /choose Refresh/);
  assert.match((await controller.setup({ kind: "wsl-install" }) as { error: string }).error, /doesn't need that/, "a present prerequisite's fix isn't offered");
  confirmed = false;
  assert.deepEqual(await controller.setup({ kind: "xcode-tools" }), { ok: false, error: "Not started." });
  assert.deepEqual(ran, [{ kind: "xcode-tools" }, { kind: "xcode-tools" }]);
  // Links open only when the host offered them.
  assert.equal(controller.knownLink("https://git-scm.com/download/win"), false);
  assert.equal(controller.knownLink("https://evil.example/"), false);

  // Where the app can't do it (apt on Linux opens no terminal), the fix shows only how, and nothing runs.
  const linux = new HostController({ id: "default", settings, fixtureModels: false, command: () => "", confirmUnsandboxed: async () => false,
    runSetup: async action => { ran.push(action); return { ok: true }; }, canSetup: action => action.kind !== "apt" });
  linux.attach(fakeHost(() => ({ platform: "linux", stateDir: directory, mode: "unsandboxed", models: [],
    prerequisites: [{ name: "bubblewrap", ok: false, fix: aptFix(["bubblewrap"], true) }] })).host);
  await linux.refresh();
  assert.deepEqual(linux.view().inspection?.prerequisites[0]?.fix, { text: "Install bubblewrap with apt.", command: "sudo apt install bubblewrap" });
  assert.match((await linux.setup({ kind: "apt", packages: ["bubblewrap"] }) as { error: string }).error, /doesn't need that/);
  assert.equal(ran.length, 2);
});

test("Pi signs in to a provider from the app: the page opens in the browser, questions wait for answers, and the models are read again", async t => {
  const directory = await mkdtemp(join(tmpdir(), "pikibun-desktop-signin-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const settings = new SettingsStore(join(directory, "settings.json"));
  let models: HostInspection["models"] = [];
  const { host, requests, pending } = fakeHost(() => ({ platform: "darwin", stateDir: directory, mode: "unsandboxed", prerequisites: [], models,
    ...(models.length ? {} : { modelsError: "No authenticated local Pi models are configured." }) }));
  const opened: string[] = [];
  const controller = new HostController({ id: "default", settings, fixtureModels: false, command: () => "", confirmUnsandboxed: async () => false, openBrowser: url => opened.push(url) });
  controller.attach(host);

  assert.deepEqual(await controller.loadProviders(), { ok: true });
  assert.equal(controller.view().providers?.[0]?.name, "Anthropic");
  const signedIn = controller.startSignIn("anthropic", "oauth");
  await Promise.resolve();
  const login = requests.findIndex(request => request.type === "login") + 1;
  assert.deepEqual(controller.view().signIn, { provider: "anthropic", name: "Anthropic", method: "oauth", state: "running", notices: [] });
  assert.match((await controller.startSignIn("anthropic", "oauth") as { error: string }).error, /under way/);

  // Another sign-in's events are ignored; this one's page opens by itself, a loopback one never does.
  controller.handleLogin(login + 100, { kind: "progress", message: "stale" });
  controller.handleLogin(login, { kind: "auth-url", url: "https://claude.ai/oauth/authorize?state=1" });
  controller.handleLogin(login, { kind: "info", message: "See", links: [{ url: "http://127.0.0.1:1455/x" }] });
  assert.deepEqual(opened, ["https://claude.ai/oauth/authorize?state=1"]);
  assert.equal(controller.knownLink("https://claude.ai/oauth/authorize?state=1"), true);
  assert.equal(controller.knownLink("http://127.0.0.1:1455/x"), false);
  assert.equal(controller.view().signIn?.notices.length, 2);

  controller.handleLogin(login, { kind: "prompt", prompt: 1, detail: { type: "select", message: "How?", options: [{ id: "browser", label: "Browser" }] } });
  assert.match((await controller.answerSignIn(1, "other") as { error: string }).error, /Choose one/);
  assert.deepEqual(await controller.answerSignIn(1, "browser"), { ok: true });
  assert.deepEqual(requests.at(-1), { type: "login-answer", login, prompt: 1, value: "browser" });
  assert.match((await controller.answerSignIn(1, "browser") as { error: string }).error, /answered or has closed/);
  controller.handleLogin(login, { kind: "prompt", prompt: 2, detail: { type: "secret", message: "API key" } });
  controller.handleLogin(login, { kind: "prompt-closed", prompt: 2 });
  assert.equal(controller.view().signIn?.prompt, undefined, "a question the browser answered first goes away");
  await controller.cancelSignIn();
  assert.deepEqual(requests.at(-1), { type: "login-cancel", login });

  // Done: providers and models are read again.
  models = [{ provider: "anthropic", modelId: "claude", name: "Claude" }];
  pending[0]!.resolve({ type: "result", id: login, ok: true });
  assert.deepEqual(await signedIn, { ok: true });
  assert.equal(controller.view().signIn?.state, "done");
  assert.deepEqual(controller.view().inspection?.models, models);
  assert.match(controller.view().logs.at(-1)!.message, /signed in to Anthropic/);

  // A failed one says why; a cancelled one only that it was.
  const failing = controller.startSignIn("anthropic", "oauth");
  await Promise.resolve();
  pending[1]!.resolve({ type: "result", id: 0, ok: false, error: { code: "failed", message: "Sign-in failed: denied" } });
  await failing;
  assert.deepEqual([controller.view().signIn?.state, controller.view().signIn?.error], ["failed", "Sign-in failed: denied"]);
  const cancelled = controller.startSignIn("anthropic", "oauth");
  await Promise.resolve();
  pending[2]!.resolve({ type: "result", id: 0, ok: false, error: { code: "cancelled", message: "Sign-in cancelled." } });
  await cancelled;
  assert.deepEqual([controller.view().signIn?.state, controller.view().signIn?.error], ["cancelled", undefined]);

  // Servers' pages never see a sign-in.
  const page = remoteView({ title: "This Mac", origin: settings.server, primaryServer: settings.server, defaultServer: settings.server, version: "1.0.0",
    hosts: { title: "This Mac", fixtureModels: false, connections: [controller.view()] }, local: { enabled: false, mode: "local", status: { state: "stopped", host: "off" }, logs: [] } });
  assert.equal(page.hosts.connections[0]?.signIn, undefined);
  assert.equal(page.hosts.connections[0]?.providers?.[0]?.id, "anthropic");
});

/** A Pi runtime with one OAuth provider whose sign-in asks two questions, and one ambient-only provider. */
function fakeRuntime(login: (interaction: AuthInteraction) => Promise<void>): LoginRuntime & { saved: string[] } {
  const saved: string[] = [];
  return {
    saved,
    getProviders: () => [
      { id: "openai-codex", name: "OpenAI\u0007 (ChatGPT)", auth: { oauth: { name: "ChatGPT Plus/Pro", isSubscription: true }, apiKey: { name: "OpenAI API key", login: () => {} } } },
      { id: "amazon-bedrock", name: "Bedrock", auth: { apiKey: { name: "AWS profile" } } },
      { id: "../etc", name: "Bad", auth: { oauth: { name: "x" } } },
    ],
    listCredentials: async () => saved.map(providerId => ({ providerId })),
    login: async (providerId, _type, interaction, options) => {
      assert.equal(options?.getDeviceId?.(), "device-1");
      await login(interaction);
      saved.push(providerId);
    },
  };
}

test("Pi's providers are offered with the sign-ins they have, and a sign-in runs through its questions to a saved credential", async () => {
  const events: LoginEvent[] = [];
  const answers: string[] = [];
  const runtime = fakeRuntime(async interaction => {
    interaction.notify({ type: "auth_url", url: "https://auth.openai.com/oauth?x=1", instructions: "Complete login" });
    answers.push(await interaction.prompt({ type: "select", message: "Method?", options: [{ id: "browser", label: "Browser" }] }));
    answers.push(await interaction.prompt({ type: "secret", message: "Code" }));
  });
  assert.deepEqual(await loginProviders(runtime), [{ id: "openai-codex", name: "OpenAI (ChatGPT)", signedIn: false,
    methods: [{ type: "oauth", name: "ChatGPT Plus/Pro", subscription: true }, { type: "api_key", name: "OpenAI API key" }] }]);

  const session = new LoginSession(event => {
    events.push(event);
    if (event.kind === "prompt") queueMicrotask(() => session.answer(event.prompt, event.detail.type === "select" ? "browser" : "secret-code"));
  });
  await runLogin({ runtime, provider: "openai-codex", method: "oauth", session, deviceId: () => "device-1" });
  assert.deepEqual(answers, ["browser", "secret-code"]);
  assert.deepEqual(runtime.saved, ["openai-codex"]);
  assert.equal((await loginProviders(runtime))[0]?.signedIn, true);
  assert.deepEqual(events.map(event => event.kind), ["auth-url", "prompt", "prompt"]);
  assert.equal(session.answer(1, "again"), false, "an answered prompt takes no second answer");
  await assert.rejects(runLogin({ runtime, provider: "amazon-bedrock", method: "api_key", session, deviceId: () => "device-1" }), /can't sign in that way/);
});

test("a cancelled sign-in ends its questions, and a provider's errors and links are checked before the app sees them", async () => {
  const events: LoginEvent[] = [];
  const runtime = fakeRuntime(async interaction => { await interaction.prompt({ type: "text", message: "Name" }); });
  const session = new LoginSession(event => { events.push(event); if (event.kind === "prompt") queueMicrotask(() => session.cancel()); });
  await assert.rejects(runLogin({ runtime, provider: "openai-codex", method: "oauth", session, deviceId: () => "device-1" }),
    (error: unknown) => error instanceof LoginError && error.cancelled && error.message === "Sign-in cancelled.");
  assert.deepEqual(events.map(event => event.kind), ["prompt", "prompt-closed"]);

  assert.equal(loginEvent({ type: "auth_url", url: "javascript:alert(1)" }), undefined);
  assert.equal(loginEvent({ type: "auth_url", url: "file:///etc/passwd" }), undefined);
  assert.deepEqual(loginEvent({ type: "auth_url", url: "http://localhost:1455/cb" }), { kind: "auth-url", url: "http://localhost:1455/cb" });
  assert.equal(loginEvent({ type: "device_code", userCode: "ABCD-1234", verificationUri: "http://evil.example/" }), undefined);
  assert.deepEqual(loginEvent({ type: "info", message: "See\u0000", links: [{ url: "https://a.example/", label: "A" }, { url: "ftp://b" }] }),
    { kind: "info", message: "See", links: [{ url: "https://a.example/", label: "A" }] });

  const token = "sk-ant-oat01-" + "x".repeat(60);
  const failure = loginFailure(new Error(`OpenAI Codex token exchange response missing fields: {"access_token":"${token}"} with ${token}`), false);
  assert.equal(failure.cancelled, false);
  assert.ok(!failure.message.includes("xxxxxxxxxx"), failure.message);
  assert.match(failure.message, /^Sign-in failed: OpenAI Codex token exchange response missing fields/);
  assert.deepEqual(loginFailure(new Error("Login cancelled"), false), { cancelled: true, message: "Sign-in cancelled." });
});

test("a host that runs unsandboxed until its sandbox is ready lists what the sandbox lacks, and offers its fix", async t => {
  const directory = await mkdtemp(join(tmpdir(), "pikibun-desktop-sandbox-fix-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const settings = new SettingsStore(join(directory, "settings.json"));
  const git = { name: "Git for Windows (git on PATH)", ok: true, fix: fixes.gitForWindows };
  const mxc = { name: "Microsoft MXC SDK 1.0.1", ok: false, fix: fixes.mxcSdk("C:\\mxc") };
  // Native Windows with Git but without the MXC SDK: it runs unsandboxed, needing only Git, until the SDK is there.
  const inspection: HostInspection = { platform: "win32", stateDir: directory, mode: "unsandboxed", models: [], prerequisites: [git], sandboxPrerequisites: [git, mxc] };
  assert.deepEqual(listedPrerequisites(inspection), [{ entry: git, sandbox: false }, { entry: mxc, sandbox: true }]);
  const ready: HostInspection = { ...inspection, mode: "sandboxed", prerequisites: [git, { ...mxc, ok: true }], sandboxPrerequisites: [git, { ...mxc, ok: true }] };
  assert.deepEqual(listedPrerequisites(ready).map(item => item.sandbox), [false, false]);
  assert.deepEqual(listedPrerequisites(undefined), []);

  const ran: unknown[] = [];
  const controller = new HostController({ id: "default", settings, fixtureModels: false, command: () => "", confirmUnsandboxed: async () => false,
    sandbox: () => ({ sandbox: "native" }), runSetup: async action => { ran.push(action); return { ok: true }; } });
  controller.attach(fakeHost(() => inspection).host);
  await controller.refresh();
  assert.deepEqual(listedPrerequisites(controller.view().inspection).at(-1)?.entry.fix?.action, { kind: "mxc-sdk" });
  assert.deepEqual(await controller.setup({ kind: "mxc-sdk" }), { ok: true });
  assert.deepEqual(ran, [{ kind: "mxc-sdk" }]);
});

test("Pi's providers are listed again after a failure once Refresh asks, and forgotten when the sandbox changes", async t => {
  const directory = await mkdtemp(join(tmpdir(), "pikibun-desktop-providers-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const settings = new SettingsStore(join(directory, "settings.json"));
  let failure: string | undefined = "WSL2 isn't set up on this computer.";
  const { host, pending } = fakeHost(() => ({ platform: "win32", stateDir: directory, mode: "sandboxed", models: [], prerequisites: [] }), () => failure);
  const controller = new HostController({ id: "default", settings, fixtureModels: false, command: () => "", confirmUnsandboxed: async () => false,
    sandbox: () => settings.connection("default")?.windows ?? { sandbox: "wsl2" } });
  controller.attach(host);

  // A host that can't start yet: why, and nothing listed.
  assert.deepEqual(await controller.loadProviders(), { ok: false, error: failure });
  assert.equal(controller.view().providers, undefined);
  assert.equal(controller.view().providersError, failure);
  // Set up meanwhile: Refresh lists them.
  failure = undefined;
  await controller.refresh();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(controller.view().providersError, undefined);
  assert.equal(controller.view().providers?.[0]?.id, "anthropic");

  // No change of sandbox while a sign-in runs in the host process it would end.
  const signingIn = controller.startSignIn("anthropic", "oauth");
  await Promise.resolve();
  assert.match(controller.sandboxRefusal() ?? "", /Finish or cancel the sign-in/);
  assert.match((await controller.setSandbox({ sandbox: "native" }) as { error: string }).error, /Finish or cancel the sign-in/);
  pending[0]!.resolve({ type: "result", id: 0, ok: false, error: { code: "cancelled", message: "Sign-in cancelled." } });
  await signingIn;

  // Another sandbox is another Pi: its providers and sign-in are its own, listed afresh.
  failure = "Native Windows' Pi isn't ready.";
  assert.deepEqual(await controller.setSandbox({ sandbox: "native" }), { ok: true });
  assert.equal(controller.view().signIn, undefined);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(controller.view().providers, undefined, "the previous environment's providers are gone");
  assert.equal(controller.view().providersError, failure);
});
