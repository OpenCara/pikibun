import { programArguments, programLimits, programShellCommand, workDirectory } from "./program-command.js";

export const gitSubcommands = Object.freeze([
  "add", "am", "apply", "blame", "branch", "checkout", "cherry-pick", "clean", "clone", "commit", "describe", "diff", "fetch",
  "format-patch", "grep", "init", "log", "ls-files", "ls-remote", "ls-tree", "merge", "merge-base", "mv", "notes", "pull", "push",
  "range-diff", "rebase", "reflog", "remote", "reset", "restore", "revert", "rev-list", "rev-parse", "rm", "shortlog", "show",
  "show-ref", "stash", "status", "switch", "tag", "worktree",
] as const);
export type GitSubcommand = (typeof gitSubcommands)[number];

export const gitLimits = programLimits;

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
  directory: string;
  args: string[];
}

export function gitRequest(input: { args: unknown; directory?: unknown }): GitRequest {
  const list = programArguments(input.args, '["status"]');
  if (list.length === 0) throw new Error("args is Git's arguments as a list, starting with its subcommand, such as [\"status\"]");
  const subcommand = list[0]!;
  if (!(gitSubcommands as readonly string[]).includes(subcommand)) {
    throw new Error(subcommand.startsWith("-")
      ? "args starts with Git's subcommand; Git's own options (-C, -c, --git-dir, --exec-path ...) aren't taken: directory says where it runs"
      : `git ${subcommand.slice(0, 40)} isn't one the git tool runs. It runs: ${gitSubcommands.join(", ")}`);
  }
  const rules = refused[subcommand as GitSubcommand];
  let value = false;
  for (const arg of list.slice(1)) {
    if (value) { value = false; continue; }
    if (arg === "--") break;
    if (!rules) continue;
    const name = arg.split("=")[0]!;
    const long = rules.long.find(option => name === option || (name.length > 2 && name.startsWith("--") && option.startsWith(name)));
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

export const gitDirectory = workDirectory;

export function gitShellCommand(request: GitRequest): string {
  return programShellCommand({ directory: request.directory, prefix: "GIT_EDITOR=true GIT_SEQUENCE_EDITOR=true GIT_TERMINAL_PROMPT=0", program: "git --no-pager", args: request.args });
}
