import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sha256, signToken } from "../packages/shared/src/crypto.js";
import {
  attachedFilesNote, attachmentCandidate, base64Bytes, fileUploadLimits, formatBytes, parseUploadChunk, uploadFileName,
} from "../packages/shared/src/file-uploads.js";
import type { AuthorizationRequest, RunnerBinding, RunnerTicket } from "../packages/shared/src/types.js";
import { HelperWorkspace, type HelperBackend, type HelperContext, type HelperLaunch, type HelperLayout } from "../apps/runner/src/helper-workspace.js";
import { HostWorkspace } from "../apps/runner/src/host-workspace.js";
import { NODE_HELPER, NODE_HELPER_KINDS } from "../apps/runner/src/node-helper.js";
import { HELPER, importedPath, importRequest, type SandboxRequest } from "../apps/runner/src/sandbox.js";
import { createRunnerApp, RunnerService } from "../apps/runner/src/server.js";
import type { SessionWorkspace } from "../apps/runner/src/workspace.js";

const allow = async () => {};
const git = spawnSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).stdout.trim();
const bash = ["/bin/bash", "/usr/bin/bash"].find(path => existsSync(path));
const python = spawnSync("sh", ["-c", "command -v python3"], { encoding: "utf8" }).stdout.trim();
const posix = process.platform !== "win32" && !!git && !!bash;
const hostMode = { skip: !["linux", "darwin"].includes(process.platform) || !git };
const SECRET = "file-uploads-test-secret-not-a-production-secret";

function binding(id: string): RunnerBinding {
  return {
    session: { id, workspaceId: "workspace", ownerId: "test:alice", agentVersionId: "version-1", title: "Uploads", policyVersion: 1, status: "ready", createdAt: "2026-01-01T00:00:00Z", repositories: [] },
    owner: { id: "test:alice", githubId: null, githubLogin: "alice", displayName: "Alice", gitName: "Alice Owner", gitEmail: "alice@example.test", env: {}, githubConnected: false },
    agent: { id: "version-1", agentId: "agent", authorId: "test:alice", workspaceId: "workspace", version: 1, name: "Agent", description: "", instructions: "Use tools.", tools: ["read_file"], modelId: "model-1", createdAt: "2026-01-01T00:00:00Z" },
    model: { id: "model-1", workspaceId: "workspace", name: "Explicit faux test provider", provider: "faux", modelId: "faux-1" },
  };
}

async function directory(t: TestContext, prefix: string): Promise<string> {
  const path = await realpath(await mkdtemp(join(tmpdir(), prefix)));
  t.after(() => rm(path, { recursive: true, force: true }));
  return path;
}

