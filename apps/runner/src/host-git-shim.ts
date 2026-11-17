import { randomBytes, timingSafeEqual } from "node:crypto";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { MirrorProgress } from "./egress.js";
import { RunnerError } from "./protocol.js";

// Sessions that run on the host (without the sandbox) clone with the host's own Git. Their commands find this session's
// `git` first on PATH: a POSIX shell launcher that runs the next git on PATH as it is, except for `git clone`, which it
// hands to a small Node program. That program asks the runner, over a private Unix socket with this session's token,
// for the host's mirror of the repository (filling it first if need be, as a sandboxed clone does through its proxy),
// and adds --reference-if-able with the mirror's own path, so the clone borrows the mirror's objects.

export interface HostGitShimOptions {
  /** The mirror's path on the host for a clone of this remote, or undefined where it isn't one of the workspace's repositories. */
  mirror(remote: string, onProgress: (progress: MirrorProgress) => void): Promise<string | undefined>;
  node?: string;
  heartbeatMs?: number;
}

const REQUEST_BYTES = 8192;
const HEARTBEAT_MS = 5_000;
const PROGRESS_MS = 1_000;
const quote = (value: string) => `'${value.replace(/'/g, "'\\''")}'`;

export const HOST_GIT_SHIM_VALUED: readonly string[] = Object.freeze(["-o", "--origin", "-b", "--branch", "-u", "--upload-pack", "--template", "-c", "--config",
  "--depth", "--shallow-since", "--shallow-exclude", "--separate-git-dir", "-j", "--jobs", "--filter", "--bundle-uri", "--server-option", "--ref-format",
  "--reference", "--reference-if-able", "--revision"]);

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
    "  if [ -f \"$dir/git\" ] && [ -x \"$dir/git\" ]; then real=$dir/git; break; fi",
    "done",
    "set +f",
    "IFS=$saved",
    "if [ -z \"$real\" ]; then echo 'git: command not found' >&2; exit 127; fi",
    "skip=",
    "for arg in \"$@\"; do",
    "  if [ -n \"$skip\" ]; then skip=; continue; fi",
    "  case $arg in",
    "    -C|-c) skip=1 ;;",
    "    -*) ;;",
    `    clone) PIKIBUN_HOST_GIT=$real; export PIKIBUN_HOST_GIT; exec ${quote(node)} ${quote(program)} "$@" ;;`,
    "    *) break ;;",
    "  esac",
    "done",
    "exec \"$real\" \"$@\"",
    "",
  ].join("\n");
}

