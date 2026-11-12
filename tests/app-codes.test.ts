import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { app } from "../apps/server/src/index.js";
import type { Env } from "../apps/server/src/types.js";
import type { AppSignInCode, AppSignInCodeState, NativeSignIn, SignedInDevice, UserProfile } from "../packages/shared/src/types.js";
import { testDatabase } from "./helpers/control-plane.js";

const origin = "http://localhost:8787";
const password = "correct horse battery";

async function fixture(t: TestContext, overrides: Partial<Env> = {}) {
  const { db, sqlite } = await testDatabase();
  t.after(() => db.close());
  const env: Env = { DB: db, APP_ORIGIN: origin, TEST_AUTH_ENABLED: "true", TEST_AUTH_SECRET: "app-codes-test-secret-not-for-deployment",
    TEST_AUTH_EXPIRES_AT: new Date(Date.now() + 3600000).toISOString(), RUNNER_SHARED_SECRET: "r".repeat(43),
    VAULT_KEY: Buffer.alloc(32, 7).toString("base64url"), PASSWORD_AUTH: "true", SIGNUP: "open", ...overrides };
  const request = (method: string, path: string, init: { headers?: Record<string, string>; body?: unknown } = {}) =>
    app.request(path, { method, headers: { ...(init.body === undefined ? {} : { "Content-Type": "application/json" }), ...init.headers },
      body: init.body === undefined ? undefined : JSON.stringify(init.body) }, env);
  const cookieOf = (response: Response) => response.headers.get("set-cookie")?.split(";")[0] ?? "";
  async function browser(cookie: string) {
    const csrf = await (await request("GET", "/api/auth/csrf", { headers: { Cookie: cookie } })).json() as { csrfToken: string };
    return { Cookie: cookie, Origin: origin, "X-CSRF-Token": csrf.csrfToken };
  }
  async function testUser(id: string) {
    return cookieOf(await request("POST", "/api/auth/test", { headers: { Authorization: `Bearer ${env.TEST_AUTH_SECRET}`, Origin: origin }, body: { id } }));
  }
  const makeCode = async (headers: Record<string, string>, body: Record<string, unknown> = {}) => request("POST", "/api/me/app-codes", { headers, body });
  const redeem = (body: Record<string, unknown>) => request("POST", "/api/auth/native/code", { body });
  return { env, sqlite, request, cookieOf, browser, testUser, makeCode, redeem };
}

async function errorCode(response: Response): Promise<string> {
  return (await response.json() as { code: string }).code;
}

test("a signed-in browser makes a one-use code, and an app exchanges it for a 30-day session of its own", async t => {
  const f = await fixture(t);
  assert.equal((await (await f.request("GET", "/api/health")).json() as { codeSignIn?: boolean }).codeSignIn, true);
  const cookie = await f.testUser("alice");
  const made = await f.makeCode(await f.browser(cookie));
  assert.equal(made.status, 201);
  assert.match(made.headers.get("cache-control") ?? "", /no-store/);
  const code = await made.json() as AppSignInCode;
  assert.match(code.code, /^[A-Za-z0-9_-]{43}$/);
  const link = new URL(code.link);
  assert.equal(`${link.protocol}//${link.host}${link.pathname}`, "pikibun://auth/code");
  assert.deepEqual([link.searchParams.get("server"), link.searchParams.get("code")], [origin, code.code]);
  const expires = Date.parse(code.expiresAt) - Date.now();
  assert.ok(expires > 9 * 60_000 && expires <= 10 * 60_000);
  assert.equal(f.sqlite.prepare("SELECT COUNT(*) AS n FROM app_sign_in_codes WHERE code_hash = ?").get(code.code)!.n, 0, "only the hash is kept");

  const state = async (id: string) => f.request("GET", `/api/me/app-codes/${id}`, { headers: { Cookie: cookie } });
  assert.deepEqual(await (await state(code.id)).json(), { id: code.id, status: "pending", expiresAt: code.expiresAt, deviceName: null });

  const signedIn = await f.redeem({ code: code.code, deviceName: "Alice's MacBook" });
  assert.equal(signedIn.status, 200);
  assert.equal(signedIn.headers.get("set-cookie"), null);
  const answer = await signedIn.json() as NativeSignIn;
  assert.equal(answer.user.id, "test:alice");
  assert.ok(Date.parse(answer.expiresAt) > Date.now() + 50 * 60_000, "a test session lasts as long as test mode");
  const bearer = { Authorization: `Bearer ${answer.token}` };
  assert.equal((await (await f.request("GET", "/api/me", { headers: bearer })).json() as { user: UserProfile }).user.id, "test:alice");
  assert.equal((await f.request("POST", "/api/workspaces", { headers: bearer, body: { name: "From the Mac" } })).status, 201);

  const used = await (await state(code.id)).json() as AppSignInCodeState;
  assert.deepEqual([used.status, used.deviceName], ["used", "Alice's MacBook"]);
  const again = await f.redeem({ code: code.code });
  assert.equal(again.status, 400);
  assert.equal(await errorCode(again), "invalid_grant");

  const devices = await (await f.request("GET", "/api/me/devices", { headers: { Cookie: cookie } })).json() as { devices: SignedInDevice[] };
  assert.deepEqual(devices.devices.map(device => [device.name, device.viaCode]), [["Alice's MacBook", true]]);
  const audit = f.sqlite.prepare("SELECT action FROM audit WHERE actor_id = 'test:alice' AND action LIKE 'account.app_code.%' ORDER BY created_at").all().map(row => row.action);
  assert.deepEqual(audit, ["account.app_code.created", "account.app_code.used"]);

  const other = await f.testUser("bob");
  assert.equal((await f.request("GET", `/api/me/app-codes/${code.id}`, { headers: { Cookie: other } })).status, 404);
});

