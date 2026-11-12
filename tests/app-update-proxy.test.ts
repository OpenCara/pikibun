import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { curlArguments, GNOME_PROXY_PROBE, SHELL_PROXY_PROBE, shellProxy } from '../apps/nsh/src/lib/update-proxy.js';

const unix = process.platform !== 'win32';
const has = (command: string) => unix && spawnSync('sh', ['-c', `command -v ${command}`]).status === 0;
const shells = ['bash', 'zsh'].filter(has);

test('the desktop app\'s proxy probes parse in every shell at hand', { skip: !unix && 'no POSIX shell' }, () => {
  for (const shell of ['sh', ...shells]) {
    for (const script of [SHELL_PROXY_PROBE, GNOME_PROXY_PROBE]) {
      const result = spawnSync(shell, ['-n', '-c', script], { encoding: 'utf8' });
      assert.equal(result.status, 0, `${shell}: ${result.stderr}`);
    }
  }
});

test('the login shell gives the proxy its startup files export, as a terminal has it', { skip: !shells.length && 'no bash or zsh' }, () => {
  const home = mkdtempSync(path.join(tmpdir(), 'pikibun-proxy-'));
  try {
    const exports = 'echo "Welcome back"\nexport https_proxy=http://127.0.0.1:7890 http_proxy=http://127.0.0.1:7890 all_proxy=socks5://127.0.0.1:7891\n';
    for (const rc of ['.bashrc', '.bash_profile', '.zshrc']) writeFileSync(path.join(home, rc), exports);
    const env = { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: home, ZDOTDIR: home };
    for (const shell of shells) {
      const result = spawnSync(shell, ['-ilc', SHELL_PROXY_PROBE], { encoding: 'utf8', env, input: '' });
      assert.equal(shellProxy(result.stdout), 'http://127.0.0.1:7890', `${shell}: ${result.stdout} ${result.stderr}`);
    }
    const none = spawnSync('sh', ['-c', SHELL_PROXY_PROBE], { encoding: 'utf8', env });
    assert.equal(shellProxy(none.stdout), null);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('curl downloads the release through the proxy it is given', { skip: !has('curl') && 'no curl' }, async () => {
  const seen: string[] = [];
  const body = Buffer.from('the new Pikibun');
  const proxy = createServer((request, response) => {
    seen.push(`${request.method} ${request.url} ${request.headers['user-agent']}`);
    if (request.url?.endsWith('/redirect')) {
      response.writeHead(302, { Location: 'http://objects.example.invalid/asset' }).end();
      return;
    }
    response.writeHead(200, { 'Content-Length': body.length }).end(body);
  });
  await new Promise<void>(resolve => proxy.listen(0, '127.0.0.1', resolve));
  const dir = mkdtempSync(path.join(tmpdir(), 'pikibun-curl-'));
  try {
    const { port } = proxy.address() as AddressInfo;
    const args = curlArguments('http://github.example.invalid/redirect', `http://127.0.0.1:${port}`, 'Pikibun.part');
    const code = await new Promise<number | null>(resolve => {
      const child = spawn('sh', ['-c', 'exec curl "$@"', 'pikibun-update', ...args], { cwd: dir, stdio: 'ignore' });
      child.on('close', resolve);
    });
    assert.equal(code, 0);
    assert.deepEqual(readFileSync(path.join(dir, 'Pikibun.part')), body);
    assert.deepEqual(seen, [
      'GET http://github.example.invalid/redirect Pikibun-App',
      'GET http://objects.example.invalid/asset Pikibun-App',
    ]);
  } finally {
    proxy.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
