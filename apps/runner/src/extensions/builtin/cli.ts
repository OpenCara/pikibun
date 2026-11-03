import { spawn } from "node:child_process";
import { mkdtemp, realpath, rm, stat } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import { Type } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionFactory } from "@earendil-works/pi-coding-agent";
import type { BuiltinExtensionInfo } from "../../../../../packages/shared/src/builtin-extensions.js";
import { killTree, windows, windowsSystemEnvironment } from "../../platform.js";

/*
 * A command-line tool as a Pi extension (docs/design/builtin-extensions.md): one tool that runs the command on the host
 * with the arguments the model gives, without a shell, as the connector's OS user and with its sign-in to that command.
 * Arguments that would show the command's credentials never run. With the workspace's `read-only` setting, only
 * commands that read run, and outside the session's worktree, so that what a session wrote there (a repository's Git
 * configuration, say) can't make the command run code.
 */

/** What one command-line tool needs. */
export interface CliSpec {
  info: BuiltinExtensionInfo;
  /** The executable; on Windows `windowsCommand` (a `.cmd` shim runs through cmd.exe, with plain arguments only). */
  command: string;
  windowsCommand?: { file: string; shim: boolean };
  /** The tool's description, for the model. */
  description: string;
  /** Environment variables of the connector it gets, besides the common ones: its own sign-in and configuration. */
  passEnv: (name: string) => boolean;
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
    const query = fields.find(field => field.startsWith("query="));
    if (!query) return "api graphql needs its query as -f query=...";
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

/** The Pi extension for `spec`: its tool, and its `read-only` setting. */
export function cliExtension(spec: CliSpec): ExtensionFactory {
  return (pi: ExtensionAPI) => {
    pi.registerFlag(READ_ONLY, { type: "boolean", default: false,
      description: `Run only ${spec.command} commands that read (lists, views, logs, GET requests), outside the session's worktree. Set it before running the tool automatically.` });
    pi.registerTool({
      name: spec.info.tool, label: spec.info.title, description: spec.description,
      parameters: Type.Object({
        args: Type.Array(Type.String({ maxLength: 32 * 1024 }), { minItems: 1, maxItems: 256,
          description: `The arguments after ${spec.command}, one per item, exactly as they are passed: there is no shell, so don't quote them.` }),
        directory: Type.Optional(Type.String({ maxLength: 4096,
          description: "Where it runs: a directory in the session's worktree, such as a clone (app). The worktree by default." })),
        timeout_seconds: Type.Optional(Type.Integer({ minimum: 1, maximum: 3600, description: `At most this long (${DEFAULT_TIMEOUT_SECONDS} seconds by default).` })),
      }),
      async execute(_toolCallId, params, signal, _onUpdate, ctx) {
        const args = params.args;
        if (args.some(arg => arg.includes("\0"))) throw new Error("An argument holds a NUL character.");
        const refused = spec.refused(args);
        if (refused) throw new Error(`Refused: ${refused}. Nothing ran.`);
        const readOnly = pi.getFlag(READ_ONLY) === true;
        if (readOnly) {
          const writes = spec.writes(args);
          if (writes) throw new Error(`Refused: this workspace runs ${spec.command} read-only, and ${writes}. Nothing ran.`);
          if (params.directory !== undefined) throw new Error(`Refused: this workspace runs ${spec.command} read-only, outside the session's worktree; leave out directory. Nothing ran.`);
        }
        const scratch = readOnly ? await mkdtemp(join(tmpdir(), `pikibun-${spec.info.name}-`)) : undefined;
        try {
          const cwd = scratch ?? (params.directory !== undefined ? await worktreeDirectory(ctx.cwd, params.directory) : ctx.cwd);
          let run: CliRun;
          try {
            run = await runCli(spec, args, { cwd, signal: signal ?? new AbortController().signal, timeoutSeconds: params.timeout_seconds ?? DEFAULT_TIMEOUT_SECONDS });
          } catch (error) {
            if (error instanceof MissingCommandError) throw new Error(`${error.message}. Its owner installs it (${spec.info.install}) and signs in with ${spec.info.signIn}.`);
            throw error;
          }
          const status = run.failure ?? (run.exitCode === 0 ? undefined : run.signal ? `It ended with ${run.signal}` : `It exited with ${run.exitCode}`);
          const text = run.output.trim() || "(no output)";
          if (status) throw new Error(`${status}.\n${text}`);
          return { content: [{ type: "text", text }], details: { exitCode: 0 } };
        } finally {
          if (scratch) await rm(scratch, { recursive: true, force: true }).catch(() => {});
        }
      },
    });
  };
}
