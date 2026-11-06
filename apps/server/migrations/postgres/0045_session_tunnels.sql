-- Postgres translation of sqlite/0052_session_tunnels.sql.

-- Session services and tunnels (piki:tunnel; docs/design/tunnel.md).
-- The longest a session service runs on a host (HostConfig.serviceLifetimeSeconds in packages/shared/src/host-config.ts),
-- 4 hours by default, and where its cloudflared comes from (HostConfig.tunnel, HostTunnelConfig in
-- packages/shared/src/tunnel.ts), as JSON: '{"source":"auto"}' looks for one.
ALTER TABLE connector_configs ADD COLUMN service_lifetime_seconds INTEGER NOT NULL DEFAULT 14400;
ALTER TABLE connector_configs ADD COLUMN tunnel_json TEXT NOT NULL DEFAULT '{"source":"auto"}';
-- A session that is online through its tunnel, as its host last reported it (SessionRecord.tunnel): its address, and
-- when its service lifetime ends, after which the session list no longer shows it whatever its host said. Display state.
ALTER TABLE sessions ADD COLUMN tunnel_url TEXT;
ALTER TABLE sessions ADD COLUMN tunnel_expires_at TEXT;
