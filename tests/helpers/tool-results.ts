import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { ToolResultEntry, type ConversationId, type Harness } from "@earendil-works/pi-durable";
import type { RunnerSession } from "../../apps/runner/src/session.js";

export interface StoredToolResult {
  tool: string;
  text: string;
  details: Record<string, unknown> | undefined;
  isError: boolean;
}

type ResultMessage = { toolName: string; content: { type: string; text?: string }[]; details?: Record<string, unknown>; isError?: boolean };

export async function storedToolResults(session: RunnerSession, conversationId: number | string): Promise<StoredToolResult[]> {
  const harness = (session as unknown as { harness: Harness }).harness;
  const conversation = await harness.conversation(Number(conversationId) as ConversationId, context);
  if (!conversation) return [];
  const entries = (await conversation.context(context)).entries.filter(entry => entry.kind === ToolResultEntry.kind) as unknown as { model?: ResultMessage[] }[];
  return entries.flatMap(entry => (entry.model ?? []).map(message => ({
    tool: message.toolName,
    text: message.content.flatMap(part => part.type === "text" && typeof part.text === "string" ? [part.text] : []).join("\n"),
    details: message.details,
    isError: message.isError === true,
  })));
}
