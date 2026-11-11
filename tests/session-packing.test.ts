import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { gzipSync } from "node:zlib";
import { sha256, signToken } from "../packages/shared/src/crypto.js";
import type { AuthorizationRequest, Permission, RunnerAction, RunnerBinding, RunnerTicket } from "../packages/shared/src/types.js";
import { RunnerError } from "../apps/runner/src/protocol.js";
import { PACK_FILE, packBytes, packRefusal, readPack, settlePack, writePack } from "../apps/runner/src/pack.js";
import { writePrivate } from "../apps/runner/src/restore.js";
import { PACK_SKIPPED_HOME } from "../apps/runner/src/sandbox.js";
import { RunnerService, createRunnerApp } from "../apps/runner/src/server.js";
import type { RunnerSession } from "../apps/runner/src/session.js";

const SECRET = "packing-test-secret-not-a-production-secret-123456";
const OWNER = "test:alice";

function binding(id: string): RunnerBinding {
  return {
    session: { id, workspaceId: "workspace", ownerId: OWNER, agentVersionId: "version-1", title: "Packing", policyVersion: 1, status: "ready", createdAt: "2026-01-01T00:00:00Z" },
    owner: { id: OWNER, githubId: null, githubLogin: "alice", displayName: "Alice", gitName: "Alice", gitEmail: "alice@example.test", env: {}, githubConnected: false },
    agent: { id: "version-1", agentId: "packing-agent", authorId: "test:author", workspaceId: "workspace", version: 1, name: "Packing", description: "Tests", instructions: "Use tools.", tools: ["read_file", "write_file", "list_files"], modelId: "model-1", createdAt: "2026-01-01T00:00:00Z" },
    model: { id: "model-1", workspaceId: "workspace", name: "Explicit faux test provider", provider: "faux", modelId: "faux-1" },
  };
}

async function ticket(id: string, action: RunnerAction, actorId = OWNER, body = ""): Promise<RunnerTicket> {
  const now = Math.floor(Date.now() / 1000);
  return { aud: "runner", sessionId: id, actorId, ownerId: OWNER, action, policyVersion: 1, iat: now, exp: now + 60, jti: randomUUID(), bodyHash: await sha256(body) };
}

async function directory(t: TestContext): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "session-packing-"));
  t.after(async () => {
    await chmodTree(path).catch(() => {});
    await rm(path, { recursive: true, force: true });
  });
  return path;
}

async function chmodTree(path: string): Promise<void> {
  const info = await lstat(path);
  if (!info.isDirectory()) return;
  await chmod(path, 0o700);
  for (const name of await readdir(path)) await chmodTree(join(path, name));
}

const exists = (path: string) => lstat(path).then(() => true, () => false);
const refusedWith = (status: number, message: RegExp) => (error: unknown) => error instanceof RunnerError && error.status === status && message.test(error.message);
const file = (path: string, text: string, mode = 0o644) => ({ path, data: Buffer.from(text).toString("base64"), mode });

test("settling a session directory finishes or undoes whatever a crash cut off", async t => {
  const root = await directory(t);
  assert.equal(await settlePack(join(root, "missing")), false);

  const packed = join(root, "packed");
  await mkdir(join(packed, ".sandbox-unpack-1", "worktree", "locked"), { recursive: true });
  await writeFile(join(packed, ".sandbox-unpack-1", "worktree", "locked", "file"), "staged");
  await chmod(join(packed, ".sandbox-unpack-1", "worktree", "locked"), 0o500);
  await mkdir(join(packed, ".sandbox-delete-2", "home"), { recursive: true });
  await chmod(join(packed, ".sandbox-delete-2", "home"), 0o000);
  await writeFile(join(packed, `${PACK_FILE}.tmp-3`), "partial");
  await writeFile(join(packed, PACK_FILE), "pack", { mode: 0o600 });
  await writeFile(join(packed, "session.sqlite"), "conversation");
  assert.equal(await settlePack(packed), true);
  assert.deepEqual((await readdir(packed)).sort(), [PACK_FILE, "session.sqlite"]);

  const both = join(root, "both");
  await mkdir(join(both, "sandbox", "worktree"), { recursive: true });
  await writeFile(join(both, PACK_FILE), "pack", { mode: 0o600 });
  assert.equal(await settlePack(both), false);
  assert.deepEqual(await readdir(both), ["sandbox"]);

  const plain = join(root, "plain");
  await mkdir(join(plain, "sandbox"), { recursive: true });
  assert.equal(await settlePack(plain), false);
  assert.deepEqual(await readdir(plain), ["sandbox"]);

  const odd = join(root, "odd");
  await mkdir(join(odd, PACK_FILE), { recursive: true });
  await assert.rejects(settlePack(odd), refusedWith(409, /not a regular file/));
});

