import assert from 'node:assert/strict';
import test from 'node:test';
import { redactSmokeOutput, smokeOrigin } from '../scripts/nsh-macos-smoke.ts';

test('redacts OAuth callback codes and state from native warnings', () => {
  const message = 'warn web view navigation to pikibun://auth?code=example-code&state=example-state is not granted';
  assert.equal(redactSmokeOutput(message), 'warn web view navigation to pikibun://auth?[redacted] is not granted');
});

test('redacts HTTPS queries, fragments and bearer tokens without hiding failures', () => {
  assert.equal(
    redactSmokeOutput('failed https://example.test/callback?code=example-code#secret Bearer example-token'),
    'failed https://example.test/callback?[redacted] Bearer [redacted]',
  );
  assert.equal(redactSmokeOutput('https://example.test/#secret'), 'https://example.test/?[redacted]');
  assert.equal(redactSmokeOutput('loaded https://example.test/login'), 'loaded https://example.test/login');
});

test('accepts HTTPS origins and loopback HTTP development servers', () => {
  assert.equal(smokeOrigin('https://pikibun.com'), 'https://pikibun.com');
  assert.equal(smokeOrigin('http://127.0.0.1:8787/'), 'http://127.0.0.1:8787');
  assert.equal(smokeOrigin('http://localhost:8787'), 'http://localhost:8787');
  assert.equal(smokeOrigin('http://[::1]:8787'), 'http://[::1]:8787');
});

test('rejects credentials, non-origin URLs and insecure remote servers', () => {
  for (const value of [
    'https://user:password@example.test', 'https://example.test/path',
    'https://example.test/?code=example-code', 'https://example.test/#secret',
    'http://example.test', 'file:///tmp/example', 'not a URL',
  ]) assert.throws(() => smokeOrigin(value), value);
});
