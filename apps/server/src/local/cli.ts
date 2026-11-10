import { createInterface } from 'node:readline/promises';
import { parseArgs } from 'node:util';
import { assertConnectorPlatform, assertPrerequisites, checkPrerequisites, loadConnectorModels } from '../../../runner/src/connect-setup.js';
import { confirmUnsandboxed, promptHidden, resourceConfig } from '../../../runner/src/connect-cli.js';
import { ConnectorSetupError } from '../../../runner/src/protocol.js';
import { ConfigurationError } from '../config.js';
import { startLocalHost, type LocalHost, type LocalHostOptions } from './host.js';
import { githubOAuthAppInstructions, LocalServerError, startLocalServer } from './launch.js';
import { readNewPassword } from '../password-accounts-cli.js';
import { defaultLocalStateDir, LocalStateError, openLocalState, peekLocalState, sharedOrigin, validGitHubApp, type GitHubOAuthApp, type SharedConfig } from './state.js';

const HELP = `Usage: pikibun serve [options]

Run Pikibun on this computer, for yourself: the server and its web app on
http://127.0.0.1:7878, reachable from this computer only, and this computer as
the host that runs your sessions. No account at a Pikibun service is needed.

You sign in with GitHub through an OAuth app you register once (the first run
says how). The first run prints a sign-in link: the GitHub account that opens
it becomes this Pikibun's owner, and the only account that can sign in.
Everything is kept in the state directory; later runs need no options.

Options:
  --port PORT              Listen on 127.0.0.1:PORT (default 7878; remembered)
  --github-client-id ID    Your GitHub OAuth app's client ID (remembered); its
                           secret is asked at a hidden prompt, or read from
                           PIKIBUN_GITHUB_CLIENT_SECRET
  --no-host                Serve only: run no sessions on this computer (pair
                           other machines with \`pikibun connect\` instead)
  --unsafe-no-sandbox      Run agent work directly on this computer without
                           isolation (macOS or Linux without bubblewrap); asks
                           for confirmation
  --state-dir PATH         Private state (default ~/.local/share/pikibun/server)
  --help                   Show this help

Share it with others (a full multi-user server, from the same data):
  --share                  Serve others at a public HTTPS address, through a TLS
                           proxy or tunnel you run (Caddy, Tailscale Serve,
                           Cloudflare Tunnel); the settings below are remembered,
                           so later runs need only --share
  --public-origin URL      The address people open, https://... (required once)
  --admin USER_ID          An administrator, github:12345 or password:alice
                           (repeatable; required once). The first with an
                           account owns this computer's host
  --listen WHERE           loopback (default: a proxy or tunnel on this
                           computer) or all (a proxy on another machine)
  --trust-proxy            Honor the proxy's X-Forwarded-Proto/-Host
  --signup MODE            Who may create an account: invite (default), open
                           or off
  --password-auth          Also sign in with usernames and passwords
  --create-admin USERNAME  Create the listed administrator password:USERNAME;
                           asks for its password at a hidden prompt
  With --share, --github-client-id names a GitHub OAuth app whose callback is
  <public origin>/api/auth/github/callback (its secret as above).

This computer as the host, as with \`pikibun connect\`:
  --pi-agent-dir PATH      Pi config/auth directory (default: Pi's own)
  --model PROVIDER/MODEL   Offer this configured Pi model (repeatable)
  --resources PATH         Resource configuration JSON for sandboxed bash

Development:
  --test-mode              Also accept test sign-ins for 24 hours, with the secret
                           it prints
  --allow-faux             Offer Pi's deterministic fixture model; needs
                           --test-mode
  --allow-test-shell       Fixture shell opt-in; requires --allow-faux
`;

async function ask(question: string): Promise<string> {
  const prompt = createInterface({ input: process.stdin, output: process.stderr });
  prompt.on('SIGINT', () => prompt.close());
  try { return (await prompt.question(question).catch(() => '')).trim(); } finally { prompt.close(); }
}

async function githubApp(clientId: string | undefined, saved: boolean): Promise<GitHubOAuthApp | undefined> {
  const interactive = process.stdin.isTTY && process.stderr.isTTY;
  if (!clientId) {
    if (saved) return undefined;
    process.stderr.write(`\n${githubOAuthAppInstructions()}\n`);
    if (!interactive) throw new ConnectorSetupError('Run `pikibun serve --github-client-id CLIENT_ID` with the secret in PIKIBUN_GITHUB_CLIENT_SECRET, or run it in a terminal to be asked.');
    clientId = await ask('Client ID: ');
  }
  const fromEnvironment = process.env.PIKIBUN_GITHUB_CLIENT_SECRET?.trim();
  const clientSecret = fromEnvironment || (interactive ? (await promptHidden('Client secret (hidden): ', 'Entering the client secret', 'client secret')).trim() : '');
  if (!clientSecret) throw new ConnectorSetupError('The GitHub OAuth app needs its client secret: type it at the prompt or set PIKIBUN_GITHUB_CLIENT_SECRET.');
  const app = { clientId, clientSecret };
  if (!validGitHubApp(app)) throw new ConnectorSetupError("That doesn't look like a GitHub OAuth app's client ID and secret.");
  return app;
}

