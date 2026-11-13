import { hook, ToolTask, type HookRegistration, type ToolExecutionResult } from "@earendil-works/pi-durable";
import { canonicalToolName } from "../../../../packages/shared/src/types.js";

const UNAVAILABLE = "tool_unavailable";

export function renamedToolNote(name: string, result: ToolExecutionResult): ToolExecutionResult | undefined {
  const renamed = canonicalToolName(name);
  if (renamed === name || result.isError !== true || !(result.diagnostics ?? []).some(item => item.code === UNAVAILABLE)) return undefined;
  return { ...result, diagnostics: [...(result.diagnostics ?? []),
    { severity: "info", code: "renamed_tool", message: `${name} is called ${renamed} now, with the parameters and answers of Pi's own ${renamed}: call ${renamed} instead.` }] };
}

export function renamedToolsHook(): HookRegistration {
  return hook(ToolTask, { afterTool: async (call, result) => renamedToolNote(call.name, result) });
}
