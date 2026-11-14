import { randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, readFile, rm } from "node:fs/promises";
import { availableParallelism } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { getSupportedThinkingLevels, type ClientIdentity, type Message, type Models } from "@earendil-works/pi-ai";
import { ConversationIdle, createRegistry, defineExtension, Harness, InboxDoc, type AgentChange, type CompactionSettings, type Cursor, type Conversation, type ConversationId, type EntryId, type EntryRecord, type Extension, type Registry, type Storage, type SubmissionId, type ToolRegistration } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import type { AuthorizationRequest, AuthorizationResult, ChatOptions, GitHubCommentRequest, GitHubIssueRequest, GitHubIssueResult, GitHubIssueView, GitHubMergeRequest, GitHubMergeResult, GitHubReadRequest, HostPushCredential, ModelDefinition, Operation, Permission, PushCompleteRequest, PushCompletionResult, PushCredential, PushCredentialRequest, RunnerBinding, RunnerTicket, ScheduleToolRequest, ScheduleToolResult, SessionActivity, SessionBranch, SessionFiles, SessionView, SubmitInput, SubmitResult, ThinkingLevel, WithdrawResult } from "../../../packages/shared/src/types.js";
import { accessModes, sessionToolNames, thinkingLevels } from "../../../packages/shared/src/types.js";
import type { SessionsToolRequest, SessionsToolResult } from "../../../packages/shared/src/cross-session.js";
import type { RestoreDescriptor } from "../../../packages/shared/src/connector.js";
import { bindingRemote } from "../../../packages/shared/src/repositories.js";
import { sha256 } from "../../../packages/shared/src/crypto.js";
import { missingRequiredExtensions, sessionExtensions, type ChosenExtension, type WorkspaceExtensionsAnswer } from "../../../packages/shared/src/host-extensions.js";
import type { ModelRegistry } from "@earendil-works/pi-coding-agent";
import { ExtensionPrompts, SessionExtensions, type ExtensionHost, type SessionExtension } from "./extensions/adapter.js";
import { SessionBuiltins } from "./extensions/builtin.js";
import type { LoadedSource } from "./extensions/load.js";
import { messageHash, parseChatImages, type ChatImage } from "../../../packages/shared/src/chat-images.js";
import { parseUploadChunk, type UploadResult } from "../../../packages/shared/src/file-uploads.js";
import { requestKey, RunnerError, stableJson } from "./protocol.js";
import { localChangesRequest, type LocalChanges, type LocalChangesRequest } from "../../../packages/shared/src/local-changes.js";
import { LOCAL_CHANGES_SECONDS, localChangesCommand, NotARepository, parseLocalChanges } from "./local-changes.js";
import type { ToolDefinition } from "../../../packages/shared/src/tool-definitions.js";
import type { BrowserToolchain } from "./browser-toolchain.js";
import type { BrowserUnavailableReason, HostBrowserStatus } from "../../../packages/shared/src/browser.js";
import { serviceLifetimeLimits, type HostTunnelStatus, type SessionTunnelReport, type TunnelUnavailableReason } from "../../../packages/shared/src/tunnel.js";
import { SessionTunnel } from "./session/tunnel.js";
import { SudoPrompts } from "./sudo-prompts.js";
import { parseSudoAnswer } from "../../../packages/shared/src/sudo.js";
import { renamedToolsHook } from "./session/renamed-tools.js";
import { pinServiceSocket, serviceLimits, serviceShellCommand, serviceSocketDirectory } from "./session-service.js";
import { ProcessChannel, refusedChannel, sandboxLaunch } from "./extensions/process.js";
import type { QuickTunnel, TunnelAccess } from "./tunnel-host.js";
import { runnerModels } from "./provider.js";
import { HostWorkspace, hostOwnersSession } from "./host-workspace.js";
import { isolatedWorkspace, type SessionWorkspace } from "./workspace.js";
import type { SandboxBackendConfig } from "./sandbox-backend.js";
import { HelperWorkspace } from "./helper-workspace.js";
import { SeatbeltBackend } from "./seatbelt.js";
import { WindowsBackend } from "./windows-sandbox.js";
import { BranchReports } from "./session/branch-reports.js";
import { HostCommandPolicy } from "./session/host-commands.js";
import { WholeResults } from "./session/whole-results.js";
import { entryImages } from "./session/entries.js";
import { checkEntryImage, entryIdParts, entryImageRequest, type EntryImage } from "../../../packages/shared/src/entry-images.js";
import { MessageInputs, prepareMessageImages } from "./session/inputs.js";
import { refused, SessionMirrors } from "./session/mirrors.js";
import { SessionUploads } from "./session/uploads.js";
import { agentInstructions, type InstructionsMode } from "./session/instructions.js";
import { preparationFailure, SessionRepositories } from "./session/repositories.js";
import { comparableOptions, holdsQueue, RunnerState, tellsActivity, type Metadata, type Run } from "./session/state.js";
import { activityEntry, contextView, extensionView, sessionView } from "./session/view.js";
import { SessionOperations, type OperationConsent } from "./session/operations.js";
import { ToolCalls } from "./session/tools/calls.js";
import type { ToolContext } from "./session/tools/context.js";
import { buildTools } from "./session/tools/index.js";
import { definedTool } from "./session/tools/defined.js";
import { SessionDefinitions } from "./session/definitions.js";
import { ToolAvailability } from "./session/availability.js";
import { SessionPiki } from "./session/piki.js";
import { requeue, RunQueue, submissionRequestId } from "./session/run-queue.js";
import { autoModelRequest, chooseAutoModel, messageText } from "./session/auto-model.js";
import type { AutoRunChoice } from "../../../packages/shared/src/auto-dispatch.js";
import type { AutoModelRequest } from "../../../packages/shared/src/types.js";
import {
  Sandbox, type CloneBackup, type MirrorMount, type SnapshotFile,
} from "./sandbox.js";
import { thumbnailImage } from "./images.js";
import type { GitRemote } from "./git-remote.js";
import type { RepositoryCache } from "./repo-cache.js";
import type { ResourceConfig } from "./resources.js";
import type { RestoreManifest } from "./restore.js";
import { backupRefusal, boundedBackup } from "./backup.js";
import { isPacked, packBytes, packRefusal } from "./pack.js";
import { configuredCompaction, hostCompaction } from "./compaction.js";
import { ActivityReporter, sessionActivity } from "./activity.js";
import type { StoredOperation } from "./operation-record.js";
import { EgressProxy, egressEnvironment, egressSocketPath, parseEgressGrant, relayGitRequest, relayPath, type MirrorProgress, type RelayRequest } from "./egress.js";
import { DirectGit } from "./git-direct.js";
import { egressReadServices, type ApiAccessKind, type EgressGrant, type EgressRepository, type GitDirectRequest } from "../../../packages/shared/src/network.js";
import { sessionBranch } from "../../../packages/shared/src/git-push.js";
import type { DocumentKind, GrantSource } from "../../../packages/shared/src/sources.js";
import { defaultHostConfig, type HostCompaction, type HostConfig, type RequiredExtension } from "../../../packages/shared/src/host-config.js";

export type { Run } from "./session/state.js";
export type ForkedEntry = { kind: string; model: readonly Message[] };
export type ForkedConversation = { entries: ForkedEntry[]; agent: { model?: { provider: string; modelId: string }; thinkingLevel?: ThinkingLevel } };
const FORKED_KIND = "workspace.forked";

export function messageInput(input: unknown): string {
  const value = input as { entryId?: unknown } | null;
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some(key => key !== "entryId")
    || typeof value.entryId !== "string" || value.entryId.length > 64) throw new RunnerError(400, "Invalid message");
  return value.entryId;
}
interface RunnerBackup {
  format: "pi-runner-backup-v1";
  binding: RunnerBinding;
  manifest: Metadata;
  sqlite: string;
  files: SnapshotFile[];
  clones?: CloneBackup[];
  conversationOnly?: true;
  createdAt: string;
}
const MAX_QUEUED_IMAGE_BYTES = 16 * 1024 * 1024;
const readOnlyTools = ["identity", "read", "ls", "grep", "find"];
export type RunnerConfig = {
  dataDir: string; controlPlaneUrl: string; sharedSecret: string; allowFaux: boolean; allowTestShell?: boolean; fetch?: typeof fetch;
  connectorId?: string;
  privateEnvironment?: readonly string[];
  authorize?: (request: AuthorizationRequest) => Promise<AuthorizationResult>;
  githubComment?: (request: GitHubCommentRequest) => Promise<{ id: number; url: string }>;
  githubRead?: (request: GitHubReadRequest) => Promise<GitHubIssueView>;
  githubWaitPollMs?: number;
  toolDefinitions?: () => Promise<readonly ToolDefinition[]>;
  brokered?: (route: string, request: Record<string, unknown>) => Promise<unknown>;
  githubMerge?: (request: GitHubMergeRequest) => Promise<GitHubMergeResult>;
  githubIssue?: (request: GitHubIssueRequest) => Promise<GitHubIssueResult>;
  schedules?: (request: ScheduleToolRequest) => Promise<ScheduleToolResult>;
  crossSessions?: (request: SessionsToolRequest) => Promise<SessionsToolResult>;
  pushCredential?: (request: PushCredentialRequest) => Promise<PushCredential | HostPushCredential>;
  pushComplete?: (request: PushCompleteRequest) => Promise<PushCompletionResult>;
  hostGitCredential?: (remote: string, signal?: AbortSignal) => Promise<string>;
  resolveModels?: (model: ModelDefinition) => Promise<{ models: Models; provider: string; modelId: string; thinkingLevel?: ThinkingLevel }>;
  readBackup?: (restore: RestoreDescriptor, targetSessionId: string) => Promise<Uint8Array>;
  compaction?: CompactionSettings;
  identity?: ClientIdentity;
  repositoryCache?: RepositoryCache;
  cacheRemote?: (repository: EgressRepository) => Promise<GitRemote>;
  resources?: ResourceConfig;
  browser?: BrowserToolchain | null | (() => BrowserToolchain | undefined);
  browserStatus?: () => HostBrowserStatus | undefined;
  tunnels?: { open(socket: string, signal?: AbortSignal, access?: TunnelAccess): Promise<QuickTunnel>; status(): HostTunnelStatus | undefined };
  reportTunnel?: (report: SessionTunnelReport) => Promise<void>;
  unsandboxed?: boolean;
  pikiHostSignIn?: boolean;
  sandboxBackend?: SandboxBackendConfig;
  openStorage?: (path: string) => Promise<Storage>;
  reportActivity?: (sessionId: string, activity: SessionActivity) => Promise<void>;
  reportBranches?: (sessionId: string, branches: SessionBranch[]) => Promise<void>;
  egressGrant?: (sessionId: string) => Promise<EgressGrant>;
  gitRelay?: (sessionId: string, request: RelayRequest) => Promise<Response>;
  gitDirect?: (sessionId: string, request: Omit<GitDirectRequest, "sessionId">) => Promise<unknown>;
  apiCredential?: (sessionId: string, host: string, access: ApiAccessKind) => Promise<unknown>;
  hostConfig?: () => Promise<HostConfig>;
  requiredExtensions?: () => Promise<RequiredExtension[] | undefined>;
  extensions?: {
    installed(): readonly LoadedSource[];
    workspace(workspaceId: string): Promise<WorkspaceExtensionsAnswer>;
    lastKnown?(workspaceId: string): WorkspaceExtensionsAnswer | undefined;
    modelRegistry?: ModelRegistry;
  };
};

