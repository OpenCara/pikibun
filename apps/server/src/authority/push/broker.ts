import { HTTPException } from 'hono/http-exception';
import type { GitProvider, SessionRepository } from '../../../../../packages/shared/src/repositories.js';
import { gitProviderNames, repositoryPath } from '../../../../../packages/shared/src/repositories.js';
import type { GitPushOperation, HostPushCredential, PushCompletionResult, PushCredential, PushOutcome } from '../../../../../packages/shared/src/types.js';
import { hasPermission } from '../../../../../packages/shared/src/policy.js';
import type { AppContext, Env, PushCredentialRow, SessionAccess, SessionRow } from '../../types.js';
import { auditStatement } from '../audit.js';
import { requireNoMigration, requireUnfrozen } from '../../db.js';
import { sessionAccess } from '../access.js';
import { fail, id, identifier, jsonObject, now, text, userIdentifier } from '../../http.js';
import { parseOperation } from '../operations.js';
import { decryptToken, encryptToken } from '../vault.js';
import { requireCallbackScope } from '../hosts.js';
import { requireOperationTool } from '../tool-checks.js';
import { cloneSessionRepository, recheckAccess, repositoryAccess } from '../repositories.js';
import { mintPushToken, revokePushToken, type MintedToken, type PushRevocation } from './mint.js';
import { branchTip, openPullRequest, pushTarget } from './targets.js';

const outcomes: readonly PushOutcome[] = ['pushed', 'up-to-date', 'failed', 'unknown'];
const automaticPushesPerAdmission = 20;

export async function requireNoRestore(c: AppContext, sessionId: string): Promise<void> {
  if (await c.env.DB.query("SELECT 1 FROM restore_jobs WHERE target_session_id = ? AND status <> 'completed'").bind(sessionId).first()) {
    fail(409, 'restore_pending', 'Session restoration is not complete.');
  }
  await requireNoMigration(c.env, sessionId);
}

async function pushPin(env: Env, row: SessionRow, operation: GitPushOperation): Promise<SessionRepository> {
  const path = operation.repository;
  if (row.repository_mode !== 'clone' || operation.directory === undefined) fail(400, 'invalid_operation', 'A session pushes a clone\'s directory.');
  const repository = await cloneSessionRepository(env, row, binding => repositoryPath({ provider: binding.provider, host: binding.host, fullName: binding.full_name }) === path);
  if (!repository) fail(403, 'repository_binding_mismatch', 'The push does not name a repository of this workspace.');
  return repository;
}
function pinProvider(pin: SessionRepository): { provider: GitProvider; host: string } {
  return 'provider' in pin ? { provider: pin.provider, host: pin.host } : { provider: 'github', host: 'github.com' };
}
export async function requireBinding(c: AppContext, workspaceId: string, pin: SessionRepository): Promise<{ forbid_default_branch: number | null }> {
  const { provider, host } = pinProvider(pin);
  const binding = await c.env.DB.query<{ forbid_default_branch: number | null }>(`SELECT policy.forbid_default_branch FROM workspace_repositories binding
    LEFT JOIN repository_push_policies policy ON policy.binding_id = binding.id AND policy.workspace_id = binding.workspace_id
    WHERE binding.id = ? AND binding.workspace_id = ? AND binding.provider = ? AND binding.host = ? AND binding.repository_id = ?`)
    .bind(pin.bindingId, workspaceId, provider, host, String(pin.repositoryId)).first();
  if (!binding) fail(403, 'repository_binding_removed', 'This repository is no longer configured for the workspace.');
  return binding;
}
async function revokeStored(env: Env, credentialId: string, ciphertext: string | null): Promise<void> {
  if (!ciphertext) return;
  let settled = true;
  try {
    settled = await revokePushToken(env, JSON.parse(await decryptToken(env, `push-credential:${credentialId}`, ciphertext)) as PushRevocation);
  } catch { }
  if (settled) await env.DB.query('UPDATE push_credentials SET revocation_ciphertext = NULL WHERE id = ? AND revocation_ciphertext = ?').bind(credentialId, ciphertext).run();
}

