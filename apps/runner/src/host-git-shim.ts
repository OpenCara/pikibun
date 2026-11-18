import { randomBytes, timingSafeEqual } from "node:crypto";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { delimiter, dirname, isAbsolute, join } from "node:path";
import type { MirrorProgress } from "./egress.js";
import type { LfsObjectCache } from "./lfs-cache.js";
import { RunnerError } from "./protocol.js";

export interface HostGitShimOptions {
  mirror(remote: string, onProgress: (progress: MirrorProgress) => void): Promise<string | undefined>;
  lfs?: Pick<LfsObjectCache, "reference" | "share">;
  node?: string;
  heartbeatMs?: number;
}

export type GitShimTransport = { socket: string; token: string } | { proxy: true };

const REQUEST_BYTES = 8192;
const HEARTBEAT_MS = 5_000;
const PROGRESS_MS = 1_000;
const quote = (value: string) => `'${value.replace(/'/g, "'\\''")}'`;
export const GIT_SHIM_MAX_DEPTH = 8;

export const HOST_GIT_SHIM_VALUED: readonly string[] = Object.freeze(["-o", "--origin", "-b", "--branch", "-u", "--upload-pack", "--template", "-c", "--config",
  "--depth", "--shallow-since", "--shallow-exclude", "--separate-git-dir", "-j", "--jobs", "--filter", "--bundle-uri", "--server-option", "--ref-format",
  "--reference", "--reference-if-able", "--revision"]);

const CLONE_ONLY = (exec: string) => [
  "skip=",
  "for arg in \"$@\"; do",
  "  if [ -n \"$skip\" ]; then skip=; continue; fi",
  "  case $arg in",
  "    -C|-c) skip=1 ;;",
  "    -*) ;;",
  `    clone) ${exec} ;;`,
  "    *) break ;;",
  "  esac",
  "done",
];

export function hostGitLauncher(bin: string, node: string, program: string): string {
  return [
    "#!/bin/sh",
    "# Pikibun: this session's git. git clone of a workspace repository borrows the host's repository cache; everything else runs git as it is.",
    `here=${quote(bin)}`,
    "real=",
    "saved=$IFS",
    "IFS=:",
    "set -f",
    "for dir in $PATH; do",
    "  [ -n \"$dir\" ] || dir=.",
    "  [ \"$dir\" = \"$here\" ] && continue",
    "  [ \"$dir/git\" -ef \"$here/git\" ] 2>/dev/null && continue",
    "  [ -f \"$dir/../git-clone.cjs\" ] && continue",
    "  [ -f \"$dir/git-shim.cjs\" ] && continue",
    "  if [ -f \"$dir/git\" ] && [ -x \"$dir/git\" ]; then real=$dir/git; break; fi",
    "done",
    "set +f",
    "IFS=$saved",
    "if [ -z \"$real\" ]; then echo 'git: command not found' >&2; exit 127; fi",
    "if command -v cygpath >/dev/null 2>&1; then real=$(cygpath -w \"$real\"); fi",
    ...CLONE_ONLY(`node=${quote(node)}; [ -x "$node" ] || node=$(command -v node 2>/dev/null) || node=; `
      + `if [ -n "$node" ]; then PIKIBUN_HOST_GIT=$real; export PIKIBUN_HOST_GIT; exec "$node" ${quote(program)} "$@"; fi; `
      + `echo 'pikibun: Node.js, which borrows the host repository cache, is not on this host any more; cloning without the cache' >&2; exec "$real" "$@"`),
    "exec \"$real\" \"$@\"",
    "",
  ].join("\n");
}

