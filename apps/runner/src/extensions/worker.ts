import { AsyncLocalStorage } from "node:async_hooks";
import type { Message, Model, TextContent } from "@earendil-works/pi-ai";
import { createEventBus, createExtensionRuntime, ExtensionRunner, SessionManager, type AgentToolResult, type ExtensionActions, type ExtensionContext,
  type ExtensionContextActions, type ExtensionFactory, type ModelRegistry, type ToolCallEvent, type ToolResultEvent } from "@earendil-works/pi-coding-agent";
import type { ExtensionSettings } from "../../../../packages/shared/src/host-extensions.js";
import { isJsonValue } from "./json.js";
import { loadSource, supportedEvents } from "./load.js";
import type { ExtensionAnswer, ExtensionChannel, ExtensionMethod, ExtensionParams, ExtensionRequests, ExtensionToolDescription, RequestContext, Scoped, ToolOutput } from "./protocol.js";

export interface WorkerOptions {
  directory: string;
  warn(source: string, message: string): void;
  factories?(source: string): { path: string; factory: ExtensionFactory }[] | undefined;
  live?: { model(): Model<string> | undefined; thinkingLevel(): string | undefined; modelRegistry?: ModelRegistry };
}

export const MODEL_CALLS_REFUSED = "Installed extensions can't call models in Pikibun: a session's model and its host's model list are visible to them, the host's credentials are not.";

export function addedPrompt(base: string, final: string): string {
  if (final === base) return "";
  if (final.startsWith(base)) return final.slice(base.length).trim();
  const lines = new Set(base.split("\n"));
  return final.split("\n").filter(line => !lines.has(line)).join("\n").trim();
}

export function modelDescription<T extends Model<string> | undefined>(model: T): T {
  if (!model) return model;
  const { headers: _headers, ...rest } = model as Model<string> & { headers?: unknown };
  return JSON.parse(JSON.stringify(rest)) as T;
}

function describedRegistry(models: () => Model<string>[]): ModelRegistry {
  const known: Record<string, unknown> = {
    getAll: () => models(),
    getAvailable: () => models(),
    find: (provider: string, id: string) => models().find(model => model.provider === provider && model.id === id),
    getError: () => undefined,
  };
  return new Proxy(known, {
    get: (target, name) => typeof name === "string" && name in target ? target[name] : typeof name === "string" && name !== "then"
      ? () => { throw new Error(MODEL_CALLS_REFUSED); } : undefined,
  }) as unknown as ModelRegistry;
}

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

const textOf = (content: unknown) => typeof content === "string" ? content
  : Array.isArray(content) ? content.map(part => part && typeof part === "object" && (part as TextContent).type === "text" ? (part as TextContent).text : "").join("") : "";

function toOutput(result: AgentToolResult<unknown>): ToolOutput {
  const content = Array.isArray(result?.content) ? result.content.filter(part => part && (part.type === "text" || part.type === "image")) : [];
  return { content, ...(result?.details !== undefined && isJsonValue(result.details) ? { details: result.details } : {}) };
}

const boundary = () => ({ contextEntries: [], contextMessages: [], llmMessages: [], pendingMessages: [], canContinue: true });
const requestContext = new AsyncLocalStorage<RequestContext>();

type Handlers = { [M in ExtensionMethod]: (params: ExtensionParams<M>, signal?: AbortSignal) => Promise<ExtensionRequests[M][1]> };

export class ExtensionWorker {
  readonly #runners = new Map<string, ExtensionRunner>();
  #context: RequestContext = {};
  #models: Model<string>[] = [];
  readonly #registry: ModelRegistry | undefined;
  readonly #handlers: Handlers;

