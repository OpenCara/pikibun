import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { z } from 'zod';
import { hasPermission } from '../../../packages/shared/src/policy.js';
import { sessionToolExtensionOn } from '../../../packages/shared/src/piki-extensions.js';
import { extensionPackageKey, normalizeExtensionSource, type WorkspaceExtension } from '../../../packages/shared/src/host-extensions.js';
import { gitProviders, type GitProvider, type WorkspaceRepository } from '../../../packages/shared/src/repositories.js';
import { networkModes, type NetworkMode, type NetworkPolicy } from '../../../packages/shared/src/network.js';
import { assignableWorkspaceRoles, type Workspace } from '../../../packages/shared/src/types.js';
import {
  isWorkspaceWriteAction, workspaceActionFields, workspaceToolActions, workspaceToolLimits, workspaceToolParameters,
  type WorkspaceToolAction, type WorkspaceToolParameter,
} from '../../../packages/shared/src/workspace-management.js';
import {
  admissionExpired, auditStatement, githubRepositoryIdentity, registerNetworkPolicies, registerRepositories, registerSources, requireCallbackScope,
  requireToolCall, sessionAccess, workspaceExtensions,
} from './authority/index.js';
import { registerCatalog } from './catalog.js';
import { registerExtensions } from './extensions.js';
import { registerToolGroups } from './tool-groups.js';
import { registerWorkspaceInvites } from './workspace-invites.js';
import { fail, identifier } from './http.js';
import { errorText, serverLog } from './log.js';
import { body, fields as requestShape, identifier as identifierField, text, userIdentifier as userField } from './schemas.js';
import type { AppContext, AppEnv, Env, SessionRow } from './types.js';

type AdmissionRow = { id: string; session_id: string; actor_id: string; mode: string; access: string | null; expires_at: number };

type Fields = Partial<Record<Exclude<WorkspaceToolParameter, 'action' | 'enabled'>, string>> & { enabled?: boolean };

const INTERNAL_ORIGIN = 'http://workspace-tool.pikibun.internal';

const line = (field: string, max: number) => text(field, max).transform(value => value.trim())
  .refine(value => value !== '' && !/[\x00-\x1f\x7f]/.test(value), `${field} is one line.`).optional();
const choice = <T extends readonly [string, ...string[]]>(field: string, values: T) => z.enum(values, { error: `${field} is one of ${values.join(', ')}.` }).optional();

const workspaceToolRequest = requestShape({
  sessionId: identifierField('sessionId'), actorId: userField('actorId'), admissionId: text('admissionId', 128), callId: identifierField('callId'),
  action: z.enum(workspaceToolActions, { error: `action is one of ${workspaceToolActions.join(', ')}.` }),
  user: userField('user').optional(), role: choice('role', assignableWorkspaceRoles), name: line('name', 200), repository: line('repository', 512),
  repository_id: line('repository_id', 256), provider: choice('provider', gitProviders), host: line('host', 253), ref: line('ref', 255),
  extension: line('extension', 512), enabled: z.boolean({ error: 'enabled is true or false.' }).optional(), settings: text('settings', workspaceToolLimits.settingsChars).optional(),
  group: identifierField('group').optional(), domain: line('domain', 253), mode: choice('mode', networkModes),
}, 'Unexpected workspace tool field.', { required: ['sessionId', 'actorId', 'admissionId', 'callId', 'action'] });

async function asSender<T = Record<string, unknown>>(env: Env, actorId: string, method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', path: string, body?: unknown): Promise<T> {
  const app = new Hono<AppEnv>();
  app.use('*', async (c, next) => {
    c.set('auth', { userId: actorId, tokenHash: 'workspace-tool', csrfToken: '', client: 'native' });
    await next();
  });
  registerCatalog(app);
  registerWorkspaceInvites(app);
  registerRepositories(app);
  registerSources(app);
  registerExtensions(app);
  registerToolGroups(app);
  registerNetworkPolicies(app);
  app.all('*', () => fail(404, 'not_found', 'API route not found.'));
  app.onError((error, c) => error instanceof HTTPException ? error.getResponse()
    : c.json({ error: 'The request could not be completed.', code: 'internal_error' }, 500));
  const response = await app.request(`${INTERNAL_ORIGIN}${path}`, {
    method, ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
  }, env);
  const value: unknown = response.status === 204 ? {} : await response.json().catch(() => ({}));
  if (!response.ok) {
    const record = value && typeof value === 'object' ? value as Record<string, unknown> : {};
    fail(response.status as ContentfulStatusCode, typeof record.code === 'string' ? record.code : 'workspace_tool_failed',
      typeof record.error === 'string' ? record.error : 'The workspace refused that change.');
  }
  return value as T;
}