export async function settlePushCredentials(env: Env): Promise<void> {
  const rows = await env.DB.query<{ id: string; revocation_ciphertext: string; completed_at: string | null; session_id: string; approval_id: string;
    requested_by: string; workspace_id: string }>(`SELECT c.id, c.revocation_ciphertext, c.completed_at, c.session_id, c.approval_id, c.requested_by, s.workspace_id
    FROM push_credentials c JOIN sessions s ON s.id = c.session_id
    WHERE c.revocation_ciphertext IS NOT NULL AND (c.completed_at IS NOT NULL OR c.expires_at <= ?) ORDER BY c.created_at LIMIT 100`)
    .bind(Math.floor(Date.now() / 1000)).all();
  for (const row of rows) {
    if (!row.completed_at) {
      const closed = await env.DB.query(`UPDATE push_credentials SET completed_at = ?, outcome = 'unknown' WHERE id = ? AND completed_at IS NULL RETURNING id`)
        .bind(now(), row.id).first();
      if (!closed) continue;
      await auditStatement(env, row.requested_by, 'git.push.completed', row.workspace_id, row.session_id, {
        approvalId: row.approval_id, credentialId: row.id, outcome: 'unknown',
      }).run();
    }
    await revokeStored(env, row.id, row.revocation_ciphertext);
  }
}

