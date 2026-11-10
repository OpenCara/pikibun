// A small Pikibun server, as routes for nsh test's stubbed network: one workspace, one host, one session with a
// conversation and a pending push approval.

export const ORIGIN = "https://pikibun.test";
export const TOKEN = "tok_0123456789abcdefghijklmnopqrstuv";

export const user = {
  id: "u1", githubId: "1", githubLogin: "ada", displayName: "Ada Lovelace", gitName: "Ada", gitEmail: "ada@example.com",
  env: {}, githubConnected: true,
};

export const workspace = { id: "w1", name: "Analytical Engine", ownerId: "u1", role: "owner" };

const model = { provider: "anthropic", modelId: "claude-sonnet", name: "Claude Sonnet", reasoning: true, thinkingLevels: ["off", "low", "medium", "high"] };

export const host = {
  id: "c1", ownerId: "u1", ownerName: "ada", name: "ada-mac", createdAt: "2026-11-01T10:00:00.000Z", revokedAt: null, online: true,
  models: [model], workspaceIds: ["w1"],
  capabilities: { sandbox: true, chatOptions: true },
};

export const sessionRecord = {
  id: "s1", workspaceId: "w1", ownerId: "u1", agentVersionId: "a1", title: "Fix the flaky login test", policyVersion: 1, status: "ready",
  createdAt: "2026-11-06T09:00:00.000Z", permissions: ["read", "ask", "write", "approve", "manage"], connectorId: "c1", connectorOwnerId: "u1",
  visibility: "workspace", activity: "waiting",
};

const archived = { ...sessionRecord, id: "s2", title: "Old spike", status: "archived", createdAt: "2026-10-01T09:00:00.000Z", activity: "idle" };

export const approval = {
  id: "ap1", sessionId: "s1", requestedBy: "u1", status: "pending", createdAt: "2026-11-06T09:05:00.000Z", reviewHash: "rh_123",
  operation: { kind: "git.push", repository: "OpenCara/pikibun", branch: "fix-login", commit: "0123456789abcdef0123", pullRequest: { title: "Fix the flaky login test", base: "main" } },
};

export const view = {
  sessionId: "s1",
  owner: { id: "u1", displayName: "Ada Lovelace", gitName: "Ada", gitEmail: "ada@example.com", githubLogin: "ada" },
  entries: [
    { id: "e1", kind: "message", role: "user", text: "Why does the login test fail on CI?", actorId: "u1", conversationId: "0" },
    { id: "e2", kind: "message", role: "assistant", text: "The test **races** the session cookie.\n\n- It reads `/api/me` too early\n- Fix: wait for the redirect", conversationId: "0", durationMs: 4200 },
    { id: "e3", kind: "message", role: "toolResult", text: "PASS tests/login.test.ts", conversationId: "0", durationMs: 1300 },
  ],
  approvals: [approval],
  conversations: [{ id: "0", mode: "write" }],
  busy: true,
  activity: "waiting",
  queue: [{ submissionId: "q1", actorId: "u1", mode: "write", status: "running" }],
  stoppable: true,
  rewindable: true,
  agent: { provider: "anthropic", modelId: "claude-sonnet", thinkingLevel: "medium" },
  context: { tokens: 84_210, window: 200_000, compactsAt: 183_616 },
};

type Request = { method: string; url: string; body?: string | null };

