import type { Context } from 'hono';
import type { Permission, PushIdentityKind, SessionActivity, UserProfile, WorkspaceRole } from '../../../packages/shared/src/types';
import type { GitProvider, TokenGitProvider } from '../../../packages/shared/src/repositories';
import type { ConnectorHub } from './connector-hub-types.js';
import type { Database } from './db/types.js';
import type { ObjectStorage } from './storage/types.js';
import type { WorkspaceDatabaseProvider } from './workspace-databases/types.js';

export interface Env {
  DB: Database;
  CONNECTOR_HUB?: ConnectorHub;
  BUCKET?: ObjectStorage;
  WORKSPACE_DATABASES?: WorkspaceDatabaseProvider;
  LOG?: (line: string) => void;
  APP_ORIGIN: string;
  PIKIBUN_VERSION?: string;
  RUNNER_URL?: string;
  RUNNER_EVENT_TRANSPORT?: string;
  RUNNER_SHARED_SECRET?: string;
  SESSION_SECRET?: string;
  VAULT_KEY?: string;
  GITHUB_CLIENT_ID?: string;
  GITHUB_CLIENT_SECRET?: string;
  TEST_AUTH_ENABLED?: string;
  TEST_AUTH_SECRET?: string;
  TEST_AUTH_EXPIRES_AT?: string;
  GITHUB_APP_ID?: string;
  GITHUB_APP_SLUG?: string;
  GITHUB_APP_PRIVATE_KEY?: string;
  GIT_DIRECT?: string;
  SANDBOX_GITHUB_API?: string;
  OIDC_SIGNING_KEY?: string;
  ADMIN_USER_IDS?: string;
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  NOTION_CLIENT_ID?: string;
  NOTION_CLIENT_SECRET?: string;
  DROPBOX_CLIENT_ID?: string;
  DROPBOX_CLIENT_SECRET?: string;
  MICROSOFT_CLIENT_ID?: string;
  MICROSOFT_CLIENT_SECRET?: string;
  MICROSOFT_TENANT?: string;
  TENCENT_DOCS_CLIENT_ID?: string;
  TENCENT_DOCS_CLIENT_SECRET?: string;
  WEB_PUSH_CONTACT?: string;
  LOCAL_MODE?: string;
  LOCAL_CLAIM_SECRET?: string;
  LOCAL_OWNER_ID?: string;
  LOCAL_OWNER_NAME?: string;
  PASSWORD_AUTH?: string;
  SIGNUP?: string;
}
export interface AuthIdentity {
  userId: string;
  tokenHash: string;
  csrfToken: string;
  client: 'browser' | 'native';
}
export type AppEnv = { Bindings: Env; Variables: { auth: AuthIdentity } };
export type AppContext = Context<AppEnv>;
export interface UserRow {
  id: string;
  github_id: string | null;
  github_login: string | null;
  display_name: string;
  git_name: string;
  git_email: string;
  env_json: string;
  auth_kind: 'github' | 'test' | 'password';
  created_at: string;
  suspended_at?: string | null;
  username?: string | null;
  github_connected?: number;
  has_password?: number;
}
export interface WorkspaceRow { id: string; name: string; owner_id: string; created_at: string }
export interface MemberRow { workspace_id: string; user_id: string; role: WorkspaceRole; created_at: string }
export interface ModelRow {
  id: string; workspace_id: string; name: string; provider: string; model_id: string; created_at: string;
  connector_id?: string | null; connector_owner_id?: string | null; available?: number;
}
export interface AgentRow {
  id: string; agent_id: string; author_id: string; workspace_id: string | null; version: number;
  name: string; description: string; instructions: string; tools_json: string; model_id: string; created_at: string;
}
export interface SessionRow {
  id: string; workspace_id: string; owner_id: string; agent_version_id: string; title: string;
  policy_version: number; status: 'provisioning' | 'ready' | 'error' | 'archived'; created_at: string;
  connector_id?: string | null; connector_owner_id?: string | null;
  repositories_json?: string;
  repository_mode?: 'clone' | null;
  branch?: string | null;
  host_environment?: number | null;
  visibility?: 'private' | 'workspace';
  archived_status?: 'provisioning' | 'ready' | 'error' | null;
  packed_at?: string | null;
  pack_due_at?: string | null;
  activity?: SessionActivity | null;
  next_scheduled_at?: string | null;
  parent_session_id?: string | null;
  schedule_id?: string | null;
  one_shot?: number | string | null;
  tool_output?: 'full' | 'brief';
  tunnel_url?: string | null;
  tunnel_expires_at?: string | null;
  pull_request_url?: string | null;
  pull_request_state?: string | null;
  branch_pull_request_url?: string | null;
  branch_pull_request_state?: string | null;
}
export interface RepositoryRow {
  id: string; workspace_id: string; provider: GitProvider; host: string; repository_id: string; full_name: string;
  ref: string; private: number; created_at: string;
}
export interface GitCredentialRow {
  id: string; user_id: string; provider: TokenGitProvider; host: string; organization: string; username: string | null;
  login: string; ciphertext: string; created_at: string; updated_at: string;
}
export interface PushIdentityRow {
  id: string; workspace_id: string; provider: GitProvider; host: string; scope: string; kind: PushIdentityKind;
  config_json: string; secret_ciphertext: string | null; status: 'ready' | 'authorization_required'; lease_until: number | null;
  created_by: string; created_at: string; updated_at: string;
}
export interface PushCredentialRow {
  id: string; session_id: string; approval_id: string; requested_by: string; identity_id: string | null; kind: string;
  binding_id: string; operation_json: string; automatic: number; admission_id: string | null; revocation_ciphertext: string | null; expires_at: number;
  created_at: string; completed_at: string | null; outcome: 'pushed' | 'up-to-date' | 'failed' | 'unknown' | null; tip: string | null;
  pull_request_url: string | null;
  pull_request_state?: string | null; pull_request_checked_at?: string | null;
}
export interface SessionAccess {
  row: SessionRow;
  permissions: Permission[];
  role: WorkspaceRole;
}
export type PublicProfile = UserProfile;
