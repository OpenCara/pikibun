-- Whether the session egress proxy on a host tunnels to a local proxy's fake-IP addresses (198.18.0.0/15) for any host
-- the network policy allows, not only those it names exactly (HostConfig.fakeIpTunnels in
-- packages/shared/src/host-config.ts; docs/design/egress.md). Only the host's owner turns it on. 0 keeps the default.
ALTER TABLE connector_configs ADD COLUMN fake_ip_tunnels INTEGER NOT NULL DEFAULT 0 CHECK (fake_ip_tunnels IN (0, 1));
