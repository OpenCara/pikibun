import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import type { Context } from "@earendil-works/chord/context";
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
import { wholeForScripts } from "../script-output.js";

export interface ExtensionHost {
  readonly directory: string;
  readonly modelRegistry?: ModelRegistry;
  model(): Model<string> | undefined;
  thinkingLevel?(): string | undefined;
  state(source: string): Promise<{ active: boolean; settings: ExtensionSettings }>;
  runTool(call: { source: string; tool: string; arguments: Record<string, unknown>; api: ToolExecutionApi; signal: AbortSignal; context: Context },
    execute: (signal: AbortSignal) => Promise<ToolExecutionResult>): Promise<ToolExecutionResult>;
  readonly hookTimeoutMs: number;
  readonly inputTimeoutMs?: number;
  warn(source: string, message: string): void;
  readonly piki?: PikiSession;
}

export const ExtensionPrompts = defineDoc<{ prompts: Record<string, string> }>({ kind: "pikibun.extension-prompts", version: 1, scope: "conversation",
  history: "latest", fork: "current", initial: () => ({ prompts: {} }), checkpointWhen: () => true });

export const extensionKey = (source: string) => `pikibun-extension-${createHash("sha256").update(source).digest("hex").slice(0, 12)}`;

export interface SessionExtension {
  source: string;
  dev: boolean;
  extension: Extension;
  tools: ToolRegistration[];
  runner: ExtensionRunner;
}

export type InputOutcome = { action: "continue"; text: string; images: ImageContent[] } | { action: "refused"; by: string; notice?: string };

const inputCall = new AsyncLocalStorage<{ notices: string[]; errors: string[] }>();

function noticesOf(runner: ExtensionRunner): void {
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

export function addedPrompt(base: string, final: string): string {
  if (final === base) return "";
  if (final.startsWith(base)) return final.slice(base.length).trim();
  const lines = new Set(base.split("\n"));
  return final.split("\n").filter(line => !lines.has(line)).join("\n").trim();
}

export function settleToolNames(sources: readonly { source: string; tools: readonly string[] }[], reserved: Iterable<string>): { source: string; kept: string[]; lost: string[] }[] {
  const taken = new Set(reserved);
  return sources.map(({ source, tools }) => {
    const kept = tools.filter(tool => !taken.has(tool));
    for (const tool of kept) taken.add(tool);
    return { source, kept, lost: tools.filter(tool => !kept.includes(tool)) };
  });
}

export class SessionExtensions {
  readonly #opened: OpenedSource[] = [];
  readonly #reserved: Set<string>;
  #selected: SessionExtension[] = [];
  readonly #warned = new Set<string>();
  readonly #broken = new Set<string>();
  #started = false;

  constructor(private readonly host: ExtensionHost, reserved: Iterable<string> = []) {
    this.#reserved = new Set(reserved);
  }

  reserve(names: Iterable<string>): void {
    for (const name of names) this.#reserved.add(name);
  }

  get extensions(): readonly { source: string; dev: boolean; runner: ExtensionRunner }[] { return this.#opened; }

  isOpen(source: string): boolean {
    return this.#opened.some(item => item.source === source) && !this.#broken.has(source);
  }

  get(source: string): SessionExtension | undefined { return this.#selected.find(item => item.source === source); }

  async ensure(sources: readonly LoadedSource[]): Promise<void> {
    const opened: OpenedSource[] = [];
    for (const loaded of sources) {
      const source = loaded.summary.source;
      if (this.#opened.some(item => item.source === source) || loaded.summary.error) continue;
      try {
        const runtime = createExtensionRuntime();
        const piki = loaded.factories && source.startsWith("piki:") ? connectorPikiExtension(source) : undefined;
        const factories = piki && loaded.factories?.map(item => ({ path: item.path, factory: piki.forSession(this.host.piki ?? noPikiSession) }));
        const result = await loadSource(factories ? { ...loaded, factories } : loaded, this.host.directory, createEventBus(), runtime);
        for (const error of result.errors) this.host.warn(source, error.error);
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

  private async each(event: string, work: (runner: ExtensionRunner, source: string) => Promise<unknown>): Promise<void> {
    for (const extension of this.#opened) await this.one(extension, event, work);
  }

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

  async shutdown(): Promise<void> {
    await this.each("session_shutdown", runner => runner.emit({ type: "session_shutdown", reason: "quit" }));
    for (const extension of this.#opened) {
      try { extension.runner.shutdown(); } catch { }
    }
  }
}

async function applyState(host: ExtensionHost, source: string, runner: ExtensionRunner): Promise<boolean> {
  const state = await host.state(source);
  if (!state.active) return false;
  for (const [name, flag] of runner.getFlags()) {
    const value = state.settings[name] ?? flag.default;
    if (value !== undefined && typeof value === flag.type) runner.setFlagValue(name, value);
  }
  return true;
}

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
    abort: () => {}, hasPendingMessages: () => false, shutdown: () => {}, getContextUsage: () => undefined, compact: () => {},
    getSystemPrompt: () => "",
  };
}

const HARNESS_RESULT_CODES = new Set(["tool_unavailable", "invalid_arguments", "blocked", "interrupted", "restart_limit", "aborted", "abandoned"]);

export function harnessResult(result: ToolExecutionResult): boolean {
  return result.isError === true && (result.diagnostics ?? []).some(diagnostic => diagnostic.severity === "error" && HARNESS_RESULT_CODES.has(diagnostic.code ?? ""));
}

function toResult(result: AgentToolResult<unknown>): ToolExecutionResult {
  const content = Array.isArray(result?.content) ? result.content.filter(part => part && (part.type === "text" || part.type === "image")) : [];
  return { output: content, ...(result?.details !== undefined && isJsonValue(result.details) ? { details: result.details } : {}) };
}

interface OpenedSource {
  source: string;
  dev: boolean;
  runner: ExtensionRunner;
  tools: ToolRegistration[];
  sections: ReturnType<typeof section>[];
  hooks: HookRegistration[];
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
  const tools = runner.getAllRegisteredTools().filter(tool => offered.has(tool.definition.name)).map(({ definition }) => wholeForScripts(defineTool({
    name: definition.name, description: definition.description, parameters: definition.parameters,
    ...(definition.executionMode ? { executionMode: definition.executionMode } : {}),
    ...(definition.prepareArguments ? { prepareArguments: definition.prepareArguments } : {}),
    execute: async (args, api, call) => {
      if (!(await active())) throw new Error(`This extension (${source}) no longer applies to this session; ${definition.name} didn't run.`);
      return host.runTool({ source, tool: definition.name, arguments: args as Record<string, unknown>, api, signal: call.abortSignal ?? new AbortController().signal, context: call },
        async signal => toResult(await definition.execute(api.callId, args, signal, undefined, runner.createToolContext(api.callId, signal))));
    },
  })));

  const hooks: HookRegistration[] = [];
  const has = (...events: string[]) => events.some(event => runner.hasHandlers(event));
  if (has("tool_call", "tool_result", "tool_execution_start", "tool_execution_end")) {
    const started = new Set<string>();
    hooks.push(hook(ToolTask, {
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
        if (harnessResult(result)) {
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
