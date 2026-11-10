import { constantTimeEqual, sha256 } from '../../../../packages/shared/src/crypto.js';
import { parseCapabilities, type ConnectorCapabilities } from '../../../../packages/shared/src/connector.js';
import type { AppContext, Env, SessionRow } from '../types.js';
import { appOrigin, fail, localMode, localOwnerQuery, loopbackHttp, testMode } from '../http.js';

export interface ConnectorRow {
  id: string; owner_id: string; name: string; credential_hash: string; revoked_at: string | null;
  created_at: string; last_seen_at: string | null; connection_hash: string | null;
  models_json: string; capabilities_json: string; removed_at: string | null;
  connector_version?: string | null;
}

export async function hostCapabilities(env: Env, connectorId: string | null | undefined, options: { active?: boolean } = {}): Promise<ConnectorCapabilities | null> {
  if (!connectorId) return null;
  const host = await env.DB.query<{ capabilities_json: string }>(`SELECT capabilities_json FROM connectors WHERE id = ?${options.active ? ' AND revoked_at IS NULL' : ''}`)
    .bind(connectorId).first();
  return host ? parseCapabilities(host.capabilities_json) : null;
}

export function requireConnectorTLS(env: Env, url: URL): void {
  if (url.protocol !== 'https:' && !loopbackHttp(env, url)) {
    fail(400, 'secure_transport_required', 'Connector credentials require HTTPS.');
  }
}

export async function authenticateConnector(c: AppContext, currentConnection = true): Promise<ConnectorRow> {
  requireConnectorTLS(c.env, new URL(c.req.url));
  const authorization = c.req.header('authorization');
  if (!authorization || !/^Bearer [A-Za-z0-9_-]{43}$/.test(authorization)) fail(401, 'connector_authentication_required', 'Connector authentication is required.');
  return authenticateConnectorToken(c.env, authorization.slice(7), currentConnection ? c.req.header('x-connection-token') : undefined, currentConnection);
}
export async function authenticateConnectorToken(env: Env, token: string, connectionToken?: string, currentConnection = false): Promise<ConnectorRow> {
  if (!/^[A-Za-z0-9_-]{43}$/.test(token)) fail(401, 'connector_authentication_required', 'Connector authentication is required.');
  const row = await env.DB.query<ConnectorRow>(`SELECT c.* FROM connectors c JOIN users u ON u.id = c.owner_id
    WHERE c.credential_hash = ? AND c.revoked_at IS NULL AND u.suspended_at IS NULL AND (? = 1 OR u.auth_kind <> 'test')`)
    .bind(await sha256(token), testMode(env) ? 1 : 0).first();
  if (!row) fail(401, 'connector_authentication_required', 'Connector authentication is required.');
  if (localMode(env) && !(testMode(env) && row.owner_id.startsWith('test:'))) {
    const owner = localOwnerQuery(env);
    const found = await env.DB.query<{ id: string }>(owner.sql).bind(...owner.params).first();
    if (found?.id !== row.owner_id) fail(401, 'connector_authentication_required', 'Connector authentication is required.');
  }
  if (currentConnection && (!connectionToken || !/^[A-Za-z0-9_-]{43}$/.test(connectionToken) || !row.connection_hash || !constantTimeEqual(await sha256(connectionToken), row.connection_hash))) {
    fail(401, 'stale_connection', 'A current connector connection is required.');
  }
  return row;
}

export async function authenticateConnectorSocket(env: Env, headers: Headers, url: URL): Promise<{ connectorId: string; credentialHash: string }> {
  requireConnectorTLS(env, url);
  const origin = headers.get('origin');
  if (origin && origin !== appOrigin(env)) fail(403, 'invalid_origin', 'Request origin is not allowed.');
  const site = headers.get('sec-fetch-site');
  if (site && site !== 'same-origin' && site !== 'none') fail(403, 'invalid_origin', 'Cross-site requests are not allowed.');
  if (headers.get('cookie')) fail(401, 'connector_authentication_required', 'Use connector credentials, not a browser session.');
  const protocols = (headers.get('sec-websocket-protocol') ?? '').split(',').map(item => item.trim());
  if (protocols.length !== 2 || !protocols.includes('opencara-pi-v1')) fail(401, 'connector_authentication_required', 'Connector authentication is required.');
  const credential = protocols.find(item => item.startsWith('bearer.'))?.slice(7) ?? '';
  const row = await authenticateConnectorToken(env, credential);
  appOrigin(env);
  if (!env.CONNECTOR_HUB) fail(503, 'connector_unavailable', 'Connector relay is not configured.');
  return { connectorId: row.id, credentialHash: row.credential_hash };
}

export async function requireConnectorSession(env: Env, connectorId: string, row: SessionRow, expectedConnectionHash?: string): Promise<void> {
  if (row.connector_id !== connectorId || !row.connector_owner_id) fail(403, 'connector_binding_mismatch', 'Connector does not own this route.');
  const allowed = await env.DB.query(`SELECT c.id FROM connectors c
    JOIN connector_workspaces cw ON cw.connector_id = c.id AND cw.workspace_id = ?
    JOIN workspace_members host ON host.workspace_id = cw.workspace_id AND host.user_id = c.owner_id
    JOIN workspace_members owner ON owner.workspace_id = cw.workspace_id AND owner.user_id = ?
    JOIN users u ON u.id = c.owner_id
    JOIN users session_owner ON session_owner.id = owner.user_id
    JOIN agent_versions a ON a.id = ? JOIN models m ON m.id = a.model_id
    WHERE c.id = ? AND c.owner_id = ? AND c.revoked_at IS NULL AND u.suspended_at IS NULL AND session_owner.suspended_at IS NULL
      AND (c.owner_id = owner.user_id OR EXISTS (SELECT 1 FROM connector_shares sh
        WHERE sh.connector_id = c.id AND sh.workspace_id = cw.workspace_id))
      AND m.connector_id = c.id AND m.connector_owner_id = c.owner_id AND m.workspace_id = cw.workspace_id
      AND EXISTS (SELECT 1 FROM json_each(c.models_json) local_model
        WHERE json_extract(local_model.value, '$.provider') = m.provider AND json_extract(local_model.value, '$.modelId') = m.model_id)
      AND m.available = 1 AND (? = 1 OR (u.auth_kind <> 'test' AND m.provider <> 'faux'))
      AND (? IS NULL OR c.connection_hash = ?)
      AND NOT EXISTS (SELECT 1 FROM sessions current_session WHERE current_session.id = ? AND current_session.policy_version <> ?)`)
    .bind(row.workspace_id, row.owner_id, row.agent_version_id, connectorId, row.connector_owner_id, testMode(env) ? 1 : 0,
      expectedConnectionHash ?? null, expectedConnectionHash ?? null, row.id, row.policy_version).first();
  if (!allowed) fail(403, 'connector_unavailable', 'The connector or its workspace sharing is no longer authorized.');
}

export async function requireCallbackScope(c: AppContext, row: SessionRow, connectorId: string | null): Promise<void> {
  if (connectorId) {
    const connector = await authenticateConnector(c);
    if (connector.id !== connectorId) fail(403, 'connector_binding_mismatch', 'Connector scope changed.');
    await requireConnectorSession(c.env, connectorId, row, connector.connection_hash!);
  } else if (row.connector_id) fail(403, 'connector_scope_required', 'Use the connector-scoped callback.');
}
