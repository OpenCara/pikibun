import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { loadConfig } from "../apps/server/src/config.js";
import { InstanceLockedError } from "../apps/server/src/db/index.js";
import { startServer } from "../apps/server/src/serve.js";

const production = "https://pikibun.com";
const preview = "https://preview.pikibun.com";
const secret = "preview-test-secret-not-a-production-secret";
const environment = {
  APP_ORIGIN: production, SESSION_SECRET: secret, VAULT_KEY: Buffer.alloc(32, 1).toString("base64url"),
  DATABASE_URL: "sqlite::memory:", HOST: "127.0.0.1", PORT: "0",
};

test("preview configuration is explicit: an exact, distinct HTTPS origin, never a wildcard or a local-server alias", async () => {
  for (const origin of [production, `${preview}/`, `${preview}/app`, `http://preview.pikibun.com`, `https://user@preview.pikibun.com`, "*.pikibun.com", "null"]) {
    await assert.rejects(loadConfig({ ...environment, PREVIEW_ORIGIN: origin }), /PREVIEW_ORIGIN/, origin);
  }
  await assert.rejects(loadConfig({ ...environment, PREVIEW_STATIC_DIR: "dist/client" }), /requires PREVIEW_ORIGIN/);
  await assert.rejects(loadConfig({ ...environment, STATIC_CLIENT: "web" }), /React web client was removed/);
  await assert.rejects(loadConfig({ ...environment, APP_ORIGIN: "http://127.0.0.1", LOCAL_MODE: "true",
    LOCAL_CLAIM_SECRET: "x".repeat(43), PREVIEW_ORIGIN: preview }), /PREVIEW_ORIGIN/);
  const renamed = await loadConfig({ ...environment, STATIC_DIR: "dist/preview" });
  try {
    assert.equal(renamed.staticDir, resolve("dist/client"), "a server still set to the build's former directory serves the build where it is now");
  } finally {
    await renamed.env.CONNECTOR_HUB!.close();
    await renamed.env.DB.close();
  }
  const config = await loadConfig({ ...environment, PREVIEW_ORIGIN: preview });
  try {
    assert.equal(config.staticDir, resolve("dist/client"));
    assert.deepEqual(config.preview, { origin: preview, staticDir: resolve("dist/client") });
  } finally {
    await config.env.CONNECTOR_HUB!.close();
    await config.env.DB.close();
  }
});