export function sandboxGitLauncher(node: string, program: string): string {
  const path = (value: string) => {
    if (/["$`\\\x00-\x1f]/.test(value.replaceAll("\\", "/"))) throw new Error("Invalid path for the sandbox's git");
    return `"${value.replaceAll("\\", "/")}"`;
  };
  return [
    "#!/bin/sh",
    ...CLONE_ONLY(`exec ${path(node)} ${path(program)} "$@"`),
    "exec \"$SANDBOX_GIT\" \"$@\"",
    "",
  ].join("\n");
}

export function gitShimProgram(transport: GitShimTransport): string {
  return String.raw`"use strict";
const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { constants } = require("node:os");
const TRANSPORT = ${JSON.stringify(transport)};
const VALUED = new Set(${JSON.stringify(HOST_GIT_SHIM_VALUED)});
let git = process.env.PIKIBUN_HOST_GIT || process.env.SANDBOX_GIT;
delete process.env.PIKIBUN_HOST_GIT;
if (!git) { process.stderr.write("git: command not found\n"); process.exit(127); }
const depth = Number.parseInt(process.env.PIKIBUN_GIT_SHIM_DEPTH || "0", 10) || 0;
if (depth >= ${GIT_SHIM_MAX_DEPTH}) {
  process.stderr.write("pikibun: git's wrapper is running inside itself " + depth + " times over: another git wrapper on PATH leads back to it\n");
  process.exit(127);
}
process.env.PIKIBUN_GIT_SHIM_DEPTH = String(depth + 1);
if (process.platform === "win32" && !path.extname(git) && fs.existsSync(git + ".exe")) git += ".exe";
const started = Date.now();
let shown;

function note(text) { try { process.stderr.write("pikibun: " + text + "\n"); } catch {} }

function described(progress) {
  let text = typeof progress.phase === "string" && /^[a-z]+$/i.test(progress.phase) ? progress.phase : "filling";
  if (Number.isInteger(progress.percent)) text += " " + progress.percent + "%";
  if (Number.isInteger(progress.bytes) && progress.bytes > 0) {
    let size = progress.bytes, unit = "bytes";
    for (const bigger of ["KiB", "MiB", "GiB"]) { if (size < 1024) break; size /= 1024; unit = bigger; }
    text += ", " + (unit === "bytes" ? progress.bytes + " bytes" : size.toFixed(1) + " " + unit) + " received";
  }
  return text;
}

function progressed(url, progress) {
  const now = Date.now();
  if (!progress || typeof progress !== "object" || now - started < 3000 || (shown !== undefined && now - shown < 30000)) return;
  if (shown === undefined) note("waiting for the host to fill its repository cache of " + url + ": it downloads the repository once,"
    + " then every clone borrows from it, and it goes on if this command stops");
  note("repository cache: " + described(progress));
  shown = now;
}

function answerOf(line, url, state) {
  let answer;
  try { answer = JSON.parse(line); } catch { return undefined; }
  if (!answer || typeof answer !== "object") return undefined;
  if (typeof answer.path === "string" && answer.path) return { kind: "path", path: answer.path, lfs: typeof answer.lfs === "string" && answer.lfs ? answer.lfs : undefined };
  if (answer.none === true) return { kind: "none" };
  if ("error" in answer) return { kind: "error", reason: String(answer.error).slice(0, 300), retry: answer.retry === true, moved: state.moved };
  state.moved = true;
  progressed(url, answer.progress);
  return undefined;
}

function proxyEndpoint() {
  let status = null;
  try { status = new URL(process.env.PIKIBUN_EGRESS_STATUS || ""); } catch {}
  if (!status || status.protocol !== "http:" || status.hostname !== "127.0.0.1" || !status.port) return { port: 41080, headers: {} };
  const credentials = decodeURIComponent(status.username) + ":" + decodeURIComponent(status.password);
  return { port: Number(status.port), headers: status.username ? { authorization: "Basic " + Buffer.from(credentials).toString("base64") } : {} };
}

function ask(url) {
  return new Promise(resolve => {
    const state = { moved: false };
    let buffer = "", settled = false, stream;
    const done = answer => { if (settled) return; settled = true; if (stream) stream.destroy(); resolve(answer); };
    const failed = () => done({ kind: "failed", moved: state.moved });
    const take = chunk => {
      buffer += chunk;
      if (buffer.length > 1048576) return failed();
      for (let end = buffer.indexOf("\n"); end >= 0 && !settled; end = buffer.indexOf("\n")) {
        const answer = answerOf(buffer.slice(0, end), url, state);
        buffer = buffer.slice(end + 1);
        if (answer) done(answer);
      }
    };
    if (TRANSPORT.socket) {
      stream = require("node:net").connect(TRANSPORT.socket);
      stream.setEncoding("utf8");
      stream.setTimeout(120000, failed);
      stream.on("connect", () => stream.write(JSON.stringify({ token: TRANSPORT.token, remote: url }) + "\n"));
      stream.on("data", take);
      stream.on("error", failed);
      stream.on("close", failed);
      return;
    }
    const { port, headers } = proxyEndpoint();
    stream = require("node:http").get({ host: "127.0.0.1", port, path: "/__pikibun/mirror?remote=" + encodeURIComponent(url), headers, agent: false }, response => {
      if (response.statusCode !== 200) { response.resume(); return done({ kind: "none" }); }
      response.setEncoding("utf8");
      response.on("data", take);
      response.on("error", failed);
      response.on("end", failed);
    });
    stream.setTimeout(120000, failed);
    stream.on("error", failed);
  });
}

async function mirror(url) {
  let failures = 0;
  for (;;) {
    const answer = await ask(url);
    if (answer.kind === "path") {
      if (shown !== undefined) note("the repository cache is ready; cloning from it");
      return answer;
    }
    if (answer.kind === "none") return undefined;
    let reason = "it did not answer", transient = false;
    if (answer.kind === "error") {
      reason = answer.reason;
      if (!answer.retry) { note("the host cannot fill its repository cache (" + reason + "); cloning without it"); return undefined; }
      transient = true;
    }
    failures = transient || !answer.moved ? failures + 1 : 0;
    if (failures >= 3) {
      note("the repository cache of " + url + " is not available right now (" + reason + "); run the clone again");
      process.exit(128);
    }
    await new Promise(resolve => setTimeout(resolve, (failures || 1) * 1000));
  }
}

function readable(found) {
  try { fs.readdirSync(path.join(found, "objects")); return true; } catch { return false; }
}

function humanish(url) {
  let end = url.replace(/[\\/\s]+$/, "");
  if (end.endsWith("/.git")) end = end.slice(0, -5).replace(/[\\/\s]+$/, "");
  const start = Math.max(end.lastIndexOf("/"), end.lastIndexOf(":"), end.lastIndexOf("\\")) + 1;
  return end.slice(start).replace(/\.(git|bundle)$/, "");
}

function cloneDirectory(args, index) {
  let base = process.cwd();
  for (let position = 0; position < index; position++) {
    if (args[position] === "-C") base = path.resolve(base, args[++position] || ".");
    else if (args[position] === "-c") position++;
  }
  const rest = args.slice(index + 1), positionals = [];
  for (let position = 0; position < rest.length; position++) {
    const argument = rest[position];
    if (argument === "--") { positionals.push(...rest.slice(position + 1)); break; }
    if (argument.startsWith("-")) { if (VALUED.has(argument)) position++; continue; }
    positionals.push(argument);
  }
  const directory = positionals[1] || (positionals[0] && humanish(positionals[0]));
  return directory ? path.resolve(base, directory) : undefined;
}

function shareClone(gitDirectory) {
  return new Promise(resolve => {
    const stream = require("node:net").connect(TRANSPORT.socket);
    const done = () => { stream.destroy(); resolve(); };
    stream.setTimeout(10000, done);
    stream.on("connect", () => stream.write(JSON.stringify({ token: TRANSPORT.token, share: gitDirectory }) + "\n"));
    stream.on("data", done);
    stream.on("error", done);
    stream.on("close", done);
  });
}

async function borrowLfs(directory, store) {
  if (!directory) return;
  const found = require("node:child_process").spawnSync(git, ["-C", directory, "rev-parse", "--absolute-git-dir"], { encoding: "utf8", windowsHide: true });
  const gitDirectory = found.status === 0 ? found.stdout.trim() : "";
  if (!gitDirectory) return;
  const file = path.join(gitDirectory, "objects", "info", "alternates");
  let text;
  try { text = fs.readFileSync(file, "utf8"); } catch { return; }
  if (!text.split(/\r?\n/).includes(store)) fs.appendFileSync(file, (text && !text.endsWith("\n") ? "\n" : "") + store + "\n");
  await shareClone(gitDirectory);
}

async function main() {
  let args = process.argv.slice(2);
  let lfs, target;
  let index = 0;
  while (index < args.length && args[index].startsWith("-")) index += args[index] === "-C" || args[index] === "-c" ? 2 : 1;
  if (args[index] === "clone") {
    const rest = args.slice(index + 1);
    let url;
    for (let position = 0; position < rest.length;) {
      const argument = rest[position];
      if (argument === "--") { url = rest[position + 1]; break; }
      if (argument.startsWith("-")) { position += VALUED.has(argument) ? 2 : 1; continue; }
      url = argument;
      break;
    }
    const borrowing = rest.some(argument => argument.startsWith("--reference") || ["-s", "--shared", "--dissociate"].includes(argument));
    const extra = [];
    if (url && !borrowing) {
      const found = await mirror(url);
      if (found && readable(found.path)) {
        extra.push("--reference-if-able", found.path);
        if (TRANSPORT.socket && found.lfs && fs.existsSync(path.join(found.lfs, "objects"))) {
          lfs = fs.realpathSync(found.lfs);
          target = cloneDirectory(args, index);
          const alternates = process.env.GIT_ALTERNATE_OBJECT_DIRECTORIES;
          process.env.GIT_ALTERNATE_OBJECT_DIRECTORIES = alternates ? alternates + path.delimiter + lfs : lfs;
        }
      }
      else if (found && TRANSPORT.socket) note("the host's repository cache of " + url + " has no objects to borrow; cloning without it");
      else if (found) {
        note("the repository cache of " + url + " is ready, but this command started before it could see it; run the clone again");
        process.exit(128);
      }
    }
    args = [...args.slice(0, index + 1), ...extra, ...rest];
  }
  const child = spawn(git, args, { stdio: "inherit", windowsHide: true });
  const forward = signal => () => { try { child.kill(signal); } catch {} };
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) process.on(signal, forward(signal));
  child.on("error", () => { process.stderr.write("git: could not be started\n"); process.exit(127); });
  child.on("exit", (code, signal) => {
    if (signal) { process.removeAllListeners(signal); try { process.kill(process.pid, signal); } catch {} }
    const finish = () => process.exit(code === null ? 128 + (constants.signals[signal] || 0) : code);
    if (code === 0 && lfs) borrowLfs(target, lfs).then(finish, finish);
    else finish();
  });
}

main().catch(() => process.exit(128));
`;
}

export function hostGitProgram(socket: string, token: string): string {
  return gitShimProgram({ socket, token });
}

const PIKIBUN_PATH_SCRIPT = /pikibun-git-[^/\\]+[/\\]path\.sh$/;

export function hostGitEnvironment(bin: string, environment: Readonly<Record<string, string | undefined>>, windows = process.platform === "win32"): Record<string, string> {
  const key = Object.keys(environment).find(name => name.toUpperCase() === "PATH") ?? "PATH";
  const path = environment[key] || (windows ? "" : "/usr/bin:/bin:/usr/sbin:/sbin");
  const named = (wanted: string) => Object.entries(environment).find(([name]) => name.toUpperCase() === wanted);
  const own = (value: string | undefined) => value && !PIKIBUN_PATH_SCRIPT.test(value) ? value : undefined;
  const inherited = named("PIKIBUN_BASH_ENV");
  const owner = own(inherited?.[1]) ?? own(named("BASH_ENV")?.[1]);
  const ownerKey = inherited?.[0] ?? "PIKIBUN_BASH_ENV";
  return { [key]: path ? `${bin}${windows ? ";" : delimiter}${path}` : bin,
    ...(windows ? { BASH_ENV: join(dirname(bin), "path.sh"), ...(owner ? { [ownerKey]: owner } : inherited ? { [ownerKey]: "" } : {}) } : {}) };
}

export function hostGitBashScript(bin: string): string {
  return `if command -v cygpath >/dev/null 2>&1; then PATH="$(cygpath -u ${quote(bin)}):$PATH"; export PATH; fi\n`
    + "if [ -n \"$PIKIBUN_BASH_ENV\" ]; then . \"$PIKIBUN_BASH_ENV\"; fi\n";
}

export class HostGitShim {
  readonly #options: HostGitShimOptions;
  readonly #token = randomBytes(24).toString("base64url");
  #directory: string | undefined;
  #server: Server | undefined;
  #starting: Promise<string> | undefined;
  #closing: Promise<void> | undefined;
  readonly #connections = new Set<Socket>();
  #sharing: Promise<void> = Promise.resolve();

  constructor(options: HostGitShimOptions) {
    this.#options = options;
  }

  shared(): Promise<void> {
    return this.#sharing;
  }

  start(): Promise<string> {
    if (this.#starting) return this.#starting;
    const starting = (async () => {
      await this.#closing;
      const directory = await mkdtemp(join(tmpdir(), "pikibun-git-"));
      this.#directory = directory;
      try {
        await chmod(directory, 0o700);
        const socket = process.platform === "win32" ? `\\\\.\\pipe\\pikibun-git-${randomBytes(16).toString("hex")}` : join(directory, "s");
        const server = createServer(connection => this.#connection(connection));
        await new Promise<void>((resolve, reject) => {
          server.once("error", reject);
          server.listen(socket, () => { server.off("error", reject); resolve(); });
        });
        server.unref();
        this.#server = server;
        const program = join(directory, "git-clone.cjs");
        await writeFile(program, hostGitProgram(socket, this.#token), { mode: 0o600 });
        const bin = join(directory, "bin");
        await mkdir(bin, { mode: 0o700 });
        await writeFile(join(bin, "git"), hostGitLauncher(bin, this.#options.node ?? process.execPath, program), { mode: 0o700 });
        await writeFile(join(directory, "path.sh"), hostGitBashScript(bin), { mode: 0o600 });
        return bin;
      } catch (error) {
        const server = this.#server;
        this.#server = undefined;
        this.#directory = undefined;
        if (server) await new Promise<void>(resolve => server.close(() => resolve()));
        await rm(directory, { recursive: true, force: true }).catch(() => undefined);
        throw error;
      }
    })();
    this.#starting = starting;
    starting.catch(() => { if (this.#starting === starting) this.#starting = undefined; });
    return starting;
  }

  close(): Promise<void> {
    const starting = this.#starting;
    this.#starting = undefined;
    const previous = this.#closing;
    const closing = (async () => {
      await previous;
      await starting?.catch(() => undefined);
      const server = this.#server;
      const directory = this.#directory;
      this.#server = undefined;
      this.#directory = undefined;
      for (const connection of this.#connections) connection.destroy();
      if (server) await new Promise<void>(resolve => server.close(() => resolve()));
      if (directory) await rm(directory, { recursive: true, force: true }).catch(() => undefined);
    })();
    this.#closing = closing;
    return closing;
  }

  #connection(connection: Socket): void {
    this.#connections.add(connection);
    connection.once("close", () => this.#connections.delete(connection));
    let received = "";
    let asked = false;
    connection.setEncoding("utf8");
    connection.on("error", () => connection.destroy());
    connection.on("data", (chunk: string) => {
      if (asked) return;
      received += chunk;
      if (received.length > REQUEST_BYTES) { connection.destroy(); return; }
      const end = received.indexOf("\n");
      if (end < 0) return;
      asked = true;
      let request: { token?: unknown; remote?: unknown; share?: unknown };
      try { request = JSON.parse(received.slice(0, end)) as typeof request; } catch { connection.destroy(); return; }
      if (this.#authentic(request.token) && typeof request.share === "string") {
        this.#share(connection, request.share);
        return;
      }
      if (!this.#authentic(request.token) || typeof request.remote !== "string" || !request.remote || request.remote.length > 2048) {
        connection.destroy();
        return;
      }
      void this.#answer(connection, request.remote);
    });
  }

  async #answer(connection: Socket, remote: string): Promise<void> {
    const send = (line: object) => { if (!connection.destroyed && connection.writable) connection.write(`${JSON.stringify(line)}\n`); };
    let last: MirrorProgress = { phase: "waiting", percent: null, done: null, total: null, bytes: 0 };
    let sent = 0;
    const progress = (value: MirrorProgress) => {
      const changed = value.phase !== last.phase;
      last = { phase: value.phase, percent: value.percent, done: value.done, total: value.total, bytes: value.bytes };
      if (changed || Date.now() - sent >= PROGRESS_MS) { sent = Date.now(); send({ progress: last }); }
    };
    const heartbeat = setInterval(() => { sent = Date.now(); send({ progress: last }); }, this.#options.heartbeatMs ?? HEARTBEAT_MS);
    try {
      const path = await this.#options.mirror(remote, progress);
      const lfs = path ? await this.#options.lfs?.reference().catch(() => undefined) : undefined;
      send(path ? { path, ...(lfs ? { lfs } : {}) } : { none: true });
    } catch (error) {
      const reason = error instanceof Error && /^[\x20-\x7e]{1,300}$/.test(error.message) ? error.message : "The repository could not be cached";
      send({ error: reason, ...(error instanceof RunnerError && error.status === 503 ? { retry: true } : {}) });
    } finally {
      clearInterval(heartbeat);
      if (!connection.destroyed) connection.end();
    }
  }

  #share(connection: Socket, gitDirectory: string): void {
    const lfs = this.#options.lfs;
    const accepted = lfs !== undefined && gitDirectory.length <= 4096 && isAbsolute(gitDirectory) && !gitDirectory.includes("\0");
    if (!connection.destroyed && connection.writable) connection.end(`${JSON.stringify({ accepted })}\n`);
    if (!accepted) return;
    this.#sharing = this.#sharing.then(() => lfs.share(gitDirectory)).then(() => undefined, () => undefined);
  }

  #authentic(token: unknown): boolean {
    if (typeof token !== "string") return false;
    const given = Buffer.from(token);
    const expected = Buffer.from(this.#token);
    return given.length === expected.length && timingSafeEqual(given, expected);
  }
}
