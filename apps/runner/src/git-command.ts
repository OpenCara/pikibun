/*
 * The git tool (piki:git, #163): Git without a shell. The agent gives Git's arguments as a list, and a directory of the
 * worktree to run in; the session runs exactly `git <arguments>` there, which its approval card shows as one sandboxed
 * command. A subcommand outside the list below, and the options that make Git run another program or take settings that
 * do (rebase --exec, clone --upload-pack, --template, -c ...), are refused before any card asks.
 *
 * Its calls are decided as bash commands are, never skipping approval for "read-only" subcommands: a repository's own
 * configuration (core.fsmonitor, core.pager, diff.external, filters, hooks), which the agent can write, can make even
 * git status run a program.
 */

/** The subcommands the git tool runs: version control in a clone, nothing that configures Git or runs other programs. */
export const gitSubcommands = Object.freeze([
  "add", "am", "apply", "blame", "branch", "checkout", "cherry-pick", "clean", "clone", "commit", "describe", "diff", "fetch",
  "format-patch", "grep", "init", "log", "ls-files", "ls-remote", "ls-tree", "merge", "merge-base", "mv", "notes", "pull", "push",
  "range-diff", "rebase", "reflog", "remote", "reset", "restore", "revert", "rev-list", "rev-parse", "rm", "shortlog", "show",
  "show-ref", "stash", "status", "switch", "tag", "worktree",
] as const);
export type GitSubcommand = (typeof gitSubcommands)[number];

/** The limits of one call: as many arguments as the gh tool takes, within the 64K a sandboxed command may be. */
export const gitLimits = Object.freeze({ arguments: 256, argumentLength: 32 * 1024, commandLength: 60 * 1024 });

/**
 * Options of a subcommand that name a program for Git to run, or take settings or hooks that can (clone's --config,
 * --template), with their short forms (`short`). Git takes a long option's unambiguous abbreviation too (--upload-p),
 * so those count as well. A short form counts inside a cluster of short options (-ix) until a letter that takes a
 * value (`valued`), whose value is the rest (-bmain).
 */
const refused: Partial<Record<GitSubcommand, { long: readonly string[]; short?: string; valued?: string }>> = {
  clone: { long: ["--upload-pack", "--template", "--config"], short: "uc", valued: "obucj" },
  init: { long: ["--template"] },
  fetch: { long: ["--upload-pack"] },
  pull: { long: ["--upload-pack"] },
  "ls-remote": { long: ["--upload-pack"], short: "u", valued: "u" },
  push: { long: ["--receive-pack", "--exec"] },
  rebase: { long: ["--exec"], short: "x", valued: "sXxC" },
  grep: { long: ["--open-files-in-pager"], short: "O", valued: "eABCfmO" },
};

export interface GitRequest {
  /** The worktree directory it runs in, relative and without `..`: "." for the worktree itself. */
  directory: string;
  args: string[];
}

/** The git tool's call as it runs, or an error saying what it refused. */
export function gitRequest(input: { args: unknown; directory?: unknown }): GitRequest {
  const { args } = input;
  if (!Array.isArray(args) || args.length === 0) throw new Error("args is Git's arguments as a list, starting with its subcommand, such as [\"status\"]");
  if (args.length > gitLimits.arguments) throw new Error(`args holds at most ${gitLimits.arguments} arguments`);
  for (const arg of args) {
    if (typeof arg !== "string") throw new Error("each argument is a string");
    if (arg.includes("\0")) throw new Error("arguments must not contain NUL characters");
    if (arg.length > gitLimits.argumentLength) throw new Error(`an argument holds at most ${gitLimits.argumentLength} characters`);
  }
  const list = args as string[];
  const subcommand = list[0]!;
  if (!(gitSubcommands as readonly string[]).includes(subcommand)) {
    throw new Error(subcommand.startsWith("-")
      ? "args starts with Git's subcommand; Git's own options (-C, -c, --git-dir, --exec-path ...) aren't taken: directory says where it runs"
      : `git ${subcommand.slice(0, 40)} isn't one the git tool runs. It runs: ${gitSubcommands.join(", ")}`);
  }
  const rules = refused[subcommand as GitSubcommand];
  let value = false;
  for (const arg of list.slice(1)) {
    // The value of the short option before it (grep -e -O): not an option itself.
    if (value) { value = false; continue; }
    // Past --, the rest are paths, revisions or patterns, never options.
    if (arg === "--") break;
    if (!rules) continue;
    const name = arg.split("=")[0]!;
    const long = rules.long.find(option => name === option || (name.length > 4 && name.startsWith("--") && option.startsWith(name)));
    if (long) throw new Error(`git ${subcommand} ${long} runs a program, or takes settings that do: the git tool doesn't take it`);
    if (rules.short && /^-[A-Za-z0-9]/.test(arg)) {
      for (const [index, letter] of [...arg.slice(1)].entries()) {
        if (rules.short.includes(letter)) throw new Error(`git ${subcommand} -${letter} runs a program, or takes settings that do: the git tool doesn't take it`);
        if (rules.valued?.includes(letter)) { value = index === arg.length - 2; break; }
      }
    }
  }
  return { directory: gitDirectory(input.directory), args: list };
}

/** `directory` as the git tool takes it: a relative path within the worktree, without `..`; "." by default. */
export function gitDirectory(value: unknown): string {
  if (value === undefined) return ".";
  if (typeof value !== "string" || value.length > 1024 || value.includes("\0")) throw new Error("directory is a path within the session's worktree, such as app");
  const parts = value.replaceAll("\\", "/").split("/").filter(part => part && part !== ".");
  if (value.startsWith("/") || value.startsWith("\\") || /^[A-Za-z]:/.test(value) || value.startsWith("~") || parts.includes("..")) {
    throw new Error("directory is a path within the session's worktree, such as app");
  }
  return parts.join("/") || ".";
}

const quote = (value: string) => `'${value.replaceAll("'", `'\\''`)}'`;

/**
 * The shell command that runs `request`, as its card shows it: Git with every argument quoted, in its directory, with
 * no pager, no editor (a commit without -m fails at once rather than waiting for one) and no credential prompt, its
 * error output with the rest.
 */
export function gitShellCommand(request: GitRequest): string {
  const command = `${request.directory === "." ? "" : `cd -- ${quote(`./${request.directory}`)} && `}`
    + `GIT_EDITOR=true GIT_SEQUENCE_EDITOR=true GIT_TERMINAL_PROMPT=0 git --no-pager ${request.args.map(quote).join(" ")} </dev/null 2>&1`;
  if (command.length > gitLimits.commandLength) throw new Error(`the command would be over ${gitLimits.commandLength} characters`);
  return command;
}
