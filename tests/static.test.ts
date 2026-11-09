import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createStaticHandler, pageContentSecurityPolicy, webBuild } from "../apps/server/src/static.ts";

// The NSH client, built by `pnpm build`: an inline loader and content-named files.
const page = `<!doctype html>\n<html lang="en">\n<head>\n<script>const fetches = new Map();</script><script type="module">import { createPlayer } from "./nsh.89070fe10a.js";</script><script src="./x.js"></script>\n</head><body></body></html>`;

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
const directive = (policy: string, name: string) => policy.split("; ").find(item => item.startsWith(`${name} `));

test("the page's policy lets Native Shell's web runtime start, and no more", () => {
  const policy = pageContentSecurityPolicy();
  // Its blob modules, the import map it inserts (no hash or nonce: they would turn 'unsafe-inline' off) and WebAssembly.
  assert.equal(directive(policy, "script-src"), "script-src 'self' blob: 'unsafe-inline' 'wasm-unsafe-eval'");
  assert.doesNotMatch(policy, /'unsafe-eval'|'sha256-|'nonce-|\*/, "no eval, no hashes or nonces, no wildcard");
  assert.equal(directive(policy, "connect-src"), "connect-src 'self' blob: data:", "requests go to this server only");
  for (const kept of ["object-src 'none'", "base-uri 'self'", "frame-ancestors 'none'", "form-action 'self'", "default-src 'self'"]) {
    assert.ok(policy.split("; ").includes(kept), kept);
  }
});

test("serves the client at the root: files as they are, everything else as its page", async t => {
  const serve = createStaticHandler(await site(t));

  const index = await serve(get("/"));
  assert.equal(index.status, 200);
  const html = await index.text();
  assert.match(html, /<head>\n<base href="\/">/, "relative URLs resolve from the root whatever the path");
  assert.equal(index.headers.get("content-security-policy"), pageContentSecurityPolicy());
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

test("a build is Native Shell's when its runtime, nsh.<hash>.wasm, is beside its page", async t => {
  assert.equal(webBuild(await site(t)), "nsh");
  const other = await mkdtemp(join(tmpdir(), "react-"));
  t.after(() => rm(other, { recursive: true, force: true }));
  assert.equal(webBuild(other), "none", "nothing built yet");
  await writeFile(join(other, "index.html"), '<div id="root"></div>');
  assert.equal(webBuild(other), "other", "a page without the runtime, such as the removed React client's");
  await writeFile(join(other, "nsh-math.c2b0234f5a.wasm"), new Uint8Array([0, 97, 115, 109]));
  assert.equal(webBuild(other), "other", "only Native Shell's own runtime counts, not its other modules");
  assert.equal(webBuild(join(tmpdir(), "no-such-web-build")), "none");
});
