import type { ExtensionToolOperation, HostCommandOperation } from "../../../packages/shared/src/types.js";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, readFile, rm } from "node:fs/promises";
import { availableParallelism } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { awaitWithContext, BACKGROUND_CONTEXT as context, type Context } from "@earendil-works/chord/context";
import { getSupportedThinkingLevels, StringEnum, type ClientIdentity, type Message, type Models } from "@earendil-works/pi-ai";
import { arr, bool, int, obj, opt, str } from "@earendil-works/pi-schema";
import { createRegistry, defineDoc, defineExtension, defineTool, Harness, InboxDoc, type AgentChange, type CompactionSettings, type Cursor, type Conversation, type ConversationId, type EntryId, type EntryRecord, type Extension, type Registry, type Storage, type SubmissionId, type ToolExecutionApi, type ToolExecutionResult, type ToolRegistration } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import type { ApprovalRecord, AuthorizationRequest, AuthorizationResult, ChatOptions, GitHubCommentRequest, GitHubIssueRequest, GitHubIssueResult, GitHubIssueView, GitHubMergeRequest, GitHubMergeResult, GitHubReadRequest, GitPushOperation, HostPushCredential, ModelDefinition, Operation, PermissionNeed, PermissionRequest, Permission, PushCompleteRequest, PushCompletionResult, PushCredential, PushCredentialRequest, PushOutcome, HostCommandLevel, RunnerBinding, RunnerTicket, ScheduleToolRequest, ScheduleToolResult, SessionActivity, SessionBranch, SessionFiles, SessionView, SubmitInput, SubmitResult, ThinkingLevel, AnyToolName, WithdrawResult } from "../../../packages/shared/src/types.js";
import { EXTENSION_ARGUMENTS_SHOWN, GITHUB_ISSUE_BODY_LIMIT, GITHUB_ISSUE_TITLE_LIMIT, accessModes, githubMergeMethods, repositoryPreparationPhases, scheduleRunIns, scheduleToolActions, thinkingLevels } from "../../../packages/shared/src/types.js";
import { scheduleToolTarget } from "../../../packages/shared/src/cron.js";
import { crossSessionLimits, sessionsToolActions, sessionsToolTarget, sessionsWriteActions, type SessionsToolRequest, type SessionsToolResult } from "../../../packages/shared/src/cross-session.js";
import type { CompactionFailure, ModelFailureCause } from "../../../packages/shared/src/types.js";
import type { RestoreDescriptor } from "../../../packages/shared/src/connector.js";
import { bindingRemote, repositoryPath, validCloneDirectory, validPushTag } from "../../../packages/shared/src/repositories.js";
import { sha256 } from "../../../packages/shared/src/crypto.js";
import { extensionPackageKey, missingRequiredExtensions, sessionExtensions, type ChosenExtension, type WorkspaceExtensionsAnswer } from "../../../packages/shared/src/host-extensions.js";
import type { ModelRegistry } from "@earendil-works/pi-coding-agent";
import { ExtensionPrompts, SessionExtensions, settleToolNames, type ExtensionHost, type InputOutcome, type SessionExtension } from "./extensions/adapter.js";
import { sandboxShellCommand, type CliRun, type PikiSandboxRun, type PikiSession } from "./extensions/piki/command.js";
import { SessionBuiltins, type OutputFiles } from "./extensions/builtin.js";
import { boundOutput, MODEL_OUTPUT, SavedOutputs, toolOutputPath } from "./tool-output.js";
import type { LoadedSource } from "./extensions/load.js";
import { messageHash, parseChatImages, type ChatImage } from "../../../packages/shared/src/chat-images.js";
import { parseUploadChunk, type UploadResult } from "../../../packages/shared/src/file-uploads.js";
import { requestKey, RunnerError, stableJson, validateOperation } from "./protocol.js";
import { searchLimits, searchRequest, type SearchRequest } from "./search.js";
import { gitLimits, gitRequest, gitShellCommand, gitSubcommands, type GitRequest } from "./git-command.js";
import { brokeredArguments, brokeredTarget, programCommand, programRequest, programToolsInstructions, rememberToolDefinitions, type ProgramRequest } from "./defined-tools.js";
import { bundledToolDefinitions, type ProgramToolDefinition, type ToolDefinition } from "../../../packages/shared/src/tool-definitions.js";
import { pythonPrograms, pythonRequest, pythonShellCommand, type PythonRequest } from "./python-command.js";
import { sandboxMissingPrograms } from "./program-availability.js";
import { programInstallStep, programsMissingText } from "../../../packages/shared/src/program-install.js";
import { browserRequest, browserShellCommand, browserTarget, servePrograms } from "./browser-command.js";
import type { BrowserToolchain } from "./browser-toolchain.js";
import { browserActions, browserKeys, browserLimits, browserUnavailableReason, browserUnavailableText, parseBrowserReport, type BrowserRequest,
  type BrowserUnavailableReason, type HostBrowserStatus } from "../../../packages/shared/src/browser.js";
import { tunnelActions, tunnelUnavailableReason, tunnelUnavailableText, type HostTunnelStatus, type SessionTunnelReport,
  type TunnelUnavailableReason } from "../../../packages/shared/src/tunnel.js";
import { tunnelRequest, type TunnelRequest } from "./tunnel-command.js";
import { SessionTunnel } from "./session/tunnel.js";
import { pinServiceSocket, serviceLimits, serviceShellCommand, serviceSocketDirectory } from "./session-service.js";
import type { QuickTunnel } from "./tunnel-host.js";
import { programLimits } from "./program-command.js";
import { githubInstructions, githubWaitLimits, githubWaits, waitForGitHub } from "./github-wait.js";
import { fileOperationLimits, fileOperationRequest, type FileOperationRequest } from "./file-operations.js";
import { lineRange } from "./edits.js";
import { documentKindsOff, extensionSwitchOn, sessionToolExtensions, sessionToolsOff } from "../../../packages/shared/src/piki-extensions.js";
import { runnerModels } from "./provider.js";
import { HostWorkspace } from "./host-workspace.js";
import { isolatedWorkspace, type SessionWorkspace } from "./workspace.js";
import type { SandboxBackendConfig } from "./sandbox-backend.js";
import { HelperWorkspace } from "./helper-workspace.js";
import { SeatbeltBackend } from "./seatbelt.js";
import { WindowsBackend } from "./windows-sandbox.js";
import { reportedBranches } from "./clone-branches.js";
import { answered, ApprovalWaits } from "./session/approval-waits.js";
import { endView, entryImages, entryView, refusedView } from "./session/entries.js";
import { checkEntryImage, entryIdParts, entryImageRequest, type EntryImage } from "../../../packages/shared/src/entry-images.js";
import { MessageInputs, prepareMessageImages, type InputImage } from "./session/inputs.js";
import { refused, SessionMirrors } from "./session/mirrors.js";
import { SessionUploads } from "./session/uploads.js";
import {
  hostGitLfs, Sandbox, SandboxProcessError, type CloneBackup, type MirrorMount, type SandboxAuthorize, type SnapshotFile,
} from "./sandbox.js";
import { prepareImage, thumbnailImage } from "./images.js";
import { performClonePush, PushError, pushSummary, type PushResult } from "./push.js";
import { HostCredentialError } from "./git-credentials.js";
import type { GitRemote } from "./git-remote.js";
import type { RepositoryCache } from "./repo-cache.js";
import type { RepositoryPreparationItem, RepositoryPreparationView } from "../../../packages/shared/src/types.js";
import type { ResourceConfig } from "./resources.js";
import type { RestoreManifest } from "./restore.js";
import { isPacked, packBytes, packRefusal } from "./pack.js";
import { applyEdits } from "./edits.js";
import { compactionFailure, compactionThreshold, configuredCompaction, hostCompaction } from "./compaction.js";
import { compactionEnabled, compactsAfterFailure, contextTokens, modelFailureCause } from "./model-failure.js";
import { ActivityReporter, sessionActivity, type ActivityEntry } from "./activity.js";
import { autoApprovedCalls, viewApprovals, type StoredApproval } from "./approval-view.js";
import { EgressProxy, egressEnvironment, egressSocketPath, parseEgressGrant, relayGitRequest, relayPath, repositoryForRemote, type MirrorProgress, type RelayRequest } from "./egress.js";
import { DirectGit } from "./git-direct.js";
import { egressReadServices, type ApiAccessKind, type EgressGrant, type EgressRepository, type GitDirectRequest } from "../../../packages/shared/src/network.js";
import { sessionBranch } from "../../../packages/shared/src/git-push.js";
import { documentKindNames, type DocumentKind, type GrantSource } from "../../../packages/shared/src/sources.js";
import { defaultHostConfig, type HostCompaction, type HostConfig, type RequiredExtension } from "../../../packages/shared/src/host-config.js";
import { commandLimits, type CommandLimits } from "./host-config.js";
import { memberAutoApproves, requesterAutoApproves, decidedAsHostCommand, grantedShell, type HostCommandSession } from "../../../packages/shared/src/host-operations.js";

export type Run = {
  key: string; initiatedBy: string; ownerId: string; mode: "write" | "ask";
  conversationId: number; content: string; contentHash: string; submissionId?: number;
  status: "queued" | "admitting" | "running" | "settled" | "interrupted"; startEntry: number;
  sequence?: number;
  started?: boolean;
  admissionId?: string;
  submittedAt?: number;
  options?: ChatOptions;
  images?: { count: number; bytes: number };
  inputsLost?: true;
  failure?: { reason: "model_error" | "no_model" | "compaction_failed"; provider?: string; modelId?: string; compaction?: CompactionFailure;
    cause?: ModelFailureCause; compacting?: true };
  stopped?: { by: string; pending?: true };
  crashed?: true;
  screening?: true;
  refused?: { by: string; notice: string };
  reverted?: true;
  withdrawn?: true;
};
type Branch = { id: number; mode: "write" | "ask"; actorId?: string; superseded?: true };
export type ForkedEntry = { kind: string; model: readonly Message[] };
export type ForkedConversation = { entries: ForkedEntry[]; agent: { model?: { provider: string; modelId: string }; thinkingLevel?: ThinkingLevel } };
const FORKED_KIND = "workspace.forked";

export function messageInput(input: unknown): string {
  const value = input as { entryId?: unknown } | null;
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some(key => key !== "entryId")
    || typeof value.entryId !== "string" || value.entryId.length > 64) throw new RunnerError(400, "Invalid message");
  return value.entryId;
}
type Grants = { tools: AnyToolName[]; write: boolean; unboundedShell: boolean; audience?: boolean };
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
type Metadata = { binding: RunnerBinding; branches: Branch[]; runs: Record<string, Run>; approvals: Record<string, StoredApproval>; toolActors: Record<string, { initiatedBy: string; ownerId: string; runKey: string; callId?: string }>; usedTickets?: Record<string, number>; nextSequence?: number; grants?: Grants;
  conversationOnlyRestore?: true;
  forkedFrom?: { sessionId: string; entryId: string } };
const RunnerState = defineDoc<{ json: string }>({ kind: "workspace.runner", version: 1, scope: "session", initial: () => ({ json: "" }), checkpointWhen: () => true });
const MAX_QUEUED_IMAGE_BYTES = 16 * 1024 * 1024;
const readOnlyTools = ["identity", "read_file", "list_files", "search"];
const WAIT_POLL_MS = 3000;
const SESSIONS_TOOL_DESCRIPTION = "Work with this workspace's other Pikibun sessions, as the person whose message you are working on, with exactly their permissions in each session. "
  + "action list: the sessions they can see (id, title, status, activity, their permissions, parent), the models create can use, with the thinking levels each offers, and whether this workspace lets create choose them (childModels). "
  + "read {session, limit?, message_id?}: a session's latest shared-conversation entries (a failed model turn with why, as far as the host tells) and pending approvals; with message_id, also the outcome of a message this session sent it (status, done, reply). "
  + "ask {session, message, notify?}: a read-only side question to that session's agent. "
  + "send {session, message, access?, notify?}: a message to that session's agent, as if typed in its chat (access left out, the default: auto where this message is the session owner's own auto-approve one and that session is theirs and sandboxed, else approval; approval: its commands wait for people there; read: inspect only; auto: only in a message the session owner sent with auto-approve, to a session they own); refused while it is busy. "
  + "wait {session, message_id, timeout_seconds?}: block until a message this session sent finishes (default 300 seconds), then return its outcome and reply. "
  + "create {message?, title?, model?, thinking?, visibility?, access?, notify?}: start a new session for a sub-task, as the same person, and send it message. Where childModels allows, pick the model (one list returns) and thinking level (for its opening message, which its conversation keeps) to suit the sub-task: a capable model with more thinking for hard work, a fast one with less for simple work; what you leave out, and everything where childModels is off, is this session's current model and thinking level. "
  + "stop {session}: stop that session's current work. archive {session}: archive a session they own or, as the workspace's owner or an admin, any of its sessions. "
  + "With notify, Pikibun sends this session the outcome as a new message once the other session finishes. Delivered messages start with a line naming this session and the sender; "
  + "chains of messages stop after 3 hops and never loop back to a session they came from; approvals in another session are decided only by people there. "
  + "Involve other sessions only when the user asked for it or clearly expects it.";
const DECISION_WAIT_MS = 60 * 60 * 1000;
const GRANTED_SHELL_DECIDERS = "This command runs without the resource limits its host lacks, on the strength of a host command grant: "
  + "only the host owner, or a member granted host commands on this host, can decide it";
function tellsActivity(run: Run): boolean {
  return !run.reverted && !run.withdrawn;
}

