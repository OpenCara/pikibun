import test from "node:test";
import assert from "node:assert/strict";
import type { AuthInteraction } from "@earendil-works/pi-ai";
import type { HostInspection, LoginEvent } from "../packages/shared/src/app-host-protocol.js";
import { aptFix, fixes } from "../apps/runner/src/prerequisite-fixes.js";
import { LoginError, LoginSession, loginEvent, loginFailure, loginProviders, runLogin, type LoginRuntime } from "../apps/runner/src/pi-login.js";
import { listedPrerequisites } from "../packages/shared/src/host-prerequisites.js";

test("missing Linux packages share one fix, with apt where the system has it", () => {
  assert.deepEqual(aptFix(["bubblewrap", "git", "bubblewrap"], true), { text: "Install bubblewrap, git with apt.", command: "sudo apt install bubblewrap git", action: { kind: "apt", packages: ["bubblewrap", "git"] } });
  assert.deepEqual(aptFix(["bubblewrap"], false), { text: "Install bubblewrap with this system's package manager." });
  assert.deepEqual(fixes.xcodeTools.action, { kind: "xcode-tools" });
  assert.match(fixes.mxcSdk("C:\\mxc").command!, /npm install --prefix "C:\\mxc" @microsoft\/mxc-sdk@1\.0\.1/);
});

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

test("a host that runs unsandboxed until its sandbox is ready lists what the sandbox lacks", () => {
  const git = { name: "Git for Windows (git on PATH)", ok: true, fix: fixes.gitForWindows };
  const mxc = { name: "Microsoft MXC SDK 1.0.1", ok: false, fix: fixes.mxcSdk("C:\\mxc") };
  const inspection: HostInspection = { platform: "win32", stateDir: "C:\\state", mode: "unsandboxed", models: [], prerequisites: [git], sandboxPrerequisites: [git, mxc] };
  assert.deepEqual(listedPrerequisites(inspection), [{ entry: git, sandbox: false }, { entry: mxc, sandbox: true }]);
  assert.deepEqual(listedPrerequisites(inspection).at(-1)?.entry.fix?.action, { kind: "mxc-sdk" });
  const ready: HostInspection = { ...inspection, mode: "sandboxed", prerequisites: [git, { ...mxc, ok: true }], sandboxPrerequisites: [git, { ...mxc, ok: true }] };
  assert.deepEqual(listedPrerequisites(ready).map(item => item.sandbox), [false, false]);
  assert.deepEqual(listedPrerequisites(undefined), []);
});
