export interface CliCall {
  words?: readonly string[];
  wordPrefixes?: true;
  options?: readonly string[];
  short?: string;
  argPattern?: string;
}

export interface CliRefusal extends CliCall { reason: string }

export interface CliHint extends CliCall { outputPattern?: string; hint: string }

export interface CliRequestRule { words: readonly string[]; method: readonly string[]; body: readonly string[] }

export interface CliReads {
  hostFileArgs?: true;
  secretWords?: string;
  api?: string;
  requests?: readonly CliRequestRule[];
  browserOptions?: readonly string[];
  fileOptions?: readonly { name: string; shortest: string }[];
  groups?: Readonly<Record<string, readonly string[] | true>>;
  verb?: string;
}

export interface CliWatch { commands: readonly { words: readonly string[]; option?: string }[]; interval: string; short?: string; seconds: number }

export interface CliDefinition {
  kind: "cli";
  name: string;
  extension: string;
  command: string;
  windowsCommand?: { file: string; shim: boolean };
  description: string;
  passEnv: readonly string[];
  passEnvPrefixes?: readonly string[];
  tokenEnv: readonly string[];
  setEnv: Readonly<Record<string, string>>;
  sandboxRoots?: readonly string[];
  lowercase?: true;
  abbreviatedOptions?: true;
  refuse: readonly CliRefusal[];
  hints?: readonly CliHint[];
  reads: CliReads;
  watch?: CliWatch;
}

export const cliDefinitionLimits = Object.freeze({ definitions: 16, rules: 64, words: 64, word: 128, text: 4096, pattern: 256, patterns: 32,
  patternInput: 4096, patternOutput: 128 * 1024, matchMs: 100 });

export const GH_WATCH_INTERVAL_SECONDS = 30;

const ghCommentViews = ["issue", "pr"].map(group => ({ group, call: { words: [group, "view"], options: ["--comments"], short: "c" } }));

const ghReads: Record<string, readonly string[] | true> = {
  pr: ["list", "view", "diff", "checks", "status"], issue: ["list", "view", "status"], run: ["list", "view", "watch"], workflow: ["list", "view"],
  repo: ["list", "view"], release: ["list", "view"], search: true, gist: ["list", "view"], label: ["list"], cache: ["list"], secret: ["list"],
  variable: ["list", "get"], ruleset: ["list", "view", "check"], project: ["list", "view", "field-list", "item-list"], org: ["list"], status: true,
  auth: ["status"], version: true, help: true,
};

const pipelineReads = ["list", "status", "trace", "get"];
const glabReads: Record<string, readonly string[] | true> = {
  mr: ["list", "view", "diff"], issue: ["list", "view"], ci: pipelineReads, pipe: pipelineReads, pipeline: pipelineReads, repo: ["list", "view"],
  release: ["list", "view"], label: ["list"], milestone: ["list", "get"], schedule: ["list"], auth: ["status"], version: true, help: true,
};

