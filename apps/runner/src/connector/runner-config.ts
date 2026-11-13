import { join } from "node:path";
import { z } from "zod";
import type { ConnectorCredentials } from "../../../../packages/shared/src/connector.js";
import type { SessionsToolResult } from "../../../../packages/shared/src/cross-session.js";
import type { GitHubEffectAuthority, GitHubIssueView, ScheduleToolResult } from "../../../../packages/shared/src/types.js";
import type { HostBrowserSource } from "../browser-host.js";
import { parseEgressGrant, relayGitRequest, relayPath } from "../egress.js";
import type { HostExtensions } from "../extensions/host.js";
import { HostCredentialError, hostGitAuthorization } from "../git-credentials.js";
import type { HostConfigSource } from "../host-config.js";
import type { LocalModels } from "../local-pi.js";
import { RunnerError } from "../protocol.js";
import type { RepositoryCache } from "../repo-cache.js";
import type { SandboxBackendConfig } from "../sandbox-backend.js";
import type { RunnerConfig } from "../session.js";
import type { HostTunnels, HostTunnelSource, TunnelAccess } from "../tunnel-host.js";
import type { ControlPlaneCalls } from "./control-plane.js";
import type { Generation } from "./generation.js";

const WORKSPACE_EXTENSIONS_LIMIT = 1024 * 1024;
const GITHUB_READ_LIMIT = 128 * 1024;
const BROKERED_LIMIT = 1024 * 1024;
const BROKERED_ROUTE = /^[a-z0-9-]+(?:\/[a-z0-9-]+){0,3}$/;
const SCHEDULES_LIMIT = 4 * 1024 * 1024;
const SESSIONS_LIMIT = 2 * 1024 * 1024;

function effectAuthority(request: GitHubEffectAuthority): { capability: string } | { admissionId: string } {
  return request.capability !== undefined ? { capability: request.capability } : { admissionId: request.admissionId! };
}

export interface RunnerConfigSource {
  credentials: ConnectorCredentials;
  directory: string;
  secret: string;
  options: {
    allowFaux?: boolean; allowTestShell?: boolean; resources?: RunnerConfig["resources"]; unsandboxed?: boolean; sandboxBackend?: SandboxBackendConfig;
    privateEnvironment?: readonly string[];
    localModels: LocalModels; fetch?: typeof fetch;
  };
  lifetime: AbortSignal;
  hostConfig: HostConfigSource;
  hostExtensions: HostExtensions | undefined;
  browser(): HostBrowserSource | undefined;
  tunnel(): HostTunnelSource | undefined;
  tunnels(): HostTunnels | undefined;
  calls: ControlPlaneCalls;
  connection(): Promise<Generation>;
  requireGeneration(generation: Generation): void;
}

function runnerExtensions(source: RunnerConfigSource, extensions: HostExtensions): NonNullable<RunnerConfig["extensions"]> {
  return {
    installed: () => extensions.loaded,
    workspace: workspaceId => extensions.workspace(workspaceId, async () =>
      source.calls.callback(await source.connection(), "/api/connectors/self/extensions/workspace", { workspaceId, toolDefinitions: true }, WORKSPACE_EXTENSIONS_LIMIT)),
    lastKnown: workspaceId => extensions.lastKnown(workspaceId),
    ...(source.options.localModels.modelRegistry ? { modelRegistry: source.options.localModels.modelRegistry } : {}),
  };
}