export async function pushCredential(c: AppContext, connectorId: string | null): Promise<Response> {
  const input = await jsonObject(c, 131072);
  if (Object.keys(input).some(key => !['sessionId', 'approvalId', 'actorId', 'operation', 'capability', 'admissionId'].includes(key))) {
    fail(400, 'invalid_push_request', 'Unexpected push credential field.');
  }
  const sessionId = identifier(input.sessionId, 'sessionId');
  const approvalId = identifier(input.approvalId, 'approvalId');
  const actorId = userIdentifier(input.actorId, 'actorId');
  const operation = parseOperation(input.operation);
  if (operation.kind !== 'git.push') fail(400, 'invalid_operation', 'Only Git pushes are supported.');
  if (input.capability !== undefined) fail(410, 'approvals_removed', 'Approvals were removed: pushes run for the message that asks for them. Update the host\'s connector (npx pikibun@latest connect).');
  const automatic = true;
  const admissionId = text(input.admissionId, 'admissionId', 128);
  if (!approvalId.startsWith('tool-')) fail(400, 'invalid_push_request', 'Pushes must name a tool call.');
  const requestedBy = actorId;
  const credentialId = id();

  const authorize = async (): Promise<SessionAccess> => {
    const owner = await sessionAccess(c.env, sessionId, actorId);
    if (!owner || owner.row.status === 'archived' || !hasPermission(owner.permissions, 'write')) {
      fail(403, 'permission_revoked', 'Pushes need someone who may still write to the session.');
    }
    const admission = await c.env.DB.query<{ session_id: string; actor_id: string; mode: string; access: string | null; expires_at: number }>('SELECT session_id, actor_id, mode, access, expires_at FROM run_admissions WHERE id = ?')
      .bind(admissionId).first();
    if (!admission || admission.session_id !== sessionId || admission.actor_id !== actorId || admission.mode !== 'write' || admission.access === 'read' ||
        admission.expires_at <= Math.floor(Date.now() / 1000)) {
      fail(403, 'automatic_push_not_admitted', 'Pushes run only for an unexpired message that may act, from the person who sent it.');
    }
    await requireCallbackScope(c, owner.row, connectorId);
    await requireOperationTool(c.env, owner.row, operation);
    const used = await c.env.DB.query<{ count: number }>('SELECT COUNT(*) AS count FROM push_credentials WHERE admission_id = ? AND id <> ?')
      .bind(admissionId, credentialId).first();
    if ((used?.count ?? 0) >= automaticPushesPerAdmission) fail(429, 'automatic_push_limit', 'This message already used its automatic pushes.');
    return owner;
  };

  const authority = await authorize();
  const row = authority.row;
  requireUnfrozen(row);
  await requireNoRestore(c, sessionId);
  const pin = await pushPin(c.env, row, operation);
  const policy = await requireBinding(c, row.workspace_id, pin);
  const { provider, host } = pinProvider(pin);
  const access = await repositoryAccess(c.env, row.owner_id, provider, host, pin.fullName);
  const target = await pushTarget(access, pin, operation.branch, operation.tag);
  if (!target.canPush) fail(403, 'push_permission_required', 'The session owner cannot push to this repository.');
  if (operation.tag === undefined && policy.forbid_default_branch === 1 && operation.branch === target.defaultBranch) {
    fail(403, 'default_branch_push_forbidden', 'This workspace forbids pushes to the repository default branch.');
  }
  if (operation.tag !== undefined && operation.pullRequest) fail(400, 'invalid_pull_request', 'A tag push opens no pull request.');
  if (operation.pullRequest && provider === 'git') fail(422, 'pull_request_unsupported', `A ${gitProviderNames.git} has no pull requests; push the branch without one.`);
  if (operation.pullRequest && (operation.pullRequest.base ?? target.defaultBranch) === operation.branch) {
    fail(400, 'invalid_pull_request', 'The pull request base must differ from the pushed branch.');
  }
  await recheckAccess(c.env, access);
  const fresh = await authorize();
  if (fresh.row.policy_version !== row.policy_version || fresh.row.repositories_json !== row.repositories_json) {
    fail(403, 'permission_revoked', 'Session authority changed.');
  }
  await requireNoRestore(c, sessionId);
  await requireBinding(c, row.workspace_id, pin);
  const inserted = await c.env.DB.query(`INSERT INTO push_credentials (id, session_id, approval_id, requested_by, identity_id, kind, binding_id,
      operation_json, automatic, admission_id, revocation_ciphertext, expires_at, created_at)
    SELECT ?, ?, ?, ?, NULL, 'pending', ?, ?, ?, ?, NULL, ?, ?
    WHERE ? IS NULL OR (SELECT COUNT(*) FROM push_credentials WHERE admission_id = ?) < ?
    ON CONFLICT (session_id, approval_id) DO NOTHING RETURNING id`)
    .bind(credentialId, sessionId, approvalId, requestedBy, pin.bindingId, JSON.stringify(operation), automatic ? 1 : 0, admissionId,
      Math.floor(Date.now() / 1000), now(), admissionId, admissionId, automaticPushesPerAdmission).first();
  if (!inserted) {
    if (await c.env.DB.query('SELECT 1 FROM push_credentials WHERE session_id = ? AND approval_id = ?').bind(sessionId, approvalId).first()) {
      fail(409, 'push_attempt_exists', 'This approval already has a push attempt. Inspect its outcome before requesting a new push.');
    }
    fail(429, 'automatic_push_limit', 'This message already used its automatic pushes.');
  }
  const closeFailed = () => c.env.DB.query("UPDATE push_credentials SET completed_at = ?, outcome = 'failed' WHERE id = ? AND completed_at IS NULL")
    .bind(now(), credentialId).run();
  let minted: MintedToken;
  try {
    minted = await mintPushToken(c.env, { workspaceId: row.workspace_id, sessionId, provider, host, fullName: pin.fullName,
      repositoryId: String(pin.repositoryId), branch: operation.branch, ...(operation.tag === undefined ? {} : { tag: operation.tag }),
      ownerId: row.owner_id, connectorId: row.connector_id ?? null, hostOwnerId: row.connector_owner_id ?? null, owner: access });
  } catch (error) {
    await closeFailed();
    throw error;
  }
  try {
    const revocation = minted.revocation ? await encryptToken(c.env, `push-credential:${credentialId}`, JSON.stringify(minted.revocation)) : null;
    await c.env.DB.query('UPDATE push_credentials SET kind = ?, identity_id = ?, expires_at = ?, revocation_ciphertext = ? WHERE id = ?')
      .bind(minted.kind, minted.identityId, minted.expiresAt, revocation, credentialId).run();
    await auditStatement(c.env, actorId, 'git.push.credential_issued', row.workspace_id, sessionId, {
      approvalId, credentialId, requestedBy, actingAs: row.owner_id, automatic, kind: minted.kind, branch: operation.branch,
      ...(operation.tag === undefined ? {} : { tag: operation.tag }),
    }).run();
    const latest = await authorize();
    if (latest.row.policy_version !== row.policy_version || latest.row.repositories_json !== row.repositories_json) {
      fail(403, 'permission_revoked', 'Session authority changed.');
    }
    await requireBinding(c, row.workspace_id, pin);
    await recheckAccess(c.env, access);
  } catch (error) {
    try { await closeFailed(); } catch { }
    if (minted.revocation) {
      if (minted.revocation.kind === 'github-installation') await revokePushToken(c.env, minted.revocation);
      try { await c.env.DB.query('UPDATE push_credentials SET revocation_ciphertext = NULL WHERE id = ?').bind(credentialId).run(); } catch { }
    }
    throw error;
  }
  const expiresAt = new Date(minted.expiresAt * 1000).toISOString();
  const result: PushCredential | HostPushCredential = minted.authorization === null
    ? { credentialId, remote: target.remote, hostCredentials: true, expiresAt }
    : { credentialId, remote: target.remote, authorization: minted.authorization, expiresAt };
  return c.json(result);
}

