import assert from "node:assert/strict";
import test from "node:test";
import { releaseAsset } from "../scripts/nsh.mjs";

const url = "https://github.com/longbridge/nsh/releases/download/v0.4.0/nsh-linux-x86_64.tar.gz.sha256";
const hash = "a".repeat(64);

test("release downloads retry gateway failures with a fresh asset URL", async t => {
  const requested: URL[] = [];
  t.mock.method(globalThis, "fetch", async (input: URL) => {
    requested.push(input);
    return requested.length === 1 ? new Response("Gateway timeout", { status: 504 }) : new Response(`${hash}  nsh-linux-x86_64.tar.gz`);
  });
  assert.equal(await releaseAsset(url, { checksum: true, delayMs: 0 }), hash);
  assert.equal(requested.length, 2);
  assert.equal(requested[0]!.search, "");
  assert.ok(requested[1]!.searchParams.has("_pikibun_retry"));
});

test("a gateway HTML page with status 200 is never accepted as a release checksum", async t => {
  let calls = 0;
  t.mock.method(globalThis, "fetch", async () => new Response(++calls === 1 ? "<html><body><h1>504 Gateway timeout</h1>" : hash));
  assert.equal(await releaseAsset(url, { checksum: true, delayMs: 0 }), hash);
  assert.equal(calls, 2);
});

test("failed or malformed release responses exhaust bounded retries without installing anything", async t => {
  let calls = 0;
  t.mock.method(globalThis, "fetch", async () => { calls++; return new Response("<html>504 Gateway timeout</html>"); });
  await assert.rejects(releaseAsset(url, { checksum: true, attempts: 2, delayMs: 0 }), /not a SHA-256 hash/);
  assert.equal(calls, 2);
});

test("binary release assets are returned as bytes after a transient HTTP failure", async t => {
  let calls = 0;
  const bytes = new Uint8Array([31, 139, 8, 0]);
  t.mock.method(globalThis, "fetch", async () => ++calls === 1 ? new Response("Unavailable", { status: 503 }) : new Response(bytes));
  assert.deepEqual(await releaseAsset(url.replace(/\.sha256$/, ""), { attempts: 2, delayMs: 0 }), Buffer.from(bytes));
  assert.equal(calls, 2);
});
