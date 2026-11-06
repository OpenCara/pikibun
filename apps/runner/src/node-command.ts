import { bundledToolDefinition, type ProgramToolDefinition } from "../../../packages/shared/src/tool-definitions.js";
import { programCommand, programRequest, refusedCommand } from "./defined-tools.js";

/*
 * The node tool (piki:node, #163) as this version bundles its definition (packages/shared/src/tool-definitions.ts):
 * Node.js and its package managers without a shell, run by the defined-tools engine. Sessions run it from the
 * definitions the control plane gives; this is the bundled one, for the browser tool's `serve` and what else needs it
 * without a session.
 */

function definition(): ProgramToolDefinition {
  const found = bundledToolDefinition("node");
  if (found?.kind !== "program") throw new Error("No bundled definition of the node tool");
  return found;
}

/** The programs the node tool runs. */
export const nodePrograms = Object.freeze(["node", "npm", "npx", "pnpm", "yarn", "corepack"] as const);
export type NodeProgram = (typeof nodePrograms)[number];

/**
 * The command that acts on a registry as an account `program` would run with `args`, if any, as `<program> <command>`:
 * a package manager's own command, past its options, wrappers (`recursive`, yarn's `npm`) and `workspace <name>`, and
 * the same through `corepack <manager>`, `npx` and the managers' `exec`, `x` and `dlx` (the node definition's grammar).
 */
export function registryAccountCommand(program: string, args: readonly string[]): string | undefined {
  return refusedCommand(definition(), program, args);
}

/** Fixed for every call: no colours in the output, and no prompt from corepack or npx (input is closed, so either would only fail). */
export const NODE_ENVIRONMENT = definition().environment.map(([name, value]) => `${name}=${value}`).join(" ");

export interface NodeRequest {
  program: NodeProgram;
  /** The worktree directory it runs in, relative and without `..`: "." for the worktree itself. */
  directory: string;
  args: string[];
}

/** The node tool's call as it runs, or an error saying what it refused. */
export function nodeRequest(input: { program: unknown; args?: unknown; directory?: unknown }): NodeRequest {
  const { program, directory, args } = programRequest(definition(), input);
  return { program: program as NodeProgram, directory, args };
}

/**
 * The shell command that runs `request`, as its card shows it. `bin`: where the session's commands find the connector's
 * own Node.js (SessionWorkspace.nodeBin), looked in first; without it, the Node.js on their PATH.
 */
export function nodeShellCommand(request: NodeRequest, bin?: string): string {
  return programCommand(definition(), { tool: "node", ...request }, bin ? { nodeBin: bin } : {});
}
