import type { Hono } from 'hono';
import { gitProviderHasForge, gitProviderNames, plainRepositoryPath, repositoryLimits, type GitProvider, type ProviderRepositoryList, type TokenGitProvider } from '../../../../packages/shared/src/repositories.js';
import { documentKindNames, type DocumentItemType, type DocumentKind } from '../../../../packages/shared/src/sources.js';
import {
  sourceReadAsValues, workspaceDocumentProviders, workspaceGitProviders, workspaceConnectionLimit,
  type SourceReadAs, type WorkspaceConnection, type WorkspaceConnectionFamily, type WorkspaceConnectionList,
} from '../../../../packages/shared/src/workspace-connections.js';
import type { Env, RepositoryRow, WorkerEnv } from '../types.js';
import { auditStatement } from './audit.js';
import { requireMember } from './access.js';
import { fail, id, identifier, jsonObject, now } from '../http.js';
import { decryptToken, encryptToken } from './vault.js';
import { accountInput, credentialOrganization, providerRepository } from './git/accounts.js';
import { gitProviderAdapters, plainRepositoryId } from './git/providers.js';
import type { GitCredential } from './git/types.js';
import { recheckAccess, verifyRepository, type RepositoryAccess } from './repositories.js';
import { documentAdapters } from './sources/sources.js';

/**
 * Workspace connections (docs/design/workspace-connections.md): service credentials an owner or admin connects for a
 * workspace itself. A source reads with one only where an owner or admin chose that for it (source_read_settings), and
 * only for reads: the Git relay and LFS, and source_read. Pushes, pull requests and the GitHub API keep the session
 * owner's own account or the workspace's push access. The secret never leaves the control plane, not even to the session
 * owner's own host, and members see only which account it is.
 */

interface ConnectionRow {
  id: string; workspace_id: string; family: WorkspaceConnectionFamily; provider: string; host: string; organization: string;
  username: string | null; name: string; ciphertext: string; created_by: string; created_at: string; updated_at: string;
}

/** The vault's associated data for a connection: its secret decrypts only as that connection. */
const aad = (connectionId: string) => `workspace-connection:${connectionId}`;
const adminSql = `EXISTS (SELECT 1 FROM workspace_members WHERE workspace_id = ? AND user_id = ? AND role IN ('owner','admin'))`;

function connectionLabel(family: WorkspaceConnectionFamily, provider: string, host: string): string {
  return family === 'git' ? `${gitProviderNames[provider as GitProvider]} (${host})` : documentKindNames[provider as DocumentKind];
}

/** Which identity a source reads with; no setting means each session owner's own account. */
export async function sourceReadAs(env: Env, workspaceId: string, sourceId: string): Promise<SourceReadAs> {
  const row = await env.DB.query<{ read_as: string }>('SELECT read_as FROM source_read_settings WHERE source_id = ? AND workspace_id = ?')
    .bind(sourceId, workspaceId).first();
  return row?.read_as === 'workspace' ? 'workspace' : 'members';
}

/** The workspace's connection for a repository's provider, host and Azure DevOps organization, as repository access. */
export async function workspaceGitAccess(env: Env, workspaceId: string, provider: GitProvider, host: string, fullName: string): Promise<RepositoryAccess> {
  if (provider === 'github') fail(409, 'workspace_connection_unsupported', 'github.com repositories read with each member\'s GitHub sign-in.');
  const organization = credentialOrganization(provider, fullName);
  const row = await env.DB.query<ConnectionRow>(`SELECT * FROM workspace_connections
    WHERE workspace_id = ? AND family = 'git' AND provider = ? AND host = ? AND organization = ?`).bind(workspaceId, provider, host, organization).first();
  if (!row) {
    fail(409, 'workspace_connection_required', `This workspace reads ${fullName} with its own ${connectionLabel('git', provider, host)} connection, which isn't connected. `
      + 'A workspace owner or admin can connect it under the workspace\'s Connections, or read the repository with members\' own accounts.');
  }
  const credential: GitCredential = { id: row.id, provider: provider as TokenGitProvider, host: row.host, organization: row.organization,
    username: row.username, token: await decryptToken(env, aad(row.id), row.ciphertext) };
  return { provider: provider as TokenGitProvider, account: { credential, ciphertext: row.ciphertext, userId: '', workspaceId } };
}

