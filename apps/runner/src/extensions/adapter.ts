import { createHash } from "node:crypto";
import type { Context } from "@earendil-works/chord";
import { CompactionTask, defineDoc, defineExtension, defineTool, GenerationTask, hook, section, ToolTask, type Extension, type HookRegistration,
  type ToolExecutionApi, type ToolExecutionResult, type ToolRegistration } from "@earendil-works/pi-durable";
import type { ImageContent, Message, Model, TextContent } from "@earendil-works/pi-ai";
import { createEventBus, createExtensionRuntime, ExtensionRunner, SessionManager, type AgentToolResult, type ExtensionActions,
  type ExtensionContextActions, type ModelRegistry, type ToolCallEvent, type ToolResultEvent } from "@earendil-works/pi-coding-agent";
import { isJsonValue } from "./json.js";
import type { ExtensionSettings } from "../../../../packages/shared/src/host-extensions.js";
import { piLoader, type LoadedSource } from "./load.js";

/*
 * Runs a session's Pi extensions on pi-durable (docs/design/host-extensions.md). Each source gets its own Pi
 * ExtensionRunner, loaded for this session, so Pi's own rules compose its handlers' results; Pikibun builds it into a
 * pi-durable Extension: its tools, a prompt section, and hooks of the built-in tasks. Every part asks the session whether
 * the source still applies before it runs, so turning one off reaches running sessions at their next use.
 */

/** What the session gives its extensions. */
export interface ExtensionHost {
  /** The session's worktree on the host: the extensions' `cwd`. */
  readonly directory: string;
  /** The host's Pi model registry, as `ctx.modelRegistry`; without one, extensions that use it fail when they do. */
  readonly modelRegistry?: ModelRegistry;
  /** The model the session's conversation runs on, as Pi's `ctx.model`. */
  model(): Model<string> | undefined;
  /** Whether `source` applies to the session now, and its settings (flag values). */
  state(source: string): Promise<{ active: boolean; settings: ExtensionSettings }>;
  /**
   * Runs one tool call of `source` as the session allows it: refusing it, asking for approval, or running it at once.
   * `execute` runs the extension's code with a signal that aborts when the call stops or reaches its time limit.
   */
  runTool(call: { source: string; tool: string; arguments: Record<string, unknown>; api: ToolExecutionApi; signal: AbortSignal; context: Context },
    execute: (signal: AbortSignal) => Promise<ToolExecutionResult>): Promise<ToolExecutionResult>;
  /** How long one event's handlers may take. */
  readonly hookTimeoutMs: number;
  /** An extension's error; logged on the host, never shown to the model. */
  warn(source: string, message: string): void;
}

/**
 * What each source's `before_agent_start` handlers added for the message running in a conversation, written when the
 * message starts (SessionExtensions.beforeAgentStart) and shown by the source's prompt section for the rest of it.
 */
export const ExtensionPrompts = defineDoc<{ prompts: Record<string, string> }>({ kind: "pikibun.extension-prompts", version: 1, scope: "conversation",
  history: "latest", fork: "current", initial: () => ({ prompts: {} }), checkpointWhen: () => true });

/** A short, stable name for a source in pi-durable: its extension's name and its prompt section's key. */
export const extensionKey = (source: string) => `pikibun-extension-${createHash("sha256").update(source).digest("hex").slice(0, 12)}`;

export interface SessionExtension {
  source: string;
  dev: boolean;
  extension: Extension;
  tools: ToolRegistration[];
  runner: ExtensionRunner;
}

function withTimeout<T>(work: () => T | Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  return Promise.race([
    Promise.resolve().then(work),
    new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`${what} took longer than ${Math.round(ms / 1000)} seconds`)), ms); timer.unref(); }),
  ]).finally(() => clearTimeout(timer));
}

const describe = (error: unknown) => error instanceof Error ? error.message : String(error);
const textOf = (content: unknown) => typeof content === "string" ? content
  : Array.isArray(content) ? content.map(part => part && typeof part === "object" && (part as TextContent).type === "text" ? (part as TextContent).text : "").join("") : "";

/** The text an extension's system prompt changes add: what follows the base, or else the lines the base doesn't have. */
export function addedPrompt(base: string, final: string): string {
  if (final === base) return "";
  if (final.startsWith(base)) return final.slice(base.length).trim();
  const lines = new Set(base.split("\n"));
  return final.split("\n").filter(line => !lines.has(line)).join("\n").trim();
}

/**
 * A session's extensions: one Pi ExtensionRunner and one pi-durable Extension per source, opened as the session first
 * runs with each. A tool named like one the session already has (Pikibun's own, or an earlier extension's) is left out.
 */
export class SessionExtensions {
  readonly extensions: SessionExtension[] = [];
  readonly #taken: Set<string>;
  #started = false;

