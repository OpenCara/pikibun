import { AsyncLocalStorage } from "node:async_hooks";
import type { Context } from "@earendil-works/chord/context";
import { boundOutput as boundText } from "@earendil-works/chord/output";
import type { ToolExecutionApi, ToolExecutionResult, ToolRegistration } from "@earendil-works/pi-durable";
import { MODEL_OUTPUT, SAVED_OUTPUT_BYTES, scriptOutput } from "./tool-output.js";

type Limits = { maxBytes: number; maxLines: number; retain: "head" | "tail" };
type Content = NonNullable<ToolExecutionResult["output"]>;

export const SCRIPT_OUTPUT_LIMITS = { maxBytes: SAVED_OUTPUT_BYTES + 1024, maxLines: Number.MAX_SAFE_INTEGER } as const;

const scriptCalls = new AsyncLocalStorage<boolean>();

export function inScriptCall(): boolean {
  return scriptCalls.getStore() === true;
}

export async function calledByScript(api: ToolExecutionApi, context: Context): Promise<boolean> {
  try {
    const input = (await api.getTask(api.taskId, context))?.input;
    return !!input && typeof input === "object" && !Array.isArray(input) && (input as { kind?: unknown }).kind === "nested";
  } catch {
    return false;
  }
}

function withText(output: Content, keep: Content[number] | undefined, text: string): Content {
  const content: Content[number][] = [];
  for (const item of output) {
    if (item.type !== "text") content.push(item);
    else if (item === keep) content.push({ ...item, text });
  }
  return content;
}

export function boundForModel(result: ToolExecutionResult, limits: Limits): ToolExecutionResult {
  const output = result.output;
  if (!output) return result;
  const texts = output.filter(item => item.type === "text");
  const bounded = boundText(texts.map(item => item.text).join(""), limits);
  if (bounded.droppedBytes === 0) return result;
  const keep = limits.retain === "head" ? texts[0] : texts.at(-1);
  const content = withText(output, keep, bounded.text);
  const kept = limits.retain === "head" ? "beginning" : "end";
  return { ...result, output: content, diagnostics: [...(result.diagnostics ?? []),
    { severity: "warn", code: "truncated", message: `Output truncated to its ${kept}: ${bounded.droppedLines} lines, ${bounded.droppedBytes} bytes dropped` }] };
}

function withRetained(result: ToolExecutionResult, api: ToolExecutionApi): ToolExecutionResult {
  if (result.output !== undefined) return result;
  const retained = api.retainedOutput();
  return { ...result, output: retained.text === "" ? [] : [{ type: "text", text: retained.text }] };
}

export function capForScript(result: ToolExecutionResult): ToolExecutionResult {
  const output = result.output;
  if (!output) return result;
  const texts = output.filter(item => item.type === "text");
  const joined = texts.map(item => item.text).join("");
  const capped = scriptOutput(joined);
  if (capped === joined) return result;
  return { ...result, output: withText(output, texts[0], capped) };
}

export function wholeForScripts(tool: ToolRegistration): ToolRegistration {
  if (tool.callers && !tool.callers.includes("tools")) return tool;
  const limits: Limits = {
    maxBytes: tool.outputLimits?.maxBytes ?? MODEL_OUTPUT.bytes,
    maxLines: tool.outputLimits?.maxLines ?? MODEL_OUTPUT.lines,
    retain: tool.outputLimits?.retain ?? "head",
  };
  return {
    ...tool,
    outputLimits: { maxBytes: Math.max(limits.maxBytes, SCRIPT_OUTPUT_LIMITS.maxBytes), maxLines: Math.max(limits.maxLines, SCRIPT_OUTPUT_LIMITS.maxLines), retain: limits.retain },
    execute: async (args: never, api: ToolExecutionApi, context: Context) => {
      const script = await calledByScript(api, context);
      const result = withRetained(await scriptCalls.run(script, () => tool.execute(args, api, context)), api);
      return script ? capForScript(result) : boundForModel(result, limits);
    },
  } as ToolRegistration;
}
