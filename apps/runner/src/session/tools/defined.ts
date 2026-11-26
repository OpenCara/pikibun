import { StringEnum } from "@earendil-works/pi-ai";
import { defineTool, type ToolRegistration } from "@earendil-works/pi-durable";
import { arr, bool, compile, int, obj, opt, str, unsafe } from "@earendil-works/pi-schema";
import type { ToolDefinition } from "../../../../../packages/shared/src/tool-definitions.js";
import { accountCommandRefusal, brokeredArguments, programCommand, programRequest, type ProgramRequest } from "../../defined-tools.js";
import { callTimeout } from "../../host-config.js";
import { programLimits } from "../../program-command.js";
import { callEnvironment, defaultedTimeout } from "../../program-defaults.js";
import { RunnerError } from "../../protocol.js";
import { text, type ToolContext } from "./context.js";
import { callEnvironmentParameter, callTimeoutParameter, programHints } from "./programs.js";

export function definedTool(context: ToolContext, definition: ToolDefinition): ToolRegistration {
  const { binding, calls, config, hostCommands, sandbox } = context;
  if (definition.kind === "program") {
    return defineTool({ name: definition.name, description: definition.description, executionMode: "sequential",
      parameters: obj({ program: StringEnum([...definition.programs]), args: opt(arr(str(), { maxItems: programLimits.arguments })), directory: opt(str()),
        timeout_seconds: callTimeoutParameter(), env: callEnvironmentParameter() }, { open: true }),
      execute: async (args, api, call) => {
        await context.requireSessionTool(definition.name);
        let request: ProgramRequest;
        let command: string;
        let timeout: { seconds?: number; defaulted: boolean };
        try {
          request = programRequest(definition, args, "keep");
          command = programCommand(definition, request, { ...(sandbox.nodeBin ? { nodeBin: sandbox.nodeBin } : {}), environment: callEnvironment(args.env) });
          timeout = defaultedTimeout(request.program, request.args, callTimeout(args.timeout_seconds));
        }
        catch (error) { throw new RunnerError(400, `${error instanceof Error ? error.message : `Invalid ${definition.name} call`}. Nothing ran.`); }
        if (request.accountCommand !== undefined) {
          await hostCommands.requireAccountCommand((await calls.actor(api, true)).initiatedBy, accountCommandRefusal(definition, request.accountCommand));
        }
        const missing = context.programMissing(definition, request.program);
        if (missing) throw new RunnerError(400, `${missing} Nothing ran.`);
        const attribution = await calls.actor(api, true);
        await hostCommands.requireHostEnvironment();
        const { unbounded } = await calls.check(api, definition.name, { write: true, shell: true });
        const approval = await context.operations.run(attribution.initiatedBy, { kind: "program", tool: definition.name, command }, String(api.taskId),
          { unbounded, ...(timeout.seconds !== undefined ? { timeoutSeconds: timeout.seconds } : {}) }, call.abortSignal);
        return text(await calls.shownApproval(programHints(context, approval, request.directory, timeout.defaulted), api, definition.name));
      } });
  }
  if (definition.inputSchema) {
    const validators = new Map<string, ReturnType<typeof compile>>();
    const validatorOf = (schema: object) => {
      const key = JSON.stringify(schema);
      let found = validators.get(key);
      if (!found) validators.set(key, found = compile(schema, { unresolvedRefs: "reject" }));
      return found;
    };
    return defineTool({ name: definition.name, description: definition.description, parameters: unsafe<Record<string, unknown>>(definition.inputSchema),
      execute: async (input, api, _call) => {
        await context.requireSessionTool(definition.name);
        const current = await context.remoteDefinition(definition.name);
        if (!current) throw new RunnerError(403, `${definition.name} is no longer offered in this workspace. Nothing ran.`);
        const attribution = await calls.actor(api, current.write);
        const args = (input ?? {}) as Record<string, unknown>;
        const errors = validatorOf(current.inputSchema!).errors(args);
        if (errors.length) {
          throw new RunnerError(400, `${definition.name}: ${errors.slice(0, 3).map(error => `${error.path || "arguments"} ${error.message}`).join("; ").slice(0, 500)}. Nothing ran.`);
        }
        await calls.check(api, definition.name, current.write ? { write: true } : {});
        const state = await context.metadata();
        const run = state.runs[state.toolActors[String(api.taskId)]!.runKey]!;
        if (!run.admissionId) throw new RunnerError(403, `${definition.name} needs a message, not a side question`);
        const request = { sessionId: binding.session.id, actorId: run.initiatedBy, admissionId: run.admissionId, callId: String(api.taskId), arguments: args };
        await context.authorize(run.initiatedBy, "write");
        const result = config.brokered ? await config.brokered(current.route, request) : await context.operations.internalBroker(current.route, request);
        return text({ ...attribution, ...(result && typeof result === "object" && !Array.isArray(result) ? result : { result }) });
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
    execute: async (input, api, _call) => {
      await context.requireSessionTool(definition.name);
      const attribution = await calls.actor(api, definition.write);
      let args: Record<string, unknown>;
      try { args = brokeredArguments(definition, input as Record<string, unknown>); }
      catch (error) { throw new RunnerError(400, error instanceof Error ? error.message : `Invalid ${definition.name} call`); }
      await calls.check(api, definition.name, definition.write ? { write: true } : {});
      const state = await context.metadata();
      const run = state.runs[state.toolActors[String(api.taskId)]!.runKey]!;
      if (!run.admissionId) throw new RunnerError(403, `${definition.name} needs a write message`);
      const request = { sessionId: binding.session.id, actorId: run.initiatedBy, admissionId: run.admissionId, callId: String(api.taskId), ...args };
      await context.authorize(run.initiatedBy, "write");
      const result = config.brokered ? await config.brokered(definition.route, request) : await context.operations.internalBroker(definition.route, request);
      return text({ ...attribution, ...(result && typeof result === "object" && !Array.isArray(result) ? result : { result }) });
    } });
}
