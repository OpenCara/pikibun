import { parseCapabilities } from '../../../../packages/shared/src/connector.js';
import { PRIVATE_SESSIONS_VERSION, PRIVATE_TICKET_SESSION } from '../../../../packages/shared/src/private-sessions.js';
import { HOST_DIRECTORIES_TICKET_SESSION } from '../../../../packages/shared/src/host-directory.js';
import type { Permission, RunnerAction, RunnerTicket } from '../../../../packages/shared/src/types.js';
import { requireNoMigration, requireUnfrozen } from '../db.js';
import { fail } from '../http.js';
import type { AppContext, Env, SessionRow } from '../types.js';
import { sessionAccess } from './access.js';
import { hostSessionsGrantedAnywhere, mayRequestAction } from './host-access.js';
import { requireConnectorSession } from './hosts.js';

const actionPermissions: Record<RunnerAction, Permission> = {
  create: 'write', view: 'read', events: 'read', submit: 'write', ask: 'ask',
  backup: 'manage', restart: 'manage', restore: 'write', stop: 'write', files: 'write', changes: 'write',
  revert: 'write', fork: 'write', pack: 'manage', unpack: 'manage', withdraw: 'ask', upload: 'write', tunnel: 'write', image: 'write', sudo: 'write',
  attach: 'manage', portable: 'manage', artifacts: 'read', title: 'write', resources: 'read', private: 'manage', directories: 'manage',
};

export const connectorPermissions: Record<RunnerAction, Permission> = {
  create: 'write', view: 'read', events: 'read', submit: 'write', ask: 'ask',
  backup: 'manage', restart: 'manage', restore: 'manage', stop: 'write', files: 'write', changes: 'write',
  revert: 'write', fork: 'write', pack: 'manage', unpack: 'manage', withdraw: 'ask', upload: 'write', tunnel: 'write', image: 'write', sudo: 'write',
  attach: 'manage', portable: 'manage', artifacts: 'read', title: 'write', resources: 'read', private: 'manage', directories: 'manage',
};
export const ownerActions: readonly RunnerAction[] = ['create', 'restart', 'restore', 'backup', 'fork', 'pack', 'unpack', 'sudo', 'attach', 'portable', 'private'];

export function requireArchivedAction(row: SessionRow, action: RunnerAction): void {
  if (action === 'view' || action === 'events' || action === 'artifacts') return;
  if (action === 'pack' || action === 'unpack') {
    if (row.status !== 'archived') fail(409, 'session_not_archived', 'Only an archived session\'s files are packed or unpacked.');
    return;
  }
  if (row.status === 'archived') fail(409, 'session_archived', 'Session is archived.');
  if (row.packed_at) fail(409, 'session_packed', 'This session\'s files are packed. Archive and unarchive it to unpack them.');
}

export async function requireRunnerAccess(c: AppContext, actorId: string, row: SessionRow, action: RunnerAction): Promise<SessionRow> {
  const access = await sessionAccess(c.env, row.id, actorId);
  if (!access || access.row.owner_id !== row.owner_id || !await mayRequestAction(c.env, access, actorId, action, actionPermissions[action])) {
    fail(403, 'permission_revoked', 'Session access is no longer authorized.');
  }
  requireArchivedAction(access.row, action);
  if (!['view', 'events', 'create', 'restart', 'stop', 'files', 'changes', 'image', 'unpack', 'portable', 'artifacts', 'resources'].includes(action)) requireUnfrozen(access.row);
  if (ownerActions.includes(action) && actorId !== row.owner_id) fail(403, 'owner_required', 'Only the session owner can perform this operation.');
  if (action !== 'restore' && await c.env.DB.query("SELECT 1 FROM restore_jobs WHERE target_session_id = ? AND status <> 'completed'").bind(row.id).first()) {
    fail(409, 'restore_pending', 'Session restoration is not complete.');
  }
  if (action !== 'view' && action !== 'events' && action !== 'artifacts' && action !== 'resources') await requireNoMigration(c.env, row.id, action === 'restore');
  return access.row;
}