test("each origin serves its own NSH build, and each host's authentication keeps its own origin", async t => {
  const root = await mkdtemp(join(tmpdir(), "pikibun-preview-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const web = join(root, "web"), nsh = join(root, "nsh");
  await mkdir(web);
  await mkdir(nsh);
  await writeFile(join(web, "index.html"), '<html><head></head><body>NSH production</body></html>');
  await writeFile(join(web, "nsh.abcdef0123.wasm"), new Uint8Array([0, 97, 115, 109]));
  await writeFile(join(nsh, "index.html"), '<html><head></head><body>NSH preview</body></html>');
  await writeFile(join(nsh, "nsh.0123456789.wasm"), new Uint8Array([0, 97, 115, 109]));
  const react = join(root, "react");
  await mkdir(react);
  await writeFile(join(react, "index.html"), '<div id="root"></div>');
  await assert.rejects(loadConfig({ ...environment, STATIC_DIR: react }), /STATIC_DIR .* isn't the Native Shell client/);
  await assert.rejects(loadConfig({ ...environment, PREVIEW_ORIGIN: preview, PREVIEW_STATIC_DIR: react }), /PREVIEW_STATIC_DIR .* isn't the Native Shell client/);
  const config = await loadConfig({ ...environment, STATIC_DIR: web, PREVIEW_ORIGIN: preview, PREVIEW_STATIC_DIR: nsh,
    TRUST_PROXY: "true", TEST_AUTH_ENABLED: "true", TEST_AUTH_SECRET: secret,
    TEST_AUTH_EXPIRES_AT: new Date(Date.now() + 3600_000).toISOString(),
    GITHUB_CLIENT_ID: "client-id", GITHUB_CLIENT_SECRET: "client-secret",
  });
  const server = await startServer(config);
  t.after(() => server.close());
  const request = (origin: string, path = "/", init: RequestInit = {}) => fetch(`http://127.0.0.1:${server.address.port}${path}`, {
    ...init, redirect: "manual", headers: { "X-Forwarded-Proto": "https", "X-Forwarded-Host": new URL(origin).host, ...init.headers },
  });
  for (const path of ["/", "/index.html", "/settings/hosts"]) {
    const stable = await request(production, path);
    assert.match(await stable.text(), /<base href="\/">[\s\S]*NSH production/);
    assert.match(stable.headers.get("content-security-policy")!, /wasm-unsafe-eval/);
    const experimental = await request(preview, path);
    assert.match(await experimental.text(), /<base href="\/">[\s\S]*NSH preview/);
    assert.match(experimental.headers.get("content-security-policy")!, /wasm-unsafe-eval/);
  }
  assert.equal((await request(preview, "/nsh.0123456789.wasm")).headers.get("content-type"), "application/wasm");
  assert.equal((await request(production, "/nsh.0123456789.wasm")).headers.get("content-type"), "text/html; charset=utf-8");
  assert.match(await (await request("https://preview.pikibun.com.evil.example")).text(), /NSH production/);
  assert.match(await (await request(production, "/?preview=true")).text(), /NSH production/);
  assert.equal(await (await request(preview, "/", { method: "HEAD" })).text(), "");
  const apiMiss = await request(preview, "/api/no-such-route");
  assert.equal(apiMiss.status, 401, "API paths still require authentication, not the SPA page");
  assert.match(apiMiss.headers.get("content-type")!, /application\/json/);

  for (const origin of [production, preview]) {
    const start = await request(origin, "/api/auth/github");
    assert.equal(start.status, 302);
    assert.equal(new URL(start.headers.get("location")!).searchParams.get("redirect_uri"), `${origin}/api/auth/github/callback`);
    const stateCookie = start.headers.get("set-cookie")!;
    assert.match(stateCookie, /__Host-oauth-state=/);
    assert.doesNotMatch(stateCookie, /domain=/i, "sign-in cookies stay host-only");
  }
  const login = (origin: string, sender = origin) => request(origin, "/api/auth/test", { method: "POST", headers: {
    Origin: sender, "Content-Type": "application/json", Authorization: `Bearer ${secret}`,
  }, body: JSON.stringify({ id: "preview-user", displayName: "Preview User" }) });
  assert.equal((await login(preview, production)).status, 403, "production Origin cannot write through preview");
  assert.equal((await login(production, preview)).status, 403, "preview Origin cannot write through production");
  const signedIn = await login(preview);
  assert.equal(signedIn.status, 200);
  const cookie = signedIn.headers.get("set-cookie")!.split(";")[0]!;
  assert.match(cookie, /^__Host-auth=/);
  const csrf = await (await request(preview, "/api/auth/csrf", { headers: { Cookie: cookie } })).json() as { csrfToken: string };
  const create = (token?: string) => request(preview, "/api/workspaces", { method: "POST", headers: {
    Origin: preview, Cookie: cookie, "Content-Type": "application/json", ...(token ? { "X-CSRF-Token": token } : {}),
  }, body: JSON.stringify({ name: "Shared backend" }) });
  assert.equal((await create()).status, 403, "the preview still requires CSRF tokens");
  assert.equal((await create(csrf.csrfToken)).status, 201);
  const listed = await (await request(production, "/api/workspaces", { headers: { Cookie: cookie } })).json() as { workspaces: { name: string }[] };
  assert.ok(listed.workspaces.some(workspace => workspace.name === "Shared backend"), "both UIs use the same backend, not a copied database");

  await t.test("untrusted forwarded headers cannot select preview or change the authentication origin", async t => {
    const direct = await startServer(await loadConfig({ ...environment, STATIC_DIR: web, PREVIEW_ORIGIN: preview,
      PREVIEW_STATIC_DIR: nsh, GITHUB_CLIENT_ID: "client-id", GITHUB_CLIENT_SECRET: "client-secret" }));
    t.after(() => direct.close());
    const spoofed = (path: string) => fetch(`http://127.0.0.1:${direct.address.port}${path}`, { redirect: "manual",
      headers: { "X-Forwarded-Proto": "https", "X-Forwarded-Host": new URL(preview).host } });
    assert.match(await (await spoofed("/")).text(), /NSH production/);
    const auth = await spoofed("/api/auth/github");
    assert.equal(auth.status, 302);
    assert.equal(new URL(auth.headers.get("location")!).searchParams.get("redirect_uri"), `${production}/api/auth/github/callback`);
  });
});

test("a second server on a database another one serves is refused before it migrates, and starts once the first has stopped", async t => {
  const root = await mkdtemp(join(tmpdir(), "pikibun-instance-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const migrations = join(root, "migrations");
  await mkdir(join(migrations, "sqlite"), { recursive: true });
  await writeFile(join(migrations, "sqlite", "0001_first.sql"), "CREATE TABLE first (id TEXT PRIMARY KEY);\n");
  const previous = process.env.MIGRATIONS_DIR;
  process.env.MIGRATIONS_DIR = migrations;
  t.after(() => { if (previous === undefined) delete process.env.MIGRATIONS_DIR; else process.env.MIGRATIONS_DIR = previous; });
  const settings = { ...environment, DATABASE_URL: `sqlite://${join(root, "db.sqlite")}`, STATIC_DIR: join(root, "web") };
  const first = await startServer(await loadConfig(settings));
  await writeFile(join(migrations, "sqlite", "0002_second.sql"), "CREATE TABLE second (id TEXT PRIMARY KEY);\n");
  const second = await loadConfig(settings);
  await assert.rejects(startServer(second), InstanceLockedError);
  const reader = await loadConfig(settings);
  try {
    assert.deepEqual(await reader.env.DB.query<{ name: string }>("SELECT name FROM schema_migrations ORDER BY name").all(), [{ name: "0001_first.sql" }]);
  } finally {
    await reader.env.CONNECTOR_HUB!.close();
    await reader.env.DB.close();
  }
  await first.close();
  const next = await startServer(await loadConfig(settings));
  await next.close();
});
