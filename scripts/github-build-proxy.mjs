import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { resolve } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { pathToFileURL } from 'node:url';

// Keep electron-builder's archive/checksum verification, but fetch its public assets through GitHub's release API
// when the browser-download gateway is unavailable. Only these public build-tool repositories are reachable.
export function createBuildProxy() {
  const releases = new Map();
  return createServer(async (req, res) => {
    const match = new URL(req.url, 'http://localhost').pathname.match(/^\/(electron\/electron|electron-userland\/electron-builder-binaries)\/releases\/download\/([^/]+)\/([^/]+)$/);
    if (!match || !['GET', 'HEAD'].includes(req.method)) { res.writeHead(404).end(); return; }
    const [, repository, encodedTag, encodedName] = match;
    const key = `${repository}/${encodedTag}`;
    try {
      if (!releases.has(key)) {
        const metadata = fetch(`https://api.github.com/repos/${repository}/releases/tags/${encodedTag}`, {
          headers: { Accept: 'application/vnd.github+json' }, signal: AbortSignal.timeout(30_000),
        }).then(async response => {
          if (!response.ok) throw new Error(`Release metadata: HTTP ${response.status}`);
          return response.json();
        }).catch(error => { releases.delete(key); throw error; });
        releases.set(key, metadata);
      }
      const release = await releases.get(key);
      const asset = release.assets?.find(item => item.name === decodeURIComponent(encodedName));
      if (!asset || !new RegExp(`^https://api\\.github\\.com/repos/${repository}/releases/assets/[0-9]+$`).test(asset.url)) {
        res.writeHead(404).end(); return;
      }
      const response = await fetch(asset.url, { headers: { Accept: 'application/octet-stream', 'Cache-Control': 'no-cache' },
        method: req.method, signal: AbortSignal.timeout(300_000) });
      if (!response.ok) throw new Error(`Release asset: HTTP ${response.status}`);
      res.writeHead(200, { 'Content-Type': response.headers.get('Content-Type') || 'application/octet-stream' });
      if (req.method === 'HEAD') res.end();
      else await pipeline(Readable.fromWeb(response.body), res);
    } catch (error) {
      console.error(`Build asset ${repository}/${encodedTag}/${encodedName}: ${error.message}`);
      if (res.headersSent) res.destroy();
      else res.writeHead(502).end('Build asset download failed');
    }
  });
}

export async function main(args) {
  if (!args.length) throw new Error('Pass the build command to run');
  const server = createBuildProxy();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    return await new Promise((resolve, reject) => {
      const child = spawn(args[0], args.slice(1), { stdio: 'inherit', shell: process.platform === 'win32', env: {
        ...process.env,
        ELECTRON_MIRROR: `${base}/electron/electron/releases/download/`,
        ELECTRON_BUILDER_BINARIES_MIRROR: `${base}/electron-userland/electron-builder-binaries/releases/download/`,
      } });
      child.once('error', reject);
      child.once('exit', code => resolve(code ?? 1));
    });
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) process.exitCode = await main(process.argv.slice(2));