const REQUIRED_UNKNOWN = "This host can't learn from Pikibun which extensions its owner requires right now, so no message is sent. Try again shortly";
const REQUIRED_MISSING = "This host's owner requires an extension its connector can't run now, so no message is sent. Ask them to look at the host's extensions";

export const WORK_MARKER = "working";

export class RunnerSession {
  readonly sandbox: SessionWorkspace;
  readonly sqlitePath: string;
  private harness!: Harness;
  private root!: Conversation;
  #shared!: Conversation;
  #extension!: Extension;
  readonly #defined: SessionDefinitions;
  readonly #availability: ToolAvailability;
  #registry?: Registry;
  readonly #inputs: MessageInputs;
  readonly #uploads: SessionUploads;
  readonly #mirrors: SessionMirrors | undefined;
  readonly #calls: ToolCalls;
  readonly #toolContext: ToolContext;
  readonly #piki: SessionPiki;
  #hostExtensions?: SessionExtensions;
  #currentModel?: { provider: string; modelId: string; thinkingLevel?: string };
  #opening: Promise<void> = Promise.resolve();
  #builtins?: SessionBuiltins;
  private tools: ToolRegistration[] = [];
  private lock: Promise<unknown> = Promise.resolve();
  private generation = 0;
  private closing = false;
  readonly #queue: RunQueue;
  private modelRef!: { provider: string; modelId: string };
  private models!: Models;
  #compaction: () => CompactionSettings | undefined = () => undefined;
  readonly #operations: SessionOperations;
  #failed = false;
  #recovery: Promise<void> | undefined;
  readonly #wholeResults = new WholeResults();
  readonly #repositories: SessionRepositories;
  #opened = false;
  #resumed = false;
  readonly #activity: ActivityReporter | undefined;
  readonly #egress: EgressProxy | undefined;
  readonly #direct: DirectGit | undefined;
  readonly #clone: boolean;
  readonly #frozen: boolean;
  #packed = false;
  readonly #onHost: boolean;
  readonly #hostSession: boolean;
  private readonly hostCommands: HostCommandPolicy;
  #cloneRepositories: string[] = [];
  #sources: GrantSource[] = [];
  #lfsRepositories: string[] = [];
  #branchReports: BranchReports | undefined;
  #conversationOnlyRestore = false;
  #configuredCompaction: HostCompaction | undefined;
  #tunnel: SessionTunnel | undefined;
  readonly #sudo: SudoPrompts | undefined;
  #sudoOffered = false;

