import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import type { Context } from "@earendil-works/chord";
import { CompactionTask, defineDoc, defineExtension, defineTool, GenerationTask, hook, section, ToolTask, type Extension, type HookRegistration,
  type ToolExecutionApi, type ToolExecutionResult, type ToolRegistration } from "@earendil-works/pi-durable";
import type { ImageContent, Message, Model, TextContent } from "@earendil-works/pi-ai";
import { createEventBus, createExtensionRuntime, ExtensionRunner, SessionManager, type AgentToolResult, type ExtensionActions,
  type ExtensionContext, type ExtensionContextActions, type ModelRegistry, type ToolCallEvent, type ToolResultEvent } from "@earendil-works/pi-coding-agent";
import { isJsonValue } from "./json.js";
import type { ExtensionSettings } from "../../../../packages/shared/src/host-extensions.js";
import { loadSource, type LoadedSource } from "./load.js";
import { connectorPikiExtension } from "./piki/index.js";
import { noPikiSession, type PikiSession } from "./piki/command.js";

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
  /** The model the session's shared conversation runs on now, as Pi's `ctx.model`. */
  model(): Model<string> | undefined;
  /** Its reasoning level now, as Pi's `pi.getThinkingLevel()`. */
  thinkingLevel?(): string | undefined;
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
  /**
   * How long one source's `input` handlers may take with a message, which waits for them before it is accepted: within
   * the control plane's 30 seconds for that. `hookTimeoutMs` without it.
   */
  readonly inputTimeoutMs?: number;
  /** An extension's error; logged on the host, never shown to the model. */
  warn(source: string, message: string): void;
  /**
   * Where the session runs its Pikibun extensions' commands (piki:gh, ...): in its sandbox as its owner, or with the
   * host's sign-in where it may. Without it they don't run.
   */
  readonly piki?: PikiSession;
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

/**
 * Where a message's input stands after the extensions' `input` handlers: going on, with the text and images they left
 * it (`transform`), or refused by `by` (`handled`, a handler that failed, or one that took too long). `notice` is the
 * last thing that source's handlers told the person through `ctx.ui.notify`, as Pi shows it to them.
 */
export type InputOutcome = { action: "continue"; text: string; images: ImageContent[] } | { action: "refused"; by: string; notice?: string };

/**
 * What the `input` handlers running now tell the person (`ctx.ui.notify`) and which of them fail, per message: messages
 * of a session are screened side by side, so neither leaks into another's (see `noticesOf`).
 */
const inputCall = new AsyncLocalStorage<{ notices: string[]; errors: string[] }>();

/**
 * Lets `runner`'s handlers tell the person who sent a message something while its `input` handlers run: Pikibun runs
 * extensions without a UI (Pi's print mode, `hasUI` false), so `ctx.ui.notify` does nothing, except then, where what it
 * says is kept as the message's notice. Everything else of the context stays as it is.
 */
