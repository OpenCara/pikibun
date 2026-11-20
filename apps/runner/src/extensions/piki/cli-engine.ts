import type { CliDefinition, CliRefusal } from "../../../../../packages/shared/src/cli-definitions.js";
import { pikiExtension } from "../../../../../packages/shared/src/piki-extensions.js";
import { apiWrites, commandWords, hasOption, hasShortOption, positionals, type CliSpec } from "./command.js";

export interface CliRules {
  refused(args: readonly string[]): string | undefined;
  writes(args: readonly string[]): string | undefined;
  prepare?(args: readonly string[]): readonly string[];
}

function abbreviation(arg: string, name: string): boolean {
  if (name.startsWith("--")) {
    const given = arg.split("=")[0]!;
    return given.length >= 3 && given.startsWith("--") && name.startsWith(given);
  }
  return arg === name || (arg.startsWith(name) && arg.length > name.length);
}

function abbreviatedValues(args: readonly string[], names: readonly string[]): string[] {
  const found: string[] = [];
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!;
    const name = names.find(candidate => abbreviation(arg, candidate));
    if (!name) continue;
    if (arg.includes("=") && name.startsWith("--")) found.push(arg.slice(arg.indexOf("=") + 1));
    else if (!name.startsWith("--") && arg.length > name.length) found.push(arg.slice(name.length));
    else { found.push(args[index + 1] ?? ""); index++; }
  }
  return found;
}

export function cliRules(definition: CliDefinition): CliRules {
  const { command, reads } = definition;
  const normalize = (args: readonly string[]) => definition.lowercase ? args.map(arg => arg.toLowerCase()) : args;
  const present = (args: readonly string[], names: readonly string[]) => definition.abbreviatedOptions
    ? args.some(arg => names.some(name => abbreviation(arg, name))) : hasOption(args, names);
  const optionValues = (args: readonly string[], names: readonly string[]) => definition.abbreviatedOptions ? abbreviatedValues(args, names) : [];
  const secretWords = reads.secretWords ? new RegExp(reads.secretWords, "i") : undefined;
  const verb = reads.verb ? new RegExp(reads.verb) : undefined;
  const refusals = definition.refuse.map(rule => ({ rule, pattern: rule.argPattern ? new RegExp(rule.argPattern, "i") : undefined }));

  const matches = (rule: CliRefusal, pattern: RegExp | undefined, args: readonly string[], words: readonly string[]) => {
    if (rule.words?.length) {
      const found = (word: string) => rule.wordPrefixes ? words.some(candidate => candidate.length > 0 && word.startsWith(candidate)) : words.includes(word);
      if (!rule.words.every(found)) return false;
    }
    if (rule.options?.length || rule.short) {
      if (!((rule.options?.length && present(args, rule.options)) || (rule.short && hasShortOption(args, rule.short)))) return false;
    }
    return !pattern || args.some(arg => pattern.test(arg));
  };

  const requestWrites = (args: readonly string[], method: readonly string[], body: readonly string[]) => {
    if (present(args, body)) return "it sends a request body";
    const methods = optionValues(args, method).map(value => value.toUpperCase());
    return methods.every(value => value === "GET") ? undefined : `it sends a ${methods.find(value => value !== "GET")} request`;
  };

  const writesFile = (args: readonly string[]) => (reads.fileOptions ?? []).length > 0 && args.some(arg => {
    const given = arg.split("=")[0]!;
    return reads.fileOptions!.some(option => option.name.startsWith(given) && given.startsWith(option.shortest));
  });

  const rules: CliRules = {
    refused(original) {
      const args = normalize(original);
      const words = positionals(args);
      return refusals.find(({ rule, pattern }) => matches(rule, pattern, args, words))?.rule.reason;
    },
    writes(original) {
      const args = normalize(original);
      if (args.length === 1 && args[0] === "--version") return undefined;
      if (reads.hostFileArgs && args.some(arg => arg.startsWith("@") || /^-[^=]*=@/.test(arg))) return "an argument reads a host file (@file)";
      const words = commandWords(args);
      if (!words.length) return `${command} ${args.join(" ")} is not a command that only reads`;
      if (secretWords && words.some(word => secretWords.test(word))) return `${command} ${words.join(" ")} may show keys or secrets`;
      if (reads.api !== undefined && words[0] === reads.api) return apiWrites(args);
      const request = reads.requests?.find(rule => rule.words.join(" ") === words.join(" "));
      if (request) return requestWrites(args, request.method, request.body);
      if (reads.browserOptions?.length && hasOption(args, reads.browserOptions)) return `${reads.browserOptions[0]} opens a browser on the host`;
      if (writesFile(args)) return "it writes a file";
      if (reads.groups) {
        const [group, sub] = words;
        const allowed = reads.groups[group!];
        if (allowed === true || (allowed && sub !== undefined && allowed.includes(sub))) return undefined;
        return `${command} ${words.slice(0, 2).join(" ")} is not a command that only reads`;
      }
      if (verb) return verb.test(words.at(-1)!) ? undefined : `${command} ${words.join(" ")} is not a command that only reads`;
      return `${command} ${words.join(" ")} is not a command that only reads`;
    },
  };
  const watch = definition.watch;
  if (watch) {
    rules.prepare = args => {
      const end = args.indexOf("--");
      const words = positionals(end === -1 ? args : args.slice(0, end));
      const follows = (sequence: readonly string[]) => words.some((_, index) => sequence.every((word, offset) => words[index + offset] === word));
      const watching = watch.commands.some(item => follows(item.words) && (!item.option || hasOption(args, [item.option])));
      if (!watching || hasOption(args, [watch.interval]) || (watch.short && hasShortOption(args, watch.short))) return args;
      const at = end === -1 ? args.length : end;
      return [...args.slice(0, at), watch.interval, String(watch.seconds), ...args.slice(at)];
    };
  }
  return rules;
}

export function cliSpec(definition: CliDefinition): CliSpec {
  const info = pikiExtension(definition.extension);
  if (!info) throw new Error(`${definition.extension} isn't one of Pikibun's extensions`);
  const rules = cliRules(definition);
  const exact = new Set(definition.passEnv);
  const prefixes = definition.passEnvPrefixes ?? [];
  return {
    info, command: definition.command, ...(definition.windowsCommand ? { windowsCommand: { ...definition.windowsCommand } } : {}),
    description: definition.description,
    passEnv: name => exact.has(name) || prefixes.some(prefix => name.startsWith(prefix)),
    tokenEnv: definition.tokenEnv, setEnv: { ...definition.setEnv }, ...(definition.sandboxRoots ? { sandboxRoots: definition.sandboxRoots } : {}),
    refused: rules.refused, writes: rules.writes, ...(rules.prepare ? { prepare: rules.prepare } : {}),
  };
}