test("attached files' names are made safe for every host, and their chunks are checked whole", () => {
  assert.equal(uploadFileName("report.pdf"), "report.pdf");
  assert.equal(uploadFileName("../../etc/passwd"), ".._.._etc_passwd");
  assert.equal(uploadFileName("a\\b:c*?\"<>|\x01.txt"), "a_b_c_______.txt");
  assert.equal(uploadFileName("  notes.  "), "notes");
  for (const name of ["", ".", "..", "...", ".git", ".GIT", "   "]) assert.equal(uploadFileName(name), "", name);
  assert.equal(uploadFileName("CON.txt"), "_CON.txt");
  // Cut to 200 bytes of UTF-8, keeping a short extension and never half a character.
  const long = uploadFileName(`${"é".repeat(300)}.tar`);
  assert.ok(new TextEncoder().encode(long).length <= 200);
  assert.ok(long.endsWith(".tar"));
  assert.equal(uploadFileName(`${"😀".repeat(120)}`).length % 2, 0);

  assert.equal(attachmentCandidate("report.pdf", 1), "report.pdf");
  assert.equal(attachmentCandidate("report.pdf", 2), "report (2).pdf");
  assert.equal(attachmentCandidate("Makefile", 3), "Makefile (3)");
  assert.equal(attachmentCandidate(".env", 2), ".env (2)");
  assert.equal(base64Bytes("aGk="), 2);
  assert.equal(base64Bytes(""), 0);
  assert.equal(formatBytes(10 * 1024 * 1024), "10 MB");
  assert.equal(formatBytes(1536 * 1024), "1.5 MB");
  assert.equal(formatBytes(300 * 1024), "300 KB");
  assert.equal(attachedFilesNote([]), "");
  assert.equal(attachedFilesNote([{ path: "attachments/a.csv", size: 2048 }]), "Attached file, uploaded into the session worktree:\n- attachments/a.csv (2 KB)");

  const chunk = { uploadId: "upload-0001", name: "a.txt", size: 3, offset: 1, data: "aGk=" };
  assert.deepEqual(parseUploadChunk(chunk), chunk);
  assert.deepEqual(parseUploadChunk({ ...chunk, size: 0, offset: 0, data: "" }), { ...chunk, size: 0, offset: 0, data: "" });
  for (const [value, reason] of [
    [{ ...chunk, extra: 1 }, "an unknown field"], [{ ...chunk, uploadId: "x" }, "a short upload id"], [{ ...chunk, name: "a/b" }, "a path"],
    [{ ...chunk, name: ".git" }, "Git metadata"], [{ ...chunk, data: "aGk" }, "unpadded base64"], [{ ...chunk, data: "a$k=" }, "not base64"],
    [{ ...chunk, offset: 2 }, "a chunk past the end"], [{ ...chunk, offset: -1 }, "a negative offset"], [{ ...chunk, size: 1.5 }, "a fractional size"],
    [{ ...chunk, data: "" }, "an empty chunk of a file with bytes"], [{ ...chunk, size: fileUploadLimits.maxBytes + 1 }, "a file over the hard limit"],
    [{ ...chunk, size: 4 * 1024 * 1024, offset: 0, data: Buffer.alloc(fileUploadLimits.chunkBytes + 1).toString("base64") }, "a chunk over the chunk size"],
  ] as const) assert.ok("error" in parseUploadChunk(value), reason);
  assert.ok("error" in parseUploadChunk({ ...chunk, size: 3 }, 2), "a file over the given limit");
});

test("an import request carries only a safe name, and a helper's answer must be in the directory under a name of that file", () => {
  assert.throws(() => importRequest("attachments", "../x", Buffer.from("x")), /Invalid file import/);
  assert.throws(() => importRequest("../attachments", "x", Buffer.from("x")), /Invalid file import/);
  assert.throws(() => importRequest(".git", "x", Buffer.from("x")), /Invalid file import/);
  assert.throws(() => importRequest("attachments", "x", Buffer.alloc(fileUploadLimits.maxBytes + 1)), /Invalid file import/);
  const request = importRequest("attachments", "a.txt", Buffer.from("hi"));
  assert.deepEqual(request, { kind: "import", directory: "attachments", name: "a.txt", data: "aGk=" });
  assert.equal(importedPath({ path: "attachments/a (7).txt" }, request), "attachments/a (7).txt");
  for (const path of ["attachments/b.txt", "elsewhere/a.txt", "attachments/../a.txt", "a.txt"]) assert.throws(() => importedPath({ path }, request), /Invalid sandbox import response/);
});

