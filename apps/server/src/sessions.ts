import { hostCapabilities } from './authority/index.js';
import { parseCapabilities } from '../../../packages/shared/src/connector.js';
import type { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { streamSSE } from 'hono/streaming';
import type { ApprovalRecord, ChatOptions, Operation, Permission, RunnerBinding, SessionRole, SessionView, SubmitResult, WithdrawResult, WorkspaceRole } from '../../../packages/shared/src/types.js';
import { accessModes, permissions, sessionRoles, thinkingLevels } from '../../../packages/shared/src/types.js';
import { connectorLimits, type ConnectorCapabilities, type LocalModelSummary } from '../../../packages/shared/src/connector.js';
import { parseChatImages, type ChatImage } from '../../../packages/shared/src/chat-images.js';
import { sha256 } from '../../../packages/shared/src/crypto.js';
import { isRevision } from '../../../packages/shared/src/view-patch.js';
import { hasPermission, managesSession, normalizePermissions, roleSessionCeiling, sessionRoleOf, sessionRolePermissions, validateUserEnv } from '../../../packages/shared/src/policy.js';
import type { AgentRow, AppContext, Env, ModelRow, SessionAccess, SessionRow, AppEnv } from './types.js';
import { agentVersion, getUser, modelDefinition, requireActiveSession, requireUnfrozen, runnerSessionRecord, sessionRecord, userProfile } from './db.js';
import {
  auditStatement, cloneRepositories, hostAuthority, issueRunAdmission, legacyRepositoryFixture, listSessionAccess, requireConnectorSession, requireMember,
  requireRunnerAccess, requireSession, requireSessionCreator, requireSessionManager, runsShellCommands, sessionAccess, sessionCreatorSQL, sessionManagerSQL,
  audienceSharing,
} from './authority/index.js';
import { sessionBranchName } from '../../../packages/shared/src/git-push.js';
import { fail, id, identifier, jsonObject, now, randomToken, testMode, text, userIdentifier } from './http.js';
import { runnerJSON, runnerRequest } from './runner.js';
import { connectorUtf8Bytes } from './connector-transport.js';
import { hostSessionsNeedConsent, hostSessionsSupported } from './connectors.js';
import { connectorHostConfig } from './host-config.js';
import { chatAgentVersion, requireModel } from './catalog.js';
import { isLinkShared } from './session-links.js';
import { disabledModelKeys, isModelDisabled, messageNeedsModel, modelEnabledSQL, requireEnabledModel } from './host-models.js';
import { earlierEntries, invalidateSessionView, sessionView, transcriptDisplay, viewChanges } from './view-feed.js';
import { stopSessionTunnel } from './session-tunnels.js';
import { toolOutputs, transcriptPage, type ToolOutput } from '../../../packages/shared/src/transcript-display.js';
import { newSessionToolOutput } from './transcript-settings.js';
import { packSession, reopenUnpacked, unpackSession } from './session-packing.js';

async function chatOptions(c: AppContext, row: SessionRow, mode: 'submit' | 'ask', value: unknown): Promise<ChatOptions | undefined> {
  if (value === undefined) return undefined;
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(400, 'invalid_options', 'Invalid chat options.');
  const input = value as Record<string, unknown>;
  if (Object.keys(input).some(key => !['model', 'thinkingLevel', 'access', 'autoMerge'].includes(key))) fail(400, 'invalid_options', 'Invalid chat options.');
  if (input.access !== undefined && (mode !== 'submit' || !accessModes.includes(input.access as never))) fail(400, 'invalid_options', 'Side asks are always read-only.');
  if (input.autoMerge !== undefined && typeof input.autoMerge !== 'boolean') fail(400, 'invalid_options', 'Invalid auto-merge choice.');
  if (input.model === undefined && input.thinkingLevel === undefined && input.access !== 'read') return undefined;
  if (!row.connector_id) fail(400, 'options_unsupported', 'This session\'s runner cannot change model, reasoning or access.');
  const host = await c.env.DB.query<{ models_json: string; capabilities_json: string }>('SELECT models_json, capabilities_json FROM connectors WHERE id = ? AND revoked_at IS NULL')
    .bind(row.connector_id).first();
  if (!host) fail(409, 'connector_unavailable', 'The session\'s host is no longer available.');
  const capabilities = parseCapabilities(host.capabilities_json);
  if (capabilities.chatOptions !== true) {
    fail(409, 'connector_update_required', 'Update the host\'s connector (npx pikibun@latest connect) to choose model, reasoning or access.');
  }
  const options: ChatOptions = {};
  if (input.model !== undefined) {
    const model = input.model as Record<string, unknown>;
    if (!model || typeof model !== 'object' || Array.isArray(model) || Object.keys(model).some(key => key !== 'provider' && key !== 'modelId')) fail(400, 'invalid_options', 'Invalid model choice.');
    const provider = text(model.provider, 'provider', 80);
    const modelId = text(model.modelId, 'modelId', 200);
    const advertised = (JSON.parse(host.models_json) as LocalModelSummary[]).find(item => item.provider === provider && item.modelId === modelId);
    if (!advertised) fail(403, 'model_not_on_host', 'Only models offered by this session\'s host can be chosen.');
    if (isModelDisabled(await disabledModelKeys(c.env, row.connector_id), advertised)) {
      fail(403, 'model_disabled', `${advertised.name} is disabled on this session's host. Choose another model.`);
    }
    if (input.thinkingLevel !== undefined && advertised.thinkingLevels && !advertised.thinkingLevels.includes(input.thinkingLevel as never)) {
      fail(400, 'invalid_options', 'The model does not support this reasoning level.');
    }
    options.model = { provider, modelId };
  }
  if (input.thinkingLevel !== undefined) {
    if (!thinkingLevels.includes(input.thinkingLevel as never)) fail(400, 'invalid_options', 'Invalid reasoning level.');
    options.thinkingLevel = input.thinkingLevel as ChatOptions['thinkingLevel'];
  }
  if (input.access === 'read') options.access = 'read';
  return options;
}

async function chatImages(c: AppContext, row: SessionRow, value: unknown): Promise<ChatImage[] | undefined> {
  if (value === undefined) return undefined;
  const parsed = parseChatImages(value);
  if ('error' in parsed) fail(400, 'invalid_images', parsed.error);
  if (!parsed.images.length) return undefined;
  if (!row.connector_id) fail(400, 'images_unsupported', 'This session\'s runner cannot take images.');
  const capabilities = await hostCapabilities(c.env, row.connector_id, { active: true });
  if (!capabilities) fail(409, 'connector_unavailable', 'The session\'s host is no longer available.');
  if (capabilities.chatImages !== true) {
    fail(409, 'connector_update_required', 'Update the host\'s connector (npx pikibun@latest connect) to send images.');
  }
  return parsed.images;
}

export async function submitMessage(c: AppContext, row: SessionRow, mode: 'submit' | 'ask', input: Record<string, unknown>,
  audit: Record<string, unknown> = {}, { currentModel = false }: { currentModel?: boolean } = {}): Promise<SubmitResult> {
  requireUnfrozen(row);
  if ('admissionId' in input) fail(400, 'server_owned_admission', 'Write admissions are assigned by the server.');
  const images = await chatImages(c, row, input.images);
  const content = text(input.content, 'content', 60000, images ? 0 : 1);
  const requestId = text(input.requestId, 'requestId', 128);
  const requested = currentModel ? await withCurrentModel(c, row, input.options as Record<string, unknown> | undefined) : input.options;
  const options = await chatOptions(c, row, mode, requested);
  await requireEnabledModel(c, row, options);
  if (images && connectorUtf8Bytes(JSON.stringify({ content, requestId, admissionId: 'x'.repeat(43), options, images })) > connectorLimits.requestBytes) {
    fail(413, 'message_too_large', 'This message and its images are too large to send together. Remove an image or shorten the message.');
  }
  if (mode === 'submit' && row.connector_id && (await hostCapabilities(c.env, row.connector_id))?.approvalFree !== true) {
    fail(409, 'connector_update_required', 'Update the host\'s connector (npx pikibun@latest connect): Pikibun no longer asks anyone to approve a session\'s tools, and this connector still would.');
  }
  const admissionId = mode === 'submit' ? await issueRunAdmission(c, row, content, requestId, options?.access, images) : undefined;
  const result = await runnerJSON<SubmitResult>(await runnerRequest(c, row, mode, '', { content, requestId, ...(admissionId ? { admissionId } : {}), ...(options ? { options } : {}),
    ...(images ? { images } : {}) }));
  invalidateSessionView(c, row.id);
  if (typeof result?.submissionId !== 'string' || typeof result.conversationId !== 'string' || typeof result.status !== 'string') fail(502, 'invalid_runner_response', 'The runner returned an invalid submission.');
  if (mode === 'submit' && Number(row.one_shot) === 1) {
    await c.env.DB.query('UPDATE sessions SET one_shot = 0 WHERE id = ? AND one_shot = 1').bind(row.id).run();
    row.one_shot = 0;
  }
  await auditStatement(c.env, c.get('auth').userId, `session.${mode}`, row.workspace_id, row.id, { submissionId: result.submissionId, ...(options ? { options } : {}),
    ...(images ? { images: images.length } : {}), ...audit }).run();
  return result;
}

async function withCurrentModel(c: AppContext, row: SessionRow, options: Record<string, unknown> | undefined): Promise<Record<string, unknown> | undefined> {
  if (options?.model !== undefined || !await messageNeedsModel(c.env, row)) return options;
  const { agent } = (await sessionView(c, row, { latest: true })).view;
  if (agent) {
    return { ...options, model: { provider: agent.provider, modelId: agent.modelId }, ...(options?.thinkingLevel === undefined && agent.thinkingLevel ? { thinkingLevel: agent.thinkingLevel } : {}) };
  }
  const own = await c.env.DB.query<{ provider: string; model_id: string }>(`SELECT m.provider, m.model_id FROM agent_versions a
    JOIN models m ON m.id = a.model_id WHERE a.id = ?`).bind(row.agent_version_id).first();
  return own ? { ...options, model: { provider: own.provider, modelId: own.model_id } } : options;
}

export async function createSession(c: AppContext, input: Record<string, unknown>,
  link: { parentSessionId?: string; scheduleId?: string; inserted?: (sessionId: string) => void } = {}): Promise<{ row: SessionRow; notice?: string }> {
  if (['ownerId', 'permissions', 'githubId', 'repositories', 'repositories_json', 'pins'].some(key => key in input)) fail(400, 'server_owned_identity', 'Session identity, repository pins, and permissions are assigned by the server.');
  const workspaceId = identifier(input.workspaceId, 'workspaceId');
  if (input.agentVersionId !== undefined) fail(400, 'invalid_input', 'Sessions start from a model; agents were removed.');
  const title = text(input.title ?? 'Untitled session', 'title', 200);
  const visibility = sessionVisibility(input.visibility === undefined ? 'workspace' : input.visibility);
  const ownerId = c.get('auth').userId;
  await requireSessionCreator(c.env, workspaceId, ownerId);
  const model = await requireModel(c.env, identifier(input.modelId, 'modelId'), ownerId);
  if (model.workspace_id !== workspaceId) fail(404, 'not_found', 'Model not found.');
  if (model.provider === 'faux' && !testMode(c.env)) fail(403, 'test_mode_disabled', 'Faux models are disabled.');
  const syntheticLegacy = model.provider === 'faux' && await legacyRepositoryFixture(c.env, ownerId);
  if (!model.connector_id && !syntheticLegacy) fail(400, 'connector_required', 'New sessions require a connected model.');
  if (model.connector_id && model.connector_owner_id !== ownerId && input.trustedConnectorId !== model.connector_id) {
    fail(400, 'connector_trust_required', 'Explicitly acknowledge that this host can access this session before continuing.');
  }
  const session = { id: id(), workspace_id: workspaceId, owner_id: ownerId, title, visibility, policy_version: 1, status: 'provisioning' as const,
    created_at: now(), connector_id: model.connector_id ?? null, connector_owner_id: model.connector_owner_id ?? null };
  const capabilities = await hostCapabilities(c.env, session.connector_id) ?? parseCapabilities(null);
  if (session.connector_id && capabilities.plainGit !== true) {
    fail(409, 'connector_update_required', 'Update the host\'s connector (npx pikibun@latest connect): sessions now clone their repositories with plain Git.');
  }
  if (input.hostEnvironment !== undefined && typeof input.hostEnvironment !== 'boolean') fail(400, 'invalid_input', 'hostEnvironment must be true or false.');
  const onHost = input.hostEnvironment === true;
  const granted = session.connector_owner_id !== ownerId;
  const needsConsent = onHost && hostSessionsNeedConsent(capabilities, granted);
  if (onHost) {
    if (!session.connector_id || (granted && (await hostAuthority(c.env, session, ownerId))?.sessions !== true)) {
      fail(403, 'host_owner_required', 'Only a host\'s owner, or a member they granted sessions on the host, starts sessions that run directly on it.');
    }
    if (capabilities.unsandboxed === true) fail(400, 'host_unsandboxed', 'This host runs every session without the sandbox already.');
    if (!hostSessionsSupported(capabilities, granted)) {
      fail(409, 'connector_update_required', 'Update the host\'s connector (npx pikibun@latest connect) to run sessions directly on it.');
    }
    if (needsConsent && !(await connectorHostConfig(c.env, session.connector_id)).hostSessions) {
      fail(409, 'host_sessions_off', 'This host doesn\'t accept sessions that run directly on it. Turn that on under Settings → Hosts → the host → Configuration.');
    }
  }
  const resolved = await cloneRepositories(c.env, workspaceId, ownerId);
  const agent = await chatAgentVersion(c.env, ownerId, model, capabilities);
  const row: SessionRow & { repositories_json: string } = { ...session, agent_version_id: agent.id, repositories_json: '[]', repository_mode: 'clone',
    branch: capabilities.sessionBranches === true ? sessionBranchName(title, session.id) : null, host_environment: onHost ? 1 : 0,
    tool_output: await newSessionToolOutput(c.env.DB, workspaceId) };
  const gitPush = row.connector_id && (JSON.parse(agent.tools_json) as unknown[]).includes('git_push') ? 1 : 0;
  const notice = row.connector_id ? await cloneUnavailable(c.env, capabilities, row, JSON.parse(agent.tools_json) as string[]) : undefined;
  await requireSessionCreator(c.env, workspaceId, ownerId);
  if (row.connector_id) await requireConnectorSession(c.env, row.connector_id, row);
  const inserted = await c.env.DB.query(`INSERT INTO sessions
    (id, workspace_id, owner_id, agent_version_id, title, policy_version, status, created_at, connector_id, connector_owner_id, repositories_json, visibility, repository_mode, branch,
      host_environment, tool_output)
    SELECT ?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?
    WHERE ${sessionCreatorSQL('?')}
    AND (SELECT json_group_array(id ORDER BY id) FROM workspace_sources WHERE workspace_id = ?) = json(?)
    AND EXISTS (SELECT 1 FROM users session_owner WHERE session_owner.id = ? AND session_owner.suspended_at IS NULL
      AND ((? = 1 AND session_owner.auth_kind IN ('github', 'password')) OR (? = 1 AND session_owner.auth_kind = 'test'))
      AND (? IS NULL OR (session_owner.auth_kind = 'github' AND session_owner.github_id = ?
        AND EXISTS (SELECT 1 FROM github_tokens WHERE user_id = session_owner.id AND ciphertext = ?))))
    AND (SELECT COUNT(*) FROM json_each(?) used JOIN git_credentials credential
      ON credential.id = json_extract(used.value, '$.id') AND credential.ciphertext = json_extract(used.value, '$.ciphertext')
      AND credential.user_id = ?) = ?
    AND (? IS NULL OR EXISTS (
      SELECT 1 FROM connectors host JOIN connector_workspaces association ON association.connector_id = host.id
      JOIN workspace_members member ON member.workspace_id = association.workspace_id AND member.user_id = host.owner_id
      JOIN users host_user ON host_user.id = host.owner_id
      JOIN models m ON m.id = ?
      WHERE host.id = ? AND host.owner_id = ? AND host.revoked_at IS NULL AND host_user.suspended_at IS NULL AND association.workspace_id = ?
        AND (host.owner_id = ? OR EXISTS (SELECT 1 FROM connector_shares share
          WHERE share.connector_id = host.id AND share.workspace_id = association.workspace_id))
        AND m.available = 1 AND m.connector_id = host.id AND m.connector_owner_id = host.owner_id AND ${modelEnabledSQL('host.id', 'm')}
        AND (? = 1 OR (host_user.auth_kind <> 'test' AND m.provider <> 'faux'))
        AND (? = 0 OR json_type(host.capabilities_json, '$.gitPush') = 'true')
        AND EXISTS (SELECT 1 FROM json_each(host.models_json) local
          WHERE json_extract(local.value, '$.provider') = m.provider AND json_extract(local.value, '$.modelId') = m.model_id)
    ))
    AND (? = 0 OR EXISTS (SELECT 1 FROM connector_configs accepted WHERE accepted.connector_id = ? AND accepted.host_sessions = 1))
    RETURNING id`)
    .bind(row.id, row.workspace_id, row.owner_id, row.agent_version_id, row.title, row.policy_version, row.status, row.created_at,
      row.connector_id ?? null, row.connector_owner_id ?? null, row.repositories_json, row.visibility ?? 'private', row.repository_mode ?? null, row.branch ?? null,
      row.host_environment ?? 0, row.tool_output ?? 'full',
      workspaceId, ownerId, workspaceId, resolved.sourceIds,
      ownerId, resolved.sourceIds === '[]' && !resolved.sourcesOptional ? 0 : 1, resolved.githubAuthority === null && testMode(c.env) ? 1 : 0,
      resolved.githubAuthority?.githubId ?? null, resolved.githubAuthority?.githubId ?? null, resolved.githubAuthority?.ciphertext ?? null,
      JSON.stringify(resolved.credentials), ownerId, resolved.credentials.length,
      row.connector_id ?? null, model.id, row.connector_id ?? null, row.connector_owner_id ?? null, workspaceId, ownerId,
      testMode(c.env) ? 1 : 0, gitPush,
      needsConsent ? 1 : 0, row.connector_id ?? null).first();
  if (!inserted) fail(409, 'session_configuration_changed', 'Workspace repositories, Git account access, membership, or connector authority changed. Try again.');
  link.inserted?.(row.id);
  if (link.parentSessionId) {
    await c.env.DB.query('UPDATE sessions SET parent_session_id = ?, schedule_id = ? WHERE id = ?').bind(link.parentSessionId, link.scheduleId ?? null, row.id).run();
    row.parent_session_id = link.parentSessionId;
    row.schedule_id = link.scheduleId ?? null;
  }
  await auditStatement(c.env, ownerId, 'session.created', workspaceId, row.id, { agentVersionId: agent.id, ...(onHost ? { hostEnvironment: true } : {}),
    ...(link.parentSessionId ? { parentSessionId: link.parentSessionId } : {}), ...(link.parentSessionId && link.scheduleId ? { scheduleId: link.scheduleId } : {}) }).run();
  try {
    const binding = await bindingForSession(c, row);
    const response = await runnerRequest(c, row, 'create', '', binding);
    await response.body?.cancel();
    await c.env.DB.query('UPDATE sessions SET status = ? WHERE id = ?').bind('ready', row.id).run();
    row.status = 'ready';
  } catch (error) {
    await c.env.DB.query('UPDATE sessions SET status = ? WHERE id = ?').bind('error', row.id).run();
    await auditStatement(c.env, ownerId, 'session.provision_failed', workspaceId, row.id).run();
    throw error;
  }
  return { row, ...(notice ? { notice } : {}) };
}

export async function archiveSession(c: AppContext, sessionId: string, audit: Record<string, unknown> = {}): Promise<SessionAccess> {
  const access = await requireSessionManager(c, sessionId, 'manage', 'Only the session owner, or the workspace\'s owner or an admin, can archive it.');
  const { row } = access;
  const actorId = c.get('auth').userId;
  if (row.tunnel_url && row.connector_id) await stopSessionTunnel(c, row, 'archived').catch(() => false);
  const archived = await c.env.DB.query<SessionRow>(`UPDATE sessions SET archived_status = status, status = 'archived', policy_version = policy_version + 1,
    tunnel_url = NULL, tunnel_expires_at = NULL
    WHERE id = ? AND owner_id = ? AND policy_version = ? AND status <> 'archived' AND ${sessionManagerSQL('sessions')}
    RETURNING *`).bind(row.id, row.owner_id, row.policy_version, actorId).first();
  if (!archived) fail(409, 'policy_changed', 'Session status or permissions changed; reload and retry.');
  await auditStatement(c.env, actorId, 'session.archived', row.workspace_id, row.id, { previousStatus: row.status, ...audit }).run();
  return { ...access, row: archived };
}

export async function stopSession(c: AppContext, row: SessionRow, audit: Record<string, unknown> = {}): Promise<number> {
  const result = await runnerJSON<{ stopped: number }>(await runnerRequest(c, row, 'stop', '', {}));
  invalidateSessionView(c, row.id);
  if (!Number.isSafeInteger(result?.stopped) || result.stopped < 0) fail(502, 'invalid_runner_response', 'The runner returned an invalid stop result.');
  await auditStatement(c.env, c.get('auth').userId, 'session.stopped', row.workspace_id, row.id, { stopped: result.stopped, ...audit }).run();
  return result.stopped;
}

function messageEntry(input: Record<string, unknown>): string {
  if (Object.keys(input).some(key => key !== 'entryId') || typeof input.entryId !== 'string' || !/^\d{1,15}:\d{1,15}$/.test(input.entryId)) {
    fail(400, 'invalid_input', 'entryId names one message of the shared conversation.');
  }
  return input.entryId;
}

async function forkModel(c: AppContext, source: SessionRow, agent: SessionView['agent'], actorId: string): Promise<string> {
  if (agent) {
    const rows = await c.env.DB.query<{ id: string }>('SELECT id FROM models WHERE workspace_id = ? AND connector_id = ? AND provider = ? AND model_id = ?')
      .bind(source.workspace_id, source.connector_id ?? null, agent.provider, agent.modelId).all();
    for (const row of rows) {
      try { return (await requireModel(c.env, row.id, actorId)).id; }
      catch (error) { if (!(error instanceof HTTPException)) throw error; }
    }
  }
  const own = await c.env.DB.query<{ model_id: string }>('SELECT model_id FROM agent_versions WHERE id = ?').bind(source.agent_version_id).first();
  if (!own) fail(409, 'invalid_binding', 'Session binding is incomplete.');
  return own.model_id;
}

export async function forkSession(c: AppContext, source: SessionRow, entryId: string, title?: string): Promise<{ row: SessionRow }> {
  const actorId = c.get('auth').userId;
  requireUnfrozen(source);
  if (!source.connector_id) fail(409, 'connector_required', 'Only a session on a connected host can be forked.');
  const { agent, memberForks } = (await sessionView(c, source, { latest: true })).view;
  if (source.owner_id !== actorId && memberForks !== true) {
    fail(409, 'connector_update_required', 'Only the session owner can fork it on this host until its connector is updated (npx pikibun@latest connect).');
  }
  const modelId = await forkModel(c, source, agent, actorId);
  const { row } = await createSession(c, {
    workspaceId: source.workspace_id, title: title ?? `Fork: ${source.title}`.slice(0, 200), visibility: source.visibility ?? 'private',
    modelId, trustedConnectorId: source.connector_id, ...(source.host_environment ? { hostEnvironment: true } : {}),
  });
  try {
    const result = await runnerJSON<{ conversationId: string; entries: number }>(
      await runnerRequest(c, row, 'fork', '', { sourceSessionId: source.id, entryId }), 65536);
    if (typeof result?.conversationId !== 'string') fail(502, 'invalid_runner_response', 'The runner returned an invalid fork result.');
  } catch (error) {
    await archiveSession(c, row.id, { forkFailed: true }).catch(() => {});
    throw error;
  }
  await auditStatement(c.env, actorId, 'session.forked', row.workspace_id, row.id, { sourceSessionId: source.id, entryId,
    ...(source.owner_id !== actorId ? { sourceOwnerId: source.owner_id } : {}) }).run();
  return { row };
}

export async function bindingForSession(c: AppContext, row: SessionRow): Promise<RunnerBinding> {
  const [owner, agent] = await Promise.all([
    getUser(c.env, row.owner_id),
    c.env.DB.query<AgentRow>('SELECT * FROM agent_versions WHERE id = ?').bind(row.agent_version_id).first(),
  ]);
  if (!owner || !agent) fail(409, 'invalid_binding', 'Session binding is incomplete.');
  const model = await c.env.DB.query<ModelRow>('SELECT * FROM models WHERE id = ? AND workspace_id = ?').bind(agent.model_id, row.workspace_id).first();
  if (!model) fail(409, 'invalid_binding', 'The session model is not available.');
  if ((model.connector_id ?? null) !== (row.connector_id ?? null) || (model.connector_owner_id ?? null) !== (row.connector_owner_id ?? null)) {
    fail(409, 'invalid_binding', 'Session connector binding is inconsistent.');
  }
  if (row.connector_id) await requireConnectorSession(c.env, row.connector_id, row);
  if (model.provider === 'faux' && !testMode(c.env)) fail(403, 'test_mode_disabled', 'Faux models are available only in the explicitly enabled test environment.');
  const profile = userProfile(owner);
  profile.env = validateUserEnv(profile.env);
  return { session: runnerSessionRecord(row), owner: profile, agent: agentVersion(agent), model: modelDefinition(model) };
}

function sessionVisibility(value: unknown): 'private' | 'workspace' {
  if (value !== 'private' && value !== 'workspace') fail(400, 'invalid_visibility', 'Visibility must be private or workspace.');
  return value;
}

async function viewRefused(c: AppContext, row: SessionRow): Promise<boolean> {
  const refused = (error: unknown) => {
    if (!(error instanceof HTTPException)) throw error;
    return error.status === 403;
  };
  try {
    await requireRunnerAccess(c, c.get('auth').userId, row, 'view');
  } catch (error) {
    if (refused(error)) return true;
  }
  if (!row.connector_id) return false;
  try {
    await requireConnectorSession(c.env, row.connector_id, row);
  } catch (error) {
    if (refused(error)) return true;
  }
  return false;
}

function pollingEvents(c: AppContext, row: SessionRow): Response {
  const since = c.req.query('since');
  let held = isRevision(since) ? since : undefined;
  const response = streamSSE(c, async stream => {
    let releaseStop!: () => void;
    const stopped = new Promise<undefined>(resolve => { releaseStop = () => resolve(undefined); });
    const abort = () => stream.abort();
    let cancelPause = () => {};
    stream.onAbort(releaseStop);
    c.req.raw.signal.addEventListener('abort', abort, { once: true });
    const deadline = setTimeout(abort, 8000);
    const snapshots = row.connector_id ? 2 : 4;
    try {
      if (c.req.raw.signal.aborted) abort();
      for (let snapshot = 0; snapshot < snapshots && !stream.aborted; snapshot++) {
        const display = await Promise.race([transcriptDisplay(c, row), stopped]);
        if (!display || stream.aborted) break;
        const shown = await Promise.race([sessionView(c, row, { display }), stopped]);
        if (!shown || stream.aborted) break;
        const access = await Promise.race([requireSession(c, row.id, 'read'), stopped]);
        if (!access || stream.aborted) break;
        if (access.row.connector_id) await requireConnectorSession(c.env, access.row.connector_id, access.row);
        if (stream.aborted) break;
        const patch = since === undefined ? null : viewChanges(c, row, held, shown, display);
        held = shown.revision;
        await Promise.race([stream.writeSSE(patch ? { event: 'patch', data: JSON.stringify({ patch }) }
          : { event: 'view', data: JSON.stringify(since === undefined ? { view: shown.view } : { view: shown.view, revision: shown.revision }) }), stopped]);
        if (snapshot < snapshots - 1 && !stream.aborted) {
          await Promise.race([new Promise<void>(resolve => {
            const timer = setTimeout(resolve, 1000);
            cancelPause = () => clearTimeout(timer);
          }), stopped]);
        }
      }
      await Promise.race([stream.close(), stopped]);
    } catch {
      abort();
    } finally {
      clearTimeout(deadline);
      cancelPause();
      c.req.raw.signal.removeEventListener('abort', abort);
    }
  });
  response.headers.set('Cache-Control', 'private, no-store, no-transform');
  response.headers.set('X-Accel-Buffering', 'no');
  return response;
}

export async function cloneUnavailable(env: Env, capabilities: ConnectorCapabilities,
  row: Pick<SessionRow, 'connector_id' | 'connector_owner_id' | 'workspace_id' | 'owner_id'>, tools: readonly string[]): Promise<string | undefined> {
  if (!tools.includes('git') && !tools.includes('bash')) return 'This session\'s agent doesn\'t have the git tool, so it can\'t clone the workspace\'s repositories and works in an empty worktree.';
  if (!await runsShellCommands(env, capabilities, row, row.owner_id)) {
    return 'This session\'s host has no resource limits, so it runs shell commands only for its owner and for members they granted host commands: '
      + 'the agent can\'t clone the workspace\'s repositories and works in an empty worktree.';
  }
  return undefined;
}

export function registerSessions(app: Hono<AppEnv>): void {
  app.get('/api/sessions', async c => {
    const actorId = c.get('auth').userId;
    const sessions = (await listSessionAccess(c.env, actorId))
      .map(access => sessionRecord(access.row, access.permissions));
    return c.json({ sessions });
  });

  app.post('/api/sessions', async c => {
    const { row, notice } = await createSession(c, await jsonObject(c));
    return c.json({ session: { ...sessionRecord(row, [...permissions]), ...(notice ? { cloneUnavailable: notice } : {}) } }, 201);
  });

  app.get('/api/sessions/:id', async c => {
    const access = await requireSession(c, identifier(c.req.param('id')), 'read');
    const capabilities: unknown = await hostCapabilities(c.env, access.row.connector_id);
    const hostUnsandboxed = (typeof capabilities === 'object' && capabilities !== null && 'unsandboxed' in capabilities && capabilities.unsandboxed === true)
      || Number(access.row.host_environment ?? 0) === 1;
    const agent = access.row.repository_mode === 'clone' && access.row.connector_id && capabilities
      ? await c.env.DB.query<{ tools_json: string }>('SELECT tools_json FROM agent_versions WHERE id = ?').bind(access.row.agent_version_id).first() : null;
    const notice = agent ? await cloneUnavailable(c.env, capabilities as ConnectorCapabilities, access.row, JSON.parse(agent.tools_json) as string[]) : undefined;
    const linkShared = await isLinkShared(c.env, access.row.id);
    const viewable = !await viewRefused(c, access.row);
    const sharing = await audienceSharing(c.env, access.row.id);
    return c.json({ session: { ...sessionRecord(access.row, access.permissions), ...(hostUnsandboxed ? { hostUnsandboxed } : {}), ...(linkShared ? { linkShared } : {}),
      ...(notice ? { cloneUnavailable: notice } : {}), ...(sharing ? { audienceSharing: true } : {}), viewable } });
  });
  app.patch('/api/sessions/:id', async c => {
    const access = await requireSession(c, identifier(c.req.param('id')), 'manage');
    const { row } = access;
    const actorId = c.get('auth').userId;
    const manages = managesSession(actorId, row.owner_id, access.role);
    const input = await jsonObject(c, 4096);
    const keys = Object.keys(input);
    if (keys.length === 1 && keys[0] === 'toolOutput') {
      if (!manages) fail(403, 'owner_required', 'Only the session owner, or the workspace\'s owner or an admin, can change how it shows tool output.');
      if (!toolOutputs.includes(input.toolOutput as ToolOutput)) fail(400, 'invalid_tool_output', 'Tool output is either full or brief.');
      const toolOutput = input.toolOutput as ToolOutput;
      const updated = await c.env.DB.query<SessionRow>(`UPDATE sessions SET tool_output = ?
        WHERE id = ? AND owner_id = ? AND ${sessionManagerSQL('sessions')}
        RETURNING *`).bind(toolOutput, row.id, row.owner_id, actorId).first();
      if (!updated) fail(409, 'policy_changed', 'Session membership changed; reload and retry.');
      await auditStatement(c.env, actorId, 'session.tool_output.updated', row.workspace_id, row.id, { toolOutput }).run();
      invalidateSessionView(c, row.id);
      return c.json({ session: sessionRecord(updated, access.permissions) });
    }
    if (keys.length === 1 && keys[0] === 'title') {
      if (!manages) fail(403, 'owner_required', 'Only the session owner, or the workspace\'s owner or an admin, can rename it.');
      const title = text(input.title, 'title', 200).trim();
      if (!title || /[\r\n]/.test(title)) fail(400, 'invalid_title', 'The title must be a single non-empty line.');
      const renamed = await c.env.DB.query<SessionRow>(`UPDATE sessions SET title = ?
        WHERE id = ? AND owner_id = ? AND status <> 'archived' AND ${sessionManagerSQL('sessions')}
        RETURNING *`).bind(title, row.id, row.owner_id, actorId).first();
      if (!renamed) fail(409, 'policy_changed', 'Session membership or status changed; reload and retry.');
      await auditStatement(c.env, actorId, 'session.renamed', row.workspace_id, row.id).run();
      return c.json({ session: sessionRecord(renamed, access.permissions) });
    }
    if (!manages) fail(403, 'owner_required', 'Only the session owner, or the workspace\'s owner or an admin, can change its visibility.');
    if (keys.some(key => key !== 'visibility')) fail(400, 'invalid_input', 'Change the session title, its visibility or its tool output, one at a time.');
    const visibility = sessionVisibility(input.visibility);
    const updated = await c.env.DB.query<SessionRow>(`UPDATE sessions SET visibility = ?, policy_version = policy_version + 1
      WHERE id = ? AND owner_id = ? AND policy_version = ? AND ${sessionManagerSQL('sessions')}
        AND EXISTS (SELECT 1 FROM users owner JOIN agent_versions a ON a.id = sessions.agent_version_id
          JOIN models m ON m.id = a.model_id WHERE owner.id = sessions.owner_id
            AND (? = 1 OR (owner.auth_kind <> 'test' AND m.provider <> 'faux')))
      RETURNING *`).bind(visibility, row.id, row.owner_id, row.policy_version, actorId, testMode(c.env) ? 1 : 0).first();
    if (!updated) fail(409, 'policy_changed', 'Session membership or permissions changed; reload and retry.');
    await auditStatement(c.env, actorId, 'session.visibility.updated', row.workspace_id, row.id, { visibility }).run();
    return c.json({ session: sessionRecord(updated, access.permissions) });
  });
  app.post('/api/sessions/:id/archive', async c => {
    const archived = await archiveSession(c, identifier(c.req.param('id')));
    return c.json({ session: sessionRecord(archived.row, archived.permissions) });
  });
  app.post('/api/sessions/:id/pack', async c => {
    const packed = await packSession(c, identifier(c.req.param('id')));
    return c.json({ session: sessionRecord(packed.row, packed.permissions) });
  });
  app.post('/api/sessions/:id/unarchive', async c => {
    const access = await requireSessionManager(c, identifier(c.req.param('id')), 'read', 'Only the session owner, or the workspace\'s owner or an admin, can unarchive it.');
    const actorId = c.get('auth').userId;
    if (access.row.status !== 'archived') fail(409, 'session_not_archived', 'Session is not archived.');
    const row = await unpackSession(c, access);
    const restored = await c.env.DB.query<SessionRow>(`UPDATE sessions SET status = COALESCE(archived_status, 'ready'), archived_status = NULL, one_shot = 0,
        policy_version = policy_version + 1
      WHERE id = ? AND owner_id = ? AND policy_version = ? AND status = 'archived' AND packed_at IS NULL AND ${sessionManagerSQL('sessions')}
      RETURNING *`).bind(row.id, row.owner_id, row.policy_version, actorId).first();
    if (!restored) fail(409, 'policy_changed', 'Session status or permissions changed; reload and retry.');
    await auditStatement(c.env, actorId, 'session.unarchived', row.workspace_id, row.id, { status: restored.status }).run();
    if (access.row.packed_at) await reopenUnpacked(c, restored);
    return c.json({ session: sessionRecord(restored, access.permissions) });
  });
  app.get('/api/sessions/:id/view', async c => {
    const { row } = await requireSession(c, identifier(c.req.param('id')), 'read');
    const shown = await sessionView(c, row, { latest: true, display: await transcriptDisplay(c, row) });
    const fresh = await requireSession(c, row.id, 'read');
    if (fresh.row.connector_id) await requireConnectorSession(c.env, fresh.row.connector_id, fresh.row);
    return c.json({ view: shown.view, revision: shown.revision });
  });
  app.get('/api/sessions/:id/entries', async c => {
    const { row } = await requireSession(c, identifier(c.req.param('id')), 'read');
    const conversation = c.req.query('conversation') ?? '';
    const before = c.req.query('before') ?? '';
    const limitText = c.req.query('limit') ?? String(transcriptPage.size);
    const limit = Number(limitText);
    const name = /^[^\u0000-\u001f\u007f]{1,300}$/;
    if (!name.test(conversation) || !name.test(before)) fail(400, 'invalid_input', 'Name a conversation and the entry to read before.');
    if (!/^\d{1,4}$/.test(limitText) || limit < 1 || limit > transcriptPage.max) fail(400, 'invalid_input', `The limit must be 1 to ${transcriptPage.max}.`);
    const page = await earlierEntries(c, row, await transcriptDisplay(c, row), conversation, before, limit);
    const fresh = await requireSession(c, row.id, 'read');
    if (fresh.row.connector_id) await requireConnectorSession(c.env, fresh.row.connector_id, fresh.row);
    if (!page) fail(409, 'entries_changed', 'The transcript changed. Scroll up again to load earlier messages.');
    return c.json(page, 200, { 'Cache-Control': 'private, no-store' });
  });
  app.get('/api/sessions/:id/events', async c => {
    const { row } = await requireSession(c, identifier(c.req.param('id')), 'read');
    return pollingEvents(c, row);
  });

  for (const mode of ['submit', 'ask'] as const) {
    app.post(`/api/sessions/:id/${mode}`, async c => {
      const { row } = await requireSession(c, identifier(c.req.param('id')), mode === 'ask' ? 'ask' : 'write');
      requireUnfrozen(row);
      const input = await jsonObject(c, connectorLimits.requestBytes + 256 * 1024);
      return c.json(await submitMessage(c, row, mode, input), 202);
    });
  }

  app.get('/api/sessions/:id/grants', async c => {
    const { row } = await requireSession(c, identifier(c.req.param('id')), 'manage');
    const rows = await c.env.DB.query<{ user_id: string; permissions_json: string | null; role: WorkspaceRole }>(`SELECT m.user_id, g.permissions_json, m.role
      FROM workspace_members m
      LEFT JOIN session_grants g ON g.session_id = ? AND g.user_id = m.user_id
      WHERE m.workspace_id = ? AND (g.user_id IS NOT NULL OR m.user_id = ?)`)
      .bind(row.id, row.workspace_id, row.owner_id).all();
    const ownerRole = rows.find(g => g.user_id === row.owner_id)?.role;
    const result = rows.filter((g): g is typeof g & { permissions_json: string } => g.permissions_json !== null);
    const effective = (grant: { permissions_json: string; role: WorkspaceRole }) => {
      const ceiling = roleSessionCeiling(grant.role);
      return normalizePermissions(JSON.parse(grant.permissions_json)).filter(permission => !ceiling || ceiling.includes(permission));
    };
    return c.json({ grants: [{ userId: row.owner_id, permissions: [...permissions], ...(ownerRole ? { workspaceRole: ownerRole } : {}), sessionRole: sessionRoleOf(permissions) }, ...result.filter(g => g.user_id !== row.owner_id)
      .map(g => { const held = effective(g); return { userId: g.user_id, permissions: held, workspaceRole: g.role, sessionRole: sessionRoleOf(held) }; })] });
  });
  app.post('/api/sessions/:id/grants', async c => {
    const access = await requireSession(c, identifier(c.req.param('id')), 'manage');
    const { row } = access;
    const input = await jsonObject(c);
    const userId = userIdentifier(input.userId);
    if (userId === row.owner_id) fail(400, 'owner_grant_immutable', 'The session owner always retains full authority.');
    const grantee = await requireMember(c.env, row.workspace_id, userId);
    if ((input.role === undefined) === (input.permissions === undefined)) fail(400, 'invalid_grant', 'Give either a session role or permissions.');
    let grants: Permission[];
    if (input.role !== undefined) {
      if (typeof input.role !== 'string' || !(sessionRoles as readonly string[]).includes(input.role)) fail(400, 'invalid_session_role', 'Invalid session role.');
      grants = [...sessionRolePermissions[input.role as SessionRole]];
    } else {
      try { grants = normalizePermissions(input.permissions); } catch { fail(400, 'invalid_permissions', 'Invalid permissions.'); }
    }
    const ceiling = roleSessionCeiling(grantee.role);
    if (ceiling && grants.some(permission => !ceiling.includes(permission))) fail(400, 'viewer_role', 'Viewers can only be granted read access.');
    if (!grants.length) fail(400, 'empty_grant', 'Use DELETE to revoke a grant.');
    if (grants.some(permission => !hasPermission(access.permissions, permission))) fail(403, 'grant_escalation', 'You cannot grant permissions you do not hold.');
    const result = await c.env.DB.batch([
      c.env.DB.query(`INSERT INTO session_grants (session_id, user_id, permissions_json, created_at)
        SELECT ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM sessions WHERE id = ? AND policy_version = ?)
          AND EXISTS (SELECT 1 FROM workspace_members WHERE workspace_id = ? AND user_id = ?)
        ON CONFLICT(session_id, user_id) DO UPDATE SET permissions_json = excluded.permissions_json`)
        .bind(row.id, userId, JSON.stringify(grants), now(), row.id, row.policy_version, row.workspace_id, userId),
      c.env.DB.query('UPDATE sessions SET policy_version = policy_version + 1 WHERE id = ? AND policy_version = ?').bind(row.id, row.policy_version),
      auditStatement(c.env, c.get('auth').userId, 'grant.updated', row.workspace_id, row.id, { userId, permissions: grants }),
    ]);
    if (!result[0].changes) fail(409, 'policy_changed', 'Session membership or permissions changed; reload and retry.');
    return c.json({ grant: { userId, permissions: grants, workspaceRole: grantee.role, sessionRole: sessionRoleOf(grants) } });
  });
  app.delete('/api/sessions/:id/grants/:userId', async c => {
    const { row } = await requireSession(c, identifier(c.req.param('id')), 'manage');
    const userId = userIdentifier(c.req.param('userId'));
    if (userId === row.owner_id) fail(400, 'owner_grant_immutable', 'The session owner cannot be revoked.');
    const results = await c.env.DB.batch([
      c.env.DB.query('DELETE FROM session_grants WHERE session_id = ? AND user_id = ? AND EXISTS (SELECT 1 FROM sessions WHERE id = ? AND policy_version = ?)')
        .bind(row.id, userId, row.id, row.policy_version),
      c.env.DB.query('UPDATE sessions SET policy_version = policy_version + 1 WHERE id = ? AND policy_version = ?').bind(row.id, row.policy_version),
      auditStatement(c.env, c.get('auth').userId, 'grant.revoked', row.workspace_id, row.id, { userId }),
    ]);
    if (!results[1].changes) fail(409, 'policy_changed', 'Session permissions changed; reload and retry.');
    return c.json({ ok: true });
  });

  app.post('/api/sessions/:id/stop', async c => {
    const { row } = await requireSession(c, identifier(c.req.param('id')), 'write');
    return c.json({ stopped: await stopSession(c, row) });
  });

  app.post('/api/sessions/:id/withdraw', async c => {
    const { row } = await requireSession(c, identifier(c.req.param('id')), 'ask');
    const input = await jsonObject(c, 4096);
    if (Object.keys(input).some(key => key !== 'submissionId') || typeof input.submissionId !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(input.submissionId)) {
      fail(400, 'invalid_input', 'submissionId names one queued message.');
    }
    const result = await runnerJSON<WithdrawResult>(await runnerRequest(c, row, 'withdraw', '', { submissionId: input.submissionId }));
    invalidateSessionView(c, row.id);
    if (typeof result?.content !== 'string' || (result.mode !== 'write' && result.mode !== 'ask')
      || (result.images !== undefined && 'error' in parseChatImages(result.images)) || (result.imagesLost !== undefined && result.imagesLost !== true)) {
      fail(502, 'invalid_runner_response', 'The runner returned an invalid withdrawal result.');
    }
    await auditStatement(c.env, c.get('auth').userId, 'session.withdrawn', row.workspace_id, row.id, { submissionId: input.submissionId }).run();
    return c.json({ content: result.content, mode: result.mode, ...(result.images?.length ? { images: result.images } : {}), ...(result.imagesLost ? { imagesLost: true } : {}) });
  });

  app.post('/api/sessions/:id/revert', async c => {
    const { row } = await requireSession(c, identifier(c.req.param('id')), 'write');
    const entryId = messageEntry(await jsonObject(c, 4096));
    const result = await runnerJSON<{ conversationId: string }>(await runnerRequest(c, row, 'revert', '', { entryId }), 65536);
    invalidateSessionView(c, row.id);
    if (typeof result?.conversationId !== 'string') fail(502, 'invalid_runner_response', 'The runner returned an invalid revert result.');
    await auditStatement(c.env, c.get('auth').userId, 'session.reverted', row.workspace_id, row.id, { entryId }).run();
    return c.json({ conversationId: result.conversationId });
  });

  app.post('/api/sessions/:id/fork', async c => {
    const { row } = await requireSession(c, identifier(c.req.param('id')), 'write');
    const input = await jsonObject(c, 4096);
    if (Object.keys(input).some(key => key !== 'entryId' && key !== 'title')) fail(400, 'invalid_input', 'A fork accepts only entryId and title.');
    const title = input.title === undefined ? undefined : text(input.title, 'title', 200);
    const { row: forked } = await forkSession(c, row, messageEntry({ entryId: input.entryId }), title);
    return c.json({ session: sessionRecord(forked, [...permissions]) }, 201);
  });

  app.post('/api/sessions/:id/restart', async c => {
    const { row } = await requireSession(c, identifier(c.req.param('id')), 'manage');
    if (row.owner_id !== c.get('auth').userId) fail(403, 'owner_required', 'Only the session owner can restart it.');
    const result = row.status === 'error' || row.status === 'provisioning'
      ? await runnerRequest(c, row, 'create', '', await bindingForSession(c, row))
      : await runnerRequest(c, row, 'restart', '', {});
    invalidateSessionView(c, row.id);
    await result.body?.cancel();
    await c.env.DB.batch([
      c.env.DB.query('UPDATE sessions SET status = ? WHERE id = ?').bind('ready', row.id),
      auditStatement(c.env, c.get('auth').userId, 'session.restarted', row.workspace_id, row.id),
    ]);
    return c.json({ ok: true, sessionId: row.id });
  });

  app.get('/api/sessions/:id/audit', async c => {
    const { row } = await requireSession(c, identifier(c.req.param('id')), 'read');
    const rows = await c.env.DB.query<{ id: string; actor_id: string; action: string; detail_json: string; created_at: string }>('SELECT id, actor_id, action, detail_json, created_at FROM audit WHERE session_id = ? ORDER BY created_at DESC, id DESC LIMIT 200')
      .bind(row.id).all();
    return c.json({ events: rows.map(event => ({ id: event.id, actorId: event.actor_id, action: event.action, detail: JSON.parse(event.detail_json), createdAt: event.created_at })) });
  });
}