export async function pushComplete(c: AppContext, connectorId: string | null): Promise<Response> {
  const input = await jsonObject(c, 4096);
  if (Object.keys(input).some(key => !['sessionId', 'approvalId', 'credentialId', 'outcome', 'tip'].includes(key))) {
    fail(400, 'invalid_push_request', 'Unexpected push completion field.');
  }
  const sessionId = identifier(input.sessionId, 'sessionId');
  const approvalId = identifier(input.approvalId, 'approvalId');
  const credentialId = identifier(input.credentialId, 'credentialId');
  if (!outcomes.includes(input.outcome as PushOutcome)) fail(400, 'invalid_push_request', 'Invalid push outcome.');
  const outcome = input.outcome as PushOutcome;
  if (input.tip !== undefined && (typeof input.tip !== 'string' || !/^[0-9a-f]{40}$/.test(input.tip))) fail(400, 'invalid_push_request', 'Invalid branch tip.');
  const tip = input.tip as string | undefined;
  if ((outcome === 'pushed' || outcome === 'up-to-date') && !tip) fail(400, 'invalid_push_request', 'A branch tip is required for a completed push.');

  const ledger = await c.env.DB.query<PushCredentialRow>('SELECT * FROM push_credentials WHERE id = ?').bind(credentialId).first();
  if (!ledger || ledger.session_id !== sessionId || ledger.approval_id !== approvalId) fail(403, 'invalid_push_credential', 'This completion does not match a push credential.');
  if (ledger.completed_at) fail(409, 'push_already_completed', 'This push was already completed.');
  const session = await c.env.DB.query<SessionRow>('SELECT * FROM sessions WHERE id = ?').bind(sessionId).first();
  if (!session) fail(404, 'not_found', 'Session not found.');
  try {
    await requireCallbackScope(c, session, connectorId);
  } catch (error) {
    const closed = await c.env.DB.query<{ revocation_ciphertext: string | null }>(`UPDATE push_credentials SET completed_at = ?, outcome = 'failed', tip = NULL
      WHERE id = ? AND completed_at IS NULL RETURNING revocation_ciphertext`).bind(now(), credentialId).first();
    if (closed) {
      await revokeStored(c.env, credentialId, closed.revocation_ciphertext);
      await auditStatement(c.env, ledger.requested_by, 'git.push.completed', session.workspace_id, sessionId, {
        approvalId, credentialId, outcome: 'failed',
      }).run();
    }
    throw error;
  }
  const claimed = await c.env.DB.query<{ revocation_ciphertext: string | null }>(`UPDATE push_credentials SET completed_at = ?, outcome = ?, tip = ?
    WHERE id = ? AND completed_at IS NULL RETURNING revocation_ciphertext`)
    .bind(now(), outcome, tip ?? null, credentialId).first();
  if (!claimed) fail(409, 'push_already_completed', 'This push was already completed.');
  await revokeStored(c.env, credentialId, claimed.revocation_ciphertext);
  await auditStatement(c.env, ledger.requested_by, 'git.push.completed', session.workspace_id, sessionId, {
    approvalId, credentialId, outcome, ...(tip ? { tip } : {}),
  }).run();

  const operation = parseOperation(JSON.parse(ledger.operation_json)) as GitPushOperation;
  const result: PushCompletionResult = {};
  if ((outcome !== 'pushed' && outcome !== 'up-to-date') || !operation.pullRequest || !tip) return c.json(result);
  const pullRequestInput = operation.pullRequest;
  const authorize = async (): Promise<SessionRow> => {
    const owner = await sessionAccess(c.env, sessionId, session.owner_id);
    if (!owner || owner.row.status === 'archived' || owner.row.policy_version !== session.policy_version ||
        owner.row.repositories_json !== session.repositories_json || !hasPermission(owner.permissions, 'write')) {
      fail(403, 'permission_revoked', 'Session authority changed; the pull request was not opened.');
    }
    await requireCallbackScope(c, owner.row, connectorId);
    return owner.row;
  };
  try {
    const row = await authorize();
    const pin = await pushPin(c.env, row, operation);
    if (pin.bindingId !== ledger.binding_id) fail(403, 'repository_binding_mismatch', 'The pinned repository changed.');
    await requireBinding(c, row.workspace_id, pin);
    const { provider, host } = pinProvider(pin);
    const access = await repositoryAccess(c.env, row.owner_id, provider, host, pin.fullName);
    const target = await pushTarget(access, pin, operation.branch);
    if (!target.canPush) fail(403, 'push_permission_required', 'The session owner cannot push to this repository.');
    if (await branchTip(access, pin, operation.branch) !== tip) fail(409, 'push_tip_mismatch', 'The pushed branch moved; the pull request was not opened.');
    const base = pullRequestInput.base ?? target.defaultBranch;
    if (base === operation.branch) fail(400, 'invalid_pull_request', 'The pull request base must differ from the pushed branch.');
    await recheckAccess(c.env, access);
    await authorize();
    await requireBinding(c, row.workspace_id, pin);
    const pullRequest = await openPullRequest(access, pin, { head: operation.branch, base, title: pullRequestInput.title, body: pullRequestInput.body,
      ...(pullRequestInput.draft === undefined ? {} : { draft: pullRequestInput.draft }) }, target.azureProjectId);
    await c.env.DB.query(`UPDATE push_credentials SET pull_request_url = ?, pull_request_checked_at = NULL, pull_request_state = (SELECT p.pull_request_state
      FROM push_credentials p WHERE p.session_id = ? AND p.pull_request_url = ? AND p.pull_request_state IS NOT NULL
        AND p.pull_request_state NOT IN ('merged', 'closed')
      ORDER BY p.completed_at DESC, p.created_at DESC, p.id DESC LIMIT 1) WHERE id = ?`).bind(pullRequest.url, sessionId, pullRequest.url, credentialId).run();
    await auditStatement(c.env, ledger.requested_by, 'git.push.pull_request', session.workspace_id, sessionId, {
      approvalId, credentialId, url: pullRequest.url, number: pullRequest.number, created: pullRequest.created, actingAs: row.owner_id,
      ...(pullRequestInput.draft === undefined ? {} : { draft: pullRequest.draft }),
    }).run();
    result.pullRequest = { url: pullRequest.url, number: pullRequest.number, created: pullRequest.created,
      ...(pullRequestInput.draft === undefined ? {} : { draft: pullRequest.draft }) };
  } catch (error) {
    let code = 'internal_error';
    if (error instanceof HTTPException && error.res) {
      try { code = String((await error.res.clone().json() as { code?: unknown }).code ?? code); } catch { }
    }
    await auditStatement(c.env, ledger.requested_by, 'git.push.pull_request_failed', session.workspace_id, sessionId, { approvalId, credentialId, code }).run();
    throw error;
  }
  return c.json(result);
}
