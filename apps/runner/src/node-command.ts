import { bundledToolDefinition, type ProgramToolDefinition } from "../../../packages/shared/src/tool-definitions.js";
import { programCommand, programRequest, refusedCommand } from "./defined-tools.js";

function definition(): ProgramToolDefinition {
  const found = bundledToolDefinition("node");
  if (found?.kind !== "program") throw new Error("No bundled definition of the node tool");
  return found;
}

export const nodePrograms = Object.freeze(["node", "npm", "npx", "pnpm", "yarn", "corepack"] as const);
export type NodeProgram = (typeof nodePrograms)[number];

export function registryAccountCommand(program: string, args: readonly string[]): string | undefined {
  return refusedCommand(definition(), program, args);
}

export const NODE_ENVIRONMENT = definition().environment.map(([name, value]) => `${name}=${value}`).join(" ");

export interface NodeRequest {
  program: NodeProgram;
  directory: string;
  args: string[];
}

export function nodeRequest(input: { program: unknown; args?: unknown; directory?: unknown }): NodeRequest {
  const { program, directory, args } = programRequest(definition(), input);
  return { program: program as NodeProgram, directory, args };
}

export function nodeShellCommand(request: NodeRequest, bin?: string): string {
  return programCommand(definition(), { tool: "node", ...request }, bin ? { nodeBin: bin } : {});
}
