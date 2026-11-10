import { readFile, rename, writeFile } from 'node:fs/promises';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { savedPairing } from '../../../runner/src/connect-setup.js';
import { createConnector, type ConnectorOptions, type LocalConnector } from '../../../runner/src/connector.js';
import { createPairing } from '../connectors.js';
import type { LocalServer } from './launch.js';

export type LocalHostOptions = Pick<ConnectorOptions, 'localModels' | 'unsandboxed' | 'resources' | 'allowFaux' | 'allowTestShell' | 'onStatus' | 'onWarning' | 'capabilities'
  | 'acquireLease' | 'runtimeFactory'>;

export interface LocalHost {
  readonly started: Promise<void>;
  stop(): Promise<void>;
}

export const localHostStateDir = (stateDir: string, mode: LocalServer['mode'] = 'local'): string => join(stateDir, mode === 'shared' ? 'connector-shared' : 'connector');

const ownerFile = (dataDir: string) => `${dataDir}.owner`;
async function pairedOwner(dataDir: string): Promise<string | undefined> {
  try { return (await readFile(ownerFile(dataDir), 'utf8')).trim() || undefined; } catch { return undefined; }
}
async function savePairedOwner(dataDir: string, owner: string): Promise<void> {
  const temporary = `${ownerFile(dataDir)}.${process.pid}.tmp`;
  await writeFile(temporary, `${owner}\n`, { mode: 0o600 });
  await rename(temporary, ownerFile(dataDir));
}

export function startLocalHost(server: LocalServer, stateDir: string, options: LocalHostOptions & { onWaiting?(): void; pollMs?: number }): LocalHost {
  const stopped = new AbortController();
  let connector: LocalConnector | undefined;
  const started = (async () => {
    let owner = await server.owner();
    if (!owner) options.onWaiting?.();
    while (!owner) {
      await delay(options.pollMs ?? 1000, undefined, { signal: stopped.signal });
      owner = await server.owner();
    }
    stopped.signal.throwIfAborted();
    const dataDir = localHostStateDir(stateDir, server.mode);
    const saved = await savedPairing(dataDir, true);
    const recorded = await pairedOwner(dataDir);
    const sameOwner = recorded === undefined ? server.mode === 'local' : recorded === owner.id;
    const pairing = saved === server.origin && sameOwner ? undefined : await createPairing(server.env, owner.id, hostname().slice(0, 120) || 'This computer');
    stopped.signal.throwIfAborted();
    connector = createConnector({
      ...options, dataDir, server: server.origin, allowInsecureLoopback: true,
      ...(pairing ? { pairing: { id: pairing.id, code: pairing.code }, replacePairing: saved !== undefined } : {}),
      capabilities: options.capabilities ?? { platform: process.platform, sandbox: false, productionShell: false },
    });
    await connector.start();
    if (pairing || recorded !== owner.id) await savePairedOwner(dataDir, owner.id);
  })();
  void started.catch(() => {});
  return {
    started,
    async stop() {
      stopped.abort();
      await connector?.stop();
    },
  };
}
