import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, rm, stat, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { ConfigurationError, loadConfig } from "../apps/server/src/config.js";
import { app } from "../apps/server/src/index.js";
import { startLocalHost } from "../apps/server/src/local/host.js";
import { startLocalServer } from "../apps/server/src/local/launch.js";
import { loadLocalState, LocalStateError, openLocalState, peekLocalState } from "../apps/server/src/local/state.js";
import type { Env } from "../apps/server/src/types.js";
import { createFauxLocalModels } from "../apps/runner/src/local-pi.js";
import { testDatabase } from "./helpers/control-plane.js";

const claimSecret = "c".repeat(43);
const origin = "http://127.0.0.1:7878";

async function directory(t: TestContext): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "pikibun-local-"));
  t.after(() => rm(path, { recursive: true, force: true }));
  return path;
}

test("a local server's state is created once, owner-only, and keeps its secrets as its GitHub app and port change", async t => {
  const stateDir = join(await directory(t), "server");
  const first = await loadLocalState(stateDir);
  assert.equal(first.port, 7878);
  assert.equal(first.github, undefined);
  for (const value of [first.sessionSecret, first.vaultKey, first.claimSecret]) assert.match(value, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(new Set([first.sessionSecret, first.vaultKey, first.claimSecret]).size, 3);
  assert.equal((await stat(stateDir)).mode & 0o777, 0o700);
  assert.equal((await stat(join(stateDir, "server.json"))).mode & 0o777, 0o600);

  const github = { clientId: "Ov23liAbCdEf", clientSecret: "0123456789abcdef0123456789abcdef01234567" };
  const changed = await loadLocalState(stateDir, { github, port: 9000 });
  assert.deepEqual(changed, { ...first, github, port: 9000 });
  assert.deepEqual(await loadLocalState(stateDir), changed);

  await assert.rejects(loadLocalState(stateDir, { github: { clientId: "has space", clientSecret: "x" } }), LocalStateError);
  await assert.rejects(loadLocalState(stateDir, { port: 80 }), LocalStateError);
  await writeFile(join(stateDir, "server.json"), "{}", { mode: 0o600 });
  await assert.rejects(loadLocalState(stateDir), /damaged/);
});

test("processes creating a local server's state at once all get the same secrets", async t => {
  const stateDir = join(await directory(t), "server");
  const states = await Promise.all(Array.from({ length: 8 }, () => loadLocalState(stateDir)));
  for (const state of states) assert.deepEqual(state, states[0]);
  assert.deepEqual(await loadLocalState(stateDir), states[0]);
  // Concurrent changes are each applied to the state the last one left.
  const github = { clientId: "Ov23liAbCdEf", clientSecret: "0123456789abcdef0123456789abcdef01234567" };
  await Promise.all([loadLocalState(stateDir, { github }), loadLocalState(stateDir, { port: 9001 })]);
  assert.deepEqual(await loadLocalState(stateDir), { ...states[0], github, port: 9001 });
});

test("a running local server holds its state's lease: another can't open it, a left-over lock file doesn't stop the next", async t => {
  const stateDir = join(await directory(t), "server");
  // A lock file a crashed holder left: the kernel lock it named went with that process.
  await mkdir(stateDir, { recursive: true, mode: 0o700 });
  await writeFile(join(stateDir, "runner.lock"), "4242", { mode: 0o600 });
  const held = await openLocalState(stateDir);
  t.after(() => held.release());
  await assert.rejects(openLocalState(stateDir), /already running with this state directory/);
  // Reading it needs no lease, and creates nothing.
  assert.deepEqual(await peekLocalState(stateDir), held.state);
  assert.equal(await peekLocalState(join(stateDir, "other")), undefined);
  await held.release();
  assert.deepEqual(await loadLocalState(stateDir), held.state);
});

test("a local server refuses state others could read or that a symlink points to", async t => {
  const parent = await directory(t);
  const stateDir = join(parent, "server");
  await loadLocalState(stateDir);
  await chmod(join(stateDir, "server.json"), 0o644);
  await assert.rejects(loadLocalState(stateDir), /mode 0600/);
  await chmod(join(stateDir, "server.json"), 0o600);
  await chmod(stateDir, 0o755);
  await assert.rejects(loadLocalState(stateDir), /mode 0700/);
  await chmod(stateDir, 0o700);
  await symlink(stateDir, join(parent, "link"));
  await assert.rejects(loadLocalState(join(parent, "link")), /not a symlink/);
});

test("LOCAL_MODE listens on loopback only and needs its claim secret", async () => {
  const base = { APP_ORIGIN: origin, SESSION_SECRET: "s".repeat(32), VAULT_KEY: Buffer.alloc(32, 1).toString("base64url"), DATABASE_URL: "sqlite::memory:" };
  const refused = async (settings: Record<string, string>, message: RegExp) => {
    await assert.rejects(loadConfig({ ...base, ...settings }), (error: unknown) => error instanceof ConfigurationError && message.test(error.message));
  };
  await refused({ LOCAL_MODE: "true" }, /LOCAL_CLAIM_SECRET/);
  await refused({ LOCAL_MODE: "true", LOCAL_CLAIM_SECRET: claimSecret, HOST: "0.0.0.0" }, /loopback only/);
  await refused({ LOCAL_MODE: "true", LOCAL_CLAIM_SECRET: claimSecret, APP_ORIGIN: "https://pikibun.example.com" }, /on this machine/);
  await refused({ LOCAL_MODE: "yes" }, /"true" or "false"/);
  const config = await loadConfig({ ...base, LOCAL_MODE: "true", LOCAL_CLAIM_SECRET: claimSecret });
  assert.equal(config.host, "127.0.0.1");
  await config.env.CONNECTOR_HUB?.close();
  await config.env.DB.close();
});

/** GitHub's token exchange, user and verified email: the account signing in is `account.id`. */
async function localFixture(t: TestContext, local = true) {
  const { db, sqlite, setBeforeQuery } = await testDatabase();
  t.after(() => db.close());
  const env: Env = { DB: db, APP_ORIGIN: origin, VAULT_KEY: Buffer.alloc(32, 7).toString("base64url"),
    GITHUB_CLIENT_ID: "local-client", GITHUB_CLIENT_SECRET: "local-secret",
    ...(local ? { LOCAL_MODE: "true", LOCAL_CLAIM_SECRET: claimSecret } : {}) };
  const account = { id: 4242, login: "octo" };
  t.mock.method(globalThis, "fetch", async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url === "https://github.com/login/oauth/access_token") return Response.json({ access_token: `gho_${account.id}`, token_type: "bearer" });
    if (url === "https://api.github.com/user") return Response.json({ id: account.id, login: account.login, name: account.login });
    if (url === "https://api.github.com/user/emails?per_page=100") return Response.json([{ email: `${account.login}@example.test`, verified: true, primary: true }]);
    throw new Error(`Unexpected request ${url}`);
  });
  const request = (path: string, headers: Record<string, string> = {}) => app.request(path, { headers }, env);
  const cookies = (response: Response) => response.headers.getSetCookie().map(cookie => cookie.split(";")[0]!).filter(cookie => !cookie.endsWith("="));
  /** Starts at `start` (the claim link or "Continue with GitHub") and comes back through GitHub's callback. */
  async function signIn(start: string) {
    const begun = await request(start);
    if (begun.status !== 302) return begun;
    const state = new URL(begun.headers.get("location")!).searchParams.get("state")!;
    return request(`/api/auth/github/callback?code=github-code&state=${state}`, { Cookie: cookies(begun).join("; ") });
  }
  const health = async () => (await (await request("/api/health")).json() as { localServer?: { claimed: boolean } }).localServer;
  return { env, sqlite, setBeforeQuery, account, request, signIn, health, cookies };
}

