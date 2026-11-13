import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { ConversationIdle, type CompactionSettings, type Conversation, type ConversationId, type Harness, type SettledSubmissionRecord, type Submission,
  type SubmissionId, type SubmissionRecord } from "@earendil-works/pi-durable";
import { parseChatImages } from "../../../../packages/shared/src/chat-images.js";
import type { HostCompaction } from "../../../../packages/shared/src/host-config.js";
import type { ChosenExtension } from "../../../../packages/shared/src/host-extensions.js";
import type { ModelFailureCause } from "../../../../packages/shared/src/types.js";
import { compactionFailure, configuredCompaction } from "../compaction.js";
import type { InputOutcome, SessionExtensions } from "../extensions/adapter.js";
import { compactionEnabled, compactsAfterFailure, contextTokens, modelFailureCause } from "../model-failure.js";
import { stableJson } from "../protocol.js";
import { prepareMessageImages, type InputImage, type MessageInputs } from "./inputs.js";
import type { RepositoryPreparation } from "./repositories.js";
import type { Metadata, Run } from "./state.js";

export const REFUSED = "An extension on this host refused this message.";
export const INPUT_FAILED = "This host couldn't check this message with its extensions, so it was not sent. Try again shortly.";
export const INPUT_EMPTY = "An extension on this host left this message empty or too long, so it was not sent.";
export const INPUT_IMAGES = "An extension on this host changed this message's images into ones that can't be sent.";

export type RunContent = string | ({ type: "text"; text: string } | { type: "image"; data: string; mimeType: string })[];

/** Side asks run beside the shared work, each in its own conversation, up to this many at once. */
export const MAX_RUNNING_ASKS = 4;

const active = (run: Run) => run.status === "running" || run.status === "admitting";

export function submissionRequestId(run: Pick<Run, "key" | "steered">): string {
  return run.steered === undefined ? run.key : `${run.key}:steer`;
}

export function steersInto(runs: Record<string, Run>, run: Run): string | undefined {
  if (run.mode !== "write" || run.status !== "queued" || run.screening || run.images || run.stopped || run.withdrawn) return undefined;
  const all = Object.values(runs);
  if (all.some(other => (other.mode === "write" && other.status === "admitting") || other.stopped?.pending)) return undefined;
  const running = all.filter(other => other.mode === "write" && other.status === "running").sort((a, b) => (a.sequence ?? 0) - (b.sequence ?? 0));
  if (!running.length || running.some(other => other.submissionId === undefined || other.stopped
    || other.conversationId !== run.conversationId || other.initiatedBy !== run.initiatedBy
    || stableJson(other.options ?? null) !== stableJson(run.options ?? null))) return undefined;
  return running[0]!.steered ?? running[0]!.key;
}

export function requeue(run: Run): void {
  run.status = "queued";
  delete run.started;
  delete run.steered;
  delete run.submissionId;
}

type Settlement = Pick<SubmissionRecord, "status"> & { answer?: unknown; reason?: unknown; detail?: unknown };

function sameEnd(a: Settlement, b: Settlement): boolean {
  if (a.status !== b.status) return false;
  if (a.status === "done") return a.answer === b.answer;
  return a.status === "unanswered" && a.reason === b.reason && JSON.stringify(a.detail ?? null) === JSON.stringify(b.detail ?? null);
}

export interface RunQueueOptions {
  sessionId: string;
  connectorOwnerId: string | undefined;
  inputs: MessageInputs;
  config: { compaction?: CompactionSettings };
  configuredCompaction(): HostCompaction | undefined;
  generation(): number;
  closing(): boolean;
  preparation(): RepositoryPreparation["status"];
  harness(): Harness;
  hostExtensions(): SessionExtensions | undefined;
  exclusive(operation: () => Promise<void>): Promise<void>;
  metadata(): Promise<Metadata>;
  mutate(change: (state: Metadata) => void): Promise<void>;
  authorize(actorId: string, permission: "ask" | "write"): Promise<unknown>;
  requiredRefusal(open: boolean): Promise<string | undefined>;
  extensionChoice(): Promise<{ chosen: ChosenExtension[] }>;
  applyOptions(conversation: Conversation, run: Run, content: RunContent): Promise<void>;
  drain(): void;
}

export class RunQueue {
  #draining = false;
  #drainAgain = false;

