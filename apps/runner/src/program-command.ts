export const programLimits = Object.freeze({ arguments: 256, argumentLength: 8192, commandLength: 8192 });

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

export function programShellCommand(options: { directory: string; program: string; args: readonly string[]; prefix?: string; path?: string | readonly string[]; first?: string; firstHere?: string }): string {
  const after = (typeof options.path === "string" ? [options.path] : options.path ?? []).filter(item => item !== "");
  const first = options.first ? shellQuote(options.first) : options.firstHere ? `"$PWD"/${shellQuote(options.firstHere)}` : "";
  const command = `${options.directory === "." ? "" : `cd -- ${shellQuote(`./${options.directory}`)} && `}`
    + `${after.length || first ? `PATH=${first ? `${first}:` : ""}"\${PATH:-/usr/bin:/bin}"${after.map(item => `:${shellQuote(item)}`).join("")} ` : ""}${options.prefix ? `${options.prefix} ` : ""}${options.program}`
    + `${options.args.length ? ` ${options.args.map(shellQuote).join(" ")}` : ""} </dev/null 2>&1`;
  if (command.length > programLimits.commandLength) throw new Error(`the command would be over ${programLimits.commandLength} characters`);
  return command;
}
