import { existsSync } from "node:fs";
import { bundledToolDefinitions, type BrokeredParameter, type BrokeredToolDefinition, type ProgramGrammar, type ProgramToolDefinition, type ToolDefinition } from "../../../packages/shared/src/tool-definitions.js";
import { programArguments, programShellCommand, workDirectory } from "./program-command.js";

/*
 * The engine that runs tools defined as data (packages/shared/src/tool-definitions.ts, docs/design/tool-definitions.md):
 * a program tool's call becomes one program and its quoted arguments, refused first where its definition's grammar finds
 * a command it refuses; a brokered tool's arguments are checked against its parameters before the call goes to the
 * control plane. Nothing in a definition runs as code here: its grammar is interpreted, its values are checked words.
 */

/** How deep launchers and runners are followed (npx corepack pnpm dlx npm publish). */
const MAX_DEPTH = 4;

/**
 * The program tools defined as data this connector knows: those it bundles, and every one it has read from the control
 * plane since it started. A program operation names one of them or one of Pikibun's own (validateOperation). A session
 * reads the definitions as it opens, before any decision of its own can come back, so its operations' tools are here.
 */
const knownProgramTools = new Set<string>(bundledToolDefinitions.filter(item => item.kind === "program").map(item => item.name));

/** Notes `definitions` as known (knownProgramTools). */
export function rememberToolDefinitions(definitions: readonly ToolDefinition[]): void {
  for (const definition of definitions) if (definition.kind === "program") knownProgramTools.add(definition.name);
}

/** Whether `name` is a program tool defined as data this connector knows. */
export function knownDefinedProgramTool(name: string): boolean {
  return knownProgramTools.has(name);
}

/** A package's name without the version a launcher may give it: pnpm@9 is pnpm, @scope/tool@1 is @scope/tool. */
function packageName(spec: string): string {
  const at = spec.indexOf("@", 1);
  return at === -1 ? spec : spec.slice(0, at);
}

/** The command's positional arguments, each with where it is, past options and the values of `valued`; at `--`, as `doubleDash` says. */
function positionals(args: readonly string[], valued: ReadonlySet<string>, doubleDash: "stop" | "skip"): { arg: string; index: number }[] {
  const found: { arg: string; index: number }[] = [];
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!;
    if (arg === "--") { if (doubleDash === "stop") break; continue; }
    if (arg.startsWith("-")) { if (!arg.includes("=") && valued.has(arg)) index++; continue; }
    found.push({ arg, index });
  }
  return found;
}

/** The first argument from `from` past options, their values and any `--`: what a launcher or runner runs. */
function launched(args: readonly string[], from: number, valued: ReadonlySet<string>): { name: string; index: number } | undefined {
  for (let index = from; index < args.length; index++) {
    const arg = args[index]!;
    if (arg === "--") continue;
    if (arg.startsWith("-")) { if (!arg.includes("=") && valued.has(arg)) index++; continue; }
    return { name: packageName(arg), index };
  }
  return undefined;
}

/**
 * The command `program args` would run that `definition` refuses, named as its rule names it, if any: found in the
 * program's grammar, and followed through what it launches by name, within the definition's own programs' grammars.
 * Only the plain forms: the call's approval is what stands for the rest, as for a script that publishes.
 */
export function refusedCommand(definition: Pick<ProgramToolDefinition, "grammar">, program: string, args: readonly string[], depth = 0): string | undefined {
  if (depth > MAX_DEPTH) return undefined;
  const grammar: ProgramGrammar | undefined = Object.hasOwn(definition.grammar, program) ? definition.grammar[program] : undefined;
  if (!grammar) return undefined;
  const rest = grammar.toolchainPrefix && args[0]?.startsWith("+") ? args.slice(1) : args;
  const valued = new Set(grammar.valued ?? []);
  const follow = (next: { name: string; index: number } | undefined) =>
    next && Object.hasOwn(definition.grammar, next.name) ? refusedCommand(definition, next.name, rest.slice(next.index + 1), depth + 1) : undefined;
  if (grammar.launcher) return follow(launched(rest, 0, new Set(grammar.launcher.valued ?? [])));
  const found = positionals(rest, valued, grammar.doubleDash ?? "stop");
  for (let at = 0; at < found.length;) {
    const { arg } = found[at]!;
    if (grammar.skip?.includes(arg)) { at++; continue; }
    if (grammar.skipWithValue?.includes(arg)) { at += 2; continue; }
    const runner = grammar.runners?.find(item => item.words.every((word, offset) => found[at + offset]?.arg === word));
    if (runner) {
      let from = found[at + runner.words.length - 1]!.index + 1;
      for (let skipped = 0; skipped < (runner.skip ?? 0); skipped++) {
        const passed = launched(rest, from, valued);
        if (!passed) return undefined;
        from = passed.index + 1;
      }
      return follow(launched(rest, from, valued));
    }
    for (const rule of grammar.refuse ?? []) {
      if (!rule.words.every((alternatives, offset) => found[at + offset] !== undefined && alternatives.includes(found[at + offset]!.arg))) continue;
      if (rule.anyArgument !== undefined) {
        const pattern = new RegExp(rule.anyArgument, "s");
        if (!rest.some(item => pattern.test(item))) continue;
      }
      return rule.command.replace(/\{(\d)\}/g, (_, index: string) => found[at + Number(index)]?.arg ?? "");
    }
    return undefined;
  }
  return undefined;
}

