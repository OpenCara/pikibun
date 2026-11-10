import { existsSync } from "node:fs";
import { bundledToolDefinitions, type BrokeredParameter, type BrokeredToolDefinition, type ProgramGrammar, type ProgramToolDefinition, type ToolDefinition } from "../../../packages/shared/src/tool-definitions.js";
import { programArguments, programShellCommand, workDirectory } from "./program-command.js";

const MAX_DEPTH = 4;

const knownProgramTools = new Set<string>(bundledToolDefinitions.filter(item => item.kind === "program").map(item => item.name));

export function rememberToolDefinitions(definitions: readonly ToolDefinition[]): void {
  for (const definition of definitions) if (definition.kind === "program") knownProgramTools.add(definition.name);
}

export function knownDefinedProgramTool(name: string): boolean {
  return knownProgramTools.has(name);
}

function packageName(spec: string): string {
  const at = spec.indexOf("@", 1);
  return at === -1 ? spec : spec.slice(0, at);
}

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

function launched(args: readonly string[], from: number, valued: ReadonlySet<string>): { name: string; index: number } | undefined {
  for (let index = from; index < args.length; index++) {
    const arg = args[index]!;
    if (arg === "--") continue;
    if (arg.startsWith("-")) { if (!arg.includes("=") && valued.has(arg)) index++; continue; }
    return { name: packageName(arg), index };
  }
  return undefined;
}

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
  directory: string;
  args: string[];
}

export function programRequest(definition: ProgramToolDefinition, input: { program: unknown; args?: unknown; directory?: unknown }): ProgramRequest {
  if (typeof input.program !== "string" || !definition.programs.includes(input.program)) throw new Error(`program is one of ${definition.programs.join(", ")}`);
  const args = programArguments(input.args ?? [], definition.example);
  const command = refusedCommand(definition, input.program, args);
  if (command !== undefined) throw new Error(`${command} ${definition.refusal}: the ${definition.name} tool doesn't run it`);
  return { tool: definition.name, program: input.program, directory: workDirectory(input.directory), args };
}

export interface ProgramHost {
  nodeBin?: string;
  exists?: (path: string) => boolean;
}

export function programCommand(definition: ProgramToolDefinition, request: ProgramRequest, host: ProgramHost = {}): string {
  const exists = host.exists ?? existsSync;
  const prefix = [
    ...definition.environment.map(([name, value]) => `${name}=${value}`),
    ...(definition.systemDefaults ?? []).filter(item => exists(item.value)).map(item => `${item.variable}="\${${item.variable}:-${item.value}}"`),
  ].join(" ");
  return programShellCommand({ directory: request.directory, path: definition.path, ...(definition.toolchain === "node" && host.nodeBin ? { first: host.nodeBin } : {}),
    ...(prefix ? { prefix } : {}), program: request.program, args: request.args });
}

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

export function brokeredTarget(definition: BrokeredToolDefinition, args: Record<string, unknown>): string {
  return definition.target.filter(name => args[name] !== undefined).map(name => String(args[name])).join(": ").slice(0, 8192);
}

export function programToolsInstructions(definitions: readonly ToolDefinition[]): string | undefined {
  const shared = definitions.filter((item): item is ProgramToolDefinition & { summary: NonNullable<ProgramToolDefinition["summary"]> } => item.kind === "program" && !!item.summary);
  if (!shared.length) return undefined;
  return `Run ${shared.map(item => item.summary.programs).join(", ")} with the ${shared.map(item => item.name).join(", ")} tool${shared.length > 1 ? "s" : ""}: `
    + `the program, its arguments as a list and the clone's directory, such as ${shared[0]!.summary.example}.`;
}
