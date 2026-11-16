import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkSudoPassword, sudoCommandText, sudoLimits, sudoPromptText } from "../../../packages/shared/src/sudo.js";
import { openSudoPassword, sudoSealKeys, type SealedSudoPassword } from "../../../packages/shared/src/sudo-seal.js";
import type { SudoPromptView } from "../../../packages/shared/src/types.js";

export interface SudoPromptsOptions {
  allowed: () => Promise<boolean>;
  changed: () => void;
  command?: () => string | undefined;
  waitMs?: number;
  node?: string;
  now?: () => number;
}

interface Pending {
  view: SudoPromptView;
  privateKey?: CryptoKey;
  settle: (password: string | undefined) => void;
}

const REQUEST_BYTES = 4096;
export const SUDO_PASSWORD_SHOWN = "[sudo password]";
const quote = (value: string) => `'${value.replace(/'/g, "'\\''")}'`;

function helperSource(socket: string, token: string): string {
  return [
    "\"use strict\";",
    "const net = require(\"node:net\");",
    `const connection = net.connect(${JSON.stringify(socket)});`,
    "let reply = \"\";",
    "connection.setEncoding(\"utf8\");",
    `connection.on("connect", () => connection.write(JSON.stringify({ token: ${JSON.stringify(token)}, prompt: process.argv[2] || "" }) + "\\n"));`,
    "connection.on(\"data\", chunk => { reply += chunk; if (reply.length > 8192) process.exit(1); });",
    "connection.on(\"end\", () => {",
    "  let password;",
    "  try { password = JSON.parse(reply).password; } catch { process.exit(1); }",
    "  if (typeof password !== \"string\") process.exit(1);",
    "  process.stdout.write(password + \"\\n\", () => process.exit(0));",
    "});",
    "connection.on(\"error\", () => process.exit(1));",
    "",
  ].join("\n");
}

export class SudoPrompts {
  readonly #options: SudoPromptsOptions;
  readonly #token = randomBytes(24).toString("base64url");
  #directory: string | undefined;
  #server: Server | undefined;
  #helper: string | undefined;
  #starting: Promise<string> | undefined;
  #closing: Promise<void> | undefined;
  readonly #pending: Pending[] = [];
  readonly #answered = new Set<string>();
  #commands = 0;
  #waitingSince: number | undefined;
  #waited: { from: number; to: number }[] = [];

  constructor(options: SudoPromptsOptions) {
    this.#options = options;
  }