test("a pack is checked as unpacking checks it, and reads back the files a restore would write", async t => {
  const root = await directory(t);
  const target = binding("pack-format");
  const bytes = packBytes(target, { files: [file("worktree/src/app.ts", "export {};"), file("worktree/run.sh", "#!/bin/sh", 0o755),
    file("home/.profile", "kept"), file("owner.gitconfig", "[user]\n")] });
  await writePrivate(join(root, PACK_FILE), bytes);
  const files = await readPack(root, target);
  assert.deepEqual(files.map(entry => [entry.path, entry.bytes.toString(), entry.mode]).sort(), [
    ["home/.profile", "kept", 0o600], ["worktree/run.sh", "#!/bin/sh", 0o700], ["worktree/src/app.ts", "export {};", 0o600],
  ]);
  await assert.rejects(readPack(root, binding("another-session")), refusedWith(409, /damaged/));
  await rm(join(root, PACK_FILE));
  await writePrivate(join(root, PACK_FILE), Buffer.from("not a pack"));
  await assert.rejects(readPack(root, target), refusedWith(409, /damaged/));
  await rm(join(root, PACK_FILE));
  await writePrivate(join(root, PACK_FILE), gzipSync(JSON.stringify({ format: "other", sessionId: target.session.id, createdAt: "x", files: [] })));
  await assert.rejects(readPack(root, target), refusedWith(409, /damaged/));
  await rm(join(root, PACK_FILE));
  await writeFile(join(root, PACK_FILE), bytes);
  await chmod(join(root, PACK_FILE), 0o644);
  await assert.rejects(readPack(root, target), refusedWith(409, /private file/));

  const shown = /^[\w .,:'()-]{1,300}$/;
  for (const [content, reason] of [
    [{ files: [file("worktree/../escape", "x")] }, /can't be packed/],
    [{ files: [file("worktree/.git/config", "x")] }, /can't be packed/],
    [{ files: Array.from({ length: 10_001 }, (_, index) => file(`worktree/${index}`, "")) }, /too many files/],
    [{ files: [{ path: "worktree/large", data: Buffer.alloc(25 * 1024 * 1024).toString("base64"), mode: 0o644 }] }, /too large/],
  ] as const) {
    assert.throws(() => packBytes(target, content), (error: unknown) => refusedWith(422, reason)(error) && shown.test((error as Error).message));
  }
});

test("writing a pack replaces the sandbox, whatever permissions its commands left on it", async t => {
  const parent = await directory(t);
  const root = join(parent, "session");
  const outside = join(parent, "outside.txt");
  await writeFile(outside, "not the session's");
  await mkdir(join(root, "sandbox", "worktree", "node_modules", "pkg"), { recursive: true });
  await writeFile(join(root, "sandbox", "worktree", "node_modules", "pkg", "index.js"), "x");
  await symlink(outside, join(root, "sandbox", "worktree", "link"));
  await symlink(parent, join(root, "sandbox", "worktree", "parent"));
  await chmod(join(root, "sandbox", "worktree", "node_modules", "pkg"), 0o000);
  await chmod(join(root, "sandbox", "worktree", "node_modules"), 0o500);
  const bytes = packBytes(binding("pack-write"), { files: [file("worktree/kept.txt", "kept")] });
  await writePack(root, bytes);
  assert.deepEqual(await readdir(root), [PACK_FILE]);
  assert.deepEqual(await readFile(join(root, PACK_FILE)), bytes);
  assert.equal((await lstat(join(root, PACK_FILE))).mode & 0o777, 0o600);
  assert.equal(await readFile(outside, "utf8"), "not the session's", "symlinks are removed, never followed");
});

test("sandbox errors become reasons the session's owner can act on", () => {
  const shown = /^[\w .,:'()-]{1,300}$/;
  for (const [message, reason] of [
    ["Sandbox process failed (exit 1): sandbox: snapshot refuses symlinks and special files", /symlinks or special files/],
    ["Sandbox process failed (exit 1): sandbox: snapshot has too many files", /too many files/],
    ["Sandbox process failed (exit 1): sandbox: file exceeds size limit", /too large/],
    ["Sandbox exceeded 50331648 byte output limit", /too large/],
    ["Sandbox process failed (exit 1): sandbox: the clone app/x could not be backed up", /clones can't be packed/],
  ] as const) {
    const error = packRefusal(new Error(message));
    assert.ok(error instanceof RunnerError && error.status === 422 && reason.test(error.message) && shown.test(error.message), message);
  }
  const other = new Error("Sandbox launcher is unavailable; refusing unsandboxed execution");
  assert.equal(packRefusal(other), other);
  const refusal = new RunnerError(409, "Packing requires an idle session including queued work");
  assert.equal(packRefusal(refusal), refusal);
});

test("the home's package caches a pack leaves out stay in step with the sandbox helper", async () => {
  const { HELPER } = await import("../apps/runner/src/sandbox.js");
  const declared = /PACK_SKIPPED_HOME = \(([^)]*)\)/.exec(HELPER)?.[1];
  assert.ok(declared);
  assert.deepEqual([...declared.matchAll(/'([^']+)'/g)].map(match => match[1]), [...PACK_SKIPPED_HOME]);
});

test("a clone a pack can't keep in full is refused: stashes, other refs, tags its origin lacks, an unreadable cache", { skip: spawnSync("git", ["--version"]).status !== 0 }, async t => {
  const { HELPER } = await import("../apps/runner/src/sandbox.js");
  const root = await directory(t);
  const home = join(root, "home"), work = join(root, "work"), app = join(work, "app");
  await mkdir(home);
  await mkdir(join(work, ".git"), { recursive: true });
  const env = { HOME: home, SANDBOX_WORKTREE: work, PATH: "/usr/bin:/bin", GIT_CONFIG_NOSYSTEM: "1",
    GIT_AUTHOR_NAME: "Alice", GIT_AUTHOR_EMAIL: "alice@example.test", GIT_COMMITTER_NAME: "Alice", GIT_COMMITTER_EMAIL: "alice@example.test" };
  const git = (cwd: string, ...args: string[]) => {
    const result = spawnSync("git", args, { cwd, env, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
  };
  git(root, "init", "-q", "--bare", "-b", "main", "origin.git");
  git(root, "clone", "-q", join(root, "origin.git"), app);
  await writeFile(join(app, "a.txt"), "one");
  git(app, "add", ".");
  git(app, "commit", "-qm", "one");
  git(app, "push", "-q", "origin", "main");
  const program = HELPER.replace(/\ntry:\n    main\(\)[\s\S]*$/, "\n") + `
for pack in (False, True):
    try:
        clone_backup(pack)
        print('ok')
    except ValueError as error:
        print(error)
`;
  const backups = () => {
    const result = spawnSync("/usr/bin/python3", ["-I", "-c", program], { env, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    const [backup, pack] = result.stdout.trim().split("\n");
    assert.equal(backup, "ok", "a backup keeps what it can, as before");
    return pack;
  };
  assert.equal(backups(), "ok");
  git(app, "tag", "pushed");
  assert.equal(backups(), "ok", "its origin's tags come back with the clone");
  await writeFile(join(app, "b.txt"), "two");
  git(app, "add", ".");
  git(app, "commit", "-qm", "two");
  assert.equal(backups(), "ok", "unpushed commits on branches are in the bundle");
  git(app, "tag", "local");
  assert.match(backups()!, /has tags on commits its origin doesn't have/);
  git(app, "tag", "-d", "local");
  await writeFile(join(app, "a.txt"), "changed");
  git(app, "stash", "-q");
  assert.match(backups()!, /has stashed changes/);
  git(app, "stash", "drop", "-q");
  git(app, "update-ref", "refs/notes/commits", "HEAD");
  assert.match(backups()!, /refs other than branches and tags/);
  git(app, "update-ref", "-d", "refs/notes/commits");
  await mkdir(join(app, ".git", "objects", "info"), { recursive: true });
  await writeFile(join(app, ".git", "objects", "info", "alternates"), "/repository-mirrors/github/github.com/7.git/objects\n");
  assert.match(backups()!, /borrows objects from the host cache/);
  await rm(join(app, ".git", "objects", "info", "alternates"));
  assert.equal(backups(), "ok");
  for (const message of ["the clone app has stashed changes, which a pack can't keep", "the clone app has refs other than branches and tags, which a pack can't keep",
    "the clone app has tags on commits its origin doesn't have, which a pack can't keep", "the clone app borrows objects from the host cache that this session can't read now"]) {
    const error = packRefusal(new Error(`Sandbox process failed (exit 1): sandbox: ${message}`));
    assert.ok(error instanceof RunnerError && error.status === 422 && /^[\w .,:'()-]{1,300}$/.test(error.message), message);
  }
});

test("a pack keeps a clone's ignored files, except dependencies and build output that installing again brings back", { skip: spawnSync("git", ["--version"]).status !== 0 }, async t => {
  const { HELPER } = await import("../apps/runner/src/sandbox.js");
  const root = await directory(t);
  const home = join(root, "home"), work = join(root, "work"), app = join(work, "app");
  await mkdir(home);
  await mkdir(join(work, ".git"), { recursive: true });
  const env = { HOME: home, SANDBOX_WORKTREE: work, PATH: "/usr/bin:/bin", GIT_CONFIG_NOSYSTEM: "1",
    GIT_AUTHOR_NAME: "Alice", GIT_AUTHOR_EMAIL: "alice@example.test", GIT_COMMITTER_NAME: "Alice", GIT_COMMITTER_EMAIL: "alice@example.test" };
  const git = (cwd: string, ...args: string[]) => {
    const result = spawnSync("git", args, { cwd, env, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout;
  };
  git(root, "init", "-q", "--bare", "-b", "main", "origin.git");
  git(root, "clone", "-q", join(root, "origin.git"), app);
  await writeFile(join(app, ".gitignore"), "node_modules/\ndist/\n.env*\n.data/\n*.sqlite\n*.log\n__pycache__/\nvendor/\n");
  await writeFile(join(app, "a.txt"), "one");
  git(app, "add", ".");
  git(app, "commit", "-qm", "one");
  git(app, "push", "-q", "origin", "main");
  const put = async (path: string, text: string) => {
    await mkdir(join(app, path, ".."), { recursive: true });
    await writeFile(join(app, path), text);
  };
  await put(".env", "SECRET=1");
  await put("server/.env.local", "PORT=1");
  await put(".data/state/db.sqlite", "rows");
  await put(".data/state/node_modules/pkg/index.js", "rebuilt");
  await put("local.sqlite", "rows");
  await put("notes.txt", "untracked, as before");
  await put("node_modules/pkg/index.js", "rebuilt");
  await put("web/node_modules/pkg/index.js", "rebuilt");
  await put("dist/app.js", "built");
  await put("server.log", "noise");
  await put("py/__pycache__/m.cpython-312.pyc", "compiled");
  await put("vendor/lib.php", "kept: vendor isn't on the list");
  const program = HELPER.replace(/\ntry:\n    main\(\)[\s\S]*$/, "\n") + `
for pack in (False, True):
    try:
        print(clone_backup(pack)['clones'][0]['worktree'])
    except ValueError as error:
        print(error)
`;
  const backups = () => {
    const result = spawnSync("/usr/bin/python3", ["-I", "-c", program], { env, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim().split("\n") as [string, string];
  };
  const files = (commit: string) => git(app, "ls-tree", "-r", "--name-only", commit).trim().split("\n").sort();
  const [backup, pack] = backups();
  assert.deepEqual(files(backup), [".gitignore", "a.txt", "notes.txt"], "a backup keeps what it kept before");
  assert.deepEqual(files(pack), [".data/state/db.sqlite", ".env", ".gitignore", "a.txt", "local.sqlite", "notes.txt", "server/.env.local", "vendor/lib.php"]);
  assert.equal(git(app, "show", `${pack}:.env`), "SECRET=1");
  assert.equal(git(app, "status", "--porcelain"), "?? notes.txt\n", "the clone's own index is untouched");

  await put(".data/big.sqlite", "x".repeat(17 * 1024 * 1024));
  assert.match(backups()[1], /has ignored files too large to pack/);
  await rm(join(app, ".data", "big.sqlite"));
  git(root, "init", "-q", join(app, ".data", "checkout"));
  assert.deepEqual(files(backups()[1]), files(pack), "a clone among them is backed up as a clone of its own");
  await rm(join(app, ".data", "checkout"), { recursive: true });
  git(root, "init", "-q", join(app, ".data", "a", "b", "checkout"));
  assert.match(backups()[1], /has a Git repository among its ignored files/, "deeper than clones are looked for, it would be lost");
  await rm(join(app, ".data", "a"), { recursive: true });
  assert.deepEqual(files(backups()[1]), files(pack));
  for (const message of ["the clone app has ignored files too large to pack", "the clone app has too many ignored files to pack",
    "the clone app has a Git repository among its ignored files, which a pack can't keep"]) {
    const error = packRefusal(new Error(`Sandbox process failed (exit 1): sandbox: ${message}`));
    assert.ok(error instanceof RunnerError && error.status === 422 && /^[\w .,:'()-]{1,300}$/.test(error.message), message);
    assert.match(error.message, /ignored/);
  }
});

const isolation = process.platform !== "linux" ? "Linux only"
  : spawnSync("/usr/bin/bwrap", ["--unshare-all", "--unshare-user", "--die-with-parent", "--ro-bind", "/usr", "/usr", "--ro-bind", "/lib", "/lib",
    "--ro-bind", "/lib64", "/lib64", "--symlink", "usr/bin", "/bin", "--proc", "/proc", "--dev", "/dev", "--", "/usr/bin/true"], { timeout: 5000 }).status === 0
    ? undefined : "bubblewrap can't create namespaces here";
const sandboxed = { skip: isolation, timeout: 120_000 };

async function service(t: TestContext) {
  const root = await directory(t);
  const grants: Record<string, Permission[]> = { [OWNER]: ["read", "ask", "write", "approve", "manage"] };
  const asked: AuthorizationRequest[] = [];
  const fetcher: typeof fetch = async (_url, init) => {
    const input = JSON.parse(String(init?.body)) as AuthorizationRequest;
    asked.push(input);
    return Response.json({ allowed: grants[input.actorId]?.includes(input.permission) ?? false, ownerId: input.ownerId, policyVersion: 1 });
  };
  const runner = new RunnerService({ dataDir: root, sharedSecret: SECRET, controlPlaneUrl: "http://127.0.0.1:8787", allowFaux: true, allowTestShell: true, fetch: fetcher });
  await runner.initialize();
  t.after(() => runner.close());
  return { root, runner, asked };
}

async function idle(session: RunnerSession): Promise<void> {
  for (let count = 0; count < 500; count++) {
    if (!(await session.view()).busy) return;
    await delay(20);
  }
  assert.fail("runner did not settle");
}

async function write(session: RunnerSession, name: string, content: string): Promise<void> {
  const id = session.binding.session.id;
  await session.submit(await ticket(id, "submit"), { content: `TEST_WRITE ${name}\n${content}`, requestId: randomUUID() }, "write");
  await idle(session);
}

test("an archived session's files pack into one file, its conversation stays readable, and unpacking brings them back", sandboxed, async t => {
  const { root, runner, asked } = await service(t);
  const id = "packed-session";
  const session = await runner.provision(binding(id), await ticket(id, "create"));
  await write(session, "kept.txt", "kept");
  const sandbox = join(root, "sessions", id, "sandbox");
  await mkdir(join(sandbox, "home", ".cache", "pip"), { recursive: true });
  await writeFile(join(sandbox, "home", ".cache", "pip", "wheel"), "cached");
  await mkdir(join(sandbox, "home", ".local", "share", "pnpm", "store"), { recursive: true });
  await writeFile(join(sandbox, "home", ".local", "share", "pnpm", "store", "file"), "cached");
  await mkdir(join(sandbox, "home", ".local", "bin"), { recursive: true });
  await writeFile(join(sandbox, "home", ".local", "bin", "tool"), "kept");

  await assert.rejects(runner.pack(id, await ticket(id, "pack", "test:bob")), refusedWith(403, /owner/));
  const [result, again] = await Promise.all([runner.pack(id, await ticket(id, "pack")), runner.pack(id, await ticket(id, "pack"))]);
  assert.equal(result.packed, true);
  assert.ok(result.bytes! > 0 && result.files! >= 3);
  assert.deepEqual(again, { packed: true });
  assert.ok(asked.some(request => request.archived === true && request.permission === "manage"), "authorized as an action on an archived session");
  assert.equal(await exists(sandbox), false);
  assert.equal(await exists(join(root, "sessions", id, PACK_FILE)), true);
  assert.deepEqual(await runner.pack(id, await ticket(id, "pack")), { packed: true }, "packing again changes nothing");

  const packed = await runner.get(id);
  assert.equal(packed.packed, true);
  assert.ok((await packed.view()).entries.some(entry => entry.text.includes("TEST_WRITE kept.txt")));
  const app = createRunnerApp(runner);
  const body = JSON.stringify({ content: "TEST_WRITE again.txt\nno", requestId: "while-packed" });
  const refused = await app.request(`/v1/sessions/${id}/submit`, { method: "POST", body,
    headers: { authorization: `Bearer ${await signToken(await ticket(id, "submit", OWNER, body), SECRET)}`, "content-type": "application/json" } });
  assert.equal(refused.status, 409);
  assert.match((await refused.json() as { error: string }).error, /packed/);
  assert.equal(await exists(sandbox), false, "opening a packed session leaves its sandbox packed");

  const unpack = await app.request(`/v1/sessions/${id}/unpack`, { method: "POST", body: "{}",
    headers: { authorization: `Bearer ${await signToken(await ticket(id, "unpack", OWNER, "{}"), SECRET)}`, "content-type": "application/json" } });
  assert.equal(unpack.status, 200, await unpack.clone().text());
  assert.deepEqual(await unpack.json(), { unpacked: true });
  assert.deepEqual(await runner.unpack(id, await ticket(id, "unpack")), { unpacked: false }, "unpacking again changes nothing");
  assert.equal(await exists(join(root, "sessions", id, PACK_FILE)), false);
  assert.equal(await readFile(join(sandbox, "worktree", "kept.txt"), "utf8"), "kept");
  assert.equal(await readFile(join(sandbox, "home", ".local", "bin", "tool"), "utf8"), "kept");
  assert.equal(await exists(join(sandbox, "home", ".cache")), false);
  assert.equal(await exists(join(sandbox, "home", ".local", "share", "pnpm")), false);
  const reopened = await runner.get(id);
  assert.equal(reopened.packed, false);
  await write(reopened, "after.txt", "works again");
  assert.equal(await readFile(join(sandbox, "worktree", "after.txt"), "utf8"), "works again");
});

test("a session the pack can't keep is refused with its reason and left as it was", sandboxed, async t => {
  const { root, runner } = await service(t);
  const id = "unpackable-session";
  const session = await runner.provision(binding(id), await ticket(id, "create"));
  await write(session, "kept.txt", "kept");
  const worktree = join(root, "sessions", id, "sandbox", "worktree");
  await symlink("kept.txt", join(worktree, "link"));
  await assert.rejects(runner.pack(id, await ticket(id, "pack")), refusedWith(422, /symlinks or special files/));
  assert.equal(await exists(join(root, "sessions", id, PACK_FILE)), false);
  const reopened = await runner.get(id);
  assert.equal(reopened.packed, false);
  await write(reopened, "after.txt", "still works");
  assert.equal(await readFile(join(worktree, "after.txt"), "utf8"), "still works");
});
