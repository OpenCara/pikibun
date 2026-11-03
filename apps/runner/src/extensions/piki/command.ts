import { spawn } from "node:child_process";
import { mkdtemp, realpath, rm, stat } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import { Type } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionFactory } from "@earendil-works/pi-coding-agent";
import type { PikiExtensionInfo } from "../../../../../packages/shared/src/piki-extensions.js";
import { killTree, windows, windowsSystemEnvironment } from "../../platform.js";

/*
 * A command-line tool as a Pi extension (docs/design/piki-extensions.md): one tool that runs the command with the
 * arguments the model gives, without a shell, as the session owner. It runs in the session's sandbox, where the egress
 * proxy adds the session owner's access to the forge's API (api-access.ts): reads always, writes only in a call a person
 * approved, on the session owner's own host. Only where the session itself runs on its host, or in the host owner's own
 * sessions where the host's owner turned it on (PIKIBUN_PIKI_HOST_SIGN_IN), does it run on the host with the host's own
 * sign-in to the command, as it did before. Arguments that would show the command's credentials never run. With the
 * workspace's `read-only` setting, only commands that read run: in the sandbox, with the worktree read-only; on the host,
 * outside the worktree, so that what a session wrote there (a repository's Git configuration) can't make it run code.
 */

/** What one command-line tool needs. */
export interface CliSpec {
  info: PikiExtensionInfo;
  /** The executable; on Windows `windowsCommand` (a `.cmd` shim runs through cmd.exe, with plain arguments only). */
  command: string;
  windowsCommand?: { file: string; shim: boolean };
  /** The tool's description, for the model. */
  description: string;
  /** Environment variables of the connector it gets on the host, besides the common ones: its own sign-in and configuration. */
  passEnv: (name: string) => boolean;
  /** The variables that hold its API token in the sandbox: the proxy's placeholder, or an approved call's write lease. */
  tokenEnv: readonly string[];
  /** Variables it always gets: no prompts, colors, pagers or update checks. */
  setEnv: Record<string, string>;
  /** Why `args` never run (they would show its credentials), if so. */
  refused(args: readonly string[]): string | undefined;
  /** Why `args` may change something, if they may: refused with the read-only setting. */
  writes(args: readonly string[]): string | undefined;
}

/** The arguments' leading words, before the first option: the command path, such as `pr view`. */
export function commandWords(args: readonly string[]): string[] {
  const words: string[] = [];
  for (const arg of args) {
    if (arg.startsWith("-")) break;
    words.push(arg);
  }
  return words;
}

/**
 * Every argument that isn't an option, wherever it is: the command's words, wherever options sit between them (gh, glab
 * and az all take `auth --hostname x token`), and option values too. For refusals, which would rather refuse too much.
 */
export function positionals(args: readonly string[]): string[] {
  return args.filter(arg => !arg.startsWith("-"));
}

/** Whether `args` hold the short option `-letter`, alone, in a cluster (`-at`) or with its value joined (`-tx`). */
export function hasShortOption(args: readonly string[], letter: string): boolean {
  return args.some(arg => /^-[^-]/.test(arg) && arg.slice(1).includes(letter));
}

/**
 * The values `args` give an option, by any of its `names` (`-X`, `--method`): `--method GET`, `--method=GET` and
 * `-XGET`. Each value is the argument after the name unless it is joined to it.
 */
export function optionValues(args: readonly string[], names: readonly string[]): string[] {
  const values: string[] = [];
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!;
    if (arg === "--") break;
    for (const name of names) {
      if (arg === name) { if (index + 1 < args.length) values.push(args[index + 1]!); index++; break; }
      if (name.startsWith("--") && arg.startsWith(`${name}=`)) { values.push(arg.slice(name.length + 1)); break; }
      if (!name.startsWith("--") && name.length === 2 && arg.startsWith(name) && arg.length > 2) { values.push(arg.slice(2)); break; }
    }
  }
  return values;
}

