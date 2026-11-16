import { createCipheriv, createDecipheriv, randomBytes, scrypt as scryptCallback } from "node:crypto";
import { constants } from "node:fs";
import { chmod, link, lstat, mkdir, open, readdir, readFile, realpath, rename, rm, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { promisify } from "node:util";
import {
  base64url, fromBase64url, IDENTITY_KEY, parseSettings, parseSigned, publicKeyOf, signStatement, verifyStatement,
  type DelegationStatement, type PortableSettings, type RotationStatement, type SessionMarkStatement, type SettingsStatement, type Signed,
} from "../../../packages/shared/src/identity.js";
import { assertId, RunnerError } from "./protocol.js";

const scrypt = promisify(scryptCallback) as (password: string, salt: Buffer, length: number, options: { N: number; r: number; p: number; maxmem: number }) => Promise<Buffer>;
const KEY_FILE = "key.json";
const SETTINGS_FILE = "settings.json";
const EXPORT_FORMAT = "pikibun-identity-export-v1";
const SCRYPT = { N: 2 ** 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
const MAX_ROTATIONS = 32;

export const defaultIdentityDir = (): string => join(homedir(), ".local", "share", "pikibun", "identity");

export function identityDirectory(given?: string): string {
  const value = given ?? process.env.PIKIBUN_IDENTITY_DIR ?? defaultIdentityDir();
  return resolve(value.startsWith("~/") ? join(homedir(), value.slice(2)) : value);
}

interface KeyFile { version: 1; publicKey: string; privateKey: string; createdAt: string; rotations: Signed<RotationStatement>[] }

export interface PortableEntry { sessionId: string; directory: string; mark: Signed<SessionMarkStatement> }

export interface IdentityKey { publicKey: string; privateKey: CryptoKey; createdAt: string; rotations: Signed<RotationStatement>[] }

export class IdentityBusy extends RunnerError {
  constructor(message: string) { super(409, message); }
}

function now(): string { return new Date().toISOString(); }

async function writePrivate(path: string, content: string, mode: "create" | "replace"): Promise<boolean> {
  const temporary = `${path}.${randomBytes(8).toString("hex")}.tmp`;
  const handle = await open(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
  try {
    await handle.writeFile(content);
    await handle.sync();
  } finally { await handle.close(); }
  try {
    if (mode === "replace") { await rename(temporary, path); return true; }
    try { await link(temporary, path); return true; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "EEXIST") return false; throw error; }
  } finally {
    if (mode === "create") await unlink(temporary).catch(() => {});
  }
}

export const STALE_LOCK_MS = 60_000;

export async function olderThan(path: string, ms: number): Promise<boolean> {
  return lstat(path).then(stat => Date.now() - stat.mtimeMs > ms, () => true);
}

export async function createFilled(path: string, content: string): Promise<boolean> {
  return writePrivate(path, content, "create");
}

async function readJson(path: string): Promise<unknown> {
  const stat = await lstat(path);
  if (!stat.isFile()) throw new Error(`${path} is not a regular file`);
  return JSON.parse(await readFile(path, "utf8"));
}

function processAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code === "EPERM"; }
}

function parseKeyFile(value: unknown): KeyFile {
  const input = value as KeyFile;
  if (!input || input.version !== 1 || typeof input.publicKey !== "string" || !IDENTITY_KEY.test(input.publicKey)
    || typeof input.privateKey !== "string" || typeof input.createdAt !== "string" || !Array.isArray(input.rotations)
    || input.rotations.length > MAX_ROTATIONS) throw new Error("Invalid identity key file");
  return { version: 1, publicKey: input.publicKey, privateKey: input.privateKey, createdAt: input.createdAt,
    rotations: input.rotations.map(rotation => parseSigned(rotation, "rotation")) };
}

