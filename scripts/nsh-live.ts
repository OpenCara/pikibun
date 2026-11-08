/**
 * Runs the client (apps/nsh) against a real Pikibun server: starts one in test mode on this machine with a fresh SQLite
 * database, builds the client for the web and checks the server serves it, then drives the app headless over the real
 * network (`nsh test`, network "live"): a test-mode sign-in, the session list, a workspace and the new-session form.
 * Uses the Native Shell CLI scripts/nsh.mjs pins. `pnpm test:client-live`
 */
import { spawn } from "node:child_process";
import { buildWeb, nshBinary } from "./nsh.mjs";
import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { loadConfig } from "../apps/server/src/config.ts";
import { startServer } from "../apps/server/src/serve.ts";

const app = resolve("apps/nsh");

/** Runs nsh without blocking: the server this process hosts must keep answering the app meanwhile. */
async function run(args: string[], cwd: string) {
  const nsh: string = await nshBinary();
  const child = spawn(nsh, args, { cwd, stdio: ["ignore", "inherit", "inherit"], env: { ...process.env, NO_COLOR: "1" } });
  const status = await new Promise<number | null>((done, fail) => { child.on("error", fail); child.on("exit", done); });
  if (status !== 0) throw new Error(`nsh ${args.join(" ")} exited with ${status}`);
}

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>(done => server.listen(0, "127.0.0.1", done));
  const { port } = server.address() as { port: number };
  await new Promise(done => server.close(done));
  return port;
}

const work = await mkdtemp(join(tmpdir(), "pikibun-nsh-live-"));
const port = await freePort();
const origin = `http://127.0.0.1:${port}`;
const secret = randomBytes(32).toString("base64url");
let stop = async () => {};
try {
  console.log("Building the client for the web…");
  await buildWeb(join(work, "web"));

  const config = await loadConfig({
    APP_ORIGIN: origin, HOST: "127.0.0.1", PORT: String(port), DATABASE_URL: `sqlite://${join(work, "pikibun.sqlite")}`,
    SESSION_SECRET: randomBytes(32).toString("base64url"), VAULT_KEY: randomBytes(32).toString("base64url"),
    TEST_AUTH_ENABLED: "true", TEST_AUTH_SECRET: secret, TEST_AUTH_EXPIRES_AT: new Date(Date.now() + 3_600_000).toISOString(),
    STATIC_DIR: join(work, "web"), STATIC_CLIENT: "nsh",
  });
  const server = await startServer(config);
  stop = () => server.close();
  console.log(`Pikibun test server on ${origin}`);

  // The client, served by the server itself.
  const page = await fetch(`${origin}/`);
  const policy = page.headers.get("content-security-policy") ?? "";
  if (page.status !== 200 || !policy.includes("'wasm-unsafe-eval'")) throw new Error(`/ answered ${page.status} with policy ${policy}`);
  const wasm = /nsh\.[0-9a-f]{10}\.wasm/.exec(await page.text())?.[0];
  const runtime = wasm ? await fetch(`${origin}/${wasm}`) : null;
  if (runtime?.headers.get("content-type") !== "application/wasm") throw new Error("the server does not serve the WebAssembly runtime");
  console.log(`✓ ${origin}/ serves the client (${wasm}) with its Content-Security-Policy`);

  // A test user signed in as a native app, with a workspace of their own.
  const login = await fetch(`${origin}/api/auth/test`, {
    method: "POST",
    headers: { Authorization: `Bearer ${secret}`, Origin: origin, "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ id: "nsh-live", displayName: "Ada Lovelace", githubLogin: "ada", client: "native", deviceName: "nsh test" }),
  });
  if (!login.ok) throw new Error(`test sign-in failed: ${login.status} ${await login.text()}`);
  const { token } = await login.json() as { token: string };
  const created = await fetch(`${origin}/api/workspaces`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, Origin: origin, "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ name: "Analytical Engine" }),
  });
  if (!created.ok) throw new Error(`creating a workspace failed: ${created.status} ${await created.text()}`);

  const tests = join(app, ".nsh", "live");
  await mkdir(tests, { recursive: true });
  await writeFile(join(tests, "live.test.tsx"), `import { expect, open, test } from "nsh/test";

const origin = ${JSON.stringify(origin)};
const token = ${JSON.stringify(token)};

test("signs in to a real server with a test-mode token, lists and starts sessions", async () => {
  const app = await open("../../App.tsx", { network: "live", storage: { "pikibun.origin": origin } });
  await app.waitFor("id:developer-toggle", { timeout: 15000 });
  await app.press("id:developer-toggle");
  await app.type("id:developer-token", token);
  await app.press("id:developer-sign-in");
  await app.waitFor("text:No sessions yet", { timeout: 15000 });
  await app.press("id:new-session");
  await app.waitFor("text:What should we work on?", { timeout: 15000 });
  await app.waitFor("text:No host to chat with yet", { timeout: 15000 });
  expect(app.texts().join(" ")).toContain("Analytical Engine");
  await app.back();
  await app.press("id:open-settings");
  await app.waitFor("text:Ada Lovelace", { timeout: 15000 });
});

test("a stored sign-in comes back, and signing out revokes it on the server", async () => {
  const app = await open("../../App.tsx", { network: "live", storage: { "pikibun.origin": origin, "pikibun.token": token } });
  await app.waitFor("text:No sessions yet", { timeout: 15000 });
  await app.press("id:open-settings");
  app.onDialog(() => "Sign out");
  await app.press("id:sign-out");
  await app.waitFor("id:github-sign-in", { timeout: 15000 });
  expect(app.storage()["pikibun.token"]).toBeUndefined();
});
`);
  await run(["test", ".nsh/live/live.test.tsx"], app);
  const revoked = await fetch(`${origin}/api/me`, { headers: { Authorization: `Bearer ${token}` } });
  if (revoked.status !== 401) throw new Error(`the sign-in is still valid after signing out (${revoked.status})`);
  console.log("✓ signing out in the NSH app revoked the token on the server");
} finally {
  await stop();
  await rm(work, { recursive: true, force: true });
}