export const ghDefinition: CliDefinition = {
  kind: "cli", name: "gh", extension: "piki:gh", command: "gh", windowsCommand: { file: "gh.exe", shim: false },
  description: [
    "Run the GitHub CLI (gh) as the session owner: in the session's sandbox, or through Pikibun's proxy in a clone session on its host that uses the owner's Pikibun account, where Pikibun adds the session owner's access to the workspace's github.com repositories to its GitHub API requests.",
    "In other sessions on a host, it runs with the host's own gh sign-in.",
    "Give the arguments after gh as a list, as they are passed (no shell, no quoting), such as {\"args\": [\"pr\", \"checks\", \"42\", \"--repo\", \"acme/app\"]}.",
    "Use it for what the sandbox can't reach: GitHub Actions runs and their logs (run list, run view <id> --log-failed), pull request checks and reviews, releases, repository settings, and the REST and GraphQL APIs (api repos/acme/app/...).",
    "Name the repository with --repo owner/name: it runs in the session's worktree, or in directory, a clone in it.",
    "Use it rather than github_read, which spends the session owner's own GitHub rate limit: to read issues and pull requests (issue view, pr view --comments, pr checks),",
    "and to wait for a pull request's CI (pr checks <n> --watch, run watch <id>, with a timeout_seconds long enough); github_read with wait: \"change\" still waits for any other change (a comment, review or push).",
    `A watch reads again every ${GH_WATCH_INTERVAL_SECONDS} seconds unless it names its own --interval: don't make it shorter, and don't poll in a loop instead, since every read counts against a GitHub rate limit that all of the owner's sessions share.`,
    "It reads the workspace's repositories always. It writes (comments, pull requests, merges, reruns) only on the session owner's own host, or on any host once the owner lets their account serve others' hosts, outside read-only;",
    "where it refuses a write, comment, open issues and merge with github_comment, github_issue and github_merge.",
    "Where it may write, its GraphQL and API paths that name no repository (user/repos, search) go as the owner, beyond the workspace's repositories.",
    "Where the workspace set it read-only, only commands that read run.",
    "Commands that would show its token (auth token, --show-token) are refused.",
  ].join(" "),
  passEnv: ["GH_TOKEN", "GITHUB_TOKEN", "GH_ENTERPRISE_TOKEN", "GITHUB_ENTERPRISE_TOKEN", "GH_HOST", "GH_CONFIG_DIR"],
  tokenEnv: ["GH_TOKEN", "GITHUB_TOKEN"],
  setEnv: { GH_PROMPT_DISABLED: "1", GH_NO_UPDATE_NOTIFIER: "1", GH_NO_EXTENSION_UPDATE_NOTIFIER: "1", GH_SPINNER_DISABLED: "1", GH_PAGER: "cat" },
  refuse: [
    { words: ["auth", "token"], reason: "gh auth token would show its token" },
    { words: ["auth"], options: ["--show-token"], short: "t", reason: "--show-token would show its token" },
    { words: ["config", "get"], argPattern: "token", reason: "gh config get would show its token" },
    ...ghCommentViews.map(({ group, call }) => ({ ...call, argPattern: "^--json(?:=|$)",
      reason: `gh ${group} view takes --comments or --json, not both: use --json comments alone, with any other fields beside it (--json title,body,comments)` })),
  ],
  hints: [
    { outputPattern: "tls: failed to verify certificate|\\bx509: ",
      hint: "gh couldn't verify GitHub's TLS certificate: this host's TLS setup (its certificate store, or a proxy that intercepts HTTPS) refused it. "
        + "That is not GitHub being down, nor a failed check, and retrying won't help. github_read (with wait: \"checks\" or \"change\"), github_comment, "
        + "github_issue and github_merge still reach GitHub through the Pikibun server: use them, and tell the person that the host's owner has to fix the host's certificates." },
    { outputPattern: "Bad credentials|\\bHTTP 401\\b",
      hint: "GitHub refused the token this request went with (401 Bad credentials). Usually a git_push, in this session or another of the session owner's, "
        + "just reset the owner's GitHub token and this host still held the old one: that is not a lost sign-in, and it passes within a minute, so run the command again then. "
        + "Meanwhile git still works (git ls-remote --tags origin confirms pushed tags), and github_read reads a pull request and waits for its checks (wait: \"checks\") "
        + "through the Pikibun server. If gh still answers 401 after a few minutes, stop retrying and tell the person." },
    ...ghCommentViews.map(({ group, call }) => ({ ...call,
      hint: `gh ${group} view --comments failed or printed nothing: if the number and repository are right, read the comments with --json comments (without --comments), or with gh api repos/<owner>/<name>/issues/<n>/comments.` })),
  ],
  reads: { api: "api", browserOptions: ["--web"], groups: ghReads },
  watch: { commands: [{ words: ["run", "watch"] }, { words: ["pr", "checks"], option: "--watch" }], interval: "--interval", short: "i", seconds: GH_WATCH_INTERVAL_SECONDS },
};