/** True for access through a workspace connection: it never leaves the control plane. */
export function workspaceAccess(access: RepositoryAccess): boolean {
  return access.provider !== 'github' && access.account.workspaceId !== undefined;
}

export interface WorkspaceDocumentAccount { secret: string; ciphertext: string; connectionId: string; workspaceId: string }

/** The workspace's connection for a kind of document source. */
export async function workspaceDocumentAccount(env: Env, workspaceId: string, kind: DocumentKind): Promise<WorkspaceDocumentAccount> {
  const row = await env.DB.query<ConnectionRow>(`SELECT * FROM workspace_connections WHERE workspace_id = ? AND family = 'document' AND provider = ?`)
    .bind(workspaceId, kind).first();
  if (!row) {
    fail(409, 'workspace_connection_required', `This workspace reads its ${documentKindNames[kind]} sources with its own ${documentKindNames[kind]} connection, which isn't connected. `
      + 'A workspace owner or admin can connect it under the workspace\'s Connections, or read the source with members\' own accounts.');
  }
  return { secret: await decryptToken(env, aad(row.id), row.ciphertext), ciphertext: row.ciphertext, connectionId: row.id, workspaceId };
}

/** The connection that was used must still be the workspace's before its result leaves the control plane. */
export async function recheckWorkspaceDocument(env: Env, account: WorkspaceDocumentAccount): Promise<void> {
  const current = await env.DB.query<{ ciphertext: string }>('SELECT ciphertext FROM workspace_connections WHERE id = ? AND workspace_id = ?')
    .bind(account.connectionId, account.workspaceId).first('ciphertext');
  if (current !== account.ciphertext) fail(403, 'workspace_connection_changed', 'The workspace connection changed; retry with the current one.');
}

interface ReadSettingRow { source_id: string; kind: string; provider: string | null; host: string | null; full_name: string | null }

/** The sources reading as the workspace, with what each needs: a connection's family, provider, host and organization. */
async function workspaceReads(env: Env, workspaceId: string): Promise<{ sourceId: string; family: WorkspaceConnectionFamily; provider: string; host: string; organization: string }[]> {
  const rows = await env.DB.query<ReadSettingRow>(`SELECT s.source_id, w.kind, r.provider, r.host, r.full_name FROM source_read_settings s
    JOIN workspace_sources w ON w.id = s.source_id AND w.workspace_id = s.workspace_id
    LEFT JOIN workspace_repositories r ON r.id = w.repository_binding_id
    WHERE s.workspace_id = ? AND s.read_as = 'workspace'`).bind(workspaceId).all();
  return rows.map(row => row.kind === 'git' && row.provider && row.host !== null && row.full_name !== null
    ? { sourceId: row.source_id, family: 'git' as const, provider: row.provider, host: row.host,
      organization: credentialOrganization(row.provider as GitProvider, row.full_name) }
    : { sourceId: row.source_id, family: 'document' as const, provider: row.kind, host: '', organization: '' });
}
const uses = (connection: Pick<ConnectionRow, 'family' | 'provider' | 'host' | 'organization'>) =>
  (read: { family: string; provider: string; host: string; organization: string }) =>
    read.family === connection.family && read.provider === connection.provider && read.host === connection.host && read.organization === connection.organization;

function publicConnection(row: ConnectionRow, sources: number): WorkspaceConnection {
  return { id: row.id, workspaceId: row.workspace_id, family: row.family, provider: row.provider as WorkspaceConnection['provider'], host: row.host,
    organization: row.organization, name: row.name, createdBy: row.created_by, createdAt: row.created_at, updatedAt: row.updated_at, sources };
}

async function connectionRow(env: Env, workspaceId: string, connectionId: string): Promise<ConnectionRow> {
  return await env.DB.query<ConnectionRow>('SELECT * FROM workspace_connections WHERE id = ? AND workspace_id = ?').bind(connectionId, workspaceId).first()
    ?? fail(404, 'not_found', 'Workspace connection not found.');
}

