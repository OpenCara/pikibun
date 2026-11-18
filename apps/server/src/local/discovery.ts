import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { open, rename, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { PRIVATE_FORWARD_HEADER } from '../../../../packages/shared/src/private-sessions.js';
import { LocalStateBusyError, openLocalState, privateStateDirectory, type LocalState, type LocalStateChanges } from './state.js';

export const DISCOVERY_FILE = 'local.json';
const HANDOVER_FILE = 'handover.json';
const SECRET = /^[A-Za-z0-9_-]{43}$/;

export interface LocalDiscovery {
  version: 1;
  pid: number;
  port: number;
  origin: string;
  secret: string;
  headless: boolean;
}

function parseDiscovery(value: unknown): LocalDiscovery | undefined {
  const input = value as Partial<LocalDiscovery> | null;
  if (!input || typeof input !== 'object' || input.version !== 1 || !Number.isSafeInteger(input.pid) || (input.pid ?? 0) < 1
    || !Number.isInteger(input.port) || (input.port ?? 0) < 1 || (input.port ?? 0) > 65535 || typeof input.origin !== 'string'
    || input.origin !== `http://127.0.0.1:${input.port}` || typeof input.secret !== 'string' || !SECRET.test(input.secret) || typeof input.headless !== 'boolean') return undefined;
  return { version: 1, pid: input.pid!, port: input.port!, origin: input.origin, secret: input.secret, headless: input.headless };
}

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code === 'EPERM'; }
}

async function writePrivate(stateDir: string, name: string, value: unknown): Promise<void> {
  const directory = await privateStateDirectory(stateDir);
  const temporary = join(directory, `.local-${randomUUID()}.tmp`);
  const file = await open(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
  try {
    await file.writeFile(`${JSON.stringify(value)}\n`);
    await file.sync();
  } finally { await file.close(); }
  try { await rename(temporary, join(directory, name)); } catch (error) { await unlink(temporary).catch(() => {}); throw error; }
}

async function readPrivate(stateDir: string, name: string): Promise<unknown> {
  let file;
  try { file = await open(join(stateDir, name), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
  catch { return undefined; }
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.nlink !== 1 || (stat.mode & 0o777) !== 0o600 || stat.size > 4096 || (process.getuid && stat.uid !== process.getuid())) return undefined;
    try { return JSON.parse(await file.readFile('utf8')); } catch { return undefined; }
  } finally { await file.close(); }
}

export async function writeDiscovery(stateDir: string, discovery: LocalDiscovery): Promise<void> {
  await writePrivate(stateDir, DISCOVERY_FILE, discovery);
}

export async function handoverPending(stateDir: string): Promise<boolean> {
  const value = await readPrivate(stateDir, HANDOVER_FILE) as { until?: unknown } | undefined;
  return typeof value?.until === 'number' && value.until > Date.now();
}

export async function readDiscovery(stateDir: string): Promise<LocalDiscovery | undefined> {
  const discovery = parseDiscovery(await readPrivate(stateDir, DISCOVERY_FILE));
  return discovery && alive(discovery.pid) ? discovery : undefined;
}

export async function removeDiscovery(stateDir: string, secret: string): Promise<void> {
  const current = await readDiscovery(stateDir).catch(() => undefined);
  if (current && current.secret !== secret) return;
  await unlink(join(stateDir, DISCOVERY_FILE)).catch(() => {});
}

export async function openLocalStateTakingOver(stateDir: string, changes: LocalStateChanges = {}, waitMs = 15_000): Promise<{ state: LocalState; release(): Promise<void> }> {
  try { return await openLocalState(stateDir, changes); }
  catch (error) {
    if (!(error instanceof LocalStateBusyError)) throw error;
    const running = await readDiscovery(stateDir).catch(() => undefined);
    if (!running?.headless) throw error;
    await writePrivate(stateDir, HANDOVER_FILE, { until: Date.now() + waitMs });
    const response = await fetch(`${running.origin}/api/local/handover`, { method: 'POST', redirect: 'manual', signal: AbortSignal.timeout(5000),
      headers: { [PRIVATE_FORWARD_HEADER]: running.secret, Origin: running.origin } }).catch(() => undefined);
    await response?.body?.cancel().catch(() => {});
    if (response?.status !== 202) throw error;
    const deadline = Date.now() + waitMs;
    try {
      for (;;) {
        await delay(200);
        try { return await openLocalState(stateDir, changes); }
        catch (retry) {
          if (!(retry instanceof LocalStateBusyError) || Date.now() > deadline) throw retry;
        }
      }
    } finally {
      await unlink(join(stateDir, HANDOVER_FILE)).catch(() => {});
    }
  }
}
