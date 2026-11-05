import { existsSync } from "node:fs";
import { programArguments, programShellCommand, workDirectory } from "./program-command.js";

/*
 * The rust, go and dotnet tools (piki:rust, piki:go, piki:dotnet, #163): each ecosystem's programs without a shell, as
 * the node and python tools run theirs. The agent names the program and gives its arguments as a list, and a directory
 * of the worktree; the session runs exactly that program there, which its approval card shows as one sandboxed command.
 * Their calls are decided as commands are: cargo build, go test and dotnet run run whatever the project says.
 */

export const ecosystemTools = Object.freeze(["rust", "go", "dotnet"] as const);
export type EcosystemTool = (typeof ecosystemTools)[number];

/** The programs each tool runs. */
export const ecosystemPrograms = Object.freeze({
  rust: Object.freeze(["cargo", "rustc", "rustup", "rustfmt"] as const),
  go: Object.freeze(["go", "gofmt"] as const),
  dotnet: Object.freeze(["dotnet"] as const),
}) satisfies Record<EcosystemTool, readonly string[]>;

interface Ecosystem {
  /** Fixed for every call: no colours, progress bars, telemetry or first-run banners. */
  environment: string;
  /** Where each ecosystem installs, looked in after the sandbox's PATH. */
  path: readonly string[];
  /** An example of args, for the error that asks for a list. */
  example: string;
}

const ecosystems: Readonly<Record<EcosystemTool, Ecosystem>> = {
  rust: { environment: "NO_COLOR=1 CARGO_TERM_COLOR=never CARGO_TERM_PROGRESS_WHEN=never", path: ["/usr/local/cargo/bin", "/usr/local/bin"], example: '["test"]' },
  go: { environment: "NO_COLOR=1", path: ["/usr/local/go/bin", "/usr/lib/go/bin", "/usr/local/bin"], example: '["test", "./..."]' },
  dotnet: {
    environment: "NO_COLOR=1 DOTNET_CLI_TELEMETRY_OPTOUT=1 DOTNET_NOLOGO=1 DOTNET_SKIP_FIRST_TIME_EXPERIENCE=1 DOTNET_CLI_UI_LANGUAGE=en",
    path: ["/usr/share/dotnet", "/usr/lib/dotnet", "/usr/local/share/dotnet", "/usr/local/bin"], example: '["test"]',
  },
};

/**
 * cargo's options before its command that take the next argument as their value, and, as hardening, two that only its
 * commands take (review of #194).
 */
const cargoValued = new Set(["--color", "--config", "-Z", "-C", "--explain", "--manifest-path", "--target-dir"]);

/** The positional arguments before --, skipping options and the values of those in `valued`. */
function positionals(args: readonly string[], valued: ReadonlySet<string> = new Set()): { arg: string; index: number }[] {
  const found: { arg: string; index: number }[] = [];
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!;
    if (arg === "--") break;
    if (arg.startsWith("-")) { if (!arg.includes("=") && valued.has(arg)) index++; continue; }
    found.push({ arg, index });
  }
  return found;
}

/**
 * The command, if `program args` is one that acts on a package registry as an account, which sessions don't have:
 * `cargo publish`, `login`, `logout`, `owner` and `yank`, also through `cargo +toolchain` and `rustup run`, and `dotnet
 * nuget push` and `delete` and storing a source's password. Go publishes by tagging a repository, so it has none. Only
 * the plain forms: the approval covers everything else, as for node's and python's.
 */
