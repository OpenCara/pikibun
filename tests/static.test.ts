import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createStaticHandler, pageContentSecurityPolicy } from "../apps/server/src/static.ts";

// The client, built for the web by Native Shell (`pnpm build`): an inline loader, files named by their content.
const loader = "const fetches = new Map();";
const page = `<!doctype html>\n<html lang="en">\n<head>\n<script>${loader}</script><script type="module">import { createPlayer } from "./nsh.89070fe10a.js";</script><script src="./x.js"></script>\n</head><body></body></html>`;

async function site(t: test.TestContext) {
  const root = await mkdtemp(join(tmpdir(), "web-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, "index.html"), page);
  await writeFile(join(root, "nsh.4bda023b65.wasm"), new Uint8Array([0, 97, 115, 109]));
  await writeFile(join(root, "manifest.webmanifest"), "{}");
  await writeFile(join(root, "app.0123456789.css"), "html{}");
  return root;
}

const get = (path: string) => new Request(`https://pikibun.example${path}`);
const hash = (text: string) => `'sha256-${createHash("sha256").update(text).digest("base64")}'`;

test("the page allows its inline scripts by hash and WebAssembly, and nothing looser", () => {
  const policy = pageContentSecurityPolicy(page);
  assert.match(policy, /script-src 'self' 'wasm-unsafe-eval' /);
  assert.ok(policy.includes(hash(loader)));
  assert.ok(policy.includes(hash('import { createPlayer } from "./nsh.89070fe10a.js";')));
  assert.equal(policy.match(/'sha256-/g)?.length, 2, "a script with src needs no hash");
  assert.doesNotMatch(policy, /'unsafe-eval'|script-src[^;]*'unsafe-inline'/);
  assert.match(policy, /connect-src 'self'/);
  assert.match(policy, /frame-ancestors 'none'/);
});

test("serves the client at the root: files as they are, everything else as its page", async t => {
  const serve = createStaticHandler(await site(t));

  const index = await serve(get("/"));
  assert.equal(index.status, 200);
  const html = await index.text();
  assert.match(html, /<head>\n<base href="\/">/, "relative URLs resolve from the root whatever the path");
  assert.match(index.headers.get("content-security-policy") ?? "", /'wasm-unsafe-eval'/);
  assert.ok((index.headers.get("content-security-policy") ?? "").includes(hash(loader)), "the hashes still match the page as served");
  assert.equal(index.headers.get("cache-control"), "no-cache");

  const wasm = await serve(get("/nsh.4bda023b65.wasm"));
  assert.equal(wasm.headers.get("content-type"), "application/wasm");
  assert.equal(wasm.headers.get("cache-control"), "public, max-age=31536000, immutable");
  assert.deepEqual(new Uint8Array(await wasm.arrayBuffer()), new Uint8Array([0, 97, 115, 109]));
  assert.equal((await serve(get("/app.0123456789.css"))).headers.get("content-type"), "text/css; charset=utf-8");
  assert.equal((await serve(get("/manifest.webmanifest"))).headers.get("cache-control"), "no-cache");

  // Other paths are the page; nothing outside the build is reachable.
  assert.equal(await (await serve(get("/settings/hosts"))).text(), html);
  assert.equal(await (await serve(get("/..%2f..%2fetc%2fpasswd"))).text(), html);
  assert.equal(await (await serve(get("/index.html"))).text(), html, "index.html itself gets the page's treatment too");
});

test("answers HEAD without a body, and says so when the client isn't built", async t => {
  const serve = createStaticHandler(await site(t));
  const head = await serve(new Request("https://pikibun.example/", { method: "HEAD" }));
  assert.equal(head.status, 200);
  assert.equal(await head.text(), "");
  const missing = await createStaticHandler(join(tmpdir(), "no-such-web-build"))(get("/"));
  assert.equal(missing.status, 404);
  assert.match(await missing.text(), /pnpm build/);
});
