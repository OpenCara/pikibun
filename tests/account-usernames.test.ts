import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { app } from "../apps/server/src/index.js";
import { RECENT_SIGN_IN_MS } from "../apps/server/src/authority/password-auth.js";
import { runPasswordCommand } from "../apps/server/src/password-accounts-cli.js";
import type { Env } from "../apps/server/src/types.js";
import type { UserProfile } from "../packages/shared/src/types.js";
import { testDatabase } from "./helpers/control-plane.js";

const origin = "http://localhost:8787";
const password = "correct horse battery";

async function fixture(t: TestContext, overrides: Partial<Env> = {}) {
  const { db, sqlite } = await testDatabase();
  t.after(() => db.close());
  const env: Env = { DB: db, APP_ORIGIN: origin, TEST_AUTH_ENABLED: "true", TEST_AUTH_SECRET: "account-usernames-test-secret-not-for-deployment",
    TEST_AUTH_EXPIRES_AT: new Date(Date.now() + 3600000).toISOString(), VAULT_KEY: Buffer.alloc(32, 7).toString("base64url"),
    GITHUB_CLIENT_ID: "client", GITHUB_CLIENT_SECRET: "secret", PASSWORD_AUTH: "true", SIGNUP: "open", ...overrides };
  let account = { id: 1001, login: "Newcomer" };
  t.mock.method(globalThis, "fetch", async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url === "https://github.com/login/oauth/access_token") return Response.json({ access_token: `gho_${account.id}`, token_type: "bearer" });
    if (url === "https://api.github.com/user") return Response.json({ id: account.id, login: account.login, name: account.login });
    if (url === "https://api.github.com/user/emails?per_page=100") return Response.json([{ email: `${account.login}@example.test`, verified: true, primary: true }]);
    throw new Error(`Unexpected request ${url}`);
  });
  const request = (method: string, path: string, init: { headers?: Record<string, string>; body?: unknown } = {}) =>
    app.request(path, { method, headers: { ...(init.body === undefined ? {} : { "Content-Type": "application/json" }), ...init.headers },
      body: init.body === undefined ? undefined : JSON.stringify(init.body) }, env);
  const cookieOf = (response: Response, name = "test-auth") => (response.headers.get("set-cookie") ?? "").split(/,(?=\s*[\w-]+=)/)
    .map(part => part.trim().split(";")[0]!).find(part => part.startsWith(`${name}=`) && part.length > name.length + 1) ?? "";
  async function github(as: { id: number; login: string }) {
    account = as;
    const start = await request("GET", "/api/auth/github");
    const state = new URL(start.headers.get("location")!).searchParams.get("state")!;
    const callback = await request("GET", `/api/auth/github/callback?code=github-code&state=${state}`, { headers: { Cookie: cookieOf(start, "test-oauth-state") } });
    assert.equal(callback.status, 302);
    return cookieOf(callback);
  }
  async function browser(cookie: string) {
    const csrf = await (await request("GET", "/api/auth/csrf", { headers: { Cookie: cookie } })).json() as { csrfToken: string };
    return { Cookie: cookie, Origin: origin, "X-CSRF-Token": csrf.csrfToken };
  }
  const me = async (cookie: string) => {
    const response = await request("GET", "/api/me", { headers: { Cookie: cookie } });
    return response.status === 200 ? (await response.json() as { user: UserProfile }).user : null;
  };
  const choose = async (cookie: string, body: Record<string, unknown>) => request("POST", "/api/me/username", { headers: await browser(cookie), body });
  const setPassword = async (cookie: string, body: Record<string, unknown>) => request("POST", "/api/me/password", { headers: await browser(cookie), body });
  const removePassword = async (cookie: string, body: Record<string, unknown>) => request("DELETE", "/api/me/password", { headers: await browser(cookie), body });
  const signIn = (username: string, typed: string) => request("POST", "/api/auth/password/login", { headers: { Origin: origin }, body: { username, password: typed } });
  const age = (userId: string) => sqlite.prepare("UPDATE auth_sessions SET created_at = ? WHERE user_id = ?")
    .run(new Date(Date.now() - RECENT_SIGN_IN_MS - 60_000).toISOString(), userId);
  return { env, sqlite, request, cookieOf, github, browser, me, choose, setPassword, removePassword, signIn, age };
}

