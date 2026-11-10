import { bundledToolDefinition, type ProgramToolDefinition } from "../../../packages/shared/src/tool-definitions.js";
import { programCommand, programRequest, refusedCommand, type ProgramRequest } from "./defined-tools.js";

export const ecosystemTools = Object.freeze(["rust", "go", "dotnet", "make"] as const);
export type EcosystemTool = (typeof ecosystemTools)[number];

function definition(tool: EcosystemTool): ProgramToolDefinition {
  const found = bundledToolDefinition(tool);
  if (found?.kind !== "program") throw new Error(`No bundled definition of the ${tool} tool`);
  return found;
}

export const ecosystemPrograms = Object.freeze(Object.fromEntries(ecosystemTools.map(tool => [tool, Object.freeze([...definition(tool).programs])]))) as
  Readonly<Record<EcosystemTool, readonly string[]>>;

export function registryAccountCommand(program: string, args: readonly string[]): string | undefined {
  for (const tool of ecosystemTools) {
    const found = definition(tool);
    if (Object.hasOwn(found.grammar, program)) return refusedCommand(found, program, args);
  }
  return undefined;
}

export interface EcosystemRequest extends ProgramRequest { tool: EcosystemTool }

export function ecosystemRequest(tool: EcosystemTool, input: { program: unknown; args?: unknown; directory?: unknown }): EcosystemRequest {
  return programRequest(definition(tool), input) as EcosystemRequest;
}

export const SYSTEM_RUSTUP_HOME = "/usr/local/rustup";

export function ecosystemPath(tool: EcosystemTool): readonly string[] {
  return definition(tool).path;
}

export function ecosystemShellCommand(request: EcosystemRequest, system: { rustupHome?: boolean } = {}): string {
  return programCommand(definition(request.tool), request,
    system.rustupHome === undefined ? {} : { exists: path => path === SYSTEM_RUSTUP_HOME ? system.rustupHome! : false });
}
