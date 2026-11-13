import type { OperationRecord, GitHubCommentRequest, GitHubIssueRequest, GitHubIssueResult, GitHubMergeRequest, GitHubMergeResult, GitPushOperation, HostPushCredential,
  Operation, PushCompleteRequest, PushCompletionResult, PushCredential, PushCredentialRequest, PushOutcome, RunnerBinding } from "../../../../packages/shared/src/types.js";
import type { StoredOperation } from "../operation-record.js";
import { HostCredentialError } from "../git-credentials.js";
import type { CommandLimits } from "../host-config.js";
import { RunnerError, validateOperation } from "../protocol.js";
import { performClonePush, PushError, pushSummary, type PushResult } from "../push.js";
import { SandboxProcessError, type SandboxAuthorize } from "../sandbox.js";
import { isolatedWorkspace, type SessionWorkspace } from "../workspace.js";
import type { WholeResults } from "./whole-results.js";
import type { HostCommandPolicy } from "./host-commands.js";
import type { Metadata } from "./state.js";

export function githubRepository(name: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9_.-]{1,100}$/.test(name)) throw new RunnerError(400, "repository must be a github.com owner/name");
  return name;
}

export interface OperationsConfig {
  connectorId?: string;
  controlPlaneUrl: string;
  sharedSecret: string;
  fetch?: typeof fetch;
  githubComment?: (request: GitHubCommentRequest) => Promise<{ id: number; url: string }>;
  githubMerge?: (request: GitHubMergeRequest) => Promise<GitHubMergeResult>;
  githubIssue?: (request: GitHubIssueRequest) => Promise<GitHubIssueResult>;
  pushCredential?: (request: PushCredentialRequest) => Promise<PushCredential | HostPushCredential>;
  pushComplete?: (request: PushCompleteRequest) => Promise<PushCompletionResult>;
  hostGitCredential?: (remote: string, signal?: AbortSignal) => Promise<string>;
}

export type OperationConsent = { unbounded?: boolean; hostChecked?: boolean; timeoutSeconds?: number };

export interface SessionOperationsOptions {
  binding: RunnerBinding;
  config: OperationsConfig;
  clone: boolean;
  sandboxed: boolean;
  sandbox: SessionWorkspace;
  hostCommands: HostCommandPolicy;
  wholeResults: WholeResults;
  requireUnfrozen(): void;
  authorize(actorId: string, permission: "write"): Promise<unknown>;
  metadata(): Promise<Metadata>;
  mutate(change: (state: Metadata) => void): Promise<void>;
  commandOptions(timeoutSeconds?: number): Promise<{ limits: CommandLimits; gpu: boolean }>;
  testShell(): boolean;
  controlPlane<T>(path: string, body: unknown): Promise<T>;
}

export class SessionOperations {
  readonly #pushes = new Set<{ controller: AbortController; done: Promise<void> }>();

  constructor(private readonly options: SessionOperationsOptions) {}