  constructor(private readonly options: RunQueueOptions) {}

  observe(key: string, submissionId: SubmissionId): void {
    const generation = this.options.generation();
    const harness = this.options.harness();
    void (async () => {
      const submission = await harness.submission(submissionId, context);
      if (!submission) throw new Error("Missing durable submission");
      const settled = await submission.wait(context);
      if (generation !== this.options.generation() || this.options.closing()) return;
      const state = await this.options.metadata();
      const observed = state.runs[key];
      if (!observed || Number(observed.submissionId) !== Number(submissionId)) return;
      const joined = await this.#joined(observed, settled, state);
      if (!joined && observed.mode === "write") void this.options.hostExtensions()?.agentEnd([], settled.status !== "done").catch(() => {});
      const conversation = await harness.conversation(observed.conversationId as ConversationId, context);
      await conversation?.waitForIdle(context);
      const compaction = settled.status === "unanswered" && settled.reason === "model_error" ? compactionFailure(settled.detail) : undefined;
      const cause = settled.status === "unanswered" && settled.reason === "model_error" && !compaction ? modelFailureCause(settled.detail) : undefined;
      const failed = settled.status === "unanswered" && (settled.reason === "model_error" || settled.reason === "no_model");
      const model = failed ? (await conversation?.agent(context))?.model : undefined;
      const failure: Run["failure"] = failed
        ? { reason: compaction ? "compaction_failed" : settled.reason, ...model, ...(compaction ? { compaction } : {}), ...(cause ? { cause } : {}) } : undefined;
      const compacts = !joined && !!failure && !!conversation && await this.#compactsAfterFailure(conversation, observed.mode, cause, model);
      const crashed = settled.status === "unanswered" && (settled.reason === "restart_limit" || settled.reason === "interrupted");
      await this.options.exclusive(async () => {
        if (generation !== this.options.generation() || this.options.closing()) return;
        await this.#unstick(observed.conversationId, key);
        if (compacts && !(await this.options.metadata()).runs[key]?.stopped) {
          try { await conversation!.compact(undefined, context); failure!.compacting = true; }
          catch { }
        }
        await this.options.mutate(meta => {
          const run = meta.runs[key]!;
          if (run.stopped || Number(run.submissionId) !== Number(submissionId)) return;
          if (crashed) Object.assign(run, { status: "interrupted", crashed: true });
          else run.status = "settled";
          if (failure) run.failure = failure;
        });
      });
      if (generation === this.options.generation() && !this.options.closing()) this.options.drain();
    })().catch(() => { });
  }