  constructor(readonly binding: RunnerBinding, readonly directory: string, readonly config: RunnerConfig) {
    if (binding.session.connectorId !== config.connectorId || binding.model.connectorId !== config.connectorId)
      throw new RunnerError(403, "Session connector mismatch");
    this.sqlitePath = join(directory, "session.sqlite");
    this.#clone = binding.session.repositoryMode === "clone";
    this.#frozen = !this.#clone && (binding.session.repositories ?? []).length > 0;
    this.#hostSession = binding.session.hostEnvironment === true && config.unsandboxed !== true;
    this.#inputs = new MessageInputs(join(directory, "inputs"));
    this.#mirrors = this.#clone && config.repositoryCache ? new SessionMirrors({
      cache: config.repositoryCache, ownerId: binding.owner.id, sessionId: binding.session.id, relay: request => this.relay(request),
      grant: () => this.#egress!.grant(), ...(config.cacheRemote ? { cacheRemote: config.cacheRemote } : {}),
    }) : undefined;
    this.#onHost = config.unsandboxed === true || this.#hostSession;
    if (this.#hostSession && !binding.session.connectorOwnerId) {
      throw new RunnerError(403, "Only sessions of the host's owner, or of members they granted that, run directly on the host");
    }
    this.hostCommands = new HostCommandPolicy({
      ownerId: binding.owner.id, connectorOwnerId: binding.session.connectorOwnerId, hostSession: this.#hostSession, onHost: this.#onHost,
      limitedSandbox: !!config.resources && !config.sandboxBackend, windowsSandbox: config.sandboxBackend?.kind === "windows",
      testShell: this.testShell(), authorize: (actorId, permission, host, hostSessions) => this.authorize(actorId, permission, undefined, host, hostSessions),
      hostConfig: () => this.hostConfig(),
    });
    const directGrant = config.gitDirect ? (request: Omit<GitDirectRequest, "sessionId">) => config.gitDirect!(binding.session.id, request)
      : config.gitRelay ? undefined
      : (request: Omit<GitDirectRequest, "sessionId">) => this.controlPlane("/api/internal/git/direct", { sessionId: binding.session.id, ...request });
    this.#direct = directGrant && new DirectGit({ grant: directGrant, onFallback: (request, reason) => this.#egress?.noteFallback(request.bindingId, reason),
      fakeIpTunnels: async () => (await this.hostConfig()).fakeIpTunnels });
    this.#sudo = this.#onHost && hostOwnersSession(binding) && process.platform !== "win32" ? new SudoPrompts({
      allowed: () => this.sudoAllowed(), changed: () => this.#activity?.changed(),
      command: () => (this.sandbox instanceof HostWorkspace ? this.sandbox.activeCommand : undefined),
    }) : undefined;
    if (this.#onHost) this.sandbox = new HostWorkspace(binding, join(directory, "sandbox"),
      { ownerEnvironment: hostOwnersSession(binding), privateEnvironment: config.privateEnvironment, ...(this.#sudo ? { sudo: this.#sudo } : {}) });
    else if (config.sandboxBackend) {
      const egress = this.egressProxy(egressSocketPath(binding.session.id, directory), randomBytes(24).toString("base64url"));
      this.#egress = egress;
      const backend = config.sandboxBackend.kind === "seatbelt" ? new SeatbeltBackend()
        : new WindowsBackend({ runtime: config.sandboxBackend.runtime, limits: config.sandboxBackend.limits });
      const branch = this.#clone ? sessionBranch(binding.session) : undefined;
      const workspace: HelperWorkspace = new HelperWorkspace(binding, join(directory, "sandbox"), backend, {
        egressEnvironment: () => { const endpoint = egress.endpoint; return endpoint && egressEnvironment(branch, endpoint, workspace.layout.caBundle); },
      });
      this.sandbox = workspace;
    } else {
      this.#egress = this.egressProxy(egressSocketPath(binding.session.id, directory));
      this.sandbox = new Sandbox(binding, join(directory, "sandbox"), config.resources, { egressSocket: this.#egress.socketPath,
        ...(config.browser !== undefined ? { browser: config.browser } : {}),
        ...(this.#clone ? { sessionBranch: sessionBranch(binding.session) } : {}),
        ...(this.#mirrors ? { mirrors: () => this.mirrorMounts() } : {}) });
    }
    this.#uploads = new SessionUploads(join(directory, "uploads"), this.sandbox);
    this.#availability = new ToolAvailability({ binding, config, sandbox: this.sandbox, onHost: this.#onHost,
      definitions: () => this.#defined.definitions, toolNames: () => this.tools.map(tool => tool.name) });
    this.#calls = new ToolCalls({ ownerId: binding.owner.id, sandbox: this.sandbox, hostCommands: this.hostCommands,
      authorize: (actorId, permission) => this.authorize(actorId, permission), metadata: () => this.metadata(), hostConfig: () => this.hostConfig(),
      requireOwnerTool: tool => this.#availability.requireOwnerTool(tool), requireSenderTool: (tool, senderId) => this.#availability.requireSenderTool(tool, senderId) });
    this.#operations = new SessionOperations({
      binding, config, clone: this.#clone, sandboxed: !!this.#egress, sandbox: this.sandbox, hostCommands: this.hostCommands, wholeResults: this.#wholeResults,
      requireUnfrozen: () => this.requireUnfrozen(), authorize: (actorId, permission) => this.authorize(actorId, permission),
      metadata: () => this.metadata(), mutate: change => this.mutate(change), commandOptions: timeoutSeconds => this.#calls.commandOptions(timeoutSeconds),
      testShell: () => this.testShell(), controlPlane: <T>(path: string, body: unknown) => this.controlPlane<T>(path, body),
    });
    this.#toolContext = {
      binding, config, sandbox: this.sandbox, onHost: this.#onHost, calls: this.#calls, hostCommands: this.hostCommands, wholeResults: this.#wholeResults, operations: this.#operations,
      requireSessionTool: tool => this.#availability.requireSessionTool(tool), requireSenderTool: (tool, senderId) => this.#availability.requireSenderTool(tool, senderId),
      metadata: () => this.metadata(), mutate: change => this.mutate(change),
      authorize: (actorId, permission) => this.authorize(actorId, permission), hostConfig: () => this.hostConfig(),
      programMissing: (tool, program) => this.#availability.programMissing(tool, program), browserUnavailable: () => this.#availability.browserUnavailable(),
      tunnelUnavailable: () => this.#availability.tunnelUnavailable(), tunnel: () => this.#tunnel, startTunnel: () => this.sessionTunnel(), grant: () => this.#egress!.grant(),
    };
    this.#defined = new SessionDefinitions({
      sessionId: binding.session.id, windows: process.platform === "win32" && this.sandbox.isolated, config,
      tool: definition => definedTool(this.#toolContext, definition), registry: () => this.#registry, toolNames: () => this.tools.map(tool => tool.name),
      added: (tools, names) => { this.tools.push(...tools); this.#hostExtensions?.reserve(names); },
    });
    this.#queue = new RunQueue({
      sessionId: binding.session.id, connectorOwnerId: binding.session.connectorOwnerId, inputs: this.#inputs, config,
      configuredCompaction: () => this.#configuredCompaction, generation: () => this.generation, closing: () => this.closing,
      preparation: () => this.#repositories.status, harness: () => this.harness, hostExtensions: () => this.#hostExtensions,
      exclusive: operation => this.exclusive(operation), metadata: () => this.metadata(), mutate: change => this.mutate(change),
      authorize: (actorId, permission) => this.authorize(actorId, permission), requiredRefusal: open => this.requiredRefusal(open),
      extensionChoice: () => this.extensionChoice(), applyOptions: (conversation, run, content) => this.applyOptions(conversation, run, content),
      drain: () => this.drainQueue(),
    });
    this.#piki = new SessionPiki({
      binding, config, sandbox: this.sandbox, onHost: this.#onHost, sandboxed: !!this.#egress, calls: this.#calls, hostCommands: this.hostCommands,
      wholeResults: this.#wholeResults, operations: this.#operations, apiLease: () => this.#egress?.apiLease(), forgeWrites: senderId => this.#availability.forgeWrites(senderId), model: () => this.#currentModel ?? this.modelRef,
      thinkingLevel: () => this.#currentModel?.thinkingLevel, extensionChoice: () => this.extensionChoice(), metadata: () => this.metadata(),
      mutate: change => this.mutate(change), hostConfig: () => this.hostConfig(), extensionProcess: this.extensionProcess(),
    });
    this.#repositories = new SessionRepositories({
      grant: () => this.#egress!.grant(), cached: !!config.repositoryCache, mirror: (repository, onProgress) => this.mirror(repository, onProgress),
      workspace: () => isolatedWorkspace(this.sandbox), authorize: async () => { await this.authorize(this.binding.owner.id, "write"); },
      changed: () => this.#activity?.changed(), exclusive: operation => this.exclusive(operation),
      opened: () => this.#opened, closing: () => this.closing, resumed: () => this.#resumed, resume: () => this.resumeWork(),
    });
    const report = config.reportActivity;
    this.#activity = report && new ActivityReporter(() => this.activity(), async activity => {
      await this.markWork(activity).catch(() => {});
      await report(binding.session.id, activity);
      if (activity !== "working") this.reportBranches();
    });
  }

  private async markWork(activity: SessionActivity): Promise<void> {
    const marker = join(this.directory, WORK_MARKER);
    if (activity !== "working" && activity !== "waiting") return rm(marker, { force: true });
    const file = await open(marker, constants.O_CREAT | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
    await file.close();
  }

  private async requestGrant(): Promise<EgressGrant> {
    const sessionId = this.binding.session.id;
    return parseEgressGrant(this.config.egressGrant ? await this.config.egressGrant(sessionId) : await this.controlPlane("/api/internal/network", { sessionId }));
  }

  private egressProxy(socketPath: string, token?: string): EgressProxy {
    return new EgressProxy({
      socketPath,
      ...(token ? { tcp: { token } } : {}),
      grant: () => this.requestGrant(),
      relay: request => this.relay(request),
      apiCredential: (host, access) => this.config.apiCredential ? this.config.apiCredential(this.binding.session.id, host, access)
        : this.controlPlane("/api/internal/api/credential", { sessionId: this.binding.session.id, host, ...(access === "write" ? { access } : {}) }),
      ...(this.#clone && this.config.repositoryCache ? { mirror: (repository: EgressRepository, onProgress: (progress: MirrorProgress) => void) => this.mirror(repository, onProgress) } : {}),
      ...(this.#clone ? { sessionBranch: sessionBranch(this.binding.session) } : {}),
      fakeIpTunnels: async () => (await this.hostConfig()).fakeIpTunnels,
    });
  }

  private async relay(request: RelayRequest): Promise<Response> {
    const sessionId = this.binding.session.id;
    try {
      const direct = await this.#direct?.forward(request);
      if (direct) return direct;
      return await (this.config.gitRelay ? this.config.gitRelay(sessionId, request)
        : relayGitRequest(this.config.fetch ?? fetch, `${this.config.controlPlaneUrl}${relayPath("/api/internal", sessionId, request)}`,
          { authorization: `Bearer ${this.config.sharedSecret}` }, request, AbortSignal.timeout(60 * 60 * 1000)));
    } catch (error) {
      if (egressReadServices.includes(request.service) && refused(error)) this.#mirrors?.forget(request.bindingId);
      throw error;
    }
  }

  private async mirrorMounts(): Promise<MirrorMount[]> {
    return this.#mirrors ? this.#mirrors.mounts() : [];
  }

  private mirror(repository: EgressRepository, onProgress?: (progress: MirrorProgress) => void): Promise<string> {
    if (!this.#mirrors) throw new RunnerError(409, "This host keeps no repository cache");
    return this.#mirrors.mirror(repository, onProgress);
  }

  private assertTicket(ticket: RunnerTicket): void {
    if (ticket.sessionId !== this.binding.session.id || ticket.ownerId !== this.binding.owner.id || ticket.connectorId !== this.config.connectorId)
      throw new RunnerError(403, "Ticket session, owner, or connector mismatch");
  }

  async authorize(actorId: string, permission: Permission, expectedPolicyVersion?: number, host = false, hostSessions = false, archived = false): Promise<AuthorizationResult> {
    const body: AuthorizationRequest = { sessionId: this.binding.session.id, ownerId: this.binding.owner.id, actorId, permission,
      ...(host ? { host: true } : {}), ...(host && hostSessions ? { hostSessions: true } : {}), ...(archived ? { archived: true } : {}) };
    let result: AuthorizationResult;
    try {
      if (this.config.authorize) result = await this.config.authorize(body);
      else {
        const response = await (this.config.fetch ?? fetch)(`${this.config.controlPlaneUrl}/api/internal/authorize`, {
          method: "POST", headers: { authorization: `Bearer ${this.config.sharedSecret}`, "content-type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(1500), redirect: "error",
        });
        if (!response.ok) throw new RunnerError(403, "Authorization denied");
        result = await response.json() as AuthorizationResult;
      }
    } catch (error) {
      if (error instanceof RunnerError) throw error;
      throw new RunnerError(503, "Authorization authority unavailable");
    }
    if (!result.allowed || result.ownerId !== this.binding.owner.id || !Number.isSafeInteger(result.policyVersion)
      || (expectedPolicyVersion !== undefined && result.policyVersion !== expectedPolicyVersion)) throw new RunnerError(403, "Authorization revoked or stale policy");
    return result;
  }

  async prepareRestore(manifest: RestoreManifest, { conversationOnly = false }: { conversationOnly?: boolean } = {}): Promise<void> {
    await this.initializeRepositories();
    const resolved = this.config.resolveModels ? await this.config.resolveModels(this.binding.model)
      : { models: runnerModels(this.binding.model, this.config.allowFaux) };
    const storage = await this.openStorage();
    let harness: Harness;
    try { harness = await Harness.open(storage, { models: resolved.models, registry: createRegistry() }, context); }
    catch (error) { await storage.close(context); throw error; }
    try {
      const graph = await harness.watchTaskGraph(context);
      try { if (Object.keys(graph.value.tasks).length) throw new RunnerError(409, "Snapshot contains incomplete durable tasks"); }
      finally { await graph.stop(); }
      const root = await harness.root(context);
      await root.commit(async tx => {
        const doc = await tx.doc(RunnerState);
        if (!doc.json) throw new RunnerError(400, "Snapshot lacks runner metadata");
        const state: Metadata = JSON.parse(doc.json);
        if (stableJson(state) !== stableJson(manifest)) throw new RunnerError(400, "Snapshot manifest and SQLite metadata disagree");
        let cursor: Cursor | undefined;
        do {
          const page = await tx.scanConversations({}, 100, cursor);
          for (const conversation of page.items) {
            if ((await tx.doc(InboxDoc, conversation.id)).items.length) throw new RunnerError(409, "Snapshot contains queued pi input");
          }
          cursor = page.next;
        } while (cursor);
        if (Object.values(state.runs).some(run => !["settled", "interrupted"].includes(run.status))
          || Object.values(state.approvals).some(approval => approval.status === "executing"))
          throw new RunnerError(409, "Snapshot is not idle");
        state.binding = this.binding;
        state.usedTickets = {};
        state.toolActors = {};
        delete state.grants;
        if (conversationOnly) state.conversationOnlyRestore = true;
        else delete state.conversationOnlyRestore;
        for (const run of Object.values(state.runs)) delete run.admissionId;
        for (const approval of Object.values(state.approvals)) {
          approval.sessionId = this.binding.session.id;
          delete approval.admissionId;
          delete approval.reviewHash;
          if (approval.status === "pending") {
            approval.status = "interrupted";
            approval.result = "Restored history only; fresh approval is required for any new operation.";
          }
        }
        doc.json = JSON.stringify(state);
      }, context);
    } finally { await harness.close(context); }
  }

  private async initializeRepositories(): Promise<void> {
    await this.sandbox.initialize();
  }

  private agentInstructions(mode: InstructionsMode, off: ReadonlySet<string> = new Set(), browserUnavailable?: BrowserUnavailableReason,
    tunnelUnavailable?: TunnelUnavailableReason, kindsOff: ReadonlySet<DocumentKind> = new Set(), extensionTools: ReadonlySet<string> = new Set()): string {
    return agentInstructions({ base: this.binding.agent.instructions, agentTools: sessionToolNames(this.binding.agent.tools), mode, off, browserUnavailable, tunnelUnavailable, kindsOff,
      extensionTools, clone: this.#clone, sandboxed: !!this.#egress, branch: sessionBranch(this.binding.session), cloneRepositories: this.#cloneRepositories,
      lfsRepositories: this.#lfsRepositories, cloneFailures: this.#repositories.cloneFailures, definitions: this.#defined.definitions, sources: this.#sources,
      conversationOnlyRestore: this.#conversationOnlyRestore, tools: this.tools.map(tool => tool.name), missing: mode !== "ask" ? this.#availability.missingPrograms(off) : [],
      linuxSandbox: !!this.#availability.linuxSandbox(), nodeBin: !!this.sandbox.nodeBin, codemode: !!this.#builtins, browser: !!this.sandbox.browser,
      sudo: mode !== "ask" && this.#sudoOffered });
  }

  private async sudoAllowed(): Promise<boolean> {
    if (!this.#sudo || !this.config.extensions || this.closing) return false;
    const answer = await this.config.extensions.workspace(this.binding.session.workspaceId).catch(() => undefined);
    if (!answer) return false;
    this.#sudoOffered = answer.ownerPrivate === true;
    return this.#sudoOffered && !this.closing;
  }

  get packed(): boolean { return this.#packed; }

  async open(): Promise<void> {
    this.#packed = await isPacked(this.directory);
    if (!this.#packed) await this.#egress?.start();
    try { await this.openHarness(); }
    catch (error) {
      await this.#egress?.close().catch(() => {});
      throw error;
    }
  }

  private async openHarness(): Promise<void> {
    if (!this.#packed) await this.initializeRepositories();
    if (this.#packed) {
    } else if (this.#clone && !this.#egress) {
      const grant = await this.requestGrant().catch(() => null);
      this.branchReports()?.useRepositories(grant?.repositories ?? []);
      this.#cloneRepositories = (grant?.repositories ?? []).map(repository => bindingRemote(repository));
      this.#sources = grant?.sources ?? [];
    } else if (this.#clone) {
      const grant = await this.#egress!.grant().catch(() => null);
      const repositories = grant?.repositories ?? [];
      this.#sources = grant?.sources ?? [];
      this.#cloneRepositories = repositories.map(repository => bindingRemote(repository));
      this.#lfsRepositories = repositories.filter(repository => repository.lfs).map(repository => bindingRemote(repository));
      await this.#mirrors?.restore(repositories);
      this.#repositories.clearFailures();
      if (await lstat(join(this.directory, "sandbox", "git", "pikibun-clones", "manifest.json")).then(() => true, () => false)) {
        const pending = await isolatedWorkspace(this.sandbox).clonePending(async () => {});
        if (pending.length) this.#repositories.prepareClones(pending);
      }
    }
    const registry = createRegistry();
    const own = this.buildTools();
    this.tools = [...own, ...await this.#defined.load(own.map(tool => tool.name))];
    const extension = defineExtension({ name: "workspace-tools", tools: this.tools, hooks: [renamedToolsHook()] });
    this.#extension = extension;
    registry.install(extension);
    this.#registry = registry;
    if (!this.#packed) {
      this.#builtins = new SessionBuiltins({ outputs: api => this.#calls.outputFiles(api) });
      for (const builtin of this.#builtins.extensions.values()) registry.install(builtin);
    }
    if (this.config.extensions && !this.#packed) {
      this.#hostExtensions = new SessionExtensions(this.#piki.host(), this.tools.map(tool => tool.name));
      await this.chosenExtensions().catch(() => []);
    }
    const resolved = this.config.resolveModels ? await this.config.resolveModels(this.binding.model)
      : { models: runnerModels(this.binding.model, this.config.allowFaux), provider: this.binding.model.provider, modelId: this.binding.model.modelId };
    this.modelRef = { provider: resolved.provider, modelId: resolved.modelId };
    this.models = resolved.models;
    const models = this.models;
    await this.hostConfig();
    const catalog = models.getModels();
    let current: { from: HostCompaction | undefined; settings: { compaction: CompactionSettings } | undefined } | undefined;
    const settings = () => {
      if (!current || current.from !== this.#configuredCompaction) {
        const compaction = hostCompaction(configuredCompaction(this.config.compaction, this.#configuredCompaction), catalog);
        current = { from: this.#configuredCompaction, settings: compaction ? { compaction } : undefined };
      }
      return current.settings;
    };
    this.#compaction = () => settings()?.compaction;
    const storage = await this.openStorage();
    try {
      this.harness = await Harness.open(storage, { models, registry, settings,
        ...(this.config.identity ? { identity: this.config.identity } : {}) }, context);
    }
    catch (error) { await storage.close(context); throw error; }
    this.#failed = false;
    const harness = this.harness;
    void harness.closed.then(end => { if (end.kind === "failed" && harness === this.harness) this.#failed = true; });
    this.root = await this.harness.root(context, { agent: {
      model: this.modelRef, ...(resolved.thinkingLevel ? { thinkingLevel: resolved.thinkingLevel } : {}), extensions: [extension],
      tools: this.tools, instructions: this.agentInstructions("write"),
    } });
    await this.root.commit(async tx => {
      const doc = await tx.doc(RunnerState);
      if (!doc.json) doc.json = JSON.stringify({ binding: this.binding, branches: [{ id: this.root.id, mode: "write" }], runs: {}, approvals: {}, toolActors: {} } satisfies Metadata);
      const state: Metadata = JSON.parse(doc.json);
      if (stableJson(state.binding) !== stableJson(this.binding)) throw new RunnerError(409, "Persisted binding mismatch");
      this.#conversationOnlyRestore = state.conversationOnlyRestore === true;
      for (const approval of Object.values(state.approvals)) {
        if (approval.status === "executing") {
          approval.status = "interrupted";
          approval.result = "Execution interrupted; external effect may have occurred. Reconcile manually; never automatically retry.";
        }
        if (approval.status === "pending" && (approval.operation.kind === "permission" || approval.id.startsWith("tool-"))) {
          approval.status = "interrupted";
          approval.result = "The tool call stopped before a decision.";
        }
      }
      doc.json = JSON.stringify(state);
    }, context);
    this.#shared = await this.sharedConversation();
    await this.noteCurrentModel(this.#shared);
    this.closing = false;
    this.#opened = true;
    void this.#hostExtensions?.sessionStart().catch(() => {});
    if (this.#repositories.status === "ready" && !this.#frozen && !this.#packed) await this.resumeWork();
    if (this.#frozen) {
      await this.mutate(meta => {
        for (const run of Object.values(meta.runs)) if (["queued", "admitting", "running"].includes(run.status)) run.status = "interrupted";
        for (const card of Object.values(meta.approvals)) {
          if (card.status === "pending") Object.assign(card, { status: "interrupted", result: "This session is read-only now; nothing in it runs." });
        }
      });
      await this.#queue.sweepInputs();
    }
    if (!this.#frozen && !this.#packed) {
      for (const run of Object.values((await this.metadata()).runs)) if (run.screening && run.status === "queued") void this.#queue.screen(run.key);
    }
    this.#activity?.start();
  }

  private async resumeWork(): Promise<void> {
    this.#resumed = true;
    const state = await this.metadata();
    for (const run of Object.values(state.runs)) {
      if (run.status !== "running" && run.status !== "admitting") continue;
      try { await this.authorize(run.initiatedBy, run.mode === "ask" ? "ask" : "write"); }
      catch {
        const conversation = await this.harness.conversation(run.conversationId as ConversationId, context);
        await conversation?.abort(context);
        await this.mutate(meta => { meta.runs[run.key]!.status = "interrupted"; });
        continue;
      }
      const conversation = await this.harness.conversation(run.conversationId as ConversationId, context);
      if (!conversation) throw new Error("Persisted branch is missing");
      let submission;
      if (run.submissionId === undefined) {
        const content = await this.#queue.runInput(run);
        if (content === undefined) {
          await this.#queue.endLostInputs(run.key);
          continue;
        }
        if (run.steered !== undefined) {
          try { submission = await conversation.submit({ type: "input", content, requestId: submissionRequestId(run), whenBusy: "steer", whenIdle: "reject" }, context); }
          catch (error) {
            if (!(error instanceof ConversationIdle)) throw error;
            await this.mutate(meta => { requeue(meta.runs[run.key]!); });
            continue;
          }
        } else {
          await this.applyOptions(conversation, run, content);
          submission = await conversation.submit({ type: "input", content, requestId: submissionRequestId(run) }, context);
        }
      } else submission = await this.harness.submission(run.submissionId as SubmissionId, context);
      if (submission) {
        await this.mutate(meta => { const saved = meta.runs[run.key]!; saved.submissionId = submission.id; saved.status = "running"; });
        this.#queue.observe(run.key, submission.id);
      }
    }
    if (Object.values(state.runs).some(run => run.stopped?.pending)) await this.abortStopped();
    await this.#queue.sweepInputs();
    this.harness.resume();
    this.drainQueue();
  }

  private openStorage(): Promise<Storage> {
    return (this.config.openStorage ?? openNodeSqliteStorage)(this.sqlitePath);
  }

  get failed(): boolean {
    return this.#failed || this.#recovery !== undefined;
  }

  recover(): Promise<void> {
    this.#recovery ??= this.exclusive(async () => {
      if (!this.#failed) return;
      await this.close({ abortPushes: false });
      try { await this.open(); }
      catch (error) {
        this.#failed = true;
        throw error;
      }
    }).finally(() => { this.#recovery = undefined; });
    return this.#recovery;
  }

  private async sharedConversation(): Promise<Conversation> {
    const branch = (await this.metadata()).branches.find(item => item.mode === "write" && !item.superseded);
    if (!branch || branch.id === this.root.id) return this.root;
    const conversation = await this.harness.conversation(branch.id as ConversationId, context);
    if (!conversation) throw new Error("Persisted shared conversation is missing");
    return conversation;
  }

  private async metadata(): Promise<Metadata> {
    const doc = await this.harness.snapshot(RunnerState, context);
    if (!doc?.json) throw new Error("Missing trusted runner metadata");
    return JSON.parse(doc.json) as Metadata;
  }

  private async mutate(change: (state: Metadata) => void): Promise<void> {
    await this.root.commit(async tx => {
      const doc = await tx.doc(RunnerState);
      const state = JSON.parse(doc.json) as Metadata;
      change(state);
      doc.json = JSON.stringify(state);
    }, context);
    this.#activity?.changed();
  }

  private branchReports(): BranchReports | undefined {
    const send = this.config.reportBranches;
    if (!send || !this.#onHost || !this.#clone) return undefined;
    this.#branchReports ??= new BranchReports({ sessionId: this.binding.session.id, send, closing: () => this.closing,
      repositories: async () => (await this.requestGrant()).repositories,
      clones: () => (this.sandbox as HostWorkspace).cloneBranches(async () => {}) });
    return this.#branchReports;
  }

  private reportBranches(): void {
    this.branchReports()?.request();
  }

  private async activity(): Promise<SessionActivity> {
    const preparation = this.#repositories.status;
    if (preparation !== "ready") return preparation === "preparing" ? "working" : "failed";
    if (this.#sudo?.waiting()) return "waiting";
    const state = await this.metadata();
    const runs = Object.values(state.runs).filter(tellsActivity);
    const approvals = Object.values(state.approvals);
    const activity = sessionActivity(runs, approvals);
    if (activity !== "done") return activity;
    const watch = await this.#shared.watch(context);
    let last: EntryRecord | undefined;
    try { last = watch.value.entries.at(-1); }
    finally { await watch.stop(); }
    return sessionActivity(runs, approvals, activityEntry(last));
  }

  exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.lock.then(operation, operation);
    this.lock = next.catch(() => undefined);
    return next;
  }

  private drainQueue(): void {
    this.#queue.drain();
  }

  private async applyOptions(conversation: Conversation, run: Run, content?: string | ({ type: "text"; text: string } | { type: "image"; data: string; mimeType: string })[]): Promise<void> {
    let options = run.options ?? {};
    if (options.auto) {
      const chosen = run.auto ?? await this.chooseAutoModel(conversation, run, options.auto, content);
      const { auto: _, ...rest } = options;
      options = { ...rest, ...(chosen ? { model: { provider: chosen.provider, modelId: chosen.modelId }, ...(chosen.thinkingLevel ? { thinkingLevel: chosen.thinkingLevel } : {}) } : {}) };
    }
    const extensions = run.mode === "write" ? await this.chosenExtensions().catch(() => []) : [];
    if (run.mode === "write") await this.#defined.refresh(extensions.flatMap(extension => extension.tools.map(tool => tool.name)));
    const off = run.mode === "write" ? await this.#availability.sessionToolsOff(run.initiatedBy) : new Set<string>();
    if (run.mode === "write") await this.#sudo?.prepare();
    const own = new Set(this.tools.map(tool => tool.name));
    const kindsOff = run.mode === "write" ? await this.#availability.documentKindsOff() : new Set<DocumentKind>();
    const browserUnavailable = run.mode === "write" && !off.has("browser") ? this.#availability.browserUnavailable() : undefined;
    if (!this.sandbox.browser) off.add("browser");
    const tunnelUnavailable = run.mode === "write" && !off.has("tunnel") ? this.#availability.tunnelUnavailable() : undefined;
    if (!this.#availability.tunnelOffered()) off.add("tunnel");
    const builtins = run.mode === "write" && this.#builtins
      ? this.#builtins.select((await this.hostConfig()).builtinExtensions, new Set(extensions.flatMap(item => item.tools.map(tool => tool.name)))).map(item => item.extension)
      : [];
    const change: AgentChange = {
      ...(options.model ? { model: { provider: options.model.provider, modelId: options.model.modelId } } : {}),
      ...(options.thinkingLevel ? { thinkingLevel: options.thinkingLevel } : {}),
      ...(run.mode === "write" ? {
        tools: [...this.tools.filter(tool => !off.has(tool.name)), ...extensions.flatMap(extension => extension.tools).filter(tool => !own.has(tool.name)),
          ...builtins.flatMap(extension => extension.tools ?? [])],
        extensions: [this.#extension, ...this.#defined.extensions, ...extensions.map(extension => extension.extension), ...builtins],
        instructions: this.agentInstructions(options.access === "read" ? "read" : "write", off, browserUnavailable, tunnelUnavailable, kindsOff,
          new Set(extensions.flatMap(extension => extension.tools.map(tool => tool.name)).filter(name => !own.has(name)))),
      } : {}),
    };
    if (Object.keys(change).length) await conversation.configure(change, context);
    if (run.mode === "write") await this.noteCurrentModel(conversation);
    if (run.mode !== "write" || !this.#hostExtensions?.extensions.length) return;
    const text = typeof content === "string" ? content : (content ?? []).flatMap(part => part.type === "text" ? [part.text] : []).join("\n");
    const images = typeof content === "string" ? [] : (content ?? []).flatMap(part => part.type === "image" ? [{ type: "image" as const, data: part.data, mimeType: part.mimeType }] : []);
    const prompts = extensions.length ? await this.#hostExtensions.beforeAgentStart(text, images.length ? images : undefined).catch(() => ({})) : {};
    await conversation.commit(async tx => { (await tx.doc(ExtensionPrompts, conversation.id)).prompts = prompts; }, context);
  }

  private async chooseAutoModel(conversation: Conversation, run: Run, request: true | AutoModelRequest,
    content?: string | ({ type: "text"; text: string } | { type: "image"; data: string; mimeType: string })[]): Promise<AutoRunChoice | undefined> {
    if (request === true) return undefined;
    const active = await conversation.context(context).catch(() => undefined);
    const previous = [...(active?.messages ?? [])].reverse().find(message => message.role === "user");
    const agent = await conversation.agent(context).catch(() => undefined);
    const named = agent?.model && request.candidates.find(item => item.provider === agent.model!.provider && item.modelId === agent.model!.modelId);
    const level = agent?.thinkingLevel && thinkingLevels.includes(agent.thinkingLevel as ThinkingLevel) ? agent.thinkingLevel as ThinkingLevel : undefined;
    const current = agent?.model ? { provider: agent.model.provider, modelId: agent.model.modelId, ...(named ? { name: named.name } : {}), ...(level ? { thinkingLevel: level } : {}) } : undefined;
    const task = typeof content === "string" ? content : (content ?? []).flatMap(part => part.type === "text" ? [part.text] : []).join("\n");
    const chosen = await chooseAutoModel(this.models, request, { task, ...(previous ? { previous: messageText(previous.content) } : {}), ...(current ? { current } : {}) })
      .catch(() => undefined);
    await this.mutate(meta => {
      const saved = meta.runs[run.key];
      if (!saved) return;
      if (chosen) saved.auto = chosen;
      if (saved.options?.auto) saved.options = { ...saved.options, auto: true };
    });
    return chosen;
  }

  private async noteCurrentModel(conversation: Conversation): Promise<void> {
    const agent = await conversation.agent(context).catch(error => {
      process.stderr.write(`Session ${this.binding.session.id}: cannot read the conversation's model for its extensions: ${String(error instanceof Error ? error.message : error).replace(/[\x00-\x1f]/g, " ").slice(0, 500)}\n`);
      return undefined;
    });
    this.#currentModel = agent?.model
      ? { provider: agent.model.provider, modelId: agent.model.modelId, ...(agent.thinkingLevel ? { thinkingLevel: agent.thinkingLevel } : {}) }
      : undefined;
  }

  private async extensionChoice(): Promise<{ chosen: ChosenExtension[]; automaticTools: boolean; missingRequired: string[]; unknownRequired: boolean }> {
    const config = this.config.extensions;
    if (!config) return { chosen: [], automaticTools: false, missingRequired: [], unknownRequired: false };
    const answer = await config.workspace(this.binding.session.workspaceId).catch(() => ({ extensions: [], automaticTools: false }));
    const known = await this.requiredExtensions();
    const required = known ?? [];
    const installed = config.installed().map(item => item.summary);
    return { chosen: sessionExtensions(answer.extensions, installed, { ownerId: this.binding.owner.id, connectorOwnerId: this.binding.session.connectorOwnerId }, required),
      automaticTools: answer.automaticTools, missingRequired: missingRequiredExtensions(required, installed), unknownRequired: !known };
  }

  private extensionProcess(): ExtensionHost["extensionProcess"] {
    const sandbox = this.sandbox;
    if (!(sandbox instanceof Sandbox)) return undefined;
    const nodeBin = sandbox.nodeBin;
    if (!nodeBin) return () => refusedChannel("Extensions can't run in this session's sandbox: the host's Node.js can't be given to it.");
    return warn => new ProcessChannel({ directory: sandbox.worktree, warn, mountAllowed: path => sandbox.bindAllowed(path), launch: sandboxLaunch({
      socketDirectory: serviceSocketDirectory(`${this.binding.session.id}\0extensions`, this.directory), nodeBin, worktree: sandbox.worktree,
      start: async (command, binds, onOutput, signal) => {
        const config = await this.hostConfig();
        return sandbox.startService(command, async () => {}, { limits: serviceLimits(serviceLifetimeLimits.max, availableParallelism()), unbounded: true, gpu: config.gpu,
          socketDirectory: serviceSocketDirectory(`${this.binding.session.id}\0extensions`, this.directory), onOutput, signal, binds });
      } }) });
  }

  private sessionTunnel(): SessionTunnel {
    if (this.#tunnel) return this.#tunnel;
    const sandbox = this.sandbox as Sandbox;
    const tunnels = this.config.tunnels!;
    const sockets = serviceSocketDirectory(this.binding.session.id, this.directory);
    const report = this.config.reportTunnel;
    this.#tunnel = new SessionTunnel({
      startService: async (serve, onOutput, signal) => {
        const config = await this.hostConfig();
        return sandbox.startService(serviceShellCommand(serve, { nodeBin: sandbox.nodeBin }), async () => {}, {
          limits: serviceLimits(config.serviceLifetimeSeconds, availableParallelism()),
          unbounded: true, gpu: config.gpu, socketDirectory: sockets, onOutput, signal });
      },
      openTunnel: async (signal, access) => tunnels.open(pinServiceSocket(sockets), signal, access),
      lifetimeMs: async () => (await this.hostConfig()).serviceLifetimeSeconds * 1000,
      report: async item => { await report?.({ sessionId: this.binding.session.id, ...item }); },
      recheck: async actorId => { await this.authorize(actorId, "write"); },
      changed: () => this.#activity?.changed(),
    });
    return this.#tunnel;
  }

  async sudoAction(ticket: RunnerTicket, input: unknown): Promise<{ answered: boolean }> {
    this.assertTicket(ticket);
    let answer;
    try { answer = parseSudoAnswer(input); }
    catch (error) { throw new RunnerError(400, error instanceof Error ? error.message : "Invalid sudo answer"); }
    await this.authorize(ticket.actorId, "write", ticket.policyVersion);
    if (!this.#sudo || ticket.actorId !== this.binding.session.connectorOwnerId) throw new RunnerError(403, "Only the host's owner answers sudo on it, in their own sessions");
    if (answer.password !== undefined && !await this.sudoAllowed()) throw new RunnerError(403, "sudo takes a password only in sessions of the host owner's private workspace");
    await this.consumeTicket(ticket);
    return { answered: this.#sudo.answer(answer.id, answer.password) };
  }

  async tunnelAction(ticket: RunnerTicket, input: unknown): Promise<{ stopped: boolean; url?: string }> {
    this.assertTicket(ticket);
    if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).some(key => key !== "action" && key !== "reason")
      || (input as { action?: unknown }).action !== "stop" || ![undefined, "archived"].includes((input as { reason?: unknown }).reason as string | undefined)) {
      throw new RunnerError(400, "Invalid tunnel request");
    }
    await this.authorize(ticket.actorId, "write", ticket.policyVersion);
    if (!this.#tunnel) return { stopped: false };
    return this.#tunnel.stop((input as { reason?: string }).reason === "archived" ? "archived" : "stop", ticket.actorId);
  }

  private async chosenExtensions(): Promise<SessionExtension[]> {
    const host = this.#hostExtensions;
    const config = this.config.extensions;
    if (!host || !config) return [];
    const { chosen } = await this.extensionChoice();
    await this.openExtensions(chosen.map(item => item.source));
    const { selected, created } = host.select(chosen.map(item => item.source));
    for (const extension of created) this.#registry?.install(extension);
    return selected;
  }

  private async chatOptions(input: unknown, mode: "write" | "ask"): Promise<ChatOptions | undefined> {
    if (input === undefined) return undefined;
    const invalid = (message = "Invalid chat options") => new RunnerError(422, message);
    if (!input || typeof input !== "object" || Array.isArray(input)) throw invalid();
    const value = input as Record<string, unknown>;
    if (Object.keys(value).some(key => !["model", "thinkingLevel", "access", "autoMerge", "auto"].includes(key))) throw invalid();
    const options: ChatOptions = {};
    if (value.auto !== undefined) {
      if (value.model !== undefined || value.thinkingLevel !== undefined) throw invalid("Auto chooses the model and reasoning");
      options.auto = autoModelRequest(value.auto, invalid);
    }
    if (value.model !== undefined) {
      const model = value.model as Record<string, unknown>;
      if (!model || typeof model !== "object" || Object.keys(model).some(key => key !== "provider" && key !== "modelId")
        || typeof model.provider !== "string" || typeof model.modelId !== "string" || !model.provider || !model.modelId
        || model.provider.length > 128 || model.modelId.length > 256) throw invalid();
      const requested = { provider: model.provider, modelId: model.modelId };
      const binding = this.binding.model;
      if (this.config.resolveModels) {
        const resolved = await this.config.resolveModels({ ...binding, provider: requested.provider, modelId: requested.modelId })
          .catch(() => { throw invalid("Model is not available on this host"); });
        if (resolved.provider !== requested.provider || resolved.modelId !== requested.modelId) throw invalid("Model is not available on this host");
        if (value.thinkingLevel === undefined && resolved.thinkingLevel) options.thinkingLevel = resolved.thinkingLevel;
      } else if (requested.provider !== binding.provider || requested.modelId !== binding.modelId) throw invalid("This runner serves only the session's pinned model");
      options.model = requested;
    }
    if (value.thinkingLevel !== undefined) {
      if (!thinkingLevels.includes(value.thinkingLevel as never)) throw invalid();
      const target = options.model ?? (await this.#shared.agent(context)).model ?? this.modelRef;
      const model = this.models.getModel(target.provider, target.modelId);
      if (!model || !getSupportedThinkingLevels(model).includes(value.thinkingLevel as never)) throw invalid("Reasoning level is not supported by the model");
      options.thinkingLevel = value.thinkingLevel as ChatOptions["thinkingLevel"];
    }
    if (value.access !== undefined) {
      if (!accessModes.includes(value.access as never) || mode !== "write") throw invalid();
      if (value.access === "read") options.access = "read";
    }
    if (value.autoMerge !== undefined && typeof value.autoMerge !== "boolean") throw invalid();
    return Object.keys(options).length ? options : undefined;
  }

  private async requiredExtensions(): Promise<RequiredExtension[] | undefined> {
    if (this.config.requiredExtensions) return this.config.requiredExtensions();
    return (await this.hostConfig()).requiredExtensions;
  }

  private async requiredRefusal(open: boolean): Promise<string | undefined> {
    const host = this.#hostExtensions;
    if (!host || !this.config.extensions) return undefined;
    const { chosen, missingRequired, unknownRequired } = await this.extensionChoice();
    const log = (line: string) => { process.stderr.write(`Session ${this.binding.session.id}: ${line.replace(/[\x00-\x1f\x7f]/g, " ").slice(0, 500)}\n`); };
    if (unknownRequired) {
      log("refused a message: the connector hasn't heard from Pikibun which extensions this host's owner requires");
      return REQUIRED_UNKNOWN;
    }
    if (missingRequired.length) {
      log(`refused a message: this host requires ${missingRequired.join(", ")}, which it can't run`);
      return REQUIRED_MISSING;
    }
    if (!open) return undefined;
    await this.openExtensions(chosen.map(item => item.source));
    const closed = chosen.filter(item => item.required && !host.isOpen(item.source)).map(item => item.source);
    if (!closed.length) return undefined;
    log(`refused a message: this session couldn't open ${closed.join(", ")}, which this host requires`);
    return REQUIRED_MISSING;
  }

  private async extensionGate(): Promise<{ screen: boolean }> {
    const config = this.config.extensions;
    if (!this.#hostExtensions || !config) return { screen: false };
    const refusal = await this.requiredRefusal(false);
    if (refusal) throw new RunnerError(422, refusal);
    const { chosen } = await this.extensionChoice();
    const installed = config.installed();
    return { screen: chosen.some(item => installed.some(candidate => candidate.summary.source === item.source && candidate.summary.modules.some(module => module.events.includes("input")))) };
  }

  private openExtensions(sources: readonly string[]): Promise<void> {
    const host = this.#hostExtensions;
    const config = this.config.extensions;
    if (!host || !config) return Promise.resolve();
    const installed = config.installed();
    const open = this.#opening.then(() => host.ensure(sources.flatMap(source => installed.filter(candidate => candidate.summary.source === source))));
    this.#opening = open.catch(() => {});
    return open;
  }

  private async requireImageModel(options: ChatOptions | undefined): Promise<void> {
    const target = options?.model ?? (await this.#shared.agent(context)).model ?? this.modelRef;
    const model = this.models.getModel(target.provider, target.modelId);
    if (model && Array.isArray(model.input) && !model.input.includes("image")) throw new RunnerError(422, "The model doesn't accept images");
  }

  private requireUnfrozen(): void {
    if (this.#frozen) throw new RunnerError(409, "This session pinned its repositories when it started, which sessions no longer do; it is read-only");
  }

  async submit(ticket: RunnerTicket, input: SubmitInput, mode: "write" | "ask"): Promise<SubmitResult> {
    this.assertTicket(ticket);
    this.requireUnfrozen();
    const parsed: ReturnType<typeof parseChatImages> = input?.images === undefined ? { images: [] } : parseChatImages(input.images);
    if ("error" in parsed) throw new RunnerError(400, "Invalid submission images");
    const images = parsed.images;
    if (typeof input?.content !== "string" || input.content.length > 100_000 || (!input.content.trim() && !images.length)
      || typeof input.requestId !== "string" || !input.requestId || input.requestId.length > 200) throw new RunnerError(400, "Invalid submission");
    if ((input.admissionId !== undefined && (mode !== "write" || typeof input.admissionId !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(input.admissionId)))
      || (this.config.connectorId && mode === "write" && input.admissionId === undefined))
      throw new RunnerError(400, "Invalid or missing Worker write admission");
    const prepared = images.length ? await prepareMessageImages(images) : [];
    const content = input.content;
    const { screen } = await this.extensionGate();
    return this.exclusive(async () => {
      if (this.closing) throw new RunnerError(503, "Session is closing");
      const preparation = this.#repositories.preparation;
      if (preparation.status === "failed") throw new RunnerError(502, preparationFailure(preparation.reason));
      await this.authorize(ticket.actorId, mode === "ask" ? "ask" : "write", ticket.policyVersion);
      await this.hostConfig();
      const options = await this.chatOptions(input.options, mode);
      if (prepared.length) await this.requireImageModel(options);
      const key = await requestKey(ticket.actorId, mode, input.requestId);
      const hash = await messageHash(input.content, images);
      const state = await this.metadata();
      const existing = state.runs[key];
      if (existing) {
        if (existing.contentHash !== hash) throw new RunnerError(409, "requestId reused with different content");
        if (existing.admissionId !== input.admissionId) throw new RunnerError(409, "requestId reused with a different Worker admission");
        if (stableJson(comparableOptions(existing.options)) !== stableJson(comparableOptions(options))) throw new RunnerError(409, "requestId reused with different chat options");
        return { submissionId: key, conversationId: String(existing.conversationId), status: existing.status };
      }
      if (Object.values(state.runs).filter(run => ["queued", "running", "admitting"].includes(run.status)).length >= 64)
        throw new RunnerError(429, "Session queue is full");
      const queuedBytes = Object.values(state.runs).filter(run => ["queued", "running", "admitting"].includes(run.status))
        .reduce((total, run) => total + Buffer.byteLength(run.content, "utf8"), 0);
      if (queuedBytes + Buffer.byteLength(content, "utf8") > 1024 * 1024) throw new RunnerError(429, "Session queued content limit exceeded");
      if (Object.values(state.runs).reduce((total, run) => total + Buffer.byteLength(run.content, "utf8"), 0) + Buffer.byteLength(content, "utf8") > 32 * 1024 * 1024)
        throw new RunnerError(429, "Session durable request content limit exceeded");
      if (Object.keys(state.runs).length >= 10_000) throw new RunnerError(429, "Session durable request ledger is full");
      const imageBytes = prepared.reduce((total, image) => total + image.data.length, 0);
      if (imageBytes && Object.values(state.runs).filter(run => run.submissionId === undefined && ["queued", "running", "admitting"].includes(run.status))
        .reduce((total, run) => total + (run.images?.bytes ?? 0), 0) + imageBytes > MAX_QUEUED_IMAGE_BYTES) throw new RunnerError(429, "Session queued image limit exceeded");
      if (prepared.length) await this.#inputs.write(key, prepared);
      const shared = this.#shared;
      let conversation = shared;
      if (mode === "ask") {
        const transcript = await shared.context(context);
        const head = transcript.entries.at(-1);
        const fork = { ownership: { kind: "ownerless" as const }, agent: {
          model: (await shared.agent(context)).model ?? this.modelRef, instructions: this.agentInstructions("ask"),
          tools: this.tools.filter(tool => readOnlyTools.includes(tool.name) && sessionToolNames(this.binding.agent.tools).includes(tool.name)),
        } };
        conversation = head ? await shared.fork(head.id, fork, context) : await this.harness.createConversation(fork, context);
      }
      const transcript = await conversation.context(context);
      const run: Run = { key, initiatedBy: ticket.actorId, ownerId: this.binding.owner.id, mode, conversationId: conversation.id, content, contentHash: hash, status: "queued", startEntry: transcript.entries.at(-1)?.id ?? 0, sequence: state.nextSequence ?? 0, submittedAt: Date.now() };
      if (input.admissionId !== undefined) run.admissionId = input.admissionId;
      if (options) run.options = options;
      if (prepared.length) run.images = { count: prepared.length, bytes: imageBytes };
      if (screen) run.screening = true;
      await this.mutate(meta => {
        meta.runs[key] = run;
        meta.nextSequence = (meta.nextSequence ?? 0) + 1;
        if (!meta.branches.some(branch => branch.id === conversation.id)) meta.branches.push({ id: conversation.id, mode, actorId: ticket.actorId });
      });
      if (screen) void this.#queue.screen(key);
      this.drainQueue();
      return { submissionId: key, conversationId: String(conversation.id), status: "queued", queuePosition: Object.values(state.runs).filter(run => ["queued", "running", "admitting"].includes(run.status)).length + 1 };
    });
  }

  async stop(ticket: RunnerTicket): Promise<{ stopped: number }> {
    this.assertTicket(ticket);
    const stopped = await this.exclusive(async () => {
      if (this.closing) throw new RunnerError(503, "Session is closing");
      await this.authorize(ticket.actorId, "write", ticket.policyVersion);
      const runs = Object.values((await this.metadata()).runs).filter(run => ["queued", "admitting", "running"].includes(run.status));
      await this.mutate(meta => {
        for (const run of runs) Object.assign(meta.runs[run.key]!, { status: "interrupted", stopped: { by: ticket.actorId, ...(run.status === "queued" ? {} : { pending: true }) } });
      });
      await this.#inputs.discard(runs.filter(run => run.images && run.submissionId === undefined).map(run => run.key));
      return runs;
    });
    if (stopped.some(run => run.status !== "queued")) void this.abortStopped().catch(() => { });
    if (this.#tunnel) await this.#tunnel.stop("session-stop", ticket.actorId);
    return { stopped: stopped.length };
  }

  async withdraw(ticket: RunnerTicket, input: unknown): Promise<WithdrawResult> {
    this.assertTicket(ticket);
    const value = input as { submissionId?: unknown } | null;
    if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some(key => key !== "submissionId")
      || typeof value.submissionId !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(value.submissionId)) throw new RunnerError(400, "Invalid withdrawal");
    const key = value.submissionId;
    return this.exclusive(async () => {
      if (this.closing) throw new RunnerError(503, "Session is closing");
      const run = (await this.metadata()).runs[key];
      if (!run || run.initiatedBy !== ticket.actorId) throw new RunnerError(404, "No queued message of yours has that receipt");
      await this.authorize(ticket.actorId, run.mode === "ask" ? "ask" : "write", ticket.policyVersion);
      if (run.status !== "queued" || run.stopped) throw new RunnerError(409, "That message has already started or ended");
      const images = run.images ? await this.#inputs.read(key) : undefined;
      await this.mutate(meta => { Object.assign(meta.runs[key]!, { status: "interrupted", withdrawn: true }); });
      if (run.images) await this.#inputs.discard([key]);
      return { content: run.content, mode: run.mode, ...(images?.length ? { images: images as ChatImage[] } : {}),
        ...(run.images && !images?.length ? { imagesLost: true as const } : {}) };
    });
  }

  private async abortStopped(): Promise<void> {
    const generation = this.generation;
    const runs = Object.values((await this.metadata()).runs).filter(run => run.stopped?.pending);
    for (const id of new Set(runs.map(run => run.conversationId))) await (await this.harness.conversation(id as ConversationId, context))?.abort(context);
    if (generation !== this.generation) return;
    await this.mutate(meta => { for (const run of runs) delete meta.runs[run.key]!.stopped!.pending; });
    this.drainQueue();
  }

  private testShell(): boolean {
    return this.binding.model.provider === "faux" && this.config.allowFaux === true && this.config.allowTestShell === true;
  }

  private async hostConfig(): Promise<HostConfig> {
    const config = this.config.hostConfig ? await this.config.hostConfig() : { ...defaultHostConfig };
    this.#configuredCompaction = config.compaction;
    return config;
  }

  private buildTools(): ToolRegistration[] {
    return buildTools(this.#toolContext, this.#clone && !!this.#egress);
  }

  runOperation(actorId: string, input: Operation, toolTaskId: string, consent: OperationConsent = {}, signal?: AbortSignal): Promise<StoredOperation> {
    return this.#operations.run(actorId, input, toolTaskId, consent, signal);
  }

  private async cutPoint(conversation: Conversation, entryId: string): Promise<{ at: EntryId | undefined; last: boolean }> {
    const match = /^(\d{1,15}):(\d{1,15})$/.exec(entryId);
    if (!match) throw new RunnerError(400, "Invalid message");
    if (Number(match[1]) !== Number(conversation.id)) throw new RunnerError(409, "That message is no longer in the shared conversation; reload it");
    const { entries } = await conversation.context(context);
    const index = entries.findIndex(entry => entry.id === Number(match[2]));
    if (index < 0) throw new RunnerError(409, "That message is no longer in the shared conversation; reload it");
    const entry = entries[index]!;
    const messages = entry.model ?? [];
    if (messages[0]?.role === "user" && entry.head === undefined) return { at: index > 0 ? entries[index - 1]!.id : undefined, last: false };
    const reply = messages.at(-1);
    if (reply?.role !== "assistant" || reply.content.some(block => block.type === "toolCall")) {
      throw new RunnerError(409, "Choose one of your messages or the agent's final reply");
    }
    return { at: entry.id, last: index === entries.length - 1 };
  }

  private working(state: Metadata): boolean {
    return Object.values(state.runs).some(run => ["queued", "admitting", "running"].includes(run.status) || run.stopped?.pending)
      || Object.values(state.approvals).some(approval => approval.status === "executing");
  }

  async revert(ticket: RunnerTicket, input: unknown): Promise<{ conversationId: string }> {
    this.assertTicket(ticket);
    this.requireUnfrozen();
    const entryId = messageInput(input);
    return this.exclusive(async () => {
      if (this.closing) throw new RunnerError(503, "Session is closing");
      await this.authorize(ticket.actorId, "write", ticket.policyVersion);
      if (this.working(await this.metadata())) throw new RunnerError(409, "Stop the session's work before going back to an earlier message");
      const shared = this.#shared;
      const { at, last } = await this.cutPoint(shared, entryId);
      if (last) return { conversationId: String(shared.id) };
      let next: Conversation;
      if (at !== undefined) next = await shared.fork(at, { ownership: { kind: "ownerless" } }, context);
      else {
        const agent = await shared.agent(context);
        next = await this.harness.createConversation({ ownership: { kind: "ownerless" }, agent: {
          model: agent.model ?? this.modelRef, thinkingLevel: agent.thinkingLevel, extensions: [this.#extension, ...this.#defined.extensions],
          tools: this.tools, instructions: this.agentInstructions("write"),
        } }, context);
      }
      await this.mutate(meta => {
        for (const branch of meta.branches) if (branch.mode === "write") branch.superseded = true;
        meta.branches.push({ id: next.id, mode: "write" });
        for (const run of Object.values(meta.runs)) if (run.mode === "write" && (at === undefined || run.startEntry >= at)) run.reverted = true;
      });
      this.#shared = next;
      return { conversationId: String(next.id) };
    });
  }

  async forkEntries(actorId: string, entryId: string): Promise<ForkedConversation> {
    return this.exclusive(async () => {
      if (this.closing) throw new RunnerError(503, "Session is closing");
      await this.authorize(actorId, "write");
      const shared = this.#shared;
      const { at, last } = await this.cutPoint(shared, entryId);
      if (last && this.working(await this.metadata())) throw new RunnerError(409, "Wait for the agent to finish before forking from its latest reply");
      const current = await shared.agent(context);
      const agent = { ...(current.model ? { model: { provider: current.model.provider, modelId: current.model.modelId } } : {}),
        ...(current.thinkingLevel ? { thinkingLevel: current.thinkingLevel as ThinkingLevel } : {}) };
      if (at === undefined) return { entries: [], agent };
      const transcript = await shared.context(context, { at });
      const entries = transcript.entries.flatMap((_entry, index) => {
        const model = (transcript.contributions[index] ?? []).filter(message => (message.role as string) !== "system");
        return model.length ? [{ kind: FORKED_KIND, model }] : [];
      });
      return { entries, agent };
    });
  }

  async seed(ticket: RunnerTicket, from: { sessionId: string; entryId: string }, { entries, agent }: ForkedConversation): Promise<{ conversationId: string; entries: number }> {
    this.assertTicket(ticket);
    this.requireUnfrozen();
    if (ticket.actorId !== this.binding.owner.id) throw new RunnerError(403, "Only the session's owner can fork into it");
    return this.exclusive(async () => {
      if (this.closing) throw new RunnerError(503, "Session is closing");
      await this.authorize(ticket.actorId, "write", ticket.policyVersion);
      const shared = this.#shared;
      const state = await this.metadata();
      if (state.forkedFrom) {
        if (state.forkedFrom.sessionId !== from.sessionId || state.forkedFrom.entryId !== from.entryId) throw new RunnerError(409, "This session was already forked from another message");
        return { conversationId: String(shared.id), entries: entries.length };
      }
      if (Object.keys(state.runs).length || state.branches.length !== 1 || (await shared.context(context)).entries.length) {
        throw new RunnerError(409, "Only a new session can start from another session's conversation");
      }
      await shared.commit(async tx => {
        for (const entry of entries) await tx.appendEntry(shared.id, { kind: FORKED_KIND, model: entry.model });
        const doc = await tx.doc(RunnerState);
        const meta = JSON.parse(doc.json) as Metadata;
        meta.forkedFrom = { sessionId: from.sessionId, entryId: from.entryId };
        doc.json = JSON.stringify(meta);
      }, context);
      const same = agent.model?.provider === this.modelRef.provider && agent.model.modelId === this.modelRef.modelId;
      if (same && agent.thinkingLevel && thinkingLevels.includes(agent.thinkingLevel)) await shared.configure({ thinkingLevel: agent.thinkingLevel }, context);
      this.#activity?.changed();
      return { conversationId: String(shared.id), entries: entries.length };
    });
  }

  async consumeTicket(ticket: RunnerTicket): Promise<void> {
    this.assertTicket(ticket);
    if (ticket.exp * 1000 <= Date.now()) throw new RunnerError(401, "Ticket expired");
    const key = await sha256(ticket.jti);
    await this.mutate(meta => {
      meta.usedTickets ??= {};
      const now = Math.floor(Date.now() / 1000);
      for (const [id, expires] of Object.entries(meta.usedTickets)) if (expires <= now) delete meta.usedTickets[id];
      if (meta.usedTickets[key]) throw new RunnerError(409, "Ticket has already been consumed");
      meta.usedTickets[key] = ticket.exp;
    });
  }

  view(): Promise<SessionView> {
    return sessionView({
      binding: this.binding, tunnel: () => this.#tunnel?.view(), sudo: () => this.#sudo?.view(), metadata: () => this.metadata(),
      conversation: id => this.harness.conversation(id as ConversationId, context), agent: () => this.#shared.agent(context),
      context: (messages, model) => contextView(messages, model, { fallback: this.modelRef, models: this.models, compaction: this.#compaction }),
      repositories: () => this.#repositories.view(), extensions: () => this.extensionView(),
    });
  }

  private extensionView(): Promise<Pick<SessionView, "extensions">> {
    return extensionView({
      binding: this.binding, config: this.config.extensions, builtins: () => this.#builtins, hostConfig: () => this.hostConfig(),
      requiredExtensions: () => this.requiredExtensions(), toolNames: () => this.tools.map(tool => tool.name),
      definedToolsOff: (off, extensions) => this.#availability.definedToolsOff(off, extensions), browserUnavailable: () => this.#availability.browserUnavailable(),
      tunnelUnavailable: () => this.#availability.tunnelUnavailable(), missingPrograms: off => this.#availability.missingPrograms(off),
    });
  }

  async restart(): Promise<void> {
    await this.exclusive(async () => { await this.close(); await this.open(); });
  }

  async backup(ticket: RunnerTicket, { conversationOnly = false }: { conversationOnly?: boolean } = {}): Promise<RunnerBackup> {
    this.assertTicket(ticket);
    return this.exclusive(async () => {
      await this.authorize(ticket.actorId, "manage");
      const state = await this.metadata();
      if (Object.values(state.runs).some(holdsQueue)
        || Object.values(state.approvals).some(approval => approval.status === "executing")) throw new RunnerError(409, "Backup requires an idle session including queued work");
      this.#repositories.requireReady();
      this.requireUnfrozen();
      await this.close();
      try {
        const sqlite = await readFile(this.sqlitePath, "base64");
        if (conversationOnly) {
          return boundedBackup<RunnerBackup>({ format: "pi-runner-backup-v1", binding: this.binding, manifest: state, sqlite, files: [], conversationOnly: true,
            createdAt: new Date().toISOString() });
        }
        const authorize = async () => { await this.authorize(ticket.actorId, "manage"); };
        const sandboxed = this.#clone && this.#egress;
        const { clones, found } = sandboxed ? await isolatedWorkspace(this.sandbox).cloneBackup(authorize) : { clones: [], found: [] };
        const files = sandboxed ? await isolatedWorkspace(this.sandbox).snapshot(authorize, found) : await this.sandbox.snapshot(authorize);
        return boundedBackup<RunnerBackup>({ format: "pi-runner-backup-v1", binding: this.binding, manifest: state, sqlite, files, ...(clones.length ? { clones } : {}),
          createdAt: new Date().toISOString() });
      } catch (error) { throw backupRefusal(error); } finally { await this.open(); }
    });
  }

  async requirePackable(actorId: string, policyVersion: number): Promise<void> {
    await this.authorize(actorId, "manage", policyVersion, false, false, true);
    if (this.#packed) throw new RunnerError(409, "This session's files are already packed");
    if (this.#onHost) throw new RunnerError(422, "This session runs without the sandbox, so its files can't be packed");
    if (!(this.sandbox instanceof Sandbox)) throw new RunnerError(422, "Only sessions in the Linux sandbox can be packed");
    if (this.config.resources) throw new RunnerError(422, "This host keeps each session on its own volume, so packing would free nothing");
    this.requireUnfrozen();
    const state = await this.metadata();
    if (Object.values(state.runs).some(holdsQueue)
      || Object.values(state.approvals).some(approval => approval.status === "executing")) throw new RunnerError(409, "Packing requires an idle session including queued work");
    this.#repositories.requireReady();
  }

  async packContent(ticket: RunnerTicket): Promise<{ bytes: Buffer; files: number; clones: number }> {
    this.assertTicket(ticket);
    return this.exclusive(async () => {
      await this.requirePackable(ticket.actorId, ticket.policyVersion);
      await this.close();
      const sandbox = this.sandbox as Sandbox;
      const authorize = async () => { await this.authorize(ticket.actorId, "manage", ticket.policyVersion, false, false, true); };
      try {
        const { clones, found } = this.#clone ? await sandbox.cloneBackup(authorize, { pack: true }) : { clones: [], found: [] };
        const files = await sandbox.snapshot(authorize, found);
        return { bytes: packBytes(this.binding, { files, ...(clones.length ? { clones } : {}) }), files: files.length, clones: clones.length };
      } catch (error) { throw packRefusal(error); }
    });
  }

  async entryImage(ticket: RunnerTicket, input: unknown): Promise<{ image: EntryImage }> {
    this.assertTicket(ticket);
    const request = entryImageRequest(input);
    if (!request) throw new RunnerError(400, "Invalid image request");
    await this.authorize(ticket.actorId, "write", ticket.policyVersion);
    const { conversationId, entryId } = entryIdParts(request.entryId)!;
    const state = await this.metadata();
    const branch = state.branches.find(item => item.id === conversationId && !item.superseded);
    const conversation = branch && await this.harness.conversation(branch.id as ConversationId, context);
    const entry = conversation && (await conversation.context(context)).entries.find(item => Number(item.id) === entryId);
    const image = entry && entryImages(entry)[request.index];
    if (!image) throw new RunnerError(404, "That image is not in the transcript");
    if (request.size === "full") {
      const whole = checkEntryImage(image, "full");
      if (!whole) throw new RunnerError(422, "That image can't be shown");
      return { image: whole };
    }
    const thumbnail = await thumbnailImage(image.data, image.mimeType);
    if (thumbnail === "busy") throw new RunnerError(429, "Too many images are being prepared; try again shortly");
    const checked = thumbnail && checkEntryImage(thumbnail, "thumbnail");
    if (!checked) throw new RunnerError(422, "That image can't be shown");
    return { image: checked };
  }

  async browse(ticket: RunnerTicket, path: string): Promise<SessionFiles> {
    this.assertTicket(ticket);
    await this.authorize(ticket.actorId, "write", ticket.policyVersion);
    const authorize = async () => { await this.authorize(ticket.actorId, "write", ticket.policyVersion); };
    try {
      return { path, ...await this.sandbox.browse(path, authorize) };
    } catch (error) {
      if (error instanceof RunnerError) throw error;
      const message = error instanceof Error ? `${error.message}\n${(error as { stderr?: string }).stderr ?? ""}`.toLowerCase() : "";
      const code = (error as NodeJS.ErrnoException | null)?.code;
      if (code === "ENOENT" || code === "ENOTDIR" || /no such file or directory|not a directory/.test(message)) throw new RunnerError(422, "That path is not in the worktree");
      if (/path escapes the worktree/.test(message)) throw new RunnerError(422, "That path leads outside the worktree");
      if (/invalid relative path|absolute paths|path traversal|path component is not a real directory/.test(message)) throw new RunnerError(422, "Invalid worktree path");
      if (/too many entries/.test(message)) throw new RunnerError(422, "That directory has too many entries to list");
      if (code === "EACCES" || code === "ELOOP" || /permission denied|symlinks are not followed|too many levels of symbolic links/.test(message)) throw new RunnerError(422, "That path can't be read");
      throw error;
    }
  }

  async changes(ticket: RunnerTicket, input: unknown): Promise<LocalChanges> {
    this.assertTicket(ticket);
    await this.authorize(ticket.actorId, "write", ticket.policyVersion);
    let request: LocalChangesRequest;
    try { request = localChangesRequest(input); } catch { throw new RunnerError(400, "Invalid local changes request"); }
    const marker = randomBytes(16).toString("hex");
    const operation: Operation = { kind: "program", tool: "git", command: localChangesCommand(request, marker) };
    const unbounded = !this.hostCommands.shellAllowed();
    const onHost = this.hostCommands.runsOnHost(operation, unbounded);
    const authorize = async () => {
      await this.hostCommands.requireHostEnvironment();
      if (onHost) await this.hostCommands.require(ticket.actorId, "Reading the worktree's Git changes");
      await this.authorize(ticket.actorId, "write", ticket.policyVersion);
    };
    await authorize();
    let output: string;
    try {
      output = await this.sandbox.execute(operation, this.sandbox.isolated, authorize, { allowTestShell: this.testShell(), unbounded,
        ...await this.#calls.commandOptions(LOCAL_CHANGES_SECONDS), signal: AbortSignal.timeout(LOCAL_CHANGES_SECONDS * 1000) });
    } catch (error) {
      if (error instanceof RunnerError) throw error;
      throw new RunnerError(422, "The worktree's Git changes couldn't be read. Is git installed on the host, and the session idle?");
    }
    try { return parseLocalChanges(output, marker, request); }
    catch (error) {
      if (error instanceof NotARepository) throw new RunnerError(422, error.message);
      throw error;
    }
  }

  async upload(ticket: RunnerTicket, input: unknown): Promise<UploadResult> {
    this.assertTicket(ticket);
    await this.authorize(ticket.actorId, "write", ticket.policyVersion);
    const chunk = parseUploadChunk(input);
    if ("error" in chunk) throw new RunnerError(400, "Invalid upload chunk");
    return this.#uploads.receive(ticket.actorId, chunk, async () => { await this.authorize(ticket.actorId, "write", ticket.policyVersion); });
  }


  async close({ abortPushes = true }: { abortPushes?: boolean } = {}): Promise<void> {
    this.closing = true;
    this.#wholeResults.dropResults();
    this.#repositories.reset();
    this.#opened = false;
    this.#resumed = false;
    this.#activity?.stop();
    const tunnel = this.#tunnel;
    this.#tunnel = undefined;
    await tunnel?.close().catch(() => {});
    await this.#sudo?.close().catch(() => {});
    if (abortPushes) await this.#operations.abortPushes();
    this.generation++;
    const extensions = this.#hostExtensions;
    this.#hostExtensions = undefined;
    await extensions?.shutdown().catch(() => {});
    const failed = this.#failed;
    const builtins = this.#builtins;
    this.#builtins = undefined;
    try {
      await this.#egress?.close();
      await this.harness.close(context).catch((error: unknown) => { if (!failed) throw error; });
    } finally {
      await builtins?.close().catch(() => {});
    }
  }

  private async controlPlane<T>(path: string, body: unknown): Promise<T> {
    const response = await (this.config.fetch ?? fetch)(`${this.config.controlPlaneUrl}${path}`, {
      method: "POST", headers: { authorization: `Bearer ${this.config.sharedSecret}`, "content-type": "application/json" },
      body: JSON.stringify(body), signal: AbortSignal.timeout(30_000), redirect: "error",
    });
    const text = await response.text();
    if (text.length > 65536) throw new RunnerError(502, "Control-plane response is too large");
    let value: unknown;
    try { value = text ? JSON.parse(text) : undefined; } catch { value = undefined; }
    if (!response.ok) {
      const message = value && typeof value === "object" && "error" in value && typeof value.error === "string" ? value.error.slice(0, 1000) : `HTTP ${response.status}`;
      throw new RunnerError(response.status, message);
    }
    return value as T;
  }
}
