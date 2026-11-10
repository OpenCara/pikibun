import type { AuthorizationResult, Permission } from '../../../../packages/shared/src/types.js';
import { permissions } from '../../../../packages/shared/src/types.js';
import { hasPermission, memberAutoApproveRoles } from '../../../../packages/shared/src/policy.js';
import type { AppContext } from '../types.js';
import { fail, identifier, jsonObject, userIdentifier } from '../http.js';
import { sessionAccess } from './access.js';
import { requireCallbackScope } from './hosts.js';
import { hostAuthority } from './host-access.js';
import { autoApprovesRequester } from './requester-auto-approve.js';

/**
 * The question a session's host asks before it does anything for someone (`/api/connectors/self/authorize`, and
 * `/api/internal/authorize` from the control plane's own runner): may this actor still do this to the session, at
 * which policy version, with which host authority, does the session's owner auto-approve them, and may their own
 * Auto-approve messages run their sandboxed commands without asking. Hosts ask it for
 * every request and every second of a stream (apps/runner/src/session.ts, `authorize`).
 */
export async function authorizeSession(c: AppContext, connectorId: string | null): Promise<Response> {
    const input = await jsonObject(c, 4096);
    const sessionId = identifier(input.sessionId, 'sessionId');
    const actorId = userIdentifier(input.actorId, 'actorId');
    const ownerId = userIdentifier(input.ownerId, 'ownerId');
    if (!permissions.includes(input.permission as Permission)) fail(400, 'invalid_permission', 'Invalid permission.');
    const access = await sessionAccess(c.env, sessionId, actorId);
    if (access) await requireCallbackScope(c, access.row, connectorId);
    if (input.host !== undefined && input.host !== true) fail(400, 'invalid_authorization', 'Invalid authorization request.');
    if (input.hostSessions !== undefined && (input.hostSessions !== true || input.host !== true)) fail(400, 'invalid_authorization', 'Invalid authorization request.');
    if (input.archived !== undefined && (input.archived !== true || input.host !== undefined || input.permission !== 'manage')) fail(400, 'invalid_authorization', 'Invalid authorization request.');
    if (input.autoApprove !== undefined && input.autoApprove !== true) fail(400, 'invalid_authorization', 'Invalid authorization request.');
    if (input.memberAutoApprove !== undefined && input.memberAutoApprove !== true) fail(400, 'invalid_authorization', 'Invalid authorization request.');
    // An archived session still shows its conversation, so its host is admitted plain reads (its view and events), never
    // with host authority or auto-approval; besides those, only packing and unpacking its files, which ask as `archived` and
    // are admitted only while it is archived (see requireArchivedAction). Nothing else of it runs.
    const archived = access?.row.status === 'archived';
    const admitted = input.archived === true ? archived : !archived || (input.permission === 'read' && input.host === undefined && input.autoApprove === undefined
      && input.memberAutoApprove === undefined);
    const allowed = !!access && access.row.owner_id === ownerId && admitted && hasPermission(access.permissions, input.permission as Permission);
    const result: AuthorizationResult = { allowed, policyVersion: access?.row.policy_version ?? 0, ownerId: access?.row.owner_id ?? '' };
    // The host's owner holds every level; to the runner, that is `auto`.
    const host = allowed && input.host === true ? await hostAuthority(c.env, access!.row, actorId) : undefined;
    if (host) result.hostCommands = host.level === 'owner' ? 'auto' : host.level;
    // Only to a connector that asks: older ones parse the reply strictly and know no such field.
    if (host?.sessions && input.hostSessions === true) result.hostSessions = true;
    // Likewise only to a connector that asks: whether the session's owner auto-approves this member's requests.
    if (allowed && input.autoApprove === true && await autoApprovesRequester(c.env, access!.row, actorId)) result.autoApprove = true;
    // Likewise only to a connector that asks: whether this member's own Auto-approve messages run their sandboxed
    // commands without asking. The owner's run everything Auto-approve covers, which the host knows without asking.
    if (allowed && input.memberAutoApprove === true && actorId !== access!.row.owner_id && hasPermission(access!.permissions, 'write')
      && memberAutoApproveRoles.includes(access!.role)) result.memberAutoApprove = true;
    return c.json(result);
}