const errorCode = async (response: Response) => (await response.json() as { code: string }).code;

test("two claims at once leave one owner: the later sign-in is undone before its token is stored", async t => {
  const f = await localFixture(t);
  // Another claim's user is written between this callback's owner check and its own user's insert.
  let raced = false;
  f.setBeforeQuery(sql => {
    if (raced || !sql.trimStart().startsWith("INSERT INTO users")) return;
    raced = true;
    f.sqlite.prepare(`INSERT INTO users (id, github_id, github_login, display_name, git_name, git_email, env_json, auth_kind, created_at)
      VALUES ('github:1', '1', 'early', 'Early', 'Early', 'e@example.test', '{}', 'github', '2000-01-01T00:00:00.000Z')`).run();
  });
  const late = await f.signIn(`/api/auth/local/claim?token=${claimSecret}`);
  assert.ok(raced);
  assert.equal(late.status, 403);
  assert.equal(await errorCode(late), "local_server_owner_only");
  assert.deepEqual(f.sqlite.prepare("SELECT id FROM users").all().map(row => row.id), ["github:1"]);
  assert.equal(f.sqlite.prepare("SELECT COUNT(*) AS n FROM github_tokens").get()!.n, 0);
  assert.equal(f.sqlite.prepare("SELECT COUNT(*) AS n FROM auth_sessions").get()!.n, 0);
});

