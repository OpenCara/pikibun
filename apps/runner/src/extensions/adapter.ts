import { createHash } from "node:crypto";
import type { Context } from "@earendil-works/chord/context";
import { CompactionTask, defineDoc, defineExtension, defineTool, GenerationTask, hook, section, ToolTask, type Extension, type HookRegistration,
  type ToolExecutionApi, type ToolExecutionResult, type ToolRegistration } from "@earendil-works/pi-durable";
import type { ImageContent, Message, Model, TextContent } from "@earendil-works/pi-ai";
import type { ExtensionFactory, ModelRegistry } from "@earendil-works/pi-coding-agent";
import type { ExtensionSettings } from "../../../../packages/shared/src/host-extensions.js";
import type { LoadedSource } from "./load.js";
import { connectorPikiExtension } from "./piki/index.js";
import { noPikiSession, type PikiSession } from "./piki/command.js";
import { wholeForScripts } from "../script-output.js";
import type { ExtensionChannel, ExtensionMethod, ExtensionParams, ExtensionRequests, ExtensionToolDescription } from "./protocol.js";
import { addedPrompt, directChannel, ExtensionWorker, jsonChannel, modelDescription } from "./worker.js";

export { addedPrompt };

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
}

export type InputOutcome = { action: "continue"; text: string; images: ImageContent[] } | { action: "refused"; by: string; notice?: string };

function withTimeout<T>(work: () => T | Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  return Promise.race([
    Promise.resolve().then(work),
    new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`${what} took longer than ${Math.round(ms / 1000)} seconds`)), ms); timer.unref(); }),
  ]).finally(() => clearTimeout(timer));
}

const describe = (error: unknown) => error instanceof Error ? error.message : String(error);

export function settleToolNames(sources: readonly { source: string; tools: readonly string[] }[], reserved: Iterable<string>): { source: string; kept: string[]; lost: string[] }[] {
  const taken = new Set(reserved);
  return sources.map(({ source, tools }) => {
    const kept = tools.filter(tool => !taken.has(tool));
    for (const tool of kept) taken.add(tool);
    return { source, kept, lost: tools.filter(tool => !kept.includes(tool)) };
  });
}

interface Link {
  source: string;
  channel: ExtensionChannel;
  handlers: Set<string>;
}

async function request<M extends ExtensionMethod>(host: ExtensionHost, link: Link, method: M, params: ExtensionRequests[M][0], signal?: AbortSignal): Promise<ExtensionRequests[M][1]> {
  const model = modelDescription(host.model());
  const thinkingLevel = host.thinkingLevel?.();
  const context = { ...(model ? { model } : {}), ...(thinkingLevel ? { thinkingLevel } : {}) };
  const answer = await link.channel.call(method, { ...params, context } as ExtensionParams<M>, signal);
  if (answer.handlers) {
    link.handlers.clear();
    for (const event of answer.handlers) link.handlers.add(event);
  }
  return answer.value;
}

function listedModels(host: ExtensionHost): Model<string>[] {
  try { return (host.modelRegistry?.getAll?.() ?? []).map(model => modelDescription(model as Model<string>)); }
  catch { return []; }
}

async function activeSettings(host: ExtensionHost, source: string): Promise<ExtensionSettings | undefined> {
  const state = await host.state(source);
  return state.active ? state.settings : undefined;
}

interface OpenedSource extends Link {
  dev: boolean;
  tools: ToolRegistration[];
  sections: ReturnType<typeof section>[];
  hooks: HookRegistration[];
  variants: Map<string, Extension>;
}

type Factories = { path: string; factory: ExtensionFactory }[];

export class SessionExtensions {
  readonly #opened: OpenedSource[] = [];
  readonly #reserved: Set<string>;
  readonly #factories = new Map<string, Factories>();
  #selected: SessionExtension[] = [];
  readonly #warned = new Set<string>();
  readonly #broken = new Set<string>();
  #started = false;
  #connector?: ExtensionChannel;
  #isolated?: ExtensionChannel;

