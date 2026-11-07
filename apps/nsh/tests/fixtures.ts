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
    [`GET ${ORIGIN}/api/workspaces/w1/repositories`]: { body: { repositories: [{ fullName: "OpenCara/pikibun" }], required: true, sources: 1 } },
    [`GET ${ORIGIN}/api/sessions/s1`]: { body: { session: sessionRecord } },
    [`GET ${ORIGIN}/api/sessions/s1/view`]: { body: { view, revision: "r1" } },
    // The stream ends at once, as the server ends every stream after a few snapshots; the client reopens it later.
    [`GET ${ORIGIN}/api/sessions/s1/events*`]: { status: 200, headers: { "content-type": "text/event-stream" }, body: "" },
    [`POST ${ORIGIN}/api/sessions/s1/approvals/ap1`]: { body: { ok: true } },
    [`POST ${ORIGIN}/api/sessions/s1/submit`]: (request: Request) => ({ body: { submissionId: "q2", conversationId: "0", status: "queued", queuePosition: 1, echo: JSON.parse(request.body ?? "{}") } }),
    [`POST ${ORIGIN}/api/sessions`]: { status: 201, body: { session: { ...sessionRecord, id: "s3", title: "Add a dark mode" } } },
    [`GET ${ORIGIN}/api/sessions/s3`]: { body: { session: { ...sessionRecord, id: "s3", title: "Add a dark mode" } } },
    [`GET ${ORIGIN}/api/sessions/s3/view`]: { body: { view: { ...view, sessionId: "s3", entries: [], approvals: [], busy: false, queue: [], activity: "idle" }, revision: "r1" } },
    [`GET ${ORIGIN}/api/sessions/s3/events*`]: { status: 200, headers: { "content-type": "text/event-stream" }, body: "" },
    [`POST ${ORIGIN}/api/sessions/s3/submit`]: { body: { submissionId: "q9", conversationId: "0", status: "queued" } },
    [`POST ${ORIGIN}/api/auth/logout`]: { status: 204 },
    ...overrides,
  };
}

/** Storage holding a sign-in to the stub server. */
export const signedIn = { "pikibun.token": TOKEN, "pikibun.origin": ORIGIN };
