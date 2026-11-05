import { programArguments, programShellCommand, workDirectory } from "./program-command.js";

/*
 * The node tool (piki:node, #163): Node.js and its package managers without a shell. The agent names the program and
 * gives its arguments as a list, and a directory of the worktree; the session runs exactly that program there, which
 * its approval card shows as one sandboxed command. Like git, its calls are decided as bash commands are: `pnpm test`
 * and `node script.js` run whatever the project or the script says.
 */

/** The programs the node tool runs. */
export const nodePrograms = Object.freeze(["node", "npm", "npx", "pnpm", "yarn", "corepack"] as const);
export type NodeProgram = (typeof nodePrograms)[number];

type PackageManager = "npm" | "pnpm" | "yarn";
const packageManagers: readonly string[] = ["npm", "pnpm", "yarn"];
/** What a launcher may run that this check follows: a package manager, or another launcher (`npx corepack pnpm ...`). */
const followed: readonly string[] = [...packageManagers, "corepack", "npx"];
/**
 * Package manager commands that act on a registry as an account: publishing, and signing in or managing the account,
 * its tokens, tags and packages' owners. A session has no registry account, and these would only ever leak or misuse one.
 */
export const registryAccountCommands = Object.freeze(["publish", "unpublish", "deprecate", "undeprecate", "adduser", "login", "logout", "owner",
  "access", "token", "dist-tag", "tag", "team", "profile", "org"] as const);
/**
 * Each package manager's options that take the next argument as their value, which may come before its command. They
 * differ: npm's -w is --workspace <name>, pnpm's is --workspace-root, which takes none.
 */
const valuedOptions: Record<PackageManager, ReadonlySet<string>> = {
  npm: new Set(["--workspace", "-w", "--prefix", "-C", "--userconfig", "--registry", "--loglevel", "--package", "--call", "-c"]),
  pnpm: new Set(["--filter", "-F", "--dir", "-C", "--reporter", "--loglevel", "--package"]),
  yarn: new Set(["--cwd", "--package", "-p"]),
};
/** Commands that run another of the package manager's own commands, named next (`pnpm recursive publish`, `yarn npm publish`). */
const wrappers: Record<PackageManager, ReadonlySet<string>> = { npm: new Set(), pnpm: new Set(["recursive"]), yarn: new Set(["npm"]) };
/** Commands that run a program, named next, which may be a package manager itself (`pnpm dlx npm publish`). */
const runners: Record<PackageManager, ReadonlySet<string>> = { npm: new Set(["exec", "x"]), pnpm: new Set(["exec", "dlx"]), yarn: new Set(["exec", "dlx"]) };
/** npx's and corepack's options that take the next argument as their value, before the program they run. */
const launcherValuedOptions: ReadonlySet<string> = new Set(["--package", "-p", "--call", "-c"]);

/** A package's name without the version a launcher may give it: pnpm@9 is pnpm, @scope/tool@1 is @scope/tool. */
function packageName(spec: string): string {
  const at = spec.indexOf("@", 1);
  return at === -1 ? spec : spec.slice(0, at);
}

/**
 * The program a launcher runs, from `args[from]` on: its first argument past options, their values and a `--`, with
 * where it is.
 */
function launched(args: readonly string[], from: number, valued: ReadonlySet<string>): { name: string; index: number } | undefined {
  for (let index = from; index < args.length; index++) {
    const arg = args[index]!;
    if (arg === "--") continue;
    if (arg.startsWith("-")) { if (!arg.includes("=") && valued.has(arg)) index++; continue; }
    return { name: packageName(arg), index };
  }
  return undefined;
}

/** The positional arguments of `args` before --, with where each is, skipping options and their values. */
function positionals(args: readonly string[], valued: ReadonlySet<string>): { arg: string; index: number }[] {
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
 * The command that acts on a registry as an account `program` would run with `args`, if any, as `<program> <command>`:
 * a package manager's own command, found past its options and their values, its wrappers (`recursive`, yarn's `npm`)
 * and `workspace <name>`; and the same through what launches a package manager by name: `corepack <manager>`, `npx`
 * and the managers' `exec`, `x` and `dlx`. A program that runs any other way (a script, `node` itself) isn't
 * followed: the check keeps the plain forms out of a card, while the card's approval is what stands for the rest.
 */
export function registryAccountCommand(program: string, args: readonly string[], depth = 0): string | undefined {
  if (depth > 4) return undefined;
  if (program === "corepack" || program === "npx") {
    const next = launched(args, 0, launcherValuedOptions);
    return next && followed.includes(next.name) ? registryAccountCommand(next.name, args.slice(next.index + 1), depth + 1) : undefined;
  }
  if (!packageManagers.includes(program)) return undefined;
  const manager = program as PackageManager;
  const found = positionals(args, valuedOptions[manager]);
  for (let at = 0; at < found.length;) {
    const { arg, index } = found[at]!;
    if (wrappers[manager].has(arg)) { at++; continue; }
    if (arg === "workspace") { at += 2; continue; }
    if (runners[manager].has(arg)) {
      const next = launched(args, index + 1, valuedOptions[manager]);
      return next && followed.includes(next.name) ? registryAccountCommand(next.name, args.slice(next.index + 1), depth + 1) : undefined;
    }
    return (registryAccountCommands as readonly string[]).includes(arg) ? `${manager} ${arg}` : undefined;
  }
  return undefined;
}

/**
 * Fixed for every call: no colours in the output, no prompt from corepack or npx (input is closed, so either would only
 * fail), and Node's own toolchain directory after the sandbox's PATH.
 */
export const NODE_ENVIRONMENT = "NO_COLOR=1 COREPACK_ENABLE_DOWNLOAD_PROMPT=0 npm_config_yes=true";

export interface NodeRequest {
  program: NodeProgram;
  /** The worktree directory it runs in, relative and without `..`: "." for the worktree itself. */
  directory: string;
  args: string[];
}

/** The node tool's call as it runs, or an error saying what it refused. */
export function nodeRequest(input: { program: unknown; args?: unknown; directory?: unknown }): NodeRequest {
  if (typeof input.program !== "string" || !(nodePrograms as readonly string[]).includes(input.program)) {
    throw new Error(`program is one of ${nodePrograms.join(", ")}`);
  }
  const program = input.program as NodeProgram;
  const args = programArguments(input.args ?? [], '["test"]');
  const command = registryAccountCommand(program, args);
  if (command !== undefined) throw new Error(`${command} acts on a package registry as an account, which sessions don't have: the node tool doesn't run it`);
  return { program, directory: workDirectory(input.directory), args };
}

/**
 * The shell command that runs `request`, as its card shows it. `bin`: where the session's commands find the connector's
 * own Node.js (SessionWorkspace.nodeBin), looked in first; without it, the Node.js on their PATH.
 */
export function nodeShellCommand(request: NodeRequest, bin?: string): string {
  return programShellCommand({ directory: request.directory, path: "/usr/local/bin", ...(bin ? { first: bin } : {}), prefix: NODE_ENVIRONMENT, program: request.program, args: request.args });
}
