import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createNshWebHandler, nshContentSecurityPolicy } from "../apps/server/src/nsh-web.ts";

const loader = "const fetches = new Map();";
const page = `<!doctype html><script>${loader}</script><script type="module">import { createPlayer } from "./nsh.89070fe10a.js";</script><script src="./x.js"></script>`;

async function site(t: test.TestContext) {
  const root = await mkdtemp(join(tmpdir(), "nsh-web-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, "index.html"), page);
  await writeFile(join(root, "nsh.4bda023b65.wasm"), new Uint8Array([0, 97, 115, 109]));
  await writeFile(join(root, "manifest.webmanifest"), "{}");
  await writeFile(join(root, "app.0123456789.css"), "html{}");
  return root;
}

const get = (path: string) => new Request(`https://pikibun.example${path}`);

test("allows the page's inline scripts by hash and WebAssembly, and nothing looser", () => {
  const policy = nshContentSecurityPolicy(page);
  const hash = (text: string) => `'sha256-${createHash("sha256").update(text).digest("base64")}'`;
  assert.match(policy, /script-src 'self' 'wasm-unsafe-eval' /);
  assert.ok(policy.includes(hash(loader)));
  assert.ok(policy.includes(hash('import { createPlayer } from "./nsh.89070fe10a.js";')));
  assert.equal(policy.match(/'sha256-/g)?.length, 2, "a script with src needs no hash");
  assert.doesNotMatch(policy, /'unsafe-eval'|script-src[^;]*'unsafe-inline'/);
  assert.match(policy, /connect-src 'self'/);
  assert.match(policy, /frame-ancestors 'none'/);
});

test("serves the NSH build under /nsh/", async t => {
  const serve = createNshWebHandler(await site(t));

  const redirect = await serve(get("/nsh?x=1"));
  assert.equal(redirect?.status, 308);
  assert.equal(redirect?.headers.get("location"), "/nsh/?x=1");

  const index = await serve(get("/nsh/"));
  assert.equal(index?.status, 200);
  assert.equal(await index?.text(), page);
  assert.match(index?.headers.get("content-security-policy") ?? "", /'wasm-unsafe-eval'/);
  assert.equal(index?.headers.get("cache-control"), "no-cache");

  const wasm = await serve(get("/nsh/nsh.4bda023b65.wasm"));
  assert.equal(wasm?.headers.get("content-type"), "application/wasm");
  assert.equal(wasm?.headers.get("cache-control"), "public, max-age=31536000, immutable");
  assert.deepEqual(new Uint8Array(await wasm!.arrayBuffer()), new Uint8Array([0, 97, 115, 109]));

  assert.equal((await serve(get("/nsh/manifest.webmanifest")))?.headers.get("cache-control"), "no-cache");
  assert.equal((await serve(get("/nsh/app.0123456789.css")))?.headers.get("content-type"), "text/css; charset=utf-8");
  // Any other path under /nsh/ is the page; nothing outside the build is reachable.
  assert.equal(await (await serve(get("/nsh/sessions/s1")))?.text(), page);
  assert.equal(await (await serve(get("/nsh/..%2f..%2fetc%2fpasswd")))?.text(), page);
  // Dot segments the URL parser resolves leave /nsh/ before the handler sees them: the web app's handler answers.
  assert.equal(await serve(get("/nsh/%2e%2e/%2e%2e/etc/passwd")), null);
});

test("leaves other paths, and a server without an NSH build, to the web app", async t => {
  const serve = createNshWebHandler(await site(t));
  assert.equal(await serve(get("/")), null);
  assert.equal(await serve(get("/nshell")), null);
  assert.equal(await serve(get("/sessions/s1")), null);

  const missing = createNshWebHandler(join(tmpdir(), "no-such-nsh-build"));
  assert.equal(await missing(get("/nsh/")), null);
  assert.equal(await missing(get("/nsh")), null);
});

test("answers HEAD without a body", async t => {
  const serve = createNshWebHandler(await site(t));
  const head = await serve(new Request("https://pikibun.example/nsh/", { method: "HEAD" }));
  assert.equal(head?.status, 200);
  assert.equal(await head?.text(), "");
});

