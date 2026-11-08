import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { createBuildProxy, main } from "../scripts/github-build-proxy.mjs";

async function proxy(t: TestContext) {
  const server = createBuildProxy();
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())));
  return `http://127.0.0.1:${(server.address() as { port: number }).port}`;
}

test("build proxy streams the same official archive and checksum bytes through GitHub's API", async t => {
  const request = globalThis.fetch;
  let metadataCalls = 0;
  const archive = new Uint8Array([80, 75, 3, 4]);
  const checksum = `${"a".repeat(64)} *electron-v44.8.0-win32-x64.zip\n`;
  t.mock.method(globalThis, "fetch", async (url: string, options: RequestInit) => {
    if (url.endsWith('/releases/tags/v44.8.0')) {
      metadataCalls++;
      return Response.json({ assets: [
        { name: 'electron-v44.8.0-win32-x64.zip', url: 'https://api.github.com/repos/electron/electron/releases/assets/1' },
        { name: 'SHASUMS256.txt', url: 'https://api.github.com/repos/electron/electron/releases/assets/2' },
      ] });
    }
    assert.equal(new Headers(options.headers).get('Accept'), 'application/octet-stream');
    return new Response(url.endsWith('/1') ? archive : checksum, { headers: { 'Content-Type': 'application/octet-stream' } });
  });
  const origin = await proxy(t);
  const base = `${origin}/electron/electron/releases/download/v44.8.0/`;
  assert.equal(await (await request(base+'SHASUMS256.txt')).text(), checksum);
  assert.deepEqual(new Uint8Array(await (await request(base+'electron-v44.8.0-win32-x64.zip')).arrayBuffer()), archive);
  assert.equal(metadataCalls, 1, 'the pinned release metadata is shared across asset requests');
});

test("build proxy cannot reach arbitrary repositories or turn upstream errors into success", async t => {
  const request = globalThis.fetch;
  let calls = 0;
  t.mock.method(globalThis, "fetch", async () => { calls++; return new Response('Unavailable', { status: 503 }); });
  const origin = await proxy(t);
  assert.equal((await request(origin+'/someone/private/releases/download/v1/file')).status, 404);
  assert.equal(calls, 0);
  for (let attempt = 0; attempt < 2; attempt++) {
    const response = await request(origin+'/electron/electron/releases/download/v44.8.0/SHASUMS256.txt');
    assert.equal(response.status, 502);
    await response.text();
  }
  assert.equal(calls, 2, 'failed metadata is not cached permanently');
});

test("the build wrapper preserves the child command's exit status", { skip: process.platform === 'win32' }, async () => {
  assert.equal(await main([process.execPath, '-e', 'process.exit(7)']), 7);
});