export const glabDefinition: CliDefinition = {
  kind: "cli", name: "glab", extension: "piki:glab", command: "glab", windowsCommand: { file: "glab.exe", shim: false },
  description: [
    "Run the GitLab CLI (glab) as the session owner: in the session's sandbox, where Pikibun adds the session owner's GitLab (gitlab.com) access token to its API requests, on the session owner's own host, or on any host once the owner lets their account serve others' hosts.",
    "Give the arguments after glab as a list, as they are passed (no shell, no quoting), such as {\"args\": [\"ci\", \"list\", \"--repo\", \"group/project\"]}.",
    "Use it for what the sandbox can't reach: merge requests and their discussions, CI/CD pipelines and job logs (ci list, ci trace <job id>), releases, and the API (api projects/:id/...).",
    "Name the project with --repo group/project: it runs in the session's worktree, or in directory, a clone in it. Only gitlab.com is reached this way, not self-managed GitLab.",
    "It reads always; it writes (merge requests, notes, pipeline runs) outside read-only.",
    "Where the workspace set it read-only, only commands that read run.",
    "Commands that would show its token (--show-token, config get token) are refused. Interactive commands (ci view) don't work here.",
  ].join(" "),
  passEnv: ["GITLAB_TOKEN", "GITLAB_ACCESS_TOKEN", "OAUTH_TOKEN", "GITLAB_HOST", "GITLAB_URI", "GL_HOST", "GITLAB_API_HOST", "GLAB_CONFIG_DIR"],
  tokenEnv: ["GITLAB_TOKEN"],
  setEnv: { NO_PROMPT: "1", GLAB_CHECK_UPDATE: "false", GLAB_SEND_TELEMETRY: "false", GLAMOUR_STYLE: "notty" },
  refuse: [
    { words: ["auth"], options: ["--show-token"], short: "t", reason: "--show-token would show its token" },
    { words: ["config", "get"], argPattern: "token", reason: "glab config get would show its token" },
  ],
  reads: { api: "api", browserOptions: ["--web", "-w"], groups: glabReads },
};

export const azureCliDefinition: CliDefinition = {
  kind: "cli", name: "azure-cli", extension: "piki:azure-cli", command: "az", windowsCommand: { file: "az.cmd", shim: true },
  description: [
    "Run the Azure CLI (az) as the session owner: in the session's sandbox, where Pikibun adds the session owner's Azure DevOps personal access token (for the organization a request names) to its requests to dev.azure.com, on the session owner's own host, or on any host once the owner lets their account serve others' hosts.",
    "Give the arguments after az as a list, as they are passed (no shell, no quoting), such as {\"args\": [\"repos\", \"pr\", \"list\", \"--organization\", \"https://dev.azure.com/acme\", \"--project\", \"App\"]}.",
    "Use it for Azure DevOps: pull requests, pipelines and their runs, and work items (az repos, az pipelines, az boards, with the azure-devops extension), and their REST API (az devops invoke). Azure resources (az vm, az storage, ...) need an Azure sign-in, which only the host owner's own sessions have, where the host's owner allows that.",
    "Pass --organization https://dev.azure.com/<organization> and --project; it runs in the session's worktree, or in directory, a clone in it. Add --output json for output to read.",
    "It reads always; it writes outside read-only.",
    "Where the workspace set it read-only, only commands that read (list, show, query) run, and none that show keys or secrets.",
    "Commands that would show its tokens (account get-access-token, --expose-token, --debug) are refused.",
  ].join(" "),
  passEnv: ["AZDEVOPS_EXT_PAT"], passEnvPrefixes: ["AZURE_"],
  tokenEnv: ["AZURE_DEVOPS_EXT_PAT"],
  sandboxRoots: ["/opt/az", "/opt/azure-cli"],
  setEnv: { AZURE_CORE_NO_COLOR: "true", AZURE_CORE_ONLY_SHOW_ERRORS: "true", AZURE_CORE_DISABLE_PROGRESS_BAR: "true", AZURE_CORE_SURVEY_MESSAGE: "false",
    PYTHONIOENCODING: "utf-8" },
  lowercase: true, abbreviatedOptions: true,
  refuse: [
    { words: ["account", "get-access-token"], wordPrefixes: true, reason: "az account get-access-token would show a token" },
    { options: ["--expose-token"], reason: "--expose-token would show a token" },
    { options: ["--debug"], reason: "--debug would log its requests, with their credentials" },
  ],
  reads: {
    hostFileArgs: true,
    secretWords: "key|secret|password|credential|token|connection-string|sas|publish|appsettings|kubeconfig",
    requests: [{ words: ["rest"], method: ["--method", "-m"], body: ["--body", "-b"] }, { words: ["devops", "invoke"], method: ["--http-method"], body: ["--in-file"] }],
    fileOptions: [{ name: "--output-file", shortest: "--output-" }, { name: "--file", shortest: "--fil" }, { name: "--path", shortest: "--pat" }],
    verb: "^(?:list|show|query|version|(?:list|show)-[a-z-]+)$",
  },
};

