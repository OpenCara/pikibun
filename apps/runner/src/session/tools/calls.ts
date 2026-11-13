import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import type { ToolExecutionApi, ToolExecutionResult } from "@earendil-works/pi-durable";
import { parseBrowserReport } from "../../../../../packages/shared/src/browser.js";
import type { HostConfig } from "../../../../../packages/shared/src/host-config.js";
import type { AnyToolName, OperationRecord } from "../../../../../packages/shared/src/types.js";
import type { StoredOperation } from "../../operation-record.js";
import type { OutputFiles } from "../../extensions/builtin.js";
import { callLimits, commandLimits, type CommandLimits } from "../../host-config.js";
import { prepareImage } from "../../images.js";
import { RunnerError } from "../../protocol.js";
import type { SandboxAuthorize } from "../../sandbox.js";
import { inScriptCall } from "../../script-output.js";
import { boundOutput, MODEL_OUTPUT, SAVED_OUTPUT_BYTES, SavedOutputs, scriptOutput, toolOutputPath } from "../../tool-output.js";
import type { SessionWorkspace } from "../../workspace.js";
import type { HostCommandPolicy } from "../host-commands.js";
import { RunnerState, type Metadata } from "../state.js";

export type ToolAttribution = { initiatedBy: string; actingAs: string; mode: "write" | "ask" };

export interface ToolCallsOptions {
  ownerId: string;
  sandbox: SessionWorkspace;
  hostCommands: HostCommandPolicy;
  authorize(actorId: string, permission: "write" | "ask"): Promise<unknown>;
  metadata(): Promise<Metadata>;
  hostConfig(): Promise<HostConfig>;
  requireOwnerTool(tool: string): Promise<void>;
  requireSenderTool(tool: string, senderId: string): Promise<void>;
}

export class ToolCalls {
  readonly #savedOutputs = new SavedOutputs();

  constructor(private readonly options: ToolCallsOptions) {}

  async outputFiles(api: ToolExecutionApi): Promise<OutputFiles | undefined> {
    const attribution = await this.actor(api, true);
    const state = await this.options.metadata();
    const run = state.runs[state.toolActors[String(api.taskId)]!.runKey]!;
    if (run.options?.access === "read") return undefined;
    return { writeFile: (path, content) => this.saveOutput(path, content, async () => { await this.recheck(attribution); }) };
  }

  async saveOutput(path: string, content: string, authorize: SandboxAuthorize): Promise<void> {
    const sandbox = this.options.sandbox;
    await sandbox.writeFile(path, content, authorize);
    await this.#savedOutputs.saved(path, {
      list: directory => sandbox.listFiles(directory, authorize),
      remove: async entry => { await sandbox.fileOperation({ kind: "delete", path: entry, recursive: true }, authorize); },
    }).catch(() => {});
  }

  async shownApproval(approval: StoredOperation, api: ToolExecutionApi, tool: string): Promise<Record<string, unknown>> {
    const shown = { ...approval, admissionId: undefined, callId: undefined };
    const result = approval.result;
    if (typeof result !== "string") return shown;
    if (inScriptCall()) {
      return { ...shown, result: scriptOutput(result, candidate => Buffer.byteLength(JSON.stringify({ ...shown, result: candidate })) <= SAVED_OUTPUT_BYTES) };
    }
    const files = await this.outputFiles(api).catch(() => undefined);
    return { ...shown, result: await boundOutput(result, {
      ...(files
        ? { save: async (whole: string) => { const path = toolOutputPath(tool, String(api.callId)); await files.writeFile(path, whole); return path; } }
        : { unsaved: "a Read-only message doesn't write to the worktree" }),
      fits: candidate => Buffer.byteLength(JSON.stringify({ ...shown, result: candidate })) <= MODEL_OUTPUT.bytes,
    }) };
  }

  async actor(api: ToolExecutionApi, write: boolean): Promise<ToolAttribution> {
    const doc = await api.snapshot(RunnerState, context);
    const state: Metadata = JSON.parse(doc!.json);
    const saved = state.toolActors[String(api.taskId)];
    const run = saved ? state.runs[saved.runKey] : Object.values(state.runs).find(candidate => candidate.conversationId === api.conversationId && (candidate.status === "running" || candidate.status === "admitting"));
    if (!run || !["admitting", "running"].includes(run.status) || run.ownerId !== this.options.ownerId || (write && run.mode !== "write")) throw new RunnerError(403, "Tool has no authorized writable submission");
    await this.options.authorize(run.initiatedBy, run.mode === "ask" ? "ask" : "write");
    await api.commit(async tx => {
      const current = await tx.doc(RunnerState);
      const meta: Metadata = JSON.parse(current.json);
      meta.toolActors[String(api.taskId)] ??= { initiatedBy: run.initiatedBy, ownerId: run.ownerId, runKey: run.key, callId: api.callId };
      current.json = JSON.stringify(meta);
    }, context);
    return { initiatedBy: run.initiatedBy, actingAs: run.ownerId, mode: run.mode };
  }

  async recheck(attribution: { initiatedBy: string; mode: "write" | "ask" }): Promise<void> {
    await this.options.authorize(attribution.initiatedBy, attribution.mode === "ask" ? "ask" : "write");
  }

  async browserOutcome(approval: OperationRecord, recheck: () => Promise<void>, approvalText: (approval: StoredOperation) => ToolExecutionResult): Promise<ToolExecutionResult> {
    const report = approval.status === "executed" && approval.result ? parseBrowserReport(approval.result.trim()) : undefined;
    if (!report) return approvalText(approval as StoredOperation);
    const output: ToolExecutionResult["output"] = [{ type: "text", text: JSON.stringify({ ...approval, result: undefined, admissionId: undefined, callId: undefined, report }) }];
    if (report.screenshot) {
      try {
        const file = await this.options.sandbox.readContent(report.screenshot, recheck);
        const prepared = "image" in file ? await prepareImage(file.image, file.mimeType) : undefined;
        if (prepared && "image" in prepared) output.push({ type: "image", data: prepared.image.data, mimeType: prepared.image.mimeType });
      } catch { }
    }
    return { output };
  }

  async commandOptions(timeoutSeconds?: number): Promise<{ limits: CommandLimits; gpu: boolean }> {
    const config = await this.options.hostConfig();
    return { limits: callLimits(commandLimits(config.commandTimeoutSeconds), timeoutSeconds), gpu: config.gpu };
  }

  async check(api: ToolExecutionApi, tool: AnyToolName, effect: { write?: boolean; shell?: boolean } = {}): Promise<{ unbounded: boolean }> {
    const state = await this.options.metadata();
    const actor = state.toolActors[String(api.taskId)];
    const run = actor && state.runs[actor.runKey];
    if (!run) throw new RunnerError(403, "Tool has no authorized writable submission");
    await this.options.requireOwnerTool(tool);
    if (run.mode === "write") await this.options.requireSenderTool(tool, run.initiatedBy);
    if (effect.write && run.options?.access === "read") {
      throw new RunnerError(403, `${tool} changes things, which a Read-only message doesn't do: ask in a message that may act. Nothing ran.`);
    }
    return { unbounded: effect.shell === true && !this.options.hostCommands.shellAllowed() };
  }
}