export interface ProgramRequest {
  tool: string;
  program: string;
  /** The worktree directory it runs in, relative and without `..`: "." for the worktree itself. */
  directory: string;
  args: string[];
}

/** A program tool's call as it runs, or an error saying what it refused. */
export function programRequest(definition: ProgramToolDefinition, input: { program: unknown; args?: unknown; directory?: unknown }): ProgramRequest {
  if (typeof input.program !== "string" || !definition.programs.includes(input.program)) throw new Error(`program is one of ${definition.programs.join(", ")}`);
  const args = programArguments(input.args ?? [], definition.example);
  const command = refusedCommand(definition, input.program, args);
  if (command !== undefined) throw new Error(`${command} ${definition.refusal}: the ${definition.name} tool doesn't run it`);
  return { tool: definition.name, program: input.program, directory: workDirectory(input.directory), args };
}

/** What the host provides a program tool: the connector's own Node.js, and which directories exist (its system defaults). */
export interface ProgramHost {
  nodeBin?: string;
  exists?: (path: string) => boolean;
}

/**
 * The shell command that runs `request`, as its card shows it: the definition's fixed environment, its system defaults
 * where the host has them (`NAME="${NAME:-value}"`, so the session's own setting wins), its directories after PATH and
 * its toolchain before it.
 */
export function programCommand(definition: ProgramToolDefinition, request: ProgramRequest, host: ProgramHost = {}): string {
  const exists = host.exists ?? existsSync;
  const prefix = [
    ...definition.environment.map(([name, value]) => `${name}=${value}`),
    ...(definition.systemDefaults ?? []).filter(item => exists(item.value)).map(item => `${item.variable}="\${${item.variable}:-${item.value}}"`),
  ].join(" ");
  return programShellCommand({ directory: request.directory, path: definition.path, ...(definition.toolchain === "node" && host.nodeBin ? { first: host.nodeBin } : {}),
    ...(prefix ? { prefix } : {}), program: request.program, args: request.args });
}

/** A brokered parameter's value as the call passes it on, or an error saying why not. */
function brokeredValue(name: string, parameter: BrokeredParameter, value: unknown): unknown {
  const invalid = () => new Error(parameter.invalid ?? `${name} is not a valid ${parameter.type}`);
  if (parameter.type === "boolean") { if (typeof value !== "boolean") throw invalid(); return value; }
  if (parameter.type === "integer") {
    if (!Number.isSafeInteger(value) || (parameter.minimum !== undefined && (value as number) < parameter.minimum)
      || (parameter.maximum !== undefined && (value as number) > parameter.maximum)) throw invalid();
    return value;
  }
  if (typeof value !== "string" || value.includes("\0") || (parameter.maxLength !== undefined && value.length > parameter.maxLength)) throw invalid();
  if (parameter.line && (value.trim() === "" || /[\x00-\x1f\x7f]/.test(value))) throw invalid();
  if (parameter.pattern !== undefined && !new RegExp(parameter.pattern, "s").test(value)) throw invalid();
  if (parameter.enum && !parameter.enum.includes(value)) throw invalid();
  return parameter.line ? value.trim() : value;
}

/** A brokered call's arguments, checked against its definition's parameters: those it names, each as it says. */
export function brokeredArguments(definition: BrokeredToolDefinition, args: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const name of Object.keys(args)) if (!Object.hasOwn(definition.parameters, name)) throw new Error(`${definition.name} takes no ${name.slice(0, 64)}`);
  for (const [name, parameter] of Object.entries(definition.parameters)) {
    if (args[name] === undefined) {
      if (parameter.required) throw new Error(parameter.invalid ?? `${name} is required`);
      continue;
    }
    result[name] = brokeredValue(name, parameter, args[name]);
  }
  return result;
}

/** What a brokered call's permission card shows, as the control plane checks a one-call permission: the target's parameters given, joined by ": ". */
export function brokeredTarget(definition: BrokeredToolDefinition, args: Record<string, unknown>): string {
  return definition.target.filter(name => args[name] !== undefined).map(name => String(args[name])).join(": ").slice(0, 8192);
}

/** The program tools' shared paragraph of the agent's instructions, for those of `definitions` that take a share of it. */
export function programToolsInstructions(definitions: readonly ToolDefinition[]): string | undefined {
  const shared = definitions.filter((item): item is ProgramToolDefinition & { summary: NonNullable<ProgramToolDefinition["summary"]> } => item.kind === "program" && !!item.summary);
  if (!shared.length) return undefined;
  return `Run ${shared.map(item => item.summary.programs).join(", ")} with the ${shared.map(item => item.name).join(", ")} tool${shared.length > 1 ? "s" : ""}: `
    + `the program, its arguments as a list and the clone's directory, such as ${shared[0]!.summary.example}.`;
}
