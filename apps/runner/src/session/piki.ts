import { createHash } from "node:crypto";
import type { ToolExecutionResult } from "@earendil-works/pi-durable";
import type { ModelRegistry } from "@earendil-works/pi-coding-agent";
import type { HostConfig } from "../../../../packages/shared/src/host-config.js";
import type { ChosenExtension } from "../../../../packages/shared/src/host-extensions.js";
import type { ApiReach } from "../../../../packages/shared/src/network.js";
import { EXTENSION_ARGUMENTS_SHOWN, type ExtensionToolOperation, type RunnerBinding } from "../../../../packages/shared/src/types.js";
import type { ExtensionHost } from "../extensions/adapter.js";
import { completeWith, modelCallSources } from "../extensions/complete.js";
import { cliRules } from "../extensions/piki/cli-engine.js";
import type { CliDefinition } from "../../../../packages/shared/src/cli-definitions.js";
import { sandboxShellCommand, type CliRun, type PikiSandboxRun, type PikiSession } from "../extensions/piki/command.js";
import { configuredLimits } from "../host-config.js";
import { RunnerError } from "../protocol.js";
import { SandboxProcessError } from "../sandbox.js";
import { inScriptCall } from "../script-output.js";
import { toolOutputPath } from "../tool-output.js";
import type { SessionWorkspace } from "../workspace.js";
import type { WholeResults } from "./whole-results.js";
import { HOST_COMMANDS_RULE, type HostCommandPolicy } from "./host-commands.js";
import type { SessionOperations } from "./operations.js";
import type { Metadata } from "./state.js";
import type { ToolCalls } from "./tools/calls.js";

type PikiCall = { write: boolean; forgeWrites: boolean; attribution: { initiatedBy: string; mode: "write" | "ask" }; script: boolean };

export interface SessionPikiOptions {
  binding: RunnerBinding;
  config: { pikiHostSignIn?: boolean; extensions?: { modelRegistry?: ModelRegistry }; cliDefinitions?: () => Promise<readonly CliDefinition[]> };
  sandbox: SessionWorkspace;
  onHost: boolean;
  sandboxed: boolean;
  calls: ToolCalls;
  hostCommands: HostCommandPolicy;
  wholeResults: WholeResults;
  operations: Pick<SessionOperations, "run">;
  apiLease(options?: { reach?: ApiReach }): { token: string; release(): void } | undefined;
  forgeWrites(senderId: string): Promise<boolean>;
  model(): { provider: string; modelId: string } | undefined;
  thinkingLevel(): string | undefined;
  extensionChoice(): Promise<{ chosen: ChosenExtension[]; automaticTools: boolean }>;
  metadata(): Promise<Metadata>;
  mutate(change: (state: Metadata) => void): Promise<void>;
  hostConfig(): Promise<HostConfig>;
  extensionProcess?: ExtensionHost["extensionProcess"];
}

export class SessionPiki {
  readonly #pikiCalls = new Map<string, PikiCall>();

  constructor(private readonly options: SessionPikiOptions) {}

  host(): ExtensionHost {
    const { binding, config } = this.options;
    const model = () => {
      const current = this.options.model();
      return current && config.extensions?.modelRegistry?.find(current.provider, current.modelId) as never;
    };
    const registry = config.extensions?.modelRegistry;
    const modelCallsAllowed = async (source: string) => modelCallSources.has(source)
      || (await this.options.extensionChoice()).chosen.some(item => item.source === source && item.required?.allowModelCalls === true);
    return {
      directory: this.options.sandbox.hostWorktree,
      ...(registry ? {
        modelRegistry: registry,
        modelCallsAllowed,
        complete: async (request, signal) => {
          if (!await modelCallsAllowed(request.source)) throw new Error("This host's owner no longer lets this extension call models.");
          return completeWith({ modelRegistry: registry, model }, request, signal);
        },
      } : {}),
      model,
      thinkingLevel: () => this.options.thinkingLevel(),
      state: async source => {
        const item = (await this.options.extensionChoice()).chosen.find(candidate => candidate.source === source);
        return { active: !!item, settings: item?.required?.settings ?? item?.workspace?.settings ?? {} };
      },
      runTool: (call, execute) => this.#runTool(call, execute),
      piki: this.#session(),
      hookTimeoutMs: 30_000,
      inputTimeoutMs: 60_000,
      commandTimeoutMs: 120_000,
      warn: (source, message) => { process.stderr.write(`Session ${binding.session.id}, extension ${source}: ${message.replace(/[\x00-\x1f]/g, " ").slice(0, 500)}\n`); },
      ...(this.options.extensionProcess ? { extensionProcess: this.options.extensionProcess } : {}),
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
      ...(config.cliDefinitions ? { servedRules: async (name: string) => {
        const served = (await config.cliDefinitions!().catch(() => [])).find(item => item.name === name);
        return served ? cliRules(served) : undefined;
      } } : {}),
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
    const ownerSent = call.attribution.initiatedBy === this.options.binding.owner.id;
    const lease = call.write && !run.readOnly ? this.options.apiLease(ownerSent ? { reach: "any" } : {}) : undefined;
    try {
      const env = { ...run.env };
      if (lease) for (const name of run.tokenEnv) env[name] = lease.token;
      const command = sandboxShellCommand(run.command, run.args, env, run.directory);
      const output = await this.options.sandbox.execute({ kind: "bash", command }, run.readOnly, () => this.options.calls.recheck(call.attribution), {
        unbounded: true, ...await this.options.calls.commandOptions(), ...(run.binds.length ? { binds: run.binds } : {}), signal: AbortSignal.any([run.signal, AbortSignal.timeout(run.timeoutSeconds * 1000)]) });
      return { exitCode: 0, signal: null, output };
    } catch (error) {
      if (!(error instanceof SandboxProcessError)) throw error;
      const output = [error.stdout, error.stderr].filter(Boolean).join("\n");
      return { exitCode: error.exitCode, signal: error.signal, output, ...(error.exitCode === null && !error.signal ? { failure: error.message } : {}) };
    } finally {
      lease?.release();
    }
  }

  async #extensionMayRun(actorId: string, sandboxed: boolean, automaticTools: boolean, what: string): Promise<boolean | undefined> {
    const inSandbox = sandboxed && !this.options.hostCommands.runsOnHost({ kind: "bash", command: "" }, !this.options.hostCommands.shellAllowed());
    if (inSandbox || automaticTools) return undefined;
    if (await this.options.hostCommands.allowed(actorId)) return true;
    throw new RunnerError(403, sandboxed
      ? `${what}, which runs in the sandbox but, on this host, without resource limits, as the session's commands do here: only in sessions of the `
        + "host's owner and of members they granted host commands (Settings → Hosts → the host → Host command access), for messages of theirs. Nothing ran."
      : `${what}, which ${HOST_COMMANDS_RULE}`);
  }

