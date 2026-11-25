import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { checkAsset, componentAsset, NSH_ASSET_SHA256, NSH_COMPONENTS, NSH_TUI_HOSTS, NSH_VERSION, nshComponent, releaseAsset, targetComponent } from "../scripts/nsh.mjs";

const url = `https://github.com/longbridge/nsh/releases/download/${NSH_VERSION}/nsh-linux-x86_64.tar.gz`;

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
  assert.equal(NSH_VERSION, "v0.7.0", "a new version pins new digests: update NSH_ASSET_SHA256 with it");
  assert.deepEqual(Object.keys(NSH_ASSET_SHA256).sort(), [
    "nsh-android.tar.gz", "nsh-ios-macos-arm64.tar.gz", "nsh-linux-x86_64.tar.gz", "nsh-macos-arm64.tar.gz",
    "nsh-tui-linux-arm64.tar.gz", "nsh-tui-linux-x86_64.tar.gz", "nsh-tui-macos-arm64.tar.gz", "nsh-tui-macos-x86_64.tar.gz",
    "nsh-tui-windows-arm64.tar.gz", "nsh-tui-windows-x86_64.tar.gz",
    "nsh-web.tar.gz", "nsh-windows-x86_64.zip",
  ]);
  for (const digest of Object.values(NSH_ASSET_SHA256)) assert.match(digest, /^[0-9a-f]{64}$/);
  const bytes = Buffer.from("not Native Shell");
  assert.throws(() => checkAsset("nsh-linux-x86_64.tar.gz", bytes), /does not match the SHA-256 pinned/);
  assert.throws(() => checkAsset("nsh-freebsd.tar.gz", bytes), /No SHA-256 is pinned/);
});

test("every pinned component's archive has a pinned SHA-256, and a command's --target adds the one it needs", () => {
  for (const component of Object.values(NSH_COMPONENTS)) {
    for (const asset of component.asset ? [component.asset] : Object.values(component.assets ?? {})) assert.ok(NSH_ASSET_SHA256[asset], `${asset} is pinned`);
  }
  assert.equal(targetComponent(["run", "App.tsx", "--target", "tui"]), "tui");
  assert.equal(targetComponent(["package", "App.tsx", "--target", "web", "--out", "x"]), "web");
  assert.equal(targetComponent(["run", "--target=android"]), "android");
  assert.equal(targetComponent(["package", "App.tsx", "--target", "catalyst"]), "ios");
  assert.equal(targetComponent(["package", "App.tsx", "--target", "macos"]), null, "this platform's own runtime comes with the CLI");
  assert.equal(targetComponent(["test"]), null);
  assert.equal(targetComponent(["run", "--target", "macos", "--", "--target", "web"]), null, "what follows -- is the app's");
});

test("a component asked for by name is added or the request fails, never skipped quietly", async t => {
  const previous = process.env.NSH_BIN;
  process.env.NSH_BIN = "/usr/local/bin/nsh";
  t.after(() => { if (previous === undefined) delete process.env.NSH_BIN; else process.env.NSH_BIN = previous; });
  await nshComponent("web");
  await assert.rejects(nshComponent("web", { required: true }), /can't be added here: NSH_BIN names another nsh/);
  await assert.rejects(nshComponent("gpui"), /No Native Shell component gpui is pinned/);
});

test("the terminal host is pinned for each platform the TUI package ships, and picked by the machine's own", () => {
  assert.deepEqual(Object.keys(NSH_TUI_HOSTS).sort(), ["darwin-arm64", "darwin-x64", "linux-arm64", "linux-x64", "win32-arm64", "win32-x64"]);
  assert.equal(componentAsset(NSH_COMPONENTS.tui!, "linux-x64"), "nsh-tui-linux-x86_64.tar.gz");
  assert.equal(componentAsset(NSH_COMPONENTS.tui!, "darwin-arm64"), "nsh-tui-macos-arm64.tar.gz");
  assert.equal(componentAsset(NSH_COMPONENTS.tui!, "freebsd-x64"), null);
  assert.equal(componentAsset(NSH_COMPONENTS.web!, "freebsd-x64"), "nsh-web.tar.gz", "a single archive serves every machine");
});
