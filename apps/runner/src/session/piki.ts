import { createHash } from "node:crypto";
import type { ToolExecutionResult } from "@earendil-works/pi-durable";
import type { ModelRegistry } from "@earendil-works/pi-coding-agent";
import type { HostConfig } from "../../../../packages/shared/src/host-config.js";
import type { ChosenExtension } from "../../../../packages/shared/src/host-extensions.js";
import { EXTENSION_ARGUMENTS_SHOWN, type ExtensionToolOperation, type RunnerBinding } from "../../../../packages/shared/src/types.js";
import type { ExtensionHost } from "../extensions/adapter.js";
import { sandboxShellCommand, type CliRun, type PikiSandboxRun, type PikiSession } from "../extensions/piki/command.js";
import { commandLimits } from "../host-config.js";
import { RunnerError } from "../protocol.js";
import { SandboxProcessError } from "../sandbox.js";
import { inScriptCall } from "../script-output.js";
import { toolOutputPath } from "../tool-output.js";
import type { SessionWorkspace } from "../workspace.js";
import type { ApprovalWaits } from "./approval-waits.js";
import { HOST_COMMANDS_RULE, type HostCommandPolicy } from "./host-commands.js";
import type { SessionOperations } from "./operations.js";
import type { Metadata } from "./state.js";
import type { ToolCalls } from "./tools/calls.js";

type PikiCall = { write: boolean; forgeWrites: boolean; attribution: { initiatedBy: string; mode: "write" | "ask" }; script: boolean };

export interface SessionPikiOptions {
  binding: RunnerBinding;
  config: { pikiHostSignIn?: boolean; extensions?: { modelRegistry?: ModelRegistry } };
  sandbox: SessionWorkspace;
  onHost: boolean;
  sandboxed: boolean;
  calls: ToolCalls;
  hostCommands: HostCommandPolicy;
  waits: ApprovalWaits;
  operations: Pick<SessionOperations, "run">;
  apiLease(): { token: string; release(): void } | undefined;
  forgeWrites(senderId: string): Promise<boolean>;
  model(): { provider: string; modelId: string } | undefined;
  thinkingLevel(): string | undefined;
  extensionChoice(): Promise<{ chosen: ChosenExtension[]; automaticTools: boolean }>;
  metadata(): Promise<Metadata>;
  mutate(change: (state: Metadata) => void): Promise<void>;
  hostConfig(): Promise<HostConfig>;
}

export class SessionPiki {
  readonly #pikiCalls = new Map<string, PikiCall>();

  constructor(private readonly options: SessionPikiOptions) {}

  host(): ExtensionHost {
    const { binding, config } = this.options;
    return {
      directory: this.options.sandbox.hostWorktree,
      ...(config.extensions?.modelRegistry ? { modelRegistry: config.extensions.modelRegistry } : {}),
      model: () => {
        const current = this.options.model();
        return current && config.extensions?.modelRegistry?.find(current.provider, current.modelId) as never;
      },
      thinkingLevel: () => this.options.thinkingLevel(),
      state: async source => {
        const item = (await this.options.extensionChoice()).chosen.find(candidate => candidate.source === source);
        return { active: !!item, settings: item?.required?.settings ?? item?.workspace?.settings ?? {} };
      },
      runTool: (call, execute) => this.#runTool(call, execute),
      piki: this.#session(),
      hookTimeoutMs: 30_000,
      inputTimeoutMs: 60_000,
      warn: (source, message) => { process.stderr.write(`Session ${binding.session.id}, extension ${source}: ${message.replace(/[\x00-\x1f]/g, " ").slice(0, 500)}\n`); },
    };
  }

  #session(): PikiSession {
    const { binding, config, onHost } = this.options;
    const hostOwner = binding.session.connectorOwnerId;
    const ownSession = !!hostOwner && hostOwner === binding.owner.id;
    return {
      hostSignIn: onHost || (ownSession && config.pikiHostSignIn === true),
      ...(this.options.sandboxed && !onHost ? { sandbox: (run: PikiSandboxRun) => this.#runCommand(run) } : {}),
      saveOutput: (callId, tool, output) => this.#saveOutput(callId, tool, output),
      fromScript: callId => this.#pikiCalls.get(callId)?.script === true,
      forgeWrites: callId => this.#pikiCalls.get(callId)?.forgeWrites === true,
    };
  }

  async #saveOutput(callId: string, tool: string, output: string): Promise<string> {
    const call = this.#pikiCalls.get(callId);
    if (!call) throw new RunnerError(403, "its call no longer runs");
    const path = toolOutputPath(tool, callId);
    await this.options.calls.saveOutput(path, output, async () => { await this.options.calls.recheck(call.attribution); });
    return path;
  }