function actionFields(input: z.output<typeof workspaceToolRequest>): Fields {
  const { action } = input;
  const spec = workspaceActionFields[action];
  const given = workspaceToolParameters.filter(name => name !== 'action' && input[name] !== undefined);
  const unexpected = given.find(name => !spec.required.includes(name) && !spec.optional?.includes(name));
  if (unexpected) fail(400, 'invalid_input', `${action} takes no ${unexpected}${spec.required.length || spec.optional?.length
    ? `: it takes ${[...spec.required, ...(spec.optional ?? []).map(name => `${name}?`)].join(', ')}` : ''}.`);
  const missing = spec.required.find(name => input[name] === undefined);
  if (missing) fail(400, 'invalid_input', `${action} takes ${missing}.`);
  return Object.fromEntries(given.map(name => [name, input[name]])) as Fields;
}

function settingsInput(value: string): Record<string, unknown> {
  let parsed: unknown;
  try { parsed = JSON.parse(value); } catch { fail(400, 'invalid_input', 'settings is a JSON object, such as {"review-minutes": "30"}.'); }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) fail(400, 'invalid_input', 'settings is a JSON object, such as {"review-minutes": "30"}.');
  return parsed as Record<string, unknown>;
}

function extensionKey(source: string): string {
  try { return extensionPackageKey(normalizeExtensionSource(source)); }
  catch (error) { return fail(400, 'invalid_extension', error instanceof Error ? error.message : 'Name the extension by its source, such as piki:node or npm:<package>@<version>.'); }
}

