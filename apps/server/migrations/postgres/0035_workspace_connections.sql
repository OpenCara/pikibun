-- Postgres translation of sqlite/0042_workspace_connections.sql.

-- Workspace connections: service credentials a workspace's owners and admins connect for the workspace itself (a GitLab
-- bot's token, a Git server's deploy user, a Notion integration, a Google service account), never a member's own
-- account. A source reads with one only where an owner or admin set it to (source_read_settings); otherwise every session
-- reads with its owner's own account, as before. Pushes and pull requests always use the session owner's account or the
-- workspace's push access. Secrets are vault-encrypted with 'workspace-connection:<id>' as AAD and never reach a host.
CREATE TABLE workspace_connections (
  id TEXT PRIMARY KEY NOT NULL,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  family TEXT NOT NULL CHECK (family IN ('git', 'document')),
  provider TEXT NOT NULL CHECK (
    (family = 'git' AND provider IN ('github-enterprise', 'gitlab', 'bitbucket', 'azure-devops', 'gitea', 'git')) OR
    (family = 'document' AND provider IN ('notion', 'google-drive', 'feishu'))),
  host TEXT NOT NULL DEFAULT '' CHECK (length(host) <= 253 AND (family = 'document') = (host = '')),
  organization TEXT NOT NULL DEFAULT '' CHECK (length(organization) <= 50),
  username TEXT CHECK (username IS NULL OR length(username) BETWEEN 1 AND 254),
  name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 200),
  ciphertext TEXT NOT NULL CHECK (length(ciphertext) <= 22000),
  created_by TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (workspace_id, family, provider, host, organization)
);
-- SQLite serializes writers; here the per-workspace advisory lock keeps the cap exact under concurrent inserts.
CREATE FUNCTION workspace_connections_limit() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('workspace_connections:' || NEW.workspace_id));
  IF (SELECT COUNT(*) FROM workspace_connections WHERE workspace_id = NEW.workspace_id) >= 20 THEN
    RAISE EXCEPTION 'workspace connection limit reached';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER workspace_connections_limit BEFORE INSERT ON workspace_connections
  FOR EACH ROW EXECUTE FUNCTION workspace_connections_limit();

CREATE TABLE source_read_settings (
  source_id TEXT PRIMARY KEY NOT NULL REFERENCES workspace_sources(id) ON DELETE CASCADE,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  read_as TEXT NOT NULL CHECK (read_as IN ('members', 'workspace')),
  updated_by TEXT NOT NULL REFERENCES users(id),
  updated_at TEXT NOT NULL
);
CREATE FUNCTION source_read_settings_workspace() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM workspace_sources WHERE id = NEW.source_id AND workspace_id = NEW.workspace_id) THEN
    RAISE EXCEPTION 'a read setting needs a source of its workspace';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER source_read_settings_workspace BEFORE INSERT ON source_read_settings
  FOR EACH ROW EXECUTE FUNCTION source_read_settings_workspace();