/** What a new connection is, verified with its provider: the Git or document credential, and the account it names. */
async function connectionInput(input: Record<string, unknown>): Promise<{ family: WorkspaceConnectionFamily; provider: string; host: string; organization: string;
  username: string | null; secret: string; name: string }> {
  const { family, ...rest } = input;
  if (family === 'git') {
    // The same validation as a member's own Git account, so a workspace can't connect what a profile couldn't.
    const account = accountInput(rest);
    if (!workspaceGitProviders.includes(account.provider)) fail(400, 'invalid_git_provider', 'Choose a supported Git provider.');
    const { login } = await gitProviderAdapters[account.provider].verify({ id: 'verify', ...account });
    if (typeof login !== 'string' || !login || login.length > 200 || /[\x00-\x1f\x7f]/.test(login)) {
      fail(502, 'invalid_git_response', `${gitProviderNames[account.provider]} returned an invalid account name.`);
    }
    return { family, provider: account.provider, host: account.host, organization: account.organization, username: account.username, secret: account.token, name: login };
  }
  if (family === 'document') {
    const { provider, ...secretInput } = rest;
    if (!workspaceDocumentProviders.includes(provider as DocumentKind)) {
      fail(400, 'invalid_workspace_connection', `A workspace connects ${workspaceDocumentProviders.map(kind => documentKindNames[kind]).join(', ')} with a pasted secret; other document providers read with members' own sign-ins.`);
    }
    const kind = provider as DocumentKind;
    const { secret, name } = await documentAdapters[kind].connect(secretInput);
    return { family, provider: kind, host: '', organization: '', username: null, secret, name: (name || documentKindNames[kind]).slice(0, 200) };
  }
  return fail(400, 'invalid_workspace_connection', 'Choose a Git or document connection.');
}

