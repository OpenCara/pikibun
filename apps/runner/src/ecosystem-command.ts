import { bundledToolDefinition, type ProgramToolDefinition } from "../../../packages/shared/src/tool-definitions.js";
import { programCommand, programRequest, refusedCommand, type ProgramRequest } from "./defined-tools.js";

/*
 * The rust, go, dotnet and make tools (piki:rust, piki:go, piki:dotnet, piki:make, #163, #191) as this version bundles
 * their definitions (packages/shared/src/tool-definitions.ts): each ecosystem's programs without a shell, run by the
 * defined-tools engine. Sessions run them from the definitions the control plane gives; these are the bundled ones,
 * by name, for what needs them without a session.
 */

export const ecosystemTools = Object.freeze(["rust", "go", "dotnet", "make"] as const);
export type EcosystemTool = (typeof ecosystemTools)[number];

function definition(tool: EcosystemTool): ProgramToolDefinition {
  const found = bundledToolDefinition(tool);
  if (found?.kind !== "program") throw new Error(`No bundled definition of the ${tool} tool`);
  return found;
}

/** The programs each tool runs. */
export const ecosystemPrograms = Object.freeze(Object.fromEntries(ecosystemTools.map(tool => [tool, Object.freeze([...definition(tool).programs])]))) as
  Readonly<Record<EcosystemTool, readonly string[]>>;

/**
 * The command, if `program args` is one that acts on a package registry as an account, which sessions don't have:
 * `cargo publish`, `login`, `logout`, `owner` and `yank`, also through `cargo +toolchain` and `rustup run`, and `dotnet
 * nuget push` and `delete` and storing a source's password, as the ecosystems' definitions refuse them.
 */
export function registryAccountCommand(program: string, args: readonly string[]): string | undefined {
  for (const tool of ecosystemTools) {
    const found = definition(tool);
    if (Object.hasOwn(found.grammar, program)) return refusedCommand(found, program, args);
  }
  return undefined;
}

export interface EcosystemRequest extends ProgramRequest { tool: EcosystemTool }

/** An ecosystem tool's call as it runs, or an error saying what it refused. */
export function ecosystemRequest(tool: EcosystemTool, input: { program: unknown; args?: unknown; directory?: unknown }): EcosystemRequest {
  return programRequest(definition(tool), input) as EcosystemRequest;
}

/** Where a rustup installed for the whole system keeps its toolchains, as the official rust image does (review of #194). */
export const SYSTEM_RUSTUP_HOME = "/usr/local/rustup";

/** The directories each tool looks in after the sandbox's PATH. */
export function ecosystemPath(tool: EcosystemTool): readonly string[] {
  return definition(tool).path;
}

/**
 * The shell command that runs `request`, as its card shows it. `system.rustupHome`: whether the host has a system-wide
 * rustup (SYSTEM_RUSTUP_HOME); left out, whether it exists.
 */
export function ecosystemShellCommand(request: EcosystemRequest, system: { rustupHome?: boolean } = {}): string {
  return programCommand(definition(request.tool), request,
    system.rustupHome === undefined ? {} : { exists: path => path === SYSTEM_RUSTUP_HOME ? system.rustupHome! : false });
}
