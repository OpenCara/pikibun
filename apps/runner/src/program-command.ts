/*
 * What the session tools that run one program without a shell share (#163): git (git-command.ts), node (node-command.ts)
 * and the ecosystems after them. Each takes its program's arguments as a list and a directory of the worktree, and
 * becomes one sandboxed command, the program and its quoted arguments, which its approval card shows as it runs.
 */

/**
 * The limits of one call: as many arguments as the gh tool takes, within the 8192 characters a bash operation may be
 * (validateOperation, and the control plane's check), so a call too long says so before any card is made.
 */
export const programLimits = Object.freeze({ arguments: 256, argumentLength: 8192, commandLength: 8192 });

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
 * `path`: directories to look in after the sandbox's PATH, such as /usr/local/bin, where toolchains install; `first`, one
 * to look in before it, such as the toolchain's own bin directory; `firstHere`, one relative to where it runs, put
 * there as an absolute path ("$PWD"/...), so a program that changes directory still finds it. An empty PATH is /usr/bin:/bin there, never an empty
 * entry, which the shell would take for the command's directory.
 */
export function programShellCommand(options: { directory: string; program: string; args: readonly string[]; prefix?: string; path?: string | readonly string[]; first?: string; firstHere?: string }): string {
  // Never an empty entry, which the shell would take for the command's directory (review of #194).
  const after = (typeof options.path === "string" ? [options.path] : options.path ?? []).filter(item => item !== "");
  const first = options.first ? shellQuote(options.first) : options.firstHere ? `"$PWD"/${shellQuote(options.firstHere)}` : "";
  const command = `${options.directory === "." ? "" : `cd -- ${shellQuote(`./${options.directory}`)} && `}`
    + `${after.length || first ? `PATH=${first ? `${first}:` : ""}"\${PATH:-/usr/bin:/bin}"${after.map(item => `:${shellQuote(item)}`).join("")} ` : ""}${options.prefix ? `${options.prefix} ` : ""}${options.program}`
    + `${options.args.length ? ` ${options.args.map(shellQuote).join(" ")}` : ""} </dev/null 2>&1`;
  if (command.length > programLimits.commandLength) throw new Error(`the command would be over ${programLimits.commandLength} characters`);
  return command;
}
