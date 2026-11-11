import { parseArgs } from 'node:util';
import { z } from 'zod';
import { stdioTransport, type Transport } from '../../../runner/src/app-host-transport.js';
import { assertConnectorPlatform, assertPrerequisites, hostIsolation, loadConnectorModels, unsandboxedWarning } from '../../../runner/src/connect-setup.js';
import type { LocalModels } from '../../../runner/src/local-pi.js';
import { ConnectorSetupError } from '../../../runner/src/protocol.js';
import { ConfigurationError } from '../config.js';
import type { ServerEvent, ServerHostState, ServerInspection, ServerRequest, ServerStartRequest, ServerStatus } from '../../../../packages/shared/src/app-server-protocol.js';
import { startLocalHost, type LocalHost } from './host.js';
import { LocalServerError, startLocalServer, type LocalServer } from './launch.js';
import { DEFAULT_LOCAL_PORT, defaultLocalStateDir, LocalStateError, openLocalState, peekLocalState } from './state.js';

const requestId = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const githubApp = z.object({ clientId: z.string().min(1).max(100), clientSecret: z.string().min(1).max(200) }).strict();
const requestSchema: z.ZodType<ServerRequest> = z.discriminatedUnion('type', [
  z.object({ type: z.literal('inspect'), id: requestId }).strict(),
  z.object({ type: z.literal('start'), id: requestId, github: githubApp.optional(), unsandboxedConsent: z.boolean().optional() }).strict(),
  z.object({ type: z.literal('stop'), id: requestId }).strict(),
]);

class ServerFailure extends Error {}

function message(error: unknown, fallback: string): string {
  return error instanceof ServerFailure || error instanceof LocalStateError || error instanceof LocalServerError
    || error instanceof ConfigurationError || error instanceof ConnectorSetupError ? error.message : fallback;
}

interface Running { server: LocalServer; host?: LocalHost; hostState: ServerHostState; stopping: boolean }

let transport: Transport<ServerEvent>;
let stateDir: string;
let staticDir: string | undefined;
let running: Running | undefined;
let starting = false;

function emit(event: ServerEvent): void { transport.send(event); }
function log(level: 'info' | 'warning' | 'error', text: string): void { emit({ type: 'log', level, message: text }); }

async function claimOf(server: LocalServer): Promise<string | undefined> {
  const url = await server.claimUrl().catch(() => null);
  return url ? new URL(url).searchParams.get('token') ?? undefined : undefined;
}

async function status(): Promise<void> {
  const current = running;
  if (!current) { emit({ type: 'status', state: 'stopped', host: 'off' }); return; }
  const claim = await claimOf(current.server);
  const update: ServerStatus = { state: current.stopping ? 'stopping' : 'running', origin: current.server.origin, host: current.hostState, ...(claim ? { claim } : {}) };
  if (running === current) emit({ type: 'status', ...update });
}

async function hostCheck(): Promise<{ mode: ServerInspection['hostMode']; problem?: string; models?: LocalModels }> {
  try { assertConnectorPlatform({ unsandboxed: process.platform !== 'linux' }); }
  catch (error) { return { mode: 'unsandboxed', problem: message(error, 'This computer cannot run Pikibun sessions.') }; }
  const { mode, prerequisites } = await hostIsolation();
  try {
    assertPrerequisites(prerequisites, mode === 'unsandboxed', '');
    return { mode, models: await loadConnectorModels({}) };
  } catch (error) {
    return { mode, problem: message(error, "Pi's models could not be loaded. Check Pi's configuration on this computer.") };
  }
}

async function inspect(): Promise<ServerInspection> {
  const state = await peekLocalState(stateDir);
  const host = await hostCheck();
  return {
    stateDir, port: state?.port ?? DEFAULT_LOCAL_PORT, hostMode: host.mode,
    ...(state?.github ? { githubClientId: state.github.clientId } : {}),
    ...(host.mode === 'unsandboxed' ? { unsandboxedWarning: unsandboxedWarning() } : {}),
    ...(host.problem ? { hostProblem: host.problem } : {}),
  };
}

