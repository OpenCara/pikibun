-- Postgres translation of sqlite/0089_host_cache_warming.sql.

-- Prompt cache warming's host switch (docs/design/cache-warming.md, finding 65 of #479). connector_configs.cache_warming is
-- the host owner's setting (HostConfig.cacheWarming): 0 keeps every session on the host from warming its prompt cache,
-- whatever its workspace chooses, as warming spends the host owner's model account; 1, the default, leaves it to the
-- workspace's setting.
ALTER TABLE connector_configs ADD COLUMN cache_warming BIGINT NOT NULL DEFAULT 1 CHECK (cache_warming IN (0, 1));