test("a local server admits the GitHub account that claims it with its sign-in link, and no one else", async t => {
  const f = await localFixture(t);
  assert.deepEqual(await f.health(), { claimed: false });

  // "Continue with GitHub" can't claim it: only the launcher's link can.
  const unclaimed = await f.signIn("/api/auth/github");
  assert.equal(unclaimed.status, 403);
  assert.equal(await errorCode(unclaimed), "local_server_unclaimed");
  assert.equal(f.sqlite.prepare("SELECT COUNT(*) AS n FROM users").get()!.n, 0);
  assert.equal(f.sqlite.prepare("SELECT COUNT(*) AS n FROM github_tokens").get()!.n, 0);

  const wrong = await f.request(`/api/auth/local/claim?token=${"x".repeat(43)}`);
  assert.equal(wrong.status, 403);
  assert.equal(await errorCode(wrong), "invalid_claim");

  const claimed = await f.signIn(`/api/auth/local/claim?token=${claimSecret}`);
  assert.equal(claimed.status, 302);
  assert.equal(claimed.headers.get("location"), `${origin}/`);
  // The claim cookie ends with the sign-in.
  assert.ok(claimed.headers.getSetCookie().some(cookie => cookie.startsWith("local-claim=;")));
  const session = f.cookies(claimed).find(cookie => cookie.startsWith("test-auth="))!;
  assert.equal((await f.request("/api/me", { Cookie: session })).status, 200);
  assert.deepEqual(await f.health(), { claimed: true });

  // Another GitHub account is refused, even with the link, and its token is never kept.
  f.account.id = 5151; f.account.login = "mallory";
  for (const start of ["/api/auth/github", `/api/auth/local/claim?token=${claimSecret}`]) {
    const other = await f.signIn(start);
    assert.equal(other.status, 403);
    assert.equal(await errorCode(other), "local_server_owner_only");
  }
  assert.deepEqual(f.sqlite.prepare("SELECT user_id FROM github_tokens").all().map(row => row.user_id), ["github:4242"]);

  // The owner signs in again as on any server.
  f.account.id = 4242; f.account.login = "octo";
  assert.equal((await f.signIn("/api/auth/github")).status, 302);
});

test("a server outside local mode has no claim link and says nothing of one", async t => {
  const f = await localFixture(t, false);
  assert.equal(await f.health(), undefined);
  assert.equal((await f.request(`/api/auth/local/claim?token=${claimSecret}`)).status, 404);
});

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as { port: number };
  await new Promise(resolve => server.close(resolve));
  return port;
}

test("a relative state directory still names its database and backups correctly", async t => {
  const parent = await directory(t);
  const previous = process.cwd();
  process.chdir(parent);
  t.after(() => process.chdir(previous));
  const state = await loadLocalState("server", { port: await freePort() });
  const web = join(parent, "web");
  await mkdir(web, { recursive: true });
  await writeFile(join(web, "index.html"), "<!doctype html>");
  await writeFile(join(web, "nsh.0123456789.wasm"), new Uint8Array([0, 97, 115, 109]));
  const server = await startLocalServer({ stateDir: "server", state, staticDir: web });
  await server.close();
  assert.ok((await stat(join(parent, "server", "pikibun.sqlite"))).isFile());
  assert.ok((await stat(join(parent, "server", "backups"))).isDirectory());
});