export function connectorRunnerConfig(source: RunnerConfigSource, repositoryCache: RepositoryCache | undefined): RunnerConfig {
  const { calls, options } = source;
  const state = source.credentials;
  const hostConfig = source.hostConfig;
  return {
    dataDir: join(source.directory, "runner"), controlPlaneUrl: state.controlPlaneUrl,
    sharedSecret: source.secret, connectorId: state.connectorId,
    allowFaux: options.allowFaux === true, allowTestShell: options.allowTestShell === true,
    resources: options.resources, unsandboxed: options.unsandboxed === true,
    ...(options.privateEnvironment?.length ? { privateEnvironment: options.privateEnvironment } : {}),
    pikiHostSignIn: process.env.PIKIBUN_PIKI_HOST_SIGN_IN === "1",
    ...(options.sandboxBackend && !options.unsandboxed ? { sandboxBackend: options.sandboxBackend } : {}),
    resolveModels: model => {
      if (source.lifetime.aborted) throw new Error("Connector has stopped");
      return options.localModels.resolve(model);
    },
    compaction: options.localModels.compaction, identity: options.localModels.identity,
    ...(source.hostExtensions ? { extensions: runnerExtensions(source, source.hostExtensions) } : {}),
    ...(source.browser() ? { browser: () => source.browser()?.current(), browserStatus: () => source.browser()?.status() } : {}),
    ...(source.tunnels() && source.tunnel() ? { tunnels: { open: (socket: string, signal?: AbortSignal, access?: TunnelAccess) => source.tunnels()!.open(socket, signal, access), status: () => source.tunnel()?.status() } } : {}),
    reportTunnel: async report => calls.reportTunnel(await source.connection(), report),
    authorize: async request => calls.authorize(await source.connection(), request),
    reportActivity: async (sessionId, activity) => calls.reportActivity(await source.connection(), sessionId, activity),
    reportBranches: async (sessionId, branches) => calls.reportBranches(await source.connection(), sessionId, branches),
    githubComment: async request => {
      const payload = {
        sessionId: request.sessionId, actorId: request.actorId, approvalId: request.approvalId, ...effectAuthority(request),
        repository: request.repository, issue: request.issue, body: request.body,
      };
      return z.object({
        id: z.number().int().positive(), url: z.string().max(2048).regex(/^https:\/\/github\.com\//),
      }).strict().parse(await calls.callback(await source.connection(), "/api/connectors/self/github/comment", payload));
    },
    githubRead: async request => {
      const payload = { sessionId: request.sessionId, actorId: request.actorId, admissionId: request.admissionId, callId: request.callId, repository: request.repository, issue: request.issue };
      const view = await calls.brokerCallback(await source.connection(), "/api/connectors/self/github/read", payload, GITHUB_READ_LIMIT);
      z.looseObject({ repository: z.string(), number: z.number().int().positive(), title: z.string(), comments: z.array(z.unknown()) }).parse(view);
      return view as GitHubIssueView;
    },
    toolDefinitions: async () => calls.toolDefinitions(),
    brokered: async (route, request) => {
      if (!BROKERED_ROUTE.test(route)) throw new RunnerError(400, "Invalid brokered tool route");
      return z.looseObject({}).parse(await calls.brokerCallback(await source.connection(), `/api/connectors/self/${route}`, request, BROKERED_LIMIT));
    },
    githubMerge: async request => {
      const payload = {
        sessionId: request.sessionId, actorId: request.actorId, approvalId: request.approvalId, ...effectAuthority(request),
        repository: request.repository, pull: request.pull, sha: request.sha, method: request.method,
      };
      return z.object({
        sha: z.string().regex(/^[0-9a-f]{40}$/), url: z.string().max(2048).regex(/^https:\/\/github\.com\//),
      }).strict().parse(await calls.brokerCallback(await source.connection(), "/api/connectors/self/github/merge", payload));
    },
    githubIssue: async request => {
      const payload = {
        sessionId: request.sessionId, actorId: request.actorId, approvalId: request.approvalId, ...effectAuthority(request),
        repository: request.repository, title: request.title, body: request.body,
      };
      return z.object({
        number: z.number().int().positive(), url: z.string().max(2048).regex(/^https:\/\/github\.com\/[^/]+\/[^/]+\/issues\/\d+$/),
      }).strict().parse(await calls.brokerCallback(await source.connection(), "/api/connectors/self/github/issue", payload));
    },
    schedules: async request => {
      const result = await calls.brokerCallback(await source.connection(), "/api/connectors/self/schedules", request, SCHEDULES_LIMIT);
      z.union([z.looseObject({ schedules: z.array(z.looseObject({ id: z.string() })) }), z.looseObject({ schedule: z.looseObject({ id: z.string() }) }),
        z.object({ deleted: z.string() }).strict()]).parse(result);
      return result as ScheduleToolResult;
    },
    crossSessions: async request => {
      const result = await calls.brokerCallback(await source.connection(), "/api/connectors/self/sessions", request, SESSIONS_LIMIT);
      z.union([z.looseObject({ sessions: z.array(z.looseObject({ id: z.string() })), models: z.array(z.unknown()) }),
        z.looseObject({ session: z.looseObject({ id: z.string() }) }), z.looseObject({ message: z.looseObject({ id: z.string() }) }),
        z.object({ stopped: z.number().int().nonnegative() }).strict(), z.object({ archived: z.string() }).strict(),
        z.object({ consent: z.literal("audience"), target: z.string().max(8192), reason: z.string().max(1024) }).strict()]).parse(result);
      return result as SessionsToolResult;
    },
    pushCredential: async request => {
      const payload = {
        sessionId: request.sessionId, approvalId: request.approvalId, actorId: request.actorId, operation: request.operation,
        ...(request.capability !== undefined ? { capability: request.capability } : {}),
        ...(request.admissionId !== undefined ? { admissionId: request.admissionId } : {}),
      };
      const issued = {
        credentialId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/), remote: z.string().max(2048).regex(/^https:\/\/[^/@\s]+\/\S*$/), expiresAt: z.string().datetime(),
      };
      return z.union([
        z.object({ ...issued, authorization: z.string().regex(/^(Basic|Bearer) [A-Za-z0-9+/=._~-]{1,8000}$/) }).strict(),
        z.object({ ...issued, hostCredentials: z.literal(true) }).strict(),
      ]).parse(await calls.brokerCallback(await source.connection(), "/api/connectors/self/git/push/credential", payload));
    },
    hostConfig: () => hostConfig.current(),
    requiredExtensions: () => hostConfig.required(),
    hostGitCredential: async (remote: string, signal?: AbortSignal) => {
      if (!(await hostConfig.current()).gitCredentials) throw new HostCredentialError("This host's owner hasn't turned on its Git credentials in Pikibun (Settings → Hosts → the host → Configuration)");
      return hostGitAuthorization(remote, { signal });
    },
    pushComplete: async request => {
      const payload = {
        sessionId: request.sessionId, approvalId: request.approvalId, credentialId: request.credentialId, outcome: request.outcome,
        ...(request.tip !== undefined ? { tip: request.tip } : {}),
      };
      return z.object({
        pullRequest: z.object({
          url: z.string().max(2048).regex(/^https:\/\/\S+$/), number: z.number().int().positive(), created: z.boolean(), draft: z.boolean().optional(),
        }).strict().optional(),
      }).strict().parse(await calls.brokerCallback(await source.connection(), "/api/connectors/self/git/push/complete", payload));
    },
    egressGrant: async sessionId => parseEgressGrant(await calls.brokerCallback(await source.connection(), "/api/connectors/self/network", { sessionId })),
    gitDirect: async (sessionId, request) => calls.brokerCallback(await source.connection(), "/api/connectors/self/git/direct", { sessionId, ...request }),
    apiCredential: async (sessionId, host, access) => calls.brokerCallback(await source.connection(), "/api/connectors/self/api/credential",
      { sessionId, host, ...(access === "write" ? { access } : {}) }),
    gitRelay: async (sessionId, request) => {
      const generation = await source.connection();
      source.requireGeneration(generation);
      const push = request.service === "receive-pack";
      const response = await relayGitRequest(options.fetch ?? fetch, `${state.controlPlaneUrl}${relayPath("/api/connectors/self", sessionId, request)}`,
        { authorization: `Bearer ${state.token}`, "x-connection-token": generation.connectionToken! }, request,
        AbortSignal.any([...(push ? [] : [generation.abort.signal]), source.lifetime, AbortSignal.timeout(60 * 60 * 1000)]));
      if (push) return response;
      try { source.requireGeneration(generation); }
      catch (error) { await response.body?.cancel(); throw error; }
      return response;
    },
    readBackup: async (restore, target) => calls.readBackup(await source.connection(), restore, target),
    ...(repositoryCache ? { repositoryCache } : {}),
  };
}
