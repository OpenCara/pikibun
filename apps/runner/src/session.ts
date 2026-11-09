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
import { EXTENSION_ARGUMENTS_SHOWN, GITHUB_ISSUE_BODY_LIMIT, GITHUB_ISSUE_TITLE_LIMIT, accessModes, githubMergeMethods, repositoryPreparationPhases, scheduleToolActions, thinkingLevels } from "../../../packages/shared/src/types.js";
import { scheduleToolTarget } from "../../../packages/shared/src/cron.js";
import { crossSessionLimits, sessionsToolActions, sessionsToolTarget, sessionsWriteActions, type SessionsToolRequest, type SessionsToolResult } from "../../../packages/shared/src/cross-session.js";
import type { CompactionFailure } from "../../../packages/shared/src/types.js";
import type { RestoreDescriptor } from "../../../packages/shared/src/connector.js";
import { bindingRemote, repositoryPath, validCloneDirectory, validPushTag } from "../../../packages/shared/src/repositories.js";
import { sha256 } from "../../../packages/shared/src/crypto.js";
import { extensionPackageKey, missingRequiredExtensions, sessionExtensions, type ChosenExtension, type WorkspaceExtensionsAnswer } from "../../../packages/shared/src/host-extensions.js";
import type { ModelRegistry } from "@earendil-works/pi-coding-agent";
import { ExtensionPrompts, SessionExtensions, settleToolNames, type ExtensionHost, type InputOutcome, type SessionExtension } from "./extensions/adapter.js";
import { sandboxShellCommand, type CliRun, type PikiSandboxRun, type PikiSession } from "./extensions/piki/command.js";
import { SessionBuiltins, type OutputFiles } from "./extensions/builtin.js";
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
import { compactionFailure, configuredCompaction, hostCompaction } from "./compaction.js";
import { ActivityReporter, sessionActivity, type ActivityEntry } from "./activity.js";
import { autoApprovedCalls, viewApprovals, type StoredApproval } from "./approval-view.js";
import { EgressProxy, egressEnvironment, egressSocketPath, parseEgressGrant, relayGitRequest, relayPath, repositoryForRemote, type MirrorProgress, type RelayRequest } from "./egress.js";
import { DirectGit } from "./git-direct.js";
import { egressReadServices, type ApiAccessKind, type EgressGrant, type EgressRepository, type GitDirectRequest } from "../../../packages/shared/src/network.js";
import { sessionBranch } from "../../../packages/shared/src/git-push.js";
import { documentKindNames, type DocumentKind, type GrantSource } from "../../../packages/shared/src/sources.js";
import { defaultHostConfig, type HostCompaction, type HostConfig, type RequiredExtension } from "../../../packages/shared/src/host-config.js";
import { commandLimits, type CommandLimits } from "./host-config.js";
import { requesterAutoApproves, decidedAsHostCommand, grantedShell, type HostCommandSession } from "../../../packages/shared/src/host-operations.js";

export type Run = {
  key: string; initiatedBy: string; ownerId: string; mode: "write" | "ask";
  conversationId: number; content: string; contentHash: string; submissionId?: number;
  status: "queued" | "admitting" | "running" | "settled" | "interrupted"; startEntry: number;
  sequence?: number;
  started?: boolean;
  admissionId?: string;
  /** When the runner accepted the message (epoch ms); its Worker write admission lasts an hour from about then. */
  submittedAt?: number;
  /** Worker-signed per-message choices, applied to the conversation when the run starts. */
  options?: ChatOptions;
  /**
   * The message carries images, prepared for the model: until it reaches Pi they wait in the session's inputs directory
   * (see writeInputs), never here, as every change rewrites this ledger whole. `bytes` is their base64 length.
   */
  images?: { count: number; bytes: number };
  /** Its images were gone or unreadable on the host when it was to run, so it ended without reaching Pi (see endLostInputs). */
  inputsLost?: true;
  /** Pi ended the run without an answer or any entry: its model was unavailable, or its context could not be compacted. */
  failure?: { reason: "model_error" | "no_model" | "compaction_failed"; provider?: string; modelId?: string; compaction?: CompactionFailure };
  /** Who stopped it (see stop); `pending` until its conversation's work has ended, which holds the queue. */
  stopped?: { by: string; pending?: true };
  /**
   * Host crashes ended it: Pi ended its work once they cut it off `restartLimit` times in a row (`restart_limit`), or
   * cut off its model request with no retry left (`interrupted`). See observeRun.
   */
  crashed?: true;
  /**
   * Extensions' input handlers are still to see it (see `screen`): it is queued, but neither it nor anything behind it
   * starts until they have.
   */
  screening?: true;
  /** An extension's input handler took it (see `screen`), so it ended without reaching Pi; `notice` is what the sender is told. */
  refused?: { by: string; notice: string };
  /** Someone went back to before this shared message (see `revert`): it no longer says what the session is doing. */
  reverted?: true;
  /** Its sender took it back before it ran, to edit it (see `withdraw`): it never reached Pi, and says nothing of the session. */
  withdrawn?: true;
};
/**
 * One of the session's conversations. The shared conversation is the write branch that isn't `superseded`: going back to
 * an earlier message (`revert`) forks it there and supersedes it, which keeps its entries on the host but out of the view.
 */
type Branch = { id: number; mode: "write" | "ask"; actorId?: string; superseded?: true };
/** An entry of the shared conversation as a session forked from it starts with (see `forkEntries` and `seed`). */
export type ForkedEntry = { kind: string; model: readonly Message[] };
/** What a session forked from another starts with: its shared conversation's entries, and the model and reasoning it used. */
export type ForkedConversation = { entries: ForkedEntry[]; agent: { model?: { provider: string; modelId: string }; thinkingLevel?: ThinkingLevel } };
/** The kind of the entries a forked session starts with. */
const FORKED_KIND = "workspace.forked";

/** The view entry a revert names: `{ entryId }`, nothing else. */
export function messageInput(input: unknown): string {
  const value = input as { entryId?: unknown } | null;
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some(key => key !== "entryId")
    || typeof value.entryId !== "string" || value.entryId.length > 64) throw new RunnerError(400, "Invalid message");
  return value.entryId;
}
/**
 * What the session owner allowed for the rest of the session, beyond the agent's tools and each message's access.
 * `audience`: the sessions tool exchanges content with sessions whose readers aren't this session's.
 */
type Grants = { tools: AnyToolName[]; write: boolean; unboundedShell: boolean; audience?: boolean };
/** A session's backup (format pi-runner-backup-v1), as restore.ts reads it back. */
interface RunnerBackup {
  format: "pi-runner-backup-v1";
  binding: RunnerBinding;
  manifest: Metadata;
  /** Pi's SQLite, base64. */
  sqlite: string;
  files: SnapshotFile[];
  /** A clone session's clones, as bundles of their local work (Sandbox.cloneBackup). */
  clones?: CloneBackup[];
  /** Only the conversation: no files and no clones. */
  conversationOnly?: true;
  createdAt: string;
}
type Metadata = { binding: RunnerBinding; branches: Branch[]; runs: Record<string, Run>; approvals: Record<string, StoredApproval>; toolActors: Record<string, { initiatedBy: string; ownerId: string; runKey: string; callId?: string }>; usedTickets?: Record<string, number>; nextSequence?: number; grants?: Grants;
  /** The session's latest restore was from a conversation-only backup: files and clones its history mentions weren't kept. */
  conversationOnlyRestore?: true;
  /** The session started from another session's shared conversation, up to one of its messages (see `seed`). */
  forkedFrom?: { sessionId: string; entryId: string } };
/** One JSON string that every change replaces, so each change is stored whole: a delta would be as large and only lengthen replay. */
const RunnerState = defineDoc<{ json: string }>({ kind: "workspace.runner", version: 1, scope: "session", initial: () => ({ json: "" }), checkpointWhen: () => true });
/** Prepared images of queued messages that a session holds on disk at once, until their messages reach Pi. */
const MAX_QUEUED_IMAGE_BYTES = 16 * 1024 * 1024;
/** Tools that never change files or run commands: the whole toolset of side asks. */
const readOnlyTools = ["identity", "read_file", "list_files", "search"];
/** How often a sessions tool wait reads its message's outcome. */
const WAIT_POLL_MS = 3000;
const SESSIONS_TOOL_DESCRIPTION = "Work with this workspace's other Pikibun sessions, as the person whose message you are working on, with exactly their permissions in each session. "
  + "action list: the sessions they can see (id, title, status, activity, their permissions, parent), the models create can use, with the thinking levels each offers, and whether this workspace lets create choose them (childModels). "
  + "read {session, limit?, message_id?}: a session's latest shared-conversation entries and pending approvals; with message_id, also the outcome of a message this session sent it (status, done, reply). "
  + "ask {session, message, notify?}: a read-only side question to that session's agent. "
  + "send {session, message, access?, notify?}: a message to that session's agent, as if typed in its chat (access approval, the default: its commands wait for people there; read: inspect only; auto: only in a message the session owner sent with auto-approve, to a session they own); refused while it is busy. "
  + "wait {session, message_id, timeout_seconds?}: block until a message this session sent finishes (default 300 seconds), then return its outcome and reply. "
  + "create {message?, title?, model?, thinking?, visibility?, access?, notify?}: start a new session for a sub-task, as the same person, and send it message. Where childModels allows, pick the model (one list returns) and thinking level (for its opening message, which its conversation keeps) to suit the sub-task: a capable model with more thinking for hard work, a fast one with less for simple work; what you leave out, and everything where childModels is off, is this session's current model and thinking level. "
  + "stop {session}: stop that session's current work. archive {session}: archive a session they own or, as the workspace's owner or an admin, any of its sessions. "
  + "With notify, Pikibun sends this session the outcome as a new message once the other session finishes. Delivered messages start with a line naming this session and the sender; "
  + "chains of messages stop after 3 hops and never loop back to a session they came from; approvals in another session are decided only by people there. "
  + "Involve other sessions only when the user asked for it or clearly expects it.";
/**
 * How long after a message is sent its tool calls can wait on a card: the owner's permission or an operation's approval.
 * Deciding needs the message's write admission, which lasts an hour from sending, so a card older than that can't be
 * decided: the call fails instead of holding the session.
 */
const DECISION_WAIT_MS = 60 * 60 * 1000;
/** Why a command without the host's missing limits in a member's session waits for someone else (see grantedShell). */
const GRANTED_SHELL_DECIDERS = "This command runs without the resource limits its host lacks, on the strength of a host command grant: "
  + "only the host owner, or a member granted host commands on this host, can decide it";
/**
 * Whether `run` still says what the session is doing: not one someone went back from (see `revert`), nor one its sender
 * took back before it ran (see `withdraw`). Both the view and the activity reported to the control plane go by it.
 */
function tellsActivity(run: Run): boolean {
  return !run.reverted && !run.withdrawn;
}

