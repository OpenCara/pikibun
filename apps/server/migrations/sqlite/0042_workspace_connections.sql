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
  -- Git: the provider's host and Azure DevOps organization; empty for documents.
  host TEXT NOT NULL DEFAULT '' CHECK (length(host) <= 253 AND (family = 'document') = (host = '')),
  organization TEXT NOT NULL DEFAULT '' CHECK (length(organization) <= 50),
  username TEXT CHECK (username IS NULL OR length(username) BETWEEN 1 AND 254),
  -- The account the provider named when the credential was verified, as members see it.
  name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 200),
  ciphertext TEXT NOT NULL CHECK (length(ciphertext) <= 22000),
  created_by TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (workspace_id, family, provider, host, organization)
);
CREATE TRIGGER workspace_connections_limit BEFORE INSERT ON workspace_connections
WHEN (SELECT COUNT(*) FROM workspace_connections WHERE workspace_id = NEW.workspace_id) >= 20 BEGIN
  SELECT RAISE(ABORT, 'workspace connection limit reached');
END;

-- Which identity a source is read with: 'members' (each session's owner's own account, the default when there is no
-- row) or 'workspace' (the workspace's connection for its provider). Sources are immutable, so this lives beside them,
-- like a repository's push policy and Git LFS switch.
CREATE TABLE source_read_settings (
  source_id TEXT PRIMARY KEY NOT NULL REFERENCES workspace_sources(id) ON DELETE CASCADE,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  read_as TEXT NOT NULL CHECK (read_as IN ('members', 'workspace')),
  updated_by TEXT NOT NULL REFERENCES users(id),
  updated_at TEXT NOT NULL
);
CREATE TRIGGER source_read_settings_workspace BEFORE INSERT ON source_read_settings
WHEN NOT EXISTS (SELECT 1 FROM workspace_sources WHERE id = NEW.source_id AND workspace_id = NEW.workspace_id) BEGIN
  SELECT RAISE(ABORT, 'a read setting needs a source of its workspace');
END;