async function start(request: ServerStartRequest): Promise<void> {
  if (running || starting) throw new ServerFailure('Pikibun is already running on this computer.');
  starting = true;
  try {
    const github = request.github && { clientId: request.github.clientId.trim(), clientSecret: request.github.clientSecret.trim() };
    request.github = undefined;
    const { state, release } = await openLocalState(stateDir, github ? { github } : {});
    if (!state.github) { await release(); throw new ServerFailure('Add your GitHub OAuth app first: Pikibun signs you in with it.'); }
    const host = await hostCheck().catch(async (error: unknown) => { await release(); throw error; });
    const server = await startLocalServer({ stateDir, state, release, mode: 'local', ...(staticDir ? { staticDir } : {}) });
    const current: Running = { server, hostState: 'off', stopping: false };
    running = current;
    log('info', `Pikibun is running at ${server.origin}, reachable from this computer only.`);
    const unsandboxed = host.mode === 'unsandboxed';
    if (host.problem || !host.models) log('warning', `This computer can't run sessions yet: ${host.problem ?? "Pi has no models."} Start Pikibun again once that is fixed.`);
    else if (unsandboxed && request.unsandboxedConsent !== true) log('warning', 'This computer runs no sessions: running them without a sandbox needs your consent.');
    else {
      const setHost = (next: ServerHostState) => { if (running === current) { current.hostState = next; void status(); } };
      current.host = startLocalHost(server, stateDir, {
        localModels: host.models, unsandboxed,
        onWaiting: () => setHost('waiting'),
        onStatus: (next, reason) => {
          setHost(next);
          if (next === 'disconnected' && reason) log('warning', `This computer's host disconnected: ${reason}`);
        },
        onWarning: () => log('warning', 'Some resource domains are unavailable; production bash remains fail-closed.'),
      });
      current.host.started.catch((error: unknown) => {
        if (current.stopping || (error instanceof Error && error.name === 'AbortError')) return;
        setHost('failed');
        log('error', message(error, "This computer could not become Pikibun's host. Check its Pi configuration and prerequisites."));
      });
    }
    await status();
  } finally { starting = false; }
}

async function stop(): Promise<void> {
  const current = running;
  if (!current || current.stopping) return;
  current.stopping = true;
  await status();
  try {
    await current.host?.stop().catch(() => {});
    await current.server.close();
  } finally {
    running = undefined;
    await status();
  }
}

async function handle(request: ServerRequest): Promise<void> {
  try {
    if (request.type === 'inspect') emit({ type: 'result', id: request.id, ok: true, inspection: await inspect() });
    else {
      await (request.type === 'start' ? start(request) : stop());
      emit({ type: 'result', id: request.id, ok: true });
    }
  } catch (error) {
    emit({ type: 'result', id: request.id, ok: false, error: { message: message(error, request.type === 'stop' ? 'Pikibun did not stop cleanly.'
      : 'Pikibun could not start on this computer. Check its state directory and port.') } });
  }
}

let closing = false;
async function shutdown(): Promise<void> {
  if (closing) return;
  closing = true;
  await stop().catch(() => {});
  process.exit(0);
}

export function runAppServer(args: string[]): void {
  if (transport) throw new Error('Pikibun is already running in this process.');
  const { values } = parseArgs({ args, strict: true, allowPositionals: false,
    options: { stdio: { type: 'boolean' }, 'state-dir': { type: 'string' }, 'static-dir': { type: 'string' } } });
  if (!values.stdio) throw new ConnectorSetupError('This mode speaks only over --stdio.');
  stateDir = values['state-dir'] ?? defaultLocalStateDir();
  staticDir = values['static-dir'];
  transport = stdioTransport<ServerEvent>();
  transport.onMessage(value => {
    const request = requestSchema.safeParse(value);
    if (request.success) { void handle(request.data); return; }
    const id = value && typeof value === 'object' && 'id' in value && typeof value.id === 'number' && Number.isSafeInteger(value.id) && value.id >= 0 ? value.id : undefined;
    if (id === undefined) log('error', 'Ignored a malformed request.');
    else emit({ type: 'result', id, ok: false, error: { message: 'Refused a malformed request.' } });
  });
  transport.onClose(() => { void shutdown(); });
  process.once('SIGTERM', () => { void shutdown(); });
  process.once('SIGINT', () => { void shutdown(); });
  emit({ type: 'ready' });
}
