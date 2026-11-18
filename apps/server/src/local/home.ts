import { Buffer } from 'node:buffer';
import { setTimeout as delay } from 'node:timers/promises';
import { connectorLimits } from '../../../../packages/shared/src/connector.js';
import { PRIVATE_FORWARD_HEADER, type PrivateForwardRequest, type PrivateForwardResponse } from '../../../../packages/shared/src/private-sessions.js';
import type { PrivateHome, PrivateHomeHost } from '../../../runner/src/private-home.js';
import { handoverPending, readDiscovery } from './discovery.js';
import { startLocalHost, type LocalHost } from './host.js';
import { startLocalServer, type LocalServer } from './launch.js';
import { defaultLocalStateDir, LocalStateBusyError, openLocalState } from './state.js';

const RETRY_MS = 5_000;
const HANDOVER_PAUSE_MS = 30_000;
const FORWARD_TIMEOUT_MS = 25_000;
const RESPONSE_BYTES = Math.floor(connectorLimits.responseBytes / 4) * 3;

export interface PrivateHomeOptions {
  stateDir?: string;
  retryMs?: number;
  handoverPauseMs?: number;
  log?(line: string): void;
}

async function bounded(response: Response, limit: number): Promise<Uint8Array> {
  const reader = response.body?.getReader();
  if (!reader) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const part = await reader.read();
    if (part.done) break;
    size += part.value.byteLength;
    if (size > limit) { await reader.cancel(); throw new Error('The reply is too large to relay'); }
    chunks.push(part.value);
  }
  return Buffer.concat(chunks);
}

export function createPrivateHome(host: PrivateHomeHost, options: PrivateHomeOptions = {}): PrivateHome {
  const stateDir = options.stateDir ?? defaultLocalStateDir();
  const lifetime = new AbortController();
  let running: { server: LocalServer; host: LocalHost } | undefined;
  let pausedUntil = 0;
  let attempt: Promise<void> | undefined;
  let lastProblem = '';

  const problem = (line: string) => {
    if (line === lastProblem) return;
    lastProblem = line;
    options.log?.(line);
  };

  const stopRunning = async () => {
    const current = running;
    running = undefined;
    if (!current) return;
    await current.host.stop().catch(() => {});
    await current.server.close().catch(() => {});
  };

  const handover = () => {
    pausedUntil = Date.now() + (options.handoverPauseMs ?? HANDOVER_PAUSE_MS);
    options.log?.('Handing the Pikibun on this computer over to the one you started.');
    void stopRunning();
  };

  const start = async () => {
    if (running || lifetime.signal.aborted || Date.now() < pausedUntil) return;
    if (await handoverPending(stateDir).catch(() => false)) return;
    let opened;
    try { opened = await openLocalState(stateDir); }
    catch (error) {
      if (!(error instanceof LocalStateBusyError)) problem(`The Pikibun on this computer, which holds your private sessions, can't start: ${error instanceof Error ? error.message : 'its state is unusable'}`);
      return;
    }
    if (lifetime.signal.aborted) { await opened.release(); return; }
    let server: LocalServer;
    try {
      server = await startLocalServer({ stateDir, state: opened.state, release: opened.release, mode: 'local', headless: true, onHandover: handover });
    } catch (error) {
      problem(`The Pikibun on this computer, which holds your private sessions, can't start: ${error instanceof Error ? error.message : 'it failed'}`);
      return;
    }
    const localHost = startLocalHost(server, stateDir, {
      localModels: host.localModels, unsandboxed: host.unsandboxed, resources: host.resources, allowFaux: host.allowFaux, allowTestShell: host.allowTestShell,
      identityDir: host.identityDir, ...(host.sandboxBackend ? { sandboxBackend: host.sandboxBackend } : {}), ...(host.capabilities ? { capabilities: host.capabilities } : {}),
    });
    running = { server, host: localHost };
    lastProblem = '';
    localHost.started.catch((error: unknown) => {
      if (error instanceof Error && error.name === 'AbortError') return;
      problem('This computer could not become the host of its own Pikibun, so its private sessions can\'t run. Check its Pi configuration and prerequisites.');
    });
  };

  void (async () => {
    while (!lifetime.signal.aborted) {
      attempt = start();
      await attempt.catch(() => {});
      await delay(options.retryMs ?? RETRY_MS, undefined, { signal: lifetime.signal }).catch(() => {});
    }
  })();

  const forward = async (request: PrivateForwardRequest, signal: AbortSignal): Promise<PrivateForwardResponse> => {
    const target = await readDiscovery(stateDir);
    if (!target) throw new Error('The Pikibun on this computer is not running');
    const response = await fetch(`${target.origin}${request.path}`, {
      method: request.method, redirect: 'manual', signal: AbortSignal.any([signal, lifetime.signal, AbortSignal.timeout(FORWARD_TIMEOUT_MS)]),
      headers: { [PRIVATE_FORWARD_HEADER]: target.secret, Origin: target.origin, ...(request.body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
      ...(request.body !== undefined ? { body: request.body } : {}),
    });
    const bytes = await bounded(response, RESPONSE_BYTES);
    const type = response.headers.get('content-type')?.replace(/[\r\n]/g, '').slice(0, 200) || 'application/octet-stream';
    return { status: response.status, contentType: type, data: Buffer.from(bytes).toString('base64') };
  };

  return {
    forward,
    async sessions(signal) {
      try {
        const answer = await forward({ method: 'GET', path: '/api/private-sessions' }, signal);
        if (answer.status !== 200) return null;
        const body = JSON.parse(Buffer.from(answer.data, 'base64').toString('utf8')) as { sessions?: unknown };
        return Array.isArray(body?.sessions) ? body.sessions : null;
      } catch { return null; }
    },
    async stop() {
      lifetime.abort();
      await attempt?.catch(() => {});
      await stopRunning();
    },
  };
}