test("pikibun serve's server pairs this computer as its owner's host once claimed, and reuses that pairing", async t => {
  const stateDir = join(await directory(t), "server");
  const state = await loadLocalState(stateDir, { port: await freePort() });
  const web = await directory(t);
  await writeFile(join(web, "index.html"), "<!doctype html><title>Pikibun</title>");
  await writeFile(join(web, "nsh.0123456789.wasm"), new Uint8Array([0, 97, 115, 109]));
  // Test mode lets the host offer the fixture model; everything else is the local server as `pikibun serve` runs it.
  const testMode = { TEST_AUTH_ENABLED: "true", TEST_AUTH_SECRET: "t".repeat(43), TEST_AUTH_EXPIRES_AT: new Date(Date.now() + 3600_000).toISOString() };
  const hostOptions = {
    localModels: createFauxLocalModels("faux-1"), allowFaux: true, unsandboxed: true, pollMs: 50,
    acquireLease: () => Promise.resolve(() => Promise.resolve()),
    runtimeFactory: () => Promise.resolve({ fetch: () => Response.json({ ok: true }), close: () => Promise.resolve() }),
  };
  const server = await startLocalServer({ stateDir, state, staticDir: web, extraEnv: testMode });
  t.after(() => server.close());
  assert.equal(server.origin, `http://127.0.0.1:${state.port}`);
  assert.match(await (await fetch(server.origin)).text(), /<title>Pikibun<\/title>/);
  assert.equal(await server.claimUrl(), `${server.origin}/api/auth/local/claim?token=${state.claimSecret}`);

  let waiting = false;
  const host = startLocalHost(server, stateDir, { ...hostOptions, onWaiting: () => { waiting = true; } });
  t.after(() => host.stop());
  await new Promise(resolve => setTimeout(resolve, 150));
  assert.ok(waiting);
  const connectors = () => server.env.DB.query<{ id: string; owner_id: string }>("SELECT id, owner_id FROM connectors WHERE revoked_at IS NULL").all();
  assert.deepEqual(await connectors(), []);

  // Someone claims it (the sign-in above, here written directly): the host pairs itself for them, with no code to copy.
  await server.env.DB.query(`INSERT INTO users (id, github_id, github_login, display_name, git_name, git_email, env_json, auth_kind, created_at)
    VALUES ('github:4242', '4242', 'octo', 'Octo', 'Octo', 'octo@example.test', '{}', 'github', ?)`).bind(new Date().toISOString()).run();
  await host.started;
  const [paired] = await connectors();
  assert.equal(paired?.owner_id, "github:4242");
  assert.equal(await server.claimUrl(), null);
  await host.stop();

  // The next start reuses the saved pairing.
  const again = startLocalHost(server, stateDir, hostOptions);
  t.after(() => again.stop());
  await again.started;
  assert.deepEqual((await connectors()).map(row => row.id), [paired!.id]);
});

const sharedBase = { origin: "https://pikibun.example.test", listen: "loopback" as const, trustProxy: true, signup: "invite" as const, passwordAuth: true, admins: ["password:admin", "github:4242"] };

test("sharing settings are checked field by field, saved with the state, and keep their GitHub OAuth app until replaced", async t => {
  const stateDir = join(await directory(t), "server");
  const first = await loadLocalState(stateDir);
  for (const [shared, message] of [
    [{ ...sharedBase, origin: "http://pikibun.example.test" }, /HTTPS/],
    [{ ...sharedBase, origin: "https://pikibun.example.test/app" }, /origin/],
    [{ ...sharedBase, admins: [] }, /at least one administrator/],
    [{ ...sharedBase, admins: ["octocat"] }, /user IDs/],
    [{ ...sharedBase, admins: ["github:1", "github:1"] }, /twice/],
    [{ ...sharedBase, passwordAuth: false }, /way to sign in/],
    [{ ...sharedBase, signup: "anyone" }, /create an account/],
    [{ ...sharedBase, listen: "lan" }, /listens/],
    [{ ...sharedBase, extra: 1 }, /unknown/],
  ] as const) {
    await assert.rejects(loadLocalState(stateDir, { shared: shared as never }), message, JSON.stringify(shared));
  }
  assert.deepEqual(await loadLocalState(stateDir), first);
  const github = { clientId: "Ov23liShared", clientSecret: "0123456789abcdef0123456789abcdef01234567" };
  const saved = await loadLocalState(stateDir, { shared: { ...sharedBase, passwordAuth: false, admins: ["github:4242"], github } });
  assert.deepEqual(saved.shared, { ...sharedBase, passwordAuth: false, admins: ["github:4242"], github });
  // The loopback GitHub app and the secrets are untouched; a later change without an app keeps the saved one.
  assert.deepEqual({ ...saved, shared: undefined }, { ...first, shared: undefined });
  const changed = await loadLocalState(stateDir, { shared: { ...sharedBase, signup: "open" } });
  assert.deepEqual(changed.shared, { ...sharedBase, signup: "open", github });
  assert.deepEqual(await peekLocalState(stateDir), changed);
});

