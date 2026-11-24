-- Postgres translation of sqlite/0083_unlimited_repositories.sql.

-- A workspace binds any number of repositories: the five-binding cap goes. The binding route no longer counts them
-- either; uniqueness per provider and host, immutability and the workspace source stay as they were.
DROP TRIGGER IF EXISTS workspace_repositories_limit ON workspace_repositories;
DROP FUNCTION IF EXISTS workspace_repositories_limit();