test("making a code needs a recent sign-in, which a session made from a code never is", async t => {
  const f = await fixture(t);
  const cookie = await f.testUser("carol");
  const first = await (await f.makeCode(await f.browser(cookie))).json() as AppSignInCode;
  const fromCode = await (await f.redeem({ code: first.code, deviceName: "Carol's phone" })).json() as NativeSignIn;
  const refused = await f.makeCode({ Authorization: `Bearer ${fromCode.token}` });
  assert.equal(refused.status, 403);
  assert.equal(await errorCode(refused), "recent_sign_in_required");

  f.sqlite.prepare("UPDATE auth_sessions SET created_at = ? WHERE client = 'browser'").run(new Date(Date.now() - 16 * 60_000).toISOString());
  const stale = await f.makeCode(await f.browser(cookie));
  assert.equal(stale.status, 403);
  assert.equal(await errorCode(stale), "recent_sign_in_required");

  const noCsrf = await f.request("POST", "/api/me/app-codes", { headers: { Cookie: cookie, Origin: origin }, body: {} });
  assert.equal(noCsrf.status, 403);
  assert.equal(await errorCode(noCsrf), "invalid_csrf");
  assert.equal((await f.request("POST", "/api/me/app-codes", { body: {} })).status, 401);
  assert.equal(await errorCode(await f.makeCode(await f.browser(cookie), { currentPassword: password, extra: 1 })), "invalid_input");
});

test("a code lasts ten minutes, five can wait at once, and cancelling one frees its place", async t => {
  const f = await fixture(t);
  const cookie = await f.testUser("dave");
  const codes: AppSignInCode[] = [];
  for (let index = 0; index < 5; index++) {
    const made = await f.makeCode(await f.browser(cookie));
    assert.equal(made.status, 201);
    codes.push(await made.json() as AppSignInCode);
  }
  const sixth = await f.makeCode(await f.browser(cookie));
  assert.equal(sixth.status, 429);
  assert.equal(await errorCode(sixth), "too_many_codes");

  const other = await f.testUser("erin");
  assert.equal((await f.request("DELETE", `/api/me/app-codes/${codes[0]!.id}`, { headers: await f.browser(other) })).status, 404);
  assert.equal((await f.request("DELETE", `/api/me/app-codes/${codes[0]!.id}`, { headers: await f.browser(cookie) })).status, 200);
  assert.equal(await errorCode(await f.redeem({ code: codes[0]!.code })), "invalid_grant");
  assert.equal((await f.makeCode(await f.browser(cookie))).status, 201);

  f.sqlite.prepare("UPDATE app_sign_in_codes SET expires_at = ? WHERE id = ?").run(Date.now() - 1, codes[1]!.id);
  assert.equal(await errorCode(await f.redeem({ code: codes[1]!.code })), "invalid_grant");
  assert.equal((await f.request("GET", `/api/me/app-codes/${codes[1]!.id}`, { headers: { Cookie: cookie } })).status, 404);
  assert.equal((await f.makeCode(await f.browser(cookie))).status, 201, "an expired code makes room");

  for (const body of [{}, { code: "short" }, { code: codes[2]!.code, extra: true }, { code: codes[2]!.code, deviceName: "\u0000" }]) {
    assert.equal((await f.redeem(body)).status, 400);
  }
  assert.equal((await f.redeem({ code: codes[2]!.code, deviceName: null })).status, 200);
});