export const bundledCliDefinitions: readonly CliDefinition[] = Object.freeze([ghDefinition, glabDefinition, azureCliDefinition]);

const isObject = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const NAME = /^[a-z][a-z0-9-]{0,63}$/;
const OPTION = /^-{1,2}[A-Za-z0-9][A-Za-z0-9-]{0,63}$/;
const ENV = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
const ARG = /^[^\s\0]{1,128}$/;

function fail(what: string): never { throw new Error(`Invalid CLI definition: ${what}`); }
function text(value: unknown, what: string, limit: number = cliDefinitionLimits.text): string {
  if (typeof value !== "string" || !value || value.length > limit || value.includes("\0")) fail(what);
  return value;
}
function list(value: unknown, pattern: RegExp, what: string, limit: number = cliDefinitionLimits.words): string[] {
  if (!Array.isArray(value) || value.length > limit || value.some(item => typeof item !== "string" || !pattern.test(item))) fail(what);
  return [...value] as string[];
}
function regex(value: unknown, what: string): string {
  const source = text(value, what, cliDefinitionLimits.pattern);
  try { new RegExp(source, "i"); } catch { fail(what); }
  return source;
}
function keys(value: Record<string, unknown>, allowed: readonly string[], what: string): void {
  const unknown = Object.keys(value).find(key => !allowed.includes(key));
  if (unknown !== undefined) fail(`${what} has a key this version doesn't know (${unknown.slice(0, 64)})`);
}

export function cliPatternCount(definition: Pick<CliDefinition, "refuse" | "hints" | "reads">): number {
  return definition.refuse.filter(rule => rule.argPattern !== undefined).length
    + (definition.hints ?? []).reduce((count, rule) => count + (rule.argPattern !== undefined ? 1 : 0) + (rule.outputPattern !== undefined ? 1 : 0), 0)
    + (definition.reads.secretWords !== undefined ? 1 : 0) + (definition.reads.verb !== undefined ? 1 : 0);
}

export function withoutCliHints(definition: CliDefinition): CliDefinition {
  const copy = { ...definition };
  delete copy.hints;
  return copy;
}

const CALL_KEYS = ["words", "wordPrefixes", "options", "short", "argPattern"];

function parseCall(value: Record<string, unknown>, what: string): CliCall {
  const call: { -readonly [K in keyof CliCall]: CliCall[K] } = {};
  if (value.words !== undefined) call.words = list(value.words, ARG, `${what} words`, 8);
  if (value.wordPrefixes !== undefined) { if (value.wordPrefixes !== true) fail(what); call.wordPrefixes = true; }
  if (value.options !== undefined) call.options = list(value.options, OPTION, `${what} options`, 16);
  if (value.short !== undefined) { if (typeof value.short !== "string" || !/^[A-Za-z]$/.test(value.short)) fail(`${what} short option`); call.short = value.short; }
  if (value.argPattern !== undefined) call.argPattern = regex(value.argPattern, `${what} pattern`);
  return call;
}

const matchesSomeCalls = (call: CliCall) => !!(call.words?.length || call.options?.length || call.short || call.argPattern);

function parseRefusal(value: unknown): CliRefusal {
  if (!isObject(value)) fail("refusal");
  keys(value, [...CALL_KEYS, "reason"], "refusal");
  const refusal = { ...parseCall(value, "refusal"), reason: text(value.reason, "refusal reason", 512) };
  if (!matchesSomeCalls(refusal)) fail("refusal that matches everything");
  return refusal;
}