test("shared, the same state serves others at its public origin: no claim link, its administrators own this computer's host", async t => {
  const stateDir = join(await directory(t), "server");
  const port = await freePort();
  await loadLocalState(stateDir, { port });
  const web = await directory(t);
  await writeFile(join(web, "index.html"), "<!doctype html><title>Pikibun</title>");
  await writeFile(join(web, "nsh.0123456789.wasm"), new Uint8Array([0, 97, 115, 109]));
  await assert.rejects(startLocalServer({ stateDir, state: await loadLocalState(stateDir), staticDir: web, mode: "shared" }), /Set up sharing first/);
  const state = await loadLocalState(stateDir, { shared: sharedBase });
  const server = await startLocalServer({ stateDir, state, staticDir: web, mode: "shared" });
  t.after(() => server.close());
  assert.equal(server.mode, "shared");
  assert.equal(server.origin, "https://pikibun.example.test");
  assert.equal(server.address, `http://127.0.0.1:${port}`);
  assert.equal(await server.claimUrl(), null);
  const health = await (await fetch(`${server.address}/api/health`)).json() as Record<string, unknown>;
  assert.deepEqual([health.passwordAuth, health.githubSignup, health.passwordSignup, health.localServer], [true, "invite", "invite", undefined]);

  // Nobody has an account yet: this computer's host waits. The first listed administrator with one owns it.
  assert.equal(await server.owner(), null);
  await server.env.DB.query(`INSERT INTO users (id, github_id, github_login, display_name, git_name, git_email, env_json, auth_kind, created_at)
    VALUES ('github:4242', '4242', 'octo', 'Octo', 'Octo', 'octo@example.test', '{}', 'github', ?)`).bind(new Date().toISOString()).run();
  assert.deepEqual(await server.owner(), { id: "github:4242" });
  await assert.rejects(server.createAdmin("someone", "a long enough password"), /administrators/);
  await assert.rejects(server.createAdmin("admin", "short"), /12/);
  assert.match(await server.createAdmin("Admin", "a long enough password"), /Created the administrator password:admin: sign in at https:\/\/pikibun.example.test with the username admin/);
  await assert.rejects(server.createAdmin("admin", "a long enough password"), /exists already/);
  assert.deepEqual(await server.owner(), { id: "password:admin" });
});

test("pikibun serve --share takes its settings from the options once, then from the saved state", async () => {
  const { sharedSettings } = await import("../apps/server/src/local/cli.js");
  assert.throws(() => sharedSettings(undefined, {}), /--public-origin/);
  assert.throws(() => sharedSettings(undefined, { "public-origin": "https://pikibun.example.test" }), /--admin/);
  assert.throws(() => sharedSettings(undefined, { "public-origin": "http://pikibun.example.test", admin: ["github:1"] }), /HTTPS/);
  assert.throws(() => sharedSettings(undefined, { "public-origin": "https://pikibun.example.test", admin: ["github:1"], listen: "lan" }), /--listen/);
  const first = sharedSettings(undefined, { "public-origin": "https://pikibun.example.test/", admin: ["github:1"] });
  assert.deepEqual(first, { origin: "https://pikibun.example.test", admins: ["github:1"], listen: "loopback", signup: "invite", trustProxy: false, passwordAuth: false });
  assert.deepEqual(sharedSettings({ ...first, signup: "open", passwordAuth: true }, { listen: "all" }),
    { ...first, signup: "open", passwordAuth: true, listen: "all" });
});

