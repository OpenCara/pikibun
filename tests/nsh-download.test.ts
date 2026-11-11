import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { checkAsset, NSH_ASSET_SHA256, NSH_VERSION, releaseAsset } from "../scripts/nsh.mjs";

const url = "https://github.com/longbridge/nsh/releases/download/v0.4.0/nsh-linux-x86_64.tar.gz";

function mockFetch(t: TestContext, reply: (url: URL) => Response) {
  t.mock.method(globalThis, "fetch", async (input: URL | string) => {
    const request = new URL(input);
    if (request.pathname.includes('/releases/tags/')) return Response.json({ assets: [
      { name: 'nsh-linux-x86_64.tar.gz', url: 'https://api.github.com/repos/longbridge/nsh/releases/assets/2' },
    ] });
    return reply(request);
  });
}

test("release downloads retry gateway failures with a fresh asset URL, through the release API", async t => {
  const requested: URL[] = [];
  const bytes = new Uint8Array([31, 139, 8, 0]);
  mockFetch(t, (input: URL) => {
    requested.push(input);
    return requested.length === 1 ? new Response("Gateway timeout", { status: 504 }) : new Response(bytes);
  });
  assert.deepEqual(await releaseAsset(url, { delayMs: 0 }), Buffer.from(bytes));
  assert.equal(requested.length, 2);
  assert.equal(requested[0]!.search, "");
  assert.ok(requested[1]!.searchParams.has("_pikibun_retry"));
  assert.equal(requested[1]!.hostname, 'api.github.com', 'retry uses the official release API instead of the failed browser gateway');
});

test("failed release responses exhaust bounded retries", async t => {
  let calls = 0;
  mockFetch(t, () => { calls++; return new Response("Unavailable", { status: 503 }); });
  await assert.rejects(releaseAsset(url, { attempts: 2, delayMs: 0 }), /HTTP 503/);
  assert.equal(calls, 2);
});

test("each platform's Native Shell download is checked against the SHA-256 pinned beside its version, never the release's own", () => {
  assert.equal(NSH_VERSION, "v0.4.0", "a new version pins new digests: update NSH_ASSET_SHA256 with it");
  assert.deepEqual(Object.keys(NSH_ASSET_SHA256).sort(), ["nsh-linux-x86_64.tar.gz", "nsh-macos-arm64.tar.gz", "nsh-windows-x86_64.zip"]);
  for (const digest of Object.values(NSH_ASSET_SHA256)) assert.match(digest, /^[0-9a-f]{64}$/);
  const bytes = Buffer.from("not Native Shell");
  assert.throws(() => checkAsset("nsh-linux-x86_64.tar.gz", bytes), /does not match the SHA-256 pinned/);
  assert.throws(() => checkAsset("nsh-freebsd.tar.gz", bytes), /No SHA-256 is pinned/);
});