export function hostGitProgram(socket: string, token: string): string {
  return [
    "\"use strict\";",
    "const net = require(\"node:net\");",
    "const fs = require(\"node:fs\");",
    "const path = require(\"node:path\");",
    "const { spawn } = require(\"node:child_process\");",
    "const { constants } = require(\"node:os\");",
    `const SOCKET = ${JSON.stringify(socket)};`,
    `const TOKEN = ${JSON.stringify(token)};`,
    `const VALUED = new Set(${JSON.stringify(HOST_GIT_SHIM_VALUED)});`,
    "const git = process.env.PIKIBUN_HOST_GIT;",
    "delete process.env.PIKIBUN_HOST_GIT;",
    "if (!git) { process.stderr.write(\"git: command not found\\n\"); process.exit(127); }",
    "const started = Date.now();",
    "let shown;",
    "",
    "function note(text) { try { process.stderr.write(\"pikibun: \" + text + \"\\n\"); } catch {} }",
    "",
    "function described(progress) {",
    "  let text = typeof progress.phase === \"string\" && /^[a-z]+$/i.test(progress.phase) ? progress.phase : \"filling\";",
    "  if (Number.isInteger(progress.percent)) text += \" \" + progress.percent + \"%\";",
    "  if (Number.isInteger(progress.bytes) && progress.bytes > 0) {",
    "    let size = progress.bytes, unit = \"bytes\";",
    "    for (const bigger of [\"KiB\", \"MiB\", \"GiB\"]) { if (size < 1024) break; size /= 1024; unit = bigger; }",
    "    text += \", \" + (unit === \"bytes\" ? progress.bytes + \" bytes\" : size.toFixed(1) + \" \" + unit) + \" received\";",
    "  }",
    "  return text;",
    "}",
    "",
    "function progressed(url, progress) {",
    "  const now = Date.now();",
    "  if (!progress || typeof progress !== \"object\" || now - started < 3000 || (shown !== undefined && now - shown < 30000)) return;",
    "  if (shown === undefined) note(\"waiting for the host to fill its repository cache of \" + url + \": it downloads the repository once,\"",
    "    + \" then every clone borrows from it, and it goes on if this command stops\");",
    "  note(\"repository cache: \" + described(progress));",
    "  shown = now;",
    "}",
    "",
    "function ask(url) {",
    "  return new Promise(resolve => {",
    "    let buffer = \"\", settled = false, moved = false;",
    "    const socket = net.connect(SOCKET);",
    "    const done = answer => { if (settled) return; settled = true; socket.destroy(); resolve(answer); };",
    "    socket.setEncoding(\"utf8\");",
    "    socket.setTimeout(120000, () => done({ kind: \"failed\", moved }));",
    "    socket.on(\"connect\", () => socket.write(JSON.stringify({ token: TOKEN, remote: url }) + \"\\n\"));",
    "    socket.on(\"data\", chunk => {",
    "      buffer += chunk;",
    "      if (buffer.length > 1048576) return done({ kind: \"failed\", moved });",
    "      for (let end = buffer.indexOf(\"\\n\"); end >= 0; end = buffer.indexOf(\"\\n\")) {",
    "        const line = buffer.slice(0, end);",
    "        buffer = buffer.slice(end + 1);",
    "        let answer;",
    "        try { answer = JSON.parse(line); } catch { continue; }",
    "        if (!answer || typeof answer !== \"object\") continue;",
    "        if (typeof answer.path === \"string\" && answer.path) return done({ kind: \"path\", path: answer.path });",
    "        if (answer.none === true) return done({ kind: \"none\" });",
    "        if (\"error\" in answer) return done({ kind: \"error\", reason: String(answer.error).slice(0, 300), retry: answer.retry === true, moved });",
    "        moved = true;",
    "        progressed(url, answer.progress);",
    "      }",
    "    });",
    "    socket.on(\"error\", () => done({ kind: \"failed\", moved }));",
    "    socket.on(\"close\", () => done({ kind: \"failed\", moved }));",
    "  });",
    "}",
    "",
    "async function mirror(url) {",
    "  let failures = 0;",
    "  for (;;) {",
    "    const answer = await ask(url);",
    "    if (answer.kind === \"path\") {",
    "      if (shown !== undefined) note(\"the repository cache is ready; cloning from it\");",
    "      return answer.path;",
    "    }",
    "    if (answer.kind === \"none\") return undefined;",
    "    let reason = \"it did not answer\", transient = false;",
    "    if (answer.kind === \"error\") {",
    "      reason = answer.reason;",
    "      if (!answer.retry) { note(\"the host cannot fill its repository cache (\" + reason + \"); cloning without it\"); return undefined; }",
    "      transient = true;",
    "    }",
    "    failures = transient || !answer.moved ? failures + 1 : 0;",
    "    if (failures >= 3) {",
    "      note(\"the repository cache of \" + url + \" is not available right now (\" + reason + \"); run the clone again\");",
    "      process.exit(128);",
    "    }",
    "    await new Promise(resolve => setTimeout(resolve, (failures || 1) * 1000));",
    "  }",
    "}",
    "",
    "async function main() {",
    "  let args = process.argv.slice(2);",
    "  let index = 0;",
    "  while (index < args.length && args[index].startsWith(\"-\")) index += args[index] === \"-C\" || args[index] === \"-c\" ? 2 : 1;",
    "  if (args[index] === \"clone\") {",
    "    const rest = args.slice(index + 1);",
    "    let url;",
    "    for (let position = 0; position < rest.length;) {",
    "      const argument = rest[position];",
    "      if (argument === \"--\") { url = rest[position + 1]; break; }",
    "      if (argument.startsWith(\"-\")) { position += VALUED.has(argument) ? 2 : 1; continue; }",
    "      url = argument;",
    "      break;",
    "    }",
    "    const borrowing = rest.some(argument => argument.startsWith(\"--reference\") || [\"-s\", \"--shared\", \"--dissociate\"].includes(argument));",
    "    const extra = [];",
    "    if (url && !borrowing) {",
    "      const found = await mirror(url);",
    "      if (found && fs.existsSync(path.join(found, \"objects\"))) extra.push(\"--reference-if-able\", found);",
    "    }",
    "    args = [...args.slice(0, index + 1), ...extra, ...rest];",
    "  }",
    "  const child = spawn(git, args, { stdio: \"inherit\" });",
    "  const forward = signal => () => { try { child.kill(signal); } catch {} };",
    "  for (const signal of [\"SIGINT\", \"SIGTERM\", \"SIGHUP\"]) process.on(signal, forward(signal));",
    "  child.on(\"error\", () => { process.stderr.write(\"git: could not be started\\n\"); process.exit(127); });",
    "  child.on(\"exit\", (code, signal) => {",
    "    if (signal) { process.removeAllListeners(signal); try { process.kill(process.pid, signal); } catch {} }",
    "    process.exit(code === null ? 128 + (constants.signals[signal] || 0) : code);",
    "  });",
    "}",
    "",
    "main().catch(() => process.exit(128));",
    "",
  ].join("\n");
}

export class HostGitShim {
  readonly #options: HostGitShimOptions;
  readonly #token = randomBytes(24).toString("base64url");
  #directory: string | undefined;
  #server: Server | undefined;
  #starting: Promise<string> | undefined;
  #closing: Promise<void> | undefined;
  readonly #connections = new Set<Socket>();

  constructor(options: HostGitShimOptions) {
    if (process.platform === "win32") throw new Error("The host's git shim needs a POSIX shell");
    this.#options = options;
  }

  /** The directory to put first on commands' PATH, with this session's git in it. */
  start(): Promise<string> {
    if (this.#starting) return this.#starting;
    const starting = (async () => {
      await this.#closing;
      const directory = await mkdtemp(join(tmpdir(), "pikibun-git-"));
      this.#directory = directory;
      try {
        await chmod(directory, 0o700);
        const socket = join(directory, "s");
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
      let request: { token?: unknown; remote?: unknown };
      try { request = JSON.parse(received.slice(0, end)) as typeof request; } catch { connection.destroy(); return; }
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
      send(path ? { path } : { none: true });
    } catch (error) {
      const reason = error instanceof Error && /^[\x20-\x7e]{1,300}$/.test(error.message) ? error.message : "The repository could not be cached";
      send({ error: reason, ...(error instanceof RunnerError && error.status === 503 ? { retry: true } : {}) });
    } finally {
      clearInterval(heartbeat);
      if (!connection.destroyed) connection.end();
    }
  }

  #authentic(token: unknown): boolean {
    if (typeof token !== "string") return false;
    const given = Buffer.from(token);
    const expected = Buffer.from(this.#token);
    return given.length === expected.length && timingSafeEqual(given, expected);
  }
}