  async #joined(run: Run, settled: SettledSubmissionRecord, state: Metadata): Promise<boolean> {
    if (run.steered === undefined) return false;
    const earlier = Object.values(state.runs).filter(other => other.key !== run.key && (other.key === run.steered || other.steered === run.steered)
      && (other.sequence ?? 0) < (run.sequence ?? 0) && other.submissionId !== undefined);
    for (const other of earlier) {
      try {
        const submission = await this.options.harness().submission(other.submissionId as SubmissionId, context);
        if (submission && sameEnd(await submission.status(context), settled)) return true;
      }
      catch { }
    }
    return false;
  }

  async #unstick(conversationId: number, key: string): Promise<void> {
    const stuck = Object.values((await this.options.metadata()).runs).filter(run => run.key !== key && run.steered !== undefined && run.status === "running"
      && !run.stopped && run.conversationId === conversationId && run.submissionId !== undefined);
    for (const run of stuck) {
      const submission = await this.options.harness().submission(run.submissionId as SubmissionId, context);
      if (!submission || (await submission.status(context)).status !== "queued") continue;
      if (await submission.abort(context) !== "aborted") continue;
      await this.options.mutate(meta => {
        const saved = meta.runs[run.key];
        if (saved && saved.submissionId === run.submissionId) requeue(saved);
      });
    }
  }

  async #admissible(run: Run): Promise<boolean> {
    try { await this.options.authorize(run.initiatedBy, run.mode === "ask" ? "ask" : "write"); }
    catch {
      if (run.images) await this.options.inputs.discard([run.key]);
      await this.options.mutate(meta => { meta.runs[run.key]!.status = "interrupted"; });
      return false;
    }
    const refusal = await this.options.requiredRefusal(true).catch(() => INPUT_FAILED);
    if (refusal) {
      if (run.images) await this.options.inputs.discard([run.key]);
      await this.options.mutate(meta => { Object.assign(meta.runs[run.key]!, { status: "interrupted", refused: { by: "", notice: refusal } }); });
      return false;
    }
    return true;
  }

  async #steer(run: Run, root: string): Promise<boolean> {
    const conversation = await this.options.harness().conversation(run.conversationId as ConversationId, context);
    if (!conversation) throw new Error("Persisted branch is missing");
    const transcript = await conversation.context(context);
    await this.options.mutate(meta => {
      Object.assign(meta.runs[run.key]!, { status: "admitting", started: true, steered: root, startEntry: transcript.entries.at(-1)?.id ?? 0 });
    });
    let submission: Submission;
    try {
      submission = await conversation.submit({ type: "input", content: run.content, requestId: submissionRequestId({ key: run.key, steered: root }),
        whenBusy: "steer", whenIdle: "reject" }, context);
    }
    catch (error) {
      if (!(error instanceof ConversationIdle)) throw error;
      await this.options.mutate(meta => { requeue(meta.runs[run.key]!); });
      return false;
    }
    await this.options.mutate(meta => {
      meta.runs[run.key]!.submissionId = submission.id;
      meta.runs[run.key]!.status = "running";
    });
    this.observe(run.key, submission.id);
    return true;
  }

  async #compactsAfterFailure(conversation: Conversation, mode: Run["mode"], cause: ModelFailureCause | undefined,
    model: { provider: string; modelId: string } | undefined): Promise<boolean> {
    if (cause !== "incomplete_stream" || mode !== "write") return false;
    try {
      const enabled = compactionEnabled(configuredCompaction(this.options.config.compaction, this.options.configuredCompaction()), model);
      const tokens = contextTokens((await conversation.context(context)).messages);
      return compactsAfterFailure({ cause, mode, tokens, enabled });
    }
    catch { return false; }
  }

  drain(): void {
    if (this.#draining) { this.#drainAgain = true; return; }
    if (this.options.closing() || this.options.preparation() !== "ready") return;
    this.#draining = true;
    this.#drainAgain = false;
    void this.options.exclusive(async () => {
      while (!this.options.closing()) {
        const state = await this.options.metadata();
        const runs = Object.values(state.runs);
        const stopping = runs.some(run => run.stopped?.pending);
        const executing = Object.values(state.approvals).some(approval => approval.status === "executing");
        const queued = runs.filter(candidate => candidate.status === "queued").sort((a, b) => (a.sequence ?? 0) - (b.sequence ?? 0));
        // Shared messages run one at a time, in order, in the shared conversation (or steer the one at work).
        let write = queued.find(candidate => candidate.mode === "write");
        let root: string | undefined;
        if (write && (write.screening || executing)) write = undefined;
        else if (write && (stopping || runs.some(run => run.mode === "write" && active(run)))) {
          root = steersInto(state.runs, write);
          if (root === undefined) write = undefined;
        }
        // A side ask works in a conversation of its own, read-only, so it starts at once, beside whatever the shared work does.
        const ask = stopping || runs.filter(run => run.mode === "ask" && active(run)).length >= MAX_RUNNING_ASKS ? undefined
          : queued.find(candidate => candidate.mode === "ask" && !candidate.screening);
        const run = write && (!ask || (write.sequence ?? 0) < (ask.sequence ?? 0)) ? write : ask;
        if (!run) return;
        if (run !== write) root = undefined;
        if (!(await this.#admissible(run))) continue;
        if (root !== undefined) {
          if (!(await this.#steer(run, root))) return;
          continue;
        }
        const content = await this.runInput(run);
        if (content === undefined) {
          await this.endLostInputs(run.key);
          continue;
        }
        const conversation = await this.options.harness().conversation(run.conversationId as ConversationId, context);
        if (!conversation) throw new Error("Persisted branch is missing");
        const transcript = await conversation.context(context);
        await this.options.mutate(meta => {
          meta.runs[run.key]!.status = "admitting";
          meta.runs[run.key]!.started = true;
          meta.runs[run.key]!.startEntry = transcript.entries.at(-1)?.id ?? 0;
        });
        await this.options.applyOptions(conversation, run, content);
        const submission = await conversation.submit({ type: "input", content, requestId: run.key }, context);
        await this.options.mutate(meta => {
          meta.runs[run.key]!.submissionId = submission.id;
          meta.runs[run.key]!.status = "running";
        });
        if (run.images) await this.options.inputs.discard([run.key]);
        this.observe(run.key, submission.id);
      }
    }).catch(() => { })
      .finally(() => {
        this.#draining = false;
        if (this.#drainAgain) { this.#drainAgain = false; this.options.drain(); }
      });
  }

  async screen(key: string): Promise<void> {
    const generation = this.options.generation();
    let outcome: InputOutcome | { action: "skip" };
    try { outcome = await this.#screenInput(key); }
    catch (error) {
      process.stderr.write(`Session ${this.options.sessionId}: couldn't screen a message, so it was refused: ${String(error instanceof Error ? error.message : error).slice(0, 300)}\n`);
      outcome = { action: "refused", by: "", notice: INPUT_FAILED };
    }
    if (generation !== this.options.generation() || this.options.closing()) return;
    let images: InputImage[] | undefined;
    if (outcome.action === "continue") {
      const run = (await this.options.metadata()).runs[key];
      const before = run?.images ? await this.options.inputs.read(key) ?? [] : [];
      const changed = outcome.images.length !== before.length || outcome.images.some((image, index) => image.data !== before[index]!.data);
      if (outcome.text.length > 100_000 || (!outcome.text.trim() && !outcome.images.length)) outcome = { action: "refused", by: "", notice: INPUT_EMPTY };
      else if (changed) {
        const parsed = parseChatImages(outcome.images.map(image => ({ mimeType: image.mimeType, data: image.data })));
        images = "error" in parsed ? undefined : parsed.images.length ? await prepareMessageImages(parsed.images).catch(() => undefined) : [];
        if (!images) outcome = { action: "refused", by: "", notice: INPUT_IMAGES };
        else if (images.length) await this.options.inputs.write(key, images);
        else await this.options.inputs.discard([key]);
      }
    }
    const result = outcome;
    let refused = false;
    await this.options.mutate(meta => {
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
    if (refused) await this.options.inputs.discard([key]);
    this.options.drain();
  }

  async #screenInput(key: string): Promise<InputOutcome | { action: "skip" }> {
    const host = this.options.hostExtensions();
    const run = (await this.options.metadata()).runs[key];
    if (!host || !run?.screening || run.status !== "queued") return { action: "skip" };
    const refusal = await this.options.requiredRefusal(true);
    if (refusal) return { action: "refused", by: "", notice: refusal };
    const images = run.images ? await this.options.inputs.read(key) : [];
    if (!images) return { action: "skip" };
    const { chosen } = await this.options.extensionChoice();
    const hostOwner = this.options.connectorOwnerId;
    const outcome = await host.input(chosen.map(item => item.source), run.content, images.map(image => ({ type: "image" as const, ...image })),
      hostOwner && run.initiatedBy === hostOwner ? "interactive" : "rpc");
    if (outcome.action !== "refused") return outcome;
    const notice = outcome.notice?.replace(/[\x00-\x1f\x7f]+/g, " ").trim().slice(0, 300);
    process.stderr.write(`Session ${this.options.sessionId}: ${outcome.by} refused a message${notice ? `: ${notice}` : ""}\n`);
    return { action: "refused", by: outcome.by, notice: notice || `An extension on this host (${outcome.by}) refused this message.` };
  }

  async sweepInputs(): Promise<void> {
    const runs = (await this.options.metadata()).runs;
    await this.options.inputs.sweep(key => {
      const run = runs[key];
      return run !== undefined && run.submissionId === undefined && ["queued", "admitting", "running"].includes(run.status);
    });
  }

  async endLostInputs(key: string): Promise<void> {
    await this.options.inputs.discard([key]);
    await this.options.mutate(meta => { Object.assign(meta.runs[key]!, { status: "interrupted", inputsLost: true }); });
  }

  async runInput(run: Run): Promise<RunContent | undefined> {
    if (!run.images) return run.content;
    const images = await this.options.inputs.read(run.key);
    if (!images) return undefined;
    return [
      ...(run.content.trim() ? [{ type: "text" as const, text: run.content }] : []),
      ...images.map(image => ({ type: "image" as const, data: image.data, mimeType: image.mimeType })),
    ];
  }
}