  constructor(private readonly options: WorkerOptions) {
    this.#registry = options.live ? options.live.modelRegistry : describedRegistry(() => this.#models);
    this.#handlers = {
      open: params => this.open(params),
      emit: async params => { await this.runner(params).emit(params.event as never); return null; },
      input: params => this.input(params),
      beforeAgentStart: params => this.beforeAgentStart(params),
      toolCall: async params => {
        const input = structuredClone(params.input);
        const result = await this.runner(params).emitToolCall({ type: "tool_call", toolCallId: params.id, toolName: params.name, input } as ToolCallEvent);
        return result?.block ? { block: result.reason || "", input } : { input };
      },
      toolResult: async params => {
        const next = await this.runner(params).emitToolResult({ type: "tool_result", ...params.event } as ToolResultEvent);
        if (!next) return null;
        return { ...(next.content ? { content: next.content } : {}), ...(next.isError !== undefined ? { isError: next.isError } : {}),
          ...(next.details !== undefined && isJsonValue(next.details) ? { details: next.details } : {}) };
      },
      context: async params => {
        const messages = await this.runner(params).emitContext(params.messages as never) as unknown as Message[];
        return messages === params.messages ? null : messages;
      },
      messageEnd: async params => { await this.runner(params).emitMessageEnd({ type: "message_end", message: params.message } as never); return null; },
      turnEnd: async params => {
        await this.runner(params).emitBoundary({ type: "turn_end", turnIndex: params.turnIndex, message: undefined, toolResults: [], messageEntryId: "",
          toolResultEntryIds: [], outcome: "completed" } as never, () => boundary() as never);
        return null;
      },
      beforeSettle: async params => {
        const result = await this.runner(params).emitBoundary({ type: "agent_before_settle", outcome: "completed" } as never, () => boundary() as never);
        const text = result.entries.map(entry => "content" in entry ? textOf((entry as { content: unknown }).content) : "").filter(Boolean).join("\n\n");
        return { continue: result.continue === true, text };
      },
      compact: async params => {
        const result = await this.runner(params).emit({ type: "session_before_compact", reason: params.reason, willRetry: params.reason === "overflow",
          customInstructions: params.instructions, branchEntries: [], preparation: { messagesToSummarize: params.messages } as never,
          signal: new AbortController().signal } as never) as { cancel?: boolean; compaction?: { summary?: string } } | undefined;
        if (result?.cancel) return { cancel: true };
        return typeof result?.compaction?.summary === "string" ? { summary: result.compaction.summary } : null;
      },
      execute: (params, signal) => this.execute(params, signal),
      shutdown: async () => {
        for (const runner of this.#runners.values()) {
          try { runner.shutdown(); } catch { }
        }
        this.#runners.clear();
        return null;
      },
    };
  }

  async handle<M extends ExtensionMethod>(method: M, params: ExtensionParams<M>, signal?: AbortSignal): Promise<ExtensionAnswer<M>> {
    if (!Object.hasOwn(this.#handlers, method)) throw new Error(`Unknown extension request ${String(method)}`);
    const handler = this.#handlers[method] as (params: ExtensionParams<M>, signal?: AbortSignal) => Promise<ExtensionRequests[M][1]>;
    if (params.context) this.#context = params.context;
    const value = await requestContext.run(params.context ?? this.#context, () => handler(params, signal));
    const source = (params as { source?: unknown }).source;
    const runner = typeof source === "string" ? this.#runners.get(source) : undefined;
    return { value, ...(runner ? { handlers: [...supportedEvents].filter(event => runner.hasHandlers(event)) } : {}) };
  }

  private runner(params: Scoped): ExtensionRunner {
    const runner = this.#runners.get(params.source);
    if (!runner) throw new Error(`${params.source} isn't open`);
    applyFlags(runner, params.settings);
    return runner;
  }

  private model(): Model<string> | undefined {
    return this.options.live ? this.options.live.model() : (requestContext.getStore() ?? this.#context).model;
  }

  private thinkingLevel(): string | undefined {
    return this.options.live ? this.options.live.thinkingLevel() : (requestContext.getStore() ?? this.#context).thinkingLevel;
  }

  private async open(params: ExtensionParams<"open">): Promise<ExtensionRequests["open"][1]> {
    const { source } = params;
    if (this.#runners.has(source)) throw new Error(`${source} is already open`);
    if (!this.options.live) this.#models = params.models;
    const { directory, warn } = this.options;
    const runtime = createExtensionRuntime();
    const factories = this.options.factories?.(source);
    const result = await loadSource(factories ? { files: params.files, factories } : { files: params.files }, directory, createEventBus(), runtime);
    const runner = new ExtensionRunner(result.extensions, runtime, directory, SessionManager.inMemory(directory), this.#registry ?? (undefined as never));
    runner.bindCore(noActions(runner, message => warn(source, message), () => this.thinkingLevel()), contextActions(() => this.model()));
    runner.onError(error => warn(source, `${error.event}: ${error.error}`));
    noticesOf(runner);
    this.#runners.set(source, runner);
    const tools: ExtensionToolDescription[] = runner.getAllRegisteredTools().map(({ definition }) => ({
      name: definition.name, description: String(definition.description ?? ""), parameters: JSON.parse(JSON.stringify(definition.parameters ?? {})),
      ...(definition.executionMode ? { executionMode: definition.executionMode } : {}),
    }));
    return { errors: result.errors.map(error => error.error), tools };
  }

  private async input(params: ExtensionParams<"input">): Promise<ExtensionRequests["input"][1]> {
    const runner = this.runner(params);
    const notices: string[] = [];
    const errors: string[] = [];
    const result = await inputCall.run({ notices, errors }, () => runner.emitInput(params.text, params.images.length ? params.images : undefined, params.inputSource));
    return { result: result as ExtensionRequests["input"][1]["result"], notices, errors };
  }

  private async beforeAgentStart(params: ExtensionParams<"beforeAgentStart">): Promise<string> {
    const runner = this.runner(params);
    if (!runner.hasHandlers("before_agent_start")) return "";
    const { buildSystemPrompt } = await import(new URL("./core/system-prompt.js", import.meta.resolve("@earendil-works/pi-coding-agent")).href) as
      { buildSystemPrompt(options: { cwd: string; selectedTools?: string[] }): string };
    const options = { cwd: this.options.directory, selectedTools: [] as string[] };
    const base = buildSystemPrompt(options);
    const result = await runner.emitBeforeAgentStart({ messageType: "user", prompt: params.prompt, ...(params.images?.length ? { images: params.images } : {}) }, options);
    const final = buildSystemPrompt(result.systemPromptOptions as never);
    return [addedPrompt(base, final), ...result.messages.map(message => textOf(message.content).trim())].filter(Boolean).join("\n\n");
  }

  private async execute(params: ExtensionParams<"execute">, signal?: AbortSignal): Promise<ToolOutput> {
    const runner = this.runner(params);
    const definition = runner.getAllRegisteredTools().find(tool => tool.definition.name === params.tool)?.definition;
    if (!definition) throw new Error(`${params.source} has no tool ${params.tool}`);
    const aborted = signal ?? new AbortController().signal;
    const args = definition.prepareArguments ? definition.prepareArguments(structuredClone(params.args)) : params.args;
    return toOutput(await definition.execute(params.callId, args as never, aborted, undefined, runner.createToolContext(params.callId, aborted)));
  }
}

function applyFlags(runner: ExtensionRunner, settings: ExtensionSettings): void {
  for (const [name, flag] of runner.getFlags()) {
    const value = settings[name] ?? flag.default;
    if (value !== undefined && typeof value === flag.type) runner.setFlagValue(name, value);
  }
}

function noActions(runner: ExtensionRunner, warn: (message: string) => void, thinkingLevel: () => string | undefined): ExtensionActions {
  const said = new Set<string>();
  const noop = (name: string) => () => { if (!said.has(name)) { said.add(name); warn(`${name}() does nothing in Pikibun`); } };
  return {
    sendMessage: noop("sendMessage"), sendUserMessage: noop("sendUserMessage"), appendEntry: noop("appendEntry"),
    setSessionName: noop("setSessionName"), getSessionName: () => undefined, setLabel: noop("setLabel"),
    getActiveTools: () => runner.getAllRegisteredTools().map(tool => tool.definition.name), getAllTools: () => [],
    getSettings: () => ({}) as never, setActiveTools: noop("setActiveTools"), refreshTools: () => {}, getCommands: () => [],
    setModel: async () => { noop("setModel")(); return false; }, getThinkingLevel: () => (thinkingLevel() ?? "off") as never, setThinkingLevel: noop("setThinkingLevel"),
  } as ExtensionActions;
}

function contextActions(model: () => Model<string> | undefined): ExtensionContextActions {
  return {
    getModel: () => model() as never, getScopedModels: () => [], isIdle: () => false, isProjectTrusted: () => false, getSignal: () => undefined,
    abort: () => {}, hasPendingMessages: () => false, shutdown: () => {}, getContextUsage: () => undefined, compact: () => {},
    getSystemPrompt: () => "",
  };
}

export function directChannel(worker: ExtensionWorker): ExtensionChannel {
  return {
    call: (method, params, signal) => worker.handle(method, params, signal),
    close: async () => { await worker.handle("shutdown", {}); },
  };
}

export function jsonChannel(worker: ExtensionWorker): ExtensionChannel {
  const across = <T>(value: T): T => value === undefined ? value : JSON.parse(JSON.stringify(value)) as T;
  return {
    call: async (method, params, signal) => {
      try { return across(await worker.handle(method, across(params), signal)); }
      catch (error) { throw new Error(error instanceof Error ? error.message : String(error)); }
    },
    close: async () => { await worker.handle("shutdown", {}); },
  };
}