async function hostOptions(values: Record<string, string | boolean | string[] | undefined>): Promise<LocalHostOptions> {
  const unsandboxed = values['unsafe-no-sandbox'] === true;
  assertConnectorPlatform();
  if (process.platform === 'darwin' && !unsandboxed) {
    throw new ConnectorSetupError('macOS has no isolated sandbox for agent work. Re-run with --unsafe-no-sandbox and read its warning, or with --no-host to serve only.');
  }
  if (unsandboxed && values.resources) throw new ConnectorSetupError('--resources configures Linux sandbox limits and cannot be combined with --unsafe-no-sandbox.');
  if (values['allow-test-shell'] && !values['allow-faux']) throw new ConnectorSetupError('--allow-test-shell requires --allow-faux.');
  assertPrerequisites(await checkPrerequisites(unsandboxed), unsandboxed, ' Without bubblewrap you can run --unsafe-no-sandbox instead (read its warning first), or --no-host to serve only.');
  const models = (values.model as string[] | undefined)?.map(reference => {
    const slash = reference.indexOf('/');
    if (slash < 1 || slash === reference.length - 1) throw new ConnectorSetupError('--model expects PROVIDER/MODEL.');
    return { provider: reference.slice(0, slash), modelId: reference.slice(slash + 1) };
  });
  const localModels = await loadConnectorModels({ allowFaux: values['allow-faux'] === true, piAgentDir: values['pi-agent-dir'] as string | undefined, models });
  const resources = typeof values.resources === 'string' ? await resourceConfig(values.resources) : undefined;
  if (unsandboxed) await confirmUnsandboxed();
  return {
    localModels, unsandboxed, resources, allowFaux: values['allow-faux'] === true, allowTestShell: values['allow-test-shell'] === true,
    onStatus: (status, reason) => { process.stderr.write(`This computer: ${status}${reason ? ` (${reason})` : ''}\n`); },
    onWarning: () => { process.stderr.write('Some resource domains are unavailable; production bash remains fail-closed.\n'); },
  };
}

export function sharedSettings(saved: SharedConfig | undefined, values: {
  'public-origin'?: string; admin?: string[]; listen?: string; 'trust-proxy'?: boolean; signup?: string; 'password-auth'?: boolean;
}): Omit<SharedConfig, 'github'> {
  const origin = values['public-origin'] ?? saved?.origin;
  if (!origin) throw new ConnectorSetupError('--share needs --public-origin https://... the first time: the address people open, served by your TLS proxy or tunnel.');
  const parsed = sharedOrigin(origin);
  if (!parsed.ok) throw new ConnectorSetupError(`--public-origin: ${parsed.error}`);
  const admins = values.admin ?? saved?.admins;
  if (!admins?.length) throw new ConnectorSetupError('--share needs --admin USER_ID the first time (github:12345, which https://api.github.com/users/<login> shows as id, or password:alice).');
  const listen = values.listen ?? saved?.listen ?? 'loopback';
  if (listen !== 'loopback' && listen !== 'all') throw new ConnectorSetupError('--listen must be loopback or all.');
  const signup = values.signup ?? saved?.signup ?? 'invite';
  if (signup !== 'open' && signup !== 'invite' && signup !== 'off') throw new ConnectorSetupError('--signup must be open, invite or off.');
  return { origin: parsed.origin, admins, listen, signup, trustProxy: values['trust-proxy'] ?? saved?.trustProxy ?? false,
    passwordAuth: values['password-auth'] ?? saved?.passwordAuth ?? false };
}