export const hasOption = (args: readonly string[], names: readonly string[]) =>
  args.some(arg => names.some(name => arg === name || (name.startsWith("--") && arg.startsWith(`${name}=`))));

const FIELDS = ["-f", "-F", "--field", "--raw-field"];
const TYPED_FIELDS = ["-F", "--field"];

/**
 * Why an `api` call of gh or glab (`args` from `api` on) may change something: any method but GET, a body, a field read
 * from a host file, or a GraphQL mutation. Short options must take their values apart (`-X GET`, not `-XGET` or `-iX`),
 * so that none hides in a cluster.
 */
export function apiWrites(args: readonly string[]): string | undefined {
  const rest = args.slice(1);
  if (rest.some(arg => /^-[^-]./.test(arg))) return "api's short options take their values apart here (-X GET, -f key=value)";
  if (hasOption(rest, ["--input"])) return "api --input sends a request body";
  if (optionValues(rest, TYPED_FIELDS).some(value => value.slice(value.indexOf("=") + 1).startsWith("@"))) return "api reads a host file into a field (@file)";
  if (optionValues(rest, ["-H", "--header"]).some(value => /^\s*x-http-method-override\s*:/i.test(value))) return "api overrides its method";
  const endpoint = commandWords(rest)[0];
  const fields = optionValues(rest, FIELDS);
  const methods = optionValues(rest, ["-X", "--method"]).map(method => method.toUpperCase());
  if (endpoint === "graphql") {
    if (methods.some(method => method !== "POST")) return "api graphql only takes POST";
    // The command keeps the last of repeated fields: exactly one query, and that one checked.
    const queries = fields.filter(field => field.startsWith("query="));
    if (queries.length !== 1) return "api graphql takes exactly one query field (-f query=...)";
    const query = queries[0]!;
    if (/\b(?:mutation|subscription)\b/i.test(query)) return "api graphql runs a mutation";
    return undefined;
  }
  const method = methods.at(-1) ?? (fields.length ? "POST" : "GET");
  return method === "GET" ? undefined : `api sends a ${method} request`;
}

/** The connector's variables every command gets: where it finds its tools and files, the network's proxies and CAs. */
const COMMON_ENV = new Set(["PATH", "HOME", "USER", "LOGNAME", "SHELL", "TZ", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME", "XDG_CACHE_HOME",
  "XDG_RUNTIME_DIR", "DBUS_SESSION_BUS_ADDRESS", "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "no_proxy", "all_proxy",
  "SSL_CERT_FILE", "SSL_CERT_DIR", "REQUESTS_CA_BUNDLE", "CURL_CA_BUNDLE"]);

export function cliEnvironment(spec: Pick<CliSpec, "passEnv" | "setEnv">, source: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const env: Record<string, string> = windows ? windowsSystemEnvironment() : {};
  for (const [name, value] of Object.entries(source)) {
    if (value !== undefined && (COMMON_ENV.has(name) || spec.passEnv(name))) env[name] = value;
  }
  return { ...env, HOME: source.HOME ?? homedir(), PATH: source.PATH ?? "/usr/local/bin:/usr/bin:/bin", TMPDIR: tmpdir(), LANG: "C.UTF-8", LC_ALL: "C.UTF-8",
    TERM: "dumb", NO_COLOR: "1", CLICOLOR: "0", PAGER: "cat", ...spec.setEnv };
}

/** What a call returns at most: its output's start and end, which holds a failure's reason. */
const HEAD_BYTES = 32 * 1024;
const TAIL_BYTES = 96 * 1024;
const DEFAULT_TIMEOUT_SECONDS = 300;

/** A run's output, its start and end kept where it is longer than the model should read. */
class Output {
  #head: Buffer[] = [];
  #headSize = 0;
  #tail: Buffer[] = [];
  #tailSize = 0;
  #total = 0;

