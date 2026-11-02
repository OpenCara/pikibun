import { createHash } from "node:crypto";
import { CompactionTask, defineExtension, defineTool, GenerationTask, hook, section, ToolTask, type Extension, type HookRegistration,
  type ToolExecutionApi, type ToolExecutionResult, type ToolRegistration } from "@earendil-works/pi-durable";
import { validateToolArguments, type ImageContent, type TextContent, type TSchema } from "@earendil-works/pi-ai";
import type { HostExtensionEvent, JsonObject, JsonValue } from "../../../../packages/shared/src/host-extensions.js";
import type { ExtensionContext, ExtensionHandlers, ExtensionSession, ExtensionTool, ExtensionToolResult } from "./api.js";
import { register, type LoadedExtension, type Registrations } from "./load.js";

/*
 * Builds a host extension into a pi-durable Extension for one session (docs/design/host-extensions.md): its tools, a
 * prompt section, and hooks of the built-in tasks. Every part asks the session whether the extension still applies
 * (enabled, and the session in its scope) each time it runs, so turning one off reaches running sessions at their next
 * request or call; the session also selects only the extensions that apply for each message (Session.applyOptions).
 */

/** What the session gives its extensions. */
export interface ExtensionHost {
  readonly session: ExtensionSession;
  /** Whether `extension` applies to the session now, with its configured settings (not yet checked against its schema). */
  state(extension: string): Promise<{ active: boolean; settings: JsonObject }>;
  /**
   * Runs one tool call of `extension` as the session allows it: refusing it, asking for approval, or running it at once.
   * `execute` runs the extension's code with a signal that aborts when the call stops or reaches its time limit.
   */
  runTool(call: { extension: string; tool: string; arguments: JsonObject; api: ToolExecutionApi; signal: AbortSignal },
    execute: (signal: AbortSignal) => Promise<ToolExecutionResult>): Promise<ToolExecutionResult>;
  /** How long one hook may take. */
  readonly hookTimeoutMs: number;
  /** A hook that failed; logged on the host, never shown to the model. */
  warn(extension: string, message: string): void;
}

export interface BuiltExtension {
  name: string;
  extension: Extension;
  tools: ToolRegistration[];
}

/** The pi-durable name of host extension `name`, distinct from Pikibun's own `workspace-tools`. */
export const extensionName = (name: string) => `host:${name}`;

/** Its prompt section's key, which pi-durable takes in lower-case letters, digits, `_` and `-`: unique by a digest of the name. */
const sectionKey = (name: string) => `host-extension-${name.replace(/[^a-z0-9_-]+/g, "-").slice(0, 48)}-${createHash("sha256").update(name).digest("hex").slice(0, 8)}`;

/**
 * The settings `configured` stands for under `schema`: its top-level defaults filled in, then checked against it.
 * Throws what's wrong, for the tool call or hook that needs them.
 */
export function resolveSettings(name: string, schema: TSchema | undefined, configured: JsonObject): JsonObject {
  if (!schema) return configured;
  const properties = (schema as { properties?: Record<string, { default?: JsonValue }> }).properties ?? {};
  const filled: JsonObject = { ...configured };
  for (const [key, property] of Object.entries(properties)) {
    if (filled[key] === undefined && property && typeof property === "object" && property.default !== undefined) filled[key] = structuredClone(property.default);
  }
  try {
    return validateToolArguments({ name: "settings", description: "", parameters: schema }, { type: "toolCall", id: "settings", name: "settings", arguments: filled }) as JsonObject;
  } catch {
    throw new Error(`${name}'s settings in Pikibun don't match what it takes: fix them under Settings → Hosts → the host → Extensions.`);
  }
}

function withTimeout<T>(work: () => T | Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  return Promise.race([
    Promise.resolve().then(work),
    new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`${what} took longer than ${Math.round(ms / 1000)} seconds`)), ms); timer.unref(); }),
  ]).finally(() => clearTimeout(timer));
}

const describe = (error: unknown) => error instanceof Error ? error.message : String(error);

function toolResult(result: ExtensionToolResult): ToolExecutionResult {
  if (typeof result === "string") return { output: [{ type: "text", text: result }] };
  if (!result || typeof result !== "object") throw new Error("A tool returns a string or { content }");
  const content = result.content?.filter(part => part && (part.type === "text" || part.type === "image"));
  return { ...(content ? { output: content } : {}), ...(result.isError ? { isError: true } : {}), ...(result.details !== undefined ? { details: result.details } : {}) };
}

