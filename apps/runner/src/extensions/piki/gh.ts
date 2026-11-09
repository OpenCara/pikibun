import { pikiExtension } from "../../../../../packages/shared/src/piki-extensions.js";
import { apiWrites, commandWords, hasOption, hasShortOption, positionals, type CliSpec } from "./command.js";

/*
 * piki:gh, the GitHub CLI (docs/design/piki-extensions.md).
 */

/** Commands that only read, by group: every subcommand of a group set to true. */
const READS: Record<string, readonly string[] | true> = {
  pr: ["list", "view", "diff", "checks", "status"],
  issue: ["list", "view", "status"],
  run: ["list", "view", "watch"],
  workflow: ["list", "view"],
  repo: ["list", "view"],
  release: ["list", "view"],
  search: true,
  gist: ["list", "view"],
  label: ["list"],
  cache: ["list"],
  secret: ["list"],
  variable: ["list", "get"],
  ruleset: ["list", "view", "check"],
  project: ["list", "view", "field-list", "item-list"],
  org: ["list"],
  status: true,
  auth: ["status"],
  version: true,
  help: true,
};

export const ghSpec: CliSpec = {
  info: pikiExtension("piki:gh")!,
  command: "gh",
  windowsCommand: { file: "gh.exe", shim: false },
  description: [
    "Run the GitHub CLI (gh) as the session owner: in the session's sandbox, where Pikibun adds the session owner's access to the workspace's github.com repositories to its GitHub API requests.",
    "Give the arguments after gh as a list, as they are passed (no shell, no quoting), such as {\"args\": [\"pr\", \"checks\", \"42\", \"--repo\", \"acme/app\"]}.",
    "Use it for what the sandbox can't reach: GitHub Actions runs and their logs (run list, run view <id> --log-failed), pull request checks and reviews, releases, repository settings, and the REST and GraphQL APIs (api repos/acme/app/...).",
    "Name the repository with --repo owner/name: it runs in the session's worktree, or in directory, a clone in it.",
    "Use it rather than github_read, which spends the session owner's own GitHub rate limit: to read issues and pull requests (issue view, pr view --comments, pr checks),",
    "and to wait for a pull request's CI (pr checks <n> --watch, run watch <id>, with a timeout_seconds long enough); github_read with wait: \"change\" still waits for any other change (a comment, review or push).",
    "It reads the workspace's repositories always. It writes (comments, pull requests, merges, reruns) only in a call a person approved, on the session owner's own host, outside read-only;",
    "where it refuses a write, comment, open issues and merge with github_comment, github_issue and github_merge.",
    "Each call waits for approval unless the workspace runs this extension's tools automatically; where the workspace set it read-only, only commands that read run.",
    "Commands that would show its token (auth token, --show-token) are refused.",
  ].join(" "),
  passEnv: name => ["GH_TOKEN", "GITHUB_TOKEN", "GH_ENTERPRISE_TOKEN", "GITHUB_ENTERPRISE_TOKEN", "GH_HOST", "GH_CONFIG_DIR"].includes(name),
  tokenEnv: ["GH_TOKEN", "GITHUB_TOKEN"],
  setEnv: { GH_PROMPT_DISABLED: "1", GH_NO_UPDATE_NOTIFIER: "1", GH_NO_EXTENSION_UPDATE_NOTIFIER: "1", GH_SPINNER_DISABLED: "1", GH_PAGER: "cat" },
  // Options may sit anywhere among the command's words, and short ones cluster (-at): these look at every argument.
  refused(args) {
    const words = positionals(args);
    if (words.includes("auth") && words.includes("token")) return "gh auth token would show its token";
    if (words.includes("auth") && (hasOption(args, ["--show-token"]) || hasShortOption(args, "t"))) return "--show-token would show its token";
    if (words.includes("config") && words.includes("get") && args.some(arg => /token/i.test(arg))) return "gh config get would show its token";
    return undefined;
  },
  writes(args) {
    // Help reads too, as gh help <command>: a --help among other options might be another option's value.
    if (args.length === 1 && args[0] === "--version") return undefined;
    const words = commandWords(args);
    const [group, command] = words;
    if (!group) return `gh ${args.join(" ")} is not a command that only reads`;
    if (group === "api") return apiWrites(args);
    if (hasOption(args, ["--web"])) return "--web opens a browser on the host";
    const reads = READS[group];
    if (reads === true || (reads && command !== undefined && reads.includes(command))) return undefined;
    return `gh ${words.slice(0, 2).join(" ")} is not a command that only reads`;
  },
};