  push(chunk: Buffer): void {
    this.#total += chunk.length;
    if (this.#headSize < HEAD_BYTES) {
      const part = chunk.subarray(0, HEAD_BYTES - this.#headSize);
      this.#head.push(part);
      this.#headSize += part.length;
      chunk = chunk.subarray(part.length);
    }
    if (!chunk.length) return;
    this.#tail.push(chunk);
    this.#tailSize += chunk.length;
    while (this.#tailSize - this.#tail[0]!.length >= TAIL_BYTES) this.#tailSize -= this.#tail.shift()!.length;
  }

  text(): string {
    const head = Buffer.concat(this.#head).toString("utf8");
    let tail = Buffer.concat(this.#tail);
    if (tail.length > TAIL_BYTES) tail = tail.subarray(tail.length - TAIL_BYTES);
    const left = this.#total - this.#headSize - tail.length;
    return left > 0 ? `${head}\n[… ${left} bytes left out …]\n${tail.toString("utf8")}` : head + tail.toString("utf8");
  }
}

/** Quotes one argument for cmd.exe running a `.cmd` shim; arguments it would read as its own syntax are refused before. */
const CMD_SPECIAL = /["%!^&|<>()\r\n]/;

export interface CliRun { exitCode: number | null; signal: NodeJS.Signals | null; output: string; failure?: string }

/** Runs the command with `args` in `cwd`, its stdout and stderr together, until it exits, `signal` aborts or it times out. */
export function runCli(spec: Pick<CliSpec, "command" | "windowsCommand" | "passEnv" | "setEnv">, args: readonly string[], options: {
  cwd: string; signal: AbortSignal; timeoutSeconds: number; env?: Record<string, string>;
}): Promise<CliRun> {
  options.signal.throwIfAborted();
  const shim = windows && spec.windowsCommand?.shim === true;
  if (shim && args.some(arg => CMD_SPECIAL.test(arg))) {
    throw new Error(`On Windows, ${spec.command} runs through cmd.exe: its arguments can't hold " % ! ^ & | < > ( ) or line breaks.`);
  }
  const file = windows && spec.windowsCommand ? spec.windowsCommand.file : spec.command;
  return new Promise((resolvePromise, reject) => {
    const child = shim
      ? spawn(process.env.ComSpec ?? "cmd.exe", ["/d", "/s", "/c", `"${[file, ...args].map(arg => `"${arg}"`).join(" ")}"`],
        { cwd: options.cwd, env: options.env ?? cliEnvironment(spec), stdio: ["ignore", "pipe", "pipe"], windowsHide: true, windowsVerbatimArguments: true })
      : spawn(file, [...args], { cwd: options.cwd, env: options.env ?? cliEnvironment(spec), stdio: ["ignore", "pipe", "pipe"], windowsHide: true, detached: !windows });
    const output = new Output();
    let failure: string | undefined;
    let missing = false;
    const stop = (reason: string) => {
      failure ??= reason;
      killTree(child);
      child.stdout?.destroy();
      child.stderr?.destroy();
    };
    const abort = () => stop("It was stopped");
    options.signal.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(() => stop(`It took longer than ${options.timeoutSeconds} seconds`), options.timeoutSeconds * 1000);
    child.stdout!.on("data", (chunk: Buffer) => output.push(chunk));
    child.stderr!.on("data", (chunk: Buffer) => output.push(chunk));
    child.on("error", error => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") missing = true;
      else failure ??= error.message;
    });
    child.on("close", (exitCode, signal) => {
      clearTimeout(timer);
      options.signal.removeEventListener("abort", abort);
      if (!windows && child.pid) killTree(child);
      if (missing) { reject(new MissingCommandError(file)); return; }
      resolvePromise({ exitCode, signal, output: output.text(), ...(failure ? { failure } : {}) });
    });
  });
}

export class MissingCommandError extends Error {
  constructor(readonly command: string) { super(`${command} isn't installed on this host, or isn't on its PATH`); }
}

/** `directory` within the session's worktree `root`, as a real path; anything outside it, through links too, is refused. */
async function worktreeDirectory(root: string, directory: string): Promise<string> {
  if (directory.includes("\0") || isAbsolute(directory)) throw new Error("directory is a path within the session's worktree, such as app");
  const base = await realpath(root);
  let target: string;
  try { target = await realpath(resolve(base, directory)); }
  catch { throw new Error(`There is no directory ${directory} in the session's worktree`); }
  const inside = relative(base, target);
  if (inside.startsWith("..") || isAbsolute(inside)) throw new Error(`${directory} is outside the session's worktree`);
  if (!(await stat(target)).isDirectory()) throw new Error(`${directory} is not a directory`);
  return target;
}

const READ_ONLY = "read-only";

/** One run of a command in the session's sandbox (PikiSession.sandbox). */
export interface PikiSandboxRun {
  /** The tool call it is for: only a call the session admitted runs, and only one a person approved may write. */
  callId: string;
  command: string;
  args: readonly string[];
  /** A directory in the worktree, relative to it; the worktree by default. */
  directory?: string;
  /** Variables it gets besides the sandbox's own: no prompts, colors, pagers or update checks. */
  env: Record<string, string>;
  /** The variables that hold the API placeholder, which an approved call's write lease replaces. */
  tokenEnv: readonly string[];
  /** The workspace's read-only setting: the worktree is mounted read-only, and the call never writes through the API. */
  readOnly: boolean;
  signal: AbortSignal;
  timeoutSeconds: number;
}

/**
 * Where a session runs its Pikibun extensions' commands: `sandbox`, in its sandbox as the session owner, where it has
 * one with an egress proxy; `hostSignIn`, on the host with the host's own sign-in, only where the session runs on its
 * host or is the host owner's own and its owner allowed that. Neither: the command can't run in this session.
 */
export interface PikiSession {
  sandbox?: (run: PikiSandboxRun) => Promise<CliRun>;
  hostSignIn: boolean;
}

/** What a session that offers neither gets: the tool, which says why it can't run. */
export const noPikiSession: PikiSession = Object.freeze({ hostSignIn: false });

/**
 * The shell command that runs `command` with `args` and `env` in the sandbox, in `directory` of the worktree: every word
 * quoted, so nothing in them is the shell's; stdin closed, and its errors with its output. The command is looked for in
 * /usr/local/bin too, where its own installers put gh and glab, after the sandbox's own PATH: so the sandbox's git shim
 * (its first entry, where the host keeps a repository cache) and /usr/bin still come first, for the command and the Git
 * it runs.
 * The directory goes to cd as `./<directory>`, so no name of it (`-`) is one of cd's own.
 */
export function sandboxShellCommand(command: string, args: readonly string[], env: Record<string, string>, directory?: string): string {
  const quote = (value: string) => `'${value.replaceAll("'", `'\\''`)}'`;
  const assignments = Object.entries(env).map(([name, value]) => {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw new Error(`Invalid variable name ${name}`);
    return quote(`${name}=${value}`);
  });
  return `PATH="$PATH:/usr/local/bin" && export PATH && ${directory && directory !== "." ? `cd -- ${quote(`./${directory}`)} && ` : ""}`
    + `exec env ${[...assignments, quote(command), ...args.map(quote)].join(" ")} </dev/null 2>&1`;
}

/** `directory` as the sandbox takes it: a relative path within the worktree, without `..`. */
export function sandboxDirectory(directory: string): string {
  const parts = directory.replaceAll("\\", "/").split("/").filter(part => part && part !== ".");
  if (directory.includes("\0") || isAbsolute(directory) || /^[A-Za-z]:/.test(directory) || parts.includes("..")) {
    throw new Error("directory is a path within the session's worktree, such as app");
  }
  return parts.join("/") || ".";
}

/** The Pi extension for `spec`: its tool, and its `read-only` setting, as `session` runs it. */
export function commandExtension(spec: CliSpec, session: PikiSession = noPikiSession): ExtensionFactory {
  return (pi: ExtensionAPI) => {
    pi.registerFlag(READ_ONLY, { type: "boolean", default: false,
      description: `Run only ${spec.command} commands that read (lists, views, logs, GET requests), outside the session's worktree. Set it before running the tool automatically.` });
    pi.registerTool({
      name: spec.info.tool ?? spec.command, label: spec.info.title, description: spec.description,
      parameters: Type.Object({
        args: Type.Array(Type.String({ maxLength: 32 * 1024 }), { minItems: 1, maxItems: 256,
          description: `The arguments after ${spec.command}, one per item, exactly as they are passed: there is no shell, so don't quote them.` }),
        directory: Type.Optional(Type.String({ maxLength: 4096,
          description: "Where it runs: a directory in the session's worktree, such as a clone (app). The worktree by default." })),
        timeout_seconds: Type.Optional(Type.Integer({ minimum: 1, maximum: 3600, description: `At most this long (${DEFAULT_TIMEOUT_SECONDS} seconds by default).` })),
      }),
      async execute(toolCallId, params, signal, _onUpdate, ctx) {
        const args = params.args;
        if (args.some(arg => arg.includes("\0"))) throw new Error("An argument holds a NUL character.");
        const refused = spec.refused(args);
        if (refused) throw new Error(`Refused: ${refused}. Nothing ran.`);
        const readOnly = pi.getFlag(READ_ONLY) === true;
        if (readOnly) {
          const writes = spec.writes(args);
          if (writes) throw new Error(`Refused: this workspace runs ${spec.command} read-only, and ${writes}. Nothing ran.`);
        }
        const timeoutSeconds = params.timeout_seconds ?? DEFAULT_TIMEOUT_SECONDS;
        const outcome = (run: CliRun) => {
          const status = run.failure ?? (run.exitCode === 0 ? undefined : run.signal ? `It ended with ${run.signal}` : `It exited with ${run.exitCode}`);
          const text = run.output.trim() || "(no output)";
          if (status) throw new Error(`${status}.\n${text}`);
          return { content: [{ type: "text" as const, text }], details: { exitCode: 0 } };
        };
        if (!session.hostSignIn) {
          if (!session.sandbox) {
            throw new Error(`${spec.command} can't run in this session: it runs in a session's sandbox, as the session owner, and this session has none that reaches `
              + `the API through Pikibun; on the host it runs only in the host owner's own sessions, where the host's owner allows that. Nothing ran.`);
          }
          const run = await session.sandbox({ callId: toolCallId, command: spec.command, args, ...(params.directory !== undefined ? { directory: sandboxDirectory(params.directory) } : {}),
            env: spec.setEnv, tokenEnv: spec.tokenEnv, readOnly, signal: signal ?? new AbortController().signal, timeoutSeconds });
          // The shell's own answer when the command isn't there: the sandbox sees the host's /usr only.
          if (run.exitCode === 127 && new RegExp(`${spec.command}: (?:command )?not found|No such file`).test(run.output)) {
            throw new Error(`${spec.command} isn't installed where the session's sandbox finds it (the host's /usr/bin or /usr/local/bin). The host's owner installs it (${spec.info.install}).`);
          }
          return outcome(run);
        }
        if (readOnly && params.directory !== undefined) throw new Error(`Refused: this workspace runs ${spec.command} read-only, outside the session's worktree; leave out directory. Nothing ran.`);
        const scratch = readOnly ? await mkdtemp(join(tmpdir(), `pikibun-${spec.info.name}-`)) : undefined;
        try {
          const cwd = scratch ?? (params.directory !== undefined ? await worktreeDirectory(ctx.cwd, params.directory) : ctx.cwd);
          let run: CliRun;
          try {
            run = await runCli(spec, args, { cwd, signal: signal ?? new AbortController().signal, timeoutSeconds });
          } catch (error) {
            if (error instanceof MissingCommandError) throw new Error(`${error.message}. Its owner installs it (${spec.info.install}) and signs in with ${spec.info.signIn}.`);
            throw error;
          }
          return outcome(run);
        } finally {
          if (scratch) await rm(scratch, { recursive: true, force: true }).catch(() => {});
        }
      },
    });
  };
}