function parseHint(value: unknown): CliHint {
  if (!isObject(value)) fail("hint");
  keys(value, [...CALL_KEYS, "outputPattern", "hint"], "hint");
  const hint = { ...parseCall(value, "hint"), ...(value.outputPattern !== undefined ? { outputPattern: regex(value.outputPattern, "hint output pattern") } : {}),
    hint: text(value.hint, "hint", 1024) };
  if (!matchesSomeCalls(hint) && !hint.outputPattern) fail("hint that matches everything");
  return hint;
}

function parseReads(value: unknown): CliReads {
  if (!isObject(value)) fail("reads");
  keys(value, ["hostFileArgs", "secretWords", "api", "requests", "browserOptions", "fileOptions", "groups", "verb"], "reads");
  const reads: { -readonly [K in keyof CliReads]: CliReads[K] } = {};
  if (value.hostFileArgs !== undefined) { if (value.hostFileArgs !== true) fail("reads"); reads.hostFileArgs = true; }
  if (value.secretWords !== undefined) reads.secretWords = regex(value.secretWords, "secret words");
  if (value.api !== undefined) { if (typeof value.api !== "string" || !ARG.test(value.api)) fail("api"); reads.api = value.api; }
  if (value.requests !== undefined) {
    if (!Array.isArray(value.requests) || value.requests.length > 16) fail("requests");
    reads.requests = value.requests.map(rule => {
      if (!isObject(rule)) fail("request rule");
      keys(rule, ["words", "method", "body"], "request rule");
      return { words: list(rule.words, ARG, "request words", 8), method: list(rule.method, OPTION, "request method options", 8), body: list(rule.body, OPTION, "request body options", 8) };
    });
  }
  if (value.browserOptions !== undefined) reads.browserOptions = list(value.browserOptions, OPTION, "browser options", 8);
  if (value.fileOptions !== undefined) {
    if (!Array.isArray(value.fileOptions) || value.fileOptions.length > 16) fail("file options");
    reads.fileOptions = value.fileOptions.map(option => {
      if (!isObject(option) || typeof option.name !== "string" || typeof option.shortest !== "string" || !OPTION.test(option.name) || !option.name.startsWith(option.shortest)
        || option.shortest.length < 3) fail("file option");
      return { name: option.name, shortest: option.shortest };
    });
  }
  if (value.groups !== undefined) {
    if (!isObject(value.groups) || Object.keys(value.groups).length > cliDefinitionLimits.rules) fail("groups");
    const groups: Record<string, readonly string[] | true> = {};
    for (const [group, commands] of Object.entries(value.groups)) {
      if (!ARG.test(group)) fail("group");
      groups[group] = commands === true ? true : list(commands, ARG, `commands of ${group}`, 32);
    }
    reads.groups = groups;
  }
  if (value.verb !== undefined) reads.verb = regex(value.verb, "verb");
  return reads;
}