test("after serving others, running for its owner alone admits only the pinned owner: teammates' sign-ins and hosts are refused", async t => {
  const { newSession } = await import("../apps/server/src/authority/auth.js");
  const { authenticateConnectorToken } = await import("../apps/server/src/authority/hosts.js");
  const { sha256 } = await import("../packages/shared/src/crypto.js");
  const f = await localFixture(t, false);
  // Test mode lets this plain-HTTP origin serve outside local mode, as the shared server does behind its proxy.
  Object.assign(f.env, { TEST_AUTH_ENABLED: "true", TEST_AUTH_SECRET: "t".repeat(43), TEST_AUTH_EXPIRES_AT: new Date(Date.now() + 3600_000).toISOString() });
  // Shared, a teammate's account is created before the owner's: the first GitHub user is no longer the owner.
  const user = (id: number, at: string) => f.sqlite.prepare(`INSERT INTO users (id, github_id, github_login, display_name, git_name, git_email, env_json, auth_kind, created_at)
    VALUES (?, ?, ?, ?, ?, ?, '{}', 'github', ?)`).run(`github:${id}`, String(id), `u${id}`, `U${id}`, `U${id}`, `u${id}@example.test`, at);
  user(5151, "2000-01-01T00:00:00.000Z");
  user(4242, "2001-01-01T00:00:00.000Z");
  const signIn = async (userId: string) => {
    const session = await newSession(f.env, userId, "github");
    await session.statement.run();
    return `test-auth=${session.token}`;
  };
  const teammate = await signIn("github:5151");
  const owner = await signIn("github:4242");
  const token = "h".repeat(43);
  f.sqlite.prepare(`INSERT INTO connectors (id, owner_id, name, credential_hash, created_at, models_json, capabilities_json) VALUES ('c1', 'github:5151', 'Theirs', ?, ?, '[]', '{}')`)
    .run(await sha256(token), new Date().toISOString());
  assert.equal((await f.request("/api/me", { Cookie: teammate })).status, 200);
  assert.equal((await authenticateConnectorToken(f.env, token)).id, "c1");

  // For its owner alone again, with the owner pinned: only they sign in, and only their hosts connect.
  Object.assign(f.env, { LOCAL_MODE: "true", LOCAL_CLAIM_SECRET: claimSecret, LOCAL_OWNER_ID: "github:4242" });
  assert.equal((await f.request("/api/me", { Cookie: teammate })).status, 401);
  assert.equal((await f.request("/api/me", { Cookie: owner })).status, 200);
  await assert.rejects(authenticateConnectorToken(f.env, token), (error: { status?: number }) => error.status === 401);
  assert.deepEqual(await f.health(), { claimed: true });
});

test("running for its owner alone after sharing pins its owner: the one recorded at the first share, else its first GitHub administrator", async t => {
  const stateDir = join(await directory(t), "server");
  const web = await directory(t);
  await writeFile(join(web, "index.html"), "<!doctype html><title>Pikibun</title>");
  await writeFile(join(web, "nsh.0123456789.wasm"), new Uint8Array([0, 97, 115, 109]));
  await loadLocalState(stateDir, { port: await freePort() });
  const shared = { ...sharedBase, admins: ["github:4242", "password:admin"] };
  const insert = (env: Env, id: number) => env.DB.query(`INSERT INTO users (id, github_id, github_login, display_name, git_name, git_email, env_json, auth_kind, created_at)
    VALUES (?, ?, 'u', 'U', 'U', 'u@example.test', '{}', 'github', ?)`).bind(`github:${id}`, String(id), new Date(Date.UTC(2000, 0, id % 1000)).toISOString()).run();

  // Shared before anyone claimed it; a teammate signs up first, then the administrator.
  let { state, release } = await openLocalState(stateDir, { shared });
  let server = await startLocalServer({ stateDir, state, release, staticDir: web, mode: "shared" });
  await insert(server.env, 5151);
  await insert(server.env, 4242);
  await server.close();
  assert.equal((await peekLocalState(stateDir))?.owner, undefined);
  // Shared again (a relaunch, say): its first GitHub user is a teammate now, and nothing is pinned.
  ({ state, release } = await openLocalState(stateDir));
  server = await startLocalServer({ stateDir, state, release, staticDir: web, mode: "shared" });
  await server.close();
  assert.deepEqual([(await peekLocalState(stateDir))?.owner, (await peekLocalState(stateDir))?.sharedOnce], [undefined, true]);

  // For the owner alone: the listed GitHub administrator, not the first GitHub user, owns it, and stays pinned.
  ({ state, release } = await openLocalState(stateDir));
  server = await startLocalServer({ stateDir, state, release, staticDir: web });
  t.after(() => server.close());
  assert.equal(server.env.LOCAL_OWNER_ID, "github:4242");
  assert.deepEqual(await server.owner(), { id: "github:4242", github_id: "4242" });
  assert.equal((await peekLocalState(stateDir))?.owner, "github:4242");
});