async function errorCode(response: Response): Promise<string> {
  return (await response.json() as { code: string }).code;
}

test("a new GitHub account must choose a username, which is unique across every account and can't be changed", async t => {
  const f = await fixture(t, { ADMIN_USER_IDS: "password:root" });
  const cookie = await f.github({ id: 1001, login: "Newcomer" });
  const before = await f.me(cookie);
  assert.equal(before?.usernameRequired, true);
  assert.equal(before?.username, null);
  assert.equal(before?.hasPassword, undefined);

  for (const [username, code] of [["n", "invalid_username"], ["new comer", "invalid_username"], ["root", "username_reserved"]] as const) {
    const refused = await f.choose(cookie, { username });
    assert.equal(await errorCode(refused), code, username);
  }
  assert.equal(await errorCode(await f.choose(cookie, { username: "newcomer", extra: true })), "invalid_input");
  assert.equal((await f.request("POST", "/api/auth/password/signup", { headers: { Origin: origin }, body: { username: "alice", password } })).status, 201);
  assert.equal(await errorCode(await f.choose(cookie, { username: "Alice" })), "username_taken");

  const chosen = await f.choose(cookie, { username: "  NewComer " });
  assert.equal(chosen.status, 200);
  const { user } = await chosen.json() as { user: UserProfile };
  assert.equal(user.id, "github:1001");
  assert.equal(user.username, "newcomer");
  assert.equal(user.usernameRequired, undefined);
  assert.equal(user.hasPassword, undefined);
  assert.equal(await errorCode(await f.choose(cookie, { username: "another-name" })), "username_set");

  const other = await f.github({ id: 1002, login: "newcomer" });
  assert.equal(await errorCode(await f.choose(other, { username: "newcomer" })), "username_taken");
  const signup = await f.request("POST", "/api/auth/password/signup", { headers: { Origin: origin }, body: { username: "newcomer", password } });
  assert.equal(signup.status, 409);
  assert.equal(await errorCode(signup), "username_taken");
  assert.deepEqual(f.sqlite.prepare("SELECT id, username FROM users ORDER BY id").all().map(row => ({ ...row })),
    [{ id: "github:1001", username: "newcomer" }, { id: "github:1002", username: null }, { id: "password:alice", username: "alice" }]);

  const created = await f.request("POST", "/api/workspaces", { headers: await f.browser(cookie), body: { name: "Team" } });
  const { workspace } = await created.json() as { workspace: { id: string } };
  const members = await (await f.request("GET", `/api/workspaces/${workspace.id}/members`, { headers: { Cookie: cookie } })).json() as { members: { userId: string; username: string | null }[] };
  assert.deepEqual(members.members.map(member => [member.userId, member.username]), [["github:1001", "newcomer"]]);
});

test("a username chosen with a password signs the GitHub account in with either, and turning passwords off ends the password's sign-ins", async t => {
  const f = await fixture(t);
  const viaGitHub = await f.github({ id: 1001, login: "Newcomer" });
  assert.equal(await errorCode(await f.choose(viaGitHub, { username: "newcomer", password: "short" })), "weak_password");
  assert.equal(await errorCode(await f.choose(viaGitHub, { username: "newcomer", password: "NewComer" })), "weak_password");
  assert.equal((await f.me(viaGitHub))?.username, null, "a refused password leaves the username unchosen");
  const chosen = await f.choose(viaGitHub, { username: "newcomer", password });
  assert.equal(chosen.status, 200);
  assert.equal((await chosen.json() as { user: UserProfile }).user.hasPassword, true);

  const signedIn = await f.signIn("NewComer", password);
  assert.equal(signedIn.status, 200);
  const signedInUser = (await signedIn.json() as { user: UserProfile }).user;
  assert.equal(signedInUser.id, "github:1001");
  assert.equal(signedInUser.passwordSignIn, undefined, "still a GitHub account");
  const viaPassword = f.cookieOf(signedIn);
  assert.equal((await f.me(viaPassword))?.id, "github:1001");
  assert.equal((await f.signIn("newcomer", "not the password at all")).status, 401);
  const native = await f.request("POST", "/api/auth/native/password", { body: { username: "newcomer", password, deviceName: "Newcomer's Android" } });
  assert.equal(native.status, 200);
  const { token, user: nativeUser } = await native.json() as { token: string; user: UserProfile };
  assert.equal(nativeUser.id, "github:1001");
  const bearer = { Authorization: `Bearer ${token}` };
  assert.equal((await f.request("GET", "/api/me", { headers: bearer })).status, 200);

  f.env.PASSWORD_AUTH = "false";
  assert.equal(await f.me(viaPassword), null, "the password's sign-in ends at once");
  assert.equal((await f.request("GET", "/api/me", { headers: bearer })).status, 401, "the app's too");
  assert.equal((await f.me(viaGitHub))?.id, "github:1001", "GitHub's goes on");
  assert.equal((await f.signIn("newcomer", password)).status, 404);
});

