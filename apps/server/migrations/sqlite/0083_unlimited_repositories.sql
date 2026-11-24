-- A workspace binds any number of repositories: the five-binding cap goes. The binding route no longer counts them
-- either; uniqueness per provider and host, immutability and the workspace source stay as they were.
DROP TRIGGER IF EXISTS workspace_repositories_limit;