/** Whether `run` keeps the session busy: it is queued or at work, or a stop of it is still ending its work. */
function holdsQueue(run: Run): boolean {
  return ["queued", "running", "admitting"].includes(run.status) || run.stopped?.pending === true;
}
export type RunnerConfig = {
  dataDir: string; controlPlaneUrl: string; sharedSecret: string; allowFaux: boolean; allowTestShell?: boolean; fetch?: typeof fetch;
  connectorId?: string;
  authorize?: (request: AuthorizationRequest) => Promise<AuthorizationResult>;
  /** Posts one comment, human-approved (`capability`) or of the owner's Auto-approve message (`admissionId`). */
  githubComment?: (request: GitHubCommentRequest) => Promise<{ id: number; url: string }>;
  /** Reads an issue or pull request as the session owner, through the control plane. */
  githubRead?: (request: GitHubReadRequest) => Promise<GitHubIssueView>;
  /** Tests only: how long github_read's wait waits between reads (githubWaitLimits.pollSeconds otherwise). */
  githubWaitPollMs?: number;
  /**
   * The tools the control plane defines as data (tool-definitions.ts), as the connector reads them; this version's
   * bundled ones without it, or while it gives none.
   */
  toolDefinitions?: () => Promise<readonly ToolDefinition[]>;
  /**
   * One brokered tool's call (tool-definitions.ts), such as source_read's, posted to the control plane's `route` as the
   * connector's own; its refusal throws a RunnerError with its reason. Without it, the control plane's internal route.
   */
  brokered?: (route: string, request: Record<string, unknown>) => Promise<unknown>;
  /** Performs one merge, as githubComment; a refusal GitHub stated throws a RunnerError with status 422 and its reason. */
  githubMerge?: (request: GitHubMergeRequest) => Promise<GitHubMergeResult>;
  /** Opens one issue, as githubComment; a refusal GitHub stated throws a RunnerError with status 422 and its reason. */
  githubIssue?: (request: GitHubIssueRequest) => Promise<GitHubIssueResult>;
  /** Lists, creates, changes or deletes the session's scheduled prompts, as the schedule tool asks; the control plane's refusal throws a RunnerError with its reason. */
  schedules?: (request: ScheduleToolRequest) => Promise<ScheduleToolResult>;
  /** One sessions tool call (any action but wait, which is reads), through the control plane; its refusal throws a RunnerError with its reason. */
  crossSessions?: (request: SessionsToolRequest) => Promise<SessionsToolResult>;
  /** Issues the credential for one approved push; a token is held only in this process's memory. */
  pushCredential?: (request: PushCredentialRequest) => Promise<PushCredential | HostPushCredential>;
  /** Reports a finished push so its credential is revoked and any requested pull request is opened. */
  pushComplete?: (request: PushCompleteRequest) => Promise<PushCompletionResult>;
  /**
   * Reads this host's own Git credential for a push remote as an Authorization header. A connector sets it, and it refuses
   * (HostCredentialError) unless the host's owner has Git credentials on in its configuration (HostConfig.gitCredentials).
   */
  hostGitCredential?: (remote: string, signal?: AbortSignal) => Promise<string>;
  /** The host's models; `thinkingLevel` is the level its Pi starts the model at. */
  resolveModels?: (model: ModelDefinition) => Promise<{ models: Models; provider: string; modelId: string; thinkingLevel?: ThinkingLevel }>;
  readBackup?: (restore: RestoreDescriptor, targetSessionId: string) => Promise<Uint8Array>;
  /** The host's Pi compaction settings, overall and per model; Pi's defaults without them, but for reasoning models' room (see hostCompaction). */
  compaction?: CompactionSettings;
  /** How the host's Pi identifies its requests to providers; pi-durable's default (attributed to pi) without it. */
  identity?: ClientIdentity;
  /**
   * This host's repository cache, when its configuration keeps one (HostConfig.repositoryCache): a mirror per repository,
   * filled straight from its provider with this host's own Git credentials (see cacheRemote), that clones borrow objects
   * from once the control plane's relay confirms their owner may read it. Fixed for a connection.
   */
  repositoryCache?: RepositoryCache;
  /**
   * How the repository cache reads a workspace repository: by default directly from its provider, with the credential Git
   * on this host would use (its credential helpers), or anonymously where it has none for the provider. Never through the
   * relay. Tests stand in their own remote.
   */
  cacheRemote?: (repository: EgressRepository) => Promise<GitRemote>;
  resources?: ResourceConfig;
  /**
   * The Chromium the browser tool runs in the Linux sandbox (browser-toolchain.ts): the host's own, found once per
   * process, unless this names another, the one a connector has now (HostBrowserSource), or null for none. Sessions
   * without the sandbox, or without one, aren't offered the tool.
   */
  browser?: BrowserToolchain | null | (() => BrowserToolchain | undefined);
  /** How the connector's browser stands (HostBrowserSource): why a session has none, for its people and its agent. */
  browserStatus?: () => HostBrowserStatus | undefined;
  /**
   * The connector's quick tunnels (piki:tunnel, tunnel-host.ts): `open` points cloudflared, on the host, at a session
   * service's socket, and `status` says how the host's cloudflared stands (HostTunnelSource). Without them, sessions have
   * no tunnel tool.
   */
  tunnels?: { open(socket: string, signal?: AbortSignal): Promise<QuickTunnel>; status(): HostTunnelStatus | undefined };
  /** Tells the control plane a session's tunnel started or stopped, for its audit log and the session list; connected runners only. */
  reportTunnel?: (report: SessionTunnelReport) => Promise<void>;
  /** Owner-consented host mode: no isolation, so bash needs only per-command approval. */
  unsandboxed?: boolean;
  /**
   * Whether Pikibun extensions' commands (piki:gh, ...) run on the host with the host's own sign-in in the host owner's
   * own sessions, as the host's owner chose (PIKIBUN_PIKI_HOST_SIGN_IN=1); otherwise they run in the sandbox, as the
   * session owner. Other members' sessions never get the host's sign-in.
   */
  pikiHostSignIn?: boolean;
  /** The sandbox of a macOS or native Windows host (see sandbox-backend.ts); Linux hosts use bubblewrap without it. */
  sandboxBackend?: SandboxBackendConfig;
  /** Opens a session's Pi storage; defaults to the SQLite file in its directory. */
  openStorage?: (path: string) => Promise<Storage>;
  /** Tells the control plane what a session's agent is doing (see SessionActivity) as it changes; connected runners only. */
  reportActivity?: (sessionId: string, activity: SessionActivity) => Promise<void>;
  /**
   * Tells the control plane which branches a session on the host has checked out in its clones of the workspace's
   * github.com repositories, so that it finds their pull requests (clone-branches.ts); connected runners only.
   */
  reportBranches?: (sessionId: string, branches: SessionBranch[]) => Promise<void>;
  /** A session's network grant and its Git relay, through the connector; without them, the control plane's internal routes. */
  egressGrant?: (sessionId: string) => Promise<EgressGrant>;
  gitRelay?: (sessionId: string, request: RelayRequest) => Promise<Response>;
  /**
   * A direct grant for one of a session's Git requests (GitDirectGrant), through the connector; without it, the control
   * plane's internal route. The host then makes the request at the forge itself, so it doesn't cross the control plane.
   */
  gitDirect?: (sessionId: string, request: Omit<GitDirectRequest, "sessionId">) => Promise<unknown>;
  /**
   * A session's credential for a credentialed API host (ApiCredentialGrant, see api-access.ts), through the connector;
   * without it, the control plane's internal route. The session's egress proxy adds it to the API requests it answers.
   */
  apiCredential?: (sessionId: string, host: string, access: ApiAccessKind) => Promise<unknown>;
  /**
   * How the host runs its sessions, as its owner and admins set it in Pikibun (the connector caches it briefly). Read for
   * each shell command: its time limit and GPU. Without it, the defaults.
   */
  hostConfig?: () => Promise<HostConfig>;
  /**
   * The extensions the host's owner requires of every session (HostConfig.requiredExtensions), as the connector last
   * heard them, however long ago; undefined until it has heard. Without it, those of `hostConfig`.
   */
  requiredExtensions?: () => Promise<RequiredExtension[] | undefined>;
  /**
   * The host's extensions and the workspace's choice of them (docs/design/host-extensions.md); without it, sessions run
   * none. `workspace` is asked often: the connector caches its answers.
   */
  extensions?: {
    installed(): readonly LoadedSource[];
    workspace(workspaceId: string): Promise<WorkspaceExtensionsAnswer>;
    /** The workspace's last answer read, however old (HostExtensions.lastKnown): fail-closed session tools go by it too. */
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

/** Why a message isn't run while what the host's owner requires can't be: plain text the control plane passes on (422). */
const REQUIRED_UNKNOWN = "This host can't learn from Pikibun which extensions its owner requires right now, so no message is sent. Try again shortly";
const REQUIRED_MISSING = "This host's owner requires an extension its connector can't run now, so no message is sent. Ask them to look at the host's extensions";
/** What a message's sender is told when extensions' input handlers ended it otherwise than by a notice of their own. */
const REFUSED = "An extension on this host refused this message.";
const INPUT_FAILED = "This host couldn't check this message with its extensions, so it was not sent. Try again shortly.";
const INPUT_EMPTY = "An extension on this host left this message empty or too long, so it was not sent.";
const INPUT_IMAGES = "An extension on this host changed this message's images into ones that can't be sent.";

/**
 * Beside a session's storage while its agent is working or waiting on a decision, and gone once it isn't: a runner that
 * starts again opens just these sessions, so their work goes on without someone opening them (RunnerService.resume).
 */
export const WORK_MARKER = "working";

/** Whether the model request behind a transcript entry failed, which the session view shows as a failed model turn. */
function modelFailed(entry: EntryRecord): boolean {
  return (entry.model ?? []).some(message => message.role === "assistant" && message.stopReason === "error");
}

/** The shared conversation's last entry, as `sessionActivity` reads it. */
function activityEntry(entry: EntryRecord | undefined): ActivityEntry | undefined {
  return entry && { id: Number(entry.id), failed: modelFailed(entry) };
}

/**
 * One session on this host: its Pi harness and ledger, its runs and their queue, its tools and their approvals. Parts
 * with state of their own live in apps/runner/src/session/, each with its own tests (tests/runner-session-parts.test.ts),
 * and the session coordinates them:
 * - SessionUploads: files attached to messages, chunk by chunk, until each is whole in the worktree;
 * - MessageInputs: queued messages' prepared images, until their messages reach Pi;
 * - SessionMirrors: the host repository cache's mirrors a clone session borrows from;
 * - ApprovalWaits: tool calls waiting on their cards, and operations' whole results;
 * - entries.ts: how the transcript shows entries and runs' ends.
 */
export class RunnerSession {
  readonly sandbox: SessionWorkspace;
  readonly sqlitePath: string;
  private harness!: Harness;
  private root!: Conversation;
  /**
   * The shared conversation: Pi's root until someone goes back to an earlier message, then the fork that replaced it
   * (see `revert`). Every shared message runs here, and side asks fork from it. Session documents still commit on the root.
   */
  #shared!: Conversation;
  /** The session's tools as one extension, for a shared conversation started afresh (see `revert`). */
  #extension!: Extension;
  /** The tools defined as data this session has (tool-definitions.ts): those it opened with, then any new name a message brought. */
  #definitions: ToolDefinition[] = [];
  /** Extensions of the defined tools a message brought after the session opened, installed in the registry as they came. */
  #definedExtensions: Extension[] = [];
  /** The harness's registry, where the session's extensions are installed as it first runs with each. */
  #registry?: Registry;
  /** Queued messages' prepared images, outside the sandbox and the backups, until their messages reach Pi. */
  readonly #inputs: MessageInputs;
  /** Files attached to messages, chunk by chunk, until each is whole and in the worktree. */
  readonly #uploads: SessionUploads;
  /** The host cache's mirrors this clone session borrows from, on a host with a repository cache. */
  readonly #mirrors: SessionMirrors | undefined;
  /**
   * The extension tool calls running now (runExtensionTool), by call id: only these run a Pikibun extension's command in
   * the sandbox, and `write` says whether a person (or the owner's Auto-approve) approved the call, which lets it write
   * through the forge's API as the session owner.
   */
  readonly #pikiCalls = new Map<string, { write: boolean; attribution: { initiatedBy: string; mode: "write" | "ask" } }>();
  /** The session's Pi extensions (docs/design/host-extensions.md), where the host has any. */
  #hostExtensions?: SessionExtensions;
  /**
   * The shared conversation's model and reasoning level, as its extensions see them (`ctx.model`): read when the session
   * opens and when each shared message starts, which may switch them.
   */
  #currentModel?: { provider: string; modelId: string; thinkingLevel?: string };
  /** The extensions being opened now (openExtensions): one opening at a time, so none is opened twice. */
  #opening: Promise<void> = Promise.resolve();
  /** Pi's built-in extensions (HostConfig.builtinExtensions), installed in the registry; each message selects those the host's configuration turns on. */
  #builtins?: SessionBuiltins;
  private tools: ToolRegistration[] = [];
  private lock: Promise<unknown> = Promise.resolve();
  private generation = 0;
  private closing = false;
  private draining = false;
  /**
   * A drain was asked for while one ran (a screening that just ended, say): that pass may have read the queue before the
   * change, so one more follows it. Only such asks set it, so a pass that stops at a message still screened doesn't loop.
   */
  #drainAgain = false;
  private modelRef!: { provider: string; modelId: string };
  private models!: Models;
  /** Pushes (approved ones settle after decide() returns; automatic ones inline); close() aborts and awaits them. */
  private pushes = new Set<{ controller: AbortController; done: Promise<void> }>();
  /** Set when Pi closed the Session because its storage failed; the next request reopens it (see `recover`). */
  #failed = false;
  /** The reopen in progress, which every request waits for instead of reaching a half-open session. */
  #recovery: Promise<void> | undefined;
  /** Tool calls waiting on their cards, and the whole results of operations their records keep an excerpt of. */
  readonly #waits = new ApprovalWaits();
  /**
   * Cloning a restored session's clones again can take minutes, far longer than the control plane waits for `create`.
   * It runs in the background; runs are held until it is done (see drainQueue).
   */
  #repositories: RepositoryPreparation = { status: "ready" };
  /** Bumped by every preparation and by close(), so a superseded preparation never changes what came after it. */
  #preparations = 0;
  /** open() has finished; with #resumed, recovered and queued work resumes exactly once per open, and only when ready. */
  #opened = false;
  #resumed = false;
  /** Reports what the agent is doing while the session is open, when the runner has somewhere to report it. */
  readonly #activity: ActivityReporter | undefined;
  /** The sandbox's only way out (see EgressProxy); listening while the session is open. Host mode has no sandbox to confine. */
  readonly #egress: EgressProxy | undefined;
  /** Git requests this host makes at the forge itself, where the control plane grants it (see DirectGit). */
  readonly #direct: DirectGit | undefined;
  /** A clone session: no pins; the agent clones the workspace's repositories with plain Git through the egress proxy. */
  readonly #clone: boolean;
  /**
   * A session that pinned its repositories when it started: read-only now. It opens to show its history, and nothing
   * resumes or runs in it.
   */
  readonly #frozen: boolean;
  /**
   * The session's files are packed (pack.ts), as of this open: it opens without its sandbox, to show its conversation,
   * and nothing runs in it until RunnerService.unpack brings its files back.
   */
  #packed = false;
  /**
   * The session runs directly on the host's own environment, with no sandbox: every session of an unsandboxed host, or
   * one started that way on a host that accepts it (`#hostSession`).
   */
  readonly #onHost: boolean;
  /**
   * A session started directly on the host (SessionRecord.hostEnvironment), on a host that otherwise sandboxes its
   * sessions, by its owner or by a member they granted that: it runs commands only while the host's configuration still
   * accepts that (HostConfig.hostSessions) and, for a member's, while their grant still includes it; deciding them
   * needs host command authority, as host commands do.
   */
  readonly #hostSession: boolean;
  /** The workspace's repositories as of this open, for a clone session's instructions. */
  #cloneRepositories: string[] = [];
  /** The workspace's document sources as of this open, for the instructions. */
  #sources: GrantSource[] = [];
  /** The workspace's repositories whose Git LFS objects the egress proxy downloads, as of the session's opening. */
  #lfsRepositories: string[] = [];
  /** A clone session on the host: the workspace's repositories, whose checked-out branches it reports (reportBranches). */
  #branchRepositories: EgressRepository[] = [];
  /** The branches last reported, as JSON, and whether a report runs or another is wanted after it. */
  #branchesSent: string | undefined;
  #branchesReporting = false;
  #branchesWanted = false;
  /** Clones a restore left to clone again that this open couldn't restore, for the agent's instructions. */
  #cloneFailures: { path: string; reason: string }[] = [];
  /** Restored from a conversation-only backup (Metadata.conversationOnlyRestore), for the agent's instructions. */
  #conversationOnlyRestore = false;
  /**
   * The compaction token counts of the host's configuration as last read (HostConfig.compaction), which the harness's
   * settings put over the host's Pi settings at each use: a change applies from the first message after the connector's
   * configuration refresh (HostConfigSource, 30 seconds).
   */
  #configuredCompaction: HostCompaction | undefined;
  /** The session's server online through its tunnel (piki:tunnel), made at its first start. */
  #tunnel: SessionTunnel | undefined;

  constructor(readonly binding: RunnerBinding, readonly directory: string, readonly config: RunnerConfig) {
    if (binding.session.connectorId !== config.connectorId || binding.model.connectorId !== config.connectorId)
      throw new RunnerError(403, "Session connector mismatch");
    this.sqlitePath = join(directory, "session.sqlite");
    this.#clone = binding.session.repositoryMode === "clone";
    this.#frozen = !this.#clone && (binding.session.repositories ?? []).length > 0;
    this.#hostSession = binding.session.hostEnvironment === true && config.unsandboxed !== true;
    this.#inputs = new MessageInputs(join(directory, "inputs"));
    // Its grant is the egress proxy's, made below: asked for only once a step runs.
    this.#mirrors = this.#clone && config.repositoryCache ? new SessionMirrors({
      cache: config.repositoryCache, ownerId: binding.owner.id, sessionId: binding.session.id, relay: request => this.relay(request),
      grant: () => this.#egress!.grant(), ...(config.cacheRemote ? { cacheRemote: config.cacheRemote } : {}),
    }) : undefined;
    this.#onHost = config.unsandboxed === true || this.#hostSession;
    // Only sessions of the host's owner, or of a member they granted that, run on the host itself: the control plane
    // admits no other, and the host checks a member's grant again before each of their commands
    // (requireHostEnvironment).
    if (this.#hostSession && !binding.session.connectorOwnerId) {
      throw new RunnerError(403, "Only sessions of the host's owner, or of members they granted that, run directly on the host");
    }
    // Grants come the way relayed requests go: through the connector, or the control plane's internal route. A runner
    // given a relay of its own and no way to ask for grants relays everything.
    const directGrant = config.gitDirect ? (request: Omit<GitDirectRequest, "sessionId">) => config.gitDirect!(binding.session.id, request)
      : config.gitRelay ? undefined
      : (request: Omit<GitDirectRequest, "sessionId">) => this.controlPlane("/api/internal/git/direct", { sessionId: binding.session.id, ...request });
    this.#direct = directGrant && new DirectGit({ grant: directGrant, onFallback: (request, reason) => this.#egress?.noteFallback(request.bindingId, reason) });
    if (this.#onHost) this.sandbox = new HostWorkspace(binding, join(directory, "sandbox"));
    else if (config.sandboxBackend) {
      // macOS and native Windows sandboxes share the host's network: the proxy listens on a loopback port that wants
      // this session's token. They keep no host repository cache.
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
    // Once the agent stops working, its clones are as it left them: a session on the host reports their branches then.
    this.#activity = report && new ActivityReporter(() => this.activity(), async activity => {
      // Marked first: a report that fails (the host is reconnecting) is retried, and the mark must not wait for it. The mark
      // only saves someone opening the session after a restart, so failing to write it never holds the report up.
      await this.markWork(activity).catch(() => {});
      await report(binding.session.id, activity);
      if (activity !== "working") this.reportBranches();
    });
  }

  /** Keeps WORK_MARKER in step with `activity`. Only the host writes the session's directory, never its sandbox. */
  private async markWork(activity: SessionActivity): Promise<void> {
    const marker = join(this.directory, WORK_MARKER);
    if (activity !== "working" && activity !== "waiting") return rm(marker, { force: true });
    const file = await open(marker, constants.O_CREAT | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
    await file.close();
  }

  /** The session's network grant from the control plane: its workspace's repositories and network policy. */
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

  /**
   * One Git request: a read with the session owner's access, or a push of the session branch. It goes to the forge from
   * this host when the control plane grants a credential for it (DirectGit), else through the control plane's relay. A
   * refused read also stops this session borrowing from the host's mirror of that repository.
   */
  private async relay(request: RelayRequest): Promise<Response> {
    const sessionId = this.binding.session.id;
    try {
      const direct = await this.#direct?.forward(request);
      if (direct) return direct;
      return await (this.config.gitRelay ? this.config.gitRelay(sessionId, request)
        : relayGitRequest(this.config.fetch ?? fetch, `${this.config.controlPlaneUrl}${relayPath("/api/internal", sessionId, request)}`,
          { authorization: `Bearer ${this.config.sharedSecret}` }, request, AbortSignal.timeout(60 * 60 * 1000)));
    } catch (error) {
      // Only a refused Git read means the owner lost the repository: a push or a Git LFS download can be refused by policy alone.
      if (egressReadServices.includes(request.service) && refused(error)) this.#mirrors?.forget(request.bindingId);
      throw error;
    }
  }

  /** The mirrors a step that runs Git in a clone mounts now (SessionMirrors.mounts): none on a host without a cache. */
  private async mirrorMounts(): Promise<MirrorMount[]> {
    return this.#mirrors ? this.#mirrors.mounts() : [];
  }

  /** The host's mirror of `repository`, ready for this session to borrow from (SessionMirrors.mirror): its sandbox path. */
  private mirror(repository: EgressRepository, onProgress?: (progress: MirrorProgress) => void): Promise<string> {
    if (!this.#mirrors) throw new RunnerError(409, "This host keeps no repository cache");
    return this.#mirrors.mirror(repository, onProgress);
  }

  private assertTicket(ticket: RunnerTicket): void {
    if (ticket.sessionId !== this.binding.session.id || ticket.ownerId !== this.binding.owner.id || ticket.connectorId !== this.config.connectorId)
      throw new RunnerError(403, "Ticket session, owner, or connector mismatch");
  }

  /**
   * `host`: also ask for the actor's authority over host commands on this host (`hostCommands`); `hostSessions`, also
   * whether they may run their own sessions directly on it. `archived`: the request acts on the session because it is
   * archived, as packing and unpacking its files do; the control plane then allows it only while the session is archived,
   * and refuses every other request of an archived one. `autoApprove`: also ask whether the session's owner auto-approves
   * the actor's requests (`autoApprove`), which only the control plane knows.
   */
  async authorize(actorId: string, permission: Permission, expectedPolicyVersion?: number, host = false, hostSessions = false, archived = false, autoApprove = false): Promise<AuthorizationResult> {
    const body: AuthorizationRequest = { sessionId: this.binding.session.id, ownerId: this.binding.owner.id, actorId, permission,
      ...(host ? { host: true } : {}), ...(host && hostSessions ? { hostSessions: true } : {}), ...(archived ? { archived: true } : {}),
      ...(autoApprove ? { autoApprove: true } : {}) };
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

  /**
   * What `actorId` may do with host commands here: the host's owner holds `auto`; anyone else what the control plane
   * reports of the grants the host's owner or its admins gave them, checked with `permission` on this session. A control
   * plane that predates grants reports none, so only the owner decides host commands there.
   */
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
      // Opening does not resume. Reject hidden pi work before committing any rebinding.
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
        // What the owner allowed for the rest of a session covers that session only; the restored one asks again.
        delete state.grants;
        // The kind of the latest restore: after a conversation-only one its agent is told the files its history mentions
        // may be missing; a full restore brings back the files as they were at that backup, so the note goes.
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

  /**
   * The sandbox, ready for the session. Nothing is pinned or downloaded: a clone session's agent clones what it needs,
   * and a session that pinned its repositories (read-only now) keeps the files it has.
   */
  private async initializeRepositories(): Promise<void> {
    await this.sandbox.initialize();
  }

  /**
   * Makes `preparing` the session's repository preparation: runs wait for it, and once it is done the work it held
   * resumes; a failure leaves it all suspended until the session restarts.
   */
  private trackPreparation(epoch: number, preparing: Extract<RepositoryPreparation, { status: "preparing" }>): void {
    const { done, items } = preparing;
    this.#repositories = preparing;
    done.then(() => {
      if (this.#repositories !== preparing) return;
      this.#repositories = { status: "ready" };
      // What the session is doing follows its preparation (see activity()).
      this.#activity?.changed();
      // If open() is still running it resumes the work itself; otherwise resume it now, in turn with other requests.
      void this.exclusive(async () => {
        if (epoch !== this.#preparations || !this.#opened || this.closing || this.#resumed || this.#repositories.status !== "ready") return;
        await this.resumeWork();
      }).catch(() => {
        // As for a failed open: nothing more runs, and restarting the session tries again.
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

  /**
   * Clones a restored clone session's clones again in the background, through the egress proxy with the owner's access
   * (borrowing from the host's mirror where there is one), and puts their backed-up work back. Runs wait for it, as for
   * prepared repositories. A clone that can't be restored stays pending for the next open, and the agent is told so.
   */
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
            try { reference = await this.mirror(repository, progress); } catch { /* cloned without borrowing */ }
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

  /** Sandbox work outside runs (approved operations, backups) waits for prepared repositories, and never runs after a failure. */
  private requireRepositoriesReady(): void {
    const preparation = this.#repositories;
    if (preparation.status === "preparing") throw new RunnerError(409, "This session's repositories are still being prepared on its host. Try again once they are ready.");
    if (preparation.status === "failed") throw new RunnerError(502, preparationFailure(preparation.reason));
  }

  /** Repository preparation for the session view; absent once it is done, as on hosts without a cache. */
  private repositoryView(): RepositoryPreparationView | undefined {
    const preparation = this.#repositories;
    if (preparation.status === "ready") return undefined;
    return { status: preparation.status, items: preparation.items.map(item => ({ ...item })), ...(preparation.status === "failed" ? { error: preparation.reason } : {}) };
  }

  /** What a sandboxed clone session's agent needs to know about Git LFS, for the repositories the workspace turned it on for. */
  private lfsInstructions(): string {
    if (!this.#lfsRepositories.length) return "";
    const lfs = hostGitLfs();
    if (!lfs) return `\nGit LFS is on for ${this.#lfsRepositories.join(", ")}, but git-lfs is not installed on this host, so clones check out LFS pointer files.`;
    return `\nGit LFS is on for ${this.#lfsRepositories.join(", ")}: clones of them check out LFS files' content. In a clone made otherwise, or restored from a backup, `
      + `run ${lfs} install --local, then ${lfs} pull. Other repositories check out LFS pointer files. `
      + "LFS objects are never uploaded from this session, so don't add or change LFS-tracked files in commits you push.";
  }

  /**
   * `off`: the session's own tools its workspace turned off (sessionToolsOff), which the instructions don't point to;
   * `kindsOff`: the kinds of document source it turned off (documentKindsOff), whose sources they don't list;
   * `extensionTools`: the tools of the workspace's extensions this message runs with (gh, ...).
   */
  private agentInstructions(mode: "write" | "ask" | "read", off: ReadonlySet<string> = new Set(), browserUnavailable?: BrowserUnavailableReason,
    tunnelUnavailable?: TunnelUnavailableReason, kindsOff: ReadonlySet<DocumentKind> = new Set(), extensionTools: ReadonlySet<string> = new Set()): string {
    let instructions = this.binding.agent.instructions;
    if (this.#clone && !this.#egress) {
      // An unsandboxed host: commands run on its owner's machine, with its own Git, network and credentials.
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
    // The tools defined as data the session offers now, each with its paragraph where it has one.
    const defined = this.#definitions.filter(definition => !off.has(definition.name));
    const sources = this.#sources.filter(source => !kindsOff.has(source.kind));
    for (const definition of defined) {
      // A brokered tool's paragraph, where the session's agent has it; `{sources}` lists the workspace's document sources
      // of kinds that are on, and without any the paragraph has nothing to say.
      if (definition.kind !== "brokered" || !definition.instructions || !this.binding.agent.tools.includes(definition.name)) continue;
      if (definition.instructions.includes("{sources}") && !sources.length) continue;
      instructions += `\n\n${definition.instructions.replaceAll("{sources}",
        sources.map(source => `${JSON.stringify(source.title)} (${documentKindNames[source.kind]} ${source.type}, source ${source.id})`).join(", "))}`;
    }
    if (this.#conversationOnlyRestore) instructions += "\n\nThis session was restored from a backup that kept only its conversation: "
      + "the files, clones and uncommitted work its messages from before that restore mention were not restored with it, so they may be "
      + "missing unless they were made again since. Clone the repositories you need again, and check that a file exists before relying on it.";
    // Sessions read and searched code with grep, sed -n and head in a third of their shell commands (#163), each one approved.
    if (this.tools.some(tool => tool.name === "search")) instructions += "\n\nTo find and read code, use search (a regular expression or text across the worktree's files, "
      + "with path, glob and context) and read_file with offset and limit (just the lines around a match) rather than reading whole files: "
      + "they need no approval and their output is already bounded.";
    if (mode !== "ask" && this.tools.some(tool => tool.name === "move_file")) instructions += "\n\nTo move, copy or delete files and directories, "
      + "use move_file, copy_file and delete_file (write_file makes the directories it needs): they need no approval.";
    if (mode !== "ask" && this.tools.some(tool => tool.name === "git") && !off.has("git")) instructions += "\n\nRun Git with the git tool: "
      + "its arguments as a list, with directory naming the clone, such as git {args: [\"clone\", \"https://github.com/<owner>/<name>\"]}, "
      + "git {args: [\"status\"], directory: \"<name>\"} or git {args: [\"commit\", \"-am\", \"Fix the parser\"], directory: \"<name>\"}. "
      + "It needs no quoting, and its approval card shows exactly the Git command it runs.";
    // The program tools' programs the sandbox doesn't find (pnpm without corepack, uv, cargo ...), by tool.
    const missing = mode !== "ask" ? this.missingPrograms(off) : [];
    // A program tool's own paragraph (node's): with the connector's Node.js, the agent learns which it runs, and with which
    // of its package managers (Node.js 25 and newer no longer bundle corepack).
    if (mode !== "ask") for (const definition of defined) {
      if (definition.kind !== "program" || !definition.instructions) continue;
      const absent = missing.find(item => item.tool === definition.name)?.programs ?? [];
      // Where what commands find isn't known (outside the Linux sandbox), only those every Node.js installation has.
      const managers = this.linuxSandbox() ? definition.programs.filter(program => program !== "node" && !absent.includes(program)) : ["npm", "npx"];
      instructions += `\n\n${definition.instructions}`
        + (definition.toolchain === "node" && this.sandbox.nodeBin ? ` It runs Node.js ${process.versions.node} (this host's connector's own)${managers.length
          ? `, with ${managers.length > 1 ? `${managers.slice(0, -1).join(", ")} and ${managers.at(-1)}` : managers[0]}` : ""}, ahead of any other on PATH.` : "");
    }
    if (mode !== "ask" && this.tools.some(tool => tool.name === "python") && !off.has("python")) instructions += "\n\nRun Python, pip, uv, poetry and pytest with the python tool "
      + "(there is no shell). Make a virtual environment, then install into it and run there: python {program: \"python3\", args: [\"-m\", \"venv\", \".venv\"], directory: \"<name>\"}, "
      + "python {program: \"pip\", args: [\"install\", \"-r\", \"requirements.txt\"], directory: \"<name>\", venv: \".venv\"}, python {program: \"pytest\", args: [\"-q\"], directory: \"<name>\", venv: \".venv\"}.";
    // The program tools that share one paragraph (rust, go, dotnet, make), its example of a tool the session has (review of #194).
    const programs = mode !== "ask" ? programToolsInstructions(defined) : undefined;
    if (programs) instructions += `\n\n${programs}`;
    // As for the browser without Chromium: the agent says what the host lacks and how its owner installs it, rather than
    // finding out from "command not found" or fetching toolchains itself.
    const missingText = programsMissingText(Object.fromEntries(missing.map(item => [item.tool, item.programs])));
    if (missingText) instructions += `\n\n${missingText} Calls to them are refused before they run. When a task needs one, use what this session has `
      + "where you can (npx -y pnpm@<version> for a project's pnpm, say, or pytest installed into a virtual environment), and tell the user what the host's owner installs.";
    // Code mode is core (#163): what pipes did between commands, a script does between tools.
    if (mode !== "ask" && this.#builtins) instructions += "\n\nTo chain tools, loop over their results or cut and filter long output, "
      + "write a codemode script that calls them: there is no shell to pipe commands through.";
    // Sessions waited for CI with sleep in a shell, then read the pull request again, in 9% of their shell commands (#163).
    // With the gh tool, they read and wait for checks with gh, sparing the session owner's GitHub rate limit.
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
    // The workspace has the browser on, but this session can't run it: the agent says why rather than guessing.
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

  /** The session's files are packed: only its view, and unpacking it, are served (see createRunnerApp). */
  get packed(): boolean { return this.#packed; }

  async open(): Promise<void> {
    // RunnerService settled the directory (settlePack) before this session opened it.
    this.#packed = await isPacked(this.directory);
    // A packed session runs nothing, so it has no proxy to listen.
    if (!this.#packed) await this.#egress?.start();
    try { await this.openHarness(); }
    catch (error) {
      // A session that didn't open leaves nothing listening.
      await this.#egress?.close().catch(() => {});
      throw error;
    }
  }

  private async openHarness(): Promise<void> {
    // A packed session has no sandbox to prepare, and no clones to restore until it is unpacked.
    if (!this.#packed) await this.initializeRepositories();
    if (this.#packed) {
      // Its view and instructions need nothing of the sandbox.
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
      // A restored or moved session clones its clones again before its work resumes.
      this.#cloneFailures = [];
      // Only a restore writes the list (in the worktree's .git, which shell commands can't change), so a session that
      // has none needs no sandbox to tell.
      if (await lstat(join(this.directory, "sandbox", "git", "pikibun-clones", "manifest.json")).then(() => true, () => false)) {
        const pending = await isolatedWorkspace(this.sandbox).clonePending(async () => {});
        if (pending.length) this.prepareClones(pending);
      }
    }
    const registry = createRegistry();
    // The session's own tools that are code, then those defined as data (as the control plane gives them, or bundled), in
    // one extension, so a call the harness resumes finds its tool.
    const own = this.buildTools();
    this.#definitions = this.usableDefinitions(await this.fetchDefinitions(), own.map(tool => tool.name));
    this.#definedExtensions = [];
    this.tools = [...own, ...this.#definitions.map(definition => this.definedTool(definition))];
    const extension = defineExtension({ name: "workspace-tools", tools: this.tools });
    this.#extension = extension;
    registry.install(extension);
    this.#registry = registry;
    if (!this.#packed) {
      // Installed whether or not the host's configuration turns them on now, so a script it resumes finds its tool.
      this.#builtins = new SessionBuiltins({ outputs: api => this.codemodeOutputs(api) });
      for (const builtin of this.#builtins.extensions.values()) registry.install(builtin);
    }
    if (this.config.extensions && !this.#packed) {
      this.#hostExtensions = new SessionExtensions(this.extensionHost(), this.tools.map(tool => tool.name));
      // Installed before the harness opens, so a call of an extension's tool it resumes finds its tool.
      await this.chosenExtensions().catch(() => []);
    }
    const resolved = this.config.resolveModels ? await this.config.resolveModels(this.binding.model)
      : { models: runnerModels(this.binding.model, this.config.allowFaux), provider: this.binding.model.provider, modelId: this.binding.model.modelId };
    this.modelRef = { provider: resolved.provider, modelId: resolved.modelId };
    this.models = resolved.models;
    const models = this.models;
    // Reasoning models keep more room for their compaction summary than Pi's default, unless the host's Pi or its
    // configuration in Pikibun says otherwise. The configuration is read now and with each message, and the harness reads
    // the settings at each use.
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
      // A new conversation starts at the level the host's Pi gives this model, not pi-durable's "off".
      model: this.modelRef, ...(resolved.thinkingLevel ? { thinkingLevel: resolved.thinkingLevel } : {}), extensions: [extension],
      // Every tool is offered; one the session doesn't allow asks the owner when called (see `permit`).
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
        // The tool call waiting on this card ended with the previous process.
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
    // Recovered and queued work waits for repositories prepared in the background: their preparation resumes it once
    // they are ready, and a failure leaves it all suspended, harness included, until the session restarts. Nothing
    // resumes in a read-only session.
    // A packed session was idle when it was packed, and stays so until it is unpacked and opened again.
    if (this.#repositories.status === "ready" && !this.#frozen && !this.#packed) await this.resumeWork();
    // A read-only session never runs what it had queued or at work when it became read-only: that ends here, as a stop
    // would, so it doesn't stay busy forever.
    if (this.#frozen) {
      await this.mutate(meta => {
        for (const run of Object.values(meta.runs)) if (["queued", "admitting", "running"].includes(run.status)) run.status = "interrupted";
        for (const card of Object.values(meta.approvals)) {
          if (card.status === "pending") Object.assign(card, { status: "interrupted", result: "This session is read-only now; nothing in it runs." });
        }
      });
      await this.sweepInputs();
    }
    // Messages whose screening the previous open didn't finish are screened again (see screen).
    if (!this.#frozen && !this.#packed) {
      for (const run of Object.values((await this.metadata()).runs)) if (run.screening && run.status === "queued") void this.screen(run.key);
    }
    // Reported while its repositories are still being prepared too; reopening is also how a report lost with a previous
    // connection or process gets through.
    this.#activity?.start();
  }

  /** Recovered runs, then the harness and the queue: at most once per open, and only once the repositories are ready. */
  private async resumeWork(): Promise<void> {
    this.#resumed = true;
    const state = await this.metadata();
    for (const run of Object.values(state.runs)) {
      if (run.status !== "running" && run.status !== "admitting") continue;
      try { await this.authorize(run.initiatedBy, run.mode === "ask" ? "ask" : "write"); }
      catch {
        const conversation = await this.harness.conversation(run.conversationId as ConversationId, context);
        // Abort marks are committed before the scheduler can restart stale work.
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
    // A stop the previous open did not finish: its work is aborted before the scheduler can restart it.
    if (Object.values(state.runs).some(run => run.stopped?.pending)) await this.abortStopped();
    // Images of runs that reached Pi, ended or never committed before this open.
    await this.sweepInputs();
    this.harness.resume();
    this.drainQueue();
  }

  private openStorage(): Promise<Storage> {
    return (this.config.openStorage ?? openNodeSqliteStorage)(this.sqlitePath);
  }

  /** Pi closed the Session on a storage failure, or it is being reopened: call `recover()` before using it. */
  get failed(): boolean {
    return this.#failed || this.#recovery !== undefined;
  }

  /**
   * Pi closes a Session for good once a storage call fails, and every later call rejects with `SessionFailed`.
   * Reopen it from the same SQLite file, as Pi recommends. Concurrent callers share one attempt; while storage still
   * fails it throws and the session stays failed, so the next request tries again.
   */
  recover(): Promise<void> {
    this.#recovery ??= this.exclusive(async () => {
      if (!this.#failed) return;
      // Pushes need only the sandbox and the control plane, so they finish and report on their own; aborting them
      // would only make their outcome unknown. Their result cannot be recorded on the failed Session either way, and
      // reopening marks their approvals interrupted.
      await this.close({ abortPushes: false });
      try { await this.open(); }
      catch (error) {
        this.#failed = true;
        throw error;
      }
    }).finally(() => { this.#recovery = undefined; });
    return this.#recovery;
  }

  /** The shared conversation as the metadata names it: its write branch that nothing superseded. */
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
    // Every run and approval status changes here, so this is where the activity can change and waiting calls go on.
    this.#activity?.changed();
    if (committed) this.#waits.settle(committed.approvals);
  }

  /**
   * Holds tool call `waiting` until card `id` settles, and returns it then. A card still undecided at `deadline` (when
   * its message's write admission ends) or when the call stops is marked interrupted, so no card outlives its call.
   */
  private async awaitCard(id: string, waiting: Context, deadline: number): Promise<ApprovalRecord> {
    const waiter = this.#waits.waiter(id);
    const current = (await this.metadata()).approvals[id];
    if (current && answered(current)) {
      this.#waits.forget(id);
      return current;
    }
    // decide() records a decision only on a card still pending, so an interrupted card never runs.
    const interrupt = (result: string) => this.mutate(meta => {
      const pending = meta.approvals[id];
      if (pending?.status === "pending") Object.assign(pending, { status: "interrupted", result });
    });
    // Once decided, the effect settles the card itself, however late.
    const expiry = setTimeout(() => void interrupt("The session owner did not answer within an hour of the message.").catch(() => {}), Math.max(0, deadline - Date.now()));
    expiry.unref();
    try { return await awaitWithContext(waiter.promise, waiting); }
    catch (error) {
      this.#waits.forget(id);
      await interrupt("The tool call stopped before a decision.").catch(() => {});
      throw error;
    } finally { clearTimeout(expiry); }
  }

  /** What an operation a tool call requested came to: the call waits until it is decided and has run. */
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

  /**
   * Reports the branches a clone session on the host has checked out in its clones of the workspace's github.com
   * repositories, when they changed since the last report. A session on the host pushes and opens pull requests with
   * the host's own Git, so this is how the control plane learns which pull requests are its. A report that fails is
   * sent again the next time the agent stops.
   */
  private reportBranches(): void {
    const send = this.config.reportBranches;
    if (!send || !this.#onHost || !this.#clone || this.closing) return;
    if (this.#branchesReporting) { this.#branchesWanted = true; return; }
    this.#branchesReporting = true;
    void (async () => {
      try {
        do {
          this.#branchesWanted = false;
          // A grant that failed when the session opened is asked for again, rather than leaving the session unreported.
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
        // Sent again the next time the agent stops.
        console.warn(`Session ${this.binding.session.id}: could not report its clones' branches: ${error instanceof Error ? error.message : String(error)}`);
      }
      finally { this.#branchesReporting = false; }
    })();
  }

  /** What the agent is doing now (see SessionActivity). */
  private async activity(): Promise<SessionActivity> {
    const preparation = this.#repositories.status;
    // Held work waits for the repositories, and a failed preparation holds it until the session restarts.
    if (preparation !== "ready") return preparation === "preparing" ? "working" : "failed";
    const state = await this.metadata();
    const runs = Object.values(state.runs).filter(tellsActivity);
    const approvals = Object.values(state.approvals);
    const activity = sessionActivity(runs, approvals);
    if (activity !== "done") return activity;
    // A message that settled can still have failed in its last entry, when its model request did.
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
      // Placement is not completion: serialize through the last model/tool task.
      if (generation !== this.generation || this.closing) return;
      void this.#hostExtensions?.agentEnd([], settled.status !== "done").catch(() => {});
      const state = await this.metadata();
      const conversation = await harness.conversation(state.runs[key]!.conversationId as ConversationId, context);
      await conversation?.waitForIdle(context);
      const compaction = settled.status === "unanswered" && settled.reason === "model_error" ? compactionFailure(settled.detail) : undefined;
      const failure: Run["failure"] = settled.status === "unanswered" && (settled.reason === "model_error" || settled.reason === "no_model")
        ? { reason: compaction ? "compaction_failed" : settled.reason, ...(await conversation?.agent(context))?.model, ...(compaction ? { compaction } : {}) } : undefined;
      // Pi ends a run that host crashes cut off again and again rather than crash the host once more; sending it again runs
      // it afresh.
      const crashed = settled.status === "unanswered" && (settled.reason === "restart_limit" || settled.reason === "interrupted");
      await this.exclusive(async () => {
        if (generation !== this.generation || this.closing) return;
        await this.mutate(meta => {
          const run = meta.runs[key]!;
          // A stopped run stays stopped, whatever its aborted submission came to.
          if (run.stopped) return;
          if (crashed) Object.assign(run, { status: "interrupted", crashed: true });
          else run.status = "settled";
          if (failure) run.failure = failure;
        });
      });
      if (generation === this.generation && !this.closing) this.drainQueue();
    })().catch(() => { /* Recovery reconciles the durable active record; never replay effects here. */ });
  }

  private drainQueue(): void {
    // Runs wait for repositories prepared in the background; their preparation drains the queue when it is done.
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
        // The next message waits for extensions' input handlers to screen it, and everything behind it waits too, in order;
        // its screening drains the queue again once it is done (see screen).
        if (!run || run.screening) return;
        try { await this.authorize(run.initiatedBy, run.mode === "ask" ? "ask" : "write"); }
        catch {
          // Its images go first, as in endLostInputs: once the ledger ends the run, nothing of it is left on the host.
          if (run.images) await this.#inputs.discard([run.key]);
          await this.mutate(meta => { meta.runs[run.key]!.status = "interrupted"; });
          continue;
        }
        // What the host's owner requires, once more as the message starts: a tool-call guard among them never drops out
        // between its being accepted and its running.
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
        // Pi's transcript holds its images now.
        if (run.images) await this.#inputs.discard([run.key]);
        this.observeRun(run.key, submission.id);
        return;
      }
    }).catch(() => { /* Admission is durable even when activation fails; restart reconciles it. */ })
      .finally(() => {
        this.draining = false;
        if (this.#drainAgain) { this.#drainAgain = false; this.drainQueue(); }
      });
  }

  /**
   * Applies a run's model, reasoning and access before its input is admitted; the conversation is idle here. A shared
   * run also states its extensions: those that apply to the session now, with their tools, and what their
   * `before_agent_start` handlers add to the system prompt for `content`.
   */
  private async applyOptions(conversation: Conversation, run: Run, content?: string | ({ type: "text"; text: string } | { type: "image"; data: string; mimeType: string })[]): Promise<void> {
    const options = run.options ?? {};
    const access = options.access ?? "approval";
    const extensions = run.mode === "write" ? await this.chosenExtensions().catch(() => []) : [];
    // A tool defined as data that the control plane added since the session opened joins it now, unless one of the
    // workspace's extensions this message runs with already offers that name (review of #205).
    if (run.mode === "write") await this.refreshDefinitions(extensions.flatMap(extension => extension.tools.map(tool => tool.name)));
    // The session's own tools, less those its workspace turned off (Pikibun's session-tool extensions, such as piki:schedule).
    const off = run.mode === "write" ? await this.sessionToolsOff() : new Set<string>();
    // Never an extension's tool named like one of the session's own: its own defined tools included, which may be newer
    // than the names the session's extensions were settled against when it opened.
    const own = new Set(this.tools.map(tool => tool.name));
    const kindsOff = run.mode === "write" ? await this.documentKindsOff() : new Set<DocumentKind>();
    // The browser runs only in the session's sandbox, with the host's Chromium: elsewhere it is never offered, rather than
    // offered to fail. Where the workspace has it on, the agent learns why it has none.
    const browserUnavailable = run.mode === "write" && !off.has("browser") ? this.browserUnavailable() : undefined;
    if (!this.sandbox.browser) off.add("browser");
    // The tunnel likewise: only from the Linux sandbox, with cloudflared on the host.
    const tunnelUnavailable = run.mode === "write" && !off.has("tunnel") ? this.tunnelUnavailable() : undefined;
    if (!this.tunnelOffered()) off.add("tunnel");
    // Pi's built-in ones the host's configuration turns on, after the workspace's, unless one of those replaces them.
    const builtins = run.mode === "write" && this.#builtins
      ? this.#builtins.select((await this.hostConfig()).builtinExtensions, new Set(extensions.flatMap(item => item.tools.map(tool => tool.name)))).map(item => item.extension)
      : [];
    const change: AgentChange = {
      ...(options.model ? { model: { provider: options.model.provider, modelId: options.model.modelId } } : {}),
      ...(options.thinkingLevel ? { thinkingLevel: options.thinkingLevel } : {}),
      // Every shared run states its toolset and instructions, so a read-only request never leaks into the next one. All
      // tools are offered: a call the session doesn't allow asks the owner instead of failing.
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

  /**
   * Notes the model and reasoning level `conversation` runs on now, for the session's extensions. Where it can't be read
   * or has no model, they see the session's own model (`modelRef`) rather than an earlier message's, and the reason is logged.
   */
  private async noteCurrentModel(conversation: Conversation): Promise<void> {
    const agent = await conversation.agent(context).catch(error => {
      process.stderr.write(`Session ${this.binding.session.id}: cannot read the conversation's model for its extensions: ${String(error instanceof Error ? error.message : error).replace(/[\x00-\x1f]/g, " ").slice(0, 500)}\n`);
      return undefined;
    });
    this.#currentModel = agent?.model
      ? { provider: agent.model.provider, modelId: agent.model.modelId, ...(agent.thinkingLevel ? { thinkingLevel: agent.thinkingLevel } : {}) }
      : undefined;
  }

  /**
   * The workspace's extensions this session runs with now (docs/design/host-extensions.md): its enabled ones the host
   * has at that version, then, in the host owner's own sessions, the host's dev extensions.
   */
  private async extensionChoice(): Promise<{ chosen: ChosenExtension[]; automaticTools: boolean; missingRequired: string[]; unknownRequired: boolean }> {
    const config = this.config.extensions;
    if (!config) return { chosen: [], automaticTools: false, missingRequired: [], unknownRequired: false };
    const answer = await config.workspace(this.binding.session.workspaceId).catch(() => ({ extensions: [], automaticTools: false }));
    // Those the host's owner requires, as the connector last heard them; none it can run while it hasn't heard.
    const known = await this.requiredExtensions();
    const required = known ?? [];
    const installed = config.installed().map(item => item.summary);
    return { chosen: sessionExtensions(answer.extensions, installed, { ownerId: this.binding.owner.id, connectorOwnerId: this.binding.session.connectorOwnerId }, required),
      automaticTools: answer.automaticTools, missingRequired: missingRequiredExtensions(required, installed), unknownRequired: !known };
  }

  /**
   * Why this session has no browser, if it hasn't: it runs on its host itself, in a sandbox other than Linux's, or its
   * host's browser is off, missing, downloading or failed to download (HostBrowserSource). A fixed reason: what the host
   * reports of its files stays its owner's.
   */
  private browserUnavailable(): BrowserUnavailableReason | undefined {
    if (this.sandbox.browser) return undefined;
    if (this.#onHost) return "on-host";
    if (this.config.sandboxBackend) return "sandbox";
    // A runner no connector runs knows nothing of the host's browser, and has nobody to set one up: it says nothing.
    const status = this.config.browserStatus?.();
    if (!status) return undefined;
    return browserUnavailableReason(status.state) ?? "missing";
  }

  /**
   * Why this session can't put a server online, if it can't: it runs on its host itself, in a sandbox other than Linux's,
   * or its host's cloudflared is off, missing, downloading or failed to download (HostTunnelSource). A fixed reason, as
   * the browser's. A runner no connector runs has no tunnels and says nothing.
   */
  private tunnelUnavailable(): TunnelUnavailableReason | undefined {
    if (!this.config.tunnels) return undefined;
    if (this.#onHost) return "on-host";
    if (this.config.sandboxBackend || !(this.sandbox instanceof Sandbox)) return "sandbox";
    const status = this.config.tunnels.status();
    return status ? tunnelUnavailableReason(status.state) : "missing";
  }

  /** The session's Linux sandbox, where its commands run in one: they see only the host's /usr and the connector's Node.js. */
  private linuxSandbox(): Sandbox | undefined {
    return !this.#onHost && !this.config.sandboxBackend && this.sandbox instanceof Sandbox ? this.sandbox : undefined;
  }

  /**
   * The programs of this session's program tools (those `off` doesn't name) that its sandbox doesn't find, by tool, each
   * with its extension: only in the Linux sandbox, which sees just the host's /usr and the connector's Node.js, so what
   * it finds is known before a call (program-availability.ts). Elsewhere commands see the host's own PATH: nothing.
   */
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

  /**
   * Why a program tool's call to `program` can't run, if it can't: the Linux sandbox doesn't find it. A python call with
   * a virtual environment is never refused, since its bin may have the program.
   */
  private programMissing(tool: { programs: readonly string[]; path: string | readonly string[]; toolchain?: "node" }, program: string): string | undefined {
    const sandbox = this.linuxSandbox();
    if (!sandbox || !sandboxMissingPrograms({ ...tool, programs: [program] }, sandbox.nodePrograms).length) return undefined;
    return `${program} isn't installed on this host where the session's sandbox sees it, so the call would fail with "command not found". `
      + `The host's owner installs it for the whole system, as the sandbox sees only the host's /usr: ${programInstallStep(program) ?? "the distribution's package"}. `
      + "Tell the user so, and use what this session has meanwhile where you can.";
  }

  /** Whether this session offers the tunnel tool: the connector has tunnels, and nothing stands in the way. */
  private tunnelOffered(): boolean {
    return !!this.config.tunnels && this.tunnelUnavailable() === undefined;
  }

  /** The session's tunnel, made at its first use: its service in the session's Linux sandbox, its tunnel in the connector. */
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
          // Its start was decided as a host command is, which is what lets it run without the limits this host may lack.
          unbounded: true, gpu: config.gpu, socketDirectory: sockets, onOutput, signal });
      },
      // Never the shared directory's path, which the session could point elsewhere: the socket the service bound (pinServiceSocket).
      openTunnel: async signal => tunnels.open(pinServiceSocket(sockets), signal),
      lifetimeMs: async () => (await this.hostConfig()).serviceLifetimeSeconds * 1000,
      report: async item => { await report?.({ sessionId: this.binding.session.id, ...item }); },
      recheck: async actorId => { await this.authorize(actorId, "write"); },
      changed: () => this.#activity?.changed(),
    });
    return this.#tunnel;
  }

  /**
   * The panel's Stop button (`POST /api/sessions/:id/tunnel/stop`), and the control plane archiving the session: takes
   * its server offline. Anyone who may write to the session, as stopping its work.
   */
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

  /**
   * The session's own tools its workspace turned off, by turning off the Pikibun extension that offers them
   * (`sessionToolsOff`). None where the session has no workspace extensions, or can't learn them now: the tools stay on,
   * as they were before they became switchable. A fail-closed one (the shells) also stays off while the last answer this
   * connector read turned it off, however old, so losing the control plane never turns a shell back on.
   */
  /**
   * `off` (sessionToolsOff of the workspace's `extensions`) with the tools defined as data decided by their definitions'
   * extensions, which a newer control plane may name: each is off where none of them is on.
   */
  private definedToolsOff(off: Set<string>, extensions: Parameters<typeof sessionToolsOff>[0]): Set<string> {
    for (const definition of this.#definitions) {
      off.delete(definition.name);
      if (!definition.extensions.some(extension => extensionSwitchOn(extension, extensions))) off.add(definition.name);
    }
    return off;
  }

  private async sessionToolsOff(): Promise<Set<string>> {
    const config = this.config.extensions;
    // Opt-in tools (piki:tunnel) are off unless the workspace's answer turns them on.
    const workspaceId = this.binding.session.workspaceId;
    const answer = config ? await config.workspace(workspaceId).catch(() => undefined) : undefined;
    const extensions = answer?.extensions ?? [];
    const off = this.definedToolsOff(sessionToolsOff(extensions), extensions);
    if (!config) return off;
    const last = config.lastKnown?.(workspaceId);
    if (last) for (const tool of sessionToolsOff(last.extensions, { failClosedOnly: true })) off.add(tool);
    return off;
  }

  /**
   * The kinds of document source the workspace turned off (piki:notion, ...), whose sources source_read neither lists
   * nor reads. None where it can't learn its workspace's choice now, as with `sessionToolsOff`.
   */
  private async documentKindsOff(): Promise<Set<DocumentKind>> {
    const config = this.config.extensions;
    if (!config) return new Set();
    const answer = await config.workspace(this.binding.session.workspaceId).catch(() => undefined);
    return answer ? documentKindsOff(answer.extensions) : new Set();
  }

  /**
   * Refuses a call of `tool` while the workspace has it off. The model isn't offered it then, but a code mode script
   * calls the session's tools by name, so the tool checks too.
   */
  private async requireSessionTool(tool: string): Promise<void> {
    if (!(await this.sessionToolsOff()).has(tool)) return;
    const defined = this.#definitions.find(item => item.name === tool);
    const extensions = defined ? [...defined.extensions] : sessionToolExtensions(tool).map(item => item.source);
    throw new RunnerError(403, `${tool} is turned off in this workspace${extensions.length ? ` (${extensions.join(", ")})` : ""}. Its owners and admins turn it on under Settings → Workspaces → Extensions.`);
  }

  /** The extensions this session runs with now, opened (and installed in the registry) as it first runs with each. */
  private async chosenExtensions(): Promise<SessionExtension[]> {
    const host = this.#hostExtensions;
    const config = this.config.extensions;
    if (!host || !config) return [];
    const { chosen } = await this.extensionChoice();
    await this.openExtensions(chosen.map(item => item.source));
    // Tool name clashes are settled among the extensions this message runs with, in the workspace's order.
    const { selected, created } = host.select(chosen.map(item => item.source));
    for (const extension of created) this.#registry?.install(extension);
    return selected;
  }

  /**
   * Where a code mode call saves its full output: files in the worktree, written as the message's sender, which read_file
   * reads; none in a Read-only message, whose result then says it couldn't be saved.
   */
  private async codemodeOutputs(api: ToolExecutionApi): Promise<OutputFiles | undefined> {
    const attribution = await this.toolActor(api, true);
    const state = await this.metadata();
    const run = state.runs[state.toolActors[String(api.taskId)]!.runKey]!;
    if (run.options?.access === "read") return undefined;
    return { writeFile: (path, content) => this.sandbox.writeFile(path, content, async () => { await this.recheckTool(attribution); }) };
  }

  /** What the session gives its extensions: its worktree, their state and settings, and the gate of their tool calls. */
  private extensionHost(): ExtensionHost {
    return {
      // Extensions run in the runner, on the host: the Linux sandbox's worktree path doesn't exist there.
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
      // A queued message waits for its input handlers (see screen), and the messages behind it with it.
      inputTimeoutMs: 60_000,
      warn: (source, message) => { process.stderr.write(`Session ${this.binding.session.id}, extension ${source}: ${message.replace(/[\x00-\x1f]/g, " ").slice(0, 500)}\n`); },
    };
  }

  /**
   * Where this session runs its Pikibun extensions' commands (docs/design/piki-extensions.md): on the host with the
   * host's own sign-in where the session itself runs on its host, or in the host owner's own sessions where its owner
   * allows that; otherwise in its sandbox, as the session owner, where it has one with an egress proxy.
   */
  private pikiSession(): PikiSession {
    const hostOwner = this.binding.session.connectorOwnerId;
    const ownSession = !!hostOwner && hostOwner === this.binding.owner.id;
    return {
      hostSignIn: this.#onHost || (ownSession && this.config.pikiHostSignIn === true),
      ...(this.#egress && !this.#onHost ? { sandbox: (run: PikiSandboxRun) => this.runPikiCommand(run) } : {}),
    };
  }

  /**
   * A Pikibun extension's command in the sandbox, for a call runExtensionTool admitted. A call a person approved (or the
   * owner's Auto-approve), outside the workspace's read-only setting, gets a write lease from the egress proxy for as
   * long as it runs: its API requests may then write as the session owner, where the control plane gives this host the
   * owner's credential (only the owner's own hosts). Sandbox operations run one at a time, so no other command of the
   * session runs while the lease holds.
   */
  private async runPikiCommand(run: PikiSandboxRun): Promise<CliRun> {
    const call = this.#pikiCalls.get(run.callId);
    if (!call) throw new RunnerError(403, `${run.command} runs only in a call of its tool this session admitted. Nothing ran.`);
    const lease = call.write && !run.readOnly ? this.#egress?.apiLease() : undefined;
    try {
      const env = { ...run.env };
      if (lease) for (const name of run.tokenEnv) env[name] = lease.token;
      const command = sandboxShellCommand(run.command, run.args, env, run.directory);
      // Its call was decided as a host command is (or the host's owner lets the workspace run it automatically), which
      // is what lets a command run without the limits this host may lack.
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

  /**
   * One call of an extension's tool. It runs in the connector, outside the sandbox, so it is decided like a host command
   * (an `extension.tool` card), unless the workspace runs the extension's tools automatically and the host's owner lets
   * workspaces do that; never in a Read-only message. It stops at the host's command time limit.
   */
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
    // A Pikibun extension's command may write as the session owner only where a person decided the call: never where
    // the workspace runs the extension's tools automatically.
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

  /** Validates per-message choices against this host's models and the actor's rights. */
  private async chatOptions(input: unknown, mode: "write" | "ask", actorId: string): Promise<ChatOptions | undefined> {
    if (input === undefined) return undefined;
    // 422 carries this fixed, runner-authored reason through the Worker to the person choosing.
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
        // The host decides availability and authentication; a model it cannot serve is refused here, not mid-run.
        const resolved = await this.config.resolveModels({ ...binding, provider: requested.provider, modelId: requested.modelId })
          .catch(() => { throw invalid("Model is not available on this host"); });
        if (resolved.provider !== requested.provider || resolved.modelId !== requested.modelId) throw invalid("Model is not available on this host");
        // Switching models without naming a level starts at that model's own level on this host.
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
      if (value.access === "auto" && actorId !== this.binding.owner.id) throw new RunnerError(403, "Only the session owner can auto-approve");
      options.access = value.access as ChatOptions["access"];
    }
    // Only an Auto-approve message merges without asking too, as the apps mark each one (see ChatOptions).
    if (value.autoMerge !== undefined) {
      if (typeof value.autoMerge !== "boolean" || (value.autoMerge && options.access !== "auto")) throw invalid("Auto-merge needs Auto-approve");
      if (value.autoMerge) options.autoMerge = true;
    }
    return Object.keys(options).length ? options : undefined;
  }

  /**
   * What the host's owner requires of every session here (HostConfig.requiredExtensions): as the connector last heard it
   * from the control plane, which it keeps through outages (HostConfigSource.required); undefined until it has heard.
   */
  private async requiredExtensions(): Promise<RequiredExtension[] | undefined> {
    if (this.config.requiredExtensions) return this.config.requiredExtensions();
    return (await this.hostConfig()).requiredExtensions;
  }

  /**
   * Why a message can't run with what the host's owner requires now, or undefined when it can: the connector hasn't heard
   * what is required, the host lacks one or can't load it, or (with `open`) the session couldn't open one. A guard the
   * owner counts on never silently drops out.
   */
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

  /**
   * Checks a message against what the host's owner requires before it is accepted, refusing it at once, and says whether
   * extensions' input handlers must screen it first: those of an extension the session runs that handles input.
   */
  private async extensionGate(): Promise<{ screen: boolean }> {
    const config = this.config.extensions;
    if (!this.#hostExtensions || !config) return { screen: false };
    const refusal = await this.requiredRefusal(false);
    if (refusal) throw new RunnerError(422, refusal);
    const { chosen } = await this.extensionChoice();
    const installed = config.installed();
    return { screen: chosen.some(item => installed.some(candidate => candidate.summary.source === item.source && candidate.summary.modules.some(module => module.events.includes("input")))) };
  }

  /**
   * Runs the extensions' `input` handlers on a queued message (SessionExtensions.input): those the host's owner requires
   * first, then the workspace's, in side asks too. They run beside the session's work, never in a request the connector
   * waits on, as an audit asking a model takes seconds and the connector answers one request at a time; the message and
   * everything queued behind it wait for them. What they leave of it is what runs; one that takes it ends it refused, with
   * what it told the sender. A host's crash or restart while they run screens it again when the session opens.
   */
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
      // Stopped, taken back or already started meanwhile: it is no longer this screening's to settle.
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

  /** What the extensions' input handlers make of queued message `key`; `skip` when there is nothing to screen. */
  private async screenInput(key: string): Promise<InputOutcome | { action: "skip" }> {
    const host = this.#hostExtensions;
    const run = (await this.metadata()).runs[key];
    if (!host || !run?.screening || run.status !== "queued") return { action: "skip" };
    const refusal = await this.requiredRefusal(true);
    if (refusal) return { action: "refused", by: "", notice: refusal };
    const images = run.images ? await this.#inputs.read(key) : [];
    // Its images are gone: it never runs, as drainQueue finds (endLostInputs).
    if (!images) return { action: "skip" };
    const { chosen } = await this.extensionChoice();
    const hostOwner = this.binding.session.connectorOwnerId;
    const outcome = await host.input(chosen.map(item => item.source), run.content, images.map(image => ({ type: "image" as const, ...image })),
      hostOwner && run.initiatedBy === hostOwner ? "interactive" : "rpc");
    if (outcome.action !== "refused") return outcome;
    // What it told the sender, as one plain line; or which extension took it.
    const notice = outcome.notice?.replace(/[\x00-\x1f\x7f]+/g, " ").trim().slice(0, 300);
    process.stderr.write(`Session ${this.binding.session.id}: ${outcome.by} refused a message${notice ? `: ${notice}` : ""}\n`);
    return { action: "refused", by: outcome.by, notice: notice || `An extension on this host (${outcome.by}) refused this message.` };
  }

  /** Opens those of `sources` the host has loaded that the session hasn't opened yet, one opening at a time. */
  private openExtensions(sources: readonly string[]): Promise<void> {
    const host = this.#hostExtensions;
    const config = this.config.extensions;
    if (!host || !config) return Promise.resolve();
    const installed = config.installed();
    const open = this.#opening.then(() => host.ensure(sources.flatMap(source => installed.filter(candidate => candidate.summary.source === source))));
    this.#opening = open.catch(() => {});
    return open;
  }

  /** Images go only to a model that takes them; one that doesn't would answer the text without ever seeing them. */
  private async requireImageModel(options: ChatOptions | undefined): Promise<void> {
    const target = options?.model ?? (await this.#shared.agent(context)).model ?? this.modelRef;
    const model = this.models.getModel(target.provider, target.modelId);
    // A model that doesn't say what it takes is left to its provider.
    if (model && Array.isArray(model.input) && !model.input.includes("image")) throw new RunnerError(422, "The model doesn't accept images");
  }

  /**
   * Removes the images of every run that no longer waits to reach Pi, and those a run that never committed left. Called
   * only where no submission can be writing its images: in the session's turn, or while it opens.
   */
  private async sweepInputs(): Promise<void> {
    const runs = (await this.metadata()).runs;
    await this.#inputs.sweep(key => {
      const run = runs[key];
      return run !== undefined && run.submissionId === undefined && ["queued", "admitting", "running"].includes(run.status);
    });
  }

  /**
   * Ends a run whose images are gone or unreadable, saying so in the ledger, after removing whatever is left of them:
   * the ledger ending it is what makes the session idle, so nothing of the run is left on the host by then. A host
   * that stops in between finds the run still queued without its images when it reopens, and ends it here again.
   */
  private async endLostInputs(key: string): Promise<void> {
    await this.#inputs.discard([key]);
    await this.mutate(meta => { Object.assign(meta.runs[key]!, { status: "interrupted", inputsLost: true }); });
  }

  /**
   * What a run gives Pi: its text, then the images it was sent with. Undefined when its images are gone, and the run
   * then ends instead of running its text without them. Text of only whitespace is left out: providers refuse a text
   * block without any.
   */
  private async runInput(run: Run) {
    if (!run.images) return run.content;
    const images = await this.#inputs.read(run.key);
    if (!images) return undefined;
    return [
      ...(run.content.trim() ? [{ type: "text" as const, text: run.content }] : []),
      ...images.map(image => ({ type: "image" as const, data: image.data, mimeType: image.mimeType })),
    ];
  }

  /** A session that pinned its repositories is read-only: nothing new runs, is decided or backed up in it. */
  private requireUnfrozen(): void {
    if (this.#frozen) throw new RunnerError(409, "This session pinned its repositories when it started, which sessions no longer do; it is read-only");
  }

  async submit(ticket: RunnerTicket, input: SubmitInput, mode: "write" | "ask"): Promise<SubmitResult> {
    this.assertTicket(ticket);
    this.requireUnfrozen();
    const parsed: ReturnType<typeof parseChatImages> = input?.images === undefined ? { images: [] } : parseChatImages(input.images);
    if ("error" in parsed) throw new RunnerError(400, "Invalid submission images");
    const images = parsed.images;
    // A message of images alone has no text.
    if (typeof input?.content !== "string" || input.content.length > 100_000 || (!input.content.trim() && !images.length)
      || typeof input.requestId !== "string" || !input.requestId || input.requestId.length > 200) throw new RunnerError(400, "Invalid submission");
    if ((input.admissionId !== undefined && (mode !== "write" || typeof input.admissionId !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(input.admissionId)))
      || (this.config.connectorId && mode === "write" && input.admissionId === undefined))
      throw new RunnerError(400, "Invalid or missing Worker write admission");
    // Decoded and fitted before the session's turn, as that can take a while: what is queued is what the model gets.
    const prepared = images.length ? await prepareMessageImages(images) : [];
    const content = input.content;
    // What the host's owner requires is checked now, and refuses the message at once; extensions' input handlers, which may
    // ask a model for seconds, screen it once it is queued (see screen), never while the connector waits on this request.
    const { screen } = await this.extensionGate();
    return this.exclusive(async () => {
      if (this.closing) throw new RunnerError(503, "Session is closing");
      // Messages queue while repositories are prepared; once that failed, say why instead of queueing forever.
      const preparation = this.#repositories;
      if (preparation.status === "failed") throw new RunnerError(502, preparationFailure(preparation.reason));
      await this.authorize(ticket.actorId, mode === "ask" ? "ask" : "write", ticket.policyVersion);
      // The message compacts its conversation, if it must, by the host's configuration as it is now.
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
      // On disk before the run is committed, so a queued run with images always finds them; a run that never commits
      // leaves them for sweepInputs.
      if (prepared.length) await this.#inputs.write(key, prepared);
      const shared = this.#shared;
      let conversation = shared;
      if (mode === "ask") {
        const transcript = await shared.context(context);
        const head = transcript.entries.at(-1);
        const fork = { ownership: { kind: "ownerless" as const }, agent: {
          // A side ask starts from the shared conversation's current model; its own choices apply when it runs.
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

  /**
   * Stops the session's work: the message running now and every message queued behind it, side asks included. They
   * show as stopped at once; the conversations still working are aborted in the background, and queued work waits
   * until that is done (see abortStopped). A call waiting on a card ends and the card is interrupted; an operation
   * already executing finishes and settles its card, as for any interrupted call. Messages sent afterwards run next.
   */
  async stop(ticket: RunnerTicket): Promise<{ stopped: number }> {
    this.assertTicket(ticket);
    const stopped = await this.exclusive(async () => {
      if (this.closing) throw new RunnerError(503, "Session is closing");
      await this.authorize(ticket.actorId, "write", ticket.policyVersion);
      const runs = Object.values((await this.metadata()).runs).filter(run => ["queued", "admitting", "running"].includes(run.status));
      // A queued message never reached Pi, so there is nothing to abort for it.
      await this.mutate(meta => {
        for (const run of runs) Object.assign(meta.runs[run.key]!, { status: "interrupted", stopped: { by: ticket.actorId, ...(run.status === "queued" ? {} : { pending: true }) } });
        // Cards of the stopped calls end with the stop, so no decision made before the abort lands can still run them.
        const keys = new Set(runs.map(run => run.key));
        for (const [taskId, actor] of Object.entries(meta.toolActors)) {
          if (!keys.has(actor.runKey)) continue;
          for (const card of [meta.approvals[`tool-${taskId}`], meta.approvals[`permission-${taskId}`], meta.approvals[`permission-${taskId}_audience`]]) {
            if (card?.status === "pending") Object.assign(card, { status: "interrupted", result: "The tool call stopped before a decision." });
          }
        }
      });
      // Stopped messages that never reached Pi never will.
      await this.#inputs.discard(runs.filter(run => run.images && run.submissionId === undefined).map(run => run.key));
      return runs;
    });
    if (stopped.some(run => run.status !== "queued")) void this.abortStopped().catch(() => { /* Reopening aborts what is left (see resumeWork). */ });
    // Stopping the session's work takes its server offline too: it was the work's.
    if (this.#tunnel) await this.#tunnel.stop("session-stop", ticket.actorId);
    return { stopped: stopped.length };
  }

  /**
   * Takes back a message of the caller's that is still queued, to edit and send again: it ends without ever reaching Pi,
   * and its text, mode and images come back to its sender. Only its sender takes it back, with the access it was sent
   * with, and only before it starts: the session's turn admits runs, so one it already admitted is refused here.
   */
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
      // Read before the run ends: ending it is what lets sweepInputs remove them.
      const images = run.images ? await this.#inputs.read(key) : undefined;
      await this.mutate(meta => { Object.assign(meta.runs[key]!, { status: "interrupted", withdrawn: true }); });
      if (run.images) await this.#inputs.discard([key]);
      return { content: run.content, mode: run.mode, ...(images?.length ? { images: images as ChatImage[] } : {}),
        ...(run.images && !images?.length ? { imagesLost: true as const } : {}) };
    });
  }

  /** Aborts the conversations of runs whose stop is pending, then lets queued work run again. */
  private async abortStopped(): Promise<void> {
    const generation = this.generation;
    const runs = Object.values((await this.metadata()).runs).filter(run => run.stopped?.pending);
    // Pi withdraws the queued input and aborts every task of the conversation's current work, then waits for it to end.
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
    // Side asks offer only read tools; in shared runs, `permit` decides whether a call needs the owner first.
    if (!run || !["admitting", "running"].includes(run.status) || run.ownerId !== this.binding.owner.id || (write && run.mode !== "write")) throw new RunnerError(403, "Tool has no authorized writable submission");
    await this.authorize(run.initiatedBy, run.mode === "ask" ? "ask" : "write");
    await api.commit(async tx => {
      const current = await tx.doc(RunnerState);
      const meta: Metadata = JSON.parse(current.json);
      // The model's id of the call links its approval card to the transcript entry that made it.
      meta.toolActors[String(api.taskId)] ??= { initiatedBy: run.initiatedBy, ownerId: run.ownerId, runKey: run.key, callId: api.callId };
      current.json = JSON.stringify(meta);
    }, context);
    return { initiatedBy: run.initiatedBy, actingAs: run.ownerId, mode: run.mode };
  }

  private async recheckTool(attribution: { initiatedBy: string; mode: "write" | "ask" }): Promise<void> {
    await this.authorize(attribution.initiatedBy, attribution.mode === "ask" ? "ask" : "write");
  }

  /**
   * A browser call's answer: its card as the other command tools give it, with the driver's report in place of its raw
   * output, and the page's screenshot as an image. A call that didn't run, or whose output isn't a report, answers as
   * bash would.
   */
  private async browserOutcome(approval: ApprovalRecord, recheck: () => Promise<void>, approvalText: (approval: StoredApproval) => ToolExecutionResult): Promise<ToolExecutionResult> {
    const report = approval.status === "executed" && approval.result ? parseBrowserReport(approval.result.trim()) : undefined;
    if (!report) return approvalText(approval as StoredApproval);
    const output: ToolExecutionResult["output"] = [{ type: "text", text: JSON.stringify({ ...approval, result: undefined, admissionId: undefined, callId: undefined, report }) }];
    if (report.screenshot) {
      try {
        const file = await this.sandbox.readContent(report.screenshot, recheck);
        const prepared = "image" in file ? await prepareImage(file.image, file.mimeType) : undefined;
        if (prepared && "image" in prepared) output.push({ type: "image", data: prepared.image.data, mimeType: prepared.image.mimeType });
      } catch { /* The report names the screenshot, which read_file reads. */ }
    }
    return { output };
  }

  /**
   * Whether shell commands may run here: within provisioned limits (Linux --resources, or the Windows sandbox's job
   * objects; macOS has none), on the host itself (an owner-consented unsandboxed host, or the owner's session on a host
   * that accepts it), or as a faux test shell.
   */
  private shellAllowed(): boolean {
    return (!!this.config.resources && !this.config.sandboxBackend) || (!this.#onHost && this.config.sandboxBackend?.kind === "windows") || this.#onHost || (this.binding.model.provider === "faux" && this.config.allowFaux && this.config.allowTestShell === true);
  }

  /**
   * A session started directly on the host runs commands only while the host's configuration still accepts that: its
   * owner turning it off stops the session's next command (within the configuration's 30-second refresh). A member's
   * session also needs their grant to still include sessions on the host, and a command that runs without anyone
   * approving it (`automatic`), automatic host commands too: a grant that ends or shrinks stops their next command.
   */
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

  /** The host's configuration, as Pikibun reports it to the connector; the defaults on a runner without one. */
  private async hostConfig(): Promise<HostConfig> {
    const config = this.config.hostConfig ? await this.config.hostConfig() : { ...defaultHostConfig };
    this.#configuredCompaction = config.compaction;
    return config;
  }

  /** How the next shell command runs, as the host's owner and admins configured it: its time limit and its GPU. */
  private async commandOptions(): Promise<{ limits: CommandLimits; gpu: boolean }> {
    const config = await this.hostConfig();
    return { limits: commandLimits(config.commandTimeoutSeconds), gpu: config.gpu };
  }

  /**
   * `unbounded`: the command may run without the limits this host lacks, as the host's owner allowed for their own
   * session, or a member they granted host commands for theirs (see grantedShell and requireShellGrant).
   */
  private requireShellCapability(operation: Operation, unbounded = false): void {
    if ((operation.kind === "bash" || operation.kind === "program") && !unbounded && !this.shellAllowed()) {
      throw new RunnerError(403, "Production shell requires a quota-backed runner; bash needs verified resources or explicitly enabled faux test sessions");
    }
  }

  /**
   * The session as deciding its operations sees it, by the rule the control plane and the apps apply too (see
   * decidedAsHostCommand and grantedShell).
   */
  private hostCommandSession(): HostCommandSession {
    return { ownerId: this.binding.owner.id, connectorOwnerId: this.binding.session.connectorOwnerId, hostEnvironment: this.#hostSession };
  }

  /**
   * Refuses `actorId`'s decision of `approval` where deciding it takes host command authority on this host (see
   * decidedAsHostCommand) and they don't hold it now.
   */
  private async requireHostDecider(actorId: string, approval: Pick<StoredApproval, "operation" | "unbounded">): Promise<void> {
    if (!decidedAsHostCommand(approval.operation, this.hostCommandSession(), approval.unbounded === true)) return;
    if (await this.hostCommandLevel(actorId, "approve")) return;
    throw new RunnerError(403, approval.operation.kind === "host.bash" ? "Only the host owner, or a member granted host commands on this host, can decide a host command"
      : this.#hostSession ? "This session runs directly on its host: only the host owner, or a member granted host commands on this host, can decide its commands"
      : GRANTED_SHELL_DECIDERS);
  }

  /**
   * Refuses a command without the limits this host lacks, in a session whose owner isn't the host's owner (see
   * grantedShell), unless that owner holds host command authority on this host now: either level for a command someone
   * decides, automatic host commands for one that runs without approval (`automatic`). A grant that ends or shrinks
   * stops their next command.
   */
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

  /**
   * Lets a tool call go ahead, first asking the session owner when the session doesn't allow it yet: a tool outside the
   * agent's, a change in a Read-only message, or a shell command on a host without resource limits. The call waits on
   * the owner's card, which allows it once or for the rest of the session, or denies it. `unbounded`: the command runs
   * without limits, which the host's owner can allow in their own session, and a member they granted host commands in
   * theirs (see grantedShell).
   */
  private async permit(api: ToolExecutionApi, waiting: Context, tool: AnyToolName, target: string, effect: { write?: boolean; shell?: boolean; audience?: boolean } = {}): Promise<{ unbounded: boolean }> {
    const state = await this.metadata();
    const actor = state.toolActors[String(api.taskId)];
    const run = actor && state.runs[actor.runKey];
    if (!run) throw new RunnerError(403, "Tool has no authorized writable submission");
    const grants = state.grants;
    const needs: PermissionNeed[] = [];
    // The sessions tool's second card, once the control plane said what a call it let through would share: the call
    // already has its tool, so that card asks only for this, under an id of its own.
    if (effect.audience) {
      if (!grants?.audience) needs.push("audience");
    } else {
      if (!this.binding.agent.tools.includes(tool) && !(tool !== "host_bash" && grants?.tools.includes(tool))) needs.push("tool");
      if (effect.write && run.options?.access === "read" && !grants?.write) needs.push("write");
    }
    const unbounded = effect.shell === true && !this.shellAllowed();
    if (unbounded) {
      // In another member's session, only while they hold host command authority here, checked before any card asks.
      if (grantedShell(this.hostCommandSession())) await this.requireShellGrant();
      if (!grants?.unboundedShell) needs.push("unbounded-shell");
    }
    if (!needs.length) return { unbounded };
    // The owner's auto-approve access answers these cards for them: they chose to let the agent act without asking.
    // Only the owner can pick it, and a command without limits got this far only on their own host, or with a host
    // command grant there (checked above), which still decides whether it then runs without approval (createApproval).
    if (run.options?.access === "auto" && run.mode === "write" && run.initiatedBy === this.binding.owner.id) return { unbounded };
    if (this.config.connectorId && !run.admissionId) throw new RunnerError(403, "Approval lacks Worker write admission");
    const deadline = (run.submittedAt ?? Date.now()) + DECISION_WAIT_MS;
    if (deadline <= Date.now()) throw new Error("This message is over an hour old, so the session owner can no longer allow this call. Ask them to send a new message.");
    const id = `permission-${api.taskId}${effect.audience ? "_audience" : ""}`;
    // The target only shows the owner what the call touches; keep it within what the control plane accepts.
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

  /** Whether what the owner allowed for the rest of the session covers every need of `request`. */
  private coveredBy(request: PermissionRequest, grants: Grants): boolean {
    return request.needs.every(need => need === "tool" ? this.binding.agent.tools.includes(request.tool) || (request.tool !== "host_bash" && grants.tools.includes(request.tool))
      : need === "write" ? grants.write : need === "audience" ? grants.audience === true : grants.unboundedShell);
  }

  private buildTools(): ToolRegistration[] {
    // Sessions commit and switch branches with Git itself, and push a clone's directory with git_push; on an unsandboxed
    // host they push with Git itself too, with the host's own credentials.
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
    return [
      defineTool({ name: "identity", description: "Return immutable session owner identity and sanitized session environment, not collaborator credentials.", parameters: obj({}, { open: true }), execute: async (_args, api, call) => {
        const attribution = await this.toolActor(api, false);
        await this.permit(api, call, "identity", "");
        const config = await this.hostConfig();
        // How shell commands run here, as the host's owner and admins configured it.
        // On the host itself there is no sandbox to lend the GPU to: commands have it already, with everything else there.
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
      // Writes run one at a time: a round with a write is sequential, so an edit never reads a file another call changes.
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
      // Moving, copying and deleting as mv, cp and rm did in the retired shell (#163): writes like write_file, one at a time.
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
      // Git without a shell (piki:git, #163): its call becomes one sandboxed command, `git` and its quoted arguments, decided
      // as bash's are; Git's configuration in a clone, which the agent can write, can run programs, so no call skips that.
      defineTool({ name: "git", description: `Run Git in the session worktree without a shell: args is its arguments as a list, starting with the subcommand (${gitSubcommands.join(", ")}), such as ["commit", "-m", "Fix the parser"]; directory is where it runs, a clone such as app (the worktree by default). Git's own options before the subcommand (-C, -c) and options that run other programs (rebase --exec, clone --upload-pack or --config, --template) aren't taken. It runs with no pager, editor or password prompt. It waits for an exact human approval unless the owner enabled auto-approve for this request, and stops at the host's command time limit.`,
        executionMode: "sequential",
        parameters: obj({ args: arr(str(), { minItems: 1, maxItems: gitLimits.arguments }), directory: opt(str()) }, { open: true }),
        execute: async (args, api, call) => {
          // Before anything is recorded for the call: one the workspace turned off, or refused, leaves nothing behind.
          await this.requireSessionTool("git");
          let request: GitRequest;
          let command: string;
          try { request = gitRequest(args); command = gitShellCommand(request); }
          catch (error) { throw new RunnerError(400, `${error instanceof Error ? error.message : "Invalid git call"}. Nothing ran.`); }
          const attribution = await this.toolActor(api, true);
          await this.requireHostEnvironment();
          const { unbounded } = await this.permit(api, call, "git", `${request.directory}: git ${request.args.join(" ")}`.slice(0, 8192), { write: true, shell: true });
          return approvalText(await this.operationOutcome(await this.createApproval(attribution.initiatedBy, { kind: "program", tool: "git", command }, String(api.taskId), { permitted: true, unbounded }, call.abortSignal), call));
        } }),
      // Node.js, Rust, Go, .NET and make are tools defined as data (definedTool), as source_read is.
      // Python and its package and test tools without a shell (piki:python, #163), decided as bash's are, like node's.
      // Not in the Windows sandbox, whose container reaches no Python yet (review of #186).
      ...(process.platform === "win32" && this.sandbox.isolated ? [] : [defineTool({ name: "python", description: `Run Python or its package and test tools in the session worktree without a shell: program is one of ${pythonPrograms.join(", ")}; args is its arguments as a list, such as ["-m", "venv", ".venv"], ["install", "-r", "requirements.txt"] or ["-m", "pytest", "-q"]; directory is where it runs, such as the clone app (the worktree by default); venv names a virtual environment there, such as .venv, whose python3, pip and pytest it runs instead of the host's (make one with python3 -m venv .venv first; the host's own Python can't be installed into; if that fails for want of ensurepip, the host lacks python3-venv, which its owner installs). In the Linux sandbox, uv, uvx, poetry and pytest outside a virtual environment are there only where the host installed them for the whole system: a call to one it lacks is refused, saying how the host's owner installs it. It runs with no colours or prompts; commands that act on a package index as an account (uv publish, uv auth, poetry publish, twine upload, poetry config of credentials) aren't taken. It waits for an exact human approval unless the owner enabled auto-approve for this request, and stops at the host's command time limit.`,
        executionMode: "sequential",
        parameters: obj({ program: StringEnum(pythonPrograms), args: opt(arr(str(), { maxItems: programLimits.arguments })), directory: opt(str()),
          venv: opt(str()) }, { open: true }),
        execute: async (args, api, call) => {
          // Before anything is recorded for the call: one the workspace turned off, or refused, leaves nothing behind.
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
          return approvalText(await this.operationOutcome(await this.createApproval(attribution.initiatedBy, { kind: "program", tool: "python", command }, String(api.taskId), { permitted: true, unbounded }, call.abortSignal), call));
        } })]),
      // A headless Chromium in the session's sandbox (piki:browser): one sandboxed command per call, a program operation of
      // its own decided as the other program tools' are, since pages run their scripts, evaluate runs the agent's, and serve
      // starts the app under test. Offered only in the Linux sandbox, with a Chromium: never on the host itself.
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
          // Before anything is recorded for the call: one the workspace turned off, or refused, leaves nothing behind.
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
      // The session's server, online through a Cloudflare quick tunnel (piki:tunnel): a session service in its Linux
      // sandbox, and cloudflared in the connector, on the host. Each start puts something online from the host's network,
      // so it is an extension tool card, decided as a host command is and never run automatically; status and stop ask nothing.
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
          // Before anything is recorded for the call: one the workspace turned off (or never turned on) leaves nothing behind.
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
            // Taking it offline is never refused: it only ever narrows what the session exposes.
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
        // The control plane reads only within a message's write admission.
        if (!run.admissionId) throw new RunnerError(403, "GitHub reads need a write message");
        const request: GitHubReadRequest = { sessionId: this.binding.session.id, actorId: run.initiatedBy, admissionId: run.admissionId, callId: String(api.taskId), repository, issue: args.issue };
        const read = async () => {
          await this.authorize(run.initiatedBy, "write");
          return this.config.githubRead ? await this.config.githubRead(request) : await this.internalGitHub("read", request) as GitHubIssueView;
        };
        const first = await read();
        if (!args.wait) return text({ ...attribution, ...first });
        // A series of reads of the same call, each checked and audited by the control plane as the first was. The last
        // read stands if one fails (its message's hour ran out, say); stopping the message stops the wait.
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
      defineTool({ name: "schedule", description: "Manage this session's scheduled prompts: messages Pikibun sends this session's agent on a cron schedule, as the session owner, so the session wakes up and works on its own (a nightly check, a weekly report). Use it when the user asks to do something every hour, day or week, or at a later time. action list takes nothing; create takes message (what the agent is told each time) and cron (five fields: minute hour day-of-month month day-of-week, such as '0 9 * * 1-5'; runs at least 5 minutes apart), and optionally name, time_zone (IANA, such as Europe/Berlin; UTC otherwise, so ask the user for theirs when the time of day matters), access (approval, the default: commands wait for a human; read; auto, only in a message the owner sent with auto-approve) and enabled; update takes id and only the fields to change (an auto-approved schedule is changed, other than paused or lowered in access, only in a message the owner sent with auto-approve); delete takes id. Only the session owner's messages can use it. A run due while the agent is busy is skipped. The owner sees and edits them in the session panel's Schedules tab.", parameters: obj({
        action: StringEnum(scheduleToolActions), id: opt(str()), message: opt(str()), cron: opt(str()),
        time_zone: opt(str()), name: opt(str()), access: opt(StringEnum(accessModes)), enabled: opt(bool()),
      }, { open: true }), execute: async (args, api, call) => {
        await this.requireSessionTool("schedule");
        const attribution = await this.toolActor(api, true);
        const fields = Object.fromEntries(Object.entries({ scheduleId: args.id, name: args.name, cron: args.cron, timeZone: args.time_zone, content: args.message,
          access: args.access, enabled: args.enabled }).filter(([, value]) => value !== undefined)) as Omit<ScheduleToolRequest, "sessionId" | "actorId" | "admissionId" | "callId" | "action">;
        if (Object.values(fields).some(value => typeof value === "string" && value.includes("\0"))) throw new RunnerError(400, "Schedule fields must not contain NUL characters");
        const state = await this.metadata();
        const run = state.runs[state.toolActors[String(api.taskId)]!.runKey]!;
        // A schedule runs as the session owner, with nobody watching: only the owner's own messages make one, and only a
        // message with their Auto-approve an auto-approved one (the control plane checks both, and changes to one).
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
        // One call at a time: each counts against its message's sends and its session's new sessions.
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
        // What it sends elsewhere never has more access than this message (the control plane checks this too).
        if (args.access === "auto" && (run.options?.access !== "auto" || run.initiatedBy !== this.binding.owner.id)) {
          throw new RunnerError(403, "Only a message the session owner sent with auto-approve sends an auto-approved message. Use access approval, which leaves the other session's commands to its people.");
        }
        // A wait is a series of reads of one message, and its card shows it as that read.
        const request = { action: wait ? "read" as const : args.action as Exclude<typeof args.action, "wait">, ...(wait ? { targetSessionId: fields.targetSessionId, messageId: fields.messageId, limit: 1 } : fields) };
        await this.permit(api, call, "sessions", sessionsToolTarget(request), { write: sessionsWriteActions.includes(args.action) });
        await this.authorize(run.initiatedBy, "write");
        const base = { sessionId: this.binding.session.id, actorId: run.initiatedBy, admissionId: run.admissionId, callId: String(api.taskId) };
        const broker = async (): Promise<SessionsToolResult> => {
          const result = this.config.crossSessions ? await this.config.crossSessions({ ...base, ...request }) : await this.internalBroker("sessions", { ...base, ...request }) as SessionsToolResult;
          if (!("consent" in result)) return result;
          // The other session's readers aren't this one's: the owner decides, on a card naming that session, and the
          // control plane then sees their decision for this call.
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

  /** Tracked through shutdown, and never replayed after an ambiguous failure. */
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
        // Run under the owner's Auto-approve (an admission), it needs their automatic host commands; otherwise the
        // approver's authority to decide host commands, either one still held now.
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
    })().catch(() => { /* Durable executing records become interrupted on reopen. */ }).finally(() => {
      this.pushes.delete(entry);
      if (generation === this.generation && !this.closing) this.drainQueue();
    });
    this.pushes.add(entry);
    return entry.done;
  }

  /** Definitions already noted in the host's log, so a message notes each once. */
  readonly #definitionNotes = new Set<string>();

  private noteDefinition(name: string, what: string): void {
    const note = `${name} ${what}`;
    if (this.#definitionNotes.has(note)) return;
    this.#definitionNotes.add(note);
    process.stderr.write(`Session ${this.binding.session.id}: the tool definition ${note}.\n`);
  }

  /** The tools defined as data, as the control plane gives them (through the connector), or this version's bundled ones. */
  private async fetchDefinitions(): Promise<readonly ToolDefinition[]> {
    const fetched = this.config.toolDefinitions ? await this.config.toolDefinitions().catch(() => undefined) : undefined;
    // Their program tools' operations are this connector's to validate from now on (validateOperation).
    if (fetched) rememberToolDefinitions(fetched);
    return fetched ?? bundledToolDefinitions;
  }

  /**
   * Those of `definitions` this session can offer: never one named like a tool of its own (`own`), and no program tool
   * the Windows sandbox can't run there.
   */
  private usableDefinitions(definitions: readonly ToolDefinition[], own: readonly string[]): ToolDefinition[] {
    const windows = process.platform === "win32" && this.sandbox.isolated;
    const taken = new Set(own);
    return definitions.filter(definition => {
      if (taken.has(definition.name) || (definition.kind === "program" && windows && !definition.windowsSandbox)) return false;
      taken.add(definition.name);
      return true;
    });
  }

  /**
   * Adds the tools the control plane defined since the session opened, by new names, as one more extension in the
   * registry, so a message can use them at once. A changed definition of a tool it has applies when it next opens.
   */
  private async refreshDefinitions(extensionTools: readonly string[] = []): Promise<void> {
    if (!this.config.toolDefinitions || !this.#registry) return;
    const fetched = await this.fetchDefinitions();
    // Said in the host's log, as the session goes on with what it has: a definition that changed since it opened, and a
    // new name an extension of the workspace already offers, which keeps it as an extension's tool (review of #205).
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
    // Its names are the session's own from now on, as those it opened with: an extension of the workspace that offers one
    // later (turned on since, say) is left without it, as at open, rather than running in its place (review of #205).
    this.#hostExtensions?.reserve(added.map(definition => definition.name));
  }

  /**
   * A tool defined as data (tool-definitions.ts), run by this session's engine. A program tool's call is one program
   * operation, refused first where its definition's grammar finds a command it refuses, then decided as commands are.
   * A brokered tool's arguments are checked against its parameters, its permission is the target they make, and the
   * call goes to the control plane's route within the message's write admission, which decides and does the rest.
   */
  private definedTool(definition: ToolDefinition): ToolRegistration {
    const text = (value: unknown) => ({ output: [{ type: "text" as const, text: typeof value === "string" ? value : JSON.stringify(value) }] });
    if (definition.kind === "program") {
      return defineTool({ name: definition.name, description: definition.description, executionMode: "sequential",
        parameters: obj({ program: StringEnum([...definition.programs]), args: opt(arr(str(), { maxItems: programLimits.arguments })), directory: opt(str()) }, { open: true }),
        execute: async (args, api, call) => {
          // Before anything is recorded for the call: one the workspace turned off, or refused, leaves nothing behind.
          await this.requireSessionTool(definition.name);
          let request: ProgramRequest;
          let command: string;
          try { request = programRequest(definition, args); command = programCommand(definition, request, this.sandbox.nodeBin ? { nodeBin: this.sandbox.nodeBin } : {}); }
          catch (error) { throw new RunnerError(400, `${error instanceof Error ? error.message : `Invalid ${definition.name} call`}. Nothing ran.`); }
          // A program the sandbox doesn't have fails anyway: refused before anyone is asked to approve it.
          const missing = this.programMissing(definition, request.program);
          if (missing) throw new RunnerError(400, `${missing} Nothing ran.`);
          const attribution = await this.toolActor(api, true);
          await this.requireHostEnvironment();
          const { unbounded } = await this.permit(api, call, definition.name, `${request.directory}: ${request.program} ${request.args.join(" ")}`.slice(0, 8192), { write: true, shell: true });
          const approval = await this.operationOutcome(await this.createApproval(attribution.initiatedBy, { kind: "program", tool: definition.name, command }, String(api.taskId),
            { permitted: true, unbounded }, call.abortSignal), call);
          return text({ ...approval, admissionId: undefined, callId: undefined });
        } });
    }
    const parameters = Object.fromEntries(Object.entries(definition.parameters).map(([name, parameter]) => {
      const options = parameter.description ? { description: parameter.description } : {};
      const schema = parameter.type === "boolean" ? bool(options)
        : parameter.type === "integer" ? int({ ...options, ...(parameter.minimum !== undefined ? { minimum: parameter.minimum } : {}), ...(parameter.maximum !== undefined ? { maximum: parameter.maximum } : {}) })
        : parameter.enum ? StringEnum([...parameter.enum], options) : str(options);
      return [name, parameter.required ? schema : opt(schema)];
    }));
    // Open, as the session's own tools are: the arguments are checked against the definition (brokeredArguments).
    return defineTool({ name: definition.name, description: definition.description, parameters: obj(parameters, { open: true }),
      execute: async (input, api, call) => {
        await this.requireSessionTool(definition.name);
        const attribution = await this.toolActor(api, definition.write);
        let args: Record<string, unknown>;
        try { args = brokeredArguments(definition, input as Record<string, unknown>); }
        catch (error) { throw new RunnerError(400, error instanceof Error ? error.message : `Invalid ${definition.name} call`); }
        // The same target the control plane checks a one-call permission against.
        await this.permit(api, call, definition.name, brokeredTarget(definition, args), definition.write ? { write: true } : {});
        const state = await this.metadata();
        const run = state.runs[state.toolActors[String(api.taskId)]!.runKey]!;
        // The control plane acts only within a message's write admission.
        if (!run.admissionId) throw new RunnerError(403, `${definition.name} needs a write message`);
        const request = { sessionId: this.binding.session.id, actorId: run.initiatedBy, admissionId: run.admissionId, callId: String(api.taskId), ...args };
        await this.authorize(run.initiatedBy, "write");
        const result = this.config.brokered ? await this.config.brokered(definition.route, request) : await this.internalBroker(definition.route, request);
        return text({ ...attribution, ...(result && typeof result === "object" && !Array.isArray(result) ? result : { result }) });
      } });
  }

  /**
   * An approved shell command, run in the background for as long as the host's time limit allows and tracked through
   * shutdown like host commands: closing the session stops it. A refusal or a non-zero exit is a definite outcome the
   * agent can act on; anything else may have had partial effects.
   */
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
    })().catch(() => { /* Durable executing records become interrupted on reopen. */ }).finally(() => {
      this.pushes.delete(entry);
      if (generation === this.generation && !this.closing) this.drainQueue();
    });
    this.pushes.add(entry);
    return entry.done;
  }

  /** A github.com owner/name: a session reads and merges in any github.com repository of its workspace, as the control plane checks. */
  private githubRepository(name: string): string {
    if (!/^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9_.-]{1,100}$/.test(name)) throw new RunnerError(400, "repository must be a github.com owner/name");
    return name;
  }

  /**
   * Posts the comment, merges or opens the issue through the control plane's broker, authorized by a human approval's
   * capability or the owner's Auto-approve admission, and says what happened.
   */
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

  /** The control plane's GitHub broker for runners without a connector, with the shared secret; refusals keep their status and reason. */
  private async internalGitHub(action: "comment" | "read" | "merge" | "issue", request: object): Promise<unknown> {
    return this.internalBroker(`github/${action}`, request);
  }

  /**
   * One of the control plane's internal broker routes, as internalGitHub: Pikibun's own, or a brokered tool's
   * (tool-definitions.ts), which its definition names.
   */
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

  /**
   * `consent.permitted`: a tool call `permit` already let through. `consent.unbounded`: this command may run without the
   * resource limits this host lacks, as the host's owner allowed in their own session, or on the strength of a host
   * command grant in a member's (see grantedShell).
   */
  /**
   * `consent.automatic`: an extension's tool call that runs without approval, as its workspace set it and its host's
   * owner allows (see runExtensionTool).
   */
  async createApproval(actorId: string, input: Operation, toolTaskId?: string, consent: { permitted?: boolean; unbounded?: boolean; automatic?: boolean } = {}, signal?: AbortSignal): Promise<ApprovalRecord> {
    this.requireUnfrozen();
    const operation = validateOperation(input);
    if (operation.kind === "permission") throw new RunnerError(400, "Permission requests come only from tool calls");
    // Sessions commit and switch branches with Git itself, and push a clone's directory.
    if (operation.kind === "git.commit" || operation.kind === "git.repin" || (operation.kind === "git.push" && operation.directory === undefined)) {
      throw new RunnerError(400, "Commit and switch branches with the git tool; a push names a clone's directory");
    }
    // host_bash is retired (#163): nothing asks to run a command on the host any more. A restart already ended the
    // host commands that were waiting, so none is left to decide.
    if (operation.kind === "host.bash") throw new RunnerError(400, "Commands on the host were removed with host_bash; run programs with the git, node and python tools");
    this.requireShellCapability(operation, consent.unbounded);
    if (operation.kind === "extension.tool" && (!this.config.connectorId || !this.binding.session.connectorOwnerId)) {
      throw new RunnerError(403, "Host commands require a connected host with a known owner");
    }
    // Only the session's own extension tools ask for these, each from its call.
    if (operation.kind === "extension.tool" && (!consent.permitted || toolTaskId === undefined)) throw new RunnerError(400, "Extension tool calls come only from their tools");
    if (operation.kind === "git.push" && !this.#clone) throw new RunnerError(400, "Only clone sessions push a clone's directory");
    // On a host without the sandbox the agent pushes with the host's own Git: an approved push would only fail.
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
    if (toolTaskId !== undefined) {
      const state = await this.metadata();
      const attribution = state.toolActors[toolTaskId];
      callId = attribution?.callId;
      const run = attribution && state.runs[attribution.runKey];
      if (!run || run.initiatedBy !== actorId || run.ownerId !== this.binding.owner.id || run.mode !== "write"
        || !["admitting", "running"].includes(run.status)) throw new RunnerError(403, "Approval has no active originating write");
      admissionId = run.admissionId;
      if (this.config.connectorId && !admissionId) throw new RunnerError(403, "Approval lacks Worker write admission");
      // Automatic pushes and GitHub effects are authorized by the control plane from the run's owner admission, so they
      // need one. GitHub comments, issues and merges run automatically only under the owner's Auto-approve itself, never
      // a session grant, and merges only in a message marked `autoMerge`, as the apps mark Auto-approve messages: the
      // control plane refuses an automatic merge of any other, even in a session's view.
      // A tool the owner allowed for the rest of the session runs their calls of it as Auto-approve would; host commands
      // never take a session grant, so each one still asks unless the owner holds automatic host commands on this host.
      const github = operation.kind === "github.comment" || operation.kind === "github.merge" || operation.kind === "github.issue";
      const sessionGranted = toolName !== undefined && !github
        && state.grants?.tools.includes(toolName) === true;
      automatic = (run.options?.access === "auto" || sessionGranted) && run.initiatedBy === this.binding.owner.id
        && (!github || (admissionId !== undefined && (operation.kind !== "github.merge" || run.options?.autoMerge === true)))
        && (operation.kind !== "git.push" || admissionId !== undefined)
        // An operation decided as a host command is (host_bash, a command of a session on its host, or one without the
        // host's missing limits in a member's session) runs without approval only for an owner who holds automatic host
        // commands on this host.
        && (!decidedAsHostCommand(operation, this.hostCommandSession(), consent.unbounded === true)
          || await this.hostCommandLevel(this.binding.owner.id, "write") === "auto");
      // An extension's tools the workspace runs automatically, where the host's owner lets it, run for every message.
      if (operation.kind === "extension.tool" && consent.automatic === true) automatic = true;
      // Putting a server online (piki:tunnel) is always a person's decision: never under Auto-approve, automatic host
      // commands or a workspace's automatic extension tools.
      if (operation.kind === "extension.tool" && operation.source === "piki:tunnel") automatic = false;
      // Another member's sandboxed command, push, or GitHub comment or issue (requesterAutoApproves) runs without asking
      // while the session's owner auto-approves their requests, as the control plane reports it now; its brokers check
      // that again, with the message's admission, before a push or GitHub effect.
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
    // The tool call waits on its card: registered first, so a decision never finds the card without its call.
    if (toolTaskId !== undefined && !automatic) this.#waits.waiter(id);
    try { await this.mutate(meta => { if (!meta.approvals[id]) { meta.approvals[id] = approval; created = true; } }); }
    catch (error) {
      this.#waits.forget(id);
      throw error;
    }
    // A replayed tool task finds its record and never repeats the effect; reopening marks interrupted executions.
    // `signal`: the tool call's, so stopping its message stops a long command it runs.
    if (automatic && created) return this.executeAutomatically(id, actorId, signal);
    return (await this.metadata()).approvals[id]!;
  }

  private async executeAutomatically(id: string, actorId: string, signal?: AbortSignal): Promise<ApprovalRecord> {
    const approval = (await this.metadata()).approvals[id]!;
    const operation = approval.operation;
    let status: ApprovalRecord["status"];
    let result: string;
    // Its tool call runs it (runExtensionTool), with the call's own signal and output.
    if (operation.kind === "extension.tool") return approval;
    if (operation.kind === "host.bash") {
      await this.startHostOperation(id, operation, { actorId, admissionId: approval.admissionId }, async () => { await this.authorize(actorId, "write"); });
      return (await this.metadata()).approvals[id]!;
    }
    if (operation.kind === "github.comment" || operation.kind === "github.merge" || operation.kind === "github.issue") {
      // Under the owner's Auto-approve the control plane authorizes the effect from the run's admission and consumes the
      // call's one attempt, so a replay never repeats it.
      try {
        await this.authorize(actorId, "write");
        result = await this.githubEffect(operation, { sessionId: this.binding.session.id, actorId, approvalId: id, admissionId: approval.admissionId! });
        status = "executed";
      } catch (error) {
        // GitHub said why it didn't merge or open the issue: nothing changed, so the agent can act on the reason.
        if (error instanceof RunnerError && error.status === 422 && operation.kind !== "github.comment") { status = "failed"; result = error.message; }
        else { status = "interrupted"; result = "Effect failed or outcome is ambiguous. Inspect external state; automatic retry is prohibited."; }
      }
      await this.mutate(meta => { Object.assign(meta.approvals[id]!, { status, result: this.#waits.kept(id, result) }); });
      return (await this.metadata()).approvals[id]!;
    }
    if (operation.kind === "git.push") {
      // Tracked like approved pushes so close() aborts it and awaits its settlement before the harness closes.
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
        // Another member's command runs only while the session's owner still auto-approves their requests.
        if (actorId !== this.binding.owner.id) {
          if ((await this.authorize(actorId, "write", undefined, false, false, false, true)).autoApprove !== true) {
            throw new RunnerError(403, "The session owner no longer auto-approves this member's requests: commands need approval. Nothing ran.");
          }
        } else await this.authorize(actorId, "write");
      }, { allowTestShell: this.binding.model.provider === "faux" && this.config.allowFaux && this.config.allowTestShell === true, unbounded: approval.unbounded === true,
        ...await this.commandOptions(), signal });
      status = "executed";
    } catch (error) {
      // A non-zero exit is a definite outcome the agent can act on; anything else may have had partial effects.
      if (error instanceof SandboxProcessError) { status = "failed"; result = `${error.message}${error.stdout ? `\n${error.stdout}` : ""}`; }
      else { status = "interrupted"; result = "Effect failed or outcome is ambiguous. Inspect external state; automatic retry is prohibited."; }
    }
    await this.mutate(meta => { Object.assign(meta.approvals[id]!, { status, result: this.#waits.kept(id, result) }); });
    return (await this.metadata()).approvals[id]!;
  }

  /**
   * The permission `actorId` needs on the session to decide an approval of `operation`: approve, except that the host's
   * owner decides its host commands (host_bash), which run as the host's OS user, with any access to the session.
   * Whether they may decide host commands at all is checked with the card (see hostCommandLevel).
   */
  private decisionPermission(actorId: string, operation: Pick<Operation, "kind"> | undefined): Permission {
    const hostOwner = this.binding.session.connectorOwnerId;
    return (operation?.kind === "host.bash" || operation?.kind === "extension.tool") && !!hostOwner && actorId === hostOwner ? "read" : "approve";
  }

  /** `scope` applies to permission requests: allow the one call (default), or the same need for the rest of the session. */
  async decide(ticket: RunnerTicket, id: string, input: { decision: "approve" | "deny"; operation: Operation; brokerCapability?: string; scope?: "call" | "session" }): Promise<ApprovalRecord> {
    this.requireUnfrozen();
    this.assertTicket(ticket);
    if (input.decision !== "approve" && input.decision !== "deny") throw new RunnerError(400, "Invalid approval decision");
    if (input.scope !== undefined && input.scope !== "call" && input.scope !== "session") throw new RunnerError(400, "Invalid approval scope");
    return this.exclusive(async () => {
      // The operation the caller names must be the card's (checked below), so it says what deciding it needs.
      const permission = this.decisionPermission(ticket.actorId, input.operation);
      await this.authorize(ticket.actorId, permission, ticket.policyVersion);
      const state = await this.metadata();
      const approval = state.approvals[id];
      if (!approval) throw new RunnerError(404, "Approval not found");
      if (stableJson(validateOperation(input.operation)) !== stableJson(approval.operation)) throw new RunnerError(409, "Approval operation mismatch");
      const decided = () => new RunnerError(409, "Approval has already been decided; unsafe effects are never retried");
      if (approval.status !== "pending") throw decided();
      // Its tool call may stop meanwhile and interrupt the card, so each decision is recorded only on a card still pending.
      const record = (meta: Metadata, decision: Partial<ApprovalRecord>) => {
        const card = meta.approvals[id]!;
        if (card.status !== "pending") throw decided();
        Object.assign(card, decision);
      };
      // Host commands, the commands of a session that runs directly on the host, and those that run without the host's
      // missing limits in a member's session, on the strength of their grant, take host command authority to decide.
      await this.requireHostDecider(ticket.actorId, approval);
      const granted = (approval.operation.kind === "bash" || approval.operation.kind === "program") && approval.unbounded === true && grantedShell(this.hostCommandSession());
      if (approval.operation.kind === "git.repin" && ticket.actorId !== this.binding.owner.id) {
        throw new RunnerError(403, "Only the session owner can decide a repin");
      }
      // A tool call is waiting on this request inside a running turn, so it is decided at once rather than after the queue.
      if (approval.operation.kind === "permission") {
        const request = approval.operation;
        if (ticket.actorId !== this.binding.owner.id) throw new RunnerError(403, "Only the session owner can allow more than the session allows");
        // On someone else's host, only with host command authority there (see grantedShell).
        if (request.needs.includes("unbounded-shell") && grantedShell(this.hostCommandSession()) && !await this.hostCommandLevel(ticket.actorId, "approve")) {
          throw new RunnerError(403, "Only the host's owner, or a member granted host commands on this host, can allow a shell without resource limits");
        }
        const scope = input.scope ?? "call";
        // Each host command runs outside the sandbox, so its permission covers that one call only.
        if (scope === "session" && request.tool === "host_bash") throw new RunnerError(400, "Host commands can only be allowed once");
        await this.mutate(meta => {
          record(meta, input.decision === "approve" ? { status: "approved", decidedBy: ticket.actorId, scope } : { status: "denied", decidedBy: ticket.actorId });
          if (input.decision !== "approve" || scope !== "session") return;
          const grants = meta.grants ??= { tools: [], write: false, unboundedShell: false };
          if (request.needs.includes("tool") && !grants.tools.includes(request.tool)) grants.tools.push(request.tool);
          if (request.needs.includes("write")) grants.write = true;
          if (request.needs.includes("unbounded-shell")) grants.unboundedShell = true;
          if (request.needs.includes("audience")) grants.audience = true;
          // Parallel calls of the same round that wait on what the session now allows go ahead too.
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
      // An extension's tool call waits on its card and runs once it is approved (runExtensionTool).
      if (approval.operation.kind === "extension.tool") {
        await this.authorize(approval.requestedBy, "write");
        await this.mutate(meta => { record(meta, { status: "approved", decidedBy: ticket.actorId }); });
        return (await this.metadata()).approvals[id]!;
      }
      // Approved operations run in the sandbox, so they wait for the repositories like runs do.
      this.requireRepositoriesReady();
      this.requireShellCapability(approval.operation, approval.unbounded === true);
      await this.authorize(approval.requestedBy, "write");
      // A tool call waiting on this card holds its message, so the operation runs now and the call gets its outcome. Any
      // other card (one requested outside a message) waits for the queue, so it never runs beside the agent.
      if (!this.#waits.waiting(id) && Object.values(state.runs).some(holdsQueue))
        throw new RunnerError(409, "Wait for the session queue to finish before approval execution");
      if (["github.comment", "github.merge", "github.issue", "git.push"].includes(approval.operation.kind) && !input.brokerCapability) throw new RunnerError(403, "Missing owner-bound single-use broker capability");
      await this.mutate(meta => { record(meta, { status: "executing", decidedBy: ticket.actorId }); });
      if (approval.operation.kind === "host.bash") {
        // Long host builds must not hold the connector's 30-second RPC queue.
        void this.startHostOperation(id, approval.operation, { actorId: ticket.actorId, capability: input.brokerCapability }, async () => {
          await this.authorize(approval.requestedBy, "write");
          await this.authorize(ticket.actorId, permission);
        });
        return (await this.metadata()).approvals[id]!;
      }
      if (approval.operation.kind === "bash" || approval.operation.kind === "program") {
        // A command may run for the host's whole time limit, far past the connector's 30-second RPC deadline: report
        // executing now and settle in the background, as host commands do. The call waiting on the card gets its outcome.
        const operation = approval.operation;
        void this.startShellOperation(id, operation, approval.unbounded === true, async () => {
          this.requireShellCapability(operation, approval.unbounded === true);
          await this.requireHostEnvironment();
          await this.authorize(approval.requestedBy, "write");
          await this.authorize(ticket.actorId, "approve");
          // Its decider's host command authority where deciding it takes that, as it stands when the command starts, and,
          // without the host's missing limits in a member's session, their grant too.
          await this.requireHostDecider(ticket.actorId, approval);
          if (granted) await this.requireShellGrant();
        });
        return (await this.metadata()).approvals[id]!;
      }
      if (approval.operation.kind === "git.push") {
        // Pushes can outlast the connector RPC deadline: report executing now and settle in the background.
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
        })().catch(() => { /* Reopening marks a still-executing approval interrupted; never retry the push. */ })
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
        // GitHub said why it didn't merge or open the issue: nothing changed, so the agent can act on the reason.
        const outcome = error instanceof RunnerError && error.status === 422 && (approval.operation.kind === "github.merge" || approval.operation.kind === "github.issue")
          ? { status: "failed" as const, result: this.#waits.kept(id, error.message) }
          : { status: "interrupted" as const, result: "Effect failed or outcome is ambiguous. Inspect external state; automatic retry is prohibited." };
        await this.mutate(meta => { Object.assign(meta.approvals[id]!, outcome); });
      }
      return (await this.metadata()).approvals[id]!;
    });
  }

  /**
   * Where the shared conversation goes back to for its view entry `entryId` (`<conversation>:<entry>`, as the view names
   * it): just before a user message, so it can be sent again, or just after the agent's final reply of a turn. Nowhere
   * else: a cut inside a turn would leave tool calls without results. `at` is undefined for a cut before the first message.
   */
  private async cutPoint(conversation: Conversation, entryId: string): Promise<{ at: EntryId | undefined; last: boolean }> {
    const match = /^(\d{1,15}):(\d{1,15})$/.exec(entryId);
    if (!match) throw new RunnerError(400, "Invalid message");
    if (Number(match[1]) !== Number(conversation.id)) throw new RunnerError(409, "That message is no longer in the shared conversation; reload it");
    // The active transcript, as the model sees it: from the newest head marker on. (A watch's view holds only a window of
    // the newest entries, from before the head marker too.)
    const { entries } = await conversation.context(context);
    const index = entries.findIndex(entry => entry.id === Number(match[2]));
    if (index < 0) throw new RunnerError(409, "That message is no longer in the shared conversation; reload it");
    const entry = entries[index]!;
    const messages = entry.model ?? [];
    // The active entries start at the context's head marker (a compaction's, which carries `head`), or else at the very
    // first entry: a user message there goes back to the start of the conversation.
    if (messages[0]?.role === "user" && entry.head === undefined) return { at: index > 0 ? entries[index - 1]!.id : undefined, last: false };
    const reply = messages.at(-1);
    if (reply?.role !== "assistant" || reply.content.some(block => block.type === "toolCall")) {
      throw new RunnerError(409, "Choose one of your messages or the agent's final reply");
    }
    return { at: entry.id, last: index === entries.length - 1 };
  }

  /** Whether the shared conversation, or the message queue, has work under way that a revert or fork would cut through. */
  private working(state: Metadata): boolean {
    return Object.values(state.runs).some(run => ["queued", "admitting", "running"].includes(run.status) || run.stopped?.pending)
      || Object.values(state.approvals).some(approval => approval.status === "executing");
  }

  /**
   * Takes the shared conversation back to one of its messages (see `cutPoint`): it continues from a fork there, and what
   * came after leaves the view. The old conversation stays on the host, in its backups too. Only the conversation goes
   * back: the worktree, its clones and anything pushed stay as they are. Refused while work runs or is queued.
   */
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
      // Back to where it is already: nothing to undo.
      if (last) return { conversationId: String(shared.id) };
      let next: Conversation;
      if (at !== undefined) next = await shared.fork(at, { ownership: { kind: "ownerless" } }, context);
      else {
        // Before the first message: a conversation as the session's root started, on the model it uses now.
        const agent = await shared.agent(context);
        next = await this.harness.createConversation({ ownership: { kind: "ownerless" }, agent: {
          model: agent.model ?? this.modelRef, thinkingLevel: agent.thinkingLevel, extensions: [this.#extension, ...this.#definedExtensions],
          tools: this.tools, instructions: this.agentInstructions("write"),
        } }, context);
      }
      await this.mutate(meta => {
        for (const branch of meta.branches) if (branch.mode === "write") branch.superseded = true;
        meta.branches.push({ id: next.id, mode: "write" });
        // Entry ids grow across the session's conversations, so the shared messages cut off are those that started at
        // the cut or after it; before the first message, all of them.
        for (const run of Object.values(meta.runs)) if (run.mode === "write" && (at === undefined || run.startEntry >= at)) run.reverted = true;
      });
      this.#shared = next;
      return { conversationId: String(next.id) };
    });
  }

  /**
   * The shared conversation's entries up to one of its messages (see `cutPoint`), as the model sees them, for a session
   * forked from it (see `seed`). Its owner reads them on this host: they never leave it.
   */
  async forkEntries(actorId: string, entryId: string): Promise<ForkedConversation> {
    return this.exclusive(async () => {
      if (this.closing) throw new RunnerError(503, "Session is closing");
      if (actorId !== this.binding.owner.id) throw new RunnerError(403, "Only the session's owner can fork it");
      await this.authorize(actorId, "manage");
      const shared = this.#shared;
      const { at, last } = await this.cutPoint(shared, entryId);
      // The latest reply while the agent still works may be followed at once by more of its turn.
      if (last && this.working(await this.metadata())) throw new RunnerError(409, "Wait for the agent to finish before forking from its latest reply");
      // The fork goes on with the model and reasoning the conversation uses now, which messages may have changed.
      const current = await shared.agent(context);
      const agent = { ...(current.model ? { model: { provider: current.model.provider, modelId: current.model.modelId } } : {}),
        ...(current.thinkingLevel ? { thinkingLevel: current.thinkingLevel as ThinkingLevel } : {}) };
      if (at === undefined) return { entries: [], agent };
      const transcript = await shared.context(context, { at });
      // System messages are this session's prompt (its branch, its worktree): the fork's agent renders its own.
      const entries = transcript.entries.flatMap((_entry, index) => {
        const model = (transcript.contributions[index] ?? []).filter(message => (message.role as string) !== "system");
        return model.length ? [{ kind: FORKED_KIND, model }] : [];
      });
      return { entries, agent };
    });
  }

  /**
   * Starts this new session's shared conversation with another session's (see `forkEntries`). Only into a session that
   * hasn't run anything yet; the same fork again is answered as before.
   */
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
      // The control plane started this session on the source's current model when it still could (the host offers it
      // and nobody disabled it), else on the source's own: only on the same model does the reasoning level carry over.
      // The model itself is the control plane's choice, never set here.
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
    const snapshots: { branch: Branch; entries: readonly EntryRecord[] }[] = [];
    // A shared conversation someone went back from stays on the host, out of the view: its fork shows what was kept.
    for (const branch of initial.branches.filter(item => !item.superseded)) {
      const conversation = await this.harness.conversation(branch.id as ConversationId, context);
      if (!conversation) continue;
      // The active transcript, from the newest head marker (a compaction's summary) on, as the model sees it. A watch's
      // view would hold only a window of the newest entries.
      snapshots.push({ branch, entries: (await conversation.context(context)).entries });
    }
    // Every admission is committed before its entries: read attribution after transcript snapshots.
    const state = await this.metadata();
    const stored = Object.values(state.approvals);
    const autoApproved = autoApprovedCalls(stored);
    const entries: SessionView["entries"] = [];
    for (const snapshot of snapshots) {
      let previous: Run | undefined;
      // Messages an extension refused never reached Pi: each shows where it was sent, after the entry the conversation
      // ended with then.
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
    const latestWrite = Object.values(state.runs).filter(run => run.mode === "write" && !run.withdrawn).sort((a, b) => (b.sequence ?? 0) - (a.sequence ?? 0))[0];
    // Every shared message ran at some access ("approval" when it named none), so the view says which; only a session
    // without one leaves it out, and the owner's chat box then starts on Auto-approve.
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
      ...(agent.model ? { agent: { provider: agent.model.provider, modelId: agent.model.modelId, thinkingLevel: agent.thinkingLevel } } : {}),
      ...(access ? { access } : {}),
      ...(repositories ? { repositories } : {}),
      activity: repositories ? (repositories.status === "preparing" ? "working" : "failed")
        : sessionActivity(Object.values(state.runs).filter(tellsActivity), Object.values(state.approvals),
          activityEntry(snapshots.find(snapshot => snapshot.branch.mode === "write")?.entries.at(-1))),
      ...await this.extensionView(),
      ...(tunnel ? { tunnel } : {}),
    };
  }

  /** What the view tells of the session's extensions: those it runs with now, and its workspace's enabled ones its host lacks. */
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
      // The tools the next message would get of each, settled as that message settles them (SessionExtensions.select).
      const settled = settleToolNames(chosen.map(item => ({ source: item.source,
        tools: installed.find(candidate => candidate.source === item.source)?.modules.flatMap(module => module.tools.map(tool => tool.name)) ?? [] })),
        this.tools.map(tool => tool.name));
      const running = chosen.map((item, index) => ({ source: item.source, dev: item.dev, tools: settled[index]!.kept, ...(item.required ? { required: true as const } : {}) }));
      // A workspace extension the host requires another version of isn't missing: the host's runs in its place.
      const requiredPackages = new Set(required.map(item => extensionPackageKey(item.source)));
      const missing = answer.extensions.filter(item => item.enabled && !requiredPackages.has(extensionPackageKey(item.source))
        && !chosen.some(candidate => candidate.source === item.source)).map(item => item.source);
      // As the next message selects them: after the workspace's, which may replace one.
      const builtin = this.#builtins?.select(enabled, new Set(running.flatMap(item => item.tools))).map(item => item.name) ?? [];
      // Pikibun's own the workspace has on that this session can't offer: the browser, without Chromium on the host, say.
      const off = this.definedToolsOff(sessionToolsOff(answer.extensions), answer.extensions);
      const browserReason = off.has("browser") ? undefined : this.browserUnavailable();
      const tunnelReason = off.has("tunnel") ? undefined : this.tunnelUnavailable();
      const unavailable = [...(browserReason ? [{ source: "piki:browser", tools: ["browser"], reason: browserReason }] : []),
        ...(tunnelReason ? [{ source: "piki:tunnel", tools: ["tunnel"], reason: tunnelReason }] : []),
        // Program tools the session offers, some of whose programs the host doesn't have (pnpm, uv, cargo ...).
        ...this.missingPrograms(off).map(item => ({ source: item.source, tools: [item.tool], reason: "programs", programs: item.programs }))];
      return running.length || missing.length || builtin.length || missingRequired.length || unavailable.length
        ? { extensions: { running, missing, ...(builtin.length ? { builtin } : {}), ...(missingRequired.length ? { missingRequired } : {}),
          ...(unavailable.length ? { unavailable } : {}) } } : {};
    } catch { return {}; }
  }

  async restart(): Promise<void> {
    await this.exclusive(async () => { await this.close(); await this.open(); });
  }

  /**
   * The session's idle, checkpointed snapshot. `conversationOnly` keeps just Pi's SQLite and the runner state: no files,
   * no clones, so a restore starts with an empty worktree.
   */
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
        // A clone session's clones go into the backup as bundles of their local work, not as files: a restore clones them
        // again from their origin.
        // On an unsandboxed host the worktree is kept as files, and a session with a clone in it can't be backed up.
        const sandboxed = this.#clone && this.#egress;
        const { clones, found } = sandboxed ? await isolatedWorkspace(this.sandbox).cloneBackup(authorize) : { clones: [], found: [] };
        const files = sandboxed ? await isolatedWorkspace(this.sandbox).snapshot(authorize, found) : await this.sandbox.snapshot(authorize);
        return { format: "pi-runner-backup-v1", binding: this.binding, manifest: state, sqlite, files, ...(clones.length ? { clones } : {}),
          createdAt: new Date().toISOString() };
      } finally { await this.open(); }
    });
  }

  /**
   * Refuses to pack this session (RunnerService.pack) when it can't be: `actorId` must manage it while it is archived,
   * it must run in the Linux sandbox, without per-session volumes, and be idle with its repositories ready.
   */
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

  /**
   * The pack of this session's files (pack.ts), for RunnerService.pack, which then writes it: its clones as bundles of
   * their local work and its other files, without its home's package caches. The session is closed first, and left so;
   * a refusal says why in words the control plane shows.
   */
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

  /**
   * One image of the transcript as people's clients show it (see entry-images.ts): a thumbnail, or the image as the model
   * got it. Only an entry the view shows has its images read, and only by people who could already have the agent read
   * the files they came from (`write`), as the file browser takes. Not exclusive with runs: it reads the committed
   * transcript.
   */
  async entryImage(ticket: RunnerTicket, input: unknown): Promise<{ image: EntryImage }> {
    this.assertTicket(ticket);
    const request = entryImageRequest(input);
    if (!request) throw new RunnerError(400, "Invalid image request");
    await this.authorize(ticket.actorId, "write", ticket.policyVersion);
    const { conversationId, entryId } = entryIdParts(request.entryId)!;
    const state = await this.metadata();
    // A conversation someone went back from is out of the view, and so are its images.
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

  /**
   * The session panel's file browser: one worktree path, read-only, as `write` sees it, since a collaborator could already
   * have the agent read any file. Not exclusive with runs: it waits only for the sandbox's own queue, like a file tool.
   */
  async browse(ticket: RunnerTicket, path: string): Promise<SessionFiles> {
    this.assertTicket(ticket);
    await this.authorize(ticket.actorId, "write", ticket.policyVersion);
    const authorize = async () => { await this.authorize(ticket.actorId, "write", ticket.policyVersion); };
    try {
      return { path, ...await this.sandbox.browse(path, authorize) };
    } catch (error) {
      if (error instanceof RunnerError) throw error;
      // Fixed reasons only (the control plane shows a 422's): never a host path or raw sandbox output.
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

  /**
   * One chunk of a file attached to a message (packages/shared/src/file-uploads.ts), as `write` sends it, since a
   * collaborator could already have the agent write any file (see SessionUploads).
   */
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
    // A long fetch stops at once; a checkout already under way finishes in the sandbox and the next open finds it ready.
    const preparation = this.#repositories;
    if (preparation.status === "preparing") preparation.controller.abort();
    this.#repositories = { status: "ready" };
    this.#preparations++;
    this.#opened = false;
    this.#resumed = false;
    this.#activity?.stop();
    // A closing session's server goes offline with it; the next open has none.
    const tunnel = this.#tunnel;
    this.#tunnel = undefined;
    await tunnel?.close().catch(() => {});
    if (abortPushes) {
      // Aborted pushes still settle their approval (interrupted) and report completion before the harness closes.
      for (const push of this.pushes) push.controller.abort();
      await Promise.allSettled([...this.pushes].map(push => push.done));
    }
    this.generation++;
    const extensions = this.#hostExtensions;
    this.#hostExtensions = undefined;
    await extensions?.shutdown().catch(() => {});
    // Calls still waiting on a card end with the harness; their cards are marked interrupted on reopen.
    this.#waits.dropWaiters();
    // A Session that already failed on a storage error has closed itself, and closing again only repeats that error.
    // Read the flag first: a close that fails now also marks the session failed, and its error must still surface.
    const failed = this.#failed;
    const builtins = this.#builtins;
    this.#builtins = undefined;
    try {
      await this.#egress?.close();
      await this.harness.close(context).catch((error: unknown) => { if (!failed) throw error; });
    } finally {
      // A script this stops resumes with the next opening's sandbox.
      await builtins?.close().catch(() => {});
    }
  }

  /** Credential → push → completion. The credential stays in this frame; results carry only fixed, credential-free text. */
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

  /** This host's own Git credential for `remote`: only its owner's sessions use it, and only while the owner has it on. */
  private async hostAuthorization(remote: string, signal?: AbortSignal): Promise<string> {
    if (!this.config.hostGitCredential) throw new PushError("This host does not push with its Git credentials; its owner can turn them on in Pikibun (Settings → Hosts → the host → Configuration)");
    if (this.binding.session.connectorOwnerId !== this.binding.owner.id) throw new PushError("Only the host's owner can push with its Git credentials");
    try {
      return await this.config.hostGitCredential(remote, signal);
    } catch (error) {
      throw new PushError(error instanceof HostCredentialError ? error.message : "The host's Git credentials could not be read");
    }
  }

  /** Shared-secret internal control-plane call; Worker errors carry fixed, credential-free messages. */
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