export function registerWorkspaceConnections(app: Hono<WorkerEnv>): void {
  // Every member sees which accounts the workspace reads with, never their secrets.
  app.get('/api/workspaces/:id/connections', async c => {
    const workspaceId = identifier(c.req.param('id'));
    await requireMember(c.env, workspaceId, c.get('auth').userId);
    const rows = await c.env.DB.query<ConnectionRow>('SELECT * FROM workspace_connections WHERE workspace_id = ? ORDER BY family, provider, host, organization')
      .bind(workspaceId).all();
    const reads = await workspaceReads(c.env, workspaceId);
    return c.json({ connections: rows.map(row => publicConnection(row, reads.filter(uses(row)).length)) } satisfies WorkspaceConnectionList);
  });

  app.post('/api/workspaces/:id/connections', async c => {
    const workspaceId = identifier(c.req.param('id')); const actor = c.get('auth').userId;
    await requireMember(c.env, workspaceId, actor, ['owner', 'admin']);
    const input = await connectionInput(await jsonObject(c, 32768));
    // Reconnecting the same provider (and host and organization) replaces the secret and keeps the connection's id, which
    // its ciphertext is bound to.
    const existing = await c.env.DB.query<{ id: string }>(`SELECT id FROM workspace_connections WHERE workspace_id = ? AND family = ? AND provider = ? AND host = ? AND organization = ?`)
      .bind(workspaceId, input.family, input.provider, input.host, input.organization).first();
    const connectionId = existing?.id ?? id();
    const ciphertext = await encryptToken(c.env, aad(connectionId), input.secret);
    const timestamp = now();
    let row: ConnectionRow | null;
    try {
      row = await c.env.DB.query<ConnectionRow>(`INSERT INTO workspace_connections
        (id, workspace_id, family, provider, host, organization, username, name, ciphertext, created_by, created_at, updated_at)
        SELECT ?,?,?,?,?,?,?,?,?,?,?,? WHERE ${adminSql}
        ON CONFLICT (workspace_id, family, provider, host, organization) DO UPDATE SET username = excluded.username, name = excluded.name,
          ciphertext = excluded.ciphertext, updated_at = excluded.updated_at WHERE workspace_connections.id = excluded.id
        RETURNING *`)
        .bind(connectionId, workspaceId, input.family, input.provider, input.host, input.organization, input.username, input.name, ciphertext, actor,
          timestamp, timestamp, workspaceId, actor).first();
    } catch (error) {
      if (/workspace connection limit/.test(String(error instanceof Error ? error.message : error))) {
        fail(409, 'workspace_connection_limit', `A workspace has at most ${workspaceConnectionLimit} connections; remove one first.`);
      }
      throw error;
    }
    if (!row) {
      await requireMember(c.env, workspaceId, actor, ['owner', 'admin']);
      fail(409, 'workspace_connection_changed', 'The connection changed while it was saved; try again.');
    }
    await auditStatement(c.env, actor, 'workspace.connection.connected', workspaceId, null,
      { connectionId: row.id, family: row.family, provider: row.provider, host: row.host, organization: row.organization, name: row.name, replaced: Boolean(existing) }).run();
    const reads = await workspaceReads(c.env, workspaceId);
    return c.json({ connection: publicConnection(row, reads.filter(uses(row)).length) }, existing ? 200 : 201);
  });

  app.delete('/api/workspaces/:id/connections/:connectionId', async c => {
    const workspaceId = identifier(c.req.param('id')); const actor = c.get('auth').userId;
    await requireMember(c.env, workspaceId, actor, ['owner', 'admin']);
    const row = await connectionRow(c.env, workspaceId, identifier(c.req.param('connectionId'), 'connectionId'));
    // No silent change of identity: sources reading with it are switched to members' accounts first, on purpose.
    const using = (await workspaceReads(c.env, workspaceId)).filter(uses(row)).length;
    if (using) fail(409, 'workspace_connection_in_use', `${using} source${using === 1 ? ' reads' : 's read'} with this connection. Switch ${using === 1 ? 'it' : 'them'} to members' own accounts first.`);
    await c.env.DB.batch([
      c.env.DB.query(`DELETE FROM workspace_connections WHERE id = ? AND workspace_id = ? AND ${adminSql}`).bind(row.id, workspaceId, workspaceId, actor),
      auditStatement(c.env, actor, 'workspace.connection.removed', workspaceId, null, { connectionId: row.id, family: row.family, provider: row.provider, host: row.host }),
    ]);
    return c.body(null, 204);
  });

  // The repository picker for a Git connection: its repositories, or for a Git server one looked up by path.
  app.get('/api/workspaces/:id/connections/:connectionId/repositories', async c => {
    const workspaceId = identifier(c.req.param('id')); const actor = c.get('auth').userId;
    await requireMember(c.env, workspaceId, actor, ['owner', 'admin']);
    const row = await connectionRow(c.env, workspaceId, identifier(c.req.param('connectionId'), 'connectionId'));
    if (row.family !== 'git') fail(400, 'invalid_workspace_connection', 'Only Git connections list repositories.');
    const provider = row.provider as TokenGitProvider;
    const path = c.req.query('path');
    let repositories;
    if (!gitProviderHasForge(provider)) {
      if (path === undefined) return c.json({ repositories: [], truncated: false } satisfies ProviderRepositoryList);
      const fullName = plainRepositoryPath(row.host, path) ?? fail(400, 'invalid_repository', `Enter the repository's clone URL on ${row.host}, or its path there.`);
      const access = await workspaceGitAccess(c.env, workspaceId, provider, row.host, fullName);
      if (access.provider === 'github') return fail(400, 'invalid_workspace_connection', 'Not a token connection.');
      repositories = [providerRepository(provider, await gitProviderAdapters.git.repository(access.account.credential, { id: await plainRepositoryId(fullName), fullName }))];
      await recheckAccess(c.env, access);
      return c.json({ repositories, truncated: false } satisfies ProviderRepositoryList);
    }
    if (path !== undefined) fail(400, 'invalid_repository', 'Only Git server connections look repositories up by path.');
    const credential: GitCredential = { id: row.id, provider, host: row.host, organization: row.organization, username: row.username,
      token: await decryptToken(c.env, aad(row.id), row.ciphertext) };
    const result = await gitProviderAdapters[provider].list(credential);
    if (!Array.isArray(result?.repositories) || result.repositories.length > repositoryLimits.pickerRepositories) {
      fail(502, 'invalid_git_response', `${gitProviderNames[provider]} returned invalid repository metadata.`);
    }
    repositories = result.repositories.map(item => providerRepository(provider, item));
    await recheckAccess(c.env, { provider, account: { credential, ciphertext: row.ciphertext, userId: '', workspaceId } });
    return c.json({ repositories, truncated: result.truncated === true } satisfies ProviderRepositoryList);
  });

  /**
   * Which identity a source reads with. Switching to the workspace's connection reads the source with it first, so a
   * connection that can't is refused rather than left for sessions to find out; switching back needs no check.
   */
  app.put('/api/workspaces/:id/sources/:sourceId/read-as', async c => {
    const workspaceId = identifier(c.req.param('id')); const actor = c.get('auth').userId;
    const sourceId = identifier(c.req.param('sourceId'), 'sourceId');
    await requireMember(c.env, workspaceId, actor, ['owner', 'admin']);
    const input = await jsonObject(c, 1024);
    if (Object.keys(input).some(key => key !== 'readAs') || !sourceReadAsValues.includes(input.readAs as SourceReadAs)) {
      fail(400, 'invalid_read_as', 'Set readAs to members or workspace.');
    }
    const readAs = input.readAs as SourceReadAs;
    const source = await c.env.DB.query<{ kind: string }>('SELECT kind FROM workspace_sources WHERE id = ? AND workspace_id = ?').bind(sourceId, workspaceId).first()
      ?? fail(404, 'not_found', 'Source not found.');
    if (readAs === 'workspace') await verifySourceAsWorkspace(c.env, workspaceId, sourceId, source.kind);
    const saved = await c.env.DB.query(`INSERT INTO source_read_settings (source_id, workspace_id, read_as, updated_by, updated_at)
      SELECT ?,?,?,?,? WHERE EXISTS (SELECT 1 FROM workspace_sources WHERE id = ? AND workspace_id = ?) AND ${adminSql}
      ON CONFLICT (source_id) DO UPDATE SET read_as = excluded.read_as, updated_by = excluded.updated_by, updated_at = excluded.updated_at
        WHERE source_read_settings.workspace_id = excluded.workspace_id
      RETURNING source_id`).bind(sourceId, workspaceId, readAs, actor, now(), sourceId, workspaceId, workspaceId, actor).first();
    if (!saved) fail(404, 'not_found', 'Source not found.');
    await auditStatement(c.env, actor, 'workspace.source.read_as', workspaceId, null, { source: sourceId, kind: source.kind, readAs }).run();
    return c.json({ readAs });
  });
}

