import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { HostWorkspace } from "../apps/runner/src/host-workspace.js";
import type { SandboxAuthorize } from "../apps/runner/src/sandbox.js";
import { agentInstructions } from "../apps/runner/src/session/instructions.js";
import { SudoPrompts, type SudoPromptsOptions } from "../apps/runner/src/sudo-prompts.js";
import { parseSudoAnswer, sudoCommandText, sudoPromptText } from "../packages/shared/src/sudo.js";
import type { RunnerBinding } from "../packages/shared/src/types.js";

const unix = { skip: process.platform === "win32" };
const authorize: SandboxAuthorize = async () => {};

async function waitFor<T>(read: () => T | undefined, ms = 5000): Promise<T> {
  const until = Date.now() + ms;
  for (;;) {
    const value = read();
    if (value !== undefined && value !== false) return value;
    if (Date.now() > until) throw new Error("Timed out waiting");
    await new Promise(resolve => setTimeout(resolve, 20));
  }
}

function prompts(t: TestContext, options: Partial<SudoPromptsOptions> = {}): SudoPrompts {
  const value = new SudoPrompts({ allowed: async () => true, changed: () => {}, ...options });
  t.after(() => value.close());
  return value;
}

function ask(helper: string, prompt = "[sudo] password for alice: ") {
  const child = spawn(helper, [prompt], { stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "";
  child.stdout.setEncoding("utf8").on("data", chunk => { stdout += chunk; });
  const exited = new Promise<{ code: number | null; stdout: string }>(resolve => child.once("close", code => resolve({ code, stdout })));
  return { child, exited };
}

test("an answer to sudo's prompt checks its shape, and only the prompt's id and one password or a decline go", () => {
  assert.deepEqual(parseSudoAnswer({ id: "abc", password: "pa ss" }), { id: "abc", password: "pa ss" });
  assert.deepEqual(parseSudoAnswer({ id: "abc", decline: true, nonce: "n1" }), { id: "abc", decline: true, nonce: "n1" });
  assert.throws(() => parseSudoAnswer({ id: "abc", password: "x", decline: true }), /not both/);
  assert.throws(() => parseSudoAnswer({ id: "abc", password: "" }), /Give the password/);
  assert.throws(() => parseSudoAnswer({ id: "abc", password: "a\nb" }), /line breaks/);
  assert.throws(() => parseSudoAnswer({ id: "abc", password: "x".repeat(1025) }), /at most 1024/);
  assert.throws(() => parseSudoAnswer({ id: "../x", password: "x" }), /Invalid sudo prompt id/);
  assert.throws(() => parseSudoAnswer({ id: "abc", password: "x", remember: true }), /Answer a sudo prompt/);
  assert.equal(sudoPromptText("[sudo] password\x1b[31m for alice: "), "[sudo] password [31m for alice:");
  assert.equal(sudoPromptText(undefined), "Password:");
  assert.equal(sudoCommandText(`  ${"a".repeat(500)}`)!.length, 400);
  assert.equal(sudoCommandText("  "), undefined);
});

test("sudo -A's helper asks Pikibun, shows the prompt and command, and hands the password to that one sudo alone", unix, async t => {
  let changes = 0;
  const sudo = prompts(t, { changed: () => { changes++; }, command: () => "python3 -c 'sudo -A apt-get install -y make'" });
  await sudo.prepare();
  const helper = sudo.helper!;
  assert.ok(existsSync(helper));
  const { exited } = ask(helper);
  const view = await waitFor(() => sudo.view());
  assert.equal(view.prompt, "[sudo] password for alice:");
  assert.equal(view.command, "python3 -c 'sudo -A apt-get install -y make'");
  assert.ok(Date.parse(view.expiresAt) - Date.parse(view.requestedAt) === 5 * 60_000);
  assert.equal(sudo.waiting(), true);
  assert.ok(changes >= 1);
  assert.equal(sudo.answer("another", "nope"), false, "an answer reaches only the prompt it names");
  assert.equal(sudo.answer(view.id, "s3cret pass"), true);
  assert.deepEqual(await exited, { code: 0, stdout: "s3cret pass\n" });
  assert.equal(sudo.view(), undefined);
  assert.equal(sudo.waiting(), false);
  assert.equal(sudo.answer(view.id, "again"), false, "a prompt takes one answer");
});

test("a declined, unanswered or abandoned prompt gives sudo nothing", unix, async t => {
  const sudo = prompts(t, { waitMs: 300 });
  await sudo.prepare();
  const declined = ask(sudo.helper!);
  sudo.answer((await waitFor(() => sudo.view())).id, undefined);
  assert.deepEqual(await declined.exited, { code: 1, stdout: "" });

  const unanswered = ask(sudo.helper!);
  await waitFor(() => sudo.view());
  assert.deepEqual(await unanswered.exited, { code: 1, stdout: "" });
  assert.equal(sudo.view(), undefined, "it lapses after its wait");

  const abandoned = ask(sudo.helper!);
  await waitFor(() => sudo.view());
  abandoned.child.kill("SIGKILL");
  await abandoned.exited;
  await waitFor(() => sudo.view() === undefined);
});

test("only the helper Pikibun wrote can ask: a connection without its token is declined and shows nothing", unix, async t => {
  const sudo = prompts(t);
  await sudo.prepare();
  const source = await readFile(join(dirname(sudo.helper!), "askpass.cjs"), "utf8");
  const socket = JSON.parse(/net\.connect\(("[^"]+")\)/.exec(source)![1]!) as string;
  const reply = await new Promise<string>((resolve, reject) => {
    const connection = connect(socket, () => connection.write(`${JSON.stringify({ token: "guessed", prompt: "Password:" })}\n`));
    let data = "";
    connection.setEncoding("utf8").on("data", chunk => { data += chunk; }).on("end", () => resolve(data)).on("error", reject);
  });
  assert.deepEqual(JSON.parse(reply), { declined: true });
  assert.equal(sudo.view(), undefined);
});

test("time waiting for the password is counted, and sudo goes away where it isn't allowed, and when the session closes", unix, async t => {
  let allowed = true;
  const sudo = prompts(t, { allowed: async () => allowed });
  await sudo.prepare();
  const started = Date.now();
  const { exited } = ask(sudo.helper!);
  const view = await waitFor(() => sudo.view());
  await new Promise(resolve => setTimeout(resolve, 300));
  sudo.answer(view.id, "pw");
  await exited;
  const waited = sudo.waitedSince(started);
  assert.ok(waited >= 250 && waited < 5000, `waited ${waited}ms`);
  assert.equal(sudo.waitedSince(Date.now() + 1000), 0);

  const directory = dirname(sudo.helper!);
  allowed = false;
  await sudo.prepare();
  assert.equal(sudo.helper, undefined);
  assert.equal(existsSync(directory), false, "its socket and helper are gone");
  allowed = true;
  await sudo.prepare();
  assert.ok(sudo.helper && existsSync(sudo.helper), "it comes back once allowed again");
  const pending = ask(sudo.helper!);
  await waitFor(() => sudo.view());
  await sudo.close();
  assert.deepEqual(await pending.exited, { code: 1, stdout: "" }, "closing declines what waits");
});

const hostMode = { skip: process.platform === "win32" || spawnSync("git", ["--version"]).status !== 0 };

function binding(): RunnerBinding {
  return {
    session: { id: "sudo-session", workspaceId: "private", ownerId: "test:alice", agentVersionId: "version-1", title: "Install", policyVersion: 1, status: "ready",
      createdAt: "2026-01-01T00:00:00Z", repositories: [], connectorId: "host", connectorOwnerId: "test:alice", hostEnvironment: true },
    owner: { id: "test:alice", githubId: null, githubLogin: "alice", displayName: "Alice", gitName: "Alice", gitEmail: "alice@example.test", env: {}, githubConnected: false },
    agent: { id: "version-1", agentId: "agent", authorId: "test:alice", workspaceId: "private", version: 1, name: "Agent", description: "", instructions: "Use tools.",
      tools: ["bash"], modelId: "model-1", createdAt: "2026-01-01T00:00:00Z" },
    model: { id: "model-1", workspaceId: "private", name: "Model", provider: "openai", modelId: "local" },
  };
}

test("an on-host command gets SUDO_ASKPASS, and its time limit stops while sudo waits for the owner", hostMode, async t => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "pikibun-sudo-host-")));
  t.after(() => rm(directory, { recursive: true, force: true }));
  let workspace: HostWorkspace | undefined;
  const sudo = prompts(t, { command: () => workspace?.activeCommand });
  workspace = new HostWorkspace(binding(), join(directory, "session"), { ownerEnvironment: true, sudo });
  t.after(() => workspace!.close());
  await workspace.initialize();
  const limits = { seconds: 1, cpuSeconds: 60, fileBytes: 1 << 20, openFiles: 256 };
  const command = "\"$SUDO_ASKPASS\" '[sudo] password for alice: '";
  const running = workspace.execute({ kind: "bash", command }, false, authorize, { limits });
  const view = await waitFor(() => sudo.view());
  assert.equal(view.command, command);
  await new Promise(resolve => setTimeout(resolve, 1500));
  sudo.answer(view.id, "hunter2");
  assert.equal(await running, "hunter2\n", "the wait didn't count against the 1-second limit");
  assert.equal(workspace.activeCommand, undefined);
  await assert.rejects(workspace.execute({ kind: "bash", command: "sleep 3" }, false, authorize, { limits }), /time limit/, "the limit still holds otherwise");
});

test("the agent is told to use sudo -A, and never to ask for the password in the chat, only where sudo is offered", () => {
  const input = { base: "Base.", agentTools: [], mode: "write" as const, off: new Set<string>(), browserUnavailable: undefined, tunnelUnavailable: undefined,
    kindsOff: new Set<never>(), extensionTools: new Set<string>(), clone: false, sandboxed: false, branch: "pikibun/work-1", cloneRepositories: [], lfsRepositories: [],
    cloneFailures: [], definitions: [], sources: [], conversationOnlyRestore: false, tools: [], missing: [], linuxSandbox: false, nodeBin: false, codemode: false, browser: false };
  const offered = agentInstructions({ ...input, sudo: true });
  assert.match(offered, /use sudo -A \(--askpass\)/);
  assert.match(offered, /Never ask for the password in the chat/);
  assert.doesNotMatch(agentInstructions(input), /sudo/);
  assert.doesNotMatch(agentInstructions({ ...input, sudo: true, mode: "ask" }), /sudo -A/);
});