/** Imports through `workspace` as an attached file goes in, and checks what lands in its worktree. */
async function imports(workspace: SessionWorkspace): Promise<void> {
  const data = Buffer.from([0, 1, 2, 255, 10, 13]);
  assert.equal(await workspace.importFile("attachments", "data.bin", data, allow), "attachments/data.bin");
  assert.deepEqual(await readFile(join(workspace.worktree, "attachments", "data.bin")), data);
  // A name that is taken gets the next free one; nothing is replaced.
  assert.equal(await workspace.importFile("attachments", "data.bin", Buffer.from("second"), allow), "attachments/data (2).bin");
  assert.equal(await workspace.importFile("attachments", "data.bin", Buffer.alloc(0), allow), "attachments/data (3).bin");
  assert.deepEqual(await readFile(join(workspace.worktree, "attachments", "data.bin")), data);
  assert.equal(await readFile(join(workspace.worktree, "attachments", "data (2).bin"), "utf8"), "second");
  assert.equal((await readFile(join(workspace.worktree, "attachments", "data (3).bin"))).length, 0);
  // Large files go whole.
  const large = Buffer.alloc(3 * 1024 * 1024 + 5, 7);
  assert.equal(await workspace.importFile("attachments", "large.bin", large, allow), "attachments/large.bin");
  assert.equal((await readFile(join(workspace.worktree, "attachments", "large.bin"))).length, large.length);
  await assert.rejects(workspace.importFile("attachments", "../escape", data, allow), /Invalid file import/);
  // A directory that is a symlink, even to another directory in the worktree, gets nothing: no stray file is left there.
  await mkdir(join(workspace.worktree, "src"));
  await symlink("src", join(workspace.worktree, "linked"));
  await assert.rejects(workspace.importFile("linked", "a.txt", data, allow), /not a real directory/);
  assert.deepEqual(await readdir(join(workspace.worktree, "src")), []);
}

test("the unsandboxed host imports attached files into the worktree, never over a file or through a symlink", hostMode, async t => {
  const base = await directory(t, "uploads-host-");
  const workspace = new HostWorkspace(binding("uploads-host"), join(base, "session"));
  t.after(() => workspace.close());
  await workspace.initialize();
  await imports(workspace);
  // An attachments path the session turned into a symlink out of the worktree is refused.
  const other = new HostWorkspace(binding("uploads-host-2"), join(base, "other"));
  t.after(() => other.close());
  await other.initialize();
  await mkdir(join(base, "outside"));
  await symlink(join(base, "outside"), join(other.worktree, "attachments"));
  await assert.rejects(other.importFile("attachments", "a.txt", Buffer.from("x"), allow));
  assert.deepEqual(await readdir(join(base, "outside")), []);
});

/** A backend that runs a helper with no boundary at all, as tests/native-sandboxes.test.ts does. */
class Unconfined implements HelperBackend {
  readonly path = "/usr/bin:/bin";
  readonly limitedShell = true;
  constructor(readonly name: string, readonly helper: "python" | "node") {}
  supports(kind: SandboxRequest["kind"]): boolean { return this.helper === "python" || NODE_HELPER_KINDS.has(kind); }
  async prepare(layout: HelperLayout): Promise<void> {
    if (this.helper === "node") await writeFile(join(layout.bin, "helper.mjs"), NODE_HELPER, { mode: 0o400 }).catch(() => undefined);
  }
  async launch(_request: SandboxRequest, context: HelperContext, layout: HelperLayout): Promise<HelperLaunch> {
    const env = { ...context.environment, SANDBOX_GITDIR: layout.git, SANDBOX_GIT: git, SANDBOX_BASH: bash!, SANDBOX_OWNER_CONFIG: layout.ownerConfig };
    return this.helper === "python"
      ? { command: python, args: ["-I", "-c", HELPER], env, cwd: layout.worktree }
      : { command: process.execPath, args: [join(layout.bin, "helper.mjs")], env, cwd: layout.worktree };
  }
}

for (const helper of ["python", "node"] as const) {
  test(`the ${helper === "python" ? "Python (Linux and macOS)" : "Node (Windows)"} sandbox helper imports attached files the same way`, { skip: !posix || (helper === "python" && !python) }, async t => {
    const base = await directory(t, `uploads-${helper}-`);
    const workspace = new HelperWorkspace(binding(`uploads-${helper}`), join(base, "sandbox"), new Unconfined(helper, helper));
    t.after(() => workspace.close());
    await workspace.initialize();
    await imports(workspace);
    // The worktree's Git metadata is never written.
    await assert.rejects(workspace.importFile(".git", "x", Buffer.from("x"), allow), /Invalid file import/);
  });
}

