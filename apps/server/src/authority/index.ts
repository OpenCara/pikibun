/*
 * The authority: who people and hosts are, what each may do, which operations a person approved, the credentials that
 * act for them, and the audit log. See docs/design/authority.md.
 *
 * This file is its whole interface. The rest of the server imports the authority only from here, and code in
 * authority/ imports from the rest of the server only types.ts, http.ts, db.ts and db/types.ts
 * (tests/authority-boundary.test.ts holds both). Everything else, such as relaying requests to hosts, views, schedules,
 * backups and notifications, asks the authority and never decides for it.
 */

// Signing in, the instance's administrators, and what an invite link grants.
export { authenticate, csrfGuard, localOwner, registerAuth } from './auth.js';
export { hashPassword, newPassword, passwordAccountStatements, passwordUsername, registerPasswordAuth, USERNAME_MATCH, usernameMatch } from './password-auth.js';
export { adminUserId, instanceAdmins, registerAdmin } from './admin.js';
export { INVALID_LINK, INVITE_TOKEN, joinRequestStatement, requireInvitedWorkspace } from './invites.js';

// Hosts: who a connector is, and whether it still serves a session.
export { authenticateConnector, authenticateConnectorSocket, type ConnectorRow, requireCallbackScope, requireConnectorSession, requireConnectorTLS } from './hosts.js';

// Access: membership and roles, each person's access to a session, and what the relay may ask a session's host.
export {
  listSessionAccess, requireMember, requireSession, requireSessionCreator, requireSessionManager, sessionAccess, sessionCreatorSQL, sessionManagerSQL,
  sessionReaders, workspaceSessionAccess,
} from './access.js';
export { isPersonalWorkspace, personalWorkspaceName, personalWorkspaceSQL, requireSharedWorkspace } from './personal-workspaces.js';
export { authorizeConnectorTicket, connectorPermissions, requireRunnerAccess } from './runner-access.js';
export { authorizeSession } from './authorize.js';
export {
  connectorAdmins, connectorHostGrants, hostAuthority, hostCommandSession, hostOwnerDecides, managedConnector, managedConnectorFor, managesConnectorSQL,
  mayDecideHostCommands, registerHostAccess, requireManagedWorkspace, runsShellCommands, viewerHostAuthority,
} from './host-access.js';

// Approvals: the exact operation a person reviewed, whose requests run without asking, and which tools may run at all.
export { parseOperation } from './operations.js';
export { crossSessionCall, permissionCall, presentApprovals, requireOperationTool, requireToolCall, reviewedApproval, sessionsNeedGranted } from './approval-reviews.js';
export { autoApprovedRequesters, chooseAutoApprovedRequester, registerRequesterAutoApprove, workspaceApprovalSettings, type WorkspaceApprovalSettings } from './requester-auto-approve.js';
export { issueRunAdmission } from './run-admissions.js';
export { automaticTools, sessionToolSources, workspaceExtensions } from './extension-policy.js';

// Credentials: the vault, repositories and the accounts that read them, Git and API access for sessions, pushes,
// GitHub on the session owner's behalf, and document sources.
export { assertVaultConfigured, decryptToken, encryptToken } from './vault.js';
export {
  cloneRepositories, legacyRepositoryFixture, publicRepository, registerRepositories, type RepositorySettingsRow, repositorySettingsSelect,
  requireConfiguredWorkspace, workspaceHasSourceSQL,
} from './repositories.js';
export { registerGitAccounts } from './git/accounts.js';
export { registerWorkspaceConnections } from './workspace-connections.js';
export { egressGrant, gitDirect, gitRelay, registerNetworkPolicies, workspaceNetworkPolicy } from './network.js';
export { apiCredential } from './api-access.js';
export { pushComplete, pushCredential, settlePushCredentials } from './push/broker.js';
export { publicIdentity, registerPushIdentities } from './push/identities.js';
export { registerOidc } from './push/oidc.js';
export { githubComment, githubIssue, githubMerge, githubRead } from './github-broker.js';
export { refreshPullRequestStates } from './pull-request-states.js';
export { registerSources, sourceRead } from './sources/sources.js';
export { registerSourceOAuth } from './sources/source-oauth.js';

// The audit log, and how the authority tells the rest of the server what it changed.
export { auditAfterChange, auditStatement } from './audit.js';
export { onSessionChange } from './changes.js';
