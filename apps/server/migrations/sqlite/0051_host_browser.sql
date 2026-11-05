-- Where the browser tool's Chromium comes from on a host (HostConfig.browser in packages/shared/src/host-config.ts, and
-- HostBrowserConfig in packages/shared/src/browser.ts): found on the host, at a path its owner gives, downloaded by its
-- connector, or none, as JSON. '{"source":"auto"}' looks for one.
ALTER TABLE connector_configs ADD COLUMN browser_json TEXT NOT NULL DEFAULT '{"source":"auto"}';