export function parseCliDefinition(value: unknown): CliDefinition {
  if (!isObject(value) || value.kind !== "cli") fail("kind");
  keys(value, ["kind", "name", "extension", "command", "windowsCommand", "description", "passEnv", "passEnvPrefixes", "tokenEnv", "setEnv", "sandboxRoots",
    "lowercase", "abbreviatedOptions", "refuse", "hints", "reads", "watch"], "CLI");
  if (typeof value.name !== "string" || !NAME.test(value.name)) fail("name");
  if (typeof value.extension !== "string" || value.extension !== `piki:${value.name}`) fail("extension");
  if (typeof value.command !== "string" || !/^[a-z][a-z0-9._-]{0,63}$/.test(value.command)) fail("command");
  let windowsCommand: CliDefinition["windowsCommand"];
  if (value.windowsCommand !== undefined) {
    if (!isObject(value.windowsCommand) || typeof value.windowsCommand.file !== "string" || !/^[a-z][a-z0-9._-]{0,63}\.(?:exe|cmd)$/.test(value.windowsCommand.file)
      || typeof value.windowsCommand.shim !== "boolean") fail("windowsCommand");
    windowsCommand = { file: value.windowsCommand.file, shim: value.windowsCommand.shim };
  }
  if (!isObject(value.setEnv) || Object.keys(value.setEnv).length > 16) fail("setEnv");
  const setEnv: Record<string, string> = {};
  for (const [name, setting] of Object.entries(value.setEnv)) {
    if (!ENV.test(name) || typeof setting !== "string" || !/^[A-Za-z0-9._:/@%+,=-]{0,128}$/.test(setting)) fail("setEnv");
    setEnv[name] = setting;
  }
  if (!Array.isArray(value.refuse) || value.refuse.length > cliDefinitionLimits.rules) fail("refuse");
  if (value.hints !== undefined && (!Array.isArray(value.hints) || value.hints.length > cliDefinitionLimits.rules)) fail("hints");
  let watch: CliWatch | undefined;
  if (value.watch !== undefined) {
    const given = value.watch;
    if (!isObject(given) || !Array.isArray(given.commands) || given.commands.length > 8 || typeof given.interval !== "string" || !OPTION.test(given.interval)
      || !Number.isSafeInteger(given.seconds) || (given.seconds as number) < 5 || (given.seconds as number) > 600
      || (given.short !== undefined && (typeof given.short !== "string" || !/^[A-Za-z]$/.test(given.short)))) fail("watch");
    watch = { commands: given.commands.map(item => {
      if (!isObject(item)) fail("watch");
      if (item.option !== undefined && (typeof item.option !== "string" || !OPTION.test(item.option))) fail("watch");
      return { words: list(item.words, ARG, "watch words", 4), ...(item.option !== undefined ? { option: item.option as string } : {}) };
    }), interval: given.interval, ...(given.short !== undefined ? { short: given.short as string } : {}), seconds: given.seconds as number };
  }
  const refuse = value.refuse.map(parseRefusal);
  const hints = value.hints !== undefined ? (value.hints as unknown[]).map(parseHint) : undefined;
  const reads = parseReads(value.reads);
  if (cliPatternCount({ refuse, ...(hints ? { hints } : {}), reads }) > cliDefinitionLimits.patterns) fail(`more than ${cliDefinitionLimits.patterns} patterns`);
  return {
    kind: "cli", name: value.name, extension: value.extension, command: value.command, ...(windowsCommand ? { windowsCommand } : {}),
    description: text(value.description, "description"),
    passEnv: list(value.passEnv, ENV, "passEnv", 32), ...(value.passEnvPrefixes !== undefined ? { passEnvPrefixes: list(value.passEnvPrefixes, /^[A-Za-z_][A-Za-z0-9_]{1,31}$/, "passEnvPrefixes", 8) } : {}),
    tokenEnv: list(value.tokenEnv, ENV, "tokenEnv", 8), setEnv,
    ...(value.sandboxRoots !== undefined ? { sandboxRoots: list(value.sandboxRoots, /^\/[A-Za-z0-9._+-]+(?:\/[A-Za-z0-9._+-]+)*$/, "sandboxRoots", 8) } : {}),
    ...(value.lowercase === true ? { lowercase: true as const } : {}), ...(value.abbreviatedOptions === true ? { abbreviatedOptions: true as const } : {}),
    refuse, ...(hints ? { hints } : {}), reads, ...(watch ? { watch } : {}),
  };
}

export type SkippedDefinition = (name: string, reason: string) => void;

export function parseCliDefinitions(value: unknown, skipped: SkippedDefinition = () => {}): CliDefinition[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > cliDefinitionLimits.definitions) {
    skipped("", Array.isArray(value) ? `more than ${cliDefinitionLimits.definitions} CLI definitions` : "the CLI definitions aren't a list");
    return [];
  }
  const found: CliDefinition[] = [];
  for (const item of value) {
    const name = isObject(item) && typeof item.name === "string" && NAME.test(item.name) ? item.name : "";
    let definition: CliDefinition;
    try { definition = parseCliDefinition(item); }
    catch (error) {
      skipped(name, error instanceof Error ? error.message : String(error));
      continue;
    }
    if (found.some(other => other.name === definition.name)) skipped(name, "a second definition of that name");
    else found.push(definition);
  }
  return found;
}
