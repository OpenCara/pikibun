-- Whether an LLM audits messages from anyone but a host's owner before they reach its sessions' agents, as its owner sets
-- it in Pikibun (HostConfig.promptAudit in packages/shared/src/host-config.ts): on or off, the model that audits and the
-- owner's own policy, as JSON. Off by default.
ALTER TABLE connector_configs ADD COLUMN prompt_audit_json TEXT NOT NULL DEFAULT '{"enabled":false}';