  constructor(private readonly host: ExtensionHost, reserved: Iterable<string> = []) {
    this.#reserved = new Set(reserved);
  }

  reserve(names: Iterable<string>): void {
    for (const name of names) this.#reserved.add(name);
  }

  get extensions(): readonly { source: string; dev: boolean }[] { return this.#opened; }

  isOpen(source: string): boolean {
    return this.#opened.some(item => item.source === source) && !this.#broken.has(source);
  }

  get(source: string): SessionExtension | undefined { return this.#selected.find(item => item.source === source); }

  private channel(inConnector: boolean): ExtensionChannel {
    const { host } = this;
    const warn = (source: string, message: string) => host.warn(source, message);
    if (inConnector) {
      return this.#connector ??= directChannel(new ExtensionWorker({ directory: host.directory, warn, factories: source => this.#factories.get(source),
        live: { model: () => host.model(), thinkingLevel: () => host.thinkingLevel?.(), ...(host.modelRegistry ? { modelRegistry: host.modelRegistry } : {}) } }));
    }
    return this.#isolated ??= jsonChannel(new ExtensionWorker({ directory: host.directory, warn }));
  }

  async ensure(sources: readonly LoadedSource[]): Promise<void> {
    const opened: OpenedSource[] = [];
    for (const loaded of sources) {
      const source = loaded.summary.source;
      if (this.#opened.some(item => item.source === source) || loaded.summary.error) continue;
      try {
        const piki = loaded.factories && source.startsWith("piki:") ? connectorPikiExtension(source) : undefined;
        const factories = piki ? loaded.factories!.map(item => ({ path: item.path, factory: piki.forSession(this.host.piki ?? noPikiSession) })) : loaded.factories;
        if (factories) this.#factories.set(source, factories);
        const models = factories ? [] : listedModels(this.host);
        const link: Link = { source, channel: this.channel(factories !== undefined), handlers: new Set() };
        const result = await request(this.host, link, "open", { source, files: loaded.files, models });
        for (const error of result.errors) this.host.warn(source, error);
        if (result.errors.length) this.#broken.add(source);
        const offered = new Set(loaded.summary.modules.flatMap(module => module.tools.map(tool => tool.name)));
        const extension = build(link, loaded.summary.dev, result.tools.filter(tool => offered.has(tool.name)), this.host);
        this.#opened.push(extension);
        opened.push(extension);
      } catch (error) {
        this.host.warn(source, `didn't load: ${describe(error)}`);
        this.#broken.add(source);
      }
    }
    if (this.#started) for (const extension of opened) await this.emit(extension, { type: "session_start", reason: "startup" });
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
      selected.push({ source, dev: opened.dev, extension, tools });
    }
    this.#selected = selected;
    return { selected, created };
  }

  private async one(extension: OpenedSource, event: string, work: (settings: ExtensionSettings) => Promise<unknown>): Promise<void> {
    const settings = await activeSettings(this.host, extension.source);
    if (!settings) return;
    try { await withTimeout(() => work(settings), this.host.hookTimeoutMs, `${event}`); }
    catch (error) { this.host.warn(extension.source, `${event}: ${describe(error)}`); }
  }

  private emit(extension: OpenedSource, event: { type: string } & Record<string, unknown>): Promise<void> {
    return this.one(extension, event.type, settings => request(this.host, extension, "emit", { source: extension.source, settings, event }));
  }

  private async each(event: { type: string } & Record<string, unknown>): Promise<void> {
    for (const extension of this.#opened) await this.emit(extension, event);
  }

  async input(sources: readonly string[], text: string, images: ImageContent[], inputSource: "interactive" | "rpc"): Promise<InputOutcome> {
    let current = { text, images };
    for (const source of sources) {
      const opened = this.#opened.find(item => item.source === source);
      if (!opened?.handlers.has("input")) continue;
      const settings = await activeSettings(this.host, source);
      if (!settings) continue;
      try {
        const { text, images } = current;
        const answer = await withTimeout(() => request(this.host, opened, "input", { source, settings, text, images, inputSource }),
          this.host.inputTimeoutMs ?? this.host.hookTimeoutMs, `${source}'s input handlers`);
        if (answer.errors.length) return { action: "refused", by: source };
        const { result } = answer;
        if (result.action === "handled") return { action: "refused", by: source, ...(answer.notices.length ? { notice: answer.notices.at(-1)! } : {}) };
        if (result.action === "transform") {
          if (typeof result.text !== "string") throw new Error("input: transform without text");
          current = { text: result.text, images: Array.isArray(result.images) ? result.images as ImageContent[] : current.images };
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
    return this.each({ type: "session_start", reason: "startup" });
  }

  async beforeAgentStart(prompt: string, images: ImageContent[] | undefined): Promise<Record<string, string>> {
    const prompts: Record<string, string> = {};
    await this.each({ type: "agent_start" });
    for (const extension of this.#opened) {
      await this.one(extension, "before_agent_start", async settings => {
        if (!extension.handlers.has("before_agent_start")) return;
        const text = await request(this.host, extension, "beforeAgentStart", { source: extension.source, settings, prompt, ...(images?.length ? { images } : {}) });
        if (text) prompts[extension.source] = text;
      });
    }
    return prompts;
  }

  async agentEnd(messages: Message[], aborted: boolean): Promise<void> {
    await this.each({ type: "agent_end", messages });
    await this.each({ type: "agent_settled", aborted });
  }

  async shutdown(): Promise<void> {
    await this.each({ type: "session_shutdown", reason: "quit" });
    for (const channel of [this.#connector, this.#isolated]) await channel?.close().catch(() => {});
  }
}

const HARNESS_RESULT_CODES = new Set(["tool_unavailable", "invalid_arguments", "blocked", "interrupted", "restart_limit", "aborted", "abandoned"]);

export function harnessResult(result: ToolExecutionResult): boolean {
  return result.isError === true && (result.diagnostics ?? []).some(diagnostic => diagnostic.severity === "error" && HARNESS_RESULT_CODES.has(diagnostic.code ?? ""));
}

function build(link: Link, dev: boolean, described: ExtensionToolDescription[], host: ExtensionHost): OpenedSource {
  const { source } = link;
  const key = extensionKey(source);
  const ask = <M extends ExtensionMethod>(method: M, params: ExtensionRequests[M][0], signal?: AbortSignal) => request(host, link, method, params, signal);
  const settingsNow = () => activeSettings(host, source);
  const timed = <T>(event: string, work: () => Promise<T>) => withTimeout(work, host.hookTimeoutMs, `${source}'s ${event} handlers`);
  const quiet = async (event: string, work: (settings: ExtensionSettings) => Promise<unknown>) => {
    try {
      const settings = await settingsNow();
      if (settings) await timed(event, () => work(settings));
    } catch (error) { host.warn(source, `${event}: ${describe(error)}`); }
  };
  const emit = (event: { type: string } & Record<string, unknown>) => quiet(event.type, settings => ask("emit", { source, settings, event }));
  const has = (...events: string[]) => events.some(event => link.handlers.has(event));
  const tools = described.map(definition => wholeForScripts(defineTool({
    name: definition.name, description: definition.description, parameters: definition.parameters as never,
    ...(definition.executionMode ? { executionMode: definition.executionMode } : {}),
    execute: async (args, api, info) => {
      const settings = await settingsNow();
      if (!settings) throw new Error(`This extension (${source}) no longer applies to this session; ${definition.name} didn't run.`);
      const input = args as Record<string, unknown>;
      return host.runTool({ source, tool: definition.name, arguments: input, api, signal: info.abortSignal ?? new AbortController().signal, context: info },
        async signal => {
          const output = await ask("execute", { source, settings, tool: definition.name, callId: api.callId, args: input }, signal);
          return { output: output.content, ...(output.details !== undefined ? { details: output.details as never } : {}) };
        });
    },
  })));

  const hooks: HookRegistration[] = [];
  if (has("tool_call", "tool_result", "tool_execution_start", "tool_execution_end")) {
    const started = new Set<string>();
    hooks.push(hook(ToolTask, {
      beforeTool: async call => {
        const settings = await settingsNow();
        if (!settings) return undefined;
        started.add(call.id);
        await emit({ type: "tool_execution_start", toolCallId: call.id, toolName: call.name, args: call.arguments });
        if (!has("tool_call")) return undefined;
        const answer = await timed("tool_call", () => ask("toolCall", { source, settings, id: call.id, name: call.name, input: call.arguments as Record<string, unknown> }));
        if (answer.block !== undefined) return { block: answer.block || `An extension (${source}) blocked this call.` };
        return JSON.stringify(answer.input) === JSON.stringify(call.arguments) ? undefined : { arguments: answer.input as never };
      },
      afterTool: async (call, result) => {
        const began = started.delete(call.id);
        const settings = await settingsNow();
        if (!settings) return undefined;
        const content = (result.output ?? []) as (TextContent | ImageContent)[];
        if (harnessResult(result)) {
          const errors = (result.diagnostics ?? []).filter(diagnostic => diagnostic.severity === "error").map(diagnostic => ({ type: "text" as const, text: diagnostic.message }));
          if (began) await emit({ type: "tool_execution_end", toolCallId: call.id, toolName: call.name, result: [...content, ...errors], isError: true });
          return undefined;
        }
        let replaced: ToolExecutionResult | undefined;
        if (has("tool_result")) {
          try {
            const next = await timed("tool_result", () => ask("toolResult", { source, settings, event: { toolCallId: call.id, toolName: call.name,
              input: call.arguments as Record<string, unknown>, content, isError: result.isError === true, ...(result.details !== undefined ? { details: result.details } : {}) } }));
            if (next) replaced = { ...result, ...(next.content ? { output: next.content } : {}), ...(next.isError !== undefined ? { isError: next.isError } : {}),
              ...(next.details !== undefined ? { details: next.details as never } : {}) };
          } catch (error) { host.warn(source, `tool_result: ${describe(error)}`); }
        }
        await emit({ type: "tool_execution_end", toolCallId: call.id, toolName: call.name, result: replaced?.output ?? content, isError: (replaced ?? result).isError === true });
        return replaced;
      },
    }));
  }
  if (has("context", "context_with_system", "turn_start", "turn_end", "message_end", "agent_before_settle")) {
    let turn = 0;
    hooks.push(hook(GenerationTask, {
      beforeRequest: async generation => {
        const settings = await settingsNow();
        if (!settings) return undefined;
        await emit({ type: "turn_start", turnIndex: turn++, timestamp: Date.now() });
        if (!has("context", "context_with_system")) return undefined;
        try {
          const messages = await timed("context", () => ask("context", { source, settings, messages: generation.messages as Message[] }));
          return messages === null ? undefined : { messages };
        } catch (error) {
          host.warn(source, `context: ${describe(error)}`);
          return undefined;
        }
      },
      afterResponse: async message => {
        await quiet("message_end", settings => ask("messageEnd", { source, settings, message: message as Message }));
      },
      afterTools: async () => {
        await quiet("turn_end", settings => ask("turnEnd", { source, settings, turnIndex: turn }));
      },
      onYield: async () => {
        if (!has("agent_before_settle")) return undefined;
        const settings = await settingsNow();
        if (!settings) return undefined;
        try {
          const result = await timed("agent_before_settle", () => ask("beforeSettle", { source, settings }));
          return result.continue ? { continue: result.text || "Continue." } : undefined;
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
        const settings = await settingsNow();
        if (!settings) return undefined;
        try {
          const result = await timed("session_before_compact", () => ask("compact", { source, settings, reason: compaction.reason,
            ...(compaction.instructions !== undefined ? { instructions: compaction.instructions } : {}), messages: compaction.messages as Message[] }));
          if (result?.cancel) return { decline: true };
          if (typeof result?.summary === "string" && result.summary.trim()) return { summary: result.summary };
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
  return { ...link, dev, tools, sections, hooks, variants: new Map() };
}