  async abortPushes(): Promise<void> {
    for (const push of this.#pushes) push.controller.abort();
    await Promise.allSettled([...this.#pushes].map(push => push.done));
  }

  async #githubEffect(operation: Extract<Operation, { kind: "github.comment" | "github.merge" | "github.issue" }>,
    authority: { sessionId: string; actorId: string; approvalId: string } & ({ capability: string } | { admissionId: string })): Promise<string> {
    const config = this.options.config;
    if (operation.kind === "github.comment") {
      const { repository, issue, body } = operation;
      const request: GitHubCommentRequest = { ...authority, repository, issue, body };
      const comment = config.githubComment ? await config.githubComment(request) : await this.internalGitHub("comment", request) as { id: number; url: string };
      return JSON.stringify({ id: comment.id, url: comment.url });
    }
    if (operation.kind === "github.merge") {
      const { repository, pull, sha, method } = operation;
      const request: GitHubMergeRequest = { ...authority, repository, pull, sha, method };
      const merged = config.githubMerge ? await config.githubMerge(request) : await this.internalGitHub("merge", request) as GitHubMergeResult;
      return JSON.stringify({ merged: true, sha: merged.sha, url: merged.url });
    }
    const { repository, title, body } = operation;
    const request: GitHubIssueRequest = { ...authority, repository, title, body };
    const opened = config.githubIssue ? await config.githubIssue(request) : await this.internalGitHub("issue", request) as GitHubIssueResult;
    return JSON.stringify({ number: opened.number, url: opened.url });
  }

  async internalGitHub(action: "comment" | "read" | "merge" | "issue", request: object): Promise<unknown> {
    return this.internalBroker(`github/${action}`, request);
  }

  async internalBroker(path: string, request: object): Promise<unknown> {
    const config = this.options.config;
    const response = await (config.fetch ?? fetch)(`${config.controlPlaneUrl}/api/internal/${path}`, {
      method: "POST", headers: { authorization: `Bearer ${config.sharedSecret}`, "content-type": "application/json" },
      body: JSON.stringify(request), signal: AbortSignal.timeout(30_000), redirect: "error",
    });
    const value: unknown = await response.json().catch(() => undefined);
    if (!response.ok) {
      const error = value && typeof value === "object" && "error" in value && typeof value.error === "string" ? value.error : "Broker returned an error; external state must be reconciled";
      throw new RunnerError(response.status, error);
    }
    return value;
  }

  async run(actorId: string, input: Operation, toolTaskId: string, consent: OperationConsent = {}, signal?: AbortSignal): Promise<StoredOperation> {
    const { binding, config, hostCommands, wholeResults } = this.options;
    this.options.requireUnfrozen();
    const operation = validateOperation(input);
    if (operation.kind === "permission") throw new RunnerError(400, "Permission requests were removed: a session runs its tools or refuses them");
    if (operation.kind === "git.commit" || operation.kind === "git.repin" || (operation.kind === "git.push" && operation.directory === undefined)) {
      throw new RunnerError(400, "Commit and switch branches with the git tool; a push names a clone's directory");
    }
    if (operation.kind === "host.bash") throw new RunnerError(400, "Commands on the host were removed with host_bash; run programs with the git, node and python tools");
    hostCommands.requireShell(operation, consent.unbounded);
    if (operation.kind === "extension.tool" && (!config.connectorId || !binding.session.connectorOwnerId)) {
      throw new RunnerError(403, "Host commands require a connected host with a known owner");
    }
    if (operation.kind === "git.push" && !this.options.clone) throw new RunnerError(400, "Only clone sessions push a clone's directory");
    if (operation.kind === "git.push" && !this.options.sandboxed) throw new RunnerError(400, "On a host without the sandbox, push with the git tool");
    await this.options.authorize(actorId, "write");
    const state = await this.options.metadata();
    const attribution = state.toolActors[toolTaskId];
    const run = attribution && state.runs[attribution.runKey];
    if (!run || run.initiatedBy !== actorId || run.ownerId !== binding.owner.id || run.mode !== "write"
      || !["admitting", "running"].includes(run.status)) throw new RunnerError(403, "The operation has no active originating write");
    const admissionId = run.admissionId;
    if (config.connectorId && !admissionId) throw new RunnerError(403, "The operation lacks Worker write admission");
    const brokered = operation.kind === "git.push" || operation.kind === "github.comment" || operation.kind === "github.merge" || operation.kind === "github.issue";
    if (brokered && admissionId === undefined) throw new RunnerError(403, "Pushes and GitHub effects need a write message");
    if (!consent.hostChecked && hostCommands.runsOnHost(operation, consent.unbounded === true)) await hostCommands.require(actorId, hostCommands.onHostMachine());
    const id = `tool-${toolTaskId}`;
    const record: StoredOperation = { id, sessionId: binding.session.id, requestedBy: actorId, operation: JSON.parse(JSON.stringify(operation)),
      createdAt: new Date().toISOString(), status: "executing",
      ...(consent.unbounded && (operation.kind === "bash" || operation.kind === "program") ? { unbounded: true } : {}),
      ...(attribution.callId ? { callId: attribution.callId } : {}), ...(admissionId !== undefined ? { admissionId } : {}) };
    let created = false;
    await this.options.mutate(meta => { if (!meta.approvals[id]) { meta.approvals[id] = record; created = true; } });
    if (!created) return wholeResults.whole((await this.options.metadata()).approvals[id]!);
    if (operation.kind === "extension.tool") return record;
    return wholeResults.whole(await this.#execute(id, actorId, signal, consent.timeoutSeconds));
  }

  async #execute(id: string, actorId: string, signal?: AbortSignal, timeoutSeconds?: number): Promise<StoredOperation> {
    const { binding, hostCommands, wholeResults } = this.options;
    const approval = (await this.options.metadata()).approvals[id]!;
    const operation = approval.operation;
    let status: OperationRecord["status"];
    let result: string;
    if (operation.kind === "github.comment" || operation.kind === "github.merge" || operation.kind === "github.issue") {
      try {
        await this.options.authorize(actorId, "write");
        result = await this.#githubEffect(operation, { sessionId: binding.session.id, actorId, approvalId: id, admissionId: approval.admissionId! });
        status = "executed";
      } catch (error) {
        if (error instanceof RunnerError && error.status === 422 && operation.kind !== "github.comment") { status = "failed"; result = error.message; }
        else { status = "interrupted"; result = "Effect failed or outcome is ambiguous. Inspect external state; automatic retry is prohibited."; }
      }
      await this.options.mutate(meta => { Object.assign(meta.approvals[id]!, { status, result: wholeResults.kept(id, result) }); });
      return (await this.options.metadata()).approvals[id]!;
    }
    if (operation.kind === "git.push") {
      const entry = { controller: new AbortController(), done: Promise.resolve() };
      const settled = (async () => {
        const outcome = await this.#runPush(id, operation, { actorId, admissionId: approval.admissionId }, async () => { await this.options.authorize(actorId, "write"); }, entry.controller.signal);
        await this.options.mutate(meta => { Object.assign(meta.approvals[id]!, { status: outcome.status, result: wholeResults.kept(id, outcome.result) }); });
      })();
      entry.done = settled.then(() => undefined, () => undefined);
      this.#pushes.add(entry);
      try { await settled; }
      finally { this.#pushes.delete(entry); }
      return (await this.options.metadata()).approvals[id]!;
    }
    if (operation.kind !== "bash" && operation.kind !== "program") throw new RunnerError(400, "Unsupported operation");
    const onHost = hostCommands.runsOnHost(operation, approval.unbounded === true);
    try {
      result = await this.options.sandbox.execute(operation, false, async () => {
        hostCommands.requireShell(operation, approval.unbounded === true);
        await hostCommands.requireHostEnvironment();
        if (onHost) await hostCommands.require(actorId, hostCommands.onHostMachine());
        await this.options.authorize(actorId, "write");
      }, { allowTestShell: this.options.testShell(), unbounded: approval.unbounded === true,
        ...await this.options.commandOptions(timeoutSeconds), signal });
      status = "executed";
    } catch (error) {
      const refused = error instanceof RunnerError && error.status < 500;
      status = error instanceof SandboxProcessError || refused ? "failed" : "interrupted";
      result = error instanceof SandboxProcessError ? `${error.message}${error.stdout ? `\n${error.stdout}` : ""}`
        : refused ? (error as RunnerError).message : "Effect failed or outcome is ambiguous. Inspect external state; automatic retry is prohibited.";
    }
    await this.options.mutate(meta => { Object.assign(meta.approvals[id]!, { status, result: wholeResults.kept(id, result) }); });
    return (await this.options.metadata()).approvals[id]!;
  }

  async #runPush(id: string, operation: GitPushOperation, auth: { actorId: string; capability?: string; admissionId?: string }, recheck: SandboxAuthorize, signal?: AbortSignal): Promise<{ status: "executed" | "failed" | "interrupted"; result: string }> {
    const { binding, config } = this.options;
    const request: PushCredentialRequest = { sessionId: binding.session.id, approvalId: id, actorId: auth.actorId, operation,
      ...(auth.capability !== undefined ? { capability: auth.capability } : {}), ...(auth.admissionId !== undefined ? { admissionId: auth.admissionId } : {}) };
    let credential: PushCredential | HostPushCredential;
    try {
      await recheck();
      credential = config.pushCredential ? await config.pushCredential(request) : await this.options.controlPlane<PushCredential | HostPushCredential>("/api/internal/git/push/credential", request);
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
      const authorization = "hostCredentials" in credential ? await this.#hostAuthorization(credential.remote, signal) : credential.authorization;
      pushed = await performClonePush({ workspace: isolatedWorkspace(this.options.sandbox), operation, credential: { remote: credential.remote, authorization }, authorize: recheck, signal });
    } catch (error) {
      failure = error instanceof PushError && !signal?.aborted
        ? { status: "failed", result: `Push failed: ${error.message}. Nothing was pushed.` }
        : { status: "interrupted", result: "Push was interrupted; the remote branch may or may not have changed. Inspect it; automatic retry is prohibited." };
    }
    const outcome: PushOutcome = pushed?.outcome ?? (failure?.status === "failed" ? "failed" : "unknown");
    const complete: PushCompleteRequest = { sessionId: binding.session.id, approvalId: id, credentialId: credential.credentialId, outcome, ...(pushed ? { tip: pushed.tip } : {}) };
    let completion: PushCompletionResult | undefined;
    let completionFailure = "";
    try {
      completion = config.pushComplete ? await config.pushComplete(complete) : await this.options.controlPlane<PushCompletionResult>("/api/internal/git/push/complete", complete);
    } catch (error) {
      completionFailure = error instanceof RunnerError ? `: ${error.message}` : "";
    }
    if (!pushed) return failure!;
    const confirmation = completion ? "" : operation.pullRequest
      ? `\nThe pull request was not opened${completionFailure || "; the control plane did not confirm completion"}.`
      : "\nThe control plane did not confirm completion.";
    return { status: "executed", result: pushSummary(pushed, completion?.pullRequest) + confirmation };
  }

  async #hostAuthorization(remote: string, signal?: AbortSignal): Promise<string> {
    const { binding, config } = this.options;
    if (!config.hostGitCredential) throw new PushError("This host does not push with its Git credentials; its owner can turn them on in Pikibun (Settings → Hosts → the host → Configuration)");
    if (binding.session.connectorOwnerId !== binding.owner.id) throw new PushError("Only the host's owner can push with its Git credentials");
    try {
      return await config.hostGitCredential(remote, signal);
    } catch (error) {
      throw new PushError(error instanceof HostCredentialError ? error.message : "The host's Git credentials could not be read");
    }
  }
}
