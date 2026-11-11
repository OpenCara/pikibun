import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { LINUX_INSTALL, MAC_INSTALL } from '../apps/nsh/src/lib/update-scripts.js';

const unix = process.platform !== 'win32';
const linux = process.platform === 'linux';
const shells = ['sh', 'bash', 'dash', 'zsh'].filter(shell => unix && spawnSync(shell, ['-c', 'exit 0']).status === 0);

test('the desktop app\'s install scripts parse in every shell at hand', { skip: !unix && 'no POSIX shell' }, () => {
  for (const shell of shells) {
    for (const [name, script] of [['macOS', MAC_INSTALL], ['Linux', LINUX_INSTALL]] as const) {
      const result = spawnSync(shell, ['-n', '-c', script], { encoding: 'utf8' });
      assert.equal(result.status, 0, `${name} in ${shell}: ${result.stderr}`);
    }
  }
});

const until = async (condition: () => boolean, ms = 8000) => {
  const deadline = Date.now() + ms;
  while (!condition()) {
    if (Date.now() > deadline) return false;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  return true;
};

async function runAsTheApp(root: string, appFolder: string, tarball: string) {
  const app = path.join(appFolder, 'Pikibun');
  const child = spawn(app, ['-c', 'sh -c "$1" pikibun-update "$2"; status=$?; exit $status', 'pikibun', LINUX_INSTALL, tarball],
    { cwd: root, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', chunk => { stdout += chunk; });
  child.stderr.on('data', chunk => { stderr += chunk; });
  const code = await new Promise<number | null>(resolve => child.on('close', resolve));
  try { process.kill(-child.pid!, 'SIGKILL'); } catch { }
  return { code, stdout, stderr };
}

function fixture() {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'pikibun-update-')));
  const sh = realpathSync(spawnSync('sh', ['-c', 'command -v sh'], { encoding: 'utf8' }).stdout.trim());
  const appFolder = path.join(root, 'apps', 'Pikibun');
  mkdirSync(path.join(appFolder, 'nsh'), { recursive: true });
  copyFileSync(sh, path.join(appFolder, 'Pikibun'));
  chmodSync(path.join(appFolder, 'Pikibun'), 0o755);
  writeFileSync(path.join(appFolder, 'nsh', 'bundle.nshc'), 'old');
  const build = path.join(root, 'build', 'Pikibun');
  mkdirSync(path.join(build, 'nsh'), { recursive: true });
  writeFileSync(path.join(build, 'nsh', 'bundle.nshc'), 'new');
  writeFileSync(path.join(build, 'Pikibun'), `#!/bin/sh\necho "relaunched in $(pwd)" > '${path.join(root, 'relaunched')}'\n`);
  chmodSync(path.join(build, 'Pikibun'), 0o755);
  const tarball = path.join(root, 'Pikibun-0.17.0-linux-x86_64.tar.gz');
  assert.equal(spawnSync('tar', ['-czf', tarball, '-C', path.join(root, 'build'), 'Pikibun']).status, 0);
  return { root, appFolder, tarball };
}

test('on Linux, the update replaces the app\'s folder and starts the new app once the old one has quit', { skip: !linux && 'Linux only' }, async () => {
  const { root, appFolder, tarball } = fixture();
  try {
    const result = await runAsTheApp(root, appFolder, tarball);
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, new RegExp(`Installed in ${appFolder.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\.`));
    assert.equal(readFileSync(path.join(appFolder, 'nsh', 'bundle.nshc'), 'utf8'), 'new');
    assert.ok(await until(() => existsSync(path.join(root, 'relaunched'))), 'the new app was started after the old one quit, outside its process group');
    assert.match(readFileSync(path.join(root, 'relaunched'), 'utf8'), /^relaunched in \//);
    assert.ok(await until(() => readdirSync(path.join(root, 'apps')).length === 1), `the old folder is removed: ${readdirSync(path.join(root, 'apps'))}`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('on Linux, a package that doesn\'t unpack to the app leaves the app as it was', { skip: !linux && 'Linux only' }, async () => {
  const { root, appFolder } = fixture();
  try {
    const broken = path.join(root, 'broken.tar.gz');
    writeFileSync(broken, 'not a tarball');
    const result = await runAsTheApp(root, appFolder, broken);
    assert.equal(result.code, 1);
    assert.match(result.stderr, /The new Pikibun couldn't be unpacked next to /);
    assert.equal(readFileSync(path.join(appFolder, 'nsh', 'bundle.nshc'), 'utf8'), 'old');
    assert.deepEqual(readdirSync(path.join(root, 'apps')), ['Pikibun']);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('on Linux, an app folder it can\'t write next to is left alone, saying why', { skip: (!linux || process.getuid?.() === 0) && 'Linux, not as root' }, async () => {
  const { root, appFolder, tarball } = fixture();
  try {
    chmodSync(path.join(root, 'apps'), 0o555);
    const result = await runAsTheApp(root, appFolder, tarball);
    assert.equal(result.code, 1);
    assert.match(result.stderr, /can't be written by .+: unpack the update from its release page yourself\./);
    assert.equal(readFileSync(path.join(appFolder, 'nsh', 'bundle.nshc'), 'utf8'), 'old');
  } finally {
    chmodSync(path.join(root, 'apps'), 0o755);
    rmSync(root, { recursive: true, force: true });
  }
});
