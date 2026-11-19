-- Phase 2 of docs/design/extension-planes.md (#438): sandboxed hosts auto-cache locked npm: workspace extensions by default.
-- auto_cache = 1 turns it on for this host whatever its connector defaults to; auto_cache_off = 1 turns it off;
-- neither follows the host's own default, which its connector reports. The route never sets both.
ALTER TABLE connector_extension_settings ADD COLUMN auto_cache_off INTEGER NOT NULL DEFAULT 0 CHECK (auto_cache_off IN (0, 1));