export async function serveMain(args = process.argv.slice(2)): Promise<void> {
  const { values } = parseArgs({ args, strict: true, allowPositionals: false, options: {
    help: { type: 'boolean' }, port: { type: 'string' }, 'github-client-id': { type: 'string' }, 'no-host': { type: 'boolean' },
    'unsafe-no-sandbox': { type: 'boolean' }, 'state-dir': { type: 'string' }, 'pi-agent-dir': { type: 'string' },
    model: { type: 'string', multiple: true }, resources: { type: 'string' },
    'allow-faux': { type: 'boolean' }, 'allow-test-shell': { type: 'boolean' }, 'test-mode': { type: 'boolean' },
    share: { type: 'boolean' }, 'public-origin': { type: 'string' }, admin: { type: 'string', multiple: true }, listen: { type: 'string' },
    'trust-proxy': { type: 'boolean' }, signup: { type: 'string' }, 'password-auth': { type: 'boolean' }, 'create-admin': { type: 'string' },
  } });
  if (values.help) { process.stdout.write(HELP); return; }
  const share = values.share === true;
  const shareOnly = ['public-origin', 'admin', 'listen', 'trust-proxy', 'signup', 'password-auth', 'create-admin'] as const;
  const misplaced = shareOnly.find(name => values[name] !== undefined);
  if (!share && misplaced) throw new ConnectorSetupError(`--${misplaced} needs --share.`);
  const port = values.port === undefined ? undefined : Number(values.port);
  if (port !== undefined && !(Number.isInteger(port) && port >= 1024 && port <= 65535)) throw new ConnectorSetupError('--port must be a number from 1024 to 65535.');
  if (values['allow-faux'] && !values['test-mode']) throw new ConnectorSetupError('--allow-faux needs --test-mode: a server outside test mode offers no fixture models.');
  const stateDir = values['state-dir'] ?? defaultLocalStateDir();
  let server;
  let host: LocalHost | undefined;
  try {
    const existing = await peekLocalState(stateDir);
    const shared = share ? sharedSettings(existing?.shared, values) : undefined;
    const github = shared
      ? (values['github-client-id'] ? await githubApp(values['github-client-id'], false) : undefined)
      : await githubApp(values['github-client-id'], existing?.github !== undefined);
    if (values['create-admin'] && !values['create-admin'].trim()) throw new ConnectorSetupError('--create-admin needs a username.');
    const hostSetup = values['no-host'] ? undefined : await hostOptions(values);
    const { state, release } = await openLocalState(stateDir, {
      ...(shared ? { shared: { ...shared, ...(github ? { github } : {}) } } : github ? { github } : {}), ...(port ? { port } : {}),
    });
    const testSecret = values['test-mode'] ? Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64url') : undefined;
    server = await startLocalServer({ stateDir, state, release, mode: shared ? 'shared' : 'local', ...(testSecret ? { extraEnv: {
      TEST_AUTH_ENABLED: 'true', TEST_AUTH_SECRET: testSecret, TEST_AUTH_EXPIRES_AT: new Date(Date.now() + 24 * 3600_000).toISOString() } } : {}) });
    if (shared) {
      process.stderr.write(`\nPikibun is shared at ${server.origin}, listening on ${server.address}.\n`
        + `Point your TLS proxy or tunnel for ${server.origin} at ${server.address.replace('0.0.0.0', '<this computer>')}.\n`
        + `Administrators: ${state.shared!.admins.join(', ')}. New accounts: ${state.shared!.signup}.\n`);
      if (values['create-admin']) process.stderr.write(`${await server.createAdmin(values['create-admin'].trim(), await readNewPassword())}\n`);
    } else {
      const claim = await server.claimUrl();
      process.stderr.write(`\nPikibun is running at ${server.origin} (this computer only).\n`);
      process.stderr.write(claim
        ? `Sign in for the first time with this link; the GitHub account that opens it becomes this Pikibun's owner:\n  ${claim}\nKeep it private until you have signed in.\n`
        : `Sign in at ${server.origin} with the GitHub account that owns it.\n`);
    }
    if (testSecret) process.stderr.write(`Test mode for 24 hours. Test sign-in secret: ${testSecret}\n`);
    if (hostSetup) {
      host = startLocalHost(server, stateDir, { ...hostSetup, onWaiting: () => process.stderr.write('This computer becomes your host once you have signed in.\n') });
      host.started.catch((error: unknown) => {
        process.stderr.write(error instanceof ConnectorSetupError ? `This computer could not become the host: ${error.message}\n`
          : error instanceof Error && error.name === 'AbortError' ? '' : 'This computer could not become the host. Check its Pi configuration and prerequisites.\n');
      });
    } else {
      process.stderr.write('No host on this computer (--no-host): pair one in Settings › Hosts.\n');
    }
  } catch (error) {
    await server?.close().catch(() => {});
    if (error instanceof LocalStateError || error instanceof LocalServerError || error instanceof ConfigurationError) throw new ConnectorSetupError(error.message);
    throw error;
  }
  const stopped = Promise.withResolvers<void>();
  const stop = () => stopped.resolve();
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  try { await stopped.promise; }
  finally {
    process.off('SIGINT', stop); process.off('SIGTERM', stop);
    process.stderr.write('Stopping Pikibun…\n');
    await host?.stop().catch(() => {});
    await server.close();
  }
}
