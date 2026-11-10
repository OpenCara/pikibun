import { AsyncLocalStorage } from "node:async_hooks";
import type { Context } from "@earendil-works/chord/context";
import { boundOutput as boundText } from "@earendil-works/chord/output";
import type { ToolExecutionApi, ToolExecutionResult, ToolRegistration } from "@earendil-works/pi-durable";
import { MODEL_OUTPUT, SAVED_OUTPUT_BYTES, scriptOutput } from "./tool-output.js";

type Limits = { maxBytes: number; maxLines: number; retain: "head" | "tail" };
type Content = NonNullable<ToolExecutionResult["output"]>;

/**
 * The Harness bounds a tool's output with the tool's own `outputLimits`, for the model and for a script's nested call
 * alike. A tool wrapped here declares the script cap instead, and bounds a model-issued call itself, as the Harness did.
 */
export const SCRIPT_OUTPUT_LIMITS = { maxBytes: SAVED_OUTPUT_BYTES + 1024, maxLines: Number.MAX_SAFE_INTEGER } as const;

const scriptCalls = new AsyncLocalStorage<boolean>();

/** Whether the tool call running now came from a code mode script, so its output goes to the script whole. */
export function inScriptCall(): boolean {
  return scriptCalls.getStore() === true;
}

/**
 * Whether the tool task is a nested call: one a running tool made through `executeTool()`, as code mode does for each
 * of a script's calls, rather than one the model made. Read from the task's durable input, so it holds after a restart.
 */
export async function calledByScript(api: ToolExecutionApi, context: Context): Promise<boolean> {
  try {
    const input = (await api.getTask(api.taskId, context))?.input;
    return !!input && typeof input === "object" && !Array.isArray(input) && (input as { kind?: unknown }).kind === "nested";
  } catch {
    return false;
  }
}

/** The output with its text items replaced by one, `text`, where `keep` was; images stay. */
function withText(output: Content, keep: Content[number] | undefined, text: string): Content {
  const content: Content[number][] = [];
  for (const item of output) {
    if (item.type !== "text") content.push(item);
    else if (item === keep) content.push({ ...item, text });
  }
  return content;
}

/** The Harness's own bound of a result for the model: its joined text cut to the limits, with its truncation diagnostic. */
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

/** A script's result: whole up to the script cap, else its head and tail with a note of what was left out. */
export function capForScript(result: ToolExecutionResult): ToolExecutionResult {
  const output = result.output;
  if (!output) return result;
  const texts = output.filter(item => item.type === "text");
  const joined = texts.map(item => item.text).join("");
  const capped = scriptOutput(joined);
  if (capped === joined) return result;
  return { ...result, output: withText(output, texts[0], capped) };
}

/**
 * The tool, giving a code mode script its whole output (up to about 1 MB) instead of what the model is shown: scripts
 * are there to filter large output, and a cut one breaks them (JSON.parse of half a document). A call the model makes is
 * bounded as before. Tools only the model calls are left as they are.
 */
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
      const result = await scriptCalls.run(script, () => tool.execute(args, api, context));
      return script ? capForScript(result) : boundForModel(result, limits);
    },
  } as ToolRegistration;
}