test("this computer pairs again for a shared server's new owner, and keeps the pairing while the owner stays", async t => {
  const stateDir = join(await directory(t), "server");
  const state = await loadLocalState(stateDir, { port: await freePort() });
  const web = await directory(t);
  await writeFile(join(web, "index.html"), "<!doctype html><title>Pikibun</title>");
  await writeFile(join(web, "nsh.0123456789.wasm"), new Uint8Array([0, 97, 115, 109]));
  const testMode = { TEST_AUTH_ENABLED: "true", TEST_AUTH_SECRET: "t".repeat(43), TEST_AUTH_EXPIRES_AT: new Date(Date.now() + 3600_000).toISOString() };
  const local = await startLocalServer({ stateDir, state, staticDir: web, extraEnv: testMode });
  t.after(() => local.close());
  for (const name of ["alice", "bob"]) {
    await local.env.DB.query(`INSERT INTO users (id, github_id, github_login, display_name, git_name, git_email, env_json, auth_kind, created_at)
      VALUES (?, NULL, ?, ?, ?, ?, '{}', 'test', ?)`).bind(`test:${name}`, name, name, name, `${name}@example.test`, new Date().toISOString()).run();
  }
  // The server as shared: the same origin, whose owner (its first administrator with an account) changes.
  let owner = "test:alice";
  const shared = { ...local, mode: "shared" as const, owner: async () => ({ id: owner }) };
  const hostOptions = {
    localModels: createFauxLocalModels("faux-1"), allowFaux: true, unsandboxed: true, pollMs: 50,
    acquireLease: () => Promise.resolve(() => Promise.resolve()),
    runtimeFactory: () => Promise.resolve({ fetch: () => Response.json({ ok: true }), close: () => Promise.resolve() }),
  };
  const connectors = () => local.env.DB.query<{ owner_id: string }>("SELECT owner_id FROM connectors WHERE revoked_at IS NULL ORDER BY created_at").all();
  const run = async () => { const host = startLocalHost(shared, stateDir, hostOptions); await host.started; await host.stop(); };
  await run();
  await run();
  assert.deepEqual((await connectors()).map(row => row.owner_id), ["test:alice"]);
  owner = "test:bob";
  await run();
  assert.deepEqual((await connectors()).map(row => row.owner_id).sort(), ["test:alice", "test:bob"]);
  await run();
  assert.equal((await connectors()).length, 2);
});

test("sharing a Pikibun its owner had claimed pins them before anyone else can sign in, and later shares keep them", async t => {
  const stateDir = join(await directory(t), "server");
  const web = await directory(t);
  await writeFile(join(web, "index.html"), "<!doctype html><title>Pikibun</title>");
  await writeFile(join(web, "nsh.0123456789.wasm"), new Uint8Array([0, 97, 115, 109]));
  await loadLocalState(stateDir, { port: await freePort() });
  const insert = (env: Env, id: number, at: string) => env.DB.query(`INSERT INTO users (id, github_id, github_login, display_name, git_name, git_email, env_json, auth_kind, created_at)
    VALUES (?, ?, 'u', 'U', 'U', 'u@example.test', '{}', 'github', ?)`).bind(`github:${id}`, String(id), at).run();
  // Claimed for its owner alone first.
  let { state, release } = await openLocalState(stateDir);
  let server = await startLocalServer({ stateDir, state, release, staticDir: web });
  await insert(server.env, 7777, "2001-01-01T00:00:00.000Z");
  await server.close();
  // Shared: the owner is pinned at once, though a teammate's account then sorts before theirs.
  ({ state, release } = await openLocalState(stateDir, { shared: { ...sharedBase, admins: ["password:admin"] } }));
  server = await startLocalServer({ stateDir, state, release, staticDir: web, mode: "shared" });
  assert.equal((await peekLocalState(stateDir))?.owner, "github:7777");
  await insert(server.env, 5151, "2000-01-01T00:00:00.000Z");
  await server.close();
  ({ state, release } = await openLocalState(stateDir));
  server = await startLocalServer({ stateDir, state, release, staticDir: web, mode: "shared" });
  await server.close();
  ({ state, release } = await openLocalState(stateDir));
  server = await startLocalServer({ stateDir, state, release, staticDir: web });
  t.after(() => server.close());
  assert.equal(server.env.LOCAL_OWNER_ID, "github:7777");
  assert.deepEqual(await server.owner(), { id: "github:7777", github_id: "7777" });
});