/** Reads a source with the workspace's connection: the repository's metadata, or the document item itself. */
export async function verifySourceAsWorkspace(env: Env, workspaceId: string, sourceId: string, kind: string): Promise<void> {
  if (kind === 'git') {
    const binding = await env.DB.query<RepositoryRow>('SELECT * FROM workspace_repositories WHERE id = ? AND workspace_id = ?').bind(sourceId, workspaceId).first()
      ?? fail(404, 'not_found', 'Repository not found.');
    const access = await workspaceGitAccess(env, workspaceId, binding.provider, binding.host, binding.full_name);
    await verifyRepository(access, { repositoryId: binding.repository_id, fullName: binding.full_name });
    await recheckAccess(env, access);
    return;
  }
  const item = await env.DB.query<{ kind: DocumentKind; item_id: string; item_type: DocumentItemType; title: string; url: string }>(
    'SELECT kind, item_id, item_type, title, url FROM document_sources WHERE source_id = ? AND workspace_id = ?').bind(sourceId, workspaceId).first()
    ?? fail(404, 'not_found', 'Source not found.');
  if (!workspaceDocumentProviders.includes(item.kind)) {
    fail(409, 'workspace_connection_unsupported', `${documentKindNames[item.kind]} sources read with members' own sign-ins.`);
  }
  const account = await workspaceDocumentAccount(env, workspaceId, item.kind);
  await documentAdapters[item.kind].read(account.secret, { id: item.item_id, type: item.item_type, title: item.title, url: item.url }, null);
  await recheckWorkspaceDocument(env, account);
}