function noticesOf(runner: ExtensionRunner): void {
  // Pi reports a handler's error to its listeners within the same call, so this one finds the message it was screening.
  runner.onError(error => { if (error.event === "input") inputCall.getStore()?.errors.push(error.error); });
  const createContext = runner.createContext.bind(runner);
  runner.createContext = () => {
    const ctx = createContext();
    const sink = inputCall.getStore()?.notices;
    if (!sink) return ctx;
    const ui = new Proxy(ctx.ui, { get: (target, name, receiver) => name === "notify"
      ? (message: unknown) => { sink.push(String(message)); }
      : Reflect.get(target, name, receiver) });
    return Object.create(ctx, { ui: { value: ui } }) as ExtensionContext;
  };
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
 * The tools each of `sources` keeps when a message runs with them, in that order: those no earlier one, nor the
 * session itself (`reserved`), already has. The rule `SessionExtensions.select` applies, and the session's view shows.
 */
export function settleToolNames(sources: readonly { source: string; tools: readonly string[] }[], reserved: Iterable<string>): { source: string; kept: string[]; lost: string[] }[] {
  const taken = new Set(reserved);
  return sources.map(({ source, tools }) => {
    const kept = tools.filter(tool => !taken.has(tool));
    for (const tool of kept) taken.add(tool);
    return { source, kept, lost: tools.filter(tool => !kept.includes(tool)) };
  });
}

/**
 * A session's extensions: one Pi ExtensionRunner per source, opened as the session first runs with it, and the pi-durable
 * Extension each message selects. A tool named like one the session already has (Pikibun's own, or one of an extension
 * earlier in the selection) is left out of that selection only, so a later selection (another version, say) gets it.
 */
export class SessionExtensions {
  readonly #opened: OpenedSource[] = [];
  readonly #reserved: Set<string>;
  #selected: SessionExtension[] = [];
  readonly #warned = new Set<string>();
  /** Sources that failed to load for this session, whole or in part. */
  readonly #broken = new Set<string>();
  #started = false;

  /** `reserved`: the session's own tool names. */
  constructor(private readonly host: ExtensionHost, reserved: Iterable<string> = []) {
    this.#reserved = new Set(reserved);
  }

  /**
   * Adds `names` to the session's own tool names, from the next selection on: a tool the session takes up after it opened
   * (one the control plane defines since, tool-definitions.ts) is never an extension's again (review of #205).
   */
  reserve(names: Iterable<string>): void {
    for (const name of names) this.#reserved.add(name);
  }

  /** Every source the session opened. */
  get extensions(): readonly { source: string; dev: boolean; runner: ExtensionRunner }[] { return this.#opened; }

  /**
   * Whether the session opened `source` whole: loaded, with every part of it. A guard the host's owner requires runs only
   * so; one that failed for this session holds its messages instead.
   */
  isOpen(source: string): boolean {
    return this.#opened.some(item => item.source === source) && !this.#broken.has(source);
  }

  /** `source` as the last selection has it: its Extension and the tools it kept. */
  get(source: string): SessionExtension | undefined { return this.#selected.find(item => item.source === source); }

  /**
   * Opens those of `sources` the session hasn't opened yet; once the session started, each gets `session_start`. A
   * source that fails is left out, and logged.
   */
  async ensure(sources: readonly LoadedSource[]): Promise<void> {
    const opened: OpenedSource[] = [];
    for (const loaded of sources) {
      const source = loaded.summary.source;
      if (this.#opened.some(item => item.source === source) || loaded.summary.error) continue;
      try {
        const runtime = createExtensionRuntime();
        // A Pikibun extension runs its command as this session lets it, not as the connector's own copy does.
        const piki = loaded.factories && source.startsWith("piki:") ? connectorPikiExtension(source) : undefined;
        const factories = piki && loaded.factories?.map(item => ({ path: item.path, factory: piki.forSession(this.host.piki ?? noPikiSession) }));
        const result = await loadSource(factories ? { ...loaded, factories } : loaded, this.host.directory, createEventBus(), runtime);
        for (const error of result.errors) this.host.warn(source, error.error);
        // Part of it didn't load for this session: it runs as far as it did, but isn't whole (see isOpen).
        if (result.errors.length) this.#broken.add(source);
        const runner = new ExtensionRunner(result.extensions, runtime, this.host.directory, SessionManager.inMemory(this.host.directory),
          this.host.modelRegistry ?? (undefined as never));
        runner.bindCore(noActions(runner, message => this.host.warn(source, message), this.host), contextActions(this.host));
        runner.onError(error => this.host.warn(source, `${error.event}: ${error.error}`));
        noticesOf(runner);
        const offered = new Set(loaded.summary.modules.flatMap(module => module.tools.map(tool => tool.name)));
        const extension = build(source, loaded.summary.dev, runner, offered, this.host);
        this.#opened.push(extension);
        opened.push(extension);
      } catch (error) {
        this.host.warn(source, `didn't load: ${describe(error)}`);
        this.#broken.add(source);
      }
    }
    if (this.#started) for (const extension of opened) await this.one(extension, "session_start", runner => runner.emit({ type: "session_start", reason: "startup" }));
  }

  /**
   * The Extensions for a message that runs with `sources`, in that order, of those the session opened: each keeps the
   * tools no earlier one (nor the session itself) has. `created` are those made now, for the registry.
   */
  select(sources: readonly string[]): { selected: SessionExtension[]; created: Extension[] } {
    const opened = sources.flatMap(source => this.#opened.filter(item => item.source === source));
    const settled = settleToolNames(opened.map(item => ({ source: item.source, tools: item.tools.map(tool => tool.name) })), this.#reserved);
    const selected: SessionExtension[] = [];
    const created: Extension[] = [];
    for (const { source, kept, lost } of settled) {
      const opened = this.#opened.find(item => item.source === source)!;
      for (const name of lost) {
        const warning = `${source} ${name}`;
        if (this.#warned.has(warning)) continue;
        this.#warned.add(warning);
        this.host.warn(source, `tool ${name} is left out: an earlier extension or the session has a tool named so`);
      }
      const tools = opened.tools.filter(tool => kept.includes(tool.name));
      const key = tools.map(tool => tool.name).sort().join("\n");
      let extension = opened.variants.get(key);
      if (!extension) {
        // The whole source keeps its plain name; one that lost tools to a clash is another Extension, named for what it kept.
        const name = tools.length === opened.tools.length ? extensionKey(source) : `${extensionKey(source)}-${createHash("sha256").update(key).digest("hex").slice(0, 8)}`;
        extension = defineExtension({ name, tools, sections: opened.sections, hooks: opened.hooks });
        opened.variants.set(key, extension);
        created.push(extension);
      }
      selected.push({ source, dev: opened.dev, extension, tools, runner: opened.runner });
    }
    this.#selected = selected;
    return { selected, created };
  }

  private async one(extension: { source: string; runner: ExtensionRunner }, event: string, work: (runner: ExtensionRunner, source: string) => Promise<unknown>): Promise<void> {
    if (!(await applyState(this.host, extension.source, extension.runner))) return;
    try { await withTimeout(() => work(extension.runner, extension.source), this.host.hookTimeoutMs, `${event}`); }
    catch (error) { this.host.warn(extension.source, `${event}: ${describe(error)}`); }
  }

  /** Runs `event` on every source that applies; one that fails or times out is logged. */
  private async each(event: string, work: (runner: ExtensionRunner, source: string) => Promise<unknown>): Promise<void> {
    for (const extension of this.#opened) await this.one(extension, event, work);
  }

  /**
   * Pi's `input` event for a message about to be accepted, through `sources` in that order (those the session opened
   * and that apply now): each may let it go on, change its text and images (`transform`), or take it (`handled`), which
   * refuses it. `inputSource` is Pi's: `interactive` for the host owner's own messages, the machine's person in Pi's
   * terms, and `rpc` for everyone else's. Unlike in Pi, where a handler that throws lets the message through, a handler
   * that fails or takes too long refuses it here, as a `tool_call` handler blocks its call: a broken guard never lets
   * through what it would have stopped.
   */
  async input(sources: readonly string[], text: string, images: ImageContent[], inputSource: "interactive" | "rpc"): Promise<InputOutcome> {
    let current = { text, images };
    for (const source of sources) {
      const opened = this.#opened.find(item => item.source === source);
      if (!opened?.runner.hasHandlers("input") || !(await applyState(this.host, source, opened.runner))) continue;
      const notices: string[] = [];
      const errors: string[] = [];
      try {
        const { text, images } = current;
        const result = await inputCall.run({ notices, errors }, () => withTimeout(() => opened.runner.emitInput(text, images.length ? images : undefined, inputSource),
          this.host.inputTimeoutMs ?? this.host.hookTimeoutMs, `${source}'s input handlers`));
        if (errors.length) return { action: "refused", by: source };
        if (result.action === "handled") return { action: "refused", by: source, ...(notices.length ? { notice: notices.at(-1)! } : {}) };
        if (result.action === "transform") {
          if (typeof result.text !== "string") throw new Error("input: transform without text");
          current = { text: result.text, images: Array.isArray(result.images) ? result.images : current.images };
        }
      } catch (error) {
        this.host.warn(source, describe(error));
        return { action: "refused", by: source };
      }
    }
    return { action: "continue", ...current };
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
    for (const extension of this.#opened) {
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
function noActions(runner: ExtensionRunner, warn: (message: string) => void, host: ExtensionHost): ExtensionActions {
  const said = new Set<string>();
  const noop = (name: string) => () => { if (!said.has(name)) { said.add(name); warn(`${name}() does nothing in Pikibun`); } };
  return {
    sendMessage: noop("sendMessage"), sendUserMessage: noop("sendUserMessage"), appendEntry: noop("appendEntry"),
    setSessionName: noop("setSessionName"), getSessionName: () => undefined, setLabel: noop("setLabel"),
    getActiveTools: () => runner.getAllRegisteredTools().map(tool => tool.definition.name), getAllTools: () => [],
    getSettings: () => ({}) as never, setActiveTools: noop("setActiveTools"), refreshTools: () => {}, getCommands: () => [],
    setModel: async () => { noop("setModel")(); return false; }, getThinkingLevel: () => (host.thinkingLevel?.() ?? "off") as never, setThinkingLevel: noop("setThinkingLevel"),
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

/**
 * The diagnostic codes of the error results pi-durable writes itself, for calls that never ran or were cut off: a tool
 * that doesn't resolve, invalid arguments, a block, an interruption, the restart limit, an abort. Its afterTool hooks
 * run on those too (pi-durable 1.5); Pi never gives such a call to its extensions' tool_result handlers.
 */
const HARNESS_RESULT_CODES = new Set(["tool_unavailable", "invalid_arguments", "blocked", "interrupted", "restart_limit", "aborted", "abandoned"]);

/** Whether pi-durable wrote `result` itself (see HARNESS_RESULT_CODES), rather than the tool. */
export function harnessResult(result: ToolExecutionResult): boolean {
  return result.isError === true && (result.diagnostics ?? []).some(diagnostic => diagnostic.severity === "error" && HARNESS_RESULT_CODES.has(diagnostic.code ?? ""));
}

function toResult(result: AgentToolResult<unknown>): ToolExecutionResult {
  const content = Array.isArray(result?.content) ? result.content.filter(part => part && (part.type === "text" || part.type === "image")) : [];
  return { output: content, ...(result?.details !== undefined && isJsonValue(result.details) ? { details: result.details } : {}) };
}

/** One source a session opened: its runner, and every tool, section and hook it offers Pikibun. */
interface OpenedSource {
  source: string;
  dev: boolean;
  runner: ExtensionRunner;
  tools: ToolRegistration[];
  sections: ReturnType<typeof section>[];
  hooks: HookRegistration[];
  /** Its pi-durable Extensions, by the tools a selection kept of it (see SessionExtensions.select). */
  variants: Map<string, Extension>;
}

function build(source: string, dev: boolean, runner: ExtensionRunner, offered: Set<string>, host: ExtensionHost): OpenedSource {
  const key = extensionKey(source);
  const active = () => applyState(host, source, runner);
  const timed = <T>(event: string, work: () => Promise<T>) => withTimeout(work, host.hookTimeoutMs, `${source}'s ${event} handlers`);
  const quiet = async (event: string, work: () => Promise<unknown>) => {
    try { if (await active()) await timed(event, work); }
    catch (error) { host.warn(source, `${event}: ${describe(error)}`); }
  };
  const tools = runner.getAllRegisteredTools().filter(tool => offered.has(tool.definition.name)).map(({ definition }) => defineTool({
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
    // The calls this source was told started (tool_execution_start), so it is told each one's end once, and never of an
    // end it wasn't told the start of.
    const started = new Set<string>();
    hooks.push(hook(ToolTask, {
      // A tool_call handler that throws blocks the call (pi-durable's rule, and Pi's), so a broken guard never lets
      // through what it would have stopped.
      beforeTool: async call => {
        if (!(await active())) return undefined;
        started.add(call.id);
        await quiet("tool_execution_start", () => runner.emit({ type: "tool_execution_start", toolCallId: call.id, toolName: call.name, args: call.arguments }));
        if (!runner.hasHandlers("tool_call")) return undefined;
        const input = structuredClone(call.arguments) as Record<string, unknown>;
        const result = await timed("tool_call", () => runner.emitToolCall({ type: "tool_call", toolCallId: call.id, toolName: call.name, input } as ToolCallEvent));
        if (result?.block) return { block: result.reason || `An extension (${source}) blocked this call.` };
        return JSON.stringify(input) === JSON.stringify(call.arguments) ? undefined : { arguments: input as never };
      },
      afterTool: async (call, result) => {
        const began = started.delete(call.id);
        if (!(await active())) return undefined;
        const content = (result.output ?? []) as (TextContent | ImageContent)[];
        // A result pi-durable wrote itself, for a call that never ran (unknown, invalid, blocked) or was cut off: as in Pi,
        // tool_result handlers never see it, and tool_execution_end comes only after the tool_execution_start it ends.
        if (harnessResult(result)) {
          // Its output is empty or partial; what went wrong is in its diagnostics, as Pi's own error results say it.
          const errors = (result.diagnostics ?? []).filter(diagnostic => diagnostic.severity === "error").map(diagnostic => ({ type: "text" as const, text: diagnostic.message }));
          if (began) await quiet("tool_execution_end", () => runner.emit({ type: "tool_execution_end", toolCallId: call.id, toolName: call.name,
            result: [...content, ...errors], isError: true }));
          return undefined;
        }
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
  return { source, dev, runner, tools, sections, hooks, variants: new Map() };
}
