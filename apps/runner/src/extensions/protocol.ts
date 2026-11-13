import type { ImageContent, Message, Model, TextContent } from "@earendil-works/pi-ai";
import type { ExtensionSettings } from "../../../../packages/shared/src/host-extensions.js";

export interface ExtensionToolDescription {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  executionMode?: "sequential" | "parallel";
}

export interface RequestContext {
  model?: Model<string>;
  thinkingLevel?: string;
}

export interface Scoped {
  source: string;
  settings: ExtensionSettings;
}

export type InputAnswer = {
  result: { action: "continue" } | { action: "handled" } | { action: "transform"; text?: unknown; images?: unknown };
  notices: string[];
  errors: string[];
};

export type ToolResultEvent = {
  toolCallId: string;
  toolName: string;
  input: Record<string, unknown>;
  content: (TextContent | ImageContent)[];
  isError: boolean;
  details?: unknown;
};

export type ToolOutput = { content: (TextContent | ImageContent)[]; details?: unknown };

export interface ExtensionRequests {
  open: [{ source: string; files: string[]; models: Model<string>[] }, { errors: string[]; tools: ExtensionToolDescription[] }];
  emit: [Scoped & { event: { type: string } & Record<string, unknown> }, null];
  input: [Scoped & { text: string; images: ImageContent[]; inputSource: "interactive" | "rpc" }, InputAnswer];
  beforeAgentStart: [Scoped & { prompt: string; images?: ImageContent[] }, string];
  toolCall: [Scoped & { id: string; name: string; input: Record<string, unknown> }, { block?: string; input: Record<string, unknown> }];
  toolResult: [Scoped & { event: ToolResultEvent }, { content?: (TextContent | ImageContent)[]; isError?: boolean; details?: unknown } | null];
  context: [Scoped & { messages: Message[] }, Message[] | null];
  messageEnd: [Scoped & { message: Message }, null];
  turnEnd: [Scoped & { turnIndex: number }, null];
  beforeSettle: [Scoped, { continue: boolean; text: string }];
  compact: [Scoped & { reason: string; instructions?: string; messages: Message[] }, { cancel?: true; summary?: string } | null];
  execute: [Scoped & { tool: string; callId: string; args: Record<string, unknown> }, ToolOutput];
  shutdown: [Record<string, never>, null];
}

export type ExtensionMethod = keyof ExtensionRequests;
export type ExtensionParams<M extends ExtensionMethod> = ExtensionRequests[M][0] & { context?: RequestContext };
export interface ExtensionAnswer<M extends ExtensionMethod> { value: ExtensionRequests[M][1]; handlers?: string[] }

export interface ExtensionChannel {
  call<M extends ExtensionMethod>(method: M, params: ExtensionParams<M>, signal?: AbortSignal): Promise<ExtensionAnswer<M>>;
  close(): Promise<void>;
}