export async function authorizePrivateTicket(env: Env, ticket: RunnerTicket, connectionHash?: string): Promise<void> {
  if (ticket.action !== 'private' || ticket.sessionId !== PRIVATE_TICKET_SESSION || ticket.actorId !== ticket.ownerId || ticket.policyVersion !== 1 || !ticket.connectorId) {
    fail(403, 'invalid_ticket', 'Invalid connector ticket.');
  }
  const host = await env.DB.query<{ capabilities_json: string | null; connection_hash: string | null }>(`SELECT c.capabilities_json, c.connection_hash
    FROM connectors c JOIN users u ON u.id = c.owner_id WHERE c.id = ? AND c.owner_id = ? AND c.revoked_at IS NULL AND u.suspended_at IS NULL`)
    .bind(ticket.connectorId, ticket.ownerId).first();
  if (!host || (parseCapabilities(host.capabilities_json).privateSessions ?? 0) < PRIVATE_SESSIONS_VERSION
    || (connectionHash !== undefined && host.connection_hash !== connectionHash)) {
    fail(403, 'permission_revoked', 'This computer no longer forwards its private sessions here.');
  }
}

export async function hostDirectoriesAuthority(env: Env, connectorId: string, actorId: string, connectionHash?: string): Promise<{ ownerId: string }> {
  const host = await env.DB.query<{ owner_id: string; capabilities_json: string | null; connection_hash: string | null; host_sessions: number | string | null }>(
    `SELECT c.owner_id, c.capabilities_json, c.connection_hash, cc.host_sessions FROM connectors c JOIN users u ON u.id = c.owner_id
      LEFT JOIN connector_configs cc ON cc.connector_id = c.id
      WHERE c.id = ? AND c.revoked_at IS NULL AND c.removed_at IS NULL AND u.suspended_at IS NULL`).bind(connectorId).first();
  if (!host || (connectionHash !== undefined && host.connection_hash !== connectionHash)) fail(403, 'permission_revoked', 'This host is no longer available.');
  const capabilities = parseCapabilities(host.capabilities_json);
  const granted = host.owner_id !== actorId;
  if (granted && !await hostSessionsGrantedAnywhere(env, connectorId, host.owner_id, actorId)) {
    fail(403, 'host_owner_required', 'Only a host\'s owner, or a member they granted sessions on the host, browses its directories.');
  }
  if (capabilities.hostDirectoryBrowser !== true || capabilities.hostDirectories !== true) {
    fail(409, 'connector_update_required', 'Update the host\'s connector (npx pikibun@latest connect) to browse its directories.');
  }
  if (capabilities.hostConfig !== true || capabilities.unsandboxed === true || (granted && capabilities.hostSessionGrants !== true)) {
    fail(409, 'host_sessions_unavailable', 'This host doesn\'t start sessions that run directly on it, so none works in one of its directories.');
  }
  if ((granted || capabilities.ownerHostSessions !== true) && Number(host.host_sessions ?? 0) !== 1) {
    fail(409, 'host_sessions_off', 'This host doesn\'t accept sessions that run directly on it. Turn that on under Settings → Hosts → the host → Configuration.');
  }
  return { ownerId: host.owner_id };
}

export async function authorizeDirectoriesTicket(env: Env, ticket: RunnerTicket, connectionHash?: string): Promise<void> {
  if (ticket.action !== 'directories' || ticket.sessionId !== HOST_DIRECTORIES_TICKET_SESSION || ticket.policyVersion !== 1 || !ticket.connectorId) {
    fail(403, 'invalid_ticket', 'Invalid connector ticket.');
  }
  const { ownerId } = await hostDirectoriesAuthority(env, ticket.connectorId, ticket.actorId, connectionHash);
  if (ownerId !== ticket.ownerId) fail(403, 'permission_revoked', 'This host is no longer available.');
}

export async function authorizeConnectorTicket(env: Env, ticket: RunnerTicket, connectionHash?: string): Promise<SessionRow | null> {
  if (ticket.action === 'private') { await authorizePrivateTicket(env, ticket, connectionHash); return null; }
  if (ticket.action === 'directories') { await authorizeDirectoriesTicket(env, ticket, connectionHash); return null; }
  const permission = connectorPermissions[ticket.action];
  if (!permission || !Object.hasOwn(connectorPermissions, ticket.action) || !ticket.connectorId) fail(403, 'invalid_ticket', 'Invalid connector ticket.');
  const access = await sessionAccess(env, ticket.sessionId, ticket.actorId);
  if (!access || access.row.owner_id !== ticket.ownerId || access.row.connector_id !== ticket.connectorId ||
      access.row.policy_version !== ticket.policyVersion || !await mayRequestAction(env, access, ticket.actorId, ticket.action, permission)) {
    fail(403, 'permission_revoked', 'Session access is no longer authorized.');
  }
  requireArchivedAction(access.row, ticket.action);
  if (ownerActions.includes(ticket.action) && ticket.actorId !== ticket.ownerId) fail(403, 'owner_required', 'Only the session owner can perform this operation.');
  await requireConnectorSession(env, ticket.connectorId, access.row, connectionHash);
  return access.row;
}