async function ticket(id: string, action: RunnerTicket["action"], body = "", actorId = "test:alice"): Promise<RunnerTicket> {
  const now = Math.floor(Date.now() / 1000);
  return { aud: "runner", sessionId: id, actorId, ownerId: "test:alice", action, policyVersion: 1, iat: now, exp: now + 60, jti: randomUUID(), bodyHash: await sha256(body) };
}

test("a session takes an attached file in order, one chunk per ticket, and writes it into its worktree whole", hostMode, async t => {
  const base = await directory(t, "uploads-runner-");
  const authorize = async (input: AuthorizationRequest) => ({ allowed: true, ownerId: input.ownerId, policyVersion: 1 });
  const runner = new RunnerService({ dataDir: base, sharedSecret: SECRET, controlPlaneUrl: "http://127.0.0.1:8787", allowFaux: true, unsandboxed: true, authorize });
  await runner.initialize();
  t.after(() => runner.close());
  const session = await runner.provision(binding("uploads"), await ticket("uploads", "create"));
  const app = createRunnerApp(runner);
  const send = async (chunk: Record<string, unknown>, options: { actorId?: string; replay?: string; ticket?: RunnerTicket } = {}) => {
    const body = JSON.stringify(chunk);
    const token = options.replay ?? await signToken(options.ticket ?? await ticket("uploads", "upload", body, options.actorId), SECRET);
    const response = await app.request("/v1/sessions/uploads/upload", { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body });
    return { status: response.status, body: await response.json() as Record<string, unknown>, token };
  };
  const file = Buffer.concat([Buffer.alloc(fileUploadLimits.chunkBytes, 3), Buffer.from("end")]);
  const part = (offset: number, end: number, uploadId = "upload-0001") => ({ uploadId, name: "data.bin", size: file.length, offset, data: file.subarray(offset, end).toString("base64") });

  const first = await send(part(0, fileUploadLimits.chunkBytes));
  assert.deepEqual([first.status, first.body], [200, { received: fileUploadLimits.chunkBytes }]);
  // A ticket goes in once.
  assert.equal((await send(part(0, fileUploadLimits.chunkBytes), { replay: first.token })).status, 409);
  // Out of order, or another actor's upload of the same id, isn't this upload.
  assert.equal((await send(part(fileUploadLimits.chunkBytes + 1, file.length))).status, 409);
  assert.equal((await send(part(fileUploadLimits.chunkBytes, file.length), { actorId: "test:bob" })).status, 409);
  assert.equal((await send({ ...part(0, 3), name: "../x" })).status, 400);
  const last = await send(part(fileUploadLimits.chunkBytes, file.length));
  assert.deepEqual([last.status, last.body], [200, { received: file.length, path: "attachments/data.bin" }]);
  assert.deepEqual(await readFile(join(session.sandbox.worktree, "attachments", "data.bin")), file);
  // Nothing of it is left outside the worktree.
  assert.deepEqual(await readdir(join(session.directory, "uploads")), []);
  // The same file again goes beside it.
  const again = await send({ uploadId: "upload-0002", name: "data.bin", size: 2, offset: 0, data: "aGk=" });
  assert.deepEqual(again.body, { received: 2, path: "attachments/data (2).bin" });

  // Unfinished uploads count the whole size they declared from their first chunk, so several started small can't grow
  // past what the host holds at once (four files of the largest size).
  const big = (index: number) => ({ uploadId: `upload-big-${index}`, name: `big-${index}.bin`, size: fileUploadLimits.maxBytes, offset: 0, data: "aGk=" });
  for (let index = 0; index < 4; index++) assert.deepEqual((await send(big(index))).body, { received: 2 });
  const refused = await send(big(4));
  assert.equal(refused.status, 429);
  assert.equal((await readdir(join(session.directory, "uploads"))).length, 4);
  // Starting the same upload again doesn't count it twice.
  assert.equal((await send(big(3))).status, 200);
});
