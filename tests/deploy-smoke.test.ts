import assert from "node:assert/strict";
import { createServer } from "node:http";
import test, { type TestContext } from "node:test";
import { checkDeployment } from "../scripts/deploy-smoke.mjs";

async function fixture(t: TestContext, options: { missingAsset?: boolean; version?: string; unhealthy?: boolean; page?: string } = {}) {
  const server = createServer((req, res) => {
    if (req.url === "/api/health") {
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ ok: !options.unhealthy, version: options.version ?? "0.26.0" }));
    } else if (req.url === "/") {
      res.setHeader("Content-Security-Policy", "script-src 'self' 'wasm-unsafe-eval';");
      res.end(options.page ?? '<base href="/"><div id="app"></div><script>const app={wasm:"nsh.0123456789.wasm",code:"app.0123456789.js"}</script>');
    } else if (options.missingAsset) {
      res.setHeader("Content-Type", "text/html");
      res.end('<div id="app"></div>');
    } else {
      res.setHeader("Content-Type", req.url!.endsWith(".wasm") ? "application/wasm" : "text/javascript");
      res.end(req.url!.endsWith(".wasm") ? Buffer.from([0, 97, 115, 109]) : "// startup asset");
    }
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())));
  return `http://127.0.0.1:${(server.address() as { port: number }).port}`;
}

test("deployment checks verify the client, its policy, startup assets and release version", async t => {
  assert.equal((await checkDeployment(await fixture(t), "0.26.0")).version, "0.26.0");
});

test("a healthy backend serving another page cannot pass deployment checks", async t => {
  await assert.rejects(checkDeployment(await fixture(t, { page: '<div id="root"></div><script src="/assets/index-12345678.js"></script>' }), "0.26.0"),
    /NSH client must use its web base/);
});

test("a missing startup asset cannot pass as the SPA fallback", async t => {
  await assert.rejects(checkDeployment(await fixture(t, { missingAsset: true }), "0.26.0"), /not a startup asset/);
});

test("an unhealthy or stale backend fails deployment checks", async t => {
  await assert.rejects(checkDeployment(await fixture(t, { unhealthy: true }), "0.26.0"), /backend is not healthy/);
  await assert.rejects(checkDeployment(await fixture(t, { version: "0.25.0" }), "0.26.0"), /version does not match/);
});
