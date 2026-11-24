import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createAssistantMessageEventStream, type AssistantMessage, type Context as ModelContext, type ImageContent, type Message, type Model, type TextContent } from "@earendil-works/pi-ai";
import { createEventBus, createExtensionRuntime, ExtensionRunner, SessionManager, type AgentToolResult, type ExtensionActions, type ExtensionContext,
  type ExtensionContextActions, type ExtensionFactory, type ModelRegistry, type ToolCallEvent, type ToolResultEvent } from "@earendil-works/pi-coding-agent";
import type { ExtensionSettings } from "../../../../packages/shared/src/host-extensions.js";
import { dataText, entryRefusal } from "./entries.js";
import { isJsonValue } from "./json.js";
import { loadSource, piLoader, summarizeModules, supportedEvents } from "./load.js";
import { collectSkills, discoveredPath } from "./skills.js";
import type { AppendedHandler, CompleteHandler, CompleteRequest, ExtensionAnswer, ExtensionChannel, ExtensionMethod, ExtensionParams, ExtensionRequests, ExtensionSkill, ExtensionToolDescription,
  RequestContext, Scoped, StoredEntry, ToolOutput } from "./protocol.js";

export interface WorkerOptions {
  directory: string;
  warn(source: string, message: string): void;
  factories?(source: string): { path: string; factory: ExtensionFactory }[] | undefined;
  live?: { model(): Model<string> | undefined; thinkingLevel(): string | undefined; modelRegistry?: ModelRegistry };
  complete?: CompleteHandler;
  appended?: AppendedHandler;
}

export const FOLLOW_UPS_LIMIT = 8;
export const FOLLOW_UP_LIMIT = 16_000;
const RUN_METHODS: ReadonlySet<string> = new Set(["beforeAgentStart", "toolCall", "toolResult", "context", "messageEnd", "turnEnd", "beforeSettle", "execute"]);
const RUN_EVENTS: ReadonlySet<string> = new Set(["agent_start", "turn_start", "tool_execution_start", "tool_execution_end"]);

function sessionView(holder: { current: SessionManager }): SessionManager {
  return new Proxy({}, { get: (_target, name) => {
    const value = Reflect.get(holder.current, name) as unknown;
    return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(holder.current) : value;
  } }) as SessionManager;
}

