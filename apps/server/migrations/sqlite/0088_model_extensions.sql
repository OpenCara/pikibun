-- Models a host's extensions provide (docs/design/extension-models.md, #147). connector_configs.model_extensions_json is
-- the host owner's list (HostConfig.modelExtensions): the installed npm: and git: sources whose provider registrations
-- the host's connector applies to its models.
ALTER TABLE connector_configs ADD COLUMN model_extensions_json TEXT NOT NULL DEFAULT '[]';
