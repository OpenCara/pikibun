import type { AssistantMessage, ImageContent, Message, Static, TextContent, TSchema } from "@earendil-works/pi-ai";
import type { Type } from "@earendil-works/pi-ai";
import type { HostExtensionEvent, JsonObject, JsonValue } from "../../../../packages/shared/src/host-extensions.js";

/*
 * The API a host extension is written against (docs/design/host-extensions.md). Modelled on Pi's ExtensionAPI, keeping
 * its names where pi-durable has the same thing, and only what a shared, headless, durable session can offer: no UI, no
 * commands, no session switching, no providers. The connector builds each extension into a pi-durable Extension
 * (adapter.ts), once per session.
 */

/** The session an extension works in, read-only. */
export interface ExtensionSession {
  readonly id: string;
  readonly workspaceId: string;
  readonly owner: { readonly id: string; readonly displayName?: string };
  /** The session runs directly on the host (Sessions on the host, or an unsandboxed host), not in the sandbox. */
  readonly onHost: boolean;
  /** The session's worktree on the host: where its files are. Changing them outside its tools bypasses its approvals. */
  readonly directory: string;
}

/** What every handler and tool gets. */
export interface ExtensionContext<Settings = unknown> {
  readonly session: ExtensionSession;
  /** The extension's settings as the host's owner and admins set them in Pikibun, defaults filled in. */
  readonly settings: Settings;
}

export interface ExtensionToolContext<Settings = unknown> extends ExtensionContext<Settings> {
  /** Aborts when the call is stopped or reaches the host's command time limit. */
  readonly signal: AbortSignal;
  readonly callId: string;
  /** Streams running output; it becomes the result when `execute` returns no content. */
  output(chunk: string): void;
}

export type ExtensionToolResult = string | {
  content?: (TextContent | ImageContent)[];
  isError?: boolean;
  details?: JsonValue;
};

export interface ExtensionTool<Parameters extends TSchema = TSchema, Settings = unknown> {
  /** Letters, digits, `_` and `-`, starting with a letter, 64 at most; unique on the host, and not one of Pikibun's tools. */
  name: string;
  description: string;
  /** TypeBox (`pi.Type`) or plain JSON Schema; arguments are validated against it before `execute`. */
  parameters: Parameters;
  /** Whether a call interrupted by a restart may run again. Default `unsafe`: the model is told it was interrupted. */
  replay?: "safe" | "unsafe";
  /** `sequential`: the round's other calls wait for this one. */
  executionMode?: "parallel" | "sequential";
  execute(args: Static<Parameters>, ctx: ExtensionToolContext<Settings>): Promise<ExtensionToolResult>;
}

export interface ToolCallEvent {
  readonly id: string;
  readonly name: string;
  readonly arguments: Readonly<Record<string, unknown>>;
}

export interface ToolResultEvent {
  readonly content: readonly (TextContent | ImageContent)[];
  readonly isError: boolean;
}

export interface CompactionEvent {
  readonly reason: "manual" | "threshold" | "overflow";
  readonly messages: readonly Message[];
  readonly instructions?: string;
}

type Maybe<T> = T | undefined | void | Promise<T | undefined | void>;

/** Handlers by event, each with its pi-durable counterpart (adapter.ts). */
export interface ExtensionHandlers<Settings = unknown> {
  /** Text added to the system prompt before each request (a pi-durable section). */
  before_agent_start: (ctx: ExtensionContext<Settings>) => Maybe<string>;
  /** Replace the messages of one request (GenerationHooks.beforeRequest); runs again on every retry. */
  context: (messages: readonly Message[], ctx: ExtensionContext<Settings>) => Maybe<readonly Message[]>;
  /** Block a tool call, or replace its arguments, before it runs (ToolHooks.beforeTool). A throw blocks it. */
  tool_call: (call: ToolCallEvent, ctx: ExtensionContext<Settings>) => Maybe<{ block: string } | { arguments: JsonObject }>;
  /** Replace a tool call's result (ToolHooks.afterTool). */
  tool_result: (call: ToolCallEvent, result: ToolResultEvent, ctx: ExtensionContext<Settings>) => Maybe<{ content: (TextContent | ImageContent)[]; isError?: boolean }>;
  /** Once a round's tool calls are done (GenerationHooks.afterTools). */
  turn_end: (ctx: ExtensionContext<Settings>) => Maybe<void>;
  /** Each final provider message (GenerationHooks.afterResponse). */
  message_end: (message: AssistantMessage, ctx: ExtensionContext<Settings>) => Maybe<void>;
  /** Before the agent stops: `continue` sends it another user message (GenerationHooks.onYield). */
  agent_before_settle: (answer: AssistantMessage, ctx: ExtensionContext<Settings>) => Maybe<{ continue: string }>;
  /** Before a compaction: decline it, or give the summary (CompactionHooks.beforeCompact). */
  session_before_compact: (compaction: CompactionEvent, ctx: ExtensionContext<Settings>) => Maybe<{ decline: true } | { summary: string }>;
}

export interface PikibunExtensionAPI<Settings = unknown> {
  /** The extension's name on the host. */
  readonly name: string;
  /** TypeBox, for tool parameters and settings, without a dependency of the extension's own. */
  readonly Type: typeof Type;
  /** Shown on the host's page in Pikibun. */
  describe(description: string): void;
  /**
   * Declares the extension's settings: a JSON Schema object whose properties the host's owner and admins set in
   * Pikibun. Never put secrets there; read them on the host. Returns the current settings, defaults filled in.
   */
  settings<Schema extends TSchema>(schema: Schema): () => Static<Schema>;
  registerTool<Parameters extends TSchema>(tool: ExtensionTool<Parameters, Settings>): void;
  on<Event extends HostExtensionEvent>(event: Event, handler: ExtensionHandlers<Settings>[Event]): void;
}

/** What a host extension module exports by default. */
export type PikibunExtensionFactory = (pi: PikibunExtensionAPI) => void | Promise<void>;