async function run(env: Env, row: SessionRow, actorId: string, action: WorkspaceToolAction, input: Fields): Promise<Record<string, unknown>> {
  const workspace = `/api/workspaces/${encodeURIComponent(row.workspace_id)}`;
  const member = (user: string) => `${workspace}/members/${encodeURIComponent(user)}`;
  const call = <T = Record<string, unknown>>(method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', path: string, body?: unknown) => asSender<T>(env, actorId, method, path, body);
  switch (action) {
    case 'get': {
      const { workspaces } = await call<{ workspaces: Workspace[] }>('GET', '/api/workspaces');
      const found = workspaces.find(item => item.id === row.workspace_id);
      if (!found) fail(404, 'not_found', 'Workspace not found.');
      return { workspace: found };
    }
    case 'members': return call('GET', `${workspace}/members`);
    case 'repositories': return call('GET', `${workspace}/repositories`);
    case 'sources': return call('GET', `${workspace}/sources`);
    case 'tool_groups': return call('GET', `${workspace}/tool-groups`);
    case 'network': return call('GET', `${workspace}/network-policy`);
    case 'join_requests': return call('GET', `${workspace}/join-requests`);
    case 'extensions': {
      const listed = await call<{ extensions: WorkspaceExtension[]; admin: boolean; hosts: { id: string; name: string; ownerName: string; availability?: Record<string, unknown> }[] }>(
        'GET', `${workspace}/extensions`);
      return { extensions: listed.extensions, admin: listed.admin,
        hosts: listed.hosts.slice(0, workspaceToolLimits.listed).map(host => ({ id: host.id, name: host.name, ownerName: host.ownerName,
          ...(host.availability ? { availability: host.availability } : {}) })) };
    }
    case 'rename': return call('PATCH', workspace, { name: input.name });
    case 'add_member': return call('POST', `${workspace}/members`, { userId: input.user, role: input.role });
    case 'set_role': return call('PATCH', member(input.user!), { role: input.role });
    case 'remove_member': {
      await call('DELETE', member(input.user!));
      return { removed: input.user };
    }
    case 'accept_join_request': return call('POST', `${workspace}/join-requests/${encodeURIComponent(input.user!)}/accept`, { role: input.role ?? 'member' });
    case 'decline_join_request': return call('DELETE', `${workspace}/join-requests/${encodeURIComponent(input.user!)}`);
    case 'set_tool_group': return call('PUT', `${member(input.user!)}/tool-group`, { groupId: input.group === 'role' ? null : input.group });
    case 'add_repository': {
      const provider = (input.provider ?? 'github') as GitProvider;
      let repositoryId = input.repository_id;
      if (repositoryId === undefined) {
        if (provider !== 'github') fail(400, 'invalid_input', 'For a repository outside GitHub, give its repository_id as the provider shows it.');
        repositoryId = await githubRepositoryIdentity(env, actorId, input.repository!);
      }
      return call('POST', `${workspace}/repositories`, { provider, ...(input.host ? { host: input.host } : {}), repositoryId, fullName: input.repository,
        ...(input.ref ? { ref: input.ref } : {}) }) ;
    }
    case 'remove_repository': {
      const { repositories } = await call<{ repositories: WorkspaceRepository[] }>('GET', `${workspace}/repositories`);
      const wanted = input.repository!;
      const matches = repositories.filter(item => item.id === wanted || item.fullName.toLowerCase() === wanted.toLowerCase());
      if (!matches.length) fail(404, 'not_found', 'This workspace has no such repository: name it by its id or owner/name, as repositories lists it.');
      if (matches.length > 1) fail(409, 'ambiguous_repository', 'More than one repository has that name: name it by its id, as repositories lists it.');
      const found = matches[0]!;
      await call('DELETE', `${workspace}/repositories/${encodeURIComponent(identifier(found.id, 'repository'))}`);
      return { removed: { id: found.id, provider: found.provider, host: found.host, fullName: found.fullName } };
    }
    case 'set_extension': {
      const key = extensionKey(input.extension!);
      const { extensions } = await call<{ extensions: WorkspaceExtension[] }>('GET', `${workspace}/extensions`);
      const current = extensions.find(item => extensionPackageKey(item.source) === key);
      const extension = { source: input.extension, enabled: input.enabled ?? current?.enabled ?? true, tools: current?.tools ?? 'automatic',
        settings: input.settings !== undefined ? settingsInput(input.settings) : current?.settings ?? {} };
      const saved = await call<{ extensions: WorkspaceExtension[] }>('PUT', `${workspace}/extensions`, extension);
      return { extension: saved.extensions.find(item => extensionPackageKey(item.source) === key) ?? null, ...(current ? {} : { added: true }) };
    }
    case 'remove_extension': {
      const key = extensionKey(input.extension!);
      await call('DELETE', `${workspace}/extensions?source=${encodeURIComponent(input.extension!)}`);
      return { removed: key };
    }
    case 'set_network_mode':
    case 'allow_domain':
    case 'disallow_domain': {
      const { policy } = await call<{ policy: NetworkPolicy }>('GET', `${workspace}/network-policy`);
      const domain = input.domain?.toLowerCase();
      let next: NetworkPolicy = policy;
      if (action === 'set_network_mode') next = { ...policy, mode: input.mode as NetworkMode };
      else if (action === 'allow_domain') {
        if (policy.domains.includes(domain!)) return { policy, unchanged: true };
        next = { ...policy, domains: [...policy.domains, domain!] };
      } else {
        if (!policy.domains.includes(domain!)) fail(404, 'not_found', 'That domain isn\'t on the workspace\'s list.');
        next = { ...policy, domains: policy.domains.filter(item => item !== domain) };
      }
      const saved = await call<{ policy: NetworkPolicy }>('PUT', `${workspace}/network-policy`, next);
      return { policy: saved.policy, ...(saved.policy.mode !== 'allowlist' && action !== 'set_network_mode'
        ? { note: `The workspace's network access is ${saved.policy.mode}: its list of domains matters in allowlist mode.` } : {}) };
    }
  }
}

export async function agentWorkspace(c: AppContext, connectorId: string | null): Promise<Response> {
  const input = await body(c, workspaceToolRequest, { maxBytes: 64 * 1024 });
  const { sessionId, actorId, admissionId, callId, action } = input;
  const given = actionFields(input);
  const write = isWorkspaceWriteAction(action);

  const authorize = async (): Promise<SessionRow> => {
    const access = await sessionAccess(c.env, sessionId, actorId);
    if (!access || access.row.status === 'archived' || !hasPermission(access.permissions, 'write')) {
      fail(403, 'permission_revoked', 'The requester can no longer write to this session.');
    }
    await requireCallbackScope(c, access.row, connectorId);
    const admission = await c.env.DB.query<AdmissionRow>('SELECT id, session_id, actor_id, mode, access, expires_at FROM run_admissions WHERE id = ?')
      .bind(admissionId).first();
    if (!admission || admission.session_id !== sessionId || admission.actor_id !== actorId || admission.mode !== 'write'
      || await admissionExpired(c.env, admissionId, admission)) {
      fail(403, 'workspace_not_admitted', 'The workspace tool needs a write message from the requester sent within the last hour, or whose run is still going.');
    }
    await requireToolCall(c.env, access.row, actorId, 'workspace');
    if (!sessionToolExtensionOn(await workspaceExtensions(c.env, access.row.workspace_id), 'piki:workspace')) {
      fail(403, 'workspace_tool_off', 'The workspace tool is turned off in this workspace (piki:workspace). Its owners and admins add it under Settings → Workspaces → Extensions.');
    }
    if (write && admission.access === 'read') fail(403, 'write_not_allowed', 'A Read-only message changes nothing in the workspace: ask in a message that may act.');
    return access.row;
  };
  const row = await authorize();
  const result = await run(c.env, row, actorId, action, given);
  if (write) {
    const target = Object.fromEntries((['user', 'role', 'name', 'repository', 'repository_id', 'provider', 'host', 'ref', 'extension', 'enabled', 'group', 'domain', 'mode'] as const)
      .filter(name => given[name] !== undefined).map(name => [name, given[name]]));
    try {
      await auditStatement(c.env, actorId, 'session.workspace_tool.changed', row.workspace_id, row.id, { action, callId, ...target }).run();
    } catch (error) {
      serverLog(c.env)(`workspace tool: ${action} in session ${row.id} was applied, but its session audit entry failed: ${errorText(error)}`);
    }
  }
  return c.json({ action, ...result });
}