test("a code dies with the browser session that made it", async t => {
  const f = await fixture(t);
  const cookie = await f.testUser("frank");
  const signedOut = await (await f.makeCode(await f.browser(cookie))).json() as AppSignInCode;
  const expired = await (await f.makeCode(await f.browser(cookie))).json() as AppSignInCode;
  f.sqlite.prepare("UPDATE auth_sessions SET expires_at = ? WHERE client = 'browser'").run(Date.now() - 1);
  assert.equal(await errorCode(await f.redeem({ code: expired.code })), "invalid_grant");
  f.sqlite.prepare("UPDATE auth_sessions SET expires_at = ? WHERE client = 'browser'").run(Date.now() + 3600_000);
  assert.equal((await f.request("POST", "/api/auth/logout", { headers: await f.browser(cookie), body: {} })).status, 200);
  assert.equal(f.sqlite.prepare("SELECT COUNT(*) AS n FROM app_sign_in_codes").get()!.n, 0);
  assert.equal(await errorCode(await f.redeem({ code: signedOut.code })), "invalid_grant");
});

test("a password account makes a code with its password, and the app it signs in ends when passwords are turned off", async t => {
  const f = await fixture(t);
  const cookie = f.cookieOf(await f.request("POST", "/api/auth/password/signup", { headers: { Origin: origin }, body: { username: "grace", password } }));
  const missing = await f.makeCode(await f.browser(cookie));
  assert.equal(missing.status, 403);
  assert.equal(await errorCode(missing), "current_password_required");
  const wrong = await f.makeCode(await f.browser(cookie), { currentPassword: "not the password at all" });
  assert.equal(wrong.status, 403);
  assert.equal(await errorCode(wrong), "invalid_credentials");
  assert.equal(f.sqlite.prepare("SELECT failed_attempts FROM password_credentials WHERE user_id = 'password:grace'").get()!.failed_attempts, 1);

  const made = await f.makeCode(await f.browser(cookie), { currentPassword: password });
  assert.equal(made.status, 201);
  const { code } = await made.json() as AppSignInCode;
  const answer = await (await f.redeem({ code, deviceName: "Grace's Android" })).json() as NativeSignIn;
  assert.equal(answer.user.id, "password:grace");
  assert.equal(answer.user.passwordSignIn, true);
  assert.ok(Date.parse(answer.expiresAt) > Date.now() + 29 * 24 * 3600_000);
  assert.deepEqual({ ...f.sqlite.prepare("SELECT method, via, client FROM auth_sessions WHERE device_name = ?").get("Grace's Android") },
    { method: "password", via: "code", client: "native" });
  const bearer = { Authorization: `Bearer ${answer.token}` };
  assert.equal((await f.request("GET", "/api/me", { headers: bearer })).status, 200);
  f.env.PASSWORD_AUTH = "false";
  assert.equal((await f.request("GET", "/api/me", { headers: bearer })).status, 401);
});

test("a GitHub account that proves itself with its password makes a code for a password sign-in", async t => {
  const f = await fixture(t);
  const cookie = await f.testUser("heidi");
  assert.equal((await f.request("POST", "/api/me/username", { headers: await f.browser(cookie), body: { username: "heidi", password } })).status, 200);
  f.sqlite.prepare("UPDATE auth_sessions SET created_at = ? WHERE client = 'browser'").run(new Date(Date.now() - 16 * 60_000).toISOString());
  const stale = await f.makeCode(await f.browser(cookie));
  assert.equal(await errorCode(stale), "recent_sign_in_required");
  const made = await f.makeCode(await f.browser(cookie), { currentPassword: password });
  assert.equal(made.status, 201);
  const { code } = await made.json() as AppSignInCode;
  const answer = await (await f.redeem({ code, deviceName: "Heidi's iPad" })).json() as NativeSignIn;
  assert.deepEqual({ ...f.sqlite.prepare("SELECT method, via FROM auth_sessions WHERE device_name = ?").get("Heidi's iPad") }, { method: "password", via: "code" });
  f.env.PASSWORD_AUTH = "false";
  assert.equal((await f.request("GET", "/api/me", { headers: { Authorization: `Bearer ${answer.token}` } })).status, 401);
  assert.equal(await errorCode(await f.makeCode(await f.browser(cookie), { currentPassword: password })), "password_auth_off");
});
