import { programArguments, programShellCommand, workDirectory } from "./program-command.js";

/*
 * The rust, go, dotnet and make tools (piki:rust, piki:go, piki:dotnet, piki:make, #163): each runs one program of its
 * toolchain without a shell, as node and python do. The agent names the program and gives its arguments as a list, and
 * a directory of the worktree; the session runs exactly that program there, which its approval card shows as one
 * command, approved as its own tool's (a program operation). What a toolchain does as an account on a registry
 * (publishing, signing in, managing owners) is refused: sessions have no registry account.
 */

export interface EcosystemSpec {
  tool: "rust" | "go" | "dotnet" | "make";
  title: string;
  programs: readonly string[];
  /** Fixed for every call: no colours, prompts or telemetry. */
  environment: string;
  /** Directories looked in after the sandbox's PATH, where the toolchain installs. */
  path: readonly string[];
  /** Options that take the next argument as their value, before the command they run. */
  valued: Readonly<Record<string, readonly string[]>>;
  /** The command, as `<program> <words...>`, that acts on a registry as an account, if `args` run one. */
  account: (program: string, positionals: readonly string[], args: readonly string[]) => string | undefined;
  example: string;
}

const RUST_ACCOUNT = ["publish", "login", "logout", "owner", "yank"];

export const ecosystems: Readonly<Record<EcosystemSpec["tool"], EcosystemSpec>> = Object.freeze({
  rust: {
    tool: "rust", title: "Rust", programs: ["cargo", "rustc", "rustup", "rustfmt"],
    environment: "CARGO_TERM_COLOR=never CARGO_TERM_PROGRESS_WHEN=never", path: ["$HOME/.cargo/bin", "/usr/local/bin"],
    valued: { cargo: ["--config", "-Z", "--color", "-C", "--manifest-path", "--target-dir", "--target", "--features", "-F", "--package", "-p", "--jobs", "-j"] },
    // cargo +toolchain publish: the toolchain chooser comes first.
    account: (program, positionals) => {
      const command = positionals.find(word => !word.startsWith("+"));
      return program === "cargo" && command !== undefined && RUST_ACCOUNT.includes(command) ? `cargo ${command}` : undefined;
    },
    example: '["test"]',
  },
  go: {
    tool: "go", title: "Go", programs: ["go", "gofmt"],
    environment: "", path: ["/usr/local/go/bin", "$HOME/go/bin", "/usr/local/bin"],
    valued: { go: ["-C"] },
    account: () => undefined,
    example: '["test", "./..."]',
  },
  dotnet: {
    tool: "dotnet", title: ".NET", programs: ["dotnet"],
    environment: "DOTNET_CLI_TELEMETRY_OPTOUT=1 DOTNET_NOLOGO=1 DOTNET_SKIP_FIRST_TIME_EXPERIENCE=1 DOTNET_CLI_UI_LANGUAGE=en NO_COLOR=1",
    path: ["/usr/share/dotnet", "/usr/lib/dotnet", "$HOME/.dotnet", "/usr/local/bin"],
    valued: { dotnet: [] },
    // dotnet nuget push and delete publish to a feed; add or update source with a user or password stores its credentials.
    account: (_program, positionals, args) => {
      if (positionals[0] !== "nuget") return undefined;
      if (positionals[1] === "push" || positionals[1] === "delete") return `dotnet nuget ${positionals[1]}`;
      if ((positionals[1] === "add" || positionals[1] === "update") && positionals[2] === "source"
        && args.some(arg => ["--username", "-u", "--password", "-p"].includes(arg.split("=")[0]!))) return `dotnet nuget ${positionals[1]} source (credentials)`;
      return undefined;
    },
    example: '["test"]',
  },
  make: {
    tool: "make", title: "Make", programs: ["make"],
    environment: "", path: ["/usr/local/bin"],
    valued: { make: ["-C", "-f", "--file", "--makefile", "-I", "--include-dir", "-j", "--jobs", "-l", "--load-average", "-o", "-W"] },
    account: () => undefined,
    example: '["test"]',
  },
} satisfies Record<string, EcosystemSpec>);

export type EcosystemTool = keyof typeof ecosystems;

export interface EcosystemRequest {
  tool: EcosystemTool;
  program: string;
  /** The worktree directory it runs in, relative and without `..`: "." for the worktree itself. */
  directory: string;
  args: string[];
}

/** The positional arguments before --, skipping options and the values of `valued` ones. */
function positionals(args: readonly string[], valued: readonly string[]): string[] {
  const found: string[] = [];
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!;
    if (arg === "--") break;
    if (arg.startsWith("-")) { if (!arg.includes("=") && valued.includes(arg)) index++; continue; }
    found.push(arg);
  }
  return found;
}

/** A call of `tool` as it runs, or an error saying what it refused. */
export function ecosystemRequest(tool: EcosystemTool, input: { program: unknown; args?: unknown; directory?: unknown }): EcosystemRequest {
  const spec = ecosystems[tool];
  if (typeof input.program !== "string" || !spec.programs.includes(input.program)) throw new Error(`program is one of ${spec.programs.join(", ")}`);
  const args = programArguments(input.args ?? [], spec.example);
  const command = spec.account(input.program, positionals(args, spec.valued[input.program] ?? []), args);
  if (command !== undefined) throw new Error(`${command} acts on a registry as an account, which sessions don't have: the ${tool} tool doesn't run it`);
  return { tool, program: input.program, directory: workDirectory(input.directory), args };
}

/** The shell command that runs `request`, as its card shows it. */
export function ecosystemShellCommand(request: EcosystemRequest): string {
  const spec = ecosystems[request.tool];
  // Each PATH entry is fixed by the spec, not the agent: $HOME expands where the command runs.
  const path = `PATH="\${PATH:-/usr/bin:/bin}":${spec.path.map(entry => `"${entry}"`).join(":")}`;
  return programShellCommand({ directory: request.directory, prefix: [path, spec.environment].filter(Boolean).join(" "), program: request.program, args: request.args });
}