  async #runCommand(run: PikiSandboxRun): Promise<CliRun> {
    const call = this.#pikiCalls.get(run.callId);
    if (!call) throw new RunnerError(403, `${run.command} runs only in a call of its tool this session admitted. Nothing ran.`);
    const lease = call.write && !run.readOnly ? this.options.apiLease() : undefined;
    try {
      const env = { ...run.env };
      if (lease) for (const name of run.tokenEnv) env[name] = lease.token;
      const command = sandboxShellCommand(run.command, run.args, env, run.directory);
      const output = await this.options.sandbox.execute({ kind: "bash", command }, run.readOnly, () => this.options.calls.recheck(call.attribution), {
        unbounded: true, ...await this.options.calls.commandOptions(), signal: AbortSignal.any([run.signal, AbortSignal.timeout(run.timeoutSeconds * 1000)]) });
      return { exitCode: 0, signal: null, output };
    } catch (error) {
      if (!(error instanceof SandboxProcessError)) throw error;
      const output = [error.stdout, error.stderr].filter(Boolean).join("\n");
      return { exitCode: error.exitCode, signal: error.signal, output, ...(error.exitCode === null && !error.signal ? { failure: error.message } : {}) };
    } finally {
      lease?.release();
    }
  }

  async #runTool(call: Parameters<ExtensionHost["runTool"]>[0], execute: Parameters<ExtensionHost["runTool"]>[1]): Promise<ToolExecutionResult> {
    const { calls, waits } = this.options;
    const attribution = await calls.actor(call.api, true);
    const state = await this.options.metadata();
    const run = state.runs[state.toolActors[String(call.api.taskId)]!.runKey]!;
    if (run.options?.access === "read") {
      throw new RunnerError(403, `${call.tool} comes from an extension, which runs outside the sandbox: a Read-only message doesn't run it. Nothing ran.`);
    }
    const { chosen, automaticTools } = await this.options.extensionChoice();
    const item = chosen.find(candidate => candidate.source === call.source);
    if (!item) throw new RunnerError(403, `This extension (${call.source}) no longer applies to this session; ${call.tool} didn't run.`);
    const json = JSON.stringify(call.arguments);
    const operation: ExtensionToolOperation = { kind: "extension.tool", source: call.source, tool: call.tool,
      arguments: json.length > EXTENSION_ARGUMENTS_SHOWN ? `${json.slice(0, EXTENSION_ARGUMENTS_SHOWN)}…` : json,
      digest: createHash("sha256").update(json).digest("hex") };
    const trusted = await this.options.hostCommands.allowed(attribution.initiatedBy);
    if (!trusted && !automaticTools) throw new RunnerError(403, `${call.tool} comes from an extension, which ${HOST_COMMANDS_RULE}`);
    const approval = await this.options.operations.run(attribution.initiatedBy, operation, String(call.api.taskId), { hostChecked: true });
    if (approval.status !== "executing") throw new RunnerError(409, approval.result ?? `${call.tool} didn't run.`);
    const id = approval.id;
    await calls.recheck(attribution);
    const limits = commandLimits((await this.options.hostConfig()).commandTimeoutSeconds);
    const callId = String(call.api.callId);
    const forgeWrites = await this.options.forgeWrites(attribution.initiatedBy);
    this.#pikiCalls.set(callId, { write: trusted && forgeWrites, forgeWrites, attribution, script: inScriptCall() });
    try {
      const result = await execute(AbortSignal.any([call.signal, AbortSignal.timeout(limits.seconds * 1000)]));
      const shown = (result.output ?? []).map(part => part.type === "text" ? part.text : `[${part.type}]`).join("\n");
      await this.options.mutate(meta => { Object.assign(meta.approvals[id]!, { status: result.isError ? "failed" : "executed", result: waits.kept(id, shown || "(no output)") }); });
      return result;
    } catch (error) {
      await this.options.mutate(meta => { Object.assign(meta.approvals[id]!, { status: "failed", result: waits.kept(id, error instanceof Error ? error.message : String(error)) }); }).catch(() => {});
      throw error;
    } finally {
      this.#pikiCalls.delete(callId);
    }
  }
}