test("setting, changing and replacing a GitHub account's password takes its current password or a recent GitHub sign-in", async t => {
  const f = await fixture(t);
  const first = await f.github({ id: 1001, login: "Newcomer" });
  assert.equal(await errorCode(await f.setPassword(first, { newPassword: password })), "username_required");
  f.age("github:1001");
  const stale = await f.choose(first, { username: "newcomer", password });
  assert.equal(stale.status, 403);
  assert.equal(await errorCode(stale), "recent_sign_in_required");
  assert.equal((await f.me(first))?.username, null);
  assert.equal((await f.choose(first, { username: "newcomer" })).status, 200);
  assert.equal(await errorCode(await f.setPassword(first, { newPassword: password })), "recent_sign_in_required");

  const fresh = await f.github({ id: 1001, login: "Newcomer" });
  assert.equal(await errorCode(await f.setPassword(fresh, { currentPassword: "nothing to give", newPassword: password })), "invalid_input");
  const set = await f.setPassword(fresh, { newPassword: password });
  assert.equal(set.status, 200);
  assert.equal((await set.json() as { user: UserProfile }).user.hasPassword, true);
  assert.equal((await f.me(first))?.id, "github:1001", "setting the first password signs nobody out");
  const viaPassword = f.cookieOf(await f.signIn("newcomer", password));

  f.age("github:1001");
  assert.equal(await errorCode(await f.setPassword(fresh, { newPassword: "a brand new passphrase" })), "recent_sign_in_required");
  assert.equal(await errorCode(await f.setPassword(fresh, { currentPassword: "not my password!", newPassword: "a brand new passphrase" })), "invalid_credentials");
  assert.equal(await errorCode(await f.setPassword(viaPassword, { newPassword: "a brand new passphrase" })), "recent_sign_in_required",
    "a sign-in with the password is no proof without it");
  assert.equal((await f.setPassword(fresh, { currentPassword: password, newPassword: "a brand new passphrase" })).status, 200);
  assert.equal(await f.me(viaPassword), null, "a change signs out every other sign-in");
  assert.equal(await f.me(first), null);
  assert.equal((await f.me(fresh))?.hasPassword, true);
  assert.equal((await f.signIn("newcomer", password)).status, 401);

  const again = await f.github({ id: 1001, login: "Newcomer" });
  assert.equal((await f.setPassword(again, { newPassword: "forgot it, here's another" })).status, 200);
  assert.equal((await f.signIn("newcomer", "forgot it, here's another")).status, 200);
  const audit = f.sqlite.prepare("SELECT action FROM audit WHERE actor_id = 'github:1001' AND action LIKE 'account.%' ORDER BY created_at, rowid").all().map(row => row.action);
  assert.deepEqual(audit, ["account.username.chosen", "account.password.set", "account.password.changed", "account.password.changed"]);
});

test("failed sign-ins lock only the password: a recent GitHub sign-in still replaces or removes it", async t => {
  const f = await fixture(t);
  const first = await f.github({ id: 1001, login: "Newcomer" });
  assert.equal((await f.choose(first, { username: "newcomer", password })).status, 200);
  for (let attempt = 0; attempt < 6; attempt++) await f.signIn("newcomer", "someone guessing " + attempt);
  assert.equal(await errorCode(await f.signIn("newcomer", password)), "sign_in_locked");
  const fresh = await f.github({ id: 1001, login: "Newcomer" });
  assert.equal(await errorCode(await f.setPassword(fresh, { currentPassword: password, newPassword: "a brand new passphrase" })), "sign_in_locked");
  assert.equal(await errorCode(await f.removePassword(fresh, { currentPassword: password })), "sign_in_locked");
  f.age("github:1001");
  assert.equal(await errorCode(await f.setPassword(fresh, { newPassword: "a brand new passphrase" })), "recent_sign_in_required");
  const again = await f.github({ id: 1001, login: "Newcomer" });
  assert.equal((await f.setPassword(again, { newPassword: "a brand new passphrase" })).status, 200);
  assert.equal((await f.signIn("newcomer", "a brand new passphrase")).status, 200);
  for (let attempt = 0; attempt < 6; attempt++) await f.signIn("newcomer", "someone guessing " + attempt);
  const last = await f.github({ id: 1001, login: "Newcomer" });
  const removed = await f.removePassword(last, {});
  assert.equal(removed.status, 200);
  assert.equal((await removed.json() as { user: UserProfile }).user.hasPassword, undefined);
});

