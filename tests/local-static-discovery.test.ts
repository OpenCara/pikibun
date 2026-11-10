import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import { loadLocalState } from "../apps/server/src/local/state.js";

const repository = fileURLToPath(new URL("../", import.meta.url));

test("a packaged local server discovers its build without --static-dir, and serves it with Native Shell's policy", async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "pikibun-packaged-web-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const dist = join(root, "dist"), web = join(dist, "web");
  await mkdir(web, { recursive: true });
  await symlink(join(repository, "node_modules"), join(root, "node_modules"), "junction");
  await cp(join(repository, "apps/server/migrations"), join(dist, "migrations"), { recursive: true });
  const bundle = join(dist, "local-server.mjs");
  await build({ entryPoints: [join(repository, "apps/server/src/local/launch.ts")], outfile: bundle,
    bundle: true, splitting: false, platform: "node", format: "esm", target: "node24", packages: "external", logLevel: "silent" });
  const { defaultStaticDir, startLocalServer } = await import(pathToFileURL(bundle).href) as typeof import("../apps/server/src/local/launch.js");
  assert.equal(defaultStaticDir(), undefined);
  await writeFile(join(web, "index.html"), '<!doctype html><html><head></head><body>Packaged NSH</body></html>');
  assert.equal(defaultStaticDir(), undefined, "a page without its build artifacts is not a client build");
  await writeFile(join(web, "manifest.webmanifest"), '{}');
  await writeFile(join(web, "nsh.0123456789.wasm"), new Uint8Array([0, 97, 115, 109]));
  assert.equal(defaultStaticDir(), web, "NSH builds are discoverable");

  const socket = createServer();
  await new Promise<void>(resolve => socket.listen(0, "127.0.0.1", resolve));
  const { port } = socket.address() as { port: number };
  await new Promise<void>((resolve, reject) => socket.close(error => error ? reject(error) : resolve()));
  const stateDir = join(root, "state");
  const state = await loadLocalState(stateDir, { port });
  const server = await startLocalServer({ stateDir, state });
  try {
    const page = await fetch(server.origin);
    assert.equal(page.status, 200);
    assert.match(await page.text(), /<base href="\/">[\s\S]*Packaged NSH/);
    assert.match(page.headers.get("Content-Security-Policy")!, /'wasm-unsafe-eval'/);
    assert.equal((await fetch(`${server.origin}/api/health`)).status, 200);
  } finally {
    await server.close();
  }
  await rm(join(web, "index.html"));
  assert.equal(defaultStaticDir(), undefined, "a manifest alone is not a client build");
});
