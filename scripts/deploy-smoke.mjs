import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

/** Check the actual client, its startup assets and its API, not just a healthy backend on the wrong host. */
export async function checkDeployment(origin, client, expectedVersion) {
  const base = new URL(origin);
  assert.ok(['http:', 'https:'].includes(base.protocol) && base.origin === origin.replace(/\/$/, ''), 'Deployment URLs must be origins');
  const get = async path => {
    const response = await fetch(new URL(path, `${base.origin}/`), {
      redirect: 'error', signal: AbortSignal.timeout(10_000), headers: { 'User-Agent': 'Mozilla/5.0 (Pikibun deployment check)' },
    });
    assert.equal(response.status, 200, `${client}: ${path} returned HTTP ${response.status}`);
    return response;
  };
  const health = await (await get('/api/health')).json();
  assert.equal(health.ok, true, `${client}: backend is not healthy`);
  if (expectedVersion) assert.equal(health.version, expectedVersion, `${client}: deployed version does not match the release`);
  const page = await get('/');
  const html = await page.text();
  const csp = page.headers.get('Content-Security-Policy') || '';
  let assets;
  if (client === 'web') {
    assert.match(html, /id=["']root["']/, 'The web client must be React');
    assert.match(csp, /(?:^|;\s*)script-src 'self';/, 'The React client must retain its strict script policy');
    assert.doesNotMatch(csp, /wasm-unsafe-eval/);
    assets = [...html.matchAll(/(?:src|href)=["'](\/assets\/[^"']+)["']/g)].map(match => match[1]);
    assert.ok(assets.some(asset => asset.endsWith('.js')), 'Production JavaScript is missing');
  } else {
    assert.equal(client, 'nsh');
    assert.match(html, /<base href=["']\/["']>/, 'The NSH client must use its web base');
    assert.match(html, /id=["']app["']/);
    assert.match(csp, /wasm-unsafe-eval/, 'The NSH client must have its runtime policy');
    assets = [...new Set(html.match(/(?:nsh|app|host)\.[0-9a-f]{10}\.(?:wasm|js)/g) || [])];
    assert.ok(assets.some(asset => asset.endsWith('.wasm')), 'The NSH WASM runtime is missing');
    assert.ok(assets.some(asset => asset.endsWith('.js')), 'The NSH JavaScript is missing');
  }
  for (const asset of assets) {
    const response = await get(asset);
    assert.match(response.headers.get('Content-Type') || '', asset.endsWith('.wasm') ? /application\/wasm/ : asset.endsWith('.css') ? /text\/css/ : /javascript/,
      `${client}: ${asset} is not a startup asset (a missing file must not be mistaken for the SPA fallback)`);
    await response.body?.cancel();
  }
  console.log(`Verified ${base.origin}: ${client}, startup assets, policy and API${health.version ? ` (${health.version})` : ''}`);
  return health;
}

export async function main() {
  const origin = process.env.DEPLOY_URL;
  const client = process.env.DEPLOY_CLIENT || 'nsh';
  assert.ok(origin, 'Set DEPLOY_URL');
  assert.ok(client === 'web' || client === 'nsh', 'DEPLOY_CLIENT must be nsh or web');
  const expected = process.env.DEPLOY_IMAGE?.match(/:([0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?)(?:@sha256:[0-9a-f]{64})?$/)?.[1];
  for (let attempt = 1; attempt <= 30; attempt++) {
    try {
      await checkDeployment(origin, client, expected);
      return;
    } catch (error) {
      if (attempt === 30) throw error;
      console.warn(`Deployment check ${attempt}/30: ${error.message}`);
      await new Promise(resolve => setTimeout(resolve, 2_000));
    }
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) await main();