function restoredSession(directory: string, entries: readonly StoredEntry[]): SessionManager {
  let parentId: string | null = null;
  const restored = entries.map(entry => {
    const item = { type: "custom" as const, id: entry.id, parentId, timestamp: entry.timestamp, customType: entry.customType, ...(entry.data ? { data: JSON.parse(entry.data) as unknown } : {}) };
    parentId = entry.id;
    return item;
  });
  return SessionManager.inMemory(directory, undefined, restored);
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

function userContent(content: unknown): (TextContent | ImageContent)[] {
  if (typeof content === "string") return [{ type: "text", text: content }];
  if (!Array.isArray(content)) return [];
  return content.flatMap((part): (TextContent | ImageContent)[] => {
    if (part?.type === "text" && typeof part.text === "string") return [{ type: "text", text: part.text }];
    if (part?.type === "image" && typeof part.data === "string" && typeof part.mimeType === "string") return [{ type: "image", data: part.data, mimeType: part.mimeType }];
    return [];
  });
}

export function completionRequest(source: string, model: Model<string> | undefined, context: ModelContext, maxTokens?: number): CompleteRequest {
  const messages = (context.messages ?? []).map(message => {
    if (message.role !== "user") throw new Error("An extension's model call sends only user messages");
    return { role: "user" as const, content: userContent(message.content), ...(typeof message.timestamp === "number" ? { timestamp: message.timestamp } : {}) };
  });
  return { source, ...(model ? { model: { provider: model.provider, id: model.id } } : {}),
    ...(typeof context.systemPrompt === "string" ? { systemPrompt: context.systemPrompt } : {}), messages,
    ...(typeof maxTokens === "number" ? { maxTokens } : {}) };
}

function streamOver(source: string, complete: CompleteHandler) {
  return (model: Model<string> | undefined, context: ModelContext, options?: { signal?: AbortSignal; maxTokens?: number }) => {
    const stream = createAssistantMessageEventStream();
    const signal = options?.signal ?? new AbortController().signal;
    const message = (content: TextContent[], stopReason: string, errorMessage?: string): AssistantMessage => ({
      role: "assistant", content, api: model?.api ?? "unknown", provider: model?.provider ?? "unknown", model: model?.id ?? "unknown",
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      stopReason, ...(errorMessage ? { errorMessage } : {}), timestamp: Date.now(),
    } as unknown as AssistantMessage);
    void Promise.resolve().then(() => complete(completionRequest(source, model, context, options?.maxTokens), signal))
      .then(answer => stream.end(message(answer.content, answer.stopReason, answer.errorMessage)),
        (error: unknown) => stream.end(message([], signal.aborted ? "aborted" : "error", error instanceof Error ? error.message : String(error))));
    return stream;
  };
}

function describedRegistry(models: () => Model<string>[], streamSimple?: ReturnType<typeof streamOver>): ModelRegistry {
  const known: Record<string, unknown> = {
    getAll: () => models(),
    getAvailable: () => models(),
    find: (provider: string, id: string) => models().find(model => model.provider === provider && model.id === id),
    getError: () => undefined,
    ...(streamSimple ? { streamSimple } : {}),
  };
  return new Proxy(known, {
    get: (target, name) => typeof name === "string" && name in target ? target[name] : typeof name === "string" && name !== "then"
      ? () => { throw new Error(MODEL_CALLS_REFUSED); } : undefined,
  }) as unknown as ModelRegistry;
}

const inputCall = new AsyncLocalStorage<{ notices: string[]; errors: string[] }>();
const commandCall = new AsyncLocalStorage<{ notices: string[]; messages: string[] }>();
const runCall = new AsyncLocalStorage<true>();

export const NOTICE_LIMIT = 500;
export const NOTICES_PER_SOURCE = 50;
const PROMPT_TEXT_LIMIT = 1000;
const GUIDELINES_LIMIT = 8;

function noticesOf(runner: ExtensionRunner, warn: (message: string) => void): void {
  let logged = 0;
  const log = (message: string) => {
    logged++;
    if (logged <= NOTICES_PER_SOURCE) warn(message);
    else if (logged === NOTICES_PER_SOURCE + 1) warn(`it sent more than ${NOTICES_PER_SOURCE} warnings; the rest go unlogged until its process starts again`);
  };
  runner.onError(error => { if (error.event === "input") inputCall.getStore()?.errors.push(error.error); });
  const createContext = runner.createContext.bind(runner);
  runner.createContext = () => {
    const ctx = createContext();
    const sink = (inputCall.getStore() ?? commandCall.getStore())?.notices;
    const ui = new Proxy(ctx.ui, { get: (target, name, receiver) => name === "notify"
      ? (message: unknown, level?: unknown) => {
        if (sink) sink.push(String(message));
        else if (level === "warning" || level === "error") log(`${level}: ${String(message).slice(0, NOTICE_LIMIT)}`);
      }
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

const promptText = (value: unknown) => typeof value === "string" ? value.replace(/[\x00-\x08\x0b-\x1f\x7f]+/g, " ").trim().slice(0, PROMPT_TEXT_LIMIT) : "";

export function describeTools(runner: ExtensionRunner): ExtensionToolDescription[] {
  return runner.getAllRegisteredTools().map(({ definition }) => {
    const snippet = promptText(definition.promptSnippet);
    const guidelines = Array.isArray(definition.promptGuidelines) ? definition.promptGuidelines.map(promptText).filter(Boolean).slice(0, GUIDELINES_LIMIT) : [];
    return {
      name: definition.name, description: String(definition.description ?? ""), parameters: JSON.parse(JSON.stringify(definition.parameters ?? {})),
      ...(definition.executionMode ? { executionMode: definition.executionMode } : {}),
      ...(snippet ? { promptSnippet: snippet } : {}), ...(guidelines.length ? { promptGuidelines: guidelines } : {}),
    };
  });
}

const toolSignature = (tools: readonly ExtensionToolDescription[]) => createHash("sha256").update(JSON.stringify(tools)).digest("base64url");

const boundary = () => ({ contextEntries: [], contextMessages: [], llmMessages: [], pendingMessages: [], canContinue: true });
const requestContext = new AsyncLocalStorage<RequestContext>();

type Handlers = { [M in ExtensionMethod]: (params: ExtensionParams<M>, signal?: AbortSignal) => Promise<ExtensionRequests[M][1]> };

export class ExtensionWorker {
  readonly #runners = new Map<string, ExtensionRunner>();
  readonly #skillPaths = new Map<string, string[]>();
  readonly #sessions = new Map<string, { current: SessionManager }>();
  readonly #followUps = new Map<string, string[]>();
  #context: RequestContext = {};
  #models: Model<string>[] = [];
  readonly #registry: ModelRegistry | undefined;
  readonly #handlers: Handlers;

  constructor(private readonly options: WorkerOptions) {
    this.#registry = options.live ? options.live.modelRegistry : describedRegistry(() => this.#models);
    this.#handlers = {
      open: params => this.open(params),
      emit: async params => {
        if (params.event.type === "agent_end") this.#followUps.delete(params.source);
        await this.runner(params).emit(params.event as never);
        return null;
      },
      restore: async params => {
        const session = this.#sessions.get(params.source);
        if (!session) throw new Error(`${params.source} isn't open`);
        session.current = restoredSession(this.options.directory, params.entries);
        return null;
      },
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
        const context = boundary();
        await this.runner(params).emitBoundary({ type: "turn_end", turnIndex: params.turnIndex, message: undefined, toolResults: [], messageEntryId: "",
          toolResultEntryIds: [], outcome: "completed" } as never, () => context as never);
        return null;
      },
      beforeSettle: async params => {
        const context = boundary();
        const result = await this.runner(params).emitBoundary({ type: "agent_before_settle", outcome: "completed" } as never, () => context as never);
        const queued = this.#followUps.get(params.source) ?? [];
        this.#followUps.delete(params.source);
        const text = [...result.entries.map(entry => "content" in entry ? textOf((entry as { content: unknown }).content) : ""), ...queued].filter(Boolean).join("\n\n");
        return { continue: result.continue === true || queued.length > 0, text };
      },
      compact: async params => {
        const result = await this.runner(params).emit({ type: "session_before_compact", reason: params.reason, willRetry: params.reason === "overflow",
          customInstructions: params.instructions, branchEntries: [], preparation: { messagesToSummarize: params.messages } as never,
          signal: new AbortController().signal } as never) as { cancel?: boolean; compaction?: { summary?: string } } | undefined;
        if (result?.cancel) return { cancel: true };
        return typeof result?.compaction?.summary === "string" ? { summary: result.compaction.summary } : null;
      },
      execute: (params, signal) => this.execute(params, signal),
      skills: params => this.skills(params),
      command: params => this.command(params),
      describe: async params => {
        const cwd = await mkdtemp(join(tmpdir(), "pikibun-extensions-"));
        try {
          const { loadExtensions } = await piLoader();
          return summarizeModules(params.root, params.files, await loadExtensions(params.files, cwd, undefined, createExtensionRuntime()), new Set());
        } finally {
          await rm(cwd, { recursive: true, force: true }).catch(() => {});
        }
      },
      shutdown: async () => {
        for (const runner of this.#runners.values()) {
          try { runner.shutdown(); } catch { }
        }
        this.#runners.clear();
        this.#skillPaths.clear();
        this.#sessions.clear();
        this.#followUps.clear();
        return null;
      },
    };
  }

  async handle<M extends ExtensionMethod>(method: M, params: ExtensionParams<M>, signal?: AbortSignal): Promise<ExtensionAnswer<M>> {
    if (!Object.hasOwn(this.#handlers, method)) throw new Error(`Unknown extension request ${String(method)}`);
    const handler = this.#handlers[method] as (params: ExtensionParams<M>, signal?: AbortSignal) => Promise<ExtensionRequests[M][1]>;
    if (params.context) this.#context = params.context;
    const inRun = RUN_METHODS.has(method) || (method === "emit" && RUN_EVENTS.has((params as ExtensionParams<"emit">).event?.type));
    const value = await requestContext.run(params.context ?? this.#context, () => inRun ? runCall.run(true, () => handler(params, signal)) : handler(params, signal));
    const source = (params as { source?: unknown }).source;
    const runner = typeof source === "string" ? this.#runners.get(source) : undefined;
    if (!runner || typeof source !== "string") return { value };
    const pending = this.#followUps.get(source)?.length ? { pending: true as const } : {};
    const handlers = [...supportedEvents].filter(event => runner.hasHandlers(event));
    let tools: ExtensionToolDescription[];
    try { tools = describeTools(runner); }
    catch (error) {
      this.options.warn(source, `its tools can't be described: ${error instanceof Error ? error.message : String(error)}`);
      return { value, handlers, ...pending };
    }
    const signature = toolSignature(tools);
    return { value, handlers, toolsSignature: signature, ...(params.toolsSeen !== signature ? { tools } : {}), ...pending };
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
    const registry = !this.options.live && params.modelCalls && this.options.complete
      ? describedRegistry(() => this.#models, streamOver(source, this.options.complete)) : this.#registry;
    const session = { current: SessionManager.inMemory(directory) };
    this.#sessions.set(source, session);
    const runner = new ExtensionRunner(result.extensions, runtime, directory, sessionView(session), registry ?? (undefined as never));
    runner.bindCore(noActions(runner, message => warn(source, message), () => this.thinkingLevel(), {
      appendEntry: (customType, data) => {
        const text = dataText(data);
        const refusal = entryRefusal(customType, text);
        if (refusal) return refusal;
        const id = session.current.appendCustomEntry(customType as string, text ? JSON.parse(text) : undefined);
        this.options.appended?.(source, { id, timestamp: session.current.getEntry(id)?.timestamp, customType, data: text });
        return undefined;
      },
      followUp: text => {
        const queued = this.#followUps.get(source) ?? [];
        if (queued.length >= FOLLOW_UPS_LIMIT) return false;
        this.#followUps.set(source, [...queued, text.slice(0, FOLLOW_UP_LIMIT)]);
        return true;
      },
    }), contextActions(() => this.model()));
    const declined = async () => ({ cancelled: true });
    runner.bindCommandContext({ waitForIdle: async () => {}, newSession: declined, fork: declined, navigateTree: declined, switchSession: declined,
      reload: async () => {} } as never);
    runner.onError(error => warn(source, `${error.event}: ${error.error}`));
    noticesOf(runner, message => warn(source, message));
    this.#runners.set(source, runner);
    if (params.skills?.length) this.#skillPaths.set(source, params.skills.filter(path => typeof path === "string"));
    const tools = describeTools(runner);
    const commands = runner.getRegisteredCommands().map(command => ({ name: command.invocationName,
      ...(typeof command.description === "string" && command.description ? { description: command.description } : {}) }));
    return { errors: result.errors.map(error => error.error), tools, commands };
  }

  private async skills(params: ExtensionParams<"skills">): Promise<ExtensionSkill[]> {
    const runner = this.runner(params);
    const paths = [...this.#skillPaths.get(params.source) ?? []];
    if (runner.hasHandlers("resources_discover")) {
      const { skillPaths } = await runner.emitResourcesDiscover(this.options.directory, "startup");
      for (const item of skillPaths) {
        const path = discoveredPath(item.path, item.extensionPath);
        if (path) paths.push(path);
      }
    }
    return collectSkills(paths);
  }

  private async command(params: ExtensionParams<"command">): Promise<ExtensionRequests["command"][1]> {
    const runner = this.runner(params);
    const command = runner.getCommand(params.name);
    if (!command) throw new Error(`${params.source} has no command /${params.name}`);
    const notices: string[] = [];
    const messages: string[] = [];
    await commandCall.run({ notices, messages }, () => command.handler(params.args, runner.createCommandContext()));
    return { notices, messages };
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
    const skills = (params.skills ?? []).filter(skill => typeof skill?.name === "string" && typeof skill.location === "string")
      .map(skill => ({ name: skill.name, description: String(skill.description ?? ""), filePath: skill.location, baseDir: dirname(skill.location), disableModelInvocation: false }));
    const options = { cwd: this.options.directory, selectedTools: [] as string[], ...(skills.length ? { skills: skills as never[] } : {}) };
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

interface SessionActions {
  appendEntry(customType: unknown, data: unknown): string | undefined;
  followUp(text: string): boolean;
}

function noActions(runner: ExtensionRunner, warn: (message: string) => void, thinkingLevel: () => string | undefined, session: SessionActions): ExtensionActions {
  const said = new Set<string>();
  const once = (message: string) => { if (!said.has(message)) { said.add(message); warn(message); } };
  const noop = (name: string) => () => once(`${name}() does nothing in Pikibun`);
  return {
    sendMessage: noop("sendMessage"),
    appendEntry: (customType: unknown, data?: unknown) => {
      const refusal = session.appendEntry(customType, data);
      if (refusal) once(`appendEntry() kept nothing: ${refusal}`);
    },
    sendUserMessage: (content: unknown) => {
      const sent = commandCall.getStore()?.messages;
      if (sent) sent.push(textOf(content));
      else if (!runCall.getStore()) once("sendUserMessage() does nothing outside a command or a message that is running: an extension can't start the agent in Pikibun");
      else if (!textOf(content).trim()) once("sendUserMessage() sends text only in Pikibun");
      else if (!session.followUp(textOf(content))) once(`sendUserMessage() queues at most ${FOLLOW_UPS_LIMIT} messages for one reply`);
    },
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

