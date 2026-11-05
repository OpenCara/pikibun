import type { Hono, MiddlewareHandler } from 'hono';
import { constantTimeEqual } from '../../../packages/shared/src/crypto.js';
import type { WorkerEnv } from './types.js';
import { fail } from './http.js';
import {
  apiCredential, authorizeSession, egressGrant, gitDirect, githubComment, githubIssue, githubMerge, githubRead, gitRelay, pushComplete,
  pushCredential, sourceRead,
} from './authority/index.js';
import { agentSchedules } from './scheduled-prompts.js';
import { agentSessions } from './cross-session.js';
import { legacyRestoreDownload } from './restore-routes.js';
import { webSearchRetired } from './connectors.js';

const internalAuthentication: MiddlewareHandler<WorkerEnv> = async (c, next) => {
  const configured = c.env.RUNNER_SHARED_SECRET;
  const authorization = c.req.header('authorization');
  if (!configured || configured.length < 32) fail(503, 'internal_unavailable', 'Internal authorization is not configured.');
  if (!authorization?.startsWith('Bearer ') || authorization.length > 512 || !constantTimeEqual(authorization.slice(7), configured)) {
    fail(401, 'unauthorized', 'Internal authentication is required.');
  }
  await next();
};

export function registerInternal(app: Hono<WorkerEnv>): void {
  app.use('/api/internal/*', internalAuthentication);
  app.post('/api/internal/authorize', c => authorizeSession(c, null));
  app.post('/api/internal/github/comment', c => githubComment(c, null));
  app.post('/api/internal/github/read', c => githubRead(c, null));
  app.post('/api/internal/github/merge', c => githubMerge(c, null));
  app.post('/api/internal/github/issue', c => githubIssue(c, null));
  app.post('/api/internal/sources/read', c => sourceRead(c, null));
  app.post('/api/internal/schedules', c => agentSchedules(c, null));
  app.post('/api/internal/sessions', c => agentSessions(c, null));
  app.post('/api/internal/web/search', () => webSearchRetired());
  app.post('/api/internal/git/push/credential', c => pushCredential(c, null));
  app.post('/api/internal/git/push/complete', c => pushComplete(c, null));
  app.post('/api/internal/restores/:restoreId/download', legacyRestoreDownload);
  app.post('/api/internal/network', c => egressGrant(c, null));
  app.post('/api/internal/git/relay/:bindingId/:service', c => gitRelay(c, null));
  app.post('/api/internal/git/direct', c => gitDirect(c, null));
  app.post('/api/internal/api/credential', c => apiCredential(c, null));
}