/** Builds `loaded` for one session; undefined for one that failed to load. */
export async function buildExtension(loaded: LoadedExtension, host: ExtensionHost): Promise<BuiltExtension | undefined> {
  const { factory, summary } = loaded;
  if (!factory) return undefined;
  const name = summary.name;
  let current: JsonObject = {};
  // The factory runs again for this session: its registrations, and closures, are the session's own.
  const registrations: Registrations = await register(name, factory, () => current);
  const settings = async (): Promise<{ active: boolean; ctx: ExtensionContext }> => {
    const state = await host.state(name);
    if (!state.active) return { active: false, ctx: { session: host.session, settings: current } };
    current = resolveSettings(name, registrations.settingsSchema, state.settings);
    return { active: true, ctx: { session: host.session, settings: current } };
  };
  const handlers = <Event extends HostExtensionEvent>(event: Event) => (registrations.handlers[event] ?? []) as ExtensionHandlers[Event][];
  /** Runs `event`'s handlers in order while the extension applies; a failing one is skipped (logged), unless `strict`. */
  async function each<Event extends HostExtensionEvent>(event: Event, call: (handler: ExtensionHandlers[Event], ctx: ExtensionContext) => unknown,
    { strict = false }: { strict?: boolean } = {}): Promise<void> {
    let state: Awaited<ReturnType<typeof settings>>;
    try { state = await settings(); }
    catch (error) {
      if (strict) throw error;
      host.warn(name, describe(error));
      return;
    }
    if (!state.active) return;
    for (const handler of handlers(event)) {
      try { await withTimeout(() => call(handler, state.ctx), host.hookTimeoutMs, `${name}'s ${event} handler`); }
      catch (error) {
        if (strict) throw new Error(`${name}'s ${event} handler failed: ${describe(error)}`);
        host.warn(name, `${event}: ${describe(error)}`);
      }
    }
  }

  const tools = registrations.tools.map(tool => wrapTool(name, tool, host, settings));
  const hooks: HookRegistration[] = [];
  const sections = handlers("before_agent_start").length ? [section(sectionKey(name), async () => {
    const parts: string[] = [];
    await each("before_agent_start", async (handler, ctx) => {
      const text = await handler(ctx);
      if (typeof text === "string" && text.trim()) parts.push(text.trim());
    });
    return parts.length ? `<host_extension name="${name}">\n${parts.join("\n\n")}\n</host_extension>` : undefined;
  }, { tag: false })] : [];

  if (handlers("tool_call").length || handlers("tool_result").length) {
    hooks.push(hook(ToolTask, {
      ...(handlers("tool_call").length ? {
        // A throw blocks the call (pi-durable's rule): a guard that fails never lets a call it would have stopped through.
        beforeTool: async call => {
          let decision: { block?: string; arguments?: JsonObject } | undefined;
          let args = call.arguments as JsonObject;
          await each("tool_call", async (handler, ctx) => {
            if (decision?.block) return;
            const result = await handler({ id: call.id, name: call.name, arguments: args }, ctx);
            if (!result) return;
            if ("block" in result && typeof result.block === "string") decision = { block: result.block };
            else if ("arguments" in result && result.arguments && typeof result.arguments === "object") { args = result.arguments; decision = { arguments: args }; }
          }, { strict: true });
          return decision;
        },
      } : {}),
      ...(handlers("tool_result").length ? {
        afterTool: async (call, result) => {
          let replaced: ToolExecutionResult | undefined;
          await each("tool_result", async (handler, ctx) => {
            const current = replaced ?? result;
            const next = await handler({ id: call.id, name: call.name, arguments: call.arguments }, { content: (current.output ?? []) as (TextContent | ImageContent)[], isError: current.isError === true }, ctx);
            if (next && Array.isArray(next.content)) replaced = { ...current, output: next.content, ...(next.isError !== undefined ? { isError: next.isError } : {}) };
          });
          return replaced;
        },
      } : {}),
    }));
  }
  if (handlers("context").length || handlers("turn_end").length || handlers("message_end").length || handlers("agent_before_settle").length) {
    hooks.push(hook(GenerationTask, {
      ...(handlers("context").length ? {
        beforeRequest: async request => {
          let messages = request.messages;
          let changed = false;
          await each("context", async (handler, ctx) => {
            const next = await handler(messages, ctx);
            if (Array.isArray(next)) { messages = next; changed = true; }
          });
          return changed ? { messages } : undefined;
        },
      } : {}),
      ...(handlers("message_end").length ? { afterResponse: async message => { await each("message_end", (handler, ctx) => handler(message, ctx)); } } : {}),
      ...(handlers("turn_end").length ? { afterTools: async () => { await each("turn_end", (handler, ctx) => handler(ctx)); } } : {}),
      ...(handlers("agent_before_settle").length ? {
        onYield: async answer => {
          let next: string | undefined;
          await each("agent_before_settle", async (handler, ctx) => {
            if (next !== undefined) return;
            const result = await handler(answer, ctx);
            if (result && typeof result.continue === "string" && result.continue.trim()) next = result.continue;
          });
          return next !== undefined ? { continue: next } : undefined;
        },
      } : {}),
    }));
  }
  if (handlers("session_before_compact").length) {
    hooks.push(hook(CompactionTask, {
      beforeCompact: async compaction => {
        let decision: { decline: true } | { summary: string } | undefined;
        await each("session_before_compact", async (handler, ctx) => {
          if (decision) return;
          const result = await handler({ reason: compaction.reason, messages: compaction.messages, ...(compaction.instructions ? { instructions: compaction.instructions } : {}) }, ctx);
          if (result && "decline" in result && result.decline === true) decision = { decline: true };
          else if (result && "summary" in result && typeof result.summary === "string" && result.summary.trim()) decision = { summary: result.summary };
        });
        return decision;
      },
    }));
  }
  return { name, extension: defineExtension({ name: extensionName(name), tools, sections, hooks }), tools };
}

function wrapTool(name: string, tool: ExtensionTool, host: ExtensionHost, settings: () => Promise<{ active: boolean; ctx: ExtensionContext }>): ToolRegistration {
  return defineTool({
    name: tool.name, description: tool.description, parameters: tool.parameters,
    ...(tool.replay ? { replay: tool.replay } : {}), ...(tool.executionMode ? { executionMode: tool.executionMode } : {}),
    execute: async (args, api, call) => {
      const state = await settings();
      if (!state.active) throw new Error(`${name} is turned off for this session on its host; ${tool.name} didn't run.`);
      return host.runTool({ extension: name, tool: tool.name, arguments: args as JsonObject, api, signal: call.abortSignal ?? new AbortController().signal }, async signal => {
        const result = await tool.execute(args as never, { ...state.ctx, signal, callId: api.callId, output: chunk => api.output(String(chunk)) });
        return toolResult(result);
      });
    },
  });
}