test("a GitHub account can remove its password; a password account can't", async t => {
  const f = await fixture(t);
  const viaGitHub = await f.github({ id: 1001, login: "Newcomer" });
  assert.equal((await f.choose(viaGitHub, { username: "newcomer", password })).status, 200);
  const viaPassword = f.cookieOf(await f.signIn("newcomer", password));
  const secondPassword = f.cookieOf(await f.signIn("newcomer", password));
  f.age("github:1001");
  assert.equal(await errorCode(await f.removePassword(viaGitHub, {})), "recent_sign_in_required");
  assert.equal(await errorCode(await f.removePassword(viaGitHub, { currentPassword: "not my password!" })), "invalid_credentials");
  const removed = await f.removePassword(viaPassword, { currentPassword: password });
  assert.equal(removed.status, 200);
  assert.equal((await removed.json() as { user: UserProfile }).user.hasPassword, undefined);
  assert.equal(await f.me(secondPassword), null, "other password sign-ins end");
  assert.equal((await f.me(viaPassword))?.id, "github:1001", "this one goes on");
  assert.equal((await f.me(viaGitHub))?.id, "github:1001", "GitHub's go on");
  assert.equal((await f.signIn("newcomer", password)).status, 401);
  assert.equal(await errorCode(await f.removePassword(viaGitHub, { currentPassword: password })), "no_password");

  const account = f.cookieOf(await f.request("POST", "/api/auth/password/signup", { headers: { Origin: origin }, body: { username: "alice", password } }));
  assert.equal(await errorCode(await f.removePassword(account, { currentPassword: password })), "password_required");
  assert.equal(await errorCode(await f.setPassword(account, { newPassword: "a brand new passphrase" })), "invalid_credentials");
});

test("without passwords a username is still chosen, alone; a local server's owner isn't asked for one", async t => {
  const f = await fixture(t, { PASSWORD_AUTH: "false" });
  const cookie = await f.github({ id: 1001, login: "Newcomer" });
  assert.equal((await f.me(cookie))?.usernameRequired, true);
  assert.equal(await errorCode(await f.choose(cookie, { username: "newcomer", password })), "password_auth_off");
  assert.equal((await f.choose(cookie, { username: "newcomer" })).status, 200);
  assert.equal((await f.me(cookie))?.usernameRequired, undefined);
  const local = await fixture(t, { PASSWORD_AUTH: "false" });
  const owner = await local.github({ id: 2001, login: "owner" });
  local.env.LOCAL_MODE = "true";
  local.env.LOCAL_CLAIM_SECRET = "c".repeat(43);
  local.env.LOCAL_OWNER_ID = "github:2001";
  assert.equal((await local.me(owner))?.usernameRequired, undefined);
});

test("the operator resets a GitHub account's password by its username, too", async t => {
  const f = await fixture(t);
  const cookie = await f.github({ id: 1001, login: "Newcomer" });
  assert.equal((await f.choose(cookie, { username: "newcomer", password })).status, 200);
  assert.match(await runPasswordCommand(f.env.DB, {}, { kind: "reset-password", username: "NewComer" }, async () => "the operator's new passphrase"),
    /set a new password for github:1001 and signed it out everywhere/);
  assert.equal(await f.me(cookie), null);
  assert.equal((await f.signIn("newcomer", "the operator's new passphrase")).status, 200);
  const nobody = await f.github({ id: 1002, login: "other" });
  assert.equal((await f.choose(nobody, { username: "other" })).status, 200);
  await assert.rejects(runPasswordCommand(f.env.DB, {}, { kind: "reset-password", username: "other" }, async () => "the operator's new passphrase"), /no password account password:other/);
});