  /** `taken`: the session's own tool names. */
  constructor(private readonly host: ExtensionHost, taken: Iterable<string> = []) {
    this.#taken = new Set(taken);
  }

  get(source: string): SessionExtension | undefined { return this.extensions.find(item => item.source === source); }

  /**
   * Opens those of `sources` the session hasn't opened yet, in order, and returns them; once the session started, each
   * gets `session_start`. A source that fails is left out, and logged.
   */
  async ensure(sources: readonly LoadedSource[]): Promise<SessionExtension[]> {
    const { loadExtensions } = await piLoader();
    const opened: SessionExtension[] = [];
    for (const loaded of sources) {
      const source = loaded.summary.source;
      if (this.get(source) || loaded.summary.error) continue;
      try {
        const runtime = createExtensionRuntime();
        const result = await loadExtensions(loaded.files, this.host.directory, createEventBus(), runtime);
        for (const error of result.errors) this.host.warn(source, error.error);
        const runner = new ExtensionRunner(result.extensions, runtime, this.host.directory, SessionManager.inMemory(this.host.directory),
          this.host.modelRegistry ?? (undefined as never));
        runner.bindCore(noActions(runner, message => this.host.warn(source, message)), contextActions(this.host));
        runner.onError(error => this.host.warn(source, `${error.event}: ${error.error}`));
        const allowed = new Set<string>();
        for (const name of loaded.summary.modules.flatMap(module => module.tools.map(tool => tool.name))) {
          if (this.#taken.has(name)) { this.host.warn(source, `tool ${name} is left out: the session already has a tool named so`); continue; }
          allowed.add(name);
          this.#taken.add(name);
        }
        const extension = build(source, loaded.summary.dev, runner, allowed, this.host);
        this.extensions.push(extension);
        opened.push(extension);
      } catch (error) {
        this.host.warn(source, `didn't load: ${describe(error)}`);
      }
    }
    if (this.#started) for (const extension of opened) await this.one(extension, "session_start", runner => runner.emit({ type: "session_start", reason: "startup" }));
    return opened;
  }

  private async one(extension: SessionExtension, event: string, work: (runner: ExtensionRunner, source: string) => Promise<unknown>): Promise<void> {
    if (!(await applyState(this.host, extension.source, extension.runner))) return;
    try { await withTimeout(() => work(extension.runner, extension.source), this.host.hookTimeoutMs, `${event}`); }
    catch (error) { this.host.warn(extension.source, `${event}: ${describe(error)}`); }
  }

  /** Runs `event` on every source that applies; one that fails or times out is logged. */
  private async each(event: string, work: (runner: ExtensionRunner, source: string) => Promise<unknown>): Promise<void> {
    for (const extension of this.extensions) await this.one(extension, event, work);
  }

  sessionStart(): Promise<void> {
    this.#started = true;
    return this.each("session_start", runner => runner.emit({ type: "session_start", reason: "startup" }));
  }

  /** At a message's start: `agent_start`, then `before_agent_start` with its prompt; returns what each source adds to the system prompt. */
  async beforeAgentStart(prompt: string, images: ImageContent[] | undefined): Promise<Record<string, string>> {
    const prompts: Record<string, string> = {};
    await this.each("agent_start", runner => runner.emit({ type: "agent_start" }));
    const { buildSystemPrompt } = await import(new URL("./core/system-prompt.js", import.meta.resolve("@earendil-works/pi-coding-agent")).href) as
      { buildSystemPrompt(options: { cwd: string; selectedTools?: string[] }): string };
    await this.each("before_agent_start", async (runner, source) => {
      if (!runner.hasHandlers("before_agent_start")) return;
      const options = { cwd: this.host.directory, selectedTools: [] as string[] };
      const base = buildSystemPrompt(options);
      const result = await runner.emitBeforeAgentStart({ messageType: "user", prompt, ...(images?.length ? { images } : {}) }, options);
      const final = buildSystemPrompt(result.systemPromptOptions as never);
      const parts = [addedPrompt(base, final), ...result.messages.map(message => textOf(message.content).trim())].filter(Boolean);
      if (parts.length) prompts[source] = parts.join("\n\n");
    });
    return prompts;
  }

  agentEnd(messages: Message[], aborted: boolean): Promise<void> {
    return (async () => {
      await this.each("agent_end", runner => runner.emit({ type: "agent_end", messages } as never));
      await this.each("agent_settled", runner => runner.emit({ type: "agent_settled", aborted }));
    })();
  }

  /** When the session closes: `session_shutdown`, then the runners stop. */
  async shutdown(): Promise<void> {
    await this.each("session_shutdown", runner => runner.emit({ type: "session_shutdown", reason: "quit" }));
    for (const extension of this.extensions) {
      try { extension.runner.shutdown(); } catch { /* Already stopped. */ }
    }
  }
}

/** Sets the source's flags from its settings; false where it doesn't apply now. */
async function applyState(host: ExtensionHost, source: string, runner: ExtensionRunner): Promise<boolean> {
  const state = await host.state(source);
  if (!state.active) return false;
  for (const [name, flag] of runner.getFlags()) {
    const value = state.settings[name] ?? flag.default;
    if (value !== undefined && typeof value === flag.type) runner.setFlagValue(name, value);
  }
  return true;
}

/** What Pi's print mode leaves an extension: actions that change the session do nothing here, and say so once. */
function noActions(runner: ExtensionRunner, warn: (message: string) => void): ExtensionActions {
  const said = new Set<string>();
  const noop = (name: string) => () => { if (!said.has(name)) { said.add(name); warn(`${name}() does nothing in Pikibun`); } };
  return {
    sendMessage: noop("sendMessage"), sendUserMessage: noop("sendUserMessage"), appendEntry: noop("appendEntry"),
    setSessionName: noop("setSessionName"), getSessionName: () => undefined, setLabel: noop("setLabel"),
    getActiveTools: () => runner.getAllRegisteredTools().map(tool => tool.definition.name), getAllTools: () => [],
    getSettings: () => ({}) as never, setActiveTools: noop("setActiveTools"), refreshTools: () => {}, getCommands: () => [],
    setModel: async () => { noop("setModel")(); return false; }, getThinkingLevel: () => "off" as never, setThinkingLevel: noop("setThinkingLevel"),
  } as ExtensionActions;
}

function contextActions(host: ExtensionHost): ExtensionContextActions {
  return {
    getModel: () => host.model(), getScopedModels: () => [], isIdle: () => false, isProjectTrusted: () => false, getSignal: () => undefined,
    // The session's messages are stopped by the people in it, never by an extension; nor does one stop the connector.
    abort: () => {}, hasPendingMessages: () => false, shutdown: () => {}, getContextUsage: () => undefined, compact: () => {},
    getSystemPrompt: () => "",
  };
}

function toResult(result: AgentToolResult<unknown>): ToolExecutionResult {
  const content = Array.isArray(result?.content) ? result.content.filter(part => part && (part.type === "text" || part.type === "image")) : [];
  return { output: content, ...(result?.details !== undefined && isJsonValue(result.details) ? { details: result.details } : {}) };
}

function build(source: string, dev: boolean, runner: ExtensionRunner, allowed: Set<string>, host: ExtensionHost): SessionExtension {
  const key = extensionKey(source);
  const active = () => applyState(host, source, runner);
  const timed = <T>(event: string, work: () => Promise<T>) => withTimeout(work, host.hookTimeoutMs, `${source}'s ${event} handlers`);
  const quiet = async (event: string, work: () => Promise<unknown>) => {
    try { if (await active()) await timed(event, work); }
    catch (error) { host.warn(source, `${event}: ${describe(error)}`); }
  };
  const tools = runner.getAllRegisteredTools().filter(tool => allowed.has(tool.definition.name)).map(({ definition }) => defineTool({
    name: definition.name, description: definition.description, parameters: definition.parameters,
    ...(definition.executionMode ? { executionMode: definition.executionMode } : {}),
    ...(definition.prepareArguments ? { prepareArguments: definition.prepareArguments } : {}),
    execute: async (args, api, call) => {
      if (!(await active())) throw new Error(`This extension (${source}) no longer applies to this session; ${definition.name} didn't run.`);
      return host.runTool({ source, tool: definition.name, arguments: args as Record<string, unknown>, api, signal: call.abortSignal ?? new AbortController().signal, context: call },
        async signal => toResult(await definition.execute(api.callId, args, signal, undefined, runner.createToolContext(api.callId, signal))));
    },
  }));

  const hooks: HookRegistration[] = [];
  const has = (...events: string[]) => events.some(event => runner.hasHandlers(event));
  if (has("tool_call", "tool_result", "tool_execution_start", "tool_execution_end")) {
    hooks.push(hook(ToolTask, {
      // A tool_call handler that throws blocks the call (pi-durable's rule, and Pi's), so a broken guard never lets
      // through what it would have stopped.
      beforeTool: async call => {
        if (!(await active())) return undefined;
        await quiet("tool_execution_start", () => runner.emit({ type: "tool_execution_start", toolCallId: call.id, toolName: call.name, args: call.arguments }));
        if (!runner.hasHandlers("tool_call")) return undefined;
        const input = structuredClone(call.arguments) as Record<string, unknown>;
        const result = await timed("tool_call", () => runner.emitToolCall({ type: "tool_call", toolCallId: call.id, toolName: call.name, input } as ToolCallEvent));
        if (result?.block) return { block: result.reason || `An extension (${source}) blocked this call.` };
        return JSON.stringify(input) === JSON.stringify(call.arguments) ? undefined : { arguments: input as never };
      },
      afterTool: async (call, result) => {
        if (!(await active())) return undefined;
        const content = (result.output ?? []) as (TextContent | ImageContent)[];
        let replaced: ToolExecutionResult | undefined;
        if (runner.hasHandlers("tool_result")) {
          try {
            const next = await timed("tool_result", () => runner.emitToolResult({ type: "tool_result", toolCallId: call.id, toolName: call.name,
              input: call.arguments as Record<string, unknown>, content, isError: result.isError === true, details: result.details } as ToolResultEvent));
            if (next) replaced = { ...result, ...(next.content ? { output: next.content } : {}), ...(next.isError !== undefined ? { isError: next.isError } : {}),
              ...(next.details !== undefined && isJsonValue(next.details) ? { details: next.details } : {}) };
          } catch (error) { host.warn(source, `tool_result: ${describe(error)}`); }
        }
        await quiet("tool_execution_end", () => runner.emit({ type: "tool_execution_end", toolCallId: call.id, toolName: call.name,
          result: replaced?.output ?? content, isError: (replaced ?? result).isError === true }));
        return replaced;
      },
    }));
  }
  if (has("context", "context_with_system", "turn_start", "turn_end", "message_end", "agent_before_settle")) {
    let turn = 0;
    const boundary = { contextEntries: [], contextMessages: [], llmMessages: [], pendingMessages: [], canContinue: true };
    hooks.push(hook(GenerationTask, {
      beforeRequest: async request => {
        if (!(await active())) return undefined;
        await quiet("turn_start", () => runner.emit({ type: "turn_start", turnIndex: turn++, timestamp: Date.now() }));
        if (!has("context", "context_with_system")) return undefined;
        try {
          const messages = await timed("context", () => runner.emitContext(request.messages as never)) as unknown as Message[];
          return messages === request.messages ? undefined : { messages };
        } catch (error) {
          host.warn(source, `context: ${describe(error)}`);
          return undefined;
        }
      },
      afterResponse: async message => {
        await quiet("message_end", () => runner.emitMessageEnd({ type: "message_end", message }));
      },
      afterTools: async () => {
        await quiet("turn_end", () => runner.emitBoundary({ type: "turn_end", turnIndex: turn, message: undefined, toolResults: [], messageEntryId: "",
          toolResultEntryIds: [], outcome: "completed" } as never, () => boundary as never));
      },
      onYield: async answer => {
        if (!runner.hasHandlers("agent_before_settle") || !(await active())) return undefined;
        try {
          const result = await timed("agent_before_settle", () => runner.emitBoundary({ type: "agent_before_settle", outcome: "completed" } as never, () => boundary as never));
          if (!result.continue) return undefined;
          // Entries become the next message's text; Pi would append them as custom messages before continuing.
          const text = result.entries.map(entry => "content" in entry ? textOf((entry as { content: unknown }).content) : "").filter(Boolean).join("\n\n");
          void answer;
          return { continue: text || "Continue." };
        } catch (error) {
          host.warn(source, `agent_before_settle: ${describe(error)}`);
          return undefined;
        }
      },
    }));
  }
  if (has("session_before_compact")) {
    hooks.push(hook(CompactionTask, {
      beforeCompact: async compaction => {
        if (!(await active())) return undefined;
        try {
          const result = await timed("session_before_compact", () => runner.emit({ type: "session_before_compact", reason: compaction.reason, willRetry: compaction.reason === "overflow",
            customInstructions: compaction.instructions, branchEntries: [], preparation: { messagesToSummarize: compaction.messages } as never,
            signal: new AbortController().signal } as never)) as { cancel?: boolean; compaction?: { summary?: string } } | undefined;
          if (result?.cancel) return { decline: true };
          if (typeof result?.compaction?.summary === "string" && result.compaction.summary.trim()) return { summary: result.compaction.summary };
        } catch (error) { host.warn(source, `session_before_compact: ${describe(error)}`); }
        return undefined;
      },
    }));
  }
  const sections = has("before_agent_start") ? [section(key, async (input, context) => {
    const text = (await input.read.snapshot(ExtensionPrompts, input.conversationId, context))?.prompts[source];
    if (!text || !(await host.state(source)).active) return undefined;
    return `<extension source="${source.replaceAll("\"", "'")}">\n${text}\n</extension>`;
  }, { tag: false })] : [];
  return { source, dev, extension: defineExtension({ name: key, tools, sections, hooks }), tools, runner };
}