function holdsQueue(run: Run): boolean {
  return ["queued", "running", "admitting"].includes(run.status) || run.stopped?.pending === true;
}
export type RunnerConfig = {
  dataDir: string; controlPlaneUrl: string; sharedSecret: string; allowFaux: boolean; allowTestShell?: boolean; fetch?: typeof fetch;
  connectorId?: string;
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
  tunnels?: { open(socket: string, signal?: AbortSignal): Promise<QuickTunnel>; status(): HostTunnelStatus | undefined };
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

function preparationFailure(reason: string): string {
  return `${reason.replace(/\.$/, "")}. Restart the session to try again.`;
}

type RepositoryPreparation = { status: "ready" }
  | { status: "preparing"; done: Promise<void>; controller: AbortController; items: RepositoryPreparationItem[] }
  | { status: "failed"; reason: string; items: RepositoryPreparationItem[] };
type ProgressUpdate = (path: string, change: Partial<Omit<RepositoryPreparationItem, "path">>) => void;

const REQUIRED_UNKNOWN = "This host can't learn from Pikibun which extensions its owner requires right now, so no message is sent. Try again shortly";
const REQUIRED_MISSING = "This host's owner requires an extension its connector can't run now, so no message is sent. Ask them to look at the host's extensions";
const REFUSED = "An extension on this host refused this message.";
const INPUT_FAILED = "This host couldn't check this message with its extensions, so it was not sent. Try again shortly.";
const INPUT_EMPTY = "An extension on this host left this message empty or too long, so it was not sent.";
const INPUT_IMAGES = "An extension on this host changed this message's images into ones that can't be sent.";

export const WORK_MARKER = "working";

function modelFailed(entry: EntryRecord): boolean {
  return (entry.model ?? []).some(message => message.role === "assistant" && message.stopReason === "error");
}

function activityEntry(entry: EntryRecord | undefined): ActivityEntry | undefined {
  return entry && { id: Number(entry.id), failed: modelFailed(entry) };
}

export class RunnerSession {
  readonly sandbox: SessionWorkspace;
  readonly sqlitePath: string;
  private harness!: Harness;
  private root!: Conversation;
  #shared!: Conversation;
  #extension!: Extension;
  #definitions: ToolDefinition[] = [];
  #definedExtensions: Extension[] = [];
  #registry?: Registry;
  readonly #inputs: MessageInputs;
  readonly #uploads: SessionUploads;
  readonly #mirrors: SessionMirrors | undefined;
  readonly #savedOutputs = new SavedOutputs();
  readonly #pikiCalls = new Map<string, { write: boolean; attribution: { initiatedBy: string; mode: "write" | "ask" } }>();
  #hostExtensions?: SessionExtensions;
  #currentModel?: { provider: string; modelId: string; thinkingLevel?: string };
  #opening: Promise<void> = Promise.resolve();
  #builtins?: SessionBuiltins;
  private tools: ToolRegistration[] = [];
  private lock: Promise<unknown> = Promise.resolve();
  private generation = 0;
  private closing = false;
  private draining = false;
  #drainAgain = false;
  private modelRef!: { provider: string; modelId: string };
  private models!: Models;
  #compaction: () => CompactionSettings | undefined = () => undefined;
  private pushes = new Set<{ controller: AbortController; done: Promise<void> }>();
  #failed = false;
  #recovery: Promise<void> | undefined;
  readonly #waits = new ApprovalWaits();
  #repositories: RepositoryPreparation = { status: "ready" };
  #preparations = 0;
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
  #cloneRepositories: string[] = [];
  #sources: GrantSource[] = [];
  #lfsRepositories: string[] = [];
  #branchRepositories: EgressRepository[] = [];
  #branchesSent: string | undefined;
  #branchesReporting = false;
  #branchesWanted = false;
  #cloneFailures: { path: string; reason: string }[] = [];
  #conversationOnlyRestore = false;
  #configuredCompaction: HostCompaction | undefined;
  #tunnel: SessionTunnel | undefined;

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
    const directGrant = config.gitDirect ? (request: Omit<GitDirectRequest, "sessionId">) => config.gitDirect!(binding.session.id, request)
      : config.gitRelay ? undefined
      : (request: Omit<GitDirectRequest, "sessionId">) => this.controlPlane("/api/internal/git/direct", { sessionId: binding.session.id, ...request });
    this.#direct = directGrant && new DirectGit({ grant: directGrant, onFallback: (request, reason) => this.#egress?.noteFallback(request.bindingId, reason) });
    if (this.#onHost) this.sandbox = new HostWorkspace(binding, join(directory, "sandbox"));
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

  async authorize(actorId: string, permission: Permission, expectedPolicyVersion?: number, host = false, hostSessions = false, archived = false, autoApprove = false,
    memberAutoApprove = false): Promise<AuthorizationResult> {
    const body: AuthorizationRequest = { sessionId: this.binding.session.id, ownerId: this.binding.owner.id, actorId, permission,
      ...(host ? { host: true } : {}), ...(host && hostSessions ? { hostSessions: true } : {}), ...(archived ? { archived: true } : {}),
      ...(autoApprove ? { autoApprove: true } : {}), ...(memberAutoApprove ? { memberAutoApprove: true } : {}) };
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

  private async hostCommandLevel(actorId: string, permission: Permission): Promise<HostCommandLevel | undefined> {
    if (this.binding.session.connectorOwnerId && actorId === this.binding.session.connectorOwnerId) return "auto";
    const result = await this.authorize(actorId, permission, undefined, true);
    return result.hostCommands === "approve" || result.hostCommands === "auto" ? result.hostCommands : undefined;
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

  private trackPreparation(epoch: number, preparing: Extract<RepositoryPreparation, { status: "preparing" }>): void {
    const { done, items } = preparing;
    this.#repositories = preparing;
    done.then(() => {
      if (this.#repositories !== preparing) return;
      this.#repositories = { status: "ready" };
      this.#activity?.changed();
      void this.exclusive(async () => {
        if (epoch !== this.#preparations || !this.#opened || this.closing || this.#resumed || this.#repositories.status !== "ready") return;
        await this.resumeWork();
      }).catch(() => {
        if (epoch !== this.#preparations) return;
        this.#repositories = { status: "failed", reason: "This session could not resume its work after preparing its repositories", items };
        this.#activity?.changed();
      });
    }, (error: unknown) => {
      if (this.#repositories !== preparing) return;
      this.#repositories = { status: "failed", reason: error instanceof RunnerError ? error.message : "Repositories could not be prepared on this host", items };
      this.#activity?.changed();
    });
  }

  private prepareClones(pending: { path: string; origin: string | null }[]): void {
    const epoch = ++this.#preparations;
    const controller = new AbortController();
    const authorize = async () => { controller.signal.throwIfAborted(); await this.authorize(this.binding.owner.id, "write"); };
    const items: RepositoryPreparationItem[] = pending.map(({ path }) => ({ path, phase: "queued", percent: null, done: null, total: null, bytes: 0 }));
    const update: ProgressUpdate = (path, change) => { const item = items.find(each => each.path === path); if (item) Object.assign(item, change); };
    const done = (async () => {
      const failures: { path: string; reason: string }[] = [];
      for (const entry of pending) {
        controller.signal.throwIfAborted();
        update(entry.path, { phase: "connecting" });
        try {
          const repository = repositoryForRemote((await this.#egress!.grant()).repositories, entry.origin ?? "");
          if (!repository) throw new RunnerError(409, "its origin is not one of this workspace's repositories");
          let reference: string | null = null;
          if (this.config.repositoryCache && repository.repositoryId !== undefined) {
            const progress = ({ phase, percent, done, total, bytes }: MirrorProgress) => {
              if (repositoryPreparationPhases.includes(phase as RepositoryPreparationItem["phase"])) update(entry.path, { phase: phase as RepositoryPreparationItem["phase"], percent, done, total, bytes });
            };
            try { reference = await this.mirror(repository, progress); } catch { }
          }
          update(entry.path, { phase: "receiving" });
          await isolatedWorkspace(this.sandbox).cloneRestore(entry.path, bindingRemote(repository), reference, authorize);
        } catch (error) {
          if (controller.signal.aborted) throw error;
          const reason = error instanceof RunnerError ? error.message
            : error instanceof Error ? /sandbox: ([a-z0-9 ,.'()-]{1,160})$/i.exec(error.message.trim())?.[1] ?? "it could not be cloned again" : "it could not be cloned again";
          failures.push({ path: entry.path, reason });
        }
        update(entry.path, { phase: "done" });
      }
      this.#cloneFailures = failures;
    })();
    this.trackPreparation(epoch, { status: "preparing", done, controller, items });
  }

  private requireRepositoriesReady(): void {
    const preparation = this.#repositories;
    if (preparation.status === "preparing") throw new RunnerError(409, "This session's repositories are still being prepared on its host. Try again once they are ready.");
    if (preparation.status === "failed") throw new RunnerError(502, preparationFailure(preparation.reason));
  }

  private repositoryView(): RepositoryPreparationView | undefined {
    const preparation = this.#repositories;
    if (preparation.status === "ready") return undefined;
    return { status: preparation.status, items: preparation.items.map(item => ({ ...item })), ...(preparation.status === "failed" ? { error: preparation.reason } : {}) };
  }

  private lfsInstructions(): string {
    if (!this.#lfsRepositories.length) return "";
    const lfs = hostGitLfs();
    if (!lfs) return `\nGit LFS is on for ${this.#lfsRepositories.join(", ")}, but git-lfs is not installed on this host, so clones check out LFS pointer files.`;
    return `\nGit LFS is on for ${this.#lfsRepositories.join(", ")}: clones of them check out LFS files' content. In a clone made otherwise, or restored from a backup, `
      + `run ${lfs} install --local, then ${lfs} pull. Other repositories check out LFS pointer files. `
      + "LFS objects are never uploaded from this session, so don't add or change LFS-tracked files in commits you push.";
  }

  private agentInstructions(mode: "write" | "ask" | "read", off: ReadonlySet<string> = new Set(), browserUnavailable?: BrowserUnavailableReason,
    tunnelUnavailable?: TunnelUnavailableReason, kindsOff: ReadonlySet<DocumentKind> = new Set(), extensionTools: ReadonlySet<string> = new Set()): string {
    let instructions = this.binding.agent.instructions;
    if (this.#clone && !this.#egress) {
      instructions += "\n\nTrusted runtime repository context:\n"
        + "The execution root is the session worktree, which starts empty; file-tool paths are relative to it. This host runs without a sandbox: "
        + "clone the repositories you need into the worktree with plain Git (for example git clone https://github.com/<owner>/<name>), "
        + "and fetch, switch, commit and push as usual. Git uses this host's own network and credentials, and each command waits for approval."
        + (this.#cloneRepositories.length ? `\nThis workspace's repositories: ${this.#cloneRepositories.join(", ")}.` : "");
    } else if (this.#clone) {
      const branch = sessionBranch(this.binding.session);
      instructions += "\n\nTrusted runtime repository context:\n"
        + "The execution root is the isolated session worktree, which starts empty; file-tool paths are relative to it. "
        + "Clone the repositories you need into it with plain Git (for example git clone https://github.com/<owner>/<name>), "
        + "and fetch, switch and create branches as usual. Git reaches this workspace's repositories through the session's egress proxy "
        + "with the session owner's own access; no credentials are needed or available. Commit with Git. "
        + `This session's own branch is ${branch} (also in $PIKIBUN_SESSION_BRANCH): push your work to it with plain git, for example `
        + `git push origin HEAD:${branch}, in any of the workspace's repositories, without approval. Pushes of other branches are refused there.`
        + (this.#cloneRepositories.length ? `\nThis workspace's repositories: ${this.#cloneRepositories.join(", ")}.` : "")
        + this.lfsInstructions()
        + (this.#cloneFailures.length ? "\nThis session was restored from a backup or moved, and these clones could not be cloned again: "
          + this.#cloneFailures.map(failure => `${failure.path} (${failure.reason})`).join(", ")
          + ". Their backed-up work (branches, and the working tree as a commit) is in Git bundles under .git/pikibun-clones, listed in its "
          + "manifest.json; Pikibun tries again when the session next opens, as long as nothing else is at their paths." : "");
      if (this.binding.agent.tools.includes("git_push") && !off.has("git_push"))
        instructions += "\ngit_push publishes a clone's checked-out commit, as it is, to another branch of the workspace repository it was cloned from, "
          + "with approval: git_push {directory, branch}, where directory is the clone's path in the worktree. Pushes are fast-forward only (never forced); "
          + "if the branch moved, fetch and merge or rebase first. Optionally request a pull request with pull_request {title, body, base?, draft?}; "
          + `to open one from the session branch once you pushed it, call git_push with branch ${branch}. `
          + "With draft: true it opens as a draft; with draft: false it opens ready for review, or marks the branch's open draft ready for review, "
          + "with that title and body. "
          + "To tag a commit that is already on a branch (a release tag on main, say), check it out in the clone and call "
          + "git_push {directory, branch, tag}: it creates that tag at the commit and moves no branch. Tags are never moved; "
          + "plain git push of tags is refused.";
    }
    const defined = this.#definitions.filter(definition => !off.has(definition.name));
    const sources = this.#sources.filter(source => !kindsOff.has(source.kind));
    for (const definition of defined) {
      if (definition.kind !== "brokered" || !definition.instructions || !this.binding.agent.tools.includes(definition.name)) continue;
      if (definition.instructions.includes("{sources}") && !sources.length) continue;
      instructions += `\n\n${definition.instructions.replaceAll("{sources}",
        sources.map(source => `${JSON.stringify(source.title)} (${documentKindNames[source.kind]} ${source.type}, source ${source.id})`).join(", "))}`;
    }
    if (this.#conversationOnlyRestore) instructions += "\n\nThis session was restored from a backup that kept only its conversation: "
      + "the files, clones and uncommitted work its messages from before that restore mention were not restored with it, so they may be "
      + "missing unless they were made again since. Clone the repositories you need again, and check that a file exists before relying on it.";
    if (this.tools.some(tool => tool.name === "search")) instructions += "\n\nTo find and read code, use search (a regular expression or text across the worktree's files, "
      + "with path, glob and context) and read_file with offset and limit (just the lines around a match) rather than reading whole files: "
      + "they need no approval and their output is already bounded.";
    if (mode !== "ask" && this.tools.some(tool => tool.name === "move_file")) instructions += "\n\nTo move, copy or delete files and directories, "
      + "use move_file, copy_file and delete_file (write_file makes the directories it needs): they need no approval.";
    if (mode !== "ask" && this.tools.some(tool => tool.name === "git") && !off.has("git")) instructions += "\n\nRun Git with the git tool: "
      + "its arguments as a list, with directory naming the clone, such as git {args: [\"clone\", \"https://github.com/<owner>/<name>\"]}, "
      + "git {args: [\"status\"], directory: \"<name>\"} or git {args: [\"commit\", \"-am\", \"Fix the parser\"], directory: \"<name>\"}. "
      + "It needs no quoting, and its approval card shows exactly the Git command it runs.";
    const missing = mode !== "ask" ? this.missingPrograms(off) : [];
    if (mode !== "ask") for (const definition of defined) {
      if (definition.kind !== "program" || !definition.instructions) continue;
      const absent = missing.find(item => item.tool === definition.name)?.programs ?? [];
      const managers = this.linuxSandbox() ? definition.programs.filter(program => program !== "node" && !absent.includes(program)) : ["npm", "npx"];
      instructions += `\n\n${definition.instructions}`
        + (definition.toolchain === "node" && this.sandbox.nodeBin ? ` It runs Node.js ${process.versions.node} (this host's connector's own)${managers.length
          ? `, with ${managers.length > 1 ? `${managers.slice(0, -1).join(", ")} and ${managers.at(-1)}` : managers[0]}` : ""}, ahead of any other on PATH.` : "");
    }
    if (mode !== "ask" && this.tools.some(tool => tool.name === "python") && !off.has("python")) instructions += "\n\nRun Python, pip, uv, poetry and pytest with the python tool "
      + "(there is no shell). Make a virtual environment, then install into it and run there: python {program: \"python3\", args: [\"-m\", \"venv\", \".venv\"], directory: \"<name>\"}, "
      + "python {program: \"pip\", args: [\"install\", \"-r\", \"requirements.txt\"], directory: \"<name>\", venv: \".venv\"}, python {program: \"pytest\", args: [\"-q\"], directory: \"<name>\", venv: \".venv\"}.";
    const programs = mode !== "ask" ? programToolsInstructions(defined) : undefined;
    if (programs) instructions += `\n\n${programs}`;
    const missingText = programsMissingText(Object.fromEntries(missing.map(item => [item.tool, item.programs])));
    if (missingText) instructions += `\n\n${missingText} Calls to them are refused before they run. When a task needs one, use what this session has `
      + "where you can (npx -y pnpm@<version> for a project's pnpm, say, or pytest installed into a virtual environment), and tell the user what the host's owner installs.";
    if (mode !== "ask" && this.#builtins) instructions += "\n\nTo chain tools, loop over their results or cut and filter long output, "
      + "write a codemode script that calls them: there is no shell to pipe commands through.";
    const github = mode !== "ask" ? githubInstructions({
      github: this.tools.some(tool => tool.name === "github_read") && !off.has("github_read"),
      gh: extensionTools.has("gh"),
    }) : "";
    if (github) instructions += `\n\n${github}`;
    if (mode !== "ask" && this.sandbox.browser && this.tools.some(tool => tool.name === "browser") && !off.has("browser")) instructions += "\n\nTo look at or test a web page, "
      + "use the browser tool, a headless Chromium in the sandbox that answers with a screenshot, the page's text and its interactive elements: "
      + "browser {url: \"https://example.com/\"}, or for the web app you work on, serve it in the same call, as each call is its own sandboxed command: "
      + "browser {serve: {program: \"pnpm\", args: [\"dev\", \"--port\", \"5173\"], directory: \"<name>\", port: 5173}, url: \"http://localhost:5173/\", "
      + "actions: [{action: \"click\", selector: \"text=Sign in\"}, {action: \"type\", selector: \"#email\", text: \"a@example.com\", submit: true}]}. "
      + "Use the selectors its answer lists. Its approval card shows exactly the command it runs.";
    else if (mode !== "ask" && browserUnavailable) instructions += `\n\nThis session has no browser tool: ${browserUnavailableText(browserUnavailable)} `
      + "If you're asked to look at or test a web page, say so, and use what you have instead (fetching it, or running its tests).";
    if (mode === "write" && this.tools.some(tool => tool.name === "tunnel") && !off.has("tunnel")) instructions += "\n\nTo put the web app you work on online "
      + "at a public https:// address, so people can open it in a browser or on a phone, use the tunnel tool: "
      + "tunnel {action: \"start\", serve: {program: \"pnpm\", args: [\"preview\", \"--port\", \"4173\"], directory: \"<name>\", port: 4173}} runs the server "
      + "in the sandbox as a service that keeps running after the call, and answers with its address once Cloudflare gave it one. "
      + "Have the server listen on that port on localhost and accept any Host header (Vite: --host and server.allowedHosts). "
      + "Each start waits for the approval of the host's owner, and replaces the one online. tunnel {action: \"status\"} gives the address, "
      + "whether it is connected and the server's last output; tunnel {action: \"stop\"} takes it offline. Stop it once it isn't needed.";
    else if (mode === "write" && tunnelUnavailable) instructions += `\n\nThis session has no tunnel tool: ${tunnelUnavailableText(tunnelUnavailable)} `
      + "If you're asked to put a web app online, say so.";
    if (mode === "ask") instructions += "\n\nThis is a read-only ask. Inspect isolated session files only; do not modify files, execute commands, or perform external effects.";
    if (mode === "read") instructions += "\n\nThis request is read-only. Inspect isolated session files; any change to files, command or other effect waits for the session owner to allow it.";
    return instructions;
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
      this.#branchRepositories = grant?.repositories ?? [];
      this.#cloneRepositories = this.#branchRepositories.map(repository => bindingRemote(repository));
      this.#sources = grant?.sources ?? [];
    } else if (this.#clone) {
      const grant = await this.#egress!.grant().catch(() => null);
      const repositories = grant?.repositories ?? [];
      this.#sources = grant?.sources ?? [];
      this.#cloneRepositories = repositories.map(repository => bindingRemote(repository));
      this.#lfsRepositories = repositories.filter(repository => repository.lfs).map(repository => bindingRemote(repository));
      await this.#mirrors?.restore(repositories);
      this.#cloneFailures = [];
      if (await lstat(join(this.directory, "sandbox", "git", "pikibun-clones", "manifest.json")).then(() => true, () => false)) {
        const pending = await isolatedWorkspace(this.sandbox).clonePending(async () => {});
        if (pending.length) this.prepareClones(pending);
      }
    }
    const registry = createRegistry();
    const own = this.buildTools();
    this.#definitions = this.usableDefinitions(await this.fetchDefinitions(), own.map(tool => tool.name));
    this.#definedExtensions = [];
    this.tools = [...own, ...this.#definitions.map(definition => this.definedTool(definition))];
    const extension = defineExtension({ name: "workspace-tools", tools: this.tools });
    this.#extension = extension;
    registry.install(extension);
    this.#registry = registry;
    if (!this.#packed) {
      this.#builtins = new SessionBuiltins({ outputs: api => this.outputFiles(api) });
      for (const builtin of this.#builtins.extensions.values()) registry.install(builtin);
    }
    if (this.config.extensions && !this.#packed) {
      this.#hostExtensions = new SessionExtensions(this.extensionHost(), this.tools.map(tool => tool.name));
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
      await this.sweepInputs();
    }
    if (!this.#frozen && !this.#packed) {
      for (const run of Object.values((await this.metadata()).runs)) if (run.screening && run.status === "queued") void this.screen(run.key);
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
        const content = await this.runInput(run);
        if (content === undefined) {
          await this.endLostInputs(run.key);
          continue;
        }
        await this.applyOptions(conversation, run, content);
        submission = await conversation.submit({ type: "input", content, requestId: run.key }, context);
      } else submission = await this.harness.submission(run.submissionId as SubmissionId, context);
      if (submission) {
        await this.mutate(meta => { const saved = meta.runs[run.key]!; saved.submissionId = submission.id; saved.status = "running"; });
        this.observeRun(run.key, submission.id);
      }
    }
    if (Object.values(state.runs).some(run => run.stopped?.pending)) await this.abortStopped();
    await this.sweepInputs();
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
    let committed: Metadata | undefined;
    await this.root.commit(async tx => {
      const doc = await tx.doc(RunnerState);
      const state = JSON.parse(doc.json) as Metadata;
      change(state);
      doc.json = JSON.stringify(state);
      committed = state;
    }, context);
    this.#activity?.changed();
    if (committed) this.#waits.settle(committed.approvals);
  }

  private async awaitCard(id: string, waiting: Context, deadline: number): Promise<ApprovalRecord> {
    const waiter = this.#waits.waiter(id);
    const current = (await this.metadata()).approvals[id];
    if (current && answered(current)) {
      this.#waits.forget(id);
      return current;
    }
    const interrupt = (result: string) => this.mutate(meta => {
      const pending = meta.approvals[id];
      if (pending?.status === "pending") Object.assign(pending, { status: "interrupted", result });
    });
    const expiry = setTimeout(() => void interrupt("The session owner did not answer within an hour of the message.").catch(() => {}), Math.max(0, deadline - Date.now()));
    expiry.unref();
    try { return await awaitWithContext(waiter.promise, waiting); }
    catch (error) {
      this.#waits.forget(id);
      await interrupt("The tool call stopped before a decision.").catch(() => {});
      throw error;
    } finally { clearTimeout(expiry); }
  }

  private async operationOutcome(approval: ApprovalRecord, waiting: Context): Promise<ApprovalRecord> {
    if (answered(approval)) {
      this.#waits.forget(approval.id);
      return this.#waits.whole(approval);
    }
    const state = await this.metadata();
    const actor = state.toolActors[approval.id.slice("tool-".length)];
    const run = actor && state.runs[actor.runKey];
    return this.#waits.whole(await this.awaitCard(approval.id, waiting, (run?.submittedAt ?? Date.now()) + DECISION_WAIT_MS));
  }

  private reportBranches(): void {
    const send = this.config.reportBranches;
    if (!send || !this.#onHost || !this.#clone || this.closing) return;
    if (this.#branchesReporting) { this.#branchesWanted = true; return; }
    this.#branchesReporting = true;
    void (async () => {
      try {
        do {
          this.#branchesWanted = false;
          if (!this.#branchRepositories.length) this.#branchRepositories = (await this.requestGrant()).repositories;
          if (!this.#branchRepositories.length) break;
          const clones = await (this.sandbox as HostWorkspace).cloneBranches(async () => {});
          const branches = reportedBranches(clones, this.#branchRepositories);
          const json = JSON.stringify(branches);
          if (json === this.#branchesSent) continue;
          await send(this.binding.session.id, branches);
          this.#branchesSent = json;
        } while (this.#branchesWanted && !this.closing);
      } catch (error) {
        console.warn(`Session ${this.binding.session.id}: could not report its clones' branches: ${error instanceof Error ? error.message : String(error)}`);
      }
      finally { this.#branchesReporting = false; }
    })();
  }

  private async activity(): Promise<SessionActivity> {
    const preparation = this.#repositories.status;
    if (preparation !== "ready") return preparation === "preparing" ? "working" : "failed";
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

  private observeRun(key: string, submissionId: SubmissionId): void {
    const generation = this.generation;
    const harness = this.harness;
    void (async () => {
      const submission = await harness.submission(submissionId, context);
      if (!submission) throw new Error("Missing durable submission");
      const settled = await submission.wait(context);
      if (generation !== this.generation || this.closing) return;
      void this.#hostExtensions?.agentEnd([], settled.status !== "done").catch(() => {});
      const state = await this.metadata();
      const conversation = await harness.conversation(state.runs[key]!.conversationId as ConversationId, context);
      await conversation?.waitForIdle(context);
      const compaction = settled.status === "unanswered" && settled.reason === "model_error" ? compactionFailure(settled.detail) : undefined;
      const cause = settled.status === "unanswered" && settled.reason === "model_error" && !compaction ? modelFailureCause(settled.detail) : undefined;
      const failed = settled.status === "unanswered" && (settled.reason === "model_error" || settled.reason === "no_model");
      const model = failed ? (await conversation?.agent(context))?.model : undefined;
      const failure: Run["failure"] = failed
        ? { reason: compaction ? "compaction_failed" : settled.reason, ...model, ...(compaction ? { compaction } : {}), ...(cause ? { cause } : {}) } : undefined;
      const compacts = !!failure && !!conversation && await this.compactsAfterFailure(conversation, state.runs[key]!.mode, cause, model);
      const crashed = settled.status === "unanswered" && (settled.reason === "restart_limit" || settled.reason === "interrupted");
      await this.exclusive(async () => {
        if (generation !== this.generation || this.closing) return;
        if (compacts && !(await this.metadata()).runs[key]?.stopped) {
          try { await conversation!.compact(undefined, context); failure!.compacting = true; }
          catch { }
        }
        await this.mutate(meta => {
          const run = meta.runs[key]!;
          if (run.stopped) return;
          if (crashed) Object.assign(run, { status: "interrupted", crashed: true });
          else run.status = "settled";
          if (failure) run.failure = failure;
        });
      });
      if (generation === this.generation && !this.closing) this.drainQueue();
    })().catch(() => { });
  }

  private async compactsAfterFailure(conversation: Conversation, mode: Run["mode"], cause: ModelFailureCause | undefined,
    model: { provider: string; modelId: string } | undefined): Promise<boolean> {
    if (cause !== "incomplete_stream" || mode !== "write") return false;
    try {
      const enabled = compactionEnabled(configuredCompaction(this.config.compaction, this.#configuredCompaction), model);
      const tokens = contextTokens((await conversation.context(context)).messages);
      return compactsAfterFailure({ cause, mode, tokens, enabled });
    }
    catch { return false; }
  }

  private drainQueue(): void {
    if (this.draining) { this.#drainAgain = true; return; }
    if (this.closing || this.#repositories.status !== "ready") return;
    this.draining = true;
    this.#drainAgain = false;
    void this.exclusive(async () => {
      while (!this.closing) {
        const state = await this.metadata();
        if (Object.values(state.runs).some(run => run.status === "running" || run.status === "admitting" || run.stopped?.pending)
          || Object.values(state.approvals).some(approval => approval.status === "executing")) return;
        const run = Object.values(state.runs).filter(candidate => candidate.status === "queued")
          .sort((a, b) => (a.sequence ?? 0) - (b.sequence ?? 0))[0];
        if (!run || run.screening) return;
        try { await this.authorize(run.initiatedBy, run.mode === "ask" ? "ask" : "write"); }
        catch {
          if (run.images) await this.#inputs.discard([run.key]);
          await this.mutate(meta => { meta.runs[run.key]!.status = "interrupted"; });
          continue;
        }
        const refusal = await this.requiredRefusal(true).catch(() => INPUT_FAILED);
        if (refusal) {
          if (run.images) await this.#inputs.discard([run.key]);
          await this.mutate(meta => { Object.assign(meta.runs[run.key]!, { status: "interrupted", refused: { by: "", notice: refusal } }); });
          continue;
        }
        const content = await this.runInput(run);
        if (content === undefined) {
          await this.endLostInputs(run.key);
          continue;
        }
        const conversation = await this.harness.conversation(run.conversationId as ConversationId, context);
        if (!conversation) throw new Error("Persisted branch is missing");
        const transcript = await conversation.context(context);
        await this.mutate(meta => {
          meta.runs[run.key]!.status = "admitting";
          meta.runs[run.key]!.started = true;
          meta.runs[run.key]!.startEntry = transcript.entries.at(-1)?.id ?? 0;
        });
        await this.applyOptions(conversation, run, content);
        const submission = await conversation.submit({ type: "input", content, requestId: run.key }, context);
        await this.mutate(meta => {
          meta.runs[run.key]!.submissionId = submission.id;
          meta.runs[run.key]!.status = "running";
        });
        if (run.images) await this.#inputs.discard([run.key]);
        this.observeRun(run.key, submission.id);
        return;
      }
    }).catch(() => { })
      .finally(() => {
        this.draining = false;
        if (this.#drainAgain) { this.#drainAgain = false; this.drainQueue(); }
      });
  }

  private async applyOptions(conversation: Conversation, run: Run, content?: string | ({ type: "text"; text: string } | { type: "image"; data: string; mimeType: string })[]): Promise<void> {
    const options = run.options ?? {};
    const access = options.access ?? "approval";
    const extensions = run.mode === "write" ? await this.chosenExtensions().catch(() => []) : [];
    if (run.mode === "write") await this.refreshDefinitions(extensions.flatMap(extension => extension.tools.map(tool => tool.name)));
    const off = run.mode === "write" ? await this.sessionToolsOff() : new Set<string>();
    const own = new Set(this.tools.map(tool => tool.name));
    const kindsOff = run.mode === "write" ? await this.documentKindsOff() : new Set<DocumentKind>();
    const browserUnavailable = run.mode === "write" && !off.has("browser") ? this.browserUnavailable() : undefined;
    if (!this.sandbox.browser) off.add("browser");
    const tunnelUnavailable = run.mode === "write" && !off.has("tunnel") ? this.tunnelUnavailable() : undefined;
    if (!this.tunnelOffered()) off.add("tunnel");
    const builtins = run.mode === "write" && this.#builtins
      ? this.#builtins.select((await this.hostConfig()).builtinExtensions, new Set(extensions.flatMap(item => item.tools.map(tool => tool.name)))).map(item => item.extension)
      : [];
    const change: AgentChange = {
      ...(options.model ? { model: { provider: options.model.provider, modelId: options.model.modelId } } : {}),
      ...(options.thinkingLevel ? { thinkingLevel: options.thinkingLevel } : {}),
      ...(run.mode === "write" ? {
        tools: [...this.tools.filter(tool => !off.has(tool.name)), ...extensions.flatMap(extension => extension.tools).filter(tool => !own.has(tool.name)),
          ...builtins.flatMap(extension => extension.tools ?? [])],
        extensions: [this.#extension, ...this.#definedExtensions, ...extensions.map(extension => extension.extension), ...builtins],
        instructions: this.agentInstructions(access === "read" ? "read" : "write", off, browserUnavailable, tunnelUnavailable, kindsOff,
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

  private browserUnavailable(): BrowserUnavailableReason | undefined {
    if (this.sandbox.browser) return undefined;
    if (this.#onHost) return "on-host";
    if (this.config.sandboxBackend) return "sandbox";
    const status = this.config.browserStatus?.();
    if (!status) return undefined;
    return browserUnavailableReason(status.state) ?? "missing";
  }

  private tunnelUnavailable(): TunnelUnavailableReason | undefined {
    if (!this.config.tunnels) return undefined;
    if (this.#onHost) return "on-host";
    if (this.config.sandboxBackend || !(this.sandbox instanceof Sandbox)) return "sandbox";
    const status = this.config.tunnels.status();
    return status ? tunnelUnavailableReason(status.state) : "missing";
  }

  private linuxSandbox(): Sandbox | undefined {
    return !this.#onHost && !this.config.sandboxBackend && this.sandbox instanceof Sandbox ? this.sandbox : undefined;
  }

  private missingPrograms(off: ReadonlySet<string>): { tool: string; source: string; programs: string[] }[] {
    const sandbox = this.linuxSandbox();
    if (!sandbox) return [];
    const node = sandbox.nodePrograms;
    const tools = [
      ...this.#definitions.filter((definition): definition is ProgramToolDefinition => definition.kind === "program" && !off.has(definition.name))
        .map(definition => ({ tool: definition.name, source: definition.extensions[0] ?? `piki:${definition.name}`, programs: sandboxMissingPrograms(definition, node) })),
      ...(this.tools.some(tool => tool.name === "python") && !off.has("python")
        ? [{ tool: "python", source: "piki:python", programs: sandboxMissingPrograms({ programs: pythonPrograms, path: "/usr/local/bin" }) }] : []),
    ];
    return tools.filter(item => item.programs.length);
  }

  private programMissing(tool: { programs: readonly string[]; path: string | readonly string[]; toolchain?: "node" }, program: string): string | undefined {
    const sandbox = this.linuxSandbox();
    if (!sandbox || !sandboxMissingPrograms({ ...tool, programs: [program] }, sandbox.nodePrograms).length) return undefined;
    return `${program} isn't installed on this host where the session's sandbox sees it, so the call would fail with "command not found". `
      + `The host's owner installs it for the whole system, as the sandbox sees only the host's /usr: ${programInstallStep(program) ?? "the distribution's package"}. `
      + "Tell the user so, and use what this session has meanwhile where you can.";
  }

  private tunnelOffered(): boolean {
    return !!this.config.tunnels && this.tunnelUnavailable() === undefined;
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
      openTunnel: async signal => tunnels.open(pinServiceSocket(sockets), signal),
      lifetimeMs: async () => (await this.hostConfig()).serviceLifetimeSeconds * 1000,
      report: async item => { await report?.({ sessionId: this.binding.session.id, ...item }); },
      recheck: async actorId => { await this.authorize(actorId, "write"); },
      changed: () => this.#activity?.changed(),
    });
    return this.#tunnel;
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

  private definedToolsOff(off: Set<string>, extensions: Parameters<typeof sessionToolsOff>[0]): Set<string> {
    for (const definition of this.#definitions) {
      off.delete(definition.name);
      if (!definition.extensions.some(extension => extensionSwitchOn(extension, extensions))) off.add(definition.name);
    }
    return off;
  }

  private async sessionToolsOff(): Promise<Set<string>> {
    const config = this.config.extensions;
    const workspaceId = this.binding.session.workspaceId;
    const answer = config ? await config.workspace(workspaceId).catch(() => undefined) : undefined;
    const extensions = answer?.extensions ?? [];
    const off = this.definedToolsOff(sessionToolsOff(extensions), extensions);
    if (!config) return off;
    const last = config.lastKnown?.(workspaceId);
    if (last) for (const tool of sessionToolsOff(last.extensions, { failClosedOnly: true })) off.add(tool);
    return off;
  }

  private async documentKindsOff(): Promise<Set<DocumentKind>> {
    const config = this.config.extensions;
    if (!config) return new Set();
    const answer = await config.workspace(this.binding.session.workspaceId).catch(() => undefined);
    return answer ? documentKindsOff(answer.extensions) : new Set();
  }

  private async requireSessionTool(tool: string): Promise<void> {
    if (!(await this.sessionToolsOff()).has(tool)) return;
    const defined = this.#definitions.find(item => item.name === tool);
    const extensions = defined ? [...defined.extensions] : sessionToolExtensions(tool).map(item => item.source);
    throw new RunnerError(403, `${tool} is turned off in this workspace${extensions.length ? ` (${extensions.join(", ")})` : ""}. Its owners and admins add it under Settings → Workspaces → Extensions.`);
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

  private async outputFiles(api: ToolExecutionApi): Promise<OutputFiles | undefined> {
    const attribution = await this.toolActor(api, true);
    const state = await this.metadata();
    const run = state.runs[state.toolActors[String(api.taskId)]!.runKey]!;
    if (run.options?.access === "read") return undefined;
    return { writeFile: (path, content) => this.saveOutput(path, content, async () => { await this.recheckTool(attribution); }) };
  }

  private async saveOutput(path: string, content: string, authorize: SandboxAuthorize): Promise<void> {
    await this.sandbox.writeFile(path, content, authorize);
    await this.#savedOutputs.saved(path, {
      list: directory => this.sandbox.listFiles(directory, authorize),
      remove: async entry => { await this.sandbox.fileOperation({ kind: "delete", path: entry, recursive: true }, authorize); },
    }).catch(() => {});
  }

  private extensionHost(): ExtensionHost {
    return {
      directory: this.sandbox.hostWorktree,
      ...(this.config.extensions?.modelRegistry ? { modelRegistry: this.config.extensions.modelRegistry } : {}),
      model: () => {
        const current = this.#currentModel ?? this.modelRef;
        return current && this.config.extensions?.modelRegistry?.find(current.provider, current.modelId) as never;
      },
      thinkingLevel: () => this.#currentModel?.thinkingLevel,
      state: async source => {
        const item = (await this.extensionChoice()).chosen.find(candidate => candidate.source === source);
        return { active: !!item, settings: item?.required?.settings ?? item?.workspace?.settings ?? {} };
      },
      runTool: (call, execute) => this.runExtensionTool(call, execute),
      piki: this.pikiSession(),
      hookTimeoutMs: 30_000,
      inputTimeoutMs: 60_000,
      warn: (source, message) => { process.stderr.write(`Session ${this.binding.session.id}, extension ${source}: ${message.replace(/[\x00-\x1f]/g, " ").slice(0, 500)}\n`); },
    };
  }

  private pikiSession(): PikiSession {
    const hostOwner = this.binding.session.connectorOwnerId;
    const ownSession = !!hostOwner && hostOwner === this.binding.owner.id;
    return {
      hostSignIn: this.#onHost || (ownSession && this.config.pikiHostSignIn === true),
      ...(this.#egress && !this.#onHost ? { sandbox: (run: PikiSandboxRun) => this.runPikiCommand(run) } : {}),
      saveOutput: (callId, tool, output) => this.savePikiOutput(callId, tool, output),
    };
  }

  private async savePikiOutput(callId: string, tool: string, output: string): Promise<string> {
    const call = this.#pikiCalls.get(callId);
    if (!call) throw new RunnerError(403, "its call no longer runs");
    const path = toolOutputPath(tool, callId);
    await this.saveOutput(path, output, async () => { await this.recheckTool(call.attribution); });
    return path;
  }

  private async shownApproval(approval: StoredApproval, api: ToolExecutionApi, tool: string): Promise<Record<string, unknown>> {
    const shown = { ...approval, admissionId: undefined, callId: undefined };
    const result = approval.result;
    if (typeof result !== "string") return shown;
    const files = await this.outputFiles(api).catch(() => undefined);
    return { ...shown, result: await boundOutput(result, {
      ...(files
        ? { save: async (whole: string) => { const path = toolOutputPath(tool, String(api.callId)); await files.writeFile(path, whole); return path; } }
        : { unsaved: "a Read-only message doesn't write to the worktree" }),
      fits: candidate => Buffer.byteLength(JSON.stringify({ ...shown, result: candidate })) <= MODEL_OUTPUT.bytes,
    }) };
  }

  private async runPikiCommand(run: PikiSandboxRun): Promise<CliRun> {
    const call = this.#pikiCalls.get(run.callId);
    if (!call) throw new RunnerError(403, `${run.command} runs only in a call of its tool this session admitted. Nothing ran.`);
    const lease = call.write && !run.readOnly ? this.#egress?.apiLease() : undefined;
    try {
      const env = { ...run.env };
      if (lease) for (const name of run.tokenEnv) env[name] = lease.token;
      const command = sandboxShellCommand(run.command, run.args, env, run.directory);
      const output = await this.sandbox.execute({ kind: "bash", command }, run.readOnly, () => this.recheckTool(call.attribution), {
        unbounded: true, ...await this.commandOptions(), signal: AbortSignal.any([run.signal, AbortSignal.timeout(run.timeoutSeconds * 1000)]) });
      return { exitCode: 0, signal: null, output };
    } catch (error) {
      if (!(error instanceof SandboxProcessError)) throw error;
      const output = [error.stdout, error.stderr].filter(Boolean).join("\n");
      return { exitCode: error.exitCode, signal: error.signal, output, ...(error.exitCode === null && !error.signal ? { failure: error.message } : {}) };
    } finally {
      lease?.release();
    }
  }

  private async runExtensionTool(call: Parameters<ExtensionHost["runTool"]>[0], execute: Parameters<ExtensionHost["runTool"]>[1]): Promise<ToolExecutionResult> {
    const attribution = await this.toolActor(call.api, true);
    const state = await this.metadata();
    const run = state.runs[state.toolActors[String(call.api.taskId)]!.runKey]!;
    if (run.options?.access === "read") {
      throw new RunnerError(403, `${call.tool} comes from an extension, which runs outside the sandbox: a Read-only message doesn't run it. Nothing ran.`);
    }
    const { chosen, automaticTools } = await this.extensionChoice();
    const item = chosen.find(candidate => candidate.source === call.source);
    if (!item) throw new RunnerError(403, `This extension (${call.source}) no longer applies to this session; ${call.tool} didn't run.`);
    const json = JSON.stringify(call.arguments);
    const operation: ExtensionToolOperation = { kind: "extension.tool", source: call.source, tool: call.tool,
      arguments: json.length > EXTENSION_ARGUMENTS_SHOWN ? `${json.slice(0, EXTENSION_ARGUMENTS_SHOWN)}…` : json,
      digest: createHash("sha256").update(json).digest("hex") };
    let approval = await this.createApproval(attribution.initiatedBy, operation, String(call.api.taskId),
      { permitted: true, automatic: item.workspace?.tools === "automatic" && automaticTools });
    if (approval.status === "pending") approval = await this.operationOutcome(approval, call.context);
    if (approval.status === "denied") throw new RunnerError(403, `${call.tool} wasn't approved. Nothing ran.`);
    if (approval.status !== "approved" && approval.status !== "executing") throw new RunnerError(409, approval.result ?? `${call.tool} didn't run.`);
    const id = approval.id;
    await this.mutate(meta => { const card = meta.approvals[id]; if (card?.status === "approved") card.status = "executing"; });
    await this.recheckTool(attribution);
    const limits = commandLimits((await this.hostConfig()).commandTimeoutSeconds);
    const callId = String(call.api.callId);
    this.#pikiCalls.set(callId, { write: !(item.workspace?.tools === "automatic" && automaticTools), attribution });
    try {
      const result = await execute(AbortSignal.any([call.signal, AbortSignal.timeout(limits.seconds * 1000)]));
      const shown = (result.output ?? []).map(part => part.type === "text" ? part.text : `[${part.type}]`).join("\n");
      await this.mutate(meta => { Object.assign(meta.approvals[id]!, { status: result.isError ? "failed" : "executed", result: this.#waits.kept(id, shown || "(no output)") }); });
      return result;
    } catch (error) {
      await this.mutate(meta => { Object.assign(meta.approvals[id]!, { status: "failed", result: this.#waits.kept(id, error instanceof Error ? error.message : String(error)) }); }).catch(() => {});
      throw error;
    } finally {
      this.#pikiCalls.delete(callId);
    }
  }

  private async chatOptions(input: unknown, mode: "write" | "ask", actorId: string): Promise<ChatOptions | undefined> {
    if (input === undefined) return undefined;
    const invalid = (message = "Invalid chat options") => new RunnerError(422, message);
    if (!input || typeof input !== "object" || Array.isArray(input)) throw invalid();
    const value = input as Record<string, unknown>;
    if (Object.keys(value).some(key => !["model", "thinkingLevel", "access", "autoMerge"].includes(key))) throw invalid();
    const options: ChatOptions = {};
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
      if (value.access === "auto" && actorId !== this.binding.owner.id
        && (await this.authorize(actorId, "write", undefined, false, false, false, false, true)).memberAutoApprove !== true) {
        throw new RunnerError(403, "Only the session owner, or a workspace owner, admin or collaborator who can write to the session, can auto-approve");
      }
      options.access = value.access as ChatOptions["access"];
    }
    if (value.autoMerge !== undefined) {
      if (typeof value.autoMerge !== "boolean" || (value.autoMerge && options.access !== "auto")) throw invalid("Auto-merge needs Auto-approve");
      if (value.autoMerge && actorId !== this.binding.owner.id) throw invalid("Only the session owner's Auto-approve merges without asking");
      if (value.autoMerge) options.autoMerge = true;
    }
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

  private async screen(key: string): Promise<void> {
    const generation = this.generation;
    let outcome: InputOutcome | { action: "skip" };
    try { outcome = await this.screenInput(key); }
    catch (error) {
      process.stderr.write(`Session ${this.binding.session.id}: couldn't screen a message, so it was refused: ${String(error instanceof Error ? error.message : error).slice(0, 300)}\n`);
      outcome = { action: "refused", by: "", notice: INPUT_FAILED };
    }
    if (generation !== this.generation || this.closing) return;
    let images: InputImage[] | undefined;
    if (outcome.action === "continue") {
      const run = (await this.metadata()).runs[key];
      const before = run?.images ? await this.#inputs.read(key) ?? [] : [];
      const changed = outcome.images.length !== before.length || outcome.images.some((image, index) => image.data !== before[index]!.data);
      if (outcome.text.length > 100_000 || (!outcome.text.trim() && !outcome.images.length)) outcome = { action: "refused", by: "", notice: INPUT_EMPTY };
      else if (changed) {
        const parsed = parseChatImages(outcome.images.map(image => ({ mimeType: image.mimeType, data: image.data })));
        images = "error" in parsed ? undefined : parsed.images.length ? await prepareMessageImages(parsed.images).catch(() => undefined) : [];
        if (!images) outcome = { action: "refused", by: "", notice: INPUT_IMAGES };
        else if (images.length) await this.#inputs.write(key, images);
        else await this.#inputs.discard([key]);
      }
    }
    const result = outcome;
    let refused = false;
    await this.mutate(meta => {
      const run = meta.runs[key];
      if (!run?.screening || run.status !== "queued" || run.stopped || run.withdrawn) return;
      delete run.screening;
      if (result.action === "refused") {
        Object.assign(run, { status: "interrupted", refused: { by: result.by, notice: result.notice ?? REFUSED } });
        refused = true;
      } else if (result.action === "continue") {
        run.content = result.text;
        if (images) {
          if (images.length) run.images = { count: images.length, bytes: images.reduce((total, image) => total + image.data.length, 0) };
          else delete run.images;
        }
      }
    });
    if (refused) await this.#inputs.discard([key]);
    this.drainQueue();
  }

  private async screenInput(key: string): Promise<InputOutcome | { action: "skip" }> {
    const host = this.#hostExtensions;
    const run = (await this.metadata()).runs[key];
    if (!host || !run?.screening || run.status !== "queued") return { action: "skip" };
    const refusal = await this.requiredRefusal(true);
    if (refusal) return { action: "refused", by: "", notice: refusal };
    const images = run.images ? await this.#inputs.read(key) : [];
    if (!images) return { action: "skip" };
    const { chosen } = await this.extensionChoice();
    const hostOwner = this.binding.session.connectorOwnerId;
    const outcome = await host.input(chosen.map(item => item.source), run.content, images.map(image => ({ type: "image" as const, ...image })),
      hostOwner && run.initiatedBy === hostOwner ? "interactive" : "rpc");
    if (outcome.action !== "refused") return outcome;
    const notice = outcome.notice?.replace(/[\x00-\x1f\x7f]+/g, " ").trim().slice(0, 300);
    process.stderr.write(`Session ${this.binding.session.id}: ${outcome.by} refused a message${notice ? `: ${notice}` : ""}\n`);
    return { action: "refused", by: outcome.by, notice: notice || `An extension on this host (${outcome.by}) refused this message.` };
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

  private async sweepInputs(): Promise<void> {
    const runs = (await this.metadata()).runs;
    await this.#inputs.sweep(key => {
      const run = runs[key];
      return run !== undefined && run.submissionId === undefined && ["queued", "admitting", "running"].includes(run.status);
    });
  }

  private async endLostInputs(key: string): Promise<void> {
    await this.#inputs.discard([key]);
    await this.mutate(meta => { Object.assign(meta.runs[key]!, { status: "interrupted", inputsLost: true }); });
  }

  private async runInput(run: Run) {
    if (!run.images) return run.content;
    const images = await this.#inputs.read(run.key);
    if (!images) return undefined;
    return [
      ...(run.content.trim() ? [{ type: "text" as const, text: run.content }] : []),
      ...images.map(image => ({ type: "image" as const, data: image.data, mimeType: image.mimeType })),
    ];
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
      const preparation = this.#repositories;
      if (preparation.status === "failed") throw new RunnerError(502, preparationFailure(preparation.reason));
      await this.authorize(ticket.actorId, mode === "ask" ? "ask" : "write", ticket.policyVersion);
      await this.hostConfig();
      const options = await this.chatOptions(input.options, mode, ticket.actorId);
      if (prepared.length) await this.requireImageModel(options);
      const key = await requestKey(ticket.actorId, mode, input.requestId);
      const hash = await messageHash(input.content, images);
      const state = await this.metadata();
      const existing = state.runs[key];
      if (existing) {
        if (existing.contentHash !== hash) throw new RunnerError(409, "requestId reused with different content");
        if (existing.admissionId !== input.admissionId) throw new RunnerError(409, "requestId reused with a different Worker admission");
        if (stableJson(existing.options ?? null) !== stableJson(options ?? null)) throw new RunnerError(409, "requestId reused with different chat options");
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
          tools: this.tools.filter(tool => readOnlyTools.includes(tool.name) && this.binding.agent.tools.includes(tool.name as never)),
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
      if (screen) void this.screen(key);
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
        const keys = new Set(runs.map(run => run.key));
        for (const [taskId, actor] of Object.entries(meta.toolActors)) {
          if (!keys.has(actor.runKey)) continue;
          for (const card of [meta.approvals[`tool-${taskId}`], meta.approvals[`permission-${taskId}`], meta.approvals[`permission-${taskId}_audience`]]) {
            if (card?.status === "pending") Object.assign(card, { status: "interrupted", result: "The tool call stopped before a decision." });
          }
        }
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

  private async toolActor(api: ToolExecutionApi, write: boolean) {
    const doc = await api.snapshot(RunnerState, context);
    const state: Metadata = JSON.parse(doc!.json);
    const saved = state.toolActors[String(api.taskId)];
    const run = saved ? state.runs[saved.runKey] : Object.values(state.runs).find(candidate => candidate.conversationId === api.conversationId && (candidate.status === "running" || candidate.status === "admitting"));
    if (!run || !["admitting", "running"].includes(run.status) || run.ownerId !== this.binding.owner.id || (write && run.mode !== "write")) throw new RunnerError(403, "Tool has no authorized writable submission");
    await this.authorize(run.initiatedBy, run.mode === "ask" ? "ask" : "write");
    await api.commit(async tx => {
      const current = await tx.doc(RunnerState);
      const meta: Metadata = JSON.parse(current.json);
      meta.toolActors[String(api.taskId)] ??= { initiatedBy: run.initiatedBy, ownerId: run.ownerId, runKey: run.key, callId: api.callId };
      current.json = JSON.stringify(meta);
    }, context);
    return { initiatedBy: run.initiatedBy, actingAs: run.ownerId, mode: run.mode };
  }

  private async recheckTool(attribution: { initiatedBy: string; mode: "write" | "ask" }): Promise<void> {
    await this.authorize(attribution.initiatedBy, attribution.mode === "ask" ? "ask" : "write");
  }

  private async browserOutcome(approval: ApprovalRecord, recheck: () => Promise<void>, approvalText: (approval: StoredApproval) => ToolExecutionResult): Promise<ToolExecutionResult> {
    const report = approval.status === "executed" && approval.result ? parseBrowserReport(approval.result.trim()) : undefined;
    if (!report) return approvalText(approval as StoredApproval);
    const output: ToolExecutionResult["output"] = [{ type: "text", text: JSON.stringify({ ...approval, result: undefined, admissionId: undefined, callId: undefined, report }) }];
    if (report.screenshot) {
      try {
        const file = await this.sandbox.readContent(report.screenshot, recheck);
        const prepared = "image" in file ? await prepareImage(file.image, file.mimeType) : undefined;
        if (prepared && "image" in prepared) output.push({ type: "image", data: prepared.image.data, mimeType: prepared.image.mimeType });
      } catch { }
    }
    return { output };
  }

  private shellAllowed(): boolean {
    return (!!this.config.resources && !this.config.sandboxBackend) || (!this.#onHost && this.config.sandboxBackend?.kind === "windows") || this.#onHost || (this.binding.model.provider === "faux" && this.config.allowFaux && this.config.allowTestShell === true);
  }

  private async requireHostEnvironment(automatic = false): Promise<void> {
    if (!this.#hostSession) return;
    if (!(await this.hostConfig()).hostSessions) {
      throw new RunnerError(403, "This host no longer runs sessions directly on it: its owner turned that off in Pikibun (Settings → Hosts → the host → Configuration). "
        + "Nothing ran. Start a new session to work in the sandbox.");
    }
    if (this.binding.session.connectorOwnerId === this.binding.owner.id) return;
    const result = await this.authorize(this.binding.owner.id, "write", undefined, true, true);
    if (result.hostSessions !== true) {
      throw new RunnerError(403, "The session's owner may no longer run sessions directly on this host: the grant that let them has ended. "
        + "Nothing ran. Start a new session to work in the sandbox.");
    }
    if (automatic && result.hostCommands !== "auto") {
      throw new RunnerError(403, "This session runs directly on its host, and its owner no longer holds automatic host commands there: commands need approval. Nothing ran.");
    }
  }

  private async hostConfig(): Promise<HostConfig> {
    const config = this.config.hostConfig ? await this.config.hostConfig() : { ...defaultHostConfig };
    this.#configuredCompaction = config.compaction;
    return config;
  }

  private async commandOptions(): Promise<{ limits: CommandLimits; gpu: boolean }> {
    const config = await this.hostConfig();
    return { limits: commandLimits(config.commandTimeoutSeconds), gpu: config.gpu };
  }

  private requireShellCapability(operation: Operation, unbounded = false): void {
    if ((operation.kind === "bash" || operation.kind === "program") && !unbounded && !this.shellAllowed()) {
      throw new RunnerError(403, "Production shell requires a quota-backed runner; bash needs verified resources or explicitly enabled faux test sessions");
    }
  }

  private hostCommandSession(): HostCommandSession {
    return { ownerId: this.binding.owner.id, connectorOwnerId: this.binding.session.connectorOwnerId, hostEnvironment: this.#hostSession };
  }

  private async requireHostDecider(actorId: string, approval: Pick<StoredApproval, "operation" | "unbounded">): Promise<void> {
    if (!decidedAsHostCommand(approval.operation, this.hostCommandSession(), approval.unbounded === true)) return;
    if (await this.hostCommandLevel(actorId, "approve")) return;
    throw new RunnerError(403, approval.operation.kind === "host.bash" ? "Only the host owner, or a member granted host commands on this host, can decide a host command"
      : this.#hostSession ? "This session runs directly on its host: only the host owner, or a member granted host commands on this host, can decide its commands"
      : GRANTED_SHELL_DECIDERS);
  }

  private async requireShellGrant(automatic = false): Promise<void> {
    const level = this.binding.session.connectorOwnerId ? await this.hostCommandLevel(this.binding.owner.id, "write") : undefined;
    if (!level) {
      throw new RunnerError(403, "This host has no resource limits for commands, so it runs them only in sessions of its owner and of members they granted "
        + "host commands (Settings → Hosts → the host → Host command access). Nothing ran.");
    }
    if (automatic && level !== "auto") {
      throw new RunnerError(403, "This host has no resource limits for commands, and the session's owner no longer holds automatic host commands there: "
        + "commands need approval. Nothing ran.");
    }
  }

  private async permit(api: ToolExecutionApi, waiting: Context, tool: AnyToolName, target: string, effect: { write?: boolean; shell?: boolean; audience?: boolean } = {}): Promise<{ unbounded: boolean }> {
    const state = await this.metadata();
    const actor = state.toolActors[String(api.taskId)];
    const run = actor && state.runs[actor.runKey];
    if (!run) throw new RunnerError(403, "Tool has no authorized writable submission");
    const grants = state.grants;
    const needs: PermissionNeed[] = [];
    if (effect.audience) {
      if (!grants?.audience) needs.push("audience");
    } else {
      if (!this.binding.agent.tools.includes(tool) && !(tool !== "host_bash" && grants?.tools.includes(tool))) needs.push("tool");
      if (effect.write && run.options?.access === "read" && !grants?.write) needs.push("write");
    }
    const unbounded = effect.shell === true && !this.shellAllowed();
    if (unbounded) {
      if (grantedShell(this.hostCommandSession())) await this.requireShellGrant();
      if (!grants?.unboundedShell) needs.push("unbounded-shell");
    }
    if (!needs.length) return { unbounded };
    if (run.options?.access === "auto" && run.mode === "write" && run.initiatedBy === this.binding.owner.id) return { unbounded };
    if (this.config.connectorId && !run.admissionId) throw new RunnerError(403, "Approval lacks Worker write admission");
    const deadline = (run.submittedAt ?? Date.now()) + DECISION_WAIT_MS;
    if (deadline <= Date.now()) throw new Error("This message is over an hour old, so the session owner can no longer allow this call. Ask them to send a new message.");
    const id = `permission-${api.taskId}${effect.audience ? "_audience" : ""}`;
    const shown = target.replaceAll("\0", "");
    const operation = validateOperation({ kind: "permission", tool, target: shown.length > 8192 ? `${shown.slice(0, 8191)}…` : shown, needs });
    const request: ApprovalRecord = { id, sessionId: this.binding.session.id, requestedBy: run.initiatedBy, createdAt: new Date().toISOString(), status: "pending", operation,
      ...(run.admissionId !== undefined ? { admissionId: run.admissionId } : {}) };
    await this.mutate(meta => { meta.approvals[id] ??= request; });
    const decided = await this.awaitCard(id, waiting, deadline);
    if (decided.status === "denied") throw new Error(`The session owner did not allow ${tool}${target ? ` on ${target}` : ""}.`);
    if (decided.status !== "approved") throw new Error(decided.result ?? "The permission request ended before the session owner answered.");
    return { unbounded };
  }

  private coveredBy(request: PermissionRequest, grants: Grants): boolean {
    return request.needs.every(need => need === "tool" ? this.binding.agent.tools.includes(request.tool) || (request.tool !== "host_bash" && grants.tools.includes(request.tool))
      : need === "write" ? grants.write : need === "audience" ? grants.audience === true : grants.unboundedShell);
  }

  private buildTools(): ToolRegistration[] {
    const tools = this.sessionTools();
    return this.#clone && this.#egress ? [...tools, this.clonePushTool()] : tools;
  }

  private clonePushTool(): ToolRegistration {
    const text = (value: unknown) => ({ output: [{ type: "text" as const, text: typeof value === "string" ? value : JSON.stringify(value) }] });
    return defineTool({ name: "git_push", description: "Push the checked-out commit of a clone in the worktree (its directory, such as app) as it is to a branch of the workspace repository it was cloned from, fast-forward only, optionally opening a pull request as the owner. pull_request.draft true opens it as a draft; false opens it ready for review, or marks the branch's open draft ready for review with this title and body. With tag, push no branch: create that tag at the checked-out commit, which must already be on the remote's branch (such as a release tag on main); tags are never moved. Commit with git first. Waits for an exact human approval unless the owner enabled auto-approve for this request.", parameters: obj({
      directory: str(), branch: str(), tag: opt(str()),
      pull_request: opt(obj({ title: str(), body: str(), base: opt(str()), draft: opt(bool()) }, { open: true })),
    }, { open: true }), execute: async (args, api, call) => {
      await this.requireSessionTool("git_push");
      const attribution = await this.toolActor(api, true);
      await this.permit(api, call, "git_push", args.tag === undefined ? `${args.directory} → ${args.branch}` : `${args.directory} → tag ${args.tag} on ${args.branch}`, { write: true });
      if (!validCloneDirectory(args.directory)) throw new RunnerError(400, "directory must be a clone's path in the worktree, such as app or src/app");
      if (args.tag !== undefined && !validPushTag(args.tag)) throw new RunnerError(400, "tag must be a plain tag name, such as v1.2.3, not refs/tags/v1.2.3");
      if (args.tag !== undefined && args.pull_request) throw new RunnerError(400, "a tag push opens no pull request");
      const head = await isolatedWorkspace(this.sandbox).cloneHead(args.directory, () => this.recheckTool(attribution));
      if (!head.origin) throw new RunnerError(400, `${args.directory} has no origin remote; push only clones of this workspace's repositories`);
      const repository = repositoryForRemote((await this.#egress!.grant()).repositories, head.origin);
      if (!repository) throw new RunnerError(403, `${args.directory} was cloned from ${head.origin.slice(0, 200)}, which is not one of this workspace's repositories`);
      const request = args.pull_request;
      const operation: GitPushOperation = { kind: "git.push", repository: repositoryPath(repository), directory: args.directory, branch: args.branch,
        ...(args.tag !== undefined ? { tag: args.tag } : {}), commit: head.commit,
        ...(request ? { pullRequest: { title: request.title, body: request.body, ...(request.base !== undefined ? { base: request.base } : {}),
          ...(request.draft !== undefined ? { draft: request.draft } : {}) } } : {}) };
      const approval = await this.operationOutcome(await this.createApproval(attribution.initiatedBy, operation, String(api.taskId), { permitted: true }), call);
      return text({ ...approval, admissionId: undefined });
    } });
  }

  private sessionTools(): ToolRegistration[] {
    const text = (value: unknown) => ({ output: [{ type: "text" as const, text: typeof value === "string" ? value : JSON.stringify(value) }] });
    const approvalText = (approval: StoredApproval) => text({ ...approval, admissionId: undefined, callId: undefined });
    const commandText = async (approval: StoredApproval, api: ToolExecutionApi, tool: string) => text(await this.shownApproval(approval, api, tool));
    return [
      defineTool({ name: "identity", description: "Return immutable session owner identity and sanitized session environment, not collaborator credentials.", parameters: obj({}, { open: true }), execute: async (_args, api, call) => {
        const attribution = await this.toolActor(api, false);
        await this.permit(api, call, "identity", "");
        const config = await this.hostConfig();
        const commands = { timeoutSeconds: commandLimits(config.commandTimeoutSeconds).seconds, gpu: config.gpu && !this.#onHost,
          ...(this.#onHost ? { onHost: true } : {}) };
        return text({ ...await this.sandbox.identity(() => this.recheckTool(attribution)), commands, ...attribution });
      } }),
      defineTool({ name: "read_file", description: "Read a confined worktree file. PNG, JPEG, GIF and WebP images are returned as images, scaled to fit. For a text file, offset (the first line, from 1) and limit (how many lines) read only part of it, and the result says which lines of how many it holds: use search to find where to look, then read around it.",
        parameters: obj({ path: str(), offset: opt(int({ minimum: 1 })), limit: opt(int({ minimum: 1 })) }, { open: true }), execute: async (args, api, call) => {
        const attribution = await this.toolActor(api, false);
        await this.permit(api, call, "read_file", args.path);
        const file = await this.sandbox.readContent(args.path, () => this.recheckTool(attribution));
        if ("text" in file && (args.offset !== undefined || args.limit !== undefined)) return text({ ...attribution, ...lineRange(file.text, args.offset, args.limit) });
        if ("text" in file) return text({ ...attribution, content: file.text });
        const prepared = await prepareImage(file.image, file.mimeType);
        if ("error" in prepared) return { output: [], isError: true, diagnostics: [{ severity: "error" as const, code: "image", message: prepared.error }] };
        const { image } = prepared;
        return { output: [
          { type: "text" as const, text: JSON.stringify({ ...attribution, path: args.path, mimeType: image.mimeType, width: image.width, height: image.height }) },
          { type: "image" as const, data: image.data, mimeType: image.mimeType },
        ] };
      } }),
      defineTool({ name: "list_files", description: "List confined worktree files.", parameters: obj({ path: opt(str()) }, { open: true }), execute: async (args, api, call) => {
        const attribution = await this.toolActor(api, false);
        await this.permit(api, call, "list_files", args.path ?? "");
        return text({ ...attribution, files: await this.sandbox.listFiles(args.path, () => this.recheckTool(attribution)) });
      } }),
      defineTool({ name: "search", description: "Search the worktree's text files for a regular expression (or, with literal, exact text), line by line, as grep -rn does, without a shell or approval. path narrows it to a directory or one file; glob to file names (*.ts) or paths (apps/**/*.ts); context adds up to 5 lines around each match; ignore_case; max_results (100 by default, at most 500). It skips .git directories as it walks, and node_modules unless all is true; links, binary and non-UTF-8 files and files over 1 MB are skipped. Results give each match's path, line number and text; truncated says it stopped early. Then read_file with offset and limit reads around a match.",
        parameters: obj({ pattern: str(), path: opt(str()), glob: opt(str()), literal: opt(bool()),
          ignore_case: opt(bool()), context: opt(int({ minimum: 0, maximum: searchLimits.context })),
          max_results: opt(int({ minimum: 1, maximum: searchLimits.maxResults })), all: opt(bool()) }, { open: true }),
        execute: async (args, api, call) => {
          let request: SearchRequest;
          try { request = searchRequest(args); } catch (error) { throw new RunnerError(400, error instanceof Error ? error.message : "Invalid search"); }
          const attribution = await this.toolActor(api, false);
          await this.permit(api, call, "search", `${request.path}: ${request.pattern}`.slice(0, 1200));
          return text({ ...attribution, ...await this.sandbox.search(request, () => this.recheckTool(attribution)) });
        } }),
      defineTool({ name: "write_file", description: "Write a confined worktree file. In a read-only request it waits for the session owner to allow it.", executionMode: "sequential", parameters: obj({ path: str(), content: str() }, { open: true }), execute: async (args, api, call) => {
        const attribution = await this.toolActor(api, true);
        await this.permit(api, call, "write_file", args.path, { write: true });
        await this.sandbox.writeFile(args.path, args.content, () => this.recheckTool(attribution));
        return text({ ...attribution, written: args.path });
      } }),
      defineTool({ name: "edit_file", executionMode: "sequential",
        description: "Edit a confined worktree text file by exact replacement, without rewriting it. Each edits[].oldText must occur exactly once in the file, including whitespace and line breaks; edits are matched against the file as it was, must not overlap, and apply together. In a read-only request it waits for the session owner to allow it.",
        parameters: obj({ path: str(), edits: arr(obj({ oldText: str(), newText: str() }, { open: true }), { minItems: 1 }) }, { open: true }),
        execute: async (args, api, call) => {
          const attribution = await this.toolActor(api, true);
          await this.permit(api, call, "edit_file", args.path, { write: true });
          const recheck = () => this.recheckTool(attribution);
          await this.sandbox.writeFile(args.path, applyEdits(await this.sandbox.readFile(args.path, recheck), args.edits, args.path), recheck);
          return text({ ...attribution, edited: args.path, edits: args.edits.length });
        } }),
      ...(["move_file", "copy_file"] as const).map(name => defineTool({ name, executionMode: "sequential",
        description: name === "move_file"
          ? "Move or rename a file, directory or link in the worktree, without a shell or approval (like write_file): from and to are worktree paths. A link is moved itself, never what it points to. The destination must not exist, its directories are made, and a directory can't go inside itself; nothing in .git is moved. In a read-only request it waits for the session owner to allow it."
          : `Copy a file, or a directory with everything in it, in the worktree, without a shell or approval (like write_file): from and to are worktree paths. Links are copied as links. The destination must not exist and its directories are made; at most ${fileOperationLimits.entries} entries and ${fileOperationLimits.bytes / 1024 / 1024} MB of files, never a repository's .git (clone it again instead). In a read-only request it waits for the session owner to allow it.`,
        parameters: obj({ from: str(), to: str() }, { open: true }),
        execute: async (args, api, call) => {
          let request: FileOperationRequest;
          try { request = fileOperationRequest(name === "move_file" ? "move" : "copy", args); } catch (error) { throw new RunnerError(400, error instanceof Error ? error.message : "Invalid file operation"); }
          const attribution = await this.toolActor(api, true);
          await this.permit(api, call, name, `${args.from} → ${args.to}`.slice(0, 4096), { write: true });
          const result = await this.sandbox.fileOperation(request, () => this.recheckTool(attribution));
          return text({ ...attribution, ...(name === "move_file" ? { moved: args.from, to: args.to } : { copied: args.from, to: args.to, ...result }) });
        } })),
      defineTool({ name: "delete_file", executionMode: "sequential",
        description: "Delete a file, link or directory in the worktree, without a shell or approval (like write_file). A link is deleted itself, never what it points to. A directory with anything in it is deleted only with recursive: true, everything in it included. Never .git or the worktree itself. In a read-only request it waits for the session owner to allow it.",
        parameters: obj({ path: str(), recursive: opt(bool()) }, { open: true }),
        execute: async (args, api, call) => {
          let request: FileOperationRequest;
          try { request = fileOperationRequest("delete", args); } catch (error) { throw new RunnerError(400, error instanceof Error ? error.message : "Invalid file operation"); }
          const attribution = await this.toolActor(api, true);
          await this.permit(api, call, "delete_file", `${args.path}${args.recursive ? " (recursive)" : ""}`.slice(0, 4096), { write: true });
          const result = await this.sandbox.fileOperation(request, () => this.recheckTool(attribution));
          return text({ ...attribution, deleted: args.path, entries: result.entries });
        } }),
      defineTool({ name: "git", description: `Run Git in the session worktree without a shell: args is its arguments as a list, starting with the subcommand (${gitSubcommands.join(", ")}), such as ["commit", "-m", "Fix the parser"]; directory is where it runs, a clone such as app (the worktree by default). Git's own options before the subcommand (-C, -c) and options that run other programs (rebase --exec, clone --upload-pack or --config, --template) aren't taken. It runs with no pager, editor or password prompt. It waits for an exact human approval unless the owner enabled auto-approve for this request, and stops at the host's command time limit.`,
        executionMode: "sequential",
        parameters: obj({ args: arr(str(), { minItems: 1, maxItems: gitLimits.arguments }), directory: opt(str()) }, { open: true }),
        execute: async (args, api, call) => {
          await this.requireSessionTool("git");
          let request: GitRequest;
          let command: string;
          try { request = gitRequest(args); command = gitShellCommand(request); }
          catch (error) { throw new RunnerError(400, `${error instanceof Error ? error.message : "Invalid git call"}. Nothing ran.`); }
          const attribution = await this.toolActor(api, true);
          await this.requireHostEnvironment();
          const { unbounded } = await this.permit(api, call, "git", `${request.directory}: git ${request.args.join(" ")}`.slice(0, 8192), { write: true, shell: true });
          return commandText(await this.operationOutcome(await this.createApproval(attribution.initiatedBy, { kind: "program", tool: "git", command }, String(api.taskId), { permitted: true, unbounded }, call.abortSignal), call), api, "git");
        } }),
      ...(process.platform === "win32" && this.sandbox.isolated ? [] : [defineTool({ name: "python", description: `Run Python or its package and test tools in the session worktree without a shell: program is one of ${pythonPrograms.join(", ")}; args is its arguments as a list, such as ["-m", "venv", ".venv"], ["install", "-r", "requirements.txt"] or ["-m", "pytest", "-q"]; directory is where it runs, such as the clone app (the worktree by default); venv names a virtual environment there, such as .venv, whose python3, pip and pytest it runs instead of the host's (make one with python3 -m venv .venv first; the host's own Python can't be installed into; if that fails for want of ensurepip, the host lacks python3-venv, which its owner installs). In the Linux sandbox, uv, uvx, poetry and pytest outside a virtual environment are there only where the host installed them for the whole system: a call to one it lacks is refused, saying how the host's owner installs it. It runs with no colours or prompts; commands that act on a package index as an account (uv publish, uv auth, poetry publish, twine upload, poetry config of credentials) aren't taken. It waits for an exact human approval unless the owner enabled auto-approve for this request, and stops at the host's command time limit.`,
        executionMode: "sequential",
        parameters: obj({ program: StringEnum(pythonPrograms), args: opt(arr(str(), { maxItems: programLimits.arguments })), directory: opt(str()),
          venv: opt(str()) }, { open: true }),
        execute: async (args, api, call) => {
          await this.requireSessionTool("python");
          let request: PythonRequest;
          let command: string;
          try { request = pythonRequest(args); command = pythonShellCommand(request); }
          catch (error) { throw new RunnerError(400, `${error instanceof Error ? error.message : "Invalid python call"}. Nothing ran.`); }
          const missing = request.venv ? undefined : this.programMissing({ programs: pythonPrograms, path: "/usr/local/bin" }, request.program);
          if (missing) throw new RunnerError(400, `${missing} Nothing ran.`);
          const attribution = await this.toolActor(api, true);
          await this.requireHostEnvironment();
          const { unbounded } = await this.permit(api, call, "python", `${request.directory}${request.venv ? ` (${request.venv})` : ""}: ${request.program} ${request.args.join(" ")}`.slice(0, 8192), { write: true, shell: true });
          return commandText(await this.operationOutcome(await this.createApproval(attribution.initiatedBy, { kind: "program", tool: "python", command }, String(api.taskId), { permitted: true, unbounded }, call.abortSignal), call), api, "python");
        } })]),
      defineTool({ name: "browser", description: "Drive a headless Chromium in the session's sandbox. It opens url (http, https, file, or about:blank; "
        + "without one, the page the last call left), runs actions in order, and answers with the page as it ends: a screenshot, its URL, title, "
        + "HTTP status, visible text, interactive elements each with a CSS selector, console messages, page errors and failed requests. Actions: "
        + "goto {url}; click or hover {selector, or x and y}; type {text, selector?, submit?, clear?}; press {key}; select {selector, value}; "
        + "scroll {selector, or x and y}; wait {selector, text or ms}; evaluate {expression} (JavaScript in the page; its value comes back); "
        + "screenshot {full_page?}; back; forward; reload. A selector is CSS, or text=<visible text>. A failed action stops the rest. "
        + "Each call starts the browser afresh with the session's own profile: cookies and storage persist, open pages and their state don't, "
        + "so do a whole flow in one call. Its network is the sandbox's: other hosts through the session's proxy, as the workspace allows, and "
        + "localhost only within the call, so start the web app under test with serve {program, args, directory?, venv?, port}: one of the node and "
        + `python tools' programs (${servePrograms.join(", ")}), checked as those tools check them and started without a shell, which runs from before `
        + "the page opens until the call ends. Each call's screenshots and report are kept in browser-output/, which the session panel's Browser tab shows. "
        + "It waits for an exact human approval unless the owner enabled auto-approve for this request, and stops at the host's command time limit.",
        executionMode: "sequential",
        parameters: obj({
          url: opt(str()),
          actions: opt(arr(obj({
            action: StringEnum(browserActions),
            selector: opt(str()), url: opt(str()), text: opt(str()),
            key: opt(str({ description: `${browserKeys.join(", ")}, or a single character` })), value: opt(str()), expression: opt(str()),
            x: opt(int()), y: opt(int()), ms: opt(int({ minimum: 0, maximum: browserLimits.waitMs })),
            full_page: opt(bool()), submit: opt(bool()), clear: opt(bool()),
          }, { open: true }), { maxItems: browserLimits.actions })),
          viewport: opt(obj({ width: int(), height: int() }, { open: true })),
          full_page: opt(bool()),
          timeout_seconds: opt(int({ minimum: browserLimits.timeoutSeconds.min, maximum: browserLimits.timeoutSeconds.max })),
          serve: opt(obj({ program: StringEnum([...servePrograms]), args: opt(arr(str(), { maxItems: programLimits.arguments })),
            directory: opt(str()), venv: opt(str()), port: int({ minimum: 1, maximum: 65535 }),
            timeout_seconds: opt(int({ minimum: browserLimits.serveSeconds.min, maximum: browserLimits.serveSeconds.max })) }, { open: true })),
        }, { open: true }),
        execute: async (args, api, call) => {
          await this.requireSessionTool("browser");
          const browser = this.sandbox.browser;
          if (!browser) throw new RunnerError(400, `This session has no browser: ${browserUnavailableText(this.browserUnavailable() ?? "missing")} Nothing ran.`);
          let request: BrowserRequest;
          let command: string;
          try {
            request = browserRequest(args as Record<string, unknown>);
            command = browserShellCommand(request, browser, { seconds: (await this.commandOptions()).limits.seconds, nodeBin: this.sandbox.nodeBin });
          } catch (error) { throw new RunnerError(400, `${error instanceof Error ? error.message : "Invalid browser call"}. Nothing ran.`); }
          const attribution = await this.toolActor(api, true);
          await this.requireHostEnvironment();
          const { unbounded } = await this.permit(api, call, "browser", browserTarget(request), { write: true, shell: true });
          const approval = await this.operationOutcome(await this.createApproval(attribution.initiatedBy, { kind: "program", tool: "browser", command }, String(api.taskId), { permitted: true, unbounded }, call.abortSignal), call);
          return this.browserOutcome(approval, () => this.recheckTool(attribution), approvalText);
        } }),
      defineTool({ name: "tunnel", description: "Put the web server you work on online at a public https:// address, through a Cloudflare quick tunnel (https://<name>.trycloudflare.com). "
        + "start {serve: {program, args, directory?, venv?, port, timeout_seconds?}} runs the server in the session's sandbox as a service that keeps running after the call: "
        + `one of the node and python tools' programs (${servePrograms.join(", ")}), checked as those tools check them and started without a shell, `
        + "listening on port on localhost; once the port answers (within timeout_seconds, 60 by default) cloudflared, on the host, puts it online, and the call answers with the address. "
        + "A start replaces the one online. status gives the address, whether cloudflared is connected, the uptime and the server's last lines of output; stop takes it offline. "
        + "It stays online until stopped, until someone stops the session's work, until the session closes or is archived, or for the host's service lifetime at most. "
        + "Each start waits for the approval of the host's owner or a member granted host commands, never automatically, and isn't taken in a read-only request. "
        + "Only the declared port is reachable through it, and it is public: anyone with the address can open it.",
        executionMode: "sequential",
        parameters: obj({
          action: StringEnum(tunnelActions),
          serve: opt(obj({ program: StringEnum([...servePrograms]), args: opt(arr(str(), { maxItems: programLimits.arguments })),
            directory: opt(str()), venv: opt(str()), port: int({ minimum: 1, maximum: 65535 }),
            timeout_seconds: opt(int({ minimum: browserLimits.serveSeconds.min, maximum: browserLimits.serveSeconds.max })) }, { open: true })),
        }, { open: true }),
        execute: async (args, api, call) => {
          await this.requireSessionTool("tunnel");
          let request: TunnelRequest;
          try { request = tunnelRequest(args); }
          catch (error) { throw new RunnerError(400, `${error instanceof Error ? error.message : "Invalid tunnel call"}. Nothing ran.`); }
          if (request.action === "status") {
            const attribution = await this.toolActor(api, false);
            return text({ ...attribution, ...(this.#tunnel?.status() ?? { online: false }) });
          }
          const attribution = await this.toolActor(api, true);
          if (request.action === "stop") {
            const stopped = this.#tunnel ? await this.#tunnel.stop("stop", attribution.initiatedBy) : { stopped: false };
            return text({ ...attribution, ...stopped, ...(stopped.stopped ? {} : { note: "Nothing was online." }) });
          }
          const unavailable = this.tunnelUnavailable() ?? (this.config.tunnels ? undefined : "missing");
          if (unavailable) throw new RunnerError(400, `This session can't put a server online: ${tunnelUnavailableText(unavailable)} Nothing ran.`);
          const state = await this.metadata();
          const run = state.runs[state.toolActors[String(api.taskId)]!.runKey]!;
          if (run.options?.access === "read") {
            throw new RunnerError(403, "Putting a server online is an effect a Read-only message doesn't take: ask in a message that may act. Nothing ran.");
          }
          const json = JSON.stringify({ action: "start", serve: request.serve });
          const operation: ExtensionToolOperation = { kind: "extension.tool", source: "piki:tunnel", tool: "tunnel",
            arguments: json.length > EXTENSION_ARGUMENTS_SHOWN ? `${json.slice(0, EXTENSION_ARGUMENTS_SHOWN)}…` : json,
            digest: createHash("sha256").update(json).digest("hex") };
          let approval = await this.createApproval(attribution.initiatedBy, operation, String(api.taskId), { permitted: true }, call.abortSignal);
          if (approval.status === "pending") approval = await this.operationOutcome(approval, call);
          if (approval.status === "denied") throw new RunnerError(403, "Putting the server online wasn't approved. Nothing ran.");
          if (approval.status !== "approved") throw new RunnerError(409, approval.result ?? "The tunnel didn't start.");
          const id = approval.id;
          await this.mutate(meta => { const card = meta.approvals[id]; if (card?.status === "approved") card.status = "executing"; });
          try {
            await this.recheckTool(attribution);
            const started = await this.sessionTunnel().start(request.serve!, attribution.initiatedBy, call.abortSignal);
            await this.mutate(meta => { Object.assign(meta.approvals[id]!, { status: "executed", result: this.#waits.kept(id, `Online at ${started.url}`) }); });
            return text({ ...attribution, ...started });
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            await this.mutate(meta => { Object.assign(meta.approvals[id]!, { status: "failed", result: this.#waits.kept(id, message) }); }).catch(() => {});
            throw new RunnerError(error instanceof RunnerError ? error.status : 409, message);
          }
        } }),
      defineTool({ name: "github_read", description: "Read a GitHub issue or pull request of one of the workspace's github.com repositories (owner/name) as the session owner, through Pikibun: its description and comments and, for a pull request, its merge state, head commit, reviews, review comments and checks. Long threads keep their newest items. The sandbox has no network, so use this instead of curl. Each read spends the session owner's own GitHub rate limit: "
        + "where the session has the gh tool, read and wait for checks with gh instead, and use this to wait for any other change. Read-only; no credentials enter tools. "
        + `To wait for CI or a review instead of sleeping, pass wait: "checks" answers once every check of the head commit has completed (or the pull request is closed, or its head has no checks after ${githubWaitLimits.noChecksSeconds} seconds); "change" answers once anything changes: a comment, review, review comment, push, check or its state. It reads again every ${githubWaitLimits.pollSeconds} seconds for up to timeout_seconds (${githubWaitLimits.defaultSeconds} by default, at most ${githubWaitLimits.maxSeconds}), and its result's waited says how it ended (checks-completed, no-checks, changed, closed or timeout).`,
        parameters: obj({ repository: str(), issue: int({ minimum: 1 }), wait: opt(StringEnum(githubWaits)),
          timeout_seconds: opt(int({ minimum: githubWaitLimits.minSeconds, maximum: githubWaitLimits.maxSeconds })) }, { open: true }), execute: async (args, api, call) => {
        await this.requireSessionTool("github_read");
        const attribution = await this.toolActor(api, false);
        const repository = this.githubRepository(args.repository);
        await this.permit(api, call, "github_read", `${repository}#${args.issue}`);
        const state = await this.metadata();
        const run = state.runs[state.toolActors[String(api.taskId)]!.runKey]!;
        if (!run.admissionId) throw new RunnerError(403, "GitHub reads need a write message");
        const request: GitHubReadRequest = { sessionId: this.binding.session.id, actorId: run.initiatedBy, admissionId: run.admissionId, callId: String(api.taskId), repository, issue: args.issue };
        const read = async () => {
          await this.authorize(run.initiatedBy, "write");
          return this.config.githubRead ? await this.config.githubRead(request) : await this.internalGitHub("read", request) as GitHubIssueView;
        };
        const first = await read();
        if (!args.wait) return text({ ...attribution, ...first });
        const { view, waited } = await waitForGitHub({ wait: args.wait, first, read, timeoutMs: (args.timeout_seconds ?? githubWaitLimits.defaultSeconds) * 1000,
          pollMs: this.config.githubWaitPollMs ?? githubWaitLimits.pollSeconds * 1000, now: Date.now, sleep: ms => sleep(ms, undefined, { signal: call.abortSignal }) });
        return text({ ...attribution, ...view, waited });
      } }),
      defineTool({ name: "github_comment", description: "Post an exact GitHub comment as the session owner through the owner's broker, once a human approves it, or at once under the owner's auto-approve. Use this where the gh tool can't write (gh pr comment, gh issue comment). The result carries the outcome; no credentials enter tools.", parameters: obj({ repository: str(), issue: int({ minimum: 1 }), body: str() }, { open: true }), execute: async (args, api, call) => {
        await this.requireSessionTool("github_comment");
        const attribution = await this.toolActor(api, true);
        await this.permit(api, call, "github_comment", `${args.repository}#${args.issue}`, { write: true });
        return approvalText(await this.operationOutcome(await this.createApproval(attribution.initiatedBy, { kind: "github.comment", ...args }, String(api.taskId), { permitted: true }), call));
      } }),
      defineTool({ name: "github_merge", description: "Merge a pull request of one of the workspace's github.com repositories (owner/name) as the session owner, through the owner's broker: only while its head is still commit sha, as github_read reports it, with method merge, squash or rebase, once a human approves it, or at once under the owner's auto-approve. Use this where the gh tool can't write (gh pr merge --match-head-commit). The result carries the outcome; no credentials enter tools.", parameters: obj({ repository: str(), pull: int({ minimum: 1 }), sha: str(), method: StringEnum(githubMergeMethods) }, { open: true }), execute: async (args, api, call) => {
        await this.requireSessionTool("github_merge");
        const attribution = await this.toolActor(api, true);
        const repository = this.githubRepository(args.repository);
        if (!/^[0-9a-f]{40}$/.test(args.sha)) throw new RunnerError(400, "sha must be the pull request's full 40-character head commit, as github_read reports it");
        await this.permit(api, call, "github_merge", `${repository}#${args.pull}`, { write: true });
        return approvalText(await this.operationOutcome(await this.createApproval(attribution.initiatedBy, { kind: "github.merge", repository, pull: args.pull, sha: args.sha, method: args.method }, String(api.taskId), { permitted: true }), call));
      } }),
      defineTool({ name: "github_issue", description: "Open a GitHub issue with exactly this title (one line) and body (Markdown) in one of the workspace's github.com repositories (owner/name), as the session owner, through the owner's broker once a human approves it, or at once under the owner's auto-approve. Use this where the gh tool can't write (gh issue create): the sandbox holds no GitHub credentials. The result carries the new issue's number and URL; no credentials enter tools.", parameters: obj({ repository: str(), title: str(), body: str() }, { open: true }), execute: async (args, api, call) => {
        await this.requireSessionTool("github_issue");
        const attribution = await this.toolActor(api, true);
        const repository = this.githubRepository(args.repository);
        if (!args.title.trim() || /[\r\n]/.test(args.title) || args.title.length > GITHUB_ISSUE_TITLE_LIMIT) throw new RunnerError(400, `title must be one non-empty line of at most ${GITHUB_ISSUE_TITLE_LIMIT} characters`);
        if (args.body.length > GITHUB_ISSUE_BODY_LIMIT) throw new RunnerError(400, `body must be at most ${GITHUB_ISSUE_BODY_LIMIT} characters`);
        if (args.title.includes("\0") || args.body.includes("\0")) throw new RunnerError(400, "title and body must not contain NUL characters");
        await this.permit(api, call, "github_issue", `${repository}: ${args.title}`, { write: true });
        return approvalText(await this.operationOutcome(await this.createApproval(attribution.initiatedBy, { kind: "github.issue", repository, title: args.title, body: args.body }, String(api.taskId), { permitted: true }), call));
      } }),
      defineTool({ name: "schedule", description: "Manage this session's scheduled prompts: messages Pikibun sends this session's agent on a cron schedule, as the session owner, so the session wakes up and works on its own (a nightly check, a weekly report). Use it when the user asks to do something every hour, day or week, or at a later time. action list takes nothing; create takes message (what the agent is told each time) and cron (five fields: minute hour day-of-month month day-of-week, such as '0 9 * * 1-5'; runs at least 5 minutes apart), and optionally name, time_zone (IANA, such as Europe/Berlin; UTC otherwise, so ask the user for theirs when the time of day matters), access (approval, the default: commands wait for a human; read; auto, only in a message the owner sent with auto-approve), run_in (session, the default: each run prompts this session's agent, and is skipped while it is busy; child: each run starts a new session under this one, on its model and host, with the message as its opening message, so this session is never prompted and its own work goes on) and enabled; update takes id and only the fields to change (an auto-approved schedule is changed, other than paused or lowered in access, only in a message the owner sent with auto-approve); delete takes id. Only the session owner's messages can use it. A run due while the agent is busy is skipped, unless it runs in a child session. The owner sees and edits them in the session panel's Schedules tab.", parameters: obj({
        action: StringEnum(scheduleToolActions), id: opt(str()), message: opt(str()), cron: opt(str()),
        time_zone: opt(str()), name: opt(str()), access: opt(StringEnum(accessModes)), run_in: opt(StringEnum(scheduleRunIns)), enabled: opt(bool()),
      }, { open: true }), execute: async (args, api, call) => {
        await this.requireSessionTool("schedule");
        const attribution = await this.toolActor(api, true);
        const fields = Object.fromEntries(Object.entries({ scheduleId: args.id, name: args.name, cron: args.cron, timeZone: args.time_zone, content: args.message,
          access: args.access, runIn: args.run_in, enabled: args.enabled }).filter(([, value]) => value !== undefined)) as Omit<ScheduleToolRequest, "sessionId" | "actorId" | "admissionId" | "callId" | "action">;
        if (Object.values(fields).some(value => typeof value === "string" && value.includes("\0"))) throw new RunnerError(400, "Schedule fields must not contain NUL characters");
        const state = await this.metadata();
        const run = state.runs[state.toolActors[String(api.taskId)]!.runKey]!;
        if (run.initiatedBy !== this.binding.owner.id) throw new RunnerError(403, "Only the session owner's messages schedule prompts. Ask the owner to send this request, or to add it in the Schedules tab.");
        if (args.access === "auto" && run.options?.access !== "auto") {
          throw new RunnerError(403, "Only a message the session owner sent with auto-approve schedules an auto-approved prompt. Use access approval, or ask the owner to set it in the Schedules tab.");
        }
        if (!run.admissionId) throw new RunnerError(403, "Scheduling needs a write message");
        await this.permit(api, call, "schedule", scheduleToolTarget({ action: args.action, ...fields }), { write: args.action !== "list" });
        await this.authorize(run.initiatedBy, "write");
        const request: ScheduleToolRequest = { sessionId: this.binding.session.id, actorId: run.initiatedBy, admissionId: run.admissionId, callId: String(api.taskId),
          action: args.action, ...fields };
        const result = this.config.schedules ? await this.config.schedules(request) : await this.internalBroker("schedules", request) as ScheduleToolResult;
        return text({ ...attribution, ...result });
      } }),
      defineTool({ name: "sessions", description: SESSIONS_TOOL_DESCRIPTION,
        executionMode: "sequential", parameters: obj({
        action: StringEnum(sessionsToolActions), session: opt(str()), message: opt(str()),
        access: opt(StringEnum(accessModes)), notify: opt(bool()), title: opt(str()), model: opt(str()),
        thinking: opt(StringEnum(thinkingLevels)), visibility: opt(StringEnum(["private", "workspace"] as const)), message_id: opt(str()),
        limit: opt(int({ minimum: 1, maximum: crossSessionLimits.readEntries })),
        timeout_seconds: opt(int({ minimum: 1, maximum: crossSessionLimits.waitSeconds })),
      }, { open: true }), execute: async (args, api, call) => {
        await this.requireSessionTool("sessions");
        const attribution = await this.toolActor(api, true);
        const fields = Object.fromEntries(Object.entries({ targetSessionId: args.session, message: args.message, access: args.access, notify: args.notify, title: args.title,
          modelId: args.model, thinkingLevel: args.thinking, visibility: args.visibility, messageId: args.message_id, limit: args.limit }).filter(([, value]) => value !== undefined)) as
          Omit<SessionsToolRequest, "sessionId" | "actorId" | "admissionId" | "callId" | "action">;
        if (Object.values(fields).some(value => typeof value === "string" && value.includes("\0"))) throw new RunnerError(400, "Sessions tool fields must not contain NUL characters");
        const wait = args.action === "wait";
        if (wait && (fields.targetSessionId === undefined || fields.messageId === undefined)) throw new RunnerError(400, "wait takes session and message_id, as ask, send or create returned them");
        if (!wait && args.timeout_seconds !== undefined) throw new RunnerError(400, "Only wait takes timeout_seconds");
        const state = await this.metadata();
        const run = state.runs[state.toolActors[String(api.taskId)]!.runKey]!;
        if (!run.admissionId) throw new RunnerError(403, "The sessions tool needs a write message");
        if (args.access === "auto" && (run.options?.access !== "auto" || run.initiatedBy !== this.binding.owner.id)) {
          throw new RunnerError(403, "Only a message the session owner sent with auto-approve sends an auto-approved message. Use access approval, which leaves the other session's commands to its people.");
        }
        const request = { action: wait ? "read" as const : args.action as Exclude<typeof args.action, "wait">, ...(wait ? { targetSessionId: fields.targetSessionId, messageId: fields.messageId, limit: 1 } : fields) };
        await this.permit(api, call, "sessions", sessionsToolTarget(request), { write: sessionsWriteActions.includes(args.action) });
        await this.authorize(run.initiatedBy, "write");
        const base = { sessionId: this.binding.session.id, actorId: run.initiatedBy, admissionId: run.admissionId, callId: String(api.taskId) };
        const broker = async (): Promise<SessionsToolResult> => {
          const result = this.config.crossSessions ? await this.config.crossSessions({ ...base, ...request }) : await this.internalBroker("sessions", { ...base, ...request }) as SessionsToolResult;
          if (!("consent" in result)) return result;
          await this.permit(api, call, "sessions", result.target, { audience: true });
          await this.authorize(run.initiatedBy, "write");
          const retried = this.config.crossSessions ? await this.config.crossSessions({ ...base, ...request }) : await this.internalBroker("sessions", { ...base, ...request }) as SessionsToolResult;
          if ("consent" in retried) throw new RunnerError(409, "The control plane did not see the session owner's decision yet; call again.");
          return retried;
        };
        if (!wait) return text({ ...attribution, ...await broker() });
        const deadline = Date.now() + (args.timeout_seconds ?? crossSessionLimits.defaultWaitSeconds) * 1000;
        for (;;) {
          const result = await broker();
          const done = "outcome" in result && result.outcome?.done === true;
          if (done || Date.now() + WAIT_POLL_MS > deadline) {
            const { entries: _entries, ...shown } = result as Extract<SessionsToolResult, { entries: unknown }>;
            return text({ ...attribution, ...shown, ...(done ? {} : { timedOut: true }) });
          }
          await sleep(WAIT_POLL_MS, undefined, { signal: call.abortSignal });
        }
      } }),
    ];
  }

  private startHostOperation(id: string, operation: HostCommandOperation,
    auth: { actorId: string; capability?: string; admissionId?: string }, recheck: SandboxAuthorize): Promise<void> {
    const entry = { controller: new AbortController(), done: Promise.resolve() };
    const generation = this.generation;
    entry.done = (async () => {
      let status: "executed" | "failed" | "interrupted" = "executed";
      let result: string;
      try {
        await recheck();
        entry.controller.signal.throwIfAborted();
        const automatic = auth.capability === undefined && auth.admissionId !== undefined;
        const level = await this.hostCommandLevel(auth.actorId, automatic ? "write" : "approve");
        if (!level || (automatic && level !== "auto")) throw new RunnerError(403, "Only the host owner, or a member granted host commands on this host, can execute host commands");
        result = await this.sandbox.executeHost(operation, recheck, entry.controller.signal);
      } catch (error) {
        const refused = error instanceof RunnerError && error.status < 500;
        status = error instanceof SandboxProcessError || refused ? "failed" : "interrupted";
        result = error instanceof SandboxProcessError ? `${error.message}${error.stdout ? `\n${error.stdout}` : ""}`
          : refused ? (error as RunnerError).message : "Effect interrupted or outcome unknown. Inspect the session list or host before requesting another operation.";
      }
      if (generation === this.generation) await this.mutate(meta => { Object.assign(meta.approvals[id]!, { status, result: this.#waits.kept(id, result) }); });
    })().catch(() => { }).finally(() => {
      this.pushes.delete(entry);
      if (generation === this.generation && !this.closing) this.drainQueue();
    });
    this.pushes.add(entry);
    return entry.done;
  }

  readonly #definitionNotes = new Set<string>();

  private noteDefinition(name: string, what: string): void {
    const note = `${name} ${what}`;
    if (this.#definitionNotes.has(note)) return;
    this.#definitionNotes.add(note);
    process.stderr.write(`Session ${this.binding.session.id}: the tool definition ${note}.\n`);
  }

  private async fetchDefinitions(): Promise<readonly ToolDefinition[]> {
    const fetched = this.config.toolDefinitions ? await this.config.toolDefinitions().catch(() => undefined) : undefined;
    if (fetched) rememberToolDefinitions(fetched);
    return fetched ?? bundledToolDefinitions;
  }

  private usableDefinitions(definitions: readonly ToolDefinition[], own: readonly string[]): ToolDefinition[] {
    const windows = process.platform === "win32" && this.sandbox.isolated;
    const taken = new Set(own);
    return definitions.filter(definition => {
      if (taken.has(definition.name) || (definition.kind === "program" && windows && !definition.windowsSandbox)) return false;
      taken.add(definition.name);
      return true;
    });
  }

  private async refreshDefinitions(extensionTools: readonly string[] = []): Promise<void> {
    if (!this.config.toolDefinitions || !this.#registry) return;
    const fetched = await this.fetchDefinitions();
    for (const definition of fetched) {
      const had = this.#definitions.find(item => item.name === definition.name);
      if (had && JSON.stringify(had) !== JSON.stringify(definition)) this.noteDefinition(definition.name, "changed; the session uses it as it was until it next opens");
      else if (!had && extensionTools.includes(definition.name)) this.noteDefinition(definition.name, "is offered by one of the workspace's extensions, which keeps it");
    }
    const added = this.usableDefinitions(fetched, [...this.tools.map(tool => tool.name), ...extensionTools]);
    if (!added.length) return;
    const tools = added.map(definition => this.definedTool(definition));
    const extension = defineExtension({ name: `defined-tools-${this.#definedExtensions.length + 1}`, tools });
    this.#registry.install(extension);
    this.#definedExtensions.push(extension);
    this.#definitions.push(...added);
    this.tools.push(...tools);
    this.#hostExtensions?.reserve(added.map(definition => definition.name));
  }

  private definedTool(definition: ToolDefinition): ToolRegistration {
    const text = (value: unknown) => ({ output: [{ type: "text" as const, text: typeof value === "string" ? value : JSON.stringify(value) }] });
    if (definition.kind === "program") {
      return defineTool({ name: definition.name, description: definition.description, executionMode: "sequential",
        parameters: obj({ program: StringEnum([...definition.programs]), args: opt(arr(str(), { maxItems: programLimits.arguments })), directory: opt(str()) }, { open: true }),
        execute: async (args, api, call) => {
          await this.requireSessionTool(definition.name);
          let request: ProgramRequest;
          let command: string;
          try { request = programRequest(definition, args); command = programCommand(definition, request, this.sandbox.nodeBin ? { nodeBin: this.sandbox.nodeBin } : {}); }
          catch (error) { throw new RunnerError(400, `${error instanceof Error ? error.message : `Invalid ${definition.name} call`}. Nothing ran.`); }
          const missing = this.programMissing(definition, request.program);
          if (missing) throw new RunnerError(400, `${missing} Nothing ran.`);
          const attribution = await this.toolActor(api, true);
          await this.requireHostEnvironment();
          const { unbounded } = await this.permit(api, call, definition.name, `${request.directory}: ${request.program} ${request.args.join(" ")}`.slice(0, 8192), { write: true, shell: true });
          const approval = await this.operationOutcome(await this.createApproval(attribution.initiatedBy, { kind: "program", tool: definition.name, command }, String(api.taskId),
            { permitted: true, unbounded }, call.abortSignal), call);
          return text(await this.shownApproval(approval, api, definition.name));
        } });
    }
    const parameters = Object.fromEntries(Object.entries(definition.parameters).map(([name, parameter]) => {
      const options = parameter.description ? { description: parameter.description } : {};
      const schema = parameter.type === "boolean" ? bool(options)
        : parameter.type === "integer" ? int({ ...options, ...(parameter.minimum !== undefined ? { minimum: parameter.minimum } : {}), ...(parameter.maximum !== undefined ? { maximum: parameter.maximum } : {}) })
        : parameter.enum ? StringEnum([...parameter.enum], options) : str(options);
      return [name, parameter.required ? schema : opt(schema)];
    }));
    return defineTool({ name: definition.name, description: definition.description, parameters: obj(parameters, { open: true }),
      execute: async (input, api, call) => {
        await this.requireSessionTool(definition.name);
        const attribution = await this.toolActor(api, definition.write);
        let args: Record<string, unknown>;
        try { args = brokeredArguments(definition, input as Record<string, unknown>); }
        catch (error) { throw new RunnerError(400, error instanceof Error ? error.message : `Invalid ${definition.name} call`); }
        await this.permit(api, call, definition.name, brokeredTarget(definition, args), definition.write ? { write: true } : {});
        const state = await this.metadata();
        const run = state.runs[state.toolActors[String(api.taskId)]!.runKey]!;
        if (!run.admissionId) throw new RunnerError(403, `${definition.name} needs a write message`);
        const request = { sessionId: this.binding.session.id, actorId: run.initiatedBy, admissionId: run.admissionId, callId: String(api.taskId), ...args };
        await this.authorize(run.initiatedBy, "write");
        const result = this.config.brokered ? await this.config.brokered(definition.route, request) : await this.internalBroker(definition.route, request);
        return text({ ...attribution, ...(result && typeof result === "object" && !Array.isArray(result) ? result : { result }) });
      } });
  }

  private startShellOperation(id: string, operation: Extract<Operation, { kind: "bash" | "program" }>, unbounded: boolean, recheck: SandboxAuthorize): Promise<void> {
    const entry = { controller: new AbortController(), done: Promise.resolve() };
    const generation = this.generation;
    entry.done = (async () => {
      let status: "executed" | "failed" | "interrupted";
      let result: string;
      try {
        result = await this.sandbox.execute(operation, false, recheck, {
          allowTestShell: this.binding.model.provider === "faux" && this.config.allowFaux && this.config.allowTestShell === true, unbounded,
          ...await this.commandOptions(), signal: entry.controller.signal,
        });
        status = "executed";
      } catch (error) {
        const refused = error instanceof RunnerError && error.status < 500;
        status = error instanceof SandboxProcessError || refused ? "failed" : "interrupted";
        result = error instanceof SandboxProcessError ? `${error.message}${error.stdout ? `\n${error.stdout}` : ""}`
          : refused ? (error as RunnerError).message : "Effect failed or outcome is ambiguous. Inspect external state; automatic retry is prohibited.";
      }
      if (generation === this.generation) await this.mutate(meta => { Object.assign(meta.approvals[id]!, { status, result: this.#waits.kept(id, result) }); });
    })().catch(() => { }).finally(() => {
      this.pushes.delete(entry);
      if (generation === this.generation && !this.closing) this.drainQueue();
    });
    this.pushes.add(entry);
    return entry.done;
  }

  private githubRepository(name: string): string {
    if (!/^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9_.-]{1,100}$/.test(name)) throw new RunnerError(400, "repository must be a github.com owner/name");
    return name;
  }

  private async githubEffect(operation: Extract<Operation, { kind: "github.comment" | "github.merge" | "github.issue" }>,
    authority: { sessionId: string; actorId: string; approvalId: string } & ({ capability: string } | { admissionId: string })): Promise<string> {
    if (operation.kind === "github.comment") {
      const { repository, issue, body } = operation;
      const request: GitHubCommentRequest = { ...authority, repository, issue, body };
      const comment = this.config.githubComment ? await this.config.githubComment(request) : await this.internalGitHub("comment", request) as { id: number; url: string };
      return JSON.stringify({ id: comment.id, url: comment.url });
    }
    if (operation.kind === "github.merge") {
      const { repository, pull, sha, method } = operation;
      const request: GitHubMergeRequest = { ...authority, repository, pull, sha, method };
      const merged = this.config.githubMerge ? await this.config.githubMerge(request) : await this.internalGitHub("merge", request) as GitHubMergeResult;
      return JSON.stringify({ merged: true, sha: merged.sha, url: merged.url });
    }
    const { repository, title, body } = operation;
    const request: GitHubIssueRequest = { ...authority, repository, title, body };
    const opened = this.config.githubIssue ? await this.config.githubIssue(request) : await this.internalGitHub("issue", request) as GitHubIssueResult;
    return JSON.stringify({ number: opened.number, url: opened.url });
  }

  private async internalGitHub(action: "comment" | "read" | "merge" | "issue", request: object): Promise<unknown> {
    return this.internalBroker(`github/${action}`, request);
  }

  private async internalBroker(path: string, request: object): Promise<unknown> {
    const response = await (this.config.fetch ?? fetch)(`${this.config.controlPlaneUrl}/api/internal/${path}`, {
      method: "POST", headers: { authorization: `Bearer ${this.config.sharedSecret}`, "content-type": "application/json" },
      body: JSON.stringify(request), signal: AbortSignal.timeout(30_000), redirect: "error",
    });
    const value: unknown = await response.json().catch(() => undefined);
    if (!response.ok) {
      const error = value && typeof value === "object" && "error" in value && typeof value.error === "string" ? value.error : "Broker returned an error; external state must be reconciled";
      throw new RunnerError(response.status, error);
    }
    return value;
  }

  async createApproval(actorId: string, input: Operation, toolTaskId?: string, consent: { permitted?: boolean; unbounded?: boolean; automatic?: boolean } = {}, signal?: AbortSignal): Promise<ApprovalRecord> {
    this.requireUnfrozen();
    const operation = validateOperation(input);
    if (operation.kind === "permission") throw new RunnerError(400, "Permission requests come only from tool calls");
    if (operation.kind === "git.commit" || operation.kind === "git.repin" || (operation.kind === "git.push" && operation.directory === undefined)) {
      throw new RunnerError(400, "Commit and switch branches with the git tool; a push names a clone's directory");
    }
    if (operation.kind === "host.bash") throw new RunnerError(400, "Commands on the host were removed with host_bash; run programs with the git, node and python tools");
    this.requireShellCapability(operation, consent.unbounded);
    if (operation.kind === "extension.tool" && (!this.config.connectorId || !this.binding.session.connectorOwnerId)) {
      throw new RunnerError(403, "Host commands require a connected host with a known owner");
    }
    if (operation.kind === "extension.tool" && (!consent.permitted || toolTaskId === undefined)) throw new RunnerError(400, "Extension tool calls come only from their tools");
    if (operation.kind === "git.push" && !this.#clone) throw new RunnerError(400, "Only clone sessions push a clone's directory");
    if (operation.kind === "git.push" && !this.#egress) throw new RunnerError(400, "On a host without the sandbox, push with the git tool");
    const toolName = operation.kind === "extension.tool" ? undefined : operation.kind === "program" ? operation.tool : ({ "git.commit": "git_commit", bash: "bash", "github.comment": "github_comment", "github.merge": "github_merge", "github.issue": "github_issue", "git.push": "git_push", "git.repin": "git_repin", "host.bash": "host_bash" } as const)[operation.kind];
    if (!consent.permitted && (toolName === undefined || (!this.binding.agent.tools.includes(toolName)
      && !(await this.metadata()).grants?.tools.includes(toolName)))) {
      throw new RunnerError(403, "Operation not enabled by pinned agent version");
    }
    await this.authorize(actorId, "write");
    let admissionId: string | undefined;
    let callId: string | undefined;
    let automatic = false;
    let memberAuto = false;
    if (toolTaskId !== undefined) {
      const state = await this.metadata();
      const attribution = state.toolActors[toolTaskId];
      callId = attribution?.callId;
      const run = attribution && state.runs[attribution.runKey];
      if (!run || run.initiatedBy !== actorId || run.ownerId !== this.binding.owner.id || run.mode !== "write"
        || !["admitting", "running"].includes(run.status)) throw new RunnerError(403, "Approval has no active originating write");
      admissionId = run.admissionId;
      if (this.config.connectorId && !admissionId) throw new RunnerError(403, "Approval lacks Worker write admission");
      const github = operation.kind === "github.comment" || operation.kind === "github.merge" || operation.kind === "github.issue";
      const sessionGranted = toolName !== undefined && !github
        && state.grants?.tools.includes(toolName) === true;
      automatic = (run.options?.access === "auto" || sessionGranted) && run.initiatedBy === this.binding.owner.id
        && (!github || (admissionId !== undefined && (operation.kind !== "github.merge" || run.options?.autoMerge === true)))
        && (operation.kind !== "git.push" || admissionId !== undefined)
        && (!decidedAsHostCommand(operation, this.hostCommandSession(), consent.unbounded === true)
          || await this.hostCommandLevel(this.binding.owner.id, "write") === "auto");
      if (operation.kind === "extension.tool" && consent.automatic === true) automatic = true;
      if (operation.kind === "extension.tool" && operation.source === "piki:tunnel") automatic = false;
      if (!automatic && run.initiatedBy !== this.binding.owner.id && run.options?.access === "auto" && admissionId !== undefined && !this.#onHost
        && memberAutoApproves(operation, this.hostCommandSession(), consent.unbounded === true)) {
        memberAuto = automatic = (await this.authorize(actorId, "write", undefined, false, false, false, false, true)).memberAutoApprove === true;
      }
      if (!automatic && run.initiatedBy !== this.binding.owner.id && admissionId !== undefined
        && requesterAutoApproves(operation, this.hostCommandSession(), consent.unbounded === true)) {
        automatic = (await this.authorize(actorId, "write", undefined, false, false, false, true)).autoApprove === true;
      }
    }
    const id = toolTaskId ? `tool-${toolTaskId}` : randomUUID();
    const approval: StoredApproval = { id, sessionId: this.binding.session.id, requestedBy: actorId, operation: JSON.parse(JSON.stringify(operation)), createdAt: new Date().toISOString(),
      ...(automatic ? { status: "executing", decidedBy: this.binding.owner.id, automatic: true } : { status: "pending" }),
      ...(consent.unbounded && (operation.kind === "bash" || operation.kind === "program") ? { unbounded: true } : {}), ...(callId ? { callId } : {}) };
    if (admissionId !== undefined) approval.admissionId = admissionId;
    let created = false;
    if (toolTaskId !== undefined && !automatic) this.#waits.waiter(id);
    try { await this.mutate(meta => { if (!meta.approvals[id]) { meta.approvals[id] = approval; created = true; } }); }
    catch (error) {
      this.#waits.forget(id);
      throw error;
    }
    if (automatic && created) return this.executeAutomatically(id, actorId, signal, memberAuto);
    return (await this.metadata()).approvals[id]!;
  }

  private async executeAutomatically(id: string, actorId: string, signal?: AbortSignal, memberAuto = false): Promise<ApprovalRecord> {
    const approval = (await this.metadata()).approvals[id]!;
    const operation = approval.operation;
    let status: ApprovalRecord["status"];
    let result: string;
    if (operation.kind === "extension.tool") return approval;
    if (operation.kind === "host.bash") {
      await this.startHostOperation(id, operation, { actorId, admissionId: approval.admissionId }, async () => { await this.authorize(actorId, "write"); });
      return (await this.metadata()).approvals[id]!;
    }
    if (operation.kind === "github.comment" || operation.kind === "github.merge" || operation.kind === "github.issue") {
      try {
        await this.authorize(actorId, "write");
        result = await this.githubEffect(operation, { sessionId: this.binding.session.id, actorId, approvalId: id, admissionId: approval.admissionId! });
        status = "executed";
      } catch (error) {
        if (error instanceof RunnerError && error.status === 422 && operation.kind !== "github.comment") { status = "failed"; result = error.message; }
        else { status = "interrupted"; result = "Effect failed or outcome is ambiguous. Inspect external state; automatic retry is prohibited."; }
      }
      await this.mutate(meta => { Object.assign(meta.approvals[id]!, { status, result: this.#waits.kept(id, result) }); });
      return (await this.metadata()).approvals[id]!;
    }
    if (operation.kind === "git.push") {
      const entry = { controller: new AbortController(), done: Promise.resolve() };
      const settled = (async () => {
        const outcome = await this.runPush(id, operation, { actorId, admissionId: approval.admissionId }, async () => { await this.authorize(actorId, "write"); }, entry.controller.signal);
        await this.mutate(meta => { Object.assign(meta.approvals[id]!, { status: outcome.status, result: this.#waits.kept(id, outcome.result) }); });
      })();
      entry.done = settled.then(() => undefined, () => undefined);
      this.pushes.add(entry);
      try { await settled; }
      finally { this.pushes.delete(entry); }
      return (await this.metadata()).approvals[id]!;
    }
    try {
      result = await this.sandbox.execute(operation, false, async () => {
        this.requireShellCapability(operation, approval.unbounded === true);
        await this.requireHostEnvironment(true);
        if (approval.unbounded === true && grantedShell(this.hostCommandSession())) await this.requireShellGrant(true);
        if (actorId !== this.binding.owner.id && memberAuto) {
          if ((await this.authorize(actorId, "write", undefined, false, false, false, false, true)).memberAutoApprove !== true) {
            throw new RunnerError(403, "This member can no longer auto-approve their commands here: commands need approval. Nothing ran.");
          }
        } else if (actorId !== this.binding.owner.id) {
          if ((await this.authorize(actorId, "write", undefined, false, false, false, true)).autoApprove !== true) {
            throw new RunnerError(403, "The session owner no longer auto-approves this member's requests: commands need approval. Nothing ran.");
          }
        } else await this.authorize(actorId, "write");
      }, { allowTestShell: this.binding.model.provider === "faux" && this.config.allowFaux && this.config.allowTestShell === true, unbounded: approval.unbounded === true,
        ...await this.commandOptions(), signal });
      status = "executed";
    } catch (error) {
      if (error instanceof SandboxProcessError) { status = "failed"; result = `${error.message}${error.stdout ? `\n${error.stdout}` : ""}`; }
      else { status = "interrupted"; result = "Effect failed or outcome is ambiguous. Inspect external state; automatic retry is prohibited."; }
    }
    await this.mutate(meta => { Object.assign(meta.approvals[id]!, { status, result: this.#waits.kept(id, result) }); });
    return (await this.metadata()).approvals[id]!;
  }

  private decisionPermission(actorId: string, operation: Pick<Operation, "kind"> | undefined): Permission {
    const hostOwner = this.binding.session.connectorOwnerId;
    return (operation?.kind === "host.bash" || operation?.kind === "extension.tool") && !!hostOwner && actorId === hostOwner ? "read" : "approve";
  }

  async decide(ticket: RunnerTicket, id: string, input: { decision: "approve" | "deny"; operation: Operation; brokerCapability?: string; scope?: "call" | "session" }): Promise<ApprovalRecord> {
    this.requireUnfrozen();
    this.assertTicket(ticket);
    if (input.decision !== "approve" && input.decision !== "deny") throw new RunnerError(400, "Invalid approval decision");
    if (input.scope !== undefined && input.scope !== "call" && input.scope !== "session") throw new RunnerError(400, "Invalid approval scope");
    return this.exclusive(async () => {
      const permission = this.decisionPermission(ticket.actorId, input.operation);
      await this.authorize(ticket.actorId, permission, ticket.policyVersion);
      const state = await this.metadata();
      const approval = state.approvals[id];
      if (!approval) throw new RunnerError(404, "Approval not found");
      if (stableJson(validateOperation(input.operation)) !== stableJson(approval.operation)) throw new RunnerError(409, "Approval operation mismatch");
      const decided = () => new RunnerError(409, "Approval has already been decided; unsafe effects are never retried");
      if (approval.status !== "pending") throw decided();
      const record = (meta: Metadata, decision: Partial<ApprovalRecord>) => {
        const card = meta.approvals[id]!;
        if (card.status !== "pending") throw decided();
        Object.assign(card, decision);
      };
      await this.requireHostDecider(ticket.actorId, approval);
      const granted = (approval.operation.kind === "bash" || approval.operation.kind === "program") && approval.unbounded === true && grantedShell(this.hostCommandSession());
      if (approval.operation.kind === "git.repin" && ticket.actorId !== this.binding.owner.id) {
        throw new RunnerError(403, "Only the session owner can decide a repin");
      }
      if (approval.operation.kind === "permission") {
        const request = approval.operation;
        if (ticket.actorId !== this.binding.owner.id) throw new RunnerError(403, "Only the session owner can allow more than the session allows");
        if (request.needs.includes("unbounded-shell") && grantedShell(this.hostCommandSession()) && !await this.hostCommandLevel(ticket.actorId, "approve")) {
          throw new RunnerError(403, "Only the host's owner, or a member granted host commands on this host, can allow a shell without resource limits");
        }
        const scope = input.scope ?? "call";
        if (scope === "session" && request.tool === "host_bash") throw new RunnerError(400, "Host commands can only be allowed once");
        await this.mutate(meta => {
          record(meta, input.decision === "approve" ? { status: "approved", decidedBy: ticket.actorId, scope } : { status: "denied", decidedBy: ticket.actorId });
          if (input.decision !== "approve" || scope !== "session") return;
          const grants = meta.grants ??= { tools: [], write: false, unboundedShell: false };
          if (request.needs.includes("tool") && !grants.tools.includes(request.tool)) grants.tools.push(request.tool);
          if (request.needs.includes("write")) grants.write = true;
          if (request.needs.includes("unbounded-shell")) grants.unboundedShell = true;
          if (request.needs.includes("audience")) grants.audience = true;
          for (const other of Object.values(meta.approvals)) {
            if (other.id === id || other.status !== "pending" || other.operation.kind !== "permission" || !this.coveredBy(other.operation, grants)) continue;
            Object.assign(other, { status: "approved", decidedBy: ticket.actorId, scope });
          }
        });
        return (await this.metadata()).approvals[id]!;
      }
      if (input.decision === "deny") {
        await this.mutate(meta => { record(meta, { status: "denied", decidedBy: ticket.actorId }); });
        return (await this.metadata()).approvals[id]!;
      }
      if (approval.operation.kind === "extension.tool") {
        await this.authorize(approval.requestedBy, "write");
        await this.mutate(meta => { record(meta, { status: "approved", decidedBy: ticket.actorId }); });
        return (await this.metadata()).approvals[id]!;
      }
      this.requireRepositoriesReady();
      this.requireShellCapability(approval.operation, approval.unbounded === true);
      await this.authorize(approval.requestedBy, "write");
      if (!this.#waits.waiting(id) && Object.values(state.runs).some(holdsQueue))
        throw new RunnerError(409, "Wait for the session queue to finish before approval execution");
      if (["github.comment", "github.merge", "github.issue", "git.push"].includes(approval.operation.kind) && !input.brokerCapability) throw new RunnerError(403, "Missing owner-bound single-use broker capability");
      await this.mutate(meta => { record(meta, { status: "executing", decidedBy: ticket.actorId }); });
      if (approval.operation.kind === "host.bash") {
        void this.startHostOperation(id, approval.operation, { actorId: ticket.actorId, capability: input.brokerCapability }, async () => {
          await this.authorize(approval.requestedBy, "write");
          await this.authorize(ticket.actorId, permission);
        });
        return (await this.metadata()).approvals[id]!;
      }
      if (approval.operation.kind === "bash" || approval.operation.kind === "program") {
        const operation = approval.operation;
        void this.startShellOperation(id, operation, approval.unbounded === true, async () => {
          this.requireShellCapability(operation, approval.unbounded === true);
          await this.requireHostEnvironment();
          await this.authorize(approval.requestedBy, "write");
          await this.authorize(ticket.actorId, "approve");
          await this.requireHostDecider(ticket.actorId, approval);
          if (granted) await this.requireShellGrant();
        });
        return (await this.metadata()).approvals[id]!;
      }
      if (approval.operation.kind === "git.push") {
        const operation = approval.operation;
        const controller = new AbortController();
        const generation = this.generation;
        const entry = { controller, done: Promise.resolve() };
        entry.done = (async () => {
          const outcome = await this.runPush(id, operation, { actorId: ticket.actorId, capability: input.brokerCapability! }, async () => {
            await this.authorize(approval.requestedBy, "write");
            await this.authorize(ticket.actorId, "approve");
          }, controller.signal);
          if (generation !== this.generation) return;
          await this.mutate(meta => { Object.assign(meta.approvals[id]!, { status: outcome.status, result: this.#waits.kept(id, outcome.result) }); });
        })().catch(() => { })
          .finally(() => {
            this.pushes.delete(entry);
            if (generation === this.generation && !this.closing) this.drainQueue();
          });
        this.pushes.add(entry);
        return (await this.metadata()).approvals[id]!;
      }
      try {
        let result: string;
        if (approval.operation.kind === "github.comment" || approval.operation.kind === "github.merge" || approval.operation.kind === "github.issue") {
          await this.authorize(approval.requestedBy, "write");
          await this.authorize(ticket.actorId, "approve");
          result = await this.githubEffect(approval.operation, { sessionId: this.binding.session.id, actorId: ticket.actorId, approvalId: id, capability: input.brokerCapability! });
        } else throw new RunnerError(400, "Unsupported approval operation");
        await this.mutate(meta => { Object.assign(meta.approvals[id]!, { status: "executed", result: this.#waits.kept(id, result) }); });
      } catch (error) {
        const outcome = error instanceof RunnerError && error.status === 422 && (approval.operation.kind === "github.merge" || approval.operation.kind === "github.issue")
          ? { status: "failed" as const, result: this.#waits.kept(id, error.message) }
          : { status: "interrupted" as const, result: "Effect failed or outcome is ambiguous. Inspect external state; automatic retry is prohibited." };
        await this.mutate(meta => { Object.assign(meta.approvals[id]!, outcome); });
      }
      return (await this.metadata()).approvals[id]!;
    });
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
          model: agent.model ?? this.modelRef, thinkingLevel: agent.thinkingLevel, extensions: [this.#extension, ...this.#definedExtensions],
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

  async view(): Promise<SessionView> {
    const tunnel = this.#tunnel?.view();
    const initial = await this.metadata();
    const snapshots: { branch: Branch; entries: readonly EntryRecord[]; messages: readonly Message[] }[] = [];
    for (const branch of initial.branches.filter(item => !item.superseded)) {
      const conversation = await this.harness.conversation(branch.id as ConversationId, context);
      if (!conversation) continue;
      const active = await conversation.context(context);
      snapshots.push({ branch, entries: active.entries, messages: active.messages });
    }
    const state = await this.metadata();
    const stored = Object.values(state.approvals);
    const autoApproved = autoApprovedCalls(stored);
    const entries: SessionView["entries"] = [];
    for (const snapshot of snapshots) {
      let previous: Run | undefined;
      const refused = Object.values(state.runs).filter(run => run.refused && run.conversationId === snapshot.branch.id)
        .sort((a, b) => (a.sequence ?? 0) - (b.sequence ?? 0));
      const refusedAt = (after: (run: Run) => boolean) => {
        for (const run of refused.filter(after)) entries.push(refusedView(run, snapshot.branch.id));
      };
      refusedAt(run => !snapshot.entries.some(entry => entry.id <= run.startEntry));
      for (const entry of snapshot.entries) {
        const run = Object.values(state.runs).filter(candidate => (candidate.started || candidate.submissionId !== undefined || candidate.status === "admitting") && candidate.conversationId === entry.conversationId && candidate.startEntry < entry.id).sort((a, b) => b.startEntry - a.startEntry)[0];
        const ending = run !== previous && previous && endView(previous, snapshot.branch.id);
        if (ending) entries.push(ending);
        previous = run;
        entries.push(entryView(entry, snapshot.branch.id, run?.initiatedBy, autoApproved));
        const next = snapshot.entries[snapshot.entries.indexOf(entry) + 1];
        refusedAt(run => run.startEntry >= entry.id && (!next || run.startEntry < next.id));
      }
      const ending = previous && endView(previous, snapshot.branch.id);
      if (ending) entries.push(ending);
    }
    const agent = await this.#shared.agent(context);
    const shared = snapshots.find(snapshot => snapshot.branch.mode === "write");
    const usage = shared && this.contextView(shared.messages, agent.model);
    const latestWrite = Object.values(state.runs).filter(run => run.mode === "write" && !run.withdrawn).sort((a, b) => (b.sequence ?? 0) - (a.sequence ?? 0))[0];
    const access = latestWrite && (latestWrite.options?.access ?? "approval");
    const repositories = this.repositoryView();
    const { id, displayName, gitName, gitEmail, githubLogin } = this.binding.owner;
    const { approvals, olderApprovals } = viewApprovals(stored);
    return { sessionId: this.binding.session.id, owner: { id, displayName, gitName, gitEmail, githubLogin }, entries,
      approvals, ...(olderApprovals ? { olderApprovals } : {}),
      conversations: state.branches.filter(branch => !branch.superseded).map(({ id, mode, actorId }) => ({ id: String(id), mode, ...(actorId ? { actorId } : {}) })),
      busy: Object.values(state.runs).some(holdsQueue)
        || Object.values(state.approvals).some(approval => approval.status === "executing") || repositories?.status === "preparing",
      queue: Object.values(state.runs).sort((a, b) => (a.sequence ?? 0) - (b.sequence ?? 0))
        .map(run => ({ submissionId: run.key, actorId: run.initiatedBy, mode: run.mode, status: run.stopped ? (run.stopped.pending ? "stopping" : "stopped") : run.withdrawn ? "withdrawn" : run.inputsLost ? "images lost" : run.refused ? "refused" : run.status })),
      stoppable: true,
      withdrawable: true,
      rewindable: true,
      memberForks: true,
      ...(agent.model ? { agent: { provider: agent.model.provider, modelId: agent.model.modelId, thinkingLevel: agent.thinkingLevel } } : {}),
      ...(usage ? { context: usage } : {}),
      ...(access ? { access } : {}),
      ...(repositories ? { repositories } : {}),
      activity: repositories ? (repositories.status === "preparing" ? "working" : "failed")
        : sessionActivity(Object.values(state.runs).filter(tellsActivity), Object.values(state.approvals),
          activityEntry(shared?.entries.at(-1))),
      ...await this.extensionView(),
      ...(tunnel ? { tunnel } : {}),
    };
  }

  private contextView(messages: readonly Message[], model: { provider: string; modelId: string } | undefined): SessionView["context"] {
    const tokens = contextTokens(messages);
    if (!Number.isFinite(tokens) || tokens < 0) return undefined;
    const current = model ?? this.modelRef;
    let window: number | undefined;
    try {
      const found = current && this.models?.getModel(current.provider, current.modelId)?.contextWindow;
      window = Number.isSafeInteger(found) && found! > 0 ? found : undefined;
    }
    catch { window = undefined; }
    const compactsAt = current ? compactionThreshold(this.#compaction(), current, window) : undefined;
    return { tokens, ...(window !== undefined ? { window } : {}), ...(compactsAt !== undefined ? { compactsAt } : {}) };
  }

  private async extensionView(): Promise<Pick<SessionView, "extensions">> {
    const config = this.config.extensions;
    const enabled = this.#builtins ? (await this.hostConfig().catch(() => undefined))?.builtinExtensions ?? [] : [];
    if (!config) {
      const builtin = this.#builtins?.select(enabled, new Set()).map(item => item.name) ?? [];
      return builtin.length ? { extensions: { running: [], missing: [], builtin } } : {};
    }
    try {
      const answer = await config.workspace(this.binding.session.workspaceId);
      const installed = config.installed().map(item => item.summary);
      const required = await this.requiredExtensions() ?? [];
      const chosen = sessionExtensions(answer.extensions, installed, { ownerId: this.binding.owner.id, connectorOwnerId: this.binding.session.connectorOwnerId }, required);
      const missingRequired = missingRequiredExtensions(required, installed);
      const settled = settleToolNames(chosen.map(item => ({ source: item.source,
        tools: installed.find(candidate => candidate.source === item.source)?.modules.flatMap(module => module.tools.map(tool => tool.name)) ?? [] })),
        this.tools.map(tool => tool.name));
      const running = chosen.map((item, index) => ({ source: item.source, dev: item.dev, tools: settled[index]!.kept, ...(item.required ? { required: true as const } : {}) }));
      const requiredPackages = new Set(required.map(item => extensionPackageKey(item.source)));
      const missing = answer.extensions.filter(item => item.enabled && !requiredPackages.has(extensionPackageKey(item.source))
        && !chosen.some(candidate => candidate.source === item.source)).map(item => item.source);
      const builtin = this.#builtins?.select(enabled, new Set(running.flatMap(item => item.tools))).map(item => item.name) ?? [];
      const off = this.definedToolsOff(sessionToolsOff(answer.extensions), answer.extensions);
      const browserReason = off.has("browser") ? undefined : this.browserUnavailable();
      const tunnelReason = off.has("tunnel") ? undefined : this.tunnelUnavailable();
      const unavailable = [...(browserReason ? [{ source: "piki:browser", tools: ["browser"], reason: browserReason }] : []),
        ...(tunnelReason ? [{ source: "piki:tunnel", tools: ["tunnel"], reason: tunnelReason }] : []),
        ...this.missingPrograms(off).map(item => ({ source: item.source, tools: [item.tool], reason: "programs", programs: item.programs }))];
      return running.length || missing.length || builtin.length || missingRequired.length || unavailable.length
        ? { extensions: { running, missing, ...(builtin.length ? { builtin } : {}), ...(missingRequired.length ? { missingRequired } : {}),
          ...(unavailable.length ? { unavailable } : {}) } } : {};
    } catch { return {}; }
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
      this.requireRepositoriesReady();
      this.requireUnfrozen();
      await this.close();
      try {
        const sqlite = await readFile(this.sqlitePath, "base64");
        if (conversationOnly) {
          return { format: "pi-runner-backup-v1", binding: this.binding, manifest: state, sqlite, files: [], conversationOnly: true,
            createdAt: new Date().toISOString() };
        }
        const authorize = async () => { await this.authorize(ticket.actorId, "manage"); };
        const sandboxed = this.#clone && this.#egress;
        const { clones, found } = sandboxed ? await isolatedWorkspace(this.sandbox).cloneBackup(authorize) : { clones: [], found: [] };
        const files = sandboxed ? await isolatedWorkspace(this.sandbox).snapshot(authorize, found) : await this.sandbox.snapshot(authorize);
        return { format: "pi-runner-backup-v1", binding: this.binding, manifest: state, sqlite, files, ...(clones.length ? { clones } : {}),
          createdAt: new Date().toISOString() };
      } finally { await this.open(); }
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
    this.requireRepositoriesReady();
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
        const files = await sandbox.snapshot(authorize, found, { skipCaches: true });
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

  async upload(ticket: RunnerTicket, input: unknown): Promise<UploadResult> {
    this.assertTicket(ticket);
    await this.authorize(ticket.actorId, "write", ticket.policyVersion);
    const chunk = parseUploadChunk(input);
    if ("error" in chunk) throw new RunnerError(400, "Invalid upload chunk");
    return this.#uploads.receive(ticket.actorId, chunk, async () => { await this.authorize(ticket.actorId, "write", ticket.policyVersion); });
  }


  async close({ abortPushes = true }: { abortPushes?: boolean } = {}): Promise<void> {
    this.closing = true;
    this.#waits.dropResults();
    const preparation = this.#repositories;
    if (preparation.status === "preparing") preparation.controller.abort();
    this.#repositories = { status: "ready" };
    this.#preparations++;
    this.#opened = false;
    this.#resumed = false;
    this.#activity?.stop();
    const tunnel = this.#tunnel;
    this.#tunnel = undefined;
    await tunnel?.close().catch(() => {});
    if (abortPushes) {
      for (const push of this.pushes) push.controller.abort();
      await Promise.allSettled([...this.pushes].map(push => push.done));
    }
    this.generation++;
    const extensions = this.#hostExtensions;
    this.#hostExtensions = undefined;
    await extensions?.shutdown().catch(() => {});
    this.#waits.dropWaiters();
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

  private async runPush(id: string, operation: GitPushOperation, auth: { actorId: string; capability?: string; admissionId?: string }, recheck: SandboxAuthorize, signal?: AbortSignal): Promise<{ status: "executed" | "failed" | "interrupted"; result: string }> {
    if (!this.#clone || operation.directory === undefined) return { status: "failed", result: "Push failed: a push names a clone's directory. Nothing was pushed." };
    if (!this.#egress) return { status: "failed", result: "Push failed: on a host without the sandbox, push with the git tool. Nothing was pushed." };
    const request: PushCredentialRequest = { sessionId: this.binding.session.id, approvalId: id, actorId: auth.actorId, operation,
      ...(auth.capability !== undefined ? { capability: auth.capability } : {}), ...(auth.admissionId !== undefined ? { admissionId: auth.admissionId } : {}) };
    let credential: PushCredential | HostPushCredential;
    try {
      await recheck();
      credential = this.config.pushCredential ? await this.config.pushCredential(request) : await this.controlPlane<PushCredential | HostPushCredential>("/api/internal/git/push/credential", request);
      if (!credential || typeof credential.credentialId !== "string" || typeof credential.remote !== "string"
        || ("hostCredentials" in credential ? credential.hostCredentials !== true : typeof credential.authorization !== "string"))
        throw new RunnerError(502, "Invalid push credential");
    } catch (error) {
      const reason = error instanceof RunnerError ? `: ${error.message}` : "";
      return { status: "failed", result: `Push credential was refused${reason}. Nothing was pushed.` };
    }
    let pushed: PushResult | undefined;
    let failure: { status: "failed" | "interrupted"; result: string } | undefined;
    try {
      const authorization = "hostCredentials" in credential ? await this.hostAuthorization(credential.remote, signal) : credential.authorization;
      pushed = await performClonePush({ workspace: isolatedWorkspace(this.sandbox), operation, credential: { remote: credential.remote, authorization }, authorize: recheck, signal });
    } catch (error) {
      failure = error instanceof PushError && !signal?.aborted
        ? { status: "failed", result: `Push failed: ${error.message}. Nothing was pushed.` }
        : { status: "interrupted", result: "Push was interrupted; the remote branch may or may not have changed. Inspect it; automatic retry is prohibited." };
    }
    const outcome: PushOutcome = pushed?.outcome ?? (failure?.status === "failed" ? "failed" : "unknown");
    const complete: PushCompleteRequest = { sessionId: this.binding.session.id, approvalId: id, credentialId: credential.credentialId, outcome, ...(pushed ? { tip: pushed.tip } : {}) };
    let completion: PushCompletionResult | undefined;
    let completionFailure = "";
    try {
      completion = this.config.pushComplete ? await this.config.pushComplete(complete) : await this.controlPlane<PushCompletionResult>("/api/internal/git/push/complete", complete);
    } catch (error) {
      completionFailure = error instanceof RunnerError ? `: ${error.message}` : "";
    }
    if (!pushed) return failure!;
    const confirmation = completion ? "" : operation.pullRequest
      ? `\nThe pull request was not opened${completionFailure || "; the control plane did not confirm completion"}.`
      : "\nThe control plane did not confirm completion.";
    return { status: "executed", result: pushSummary(pushed, completion?.pullRequest) + confirmation };
  }

  private async hostAuthorization(remote: string, signal?: AbortSignal): Promise<string> {
    if (!this.config.hostGitCredential) throw new PushError("This host does not push with its Git credentials; its owner can turn them on in Pikibun (Settings → Hosts → the host → Configuration)");
    if (this.binding.session.connectorOwnerId !== this.binding.owner.id) throw new PushError("Only the host's owner can push with its Git credentials");
    try {
      return await this.config.hostGitCredential(remote, signal);
    } catch (error) {
      throw new PushError(error instanceof HostCredentialError ? error.message : "The host's Git credentials could not be read");
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
