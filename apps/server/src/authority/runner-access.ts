import type { Permission, RunnerAction, RunnerTicket } from '../../../../packages/shared/src/types.js';
import { requireNoMigration, requireUnfrozen } from '../db.js';
import { fail } from '../http.js';
import type { AppContext, Env, SessionRow } from '../types.js';
import { sessionAccess } from './access.js';
import { mayRequestAction } from './host-access.js';
import { requireConnectorSession } from './hosts.js';

const actionPermissions: Record<RunnerAction, Permission> = {
  create: 'write', view: 'read', events: 'read', submit: 'write', ask: 'ask',
  backup: 'manage', restart: 'manage', restore: 'write', stop: 'write', files: 'write',
  revert: 'write', fork: 'write', pack: 'manage', unpack: 'manage', withdraw: 'ask', upload: 'write', tunnel: 'write', image: 'write',
};

export const connectorPermissions: Record<RunnerAction, Permission> = {
  create: 'write', view: 'read', events: 'read', submit: 'write', ask: 'ask',
  backup: 'manage', restart: 'manage', restore: 'manage', stop: 'write', files: 'write',
  revert: 'write', fork: 'write', pack: 'manage', unpack: 'manage', withdraw: 'ask', upload: 'write', tunnel: 'write', image: 'write',
};
export const ownerActions: readonly RunnerAction[] = ['create', 'restart', 'restore', 'backup', 'fork', 'pack', 'unpack'];

export function requireArchivedAction(row: SessionRow, action: RunnerAction): void {
  if (action === 'view' || action === 'events') return;
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
  if (!['view', 'events', 'create', 'restart', 'stop', 'files', 'image', 'unpack'].includes(action)) requireUnfrozen(access.row);
  if (ownerActions.includes(action) && actorId !== row.owner_id) fail(403, 'owner_required', 'Only the session owner can perform this operation.');
  if (action !== 'restore' && await c.env.DB.query("SELECT 1 FROM restore_jobs WHERE target_session_id = ? AND status <> 'completed'").bind(row.id).first()) {
    fail(409, 'restore_pending', 'Session restoration is not complete.');
  }
  if (action !== 'view' && action !== 'events') await requireNoMigration(c.env, row.id, action === 'restore');
  return access.row;
}

export async function authorizeConnectorTicket(env: Env, ticket: RunnerTicket, connectionHash?: string): Promise<SessionRow> {
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
