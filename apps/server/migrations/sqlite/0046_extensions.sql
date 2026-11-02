-- Extensions (docs/design/host-extensions.md, apps/server/src/extensions.ts).
-- The Pi extensions a workspace's sessions use, one version of each package, in order; its owners and admins choose them.
-- package_key is npm:<name> or git:<url>; source pins the version (npm:<name>@<version>, git:<url>@<commit>).
CREATE TABLE workspace_extensions (
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  package_key TEXT NOT NULL,
  source TEXT NOT NULL,
  position INTEGER NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  tools_mode TEXT NOT NULL DEFAULT 'approval' CHECK (tools_mode IN ('approval', 'automatic')),
  settings_json TEXT NOT NULL DEFAULT '{}',
  updated_by TEXT NOT NULL REFERENCES users(id),
  updated_at TEXT NOT NULL,
  PRIMARY KEY (workspace_id, package_key)
);
-- What each host last reported it has installed (HostExtensionsReport), on each sync of its connector.
CREATE TABLE connector_extensions (
  connector_id TEXT PRIMARY KEY REFERENCES connectors(id) ON DELETE CASCADE,
  report_json TEXT NOT NULL,
  reported_at TEXT NOT NULL
);
-- The host owner's own extension settings; no row: the defaults. automatic_tools 1 lets workspaces run extension tools
-- without approval on this host, where they set an extension's tools to automatic.
CREATE TABLE connector_extension_settings (
  connector_id TEXT PRIMARY KEY REFERENCES connectors(id) ON DELETE CASCADE,
  automatic_tools INTEGER NOT NULL DEFAULT 0 CHECK (automatic_tools IN (0, 1)),
  updated_by TEXT NOT NULL REFERENCES users(id),
  updated_at TEXT NOT NULL
);
-- Installs and removals the host's owner asked for in Pikibun; its connector carries them out when it next syncs and
-- reports how they went.
CREATE TABLE connector_extension_requests (
  id TEXT PRIMARY KEY,
  connector_id TEXT NOT NULL REFERENCES connectors(id) ON DELETE CASCADE,
  action TEXT NOT NULL CHECK (action IN ('install', 'remove')),
  source TEXT NOT NULL,
  requested_by TEXT NOT NULL REFERENCES users(id),
  requested_at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'done', 'failed')),
  error TEXT,
  finished_at TEXT
);
CREATE INDEX connector_extension_requests_pending ON connector_extension_requests (connector_id, status, requested_at);
-- Another member's extension tool call a host said ran automatically, which the control plane couldn't confirm the first
-- time it saw it (the workspace didn't run that extension's tools automatically on that host): shown as a plain record,
-- never reviewed, even once the setting allows it.
CREATE TABLE approval_unconfirmed_automatic (
  session_id TEXT NOT NULL REFERENCES sessions(id),
  approval_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (session_id, approval_id)
);