/** The routes of a signed-in user's server; `overrides` replace or add routes. */
export function server(overrides: Record<string, unknown> = {}) {
  return {
    [`GET ${ORIGIN}/api/health`]: { body: { ok: true, githubConfigured: true, passwordAuth: false, testMode: true } },
    [`GET ${ORIGIN}/api/me`]: { body: { user } },
    [`GET ${ORIGIN}/api/sessions`]: { body: { sessions: [sessionRecord, archived] } },
    [`GET ${ORIGIN}/api/workspaces`]: { body: { workspaces: [workspace] } },
    [`GET ${ORIGIN}/api/workspaces/w1/members`]: { body: { members: [{ userId: "u1", githubLogin: "ada", role: "owner" }] } },
    [`GET ${ORIGIN}/api/workspaces/w1/connectors`]: { body: { connectors: [host] } },
    [`GET ${ORIGIN}/api/workspaces/w1/models`]: { body: { models: [{ id: "m1", workspaceId: "w1", name: "Claude Sonnet", connectorId: "c1", provider: "anthropic", modelId: "claude-sonnet" }] } },
    [`GET ${ORIGIN}/api/workspaces/w1/repositories`]: { body: { repositories: [{ id: "r1", provider: "github", host: "github.com", repositoryId: "1", fullName: "OpenCara/pikibun", ref: "main", private: false, lfs: false, forbidDefaultBranchPush: true, readAs: "members" }], required: true, sources: 1 } },
    // A single session's read says whether its view would be served now, as the server's does.
    [`GET ${ORIGIN}/api/sessions/s1`]: { body: { session: { ...sessionRecord, viewable: true } } },
    [`GET ${ORIGIN}/api/sessions/s1/view`]: { body: { view, revision: "r1" } },
    // The stream ends at once, as the server ends every stream after a few snapshots; the client reopens it later.
    [`GET ${ORIGIN}/api/sessions/s1/events*`]: { status: 200, headers: { "content-type": "text/event-stream" }, body: "" },
    [`POST ${ORIGIN}/api/sessions/s1/approvals/ap1`]: { body: { ok: true } },
    [`POST ${ORIGIN}/api/sessions/s1/submit`]: (request: Request) => ({ body: { submissionId: "q2", conversationId: "0", status: "queued", queuePosition: 1, echo: JSON.parse(request.body ?? "{}") } }),
    [`POST ${ORIGIN}/api/sessions`]: { status: 201, body: { session: { ...sessionRecord, id: "s3", title: "Add a dark mode" } } },
    [`GET ${ORIGIN}/api/sessions/s3`]: { body: { session: { ...sessionRecord, id: "s3", title: "Add a dark mode", viewable: true } } },
    [`GET ${ORIGIN}/api/sessions/s3/view`]: { body: { view: { ...view, sessionId: "s3", entries: [], approvals: [], busy: false, queue: [], activity: "idle" }, revision: "r1" } },
    [`GET ${ORIGIN}/api/sessions/s3/events*`]: { status: 200, headers: { "content-type": "text/event-stream" }, body: "" },
    [`POST ${ORIGIN}/api/sessions/s3/submit`]: { body: { submissionId: "q9", conversationId: "0", status: "queued" } },
    [`POST ${ORIGIN}/api/auth/logout`]: { status: 204 },
    // Settings: the person's accounts and apps, their hosts, and the workspace's own settings.
    [`GET ${ORIGIN}/api/git/accounts`]: { body: { accounts: [] } },
    [`GET ${ORIGIN}/api/source-accounts`]: { body: { accounts: [], oauth: [] } },
    [`GET ${ORIGIN}/api/me/devices`]: { body: { devices: [{ id: "d1", name: "Ada's iPhone", createdAt: "2026-11-01T10:00:00.000Z", expiresAt: "2026-12-01T10:00:00.000Z" }] } },
    [`GET ${ORIGIN}/api/join-requests`]: { body: { requests: [] } },
    [`PATCH ${ORIGIN}/api/me`]: (request: Request) => ({ body: { user: { ...user, ...JSON.parse(request.body ?? "{}") } } }),
    [`GET ${ORIGIN}/api/notifications/config`]: { body: { preferences: { approvals: true, finished: false, failed: true, details: true }, devices: [], webPushKey: null } },
    [`PUT ${ORIGIN}/api/notifications/preferences`]: (request: Request) => ({ body: { preferences: { approvals: true, finished: false, failed: true, details: true, ...JSON.parse(request.body ?? "{}") } } }),
    [`GET ${ORIGIN}/api/connectors`]: { body: { connectors: [{ ...host, role: "owner", connectedWorkspaceIds: ["w1"], version: "0.40.0" }] } },
    [`GET ${ORIGIN}/api/connectors/c1/extensions`]: { body: { role: "owner", automaticTools: false, requests: [], workspaces: [] } },
    [`POST ${ORIGIN}/api/connectors/pairings`]: { status: 201, body: { pairing: { id: "p1", code: "pair-secret-code", expiresAt: "2099-01-01T00:00:00.000Z" } } },
    [`GET ${ORIGIN}/api/workspaces/w1/sources`]: { body: { sources: [] } },
    [`GET ${ORIGIN}/api/workspaces/w1/connections`]: { body: { connections: [] } },
    [`GET ${ORIGIN}/api/workspaces/w1/push-identities`]: { body: { identities: [], oidc: null, redirectUri: null, githubApp: null } },
    [`GET ${ORIGIN}/api/workspaces/w1/network-policy`]: { body: { policy: { mode: "off", domains: [], packageRegistries: true }, packageRegistryDomains: ["registry.npmjs.org"] } },
    [`GET ${ORIGIN}/api/workspaces/w1/extensions`]: { body: { extensions: [], hosts: [], admin: true } },
    [`GET ${ORIGIN}/api/workspaces/w1/transcripts`]: { body: { settings: { paging: true, toolOutput: "full" } } },
    [`GET ${ORIGIN}/api/workspaces/w1/approvals`]: { body: { settings: { requesterAutoApprove: false } } },
    [`GET ${ORIGIN}/api/workspaces/w1/child-sessions`]: { body: { settings: { childModels: true } } },
    [`GET ${ORIGIN}/api/workspaces/w1/attachments`]: { body: { settings: { maxFileBytes: 10485760 } } },
    [`GET ${ORIGIN}/api/workspaces/w1/database`]: { body: { available: false, privateHosts: false, backupStorage: true, database: null, automaticBackups: null } },
    [`GET ${ORIGIN}/api/workspaces/w1/invite-link`]: { body: { link: null } },
    [`GET ${ORIGIN}/api/workspaces/w1/join-requests`]: { body: { requests: [] } },
    // The session panel: its worktree, activity, schedules and people.
    [`GET ${ORIGIN}/api/sessions/s1/files?path=.`]: { body: { files: { type: "directory", path: ".", entries: [{ name: "src", type: "directory" }, { name: "README.md", type: "file", size: 42 }], total: 2, truncated: false } } },
    [`GET ${ORIGIN}/api/sessions/s1/files?path=README.md`]: { body: { files: { type: "file", path: "README.md", size: 42, text: "# Pikibun\nThe login test races the cookie." } } },
    [`GET ${ORIGIN}/api/sessions/s1/files?path=browser-output`]: { status: 404, body: { error: "No such file or directory" } },
    [`GET ${ORIGIN}/api/sessions/s1/audit`]: { body: { events: [{ id: "a1", actorId: "u1", action: "session.create", detail: { title: "Fix the flaky login test" }, createdAt: "2026-11-06T09:00:00.000Z" }] } },
    [`GET ${ORIGIN}/api/sessions/s1/schedules`]: { body: { schedules: [], canManage: true } },
    [`POST ${ORIGIN}/api/sessions/s1/schedules`]: { status: 201, body: { schedule: { id: "sc1" } } },
    [`GET ${ORIGIN}/api/sessions/s1/connections`]: { body: { parent: null, children: [], messages: [] } },
    [`GET ${ORIGIN}/api/sessions/s1/grants`]: { body: { grants: [{ userId: "u1", permissions: ["read", "ask", "write", "approve", "manage"] }] } },
    [`GET ${ORIGIN}/api/sessions/s1/link`]: { body: { link: null } },
    [`GET ${ORIGIN}/api/sessions/s1/backups`]: { body: { backups: [], enabled: true, conversationOnlySupported: true } },
    [`GET ${ORIGIN}/api/sessions/s1/migrations`]: { body: { migrations: [] } },
    [`PATCH ${ORIGIN}/api/sessions/s1`]: (request: Request) => ({ body: { session: { ...sessionRecord, ...JSON.parse(request.body ?? "{}") } } }),
    [`POST ${ORIGIN}/api/workspaces`]: { status: 201, body: { workspace: { id: "w2", name: "Difference Engine", ownerId: "u1", role: "owner" } } },
    ...overrides,
  };
}

/** Storage holding a sign-in to the stub server. */
export const signedIn = { "pikibun.token": TOKEN, "pikibun.origin": ORIGIN };
