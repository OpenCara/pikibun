/*
 * What the session tools that run one program without a shell share (#163): git (git-command.ts), node (node-command.ts)
 * and the ecosystems after them. Each takes its program's arguments as a list and a directory of the worktree, and
 * becomes one sandboxed command, the program and its quoted arguments, which its approval card shows as it runs.
 */

/** The limits of one call: as many arguments as the gh tool takes, within the 64K a sandboxed command may be. */
export const programLimits = Object.freeze({ arguments: 256, argumentLength: 32 * 1024, commandLength: 60 * 1024 });

/** `args` as such a tool takes it: a list of at most programLimits.arguments strings, without NUL characters. */
export function programArguments(args: unknown, example: string): string[] {
  if (!Array.isArray(args)) throw new Error(`args is the arguments as a list, such as ${example}`);
  if (args.length > programLimits.arguments) throw new Error(`args holds at most ${programLimits.arguments} arguments`);
  for (const arg of args) {
    if (typeof arg !== "string") throw new Error("each argument is a string");
    if (arg.includes("\0")) throw new Error("arguments must not contain NUL characters");
    if (arg.length > programLimits.argumentLength) throw new Error(`an argument holds at most ${programLimits.argumentLength} characters`);
  }
  return args as string[];
}

/** `directory` as these tools take it: a relative path within the worktree, without `..`; "." by default. */
export function workDirectory(value: unknown): string {
  if (value === undefined) return ".";
  if (typeof value !== "string" || value.length > 1024 || value.includes("\0")) throw new Error("directory is a path within the session's worktree, such as app");
  const parts = value.replaceAll("\\", "/").split("/").filter(part => part && part !== ".");
  if (value.startsWith("/") || value.startsWith("\\") || /^[A-Za-z]:/.test(value) || value.startsWith("~") || parts.includes("..")) {
    throw new Error("directory is a path within the session's worktree, such as app");
  }
  return parts.join("/") || ".";
}

export const shellQuote = (value: string) => `'${value.replaceAll("'", `'\\''`)}'`;

/**
 * The shell command that runs `program` with `args`, every one quoted, in `directory`, after `prefix` (fixed variable
 * assignments and options of the tool's own, never the agent's), with no input and its error output with the rest.
 * `path`: a directory to look in after the sandbox's PATH, such as /usr/local/bin, where toolchains install.
 */
export function programShellCommand(options: { directory: string; program: string; args: readonly string[]; prefix?: string; path?: string }): string {
  const command = `${options.directory === "." ? "" : `cd -- ${shellQuote(`./${options.directory}`)} && `}`
    + `${options.path ? `PATH="$PATH:${options.path}" ` : ""}${options.prefix ? `${options.prefix} ` : ""}${options.program}`
    + `${options.args.length ? ` ${options.args.map(shellQuote).join(" ")}` : ""} </dev/null 2>&1`;
  if (command.length > programLimits.commandLength) throw new Error(`the command would be over ${programLimits.commandLength} characters`);
  return command;
}
