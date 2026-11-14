import { spawn } from 'node:child_process';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { nshBinary } from './nsh.mjs';

const app = fileURLToPath(new URL('../apps/nsh/', import.meta.url));

export function redactSmokeOutput(line: string): string {
  return line.replace(/\b(?:https?|pikibun):\/\/[^\s<>"']+/g, url => {
    const query = url.search(/[?#]/);
    return query < 0 ? url : `${url.slice(0, query)}?[redacted]`;
  }).replace(/\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi, 'Bearer [redacted]');
}

export function smokeOrigin(input: string): string {
  const url = new URL(input);
  if (url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw new Error('--server must be an origin without credentials, a path, query or fragment.');
  }
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))) {
    throw new Error('--server requires HTTPS, except for a loopback development server.');
  }
  return url.origin;
}

async function run(args: string[]) {
  const child = spawn(await nshBinary(), args, {
    cwd: app, stdio: ['inherit', 'pipe', 'pipe'], env: { ...process.env, NO_COLOR: '1' },
  });
  const closed = new Promise<number | null>((resolve, reject) => {
    child.once('error', reject);
    child.once('close', resolve);
  });
  const forward = async (stream: NodeJS.ReadableStream, output: NodeJS.WritableStream) => {
    for await (const line of createInterface({ input: stream, crlfDelay: Infinity })) {
      output.write(`${redactSmokeOutput(line)}\n`);
    }
  };
  const [status] = await Promise.all([closed, forward(child.stdout!, process.stdout), forward(child.stderr!, process.stderr)]);
  if (status !== 0) throw new Error(`nsh ${args.join(' ')} exited with ${status ?? 'a signal'}`);
}

export async function main(args = process.argv.slice(2)) {
  const { values } = parseArgs({ args, options: {
    help: { type: 'boolean' }, live: { type: 'boolean' },
    server: { type: 'string', default: 'https://pikibun.com' },
    display: { type: 'string' }, 'timeout-ms': { type: 'string', default: '600000' },
  } });
  if (values.help) {
    console.log(`Usage: pnpm test:client-macos [--live] [--server https://pikibun.com] [--display 1] [--timeout-ms 600000]

Runs the stubbed app and screenshot tests on real AppKit windows.
--live additionally opens the app against a live server for you to sign in with a code:
make one on the web under Settings > Profile > Signed-in apps > Sign in an app, and
paste its link. The test passes only when the authenticated session list appears.
It takes no live screenshots and redacts URL queries.
Its isolated app storage is discarded when the test ends. The Native Shell CLI is the one
scripts/nsh.mjs pins (NSH_BIN overrides it).`);
    return;
  }
  if (process.platform !== 'darwin') throw new Error('The AppKit smoke tests require macOS.');
  const origin = smokeOrigin(values.server!);
  const timeout = Number(values['timeout-ms']);
  if (!Number.isSafeInteger(timeout) || timeout < 1000 || timeout > 3600000) {
    throw new Error('--timeout-ms must be an integer from 1000 to 3600000.');
  }
  if (values.display !== undefined && !/^[1-9]\d*$/.test(values.display)) {
    throw new Error('--display must be a positive integer.');
  }
  const target = ['--target', 'macos', ...(values.display ? ['--display', values.display] : [])];
  await mkdir(`${app}/.nsh/screenshots`, { recursive: true });
  await run(['test', ...target, 'tests/app.test.tsx']);
  await run(['test', ...target, 'tests/screenshots.test.tsx']);
  console.log('Stubbed screenshots: apps/nsh/.nsh/screenshots');
  if (!values.live) return;

  const directory = `${app}/.nsh/smoke`;
  const file = `${directory}/live-${process.pid}.test.tsx`;
  await mkdir(directory, { recursive: true });
  try {
    await writeFile(file, `import { open, test } from 'nsh/test';
test('a code made on the web signs the native app in', async () => {
  const app = await open('../../App.tsx', {
    network: 'live', platform: 'macos', width: 1100, height: 900,
    storage: { 'pikibun.origin': ${JSON.stringify(origin)} },
  });
  await app.waitFor('id:code-input', { timeout: 20000 });
  console.log('Make a code on the web (Settings > Profile > Signed-in apps > Sign in an app), paste its link in the native window and sign in. Waiting for the authenticated session list.');
  await app.waitFor('id:open-settings', { timeout: ${timeout} });
  console.log('The code signed the native app in.');
}, ${timeout + 60000});
`, { mode: 0o600, flag: 'wx' });
    console.log(`Live sign-in smoke test: ${origin}. No credentials are supplied by this script.`);
    await run(['test', ...target, `.nsh/smoke/live-${process.pid}.test.tsx`]);
  } finally {
    await rm(file, { force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => {
    console.error(redactSmokeOutput(error instanceof Error ? error.message : String(error)));
    process.exitCode = 1;
  });
}
