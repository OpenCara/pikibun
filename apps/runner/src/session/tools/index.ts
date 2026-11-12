import type { ToolRegistration } from "@earendil-works/pi-durable";
import { wholeForScripts } from "../../script-output.js";
import { browserTool, tunnelTool } from "./browser.js";
import type { ToolContext } from "./context.js";
import { fileTools } from "./files.js";
import { githubTools } from "./github.js";
import { programTools } from "./programs.js";
import { clonePushTool } from "./push.js";
import { scheduleTool } from "./schedule.js";
import { sessionsTool } from "./sessions.js";

export function sessionTools(context: ToolContext): ToolRegistration[] {
  return [
    ...fileTools(context),
    ...programTools(context),
    browserTool(context),
    tunnelTool(context),
    ...githubTools(context),
    scheduleTool(context),
    sessionsTool(context),
  ];
}

export function buildTools(context: ToolContext, clonePush: boolean): ToolRegistration[] {
  const tools = sessionTools(context);
  return (clonePush ? [...tools, clonePushTool(context)] : tools).map(wholeForScripts);
}
