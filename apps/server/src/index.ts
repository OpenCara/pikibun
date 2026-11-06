import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import type { WorkerEnv } from './types.js';
import {
  assertVaultConfigured, authenticate, csrfGuard, localOwner, registerAdmin, registerAuth, registerGitAccounts, registerHostAccess,
  registerNetworkPolicies, registerOidc, registerPasswordAuth, registerPushIdentities, registerRepositories, registerRequesterAutoApprove,
  registerSourceOAuth, registerSources, registerWorkspaceConnections,
} from './authority/index.js';
import { registerCatalog } from './catalog.js';
import { registerSessions } from './sessions.js';
import { registerScheduledPrompts } from './scheduled-prompts.js';
import { registerCrossSession } from './cross-session.js';
import { registerChildSessionSettings } from './child-session-settings.js';
import { registerSessionLinks, registerSharedSessions } from './session-links.js';
import { registerBackups } from './backups.js';
import { registerSessionFiles } from './session-files.js';
import { registerSessionTunnels } from './session-tunnels.js';
import { registerFileUploads } from './file-uploads.js';
import { registerInternal } from './internal.js';
import { fail, localMode, passwordAuthEnabled, signupMode, testMode } from './http.js';
import { registerConnectorCredentials, registerConnectors } from './connectors.js';
import { registerHostConfig } from './host-config.js';
import { registerHostModels } from './host-models.js';
import { registerConnectorExtensions, registerExtensions } from './extensions.js';
import { registerRestoreRoutes } from './restore-routes.js';
import { registerHostMigrations } from './host-migrations.js';
import { registerWorkspaceDatabases } from './workspace-databases/routes.js';
import { registerDataExports } from './data-export.js';
import { registerTranscriptSettings } from './transcript-settings.js';
import { registerNotifications } from './notifications.js';
import { registerWorkspaceInvites } from './workspace-invites.js';
import { compression } from './compression.js';
import { buildVersion, validVersion } from '../../../packages/shared/src/version.js';

export const app = new Hono<WorkerEnv>();

app.use('*', compression);
app.use('*', async (c, next) => {
  c.header('X-Content-Type-Options', 'nosniff');
  c.header('Referrer-Policy', 'no-referrer');
  c.header('X-Frame-Options', 'DENY');
  c.header('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  c.header('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data: https://avatars.githubusercontent.com; connect-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'; form-action 'self'");
  if (new URL(c.req.url).protocol === 'https:') c.header('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  if (c.req.path.startsWith('/api/')) c.header('Cache-Control', 'private, no-store');
  await next();
});
app.onError((error, c) => {
  if (error instanceof HTTPException) {
    const response = error.getResponse();
    return c.newResponse(response.body, response);
  }
  // Never log request bodies, cookies, upstream responses, or exceptions that could contain credentials.
  return c.json({ error: 'The request could not be completed.', code: 'internal_error' }, 500);
});
app.get('/api/health', async c => {
  let vaultReady = false;
  try { await assertVaultConfigured(c.env); vaultReady = true; } catch { /* Readiness only; no configuration values are exposed. */ }
  return c.json({ ok: true,
    // The release it runs, such as 0.24.0; null in development. Shown in the web app's settings.
    version: validVersion(c.env.PIKIBUN_VERSION) ?? buildVersion ?? null,
    githubConfigured: !!c.env.GITHUB_CLIENT_ID && !!c.env.GITHUB_CLIENT_SECRET && vaultReady,
    runnerConfigured: !!c.env.RUNNER_URL && !!c.env.RUNNER_SHARED_SECRET && c.env.RUNNER_SHARED_SECRET.length >= 32,
    databaseConfigured: true, databaseProvider: c.env.DB.provider,
    backupsConfigured: !!c.env.BUCKET, storageProvider: c.env.BUCKET?.provider ?? null,
    workspaceDatabasesConfigured: !!c.env.WORKSPACE_DATABASES,
    connectorsConfigured: !!c.env.CONNECTOR_HUB, testMode: testMode(c.env),
    // The sign-in page offers a username and password next to GitHub.
    passwordAuth: passwordAuthEnabled(c.env),
    // Who may create an account with each method, so the sign-in page offers sign-up only where it works.
    githubSignup: signupMode(c.env, 'github'),
    ...(passwordAuthEnabled(c.env) ? { passwordSignup: signupMode(c.env, 'password') } : {}),
    // A local server says whether someone has claimed it, so the sign-in page can point to the launcher's link.
    ...(localMode(c.env) ? { localServer: { claimed: !!await localOwner(c.env) } } : {}),
  });
});
registerAuth(app);
registerPasswordAuth(app);
registerInternal(app);
registerConnectorCredentials(app);
registerConnectorExtensions(app);
registerOidc(app);
// Share links are their own read-only credential: anyone who has one can view without signing in.
registerSharedSessions(app);
app.use('/api/*', authenticate, csrfGuard);
registerCatalog(app);
registerWorkspaceInvites(app);
registerRepositories(app);
registerSources(app);
registerWorkspaceConnections(app);
registerSourceOAuth(app);
registerPushIdentities(app);
registerGitAccounts(app);
registerConnectors(app);
registerHostAccess(app);
registerHostConfig(app);
registerHostModels(app);
registerExtensions(app);
registerSessions(app);
registerSessionLinks(app);
registerBackups(app);
registerSessionFiles(app);
registerSessionTunnels(app);
registerFileUploads(app);
registerScheduledPrompts(app);
registerCrossSession(app);
registerChildSessionSettings(app);
registerRestoreRoutes(app);
registerHostMigrations(app);
registerWorkspaceDatabases(app);
registerDataExports(app);
registerNetworkPolicies(app);
registerTranscriptSettings(app);
registerRequesterAutoApprove(app);
registerAdmin(app);
registerNotifications(app);
app.all('/api/*', () => fail(404, 'not_found', 'API route not found.'));

export default app;
