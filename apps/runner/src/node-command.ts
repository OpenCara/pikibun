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

/** The package managers, whose commands below act on a registry as an account. */
const packageManagers: readonly NodeProgram[] = ["npm", "pnpm", "yarn"];
/**
 * Package manager commands that act on a registry as an account: publishing, and signing in or managing the account,
 * its tokens and packages' owners. A session has no registry account, and these would only ever leak or misuse one.
 */
export const registryAccountCommands = Object.freeze(["publish", "unpublish", "deprecate", "undeprecate", "adduser", "login", "logout", "owner",
  "access", "token", "dist-tag", "team", "profile", "org"] as const);
/** Options of the package managers that take a value as the next argument, which comes before the command they run. */
const valuedOptions: ReadonlySet<string> = new Set(["--filter", "-F", "--dir", "-C", "--prefix", "--cwd", "--workspace", "-w", "--userconfig", "--registry",
  "--loglevel", "--reporter", "--config"]);
/** Commands that run another of the package manager's commands, named after them (`pnpm recursive publish`, `yarn npm publish`). */
const wrappers: ReadonlySet<string> = new Set(["recursive", "npm"]);

/**
 * The command a package manager runs with `args`: its first argument that isn't an option or an option's value, or the
 * one after a wrapper (`recursive`, yarn's `npm`), or after `workspace <name>`.
 */
export function packageManagerCommand(args: readonly string[]): string | undefined {
  const positional: string[] = [];
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!;
    if (arg === "--") break;
    if (arg.startsWith("-")) { if (!arg.includes("=") && valuedOptions.has(arg)) index++; continue; }
    positional.push(arg);
  }
  let at = 0;
  for (;;) {
    const command = positional[at];
    if (command !== undefined && wrappers.has(command)) at++;
    else if (command === "workspace") at += 2;
    else return command;
  }
}

/**
 * Fixed for every call: no colours in the output, no prompt from corepack or npx (input is closed, so either would only
 * fail), and Node's own toolchain directory after the sandbox's PATH.
 */
const NODE_ENVIRONMENT = "NO_COLOR=1 COREPACK_ENABLE_DOWNLOAD_PROMPT=0 npm_config_yes=true";

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
  const command = packageManagers.includes(program) ? packageManagerCommand(args) : undefined;
  if (command !== undefined && (registryAccountCommands as readonly string[]).includes(command)) {
    throw new Error(`${program} ${command} acts on a package registry as an account, which sessions don't have: the node tool doesn't run it`);
  }
  return { program, directory: workDirectory(input.directory), args };
}

/** The shell command that runs `request`, as its card shows it. */
export function nodeShellCommand(request: NodeRequest): string {
  return programShellCommand({ directory: request.directory, path: "/usr/local/bin", prefix: NODE_ENVIRONMENT, program: request.program, args: request.args });
}
