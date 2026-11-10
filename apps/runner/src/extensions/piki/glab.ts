import { pikiExtension } from "../../../../../packages/shared/src/piki-extensions.js";
import { apiWrites, commandWords, hasOption, hasShortOption, positionals, type CliSpec } from "./command.js";

const PIPELINE_READS = ["list", "status", "trace", "get"];
const READS: Record<string, readonly string[] | true> = {
  mr: ["list", "view", "diff"],
  issue: ["list", "view"],
  ci: PIPELINE_READS,
  pipe: PIPELINE_READS,
  pipeline: PIPELINE_READS,
  repo: ["list", "view"],
  release: ["list", "view"],
  label: ["list"],
  milestone: ["list", "get"],
  schedule: ["list"],
  auth: ["status"],
  version: true,
  help: true,
};

export const glabSpec: CliSpec = {
  info: pikiExtension("piki:glab")!,
  command: "glab",
  windowsCommand: { file: "glab.exe", shim: false },
  description: [
    "Run the GitLab CLI (glab) as the session owner: in the session's sandbox, where Pikibun adds the session owner's GitLab (gitlab.com) access token to its API requests, on the session owner's own host.",
    "Give the arguments after glab as a list, as they are passed (no shell, no quoting), such as {\"args\": [\"ci\", \"list\", \"--repo\", \"group/project\"]}.",
    "Use it for what the sandbox can't reach: merge requests and their discussions, CI/CD pipelines and job logs (ci list, ci trace <job id>), releases, and the API (api projects/:id/...).",
    "Name the project with --repo group/project: it runs in the session's worktree, or in directory, a clone in it. Only gitlab.com is reached this way, not self-managed GitLab.",
    "It reads always; it writes (merge requests, notes, pipeline runs) only in a call a person approved.",
    "Each call waits for approval unless the workspace runs this extension's tools automatically; where the workspace set it read-only, only commands that read run.",
    "Commands that would show its token (--show-token, config get token) are refused. Interactive commands (ci view) don't work here.",
  ].join(" "),
  passEnv: name => ["GITLAB_TOKEN", "GITLAB_ACCESS_TOKEN", "OAUTH_TOKEN", "GITLAB_HOST", "GITLAB_URI", "GL_HOST", "GITLAB_API_HOST", "GLAB_CONFIG_DIR"].includes(name),
  setEnv: { NO_PROMPT: "1", GLAB_CHECK_UPDATE: "false", GLAB_SEND_TELEMETRY: "false", GLAMOUR_STYLE: "notty" },
  tokenEnv: ["GITLAB_TOKEN"],
  refused(args) {
    const words = positionals(args);
    if (words.includes("auth") && (hasOption(args, ["--show-token"]) || hasShortOption(args, "t"))) return "--show-token would show its token";
    if (words.includes("config") && words.includes("get") && args.some(arg => /token/i.test(arg))) return "glab config get would show its token";
    return undefined;
  },
  writes(args) {
    if (args.length === 1 && args[0] === "--version") return undefined;
    const words = commandWords(args);
    const [group, command] = words;
    if (!group) return `glab ${args.join(" ")} is not a command that only reads`;
    if (group === "api") return apiWrites(args);
    if (hasOption(args, ["--web", "-w"])) return "--web opens a browser on the host";
    const reads = READS[group];
    if (reads === true || (reads && command !== undefined && reads.includes(command))) return undefined;
    return `glab ${words.slice(0, 2).join(" ")} is not a command that only reads`;
  },
};
