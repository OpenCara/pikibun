import type { Hono } from 'hono';
import {
  artifactRequest, checkArtifact, checkArtifactList, type Artifact, type ArtifactRequest, type ArtifactSummary,
} from '../../../packages/shared/src/artifacts.js';
import { redactSecrets } from '../../../packages/shared/src/redaction.js';
import { hostCapabilities, requireSession } from './authority/index.js';
import { fail, identifier } from './http.js';
import { runnerJSON, runnerRequest } from './runner.js';
import type { AppContext, AppEnv, Env, SessionRow } from './types.js';

export type ArtifactAnswer = { artifacts: ArtifactSummary[] } | { artifact: Artifact & { redacted?: true } };

export function artifactQuery(c: AppContext): ArtifactRequest {
  const name = c.req.query('name');
  const version = c.req.query('version');
  const request = artifactRequest(name === undefined && version === undefined ? {}
    : { name, version: version !== undefined && /^\d{1,4}$/.test(version) ? Number(version) : -1 });
  if (!request) fail(400, 'invalid_artifact', 'Expected an artifact\'s name and version, or neither to list them.');
  return request;
}

export async function requireArtifacts(env: Env, row: SessionRow): Promise<void> {
  if (row.connector_id && (await hostCapabilities(env, row.connector_id))?.artifacts !== true) {
    fail(409, 'artifacts_unsupported', 'This session\'s host can\'t show artifacts yet. Its owner can update the pikibun connector there.');
  }
}

export function artifactAnswer(result: { artifacts?: unknown; artifact?: unknown } | null, request: ArtifactRequest): ArtifactAnswer {
  if (request.name === undefined) {
    const artifacts = checkArtifactList(result?.artifacts);
    if (!artifacts) fail(502, 'invalid_runner_response', 'The runner returned an invalid list of artifacts.');
    return { artifacts: artifacts.map(item => ({ ...item, versions: item.versions.map(version => ({ ...version, title: redactSecrets(version.title) })) })) };
  }
  const artifact = checkArtifact(result?.artifact, request);
  if (!artifact) fail(502, 'invalid_runner_response', 'The runner returned an invalid artifact.');
  const content = redactSecrets(artifact.content);
  return { artifact: { ...artifact, title: redactSecrets(artifact.title), content, ...(content !== artifact.content ? { redacted: true as const } : {}) } };
}

export function registerSessionArtifacts(app: Hono<AppEnv>): void {
  app.get('/api/sessions/:id/artifacts', async c => {
    const { row } = await requireSession(c, identifier(c.req.param('id')), 'read');
    const request = artifactQuery(c);
    await requireArtifacts(c.env, row);
    const result = await runnerJSON<{ artifacts?: unknown; artifact?: unknown }>(await runnerRequest(c, row, 'artifacts', '', request));
    c.header('Cache-Control', 'no-store');
    return c.json(artifactAnswer(result, request));
  });
}
