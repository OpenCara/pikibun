import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile, lstat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import test, { type TestContext } from "node:test";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(new URL("../scripts/deploy-server.sh", import.meta.url));
const image = "ghcr.io/opencara/pikibun:0.26.0";

async function fixture(t: TestContext, contents: string) {
  const root = await mkdtemp(join(tmpdir(), "pikibun-deploy-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const bin = join(root, "bin");
  await mkdir(bin);
  await writeFile(join(root, ".env"), contents, { mode: 0o600 });
  await writeFile(join(bin, "docker"), `#!/usr/bin/env node
const fs = require('node:fs');
const a = process.argv.slice(2);
fs.appendFileSync('docker.log', JSON.stringify(a)+'\\n');
if (a[0] === 'compose' && a.includes('--images')) console.log(fs.readFileSync('.env','utf8').match(/^PIKIBUN_IMAGE=(.*)$/m)[1]);
else if (a[0] === 'compose' && a[1] === 'ps') console.log('container-id');
else if (a.some(x => x.includes('.State.Health'))) console.log('healthy');
else if (a.some(x => x.includes('.Config.Image'))) console.log('previous-image');
else if (a[0] === 'inspect' || (a[0] === 'image' && a[1] === 'inspect')) console.log('sha256:test-image');
`, { mode: 0o755 });
  return { root, run: (client?: string) => spawnSync("bash", [script, image, root, ...(client === undefined ? [] : [client])], {
    cwd: root, env: { ...process.env, PATH: `${bin}${delimiter}${process.env.PATH}`, DEPLOY_HEALTH_TIMEOUT: "1" }, encoding: "utf8", timeout: 10_000,
  }) };
}

test("Actions deployment serves NSH from the origin, removes the preview origin and keeps other settings", { skip: process.platform === "win32" }, async t => {
  const f = await fixture(t, "APP_ORIGIN=https://pikibun.com\nPREVIEW_ORIGIN=https://preview.pikibun.com\nPREVIEW_STATIC_DIR=dist/client\nSESSION_SECRET=keep-this-setting\n");
  const result = f.run("nsh");
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const env = await readFile(join(f.root, ".env"), "utf8");
  assert.doesNotMatch(env, /^STATIC_CLIENT=/m);
  assert.match(env, /^STATIC_DIR=dist\/preview$/m);
  assert.doesNotMatch(env, /^PREVIEW_/m);
  assert.match(env, /^PIKIBUN_IMAGE=ghcr.io\/opencara\/pikibun:0.26.0$/m);
  assert.match(env, /^APP_ORIGIN=https:\/\/pikibun.com$/m);
  assert.match(env, /^SESSION_SECRET=keep-this-setting$/m);
});

test("deploying NSH replaces the removed React client's settings", { skip: process.platform === "win32" }, async t => {
  const f = await fixture(t, "STATIC_CLIENT=web\nSTATIC_DIR=dist/web\n");
  const result = f.run("nsh");
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const env = await readFile(join(f.root, ".env"), "utf8");
  assert.doesNotMatch(env, /^STATIC_CLIENT=/m);
  assert.match(env, /^STATIC_DIR=dist\/preview$/m);
  assert.equal(env.match(/^STATIC_DIR=/gm)?.length, 1);
});

test("deployments without a client retain the server's existing client settings", { skip: process.platform === "win32" }, async t => {
  const f = await fixture(t, "PREVIEW_ORIGIN=https://preview.example.com\n");
  const result = f.run();
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const env = await readFile(join(f.root, ".env"), "utf8");
  assert.match(env, /^PREVIEW_ORIGIN=https:\/\/preview.example.com$/m);
  assert.doesNotMatch(env, /^STATIC_/m);
});

test("updating an existing symlinked environment file preserves its link and does not duplicate settings", { skip: process.platform !== "linux" }, async t => {
  const f = await fixture(t, "PIKIBUN_IMAGE=old-image\nSTATIC_CLIENT=web\nPREVIEW_ORIGIN=https://old.example.com\n");
  const target = join(f.root, "private.env");
  await writeFile(target, await readFile(join(f.root, ".env")));
  await rm(join(f.root, ".env"));
  await symlink(target, join(f.root, ".env"));
  const result = f.run("nsh");
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.ok((await lstat(join(f.root, ".env"))).isSymbolicLink());
  const env = await readFile(target, "utf8");
  assert.doesNotMatch(env, /^STATIC_CLIENT=/m);
  assert.equal(env.match(/^STATIC_DIR=/gm)?.length, 1);
  assert.doesNotMatch(env, /^PREVIEW_ORIGIN=/m);
  assert.match(env, /^PIKIBUN_IMAGE=ghcr.io\/opencara\/pikibun:0.26.0$/m);
});

test("unknown clients fail before Docker or environment changes", { skip: process.platform === "win32" }, async t => {
  const original = "APP_ORIGIN=https://pikibun.com\n";
  const f = await fixture(t, original);
  for (const client of ["web", "react", "https://preview.example.com", "nsh\nOTHER_SETTING=value", "nsh|anything"]) {
    const result = f.run(client);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /CLIENT must be nsh\./);
    assert.equal(await readFile(join(f.root, ".env"), "utf8"), original);
  }
  await assert.rejects(readFile(join(f.root, "docker.log")), { code: "ENOENT" });
});
