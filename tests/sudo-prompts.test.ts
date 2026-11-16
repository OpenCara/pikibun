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
import { base64url, fromBase64url, openSudoPassword, sealSudoPassword, sudoSealKeys } from "../packages/shared/src/sudo-seal.js";
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

test("a password answered while a command runs is taken out of that command's output, each stream on its own, and forgotten when the command ends", unix, async t => {
  const sudo = prompts(t);
  await sudo.prepare();
  const first = sudo.track();
  const other = sudo.track();
  const { exited } = ask(sudo.helper!);
  const view = await waitFor(() => sudo.view());
  assert.equal(sudo.answer(view.id, "s3cret pass"), true);
  const printed = (await exited).stdout;
  assert.equal(first.redact(`a\0b ${printed}after s3cret pass`), "a\0b [sudo password]\nafter [sudo password]", "a NUL byte in the output stays where it was");
  assert.equal(first.redact("stderr s3cret pass"), "stderr [sudo password]", "the second stream is redacted as the first");
  assert.equal(first.redact("output cut at s3cret pa", true), "output cut at [sudo password]", "the start of a password that the output limit cut is taken out too");
  assert.equal(first.redact("ends with s3cret pa"), "ends with s3cret pa", "but only where the output was cut");
  first.end();
  first.end();
  assert.equal(other.redact("s3cret pass again"), "[sudo password] again", "while another command of the session still runs, it is still taken out");
  other.end();
  assert.equal(sudo.track().redact("s3cret pass"), "s3cret pass", "once no command runs, the password is forgotten");
});

test("a password sealed to a prompt's key opens with that prompt's key and id alone, and a changed byte opens nothing", async () => {
  for (const bytes of [new Uint8Array([]), new Uint8Array([1]), new Uint8Array([1, 2]), new Uint8Array([250, 251, 252, 253])]) {
    assert.deepEqual([...fromBase64url(base64url(bytes))], [...bytes]);
    assert.equal(base64url(bytes), Buffer.from(bytes).toString("base64url"));
  }
  const host = await sudoSealKeys();
  const sealed = await sealSudoPassword(host.publicKey, "prompt1", "s3cret pass");
  assert.ok(!JSON.stringify(sealed).includes("s3cret"));
  assert.equal(await openSudoPassword(host.privateKey, "prompt1", sealed), "s3cret pass");
  await assert.rejects(openSudoPassword(host.privateKey, "prompt2", sealed), "it is bound to its prompt");
  await assert.rejects(openSudoPassword((await sudoSealKeys()).privateKey, "prompt1", sealed), "and to the host's key");
  const flipped = fromBase64url(sealed.data); flipped[0] ^= 1;
  await assert.rejects(openSudoPassword(host.privateKey, "prompt1", { ...sealed, data: base64url(flipped) }));
  assert.deepEqual(parseSudoAnswer({ id: "abc", sealed }), { id: "abc", sealed });
  const longest = "密".repeat(1024);
  const big = await sealSudoPassword(host.publicKey, "abc", longest);
  assert.deepEqual(parseSudoAnswer({ id: "abc", sealed: big }).sealed, big, "the longest password the plain path takes, in three-byte characters, fits sealed too");
  assert.ok(JSON.stringify({ id: "abc", sealed: big }).length < 8192, "and within the request body's limit");
  assert.equal(await openSudoPassword(host.privateKey, "abc", big), longest);
  for (const bad of [{ id: "abc", sealed, password: "x" }, { id: "abc", sealed, decline: true }, { id: "abc", sealed: { ...sealed, extra: "x" } },
    { id: "abc", sealed: { ...sealed, data: "not base64!" } }, { id: "abc", sealed: { ...sealed, data: "A".repeat(4300) } }]) {
    assert.throws(() => parseSudoAnswer(bad), JSON.stringify(bad));
  }
});

test("each prompt carries a key of its own, and a sealed answer reaches sudo as the password; one that doesn't open answers nothing", unix, async t => {
  const sudo = prompts(t);
  await sudo.prepare();
  const first = ask(sudo.helper!);
  const view = await waitFor(() => sudo.view());
  assert.match(view.key ?? "", /^[A-Za-z0-9_-]{87}$/, "an uncompressed P-256 public key");
  await assert.rejects(sudo.answerSealed(view.id, await sealSudoPassword((await sudoSealKeys()).publicKey, view.id, "wrong key")), /couldn't be opened/);
  assert.equal(sudo.waiting(), true, "a sealed answer that doesn't open leaves the prompt waiting");
  assert.equal(await sudo.answerSealed(view.id, await sealSudoPassword(view.key!, view.id, "s3cret pass")), true);
  assert.deepEqual(await first.exited, { code: 0, stdout: "s3cret pass\n" });
  const second = ask(sudo.helper!);
  const next = await waitFor(() => sudo.view());
  assert.notEqual(next.key, view.key, "a new prompt, a new key");
  assert.equal(sudo.answer(next.id, undefined), true);
  assert.equal((await second.exited).code, 1);
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

test("a helper that couldn't start is tried again at the next command, leaving nothing behind", unix, async t => {
  const sudo = prompts(t);
  const saved = process.env.TMPDIR;
  t.after(() => { if (saved === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = saved; });
  process.env.TMPDIR = join(tmpdir(), `pikibun-missing-${process.pid}`, "nowhere");
  await sudo.prepare();
  assert.equal(sudo.helper, undefined);
  if (saved === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = saved;
  await sudo.prepare();
  assert.ok(sudo.helper && existsSync(sudo.helper), "the next prepare starts it");
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
  assert.equal(await running, "[sudo password]\n", "the wait didn't count against the 1-second limit");
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
