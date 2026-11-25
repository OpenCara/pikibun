-- Files a host shares with extensions (docs/design/extension-files.md). connector_configs.extension_files_json is the host
-- owner's list (HostConfig.extensionFiles): host files, each with the npm: or git: package it goes to and its place in the
-- session's home, which the connector binds read-only into that extension's process in a sandboxed session.
ALTER TABLE connector_configs ADD COLUMN extension_files_json TEXT NOT NULL DEFAULT '[]';