  async requireCommand(actorId: string, source: string, name: string, sandboxed: boolean): Promise<void> {
    const { chosen, automaticTools } = await this.options.extensionChoice();
    if (!chosen.some(candidate => candidate.source === source)) throw new RunnerError(403, `This extension (${source}) no longer applies to this session; /${name} didn't run.`);
    await this.#extensionMayRun(actorId, sandboxed, automaticTools, `/${name} is a command of an extension (${source})`);
  }

  async #runTool(call: Parameters<ExtensionHost["runTool"]>[0], execute: Parameters<ExtensionHost["runTool"]>[1]): Promise<ToolExecutionResult> {
    const { calls, wholeResults } = this.options;
    const attribution = await calls.actor(call.api, true);
    const state = await this.options.metadata();
    const run = state.runs[state.toolActors[String(call.api.taskId)]!.runKey]!;
    if (run.options?.access === "read") {
      throw new RunnerError(403, call.sandboxed
        ? `${call.tool} comes from an extension, whose tools may change things, which a Read-only message doesn't do: ask in a message that may act. Nothing ran.`
        : `${call.tool} comes from an extension, which runs outside the sandbox: a Read-only message doesn't run it. Nothing ran.`);
    }
    const { chosen, automaticTools } = await this.options.extensionChoice();
    const item = chosen.find(candidate => candidate.source === call.source);
    if (!item) throw new RunnerError(403, `This extension (${call.source}) no longer applies to this session; ${call.tool} didn't run.`);
    const json = JSON.stringify(call.arguments);
    const operation: ExtensionToolOperation = { kind: "extension.tool", source: call.source, tool: call.tool,
      arguments: json.length > EXTENSION_ARGUMENTS_SHOWN ? `${json.slice(0, EXTENSION_ARGUMENTS_SHOWN)}…` : json,
      digest: createHash("sha256").update(json).digest("hex") };
    const trusted = await this.#extensionMayRun(attribution.initiatedBy, call.sandboxed === true, automaticTools, `${call.tool} comes from an extension`)
      ?? await this.options.hostCommands.allowed(attribution.initiatedBy);
    const approval = await this.options.operations.run(attribution.initiatedBy, operation, String(call.api.taskId), { hostChecked: true });
    if (approval.status !== "executing") throw new RunnerError(409, approval.result ?? `${call.tool} didn't run.`);
    const id = approval.id;
    await calls.recheck(attribution);
    const limits = configuredLimits(await this.options.hostConfig());
    const callId = String(call.api.callId);
    const forgeWrites = await this.options.forgeWrites(attribution.initiatedBy);
    this.#pikiCalls.set(callId, { write: trusted && forgeWrites, forgeWrites, attribution, script: inScriptCall() });
    try {
      const result = await execute(AbortSignal.any([call.signal, AbortSignal.timeout(limits.seconds * 1000)]));
      const shown = (result.output ?? []).map(part => part.type === "text" ? part.text : `[${part.type}]`).join("\n");
      await this.options.mutate(meta => { Object.assign(meta.approvals[id]!, { status: result.isError ? "failed" : "executed", result: wholeResults.kept(id, shown || "(no output)") }); });
      return result;
    } catch (error) {
      await this.options.mutate(meta => { Object.assign(meta.approvals[id]!, { status: "failed", result: wholeResults.kept(id, error instanceof Error ? error.message : String(error)) }); }).catch(() => {});
      throw error;
    } finally {
      this.#pikiCalls.delete(callId);
    }
  }
}