async function importPrivate(file: KeyFile): Promise<CryptoKey> {
  const key = await crypto.subtle.importKey("pkcs8", fromBase64url(file.privateKey), { name: "Ed25519" }, true, ["sign"]);
  const jwk = await crypto.subtle.exportKey("jwk", key);
  if (jwk.x !== file.publicKey) throw new Error("The identity's private key doesn't match its public key");
  return key;
}

async function generate(rotations: Signed<RotationStatement>[] = []): Promise<{ file: KeyFile; privateKey: CryptoKey }> {
  const pair = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]) as unknown as CryptoKeyPair;
  const file: KeyFile = { version: 1, publicKey: await publicKeyOf(pair.publicKey), createdAt: now(), rotations,
    privateKey: base64url(new Uint8Array(await crypto.subtle.exportKey("pkcs8", pair.privateKey))) };
  return { file, privateKey: pair.privateKey };
}

export class IdentityStore {
  #key?: Promise<IdentityKey>;
  readonly #held = new Set<string>();

  constructor(readonly root: string) {
    if (!isAbsolute(root)) throw new Error("The identity directory must be an absolute path");
  }

  private async directory(...parts: string[]): Promise<string> {
    const path = join(this.root, ...parts);
    await mkdir(path, { recursive: true, mode: 0o700 });
    const stat = await lstat(path);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`${path} must be a directory`);
    if (process.platform !== "win32") await chmod(path, 0o700);
    return path;
  }

  key(): Promise<IdentityKey> {
    this.#key ??= this.loadKey().catch(error => { this.#key = undefined; throw error; });
    return this.#key;
  }

  private async loadKey(): Promise<IdentityKey> {
    const root = await this.directory();
    const path = join(root, KEY_FILE);
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const file = parseKeyFile(await readJson(path));
        return { publicKey: file.publicKey, privateKey: await importPrivate(file), createdAt: file.createdAt, rotations: file.rotations };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      const { file, privateKey } = await generate();
      if (await writePrivate(path, JSON.stringify(file), "create")) return { publicKey: file.publicKey, privateKey, createdAt: file.createdAt, rotations: [] };
    }
    throw new Error("The identity key could not be created");
  }

  async publicKey(): Promise<string> { return (await this.key()).publicKey; }

  private async existingKey(): Promise<KeyFile | undefined> {
    try { return parseKeyFile(await readJson(join(this.root, KEY_FILE))); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
  }

  async delegation(server: string, connector: string): Promise<Signed<DelegationStatement>> {
    assertId(connector);
    const key = await this.key();
    const directory = await this.directory("delegations");
    const path = join(directory, `${connector}.json`);
    try {
      const saved = parseSigned(await readJson(path), "delegation");
      if (saved.statement.key === key.publicKey && saved.statement.server === server && saved.statement.connector === connector && await verifyStatement(saved)) return saved;
    } catch { }
    const signed = await signStatement(key.privateKey, { kind: "delegation", key: key.publicKey, server, connector, issuedAt: now() });
    await writePrivate(path, JSON.stringify(signed), "replace");
    return signed;
  }

  async mark(sessionId: string, sessionDirectory: string): Promise<PortableEntry> {
    assertId(sessionId);
    if (!isAbsolute(sessionDirectory) || await realpath(sessionDirectory) !== sessionDirectory) throw new RunnerError(403, "Invalid session storage");
    const key = await this.key();
    const existing = await this.entry(sessionId);
    if (existing && existing.directory !== sessionDirectory) throw new RunnerError(409, "This session is already portable from another folder");
    if (existing && existing.mark.statement.key === key.publicKey) return existing;
    const mark = await signStatement(key.privateKey, { kind: "session", key: key.publicKey, session: sessionId, issuedAt: now() });
    const entry: PortableEntry = { sessionId, directory: sessionDirectory, mark };
    await writePrivate(join(await this.directory("sessions"), `${sessionId}.json`), JSON.stringify({ version: 1, directory: sessionDirectory, mark }), "replace");
    return entry;
  }

  async entry(sessionId: string): Promise<PortableEntry | undefined> {
    assertId(sessionId);
    let value: unknown;
    try { value = await readJson(join(this.root, "sessions", `${sessionId}.json`)); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
    const input = value as { version?: unknown; directory?: unknown; mark?: unknown };
    if (input?.version !== 1 || typeof input.directory !== "string" || !isAbsolute(input.directory)) throw new Error("Invalid portable session entry");
    const mark = parseSigned(input.mark, "session");
    if (mark.statement.session !== sessionId || !await verifyStatement(mark)) throw new Error("Invalid portable session mark");
    return { sessionId, directory: input.directory, mark };
  }

  async entries(): Promise<PortableEntry[]> {
    let names: string[];
    try { names = await readdir(join(this.root, "sessions")); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
    const entries: PortableEntry[] = [];
    for (const name of names.sort()) {
      const id = /^(.+)\.json$/.exec(name)?.[1];
      if (!id || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(id)) continue;
      const entry = await this.entry(id).catch(() => undefined);
      if (entry) entries.push(entry);
    }
    return entries;
  }

  async repair(): Promise<number> {
    const key = await this.key();
    const previous = new Set(key.rotations.map(rotation => rotation.statement.key));
    let repaired = 0;
    for (const entry of await this.entries()) {
      if (entry.mark.statement.key === key.publicKey || !previous.has(entry.mark.statement.key)) continue;
      const mark = await signStatement(key.privateKey, { kind: "session", key: key.publicKey, session: entry.sessionId, issuedAt: now() });
      await writePrivate(join(this.root, "sessions", `${entry.sessionId}.json`), JSON.stringify({ version: 1, directory: entry.directory, mark }), "replace");
      repaired++;
    }
    return repaired;
  }

  async forget(sessionId: string): Promise<void> {
    assertId(sessionId);
    await rm(join(this.root, "sessions", `${sessionId}.json`), { force: true });
  }

  async withLock<T>(sessionId: string, work: () => Promise<T>): Promise<T> {
    assertId(sessionId);
    if (this.#held.has(sessionId)) throw new IdentityBusy("This session is being attached already");
    this.#held.add(sessionId);
    try {
      const path = join(await this.directory("sessions"), `${sessionId}.lock`);
      const busy = () => new IdentityBusy("Another Pikibun on this computer is attaching this session. Try again shortly");
      for (let attempt = 0; ; attempt++) {
        if (await createFilled(path, String(process.pid))) break;
        if (attempt > 0) throw busy();
        let content: string;
        try { content = await readFile(path, "utf8"); }
        catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") continue; throw error; }
        const holder = Number.parseInt(content, 10);
        const unreadable = !Number.isSafeInteger(holder) || holder < 1;
        if (unreadable ? !await olderThan(path, STALE_LOCK_MS) : holder !== process.pid && processAlive(holder)) throw busy();
        await unlink(path).catch(() => {});
      }
      try { return await work(); }
      finally { await unlink(path).catch(() => {}); }
    } finally { this.#held.delete(sessionId); }
  }

  async settings(): Promise<Signed<SettingsStatement> | undefined> {
    try {
      const signed = parseSigned(await readJson(join(this.root, SETTINGS_FILE)), "settings");
      return await verifyStatement(signed) ? signed : undefined;
    } catch { return undefined; }
  }

  async signSettings(version: number, settings: PortableSettings): Promise<Signed<SettingsStatement>> {
    if (!Number.isSafeInteger(version) || version < 1) throw new RunnerError(400, "Invalid settings version");
    const current = await this.settings();
    const key = await this.key();
    if (current && current.statement.version >= version && current.statement.key === key.publicKey) return current;
    const signed = await signStatement(key.privateKey, { kind: "settings", key: key.publicKey, version, settings: parseSettings(settings), issuedAt: now() });
    await this.directory();
    await writePrivate(join(this.root, SETTINGS_FILE), JSON.stringify(signed), "replace");
    return signed;
  }

  async rotate(): Promise<{ previous: string; next: string; rotation: Signed<RotationStatement> }> {
    const current = await this.key();
    const { file, privateKey } = await generate(current.rotations);
    const rotation = await signStatement(current.privateKey, { kind: "rotation", key: current.publicKey, next: file.publicKey, issuedAt: now() });
    file.rotations = [...current.rotations, rotation].slice(-MAX_ROTATIONS);
    await this.replaceKey(file, privateKey);
    return { previous: current.publicKey, next: file.publicKey, rotation };
  }

  async reset(): Promise<{ previous: string | undefined; next: string }> {
    const previous = (await this.existingKey().catch(() => undefined))?.publicKey;
    const { file, privateKey } = await generate();
    await this.replaceKey(file, privateKey);
    return { previous, next: file.publicKey };
  }

  private async replaceKey(file: KeyFile, privateKey: CryptoKey): Promise<void> {
    const root = await this.directory();
    await writePrivate(join(root, KEY_FILE), JSON.stringify(file), "replace");
    this.#key = Promise.resolve({ publicKey: file.publicKey, privateKey, createdAt: file.createdAt, rotations: file.rotations });
    await rm(join(root, "delegations"), { recursive: true, force: true });
    const settings = await this.settings();
    if (settings) await this.signSettings(settings.statement.version + 1, settings.statement.settings);
    for (const entry of await this.entries()) {
      const mark = await signStatement(privateKey, { kind: "session", key: file.publicKey, session: entry.sessionId, issuedAt: now() });
      await writePrivate(join(root, "sessions", `${entry.sessionId}.json`), JSON.stringify({ version: 1, directory: entry.directory, mark }), "replace");
    }
  }

  async exportKey(passphrase: string): Promise<string> {
    if (passphrase.length < 12) throw new RunnerError(400, "Use a passphrase of at least 12 characters");
    await this.key();
    const plain = await readFile(join(this.root, KEY_FILE));
    const salt = randomBytes(16);
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", await scrypt(passphrase, salt, 32, SCRYPT), iv);
    const sealed = Buffer.concat([cipher.update(plain), cipher.final()]);
    return `${JSON.stringify({ format: EXPORT_FORMAT, salt: salt.toString("base64url"), iv: iv.toString("base64url"),
      tag: cipher.getAuthTag().toString("base64url"), data: sealed.toString("base64url") })}\n`;
  }

  async importKey(exported: string, passphrase: string, options: { replace?: boolean } = {}): Promise<string> {
    let value: { format?: unknown; salt?: unknown; iv?: unknown; tag?: unknown; data?: unknown };
    try { value = JSON.parse(exported); } catch { throw new RunnerError(400, "That isn't an exported Pikibun identity"); }
    if (value?.format !== EXPORT_FORMAT || [value.salt, value.iv, value.tag, value.data].some(part => typeof part !== "string")) {
      throw new RunnerError(400, "That isn't an exported Pikibun identity");
    }
    let plain: Buffer;
    try {
      const decipher = createDecipheriv("aes-256-gcm", await scrypt(passphrase, Buffer.from(value.salt as string, "base64url"), 32, SCRYPT),
        Buffer.from(value.iv as string, "base64url"));
      decipher.setAuthTag(Buffer.from(value.tag as string, "base64url"));
      plain = Buffer.concat([decipher.update(Buffer.from(value.data as string, "base64url")), decipher.final()]);
    } catch { throw new RunnerError(400, "Wrong passphrase, or the file is damaged"); }
    const file = parseKeyFile(JSON.parse(plain.toString("utf8")));
    const privateKey = await importPrivate(file);
    const current = await this.existingKey();
    if (current?.publicKey === file.publicKey) return file.publicKey;
    if (current && !options.replace) throw new RunnerError(409, "This computer already has an identity; add --replace to use the imported one instead");
    await this.replaceKey(file, privateKey);
    return file.publicKey;
  }
}