  get helper(): string | undefined { return this.#helper; }

  async prepare(): Promise<void> {
    if (await this.#options.allowed().catch(() => false)) await this.start().catch(() => undefined);
    else if (this.#starting) await this.close();
  }

  start(): Promise<string> {
    if (this.#starting) return this.#starting;
    const starting = (async () => {
      await this.#closing;
      const directory = await mkdtemp(join(tmpdir(), "pikibun-sudo-"));
      this.#directory = directory;
      try {
        const socket = join(directory, "s");
        const server = createServer(connection => this.#connection(connection));
        await new Promise<void>((resolve, reject) => {
          server.once("error", reject);
          server.listen(socket, () => { server.off("error", reject); resolve(); });
        });
        this.#server = server;
        await writeFile(join(directory, "askpass.cjs"), helperSource(socket, this.#token), { mode: 0o600 });
        const helper = join(directory, "askpass");
        await writeFile(helper, `#!/bin/sh\nexec ${quote(this.#options.node ?? process.execPath)} ${quote(join(directory, "askpass.cjs"))} "$@"\n`, { mode: 0o700 });
        this.#helper = helper;
        return helper;
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

  view(): SudoPromptView | undefined {
    return this.#pending[0]?.view;
  }

  waiting(): boolean {
    return this.#pending.length > 0;
  }

  waitedSince(start: number): number {
    const now = this.#now();
    const spans = [...this.#waited, ...(this.#waitingSince !== undefined ? [{ from: this.#waitingSince, to: now }] : [])];
    return spans.reduce((total, span) => total + Math.max(0, Math.min(span.to, now) - Math.max(span.from, start)), 0);
  }

  async answerSealed(id: string, sealed: SealedSudoPassword): Promise<boolean> {
    const pending = this.#pending.find(item => item.view.id === id);
    if (!pending?.privateKey) return false;
    let opened: string;
    try { opened = await openSudoPassword(pending.privateKey, id, sealed); }
    catch { throw new Error("The sealed password couldn't be opened"); }
    return this.answer(id, checkSudoPassword(opened));
  }

  answer(id: string, password: string | undefined): boolean {
    const pending = this.#pending.find(item => item.view.id === id);
    if (!pending) return false;
    if (password && this.#commands > 0) this.#answered.add(password);
    pending.settle(password);
    return true;
  }

  track(): { redact(text: string, cut?: boolean): string; end(): void } {
    this.#commands++;
    let ended = false;
    return {
      redact: (text, cut = false) => {
        const passwords = [...this.#answered].sort((a, b) => b.length - a.length);
        let shown = passwords.reduce((result, password) => result.split(password).join(SUDO_PASSWORD_SHOWN), text);
        if (cut) {
          for (const password of passwords) {
            for (let length = password.length - 1; length > 0; length--) {
              if (!shown.endsWith(password.slice(0, length))) continue;
              shown = `${shown.slice(0, -length)}${SUDO_PASSWORD_SHOWN}`;
              break;
            }
          }
        }
        return shown;
      },
      end: () => {
        if (ended) return;
        ended = true;
        if (--this.#commands === 0) this.#answered.clear();
      },
    };
  }

  close(): Promise<void> {
    const starting = this.#starting;
    this.#starting = undefined;
    this.#helper = undefined;
    for (const pending of [...this.#pending]) pending.settle(undefined);
    if (this.#commands === 0) this.#answered.clear();
    const previous = this.#closing;
    const closing = (async () => {
      await previous;
      await starting?.catch(() => undefined);
      this.#helper = undefined;
      const server = this.#server;
      const directory = this.#directory;
      this.#server = undefined;
      this.#directory = undefined;
      if (server) await new Promise<void>(resolve => server.close(() => resolve()));
      if (directory) await rm(directory, { recursive: true, force: true }).catch(() => undefined);
    })();
    this.#closing = closing;
    return closing;
  }

  #now(): number {
    return (this.#options.now ?? Date.now)();
  }

  #connection(connection: Socket): void {
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
      let request: { token?: unknown; prompt?: unknown };
      try { request = JSON.parse(received.slice(0, end)) as typeof request; } catch { connection.destroy(); return; }
      if (!this.#authentic(request.token) || !this.#helper) { connection.end(JSON.stringify({ declined: true })); return; }
      void this.#ask(connection, sudoPromptText(request.prompt)).catch(() => connection.destroy());
    });
  }

  #authentic(token: unknown): boolean {
    if (typeof token !== "string") return false;
    const given = Buffer.from(token);
    const expected = Buffer.from(this.#token);
    return given.length === expected.length && timingSafeEqual(given, expected);
  }

  async #ask(connection: Socket, prompt: string): Promise<void> {
    const keys = await sudoSealKeys();
    if (connection.destroyed) return;
    const now = this.#now();
    const waitMs = this.#options.waitMs ?? sudoLimits.waitMs;
    const command = sudoCommandText(this.#options.command?.());
    const view: SudoPromptView = { id: randomUUID().replace(/-/g, ""), prompt, key: keys.publicKey, ...(command ? { command } : {}),
      requestedAt: new Date(now).toISOString(), expiresAt: new Date(now + waitMs).toISOString() };
    let settled = false;
    const timer = setTimeout(() => settle(undefined), waitMs);
    timer.unref?.();
    const settle = (password: string | undefined) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const index = this.#pending.indexOf(pending);
      if (index >= 0) this.#pending.splice(index, 1);
      if (!this.#pending.length && this.#waitingSince !== undefined) {
        this.#waited = [...this.#waited.slice(-1023), { from: this.#waitingSince, to: this.#now() }];
        this.#waitingSince = undefined;
      }
      if (!connection.destroyed) connection.end(JSON.stringify(password === undefined ? { declined: true } : { password }));
      this.#options.changed();
    };
    const pending: Pending = { view, settle, privateKey: keys.privateKey };
    connection.on("close", () => settle(undefined));
    if (!this.#pending.length) this.#waitingSince = now;
    this.#pending.push(pending);
    this.#options.changed();
  }
}