export function registryAccountCommand(program: string, args: readonly string[], depth = 0): string | undefined {
  if (depth > 4) return undefined;
  if (program === "cargo") {
    // cargo +nightly publish: the toolchain comes first.
    const rest = args[0]?.startsWith("+") ? args.slice(1) : args;
    const first = positionals(rest, cargoValued)[0]?.arg;
    if (first && ["publish", "login", "logout", "owner", "yank"].includes(first)) return `cargo ${first}`;
    return undefined;
  }
  if (program === "rustup") {
    // rustup [+toolchain] run [--install] [--] <toolchain> [--] <program> <args...>: rustup's options take no value, and
    // a -- before the toolchain or the program only ends them (review of #194). What follows the program is its own.
    const rest = args[0]?.startsWith("+") ? args.slice(1) : args;
    let index = 0;
    const next = (): string | undefined => {
      while (index < rest.length && rest[index]!.startsWith("-")) index++;
      return index < rest.length ? rest[index++] : undefined;
    };
    if (next() !== "run") return undefined;
    const toolchain = next();
    const launched = next();
    if (toolchain === undefined || launched === undefined) return undefined;
    return registryAccountCommand(launched, rest.slice(index), depth + 1);
  }
  if (program === "dotnet") {
    const found = positionals(args);
    if (found[0]?.arg !== "nuget") return undefined;
    const verb = found[1]?.arg;
    if (verb === "push" || verb === "delete") return `dotnet nuget ${verb}`;
    if ((verb === "add" || verb === "update") && found[2]?.arg === "source"
      && args.some(arg => /^(?:-p|--password)(?:[:=].*)?$/s.test(arg))) return `dotnet nuget ${verb} source with a password`;
  }
  return undefined;
}

export interface EcosystemRequest {
  tool: EcosystemTool;
  program: string;
  /** The worktree directory it runs in, relative and without `..`: "." for the worktree itself. */
  directory: string;
  args: string[];
}

/** An ecosystem tool's call as it runs, or an error saying what it refused. */
export function ecosystemRequest(tool: EcosystemTool, input: { program: unknown; args?: unknown; directory?: unknown }): EcosystemRequest {
  const programs: readonly string[] = ecosystemPrograms[tool];
  if (typeof input.program !== "string" || !programs.includes(input.program)) throw new Error(`program is one of ${programs.join(", ")}`);
  const args = programArguments(input.args ?? [], ecosystems[tool].example);
  const command = registryAccountCommand(input.program, args);
  if (command !== undefined) throw new Error(`${command} acts on a package registry as an account, which sessions don't have: the ${tool} tool doesn't run it`);
  return { tool, program: input.program, directory: workDirectory(input.directory), args };
}

/**
 * Where a rustup installed for the whole system keeps its toolchains, as the official rust image does
 * (RUSTUP_HOME=/usr/local/rustup, its proxies in /usr/local/cargo/bin). The sandbox sees /usr read-only, but its HOME is
 * the session's own, where a proxy would look by default and find no toolchain (review of #194).
 */
export const SYSTEM_RUSTUP_HOME = "/usr/local/rustup";

/** The directories each tool looks in after the sandbox's PATH (and, for rust, SYSTEM_RUSTUP_HOME's toolchains). */
export function ecosystemPath(tool: EcosystemTool): readonly string[] {
  return ecosystems[tool].path;
}

/**
 * The shell command that runs `request`, as its card shows it. `system.rustupHome`: whether the host has a system-wide
 * rustup (SYSTEM_RUSTUP_HOME), whose toolchains a rust call then uses unless the session's environment names another
 * RUSTUP_HOME. CARGO_HOME stays the session's own, so its registry cache and any credentials stay in the session.
 */
export function ecosystemShellCommand(request: EcosystemRequest, system: { rustupHome?: boolean } = {}): string {
  const ecosystem = ecosystems[request.tool];
  const rustup = request.tool === "rust" && (system.rustupHome ?? existsSync(SYSTEM_RUSTUP_HOME)) ? ` RUSTUP_HOME="\${RUSTUP_HOME:-${SYSTEM_RUSTUP_HOME}}"` : "";
  return programShellCommand({ directory: request.directory, path: ecosystem.path, prefix: `${ecosystem.environment}${rustup}`, program: request.program, args: request.args });
}
