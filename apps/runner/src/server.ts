import { mkdir, readFile, open, link, unlink, chmod, realpath, lstat, readdir, rename, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { streamSSE } from "hono/streaming";
import type { RunnerAction, RunnerBinding, RunnerTicket, SessionRecord, SubmitInput } from "../../../packages/shared/src/types.js";
import type { SessionMarkStatement, Signed } from "../../../packages/shared/src/identity.js";
import type { RestoreDescriptor, RestoreInput } from "../../../packages/shared/src/connector.js";
import { ViewRevisions } from "../../../packages/shared/src/view-patch.js";
import { assertId, permissionFor, RunnerError, stableJson, validateBinding, verifyRunnerTicket } from "./protocol.js";
import { RunnerSession, WORK_MARKER, type RunnerConfig } from "./session.js";
import { restoreSession } from "./restore.js";
import { PACK_FILE, readPack, settlePack, unpackSandbox, writePack, type PackSummary } from "./pack.js";
import { LocalViews } from "./local-view.js";
import type { LocalPage, LocalView } from "../../../packages/shared/src/app-host-protocol.js";
import { FailureLog, type LogLine } from "./failure-log.js";
import { PortableLeases } from "./portable-lease.js";

export const MOVED_SESSION = "This session was moved to another server this computer is paired with";
const KEPT_FILE = "portable.json";
const KEPT_BYTES = 256 * 1024;
const PORTABLE_SWEEP_MS = 1000;
const OWNER_CONFIG = "owner.gitconfig";
const RELEASE_WAIT_MS = 10_000;
const RELEASED_WATCH_MS = 60_000;

export interface PortableKept { title?: string; schedules: unknown[] }
export interface PortableReport {
  id: string; title: string; createdAt: string; attached: boolean; hostEnvironment: boolean; working: boolean;
  model: { provider: string; modelId: string }; mark: Signed<SessionMarkStatement>;
}

function parseKept(value: unknown): PortableKept {
  const input = value as { title?: unknown; schedules?: unknown };
  if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).some(key => key !== "title" && key !== "schedules")
    || (input.title !== undefined && (typeof input.title !== "string" || !input.title.trim() || input.title.length > 200))
    || !Array.isArray(input.schedules) || input.schedules.length > 50
    || input.schedules.some(schedule => !schedule || typeof schedule !== "object" || Array.isArray(schedule))) throw new RunnerError(400, "Invalid portable session record");
  return { ...(input.title !== undefined ? { title: input.title as string } : {}), schedules: input.schedules };
}

export function reportedTitle(title: unknown): string {
  const plain = typeof title === "string" ? title.replace(/[\x00-\x1f\x7f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 200).trim() : "";
  return plain || "Untitled session";
}

async function exists(path: string): Promise<boolean> {
  return lstat(path).then(() => true, () => false);
}

async function replaceFile(path: string, content: string): Promise<void> {
  const temporary = `${path}.${randomUUID()}.tmp`;
  const handle = await open(temporary, "wx", 0o600);
  try { await handle.writeFile(content); await handle.sync(); }
  finally { await handle.close(); }
  try { await rename(temporary, path); }
  catch (error) { await unlink(temporary).catch(() => {}); throw error; }
}

function immutable<T>(value: T): T {
  if (value && typeof value === "object") {
    Object.freeze(value);
    for (const child of Object.values(value)) immutable(child);
  }
  return value;
}

export class RunnerService {
  private readonly sessions = new Map<string, Promise<RunnerSession>>();
  private readonly packing = new Map<string, Promise<unknown>>();
  private readonly localViews = new LocalViews();
  private closed = false;
  private readonly reported = new WeakSet<object>();
  private readonly portableOpen = new Set<string>();
  private readonly detachedReported = new Set<string>();
  private readonly leases = new PortableLeases();
  private readonly released = new Map<string, { directory: string; until: number }>();
  private sweep?: NodeJS.Timeout;
  private sweeping = false;
  readonly failures: FailureLog;
  readonly dataDir: string;
  constructor(readonly config: RunnerConfig, log?: LogLine) {
    this.failures = new FailureLog(log);
    if (config.sharedSecret.length < 32) throw new Error("RUNNER_SHARED_SECRET must have at least 32 characters");
    const control = new URL(config.controlPlaneUrl);
    if (control.protocol !== "https:" && !(control.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(control.hostname))) throw new Error("Control plane must use HTTPS except loopback development");
    this.dataDir = resolve(config.dataDir);
  }

  assertConnector(ticket: RunnerTicket): void {
    if (ticket.connectorId !== this.config.connectorId) throw new RunnerError(403, "Ticket connector mismatch");
  }

  private binding(input: unknown, id: string): RunnerBinding {
    const binding = validateBinding(input, id, !!this.config.connectorId && !!this.config.resolveModels);
    if (binding.session.connectorId !== this.config.connectorId) throw new RunnerError(403, "Binding connector mismatch");
    if (binding.model.provider === "faux" && !this.config.allowFaux) throw new RunnerError(403, "Deterministic faux test provider disabled");
    return binding;
  }

  async initialize(): Promise<void> {
    await mkdir(this.dataDir, { recursive: true, mode: 0o700 });
    if ((await lstat(this.dataDir)).isSymbolicLink() || await realpath(this.dataDir) !== this.dataDir) throw new Error("DATA_DIR must be canonical and not symlinked");
    await chmod(this.dataDir, 0o700);
    await mkdir(join(this.dataDir, "sessions"), { recursive: true, mode: 0o700 });
    if (this.config.portable) {
      this.sweep = setInterval(() => { void this.sweepPortable(); }, PORTABLE_SWEEP_MS);
      this.sweep.unref();
    }
  }

  private async sweepPortable(): Promise<void> {
    if (this.sweeping || this.closed) return;
    this.sweeping = true;
    try {
      for (const id of [...this.portableOpen]) {
        const pending = this.sessions.get(id);
        const session = await pending?.catch(() => undefined);
        if (!pending || !session) continue;
        const attached = await this.stillAttached(session.directory, id);
        if (attached && !await this.leases.releaseRequested(session.directory)) continue;
        if (await exists(join(session.directory, WORK_MARKER))) continue;
        if (this.sessions.get(id) === pending) await this.evict(id, session);
        if (!attached) this.detach(id);
        else this.released.set(id, { directory: session.directory, until: Date.now() + RELEASED_WATCH_MS });
      }
      for (const [id, { directory, until }] of [...this.released]) {
        if (this.sessions.has(id)) { this.released.delete(id); continue; }
        if (!await this.stillAttached(directory, id)) { this.released.delete(id); this.detach(id); }
        else if (Date.now() > until) this.released.delete(id);
      }
    } finally { this.sweeping = false; }
  }

  async get(id: string): Promise<RunnerSession> {
    assertId(id);
    if (this.closed) throw new RunnerError(503, "Runner service is closed");
    const existing = this.sessions.get(id);
    if (existing) {
      const session = await existing;
      if (this.portableOpen.has(id) && !await this.stillAttached(session.directory, id)) {
        if (this.sessions.get(id) === existing) await this.evict(id, session);
        this.detach(id);
        throw new RunnerError(410, MOVED_SESSION);
      }
      if (session.failed) await session.recover();
      return session;
    }
    const opening = this.openSession(id);
    this.sessions.set(id, opening);
    try { return await opening; } catch (error) {
      if (this.sessions.get(id) === opening) this.sessions.delete(id);
      this.reportOpenFailure(id, error, "couldn't open");
      throw error;
    }
  }

  private reportOpenFailure(id: string, error: unknown, what: string): void {
    if (error instanceof RunnerError && error.status < 500) return;
    this.failures.report(`Session ${id} ${what}`, error);
    if (error && typeof error === "object") this.reported.add(error);
  }

  reportFailure(context: string, error: unknown): void {
    if (error && typeof error === "object" && this.reported.has(error)) return;
    this.failures.report(context, error);
  }

  async localView(id: string, options: { since?: string; brief?: boolean }): Promise<LocalView> {
    const session = await this.get(id);
    return this.localViews.view(session, await session.view(), options);
  }

  async localEntries(id: string, options: { conversation: string; before: string; limit: number; brief?: boolean }): Promise<LocalPage | null> {
    const session = await this.get(id);
    return this.localViews.entries(await session.view(), options);
  }

  private async locate(id: string): Promise<{ directory: string; portable: boolean }> {
    const entry = this.config.portable ? await this.config.portable.store.entry(id).catch(() => undefined) : undefined;
    return entry ? { directory: entry.directory, portable: true } : { directory: join(this.dataDir, "sessions", id), portable: false };
  }

  private async stillAttached(directory: string, id?: string): Promise<boolean> {
    let value: { session?: { connectorId?: unknown; id?: unknown } };
    try { value = JSON.parse(await readFile(join(directory, "binding.json"), "utf8")); }
    catch { return true; }
    return value?.session?.connectorId === this.config.connectorId && (id === undefined || value.session?.id === id);
  }

  private async evict(id: string, session: RunnerSession): Promise<void> {
    this.sessions.delete(id);
    const portable = this.portableOpen.delete(id);
    await session.close().catch(() => {});
    await session.sandbox.close().catch(() => {});
    if (portable) await this.leases.release(session.directory);
  }

  private detach(id: string): void {
    const report = this.config.portable?.detached;
    if (!report || this.detachedReported.has(id)) return;
    this.detachedReported.add(id);
    void report(id).catch(() => { this.detachedReported.delete(id); });
  }

  private async openSession(id: string): Promise<RunnerSession> {
    const { directory, portable } = await this.locate(id);
    let raw: unknown;
    try { raw = JSON.parse(await readFile(join(directory, "binding.json"), "utf8")); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new RunnerError(404, "Session not found"); throw error; }
    const stored = (raw as RunnerBinding | null)?.session;
    if ((portable || stored?.portable === true) && (stored?.connectorId !== this.config.connectorId || stored?.id !== id)) {
      this.detach(id);
      throw new RunnerError(410, MOVED_SESSION);
    }
    const binding = this.binding(raw, id);
    if (await realpath(directory) !== directory) throw new RunnerError(403, "Invalid session storage");
    if (portable) await this.leases.acquire(directory);
    await settlePack(directory);
    const session = new RunnerSession(immutable(binding), directory, this.config);
    try { await session.open(); }
    catch (error) {
      await session.close().catch(() => {});
      await session.sandbox.close().catch(() => {});
      if (portable) await this.leases.release(directory);
      throw error;
    }
    if (portable) {
      this.portableOpen.add(id);
      this.detachedReported.delete(id);
    }
    return session;
  }

  private async transition<T>(session: RunnerSession, work: () => Promise<T>): Promise<T> {
    const id = session.binding.session.id;
    const done = (async (): Promise<{ value: T } | { error: unknown }> => {
      try { return { value: await work() }; }
      catch (error) { return { error }; }
      finally {
        await session.close().catch(() => {});
        await session.sandbox.close().catch(() => {});
      }
    })();
    const reopened = done.then(() => this.openSession(id));
    this.sessions.set(id, reopened);
    reopened.catch(error => {
      if (this.sessions.get(id) === reopened) this.sessions.delete(id);
      this.reportOpenFailure(id, error, "couldn't reopen");
    });
    const outcome = await done;
    if ("error" in outcome) throw outcome.error;
    return outcome.value;
  }

  async pack(id: string, ticket: RunnerTicket): Promise<{ packed: true } & Partial<PackSummary>> {
    return this.serialized(id, () => this.packNow(id, ticket));
  }

  private serialized<T>(id: string, work: () => Promise<T>): Promise<T> {
    const previous = this.packing.get(id) ?? Promise.resolve();
    const next = previous.then(work, work);
    const settled = next.then(() => undefined, () => undefined);
    this.packing.set(id, settled);
    void settled.then(() => { if (this.packing.get(id) === settled) this.packing.delete(id); });
    return next;
  }

  private async packNow(id: string, ticket: RunnerTicket): Promise<{ packed: true } & Partial<PackSummary>> {
    const session = await this.get(id);
    if (ticket.actorId !== session.binding.owner.id) throw new RunnerError(403, "Only the session's owner can pack its files");
    if (session.packed) {
      await session.authorize(ticket.actorId, "manage", ticket.policyVersion, false, false, true);
      return { packed: true };
    }
    await session.requirePackable(ticket.actorId, ticket.policyVersion);
    await session.consumeTicket(ticket);
    return this.transition(session, async () => {
      const { bytes, files, clones } = await session.packContent(ticket);
      await session.sandbox.close();
      await writePack(session.directory, bytes);
      return { packed: true as const, files, clones, bytes: bytes.byteLength };
    });
  }

  async unpack(id: string, ticket: RunnerTicket): Promise<{ unpacked: boolean }> {
    return this.serialized(id, () => this.unpackNow(id, ticket));
  }

  private async unpackNow(id: string, ticket: RunnerTicket): Promise<{ unpacked: boolean }> {
    const session = await this.get(id);
    if (ticket.actorId !== session.binding.owner.id) throw new RunnerError(403, "Only the session's owner can unpack its files");
    await session.authorize(ticket.actorId, "manage", ticket.policyVersion, false, false, true);
    if (!session.packed) return { unpacked: false };
    await session.consumeTicket(ticket);
    return this.transition(session, async () => {
      const files = await readPack(session.directory, session.binding);
      await session.sandbox.close();
      await unpackSandbox(session.directory, session.binding, files);
      return { unpacked: true };
    });
  }

  async resume(): Promise<void> {
    let names: string[];
    try { names = await readdir(join(this.dataDir, "sessions")); }
    catch { return; }
    for (const name of names.sort()) {
      if (this.closed) return;
      try { assertId(name); } catch { continue; }
      const marked = await lstat(join(this.dataDir, "sessions", name, WORK_MARKER)).then(stat => stat.isFile(), () => false);
      const packed = await lstat(join(this.dataDir, "sessions", name, PACK_FILE)).then(stat => stat.isFile(), () => false);
      if (marked && !packed) await this.get(name).catch(() => {});
    }
    const own = join(this.dataDir, "sessions");
    for (const entry of await this.config.portable?.store.entries().catch(() => []) ?? []) {
      if (this.closed) return;
      if (entry.directory === join(own, entry.sessionId) || !await exists(join(entry.directory, WORK_MARKER))) continue;
      if (await this.stillAttached(entry.directory) && !await exists(join(entry.directory, PACK_FILE))) await this.get(entry.sessionId).catch(() => {});
    }
  }

  async portableSessions(): Promise<PortableReport[]> {
    const portable = this.config.portable;
    if (!portable) return [];
    await portable.store.repair().catch(() => 0);
    const key = await portable.store.publicKey();
    const reports: PortableReport[] = [];
    for (const entry of await portable.store.entries()) {
      if (entry.mark.statement.key !== key) continue;
      let binding: RunnerBinding;
      try { binding = JSON.parse(await readFile(join(entry.directory, "binding.json"), "utf8")) as RunnerBinding; }
      catch { continue; }
      if (binding?.session?.id !== entry.sessionId || typeof binding.model?.provider !== "string" || typeof binding.model.modelId !== "string") continue;
      const kept = await this.kept(entry.directory);
      reports.push({ id: entry.sessionId, title: reportedTitle(kept.title ?? binding.session.title), createdAt: binding.session.createdAt,
        attached: binding.session.connectorId === this.config.connectorId, hostEnvironment: binding.session.hostEnvironment === true,
        working: await exists(join(entry.directory, WORK_MARKER)), model: { provider: binding.model.provider, modelId: binding.model.modelId }, mark: entry.mark });
    }
    return reports;
  }

  private async kept(directory: string): Promise<PortableKept> {
    try {
      const path = join(directory, KEPT_FILE);
      if ((await lstat(path)).size > KEPT_BYTES) return { schedules: [] };
      return parseKept(JSON.parse(await readFile(path, "utf8")));
    } catch { return { schedules: [] }; }
  }

  async keep(session: RunnerSession, ticket: RunnerTicket, input: unknown): Promise<{ kept: true }> {
    if (ticket.actorId !== session.binding.owner.id) throw new RunnerError(403, "Only the session's owner keeps its record on the host");
    if (session.binding.session.portable !== true) throw new RunnerError(409, "This session isn't portable");
    const kept = parseKept(input);
    const content = JSON.stringify(kept);
    if (Buffer.byteLength(content) > KEPT_BYTES) throw new RunnerError(413, "The session's record is too large to keep on the host");
    await replaceFile(join(session.directory, KEPT_FILE), content);
    return { kept: true };
  }

  async attach(input: unknown, ticket: RunnerTicket): Promise<{ session: SessionRecord; kept: PortableKept }> {
    const id = assertId(ticket.sessionId);
    if (this.closed) throw new RunnerError(503, "Runner service is closed");
    this.assertConnector(ticket);
    const portable = this.config.portable;
    if (!portable) throw new RunnerError(409, "This host keeps no portable sessions. Update its connector");
    const request = input as { binding?: unknown; sourceSessionId?: unknown } | null;
    if (!request || typeof request !== "object" || Array.isArray(request) || Object.keys(request).some(key => key !== "binding" && key !== "sourceSessionId")
      || (request.sourceSessionId !== undefined && typeof request.sourceSessionId !== "string")) throw new RunnerError(400, "Invalid attach request");
    const source = request.sourceSessionId === undefined ? id : assertId(request.sourceSessionId as string);
    const binding = immutable(this.binding(request.binding, id));
    if (binding.session.portable !== true) throw new RunnerError(400, "Only a portable session is attached");
    if (binding.owner.id !== ticket.ownerId || ticket.actorId !== ticket.ownerId) throw new RunnerError(403, "Only the session's owner attaches it");
    const key = await portable.store.publicKey();
    const entry = await portable.store.entry(source);
    if (source !== id && !entry) throw new RunnerError(404, "Session not found");
    const directory = entry?.directory ?? join(this.dataDir, "sessions", id);
    const target = source !== id ? await portable.store.entry(id) : undefined;
    if (source !== id && ((target && target.directory !== directory) || (!target && await exists(join(this.dataDir, "sessions", id))))) {
      throw new RunnerError(409, "A session with that ID is on this host already");
    }
    if (entry && entry.mark.statement.key !== key) throw new RunnerError(403, "This session belongs to another identity");
    let current: RunnerBinding;
    try { current = JSON.parse(await readFile(join(directory, "binding.json"), "utf8")) as RunnerBinding; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new RunnerError(404, "Session not found"); throw error; }
    if (current?.session?.id !== source && !(source !== id && current?.session?.id === id)) throw new RunnerError(403, "Invalid session storage");
    if (await realpath(directory) !== directory) throw new RunnerError(403, "Invalid session storage");
    if (await exists(join(directory, PACK_FILE))) throw new RunnerError(409, "This session's files are packed. Unarchive it where it is attached now first");
    const here = current.session.connectorId === this.config.connectorId;
    if (!entry && !here) throw new RunnerError(404, "Session not found");
    if (here && (current.owner?.id !== binding.owner.id || current.session.id !== id)) throw new RunnerError(403, "A portable session keeps its owner and ID on the same server");
    if ((current.session.hostEnvironment === true) !== (binding.session.hostEnvironment === true)
      || current.session.repositoryMode !== binding.session.repositoryMode || (binding.session.repositories ?? []).length > 0) {
      throw new RunnerError(409, "The session's record doesn't match where it runs on this host");
    }
    const authority = new RunnerSession(binding, directory, this.config);
    await authority.authorize(ticket.actorId, "manage", ticket.policyVersion);
    await portable.store.withLock(source, async () => {
      const marker = join(directory, WORK_MARKER);
      if (await exists(marker)) throw new RunnerError(409, "This session is working. Stop it, or wait for it to finish, where it is attached now");
      if (await this.leases.holder(directory) === "other" && !await this.leases.requestRelease(directory, RELEASE_WAIT_MS)) {
        throw new RunnerError(409, "This session is still open on another of this computer's connections. Try again shortly");
      }
      const open = this.sessions.get(id);
      if (open) {
        const session = await open.catch(() => undefined);
        if (this.sessions.get(id) === open) this.sessions.delete(id);
        this.portableOpen.delete(id);
        if (session) { await session.close().catch(() => {}); await session.sandbox.close().catch(() => {}); }
      }
      await this.leases.acquire(directory);
      try {
        if (await exists(marker)) throw new RunnerError(409, "This session started working where it is attached now. Try again once it finishes");
        if (source !== id && !target) await portable.store.mark(id, directory);
        try { await this.rebind(binding, directory, [source, id]); }
        catch (error) {
          if (source !== id && !target && current.session.id === source) await portable.store.forget(id).catch(() => {});
          throw error;
        }
        if (!entry) await portable.store.mark(id, directory);
        if (source !== id) await portable.store.forget(source).catch(() => {});
      } catch (error) {
        await this.leases.release(directory);
        throw error;
      }
    });
    this.detachedReported.delete(id);
    const kept = await this.kept(directory);
    await this.get(id);
    return { session: binding.session, kept };
  }

  private async rebind(binding: RunnerBinding, directory: string, sources: readonly string[]): Promise<void> {
    const ownerConfig = join(directory, "sandbox", OWNER_CONFIG);
    const pinned = await readFile(ownerConfig, "utf8").catch(() => undefined);
    const path = join(directory, "binding.json");
    const restoreOwnerConfig = async () => {
      await rm(ownerConfig, { force: true });
      if (pinned !== undefined) await writeFile(ownerConfig, pinned, { mode: 0o400, flag: "wx" });
    };
    await rm(ownerConfig, { force: true });
    const staged = new RunnerSession(binding, directory, this.config);
    try { await staged.rebind(sources); }
    catch (error) { await restoreOwnerConfig().catch(() => {}); throw error; }
    finally { await staged.sandbox.close().catch(() => {}); }
    try { await replaceFile(path, JSON.stringify(binding)); }
    catch { throw new RunnerError(503, "The session's new record couldn't be saved on this host. Bring it here again to finish"); }
  }

  async provision(input: unknown, ticket: RunnerTicket): Promise<RunnerSession> {
    const id = assertId(ticket.sessionId);
    if (this.closed) throw new RunnerError(503, "Runner service is closed");
    this.assertConnector(ticket);
    const binding = this.binding(input, id);
    if (binding.owner.id !== ticket.ownerId || binding.owner.id !== ticket.actorId || binding.session.policyVersion !== ticket.policyVersion) throw new RunnerError(403, "Provisioning owner mismatch");
    if (binding.model.provider === "faux" && !this.config.allowFaux) throw new RunnerError(403, "Deterministic faux test provider disabled");
    const directory = join(this.dataDir, "sessions", id);
    const session = new RunnerSession(immutable(binding), directory, this.config);
    await session.authorize(ticket.actorId, "write", ticket.policyVersion);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    if (await realpath(directory) !== directory) throw new RunnerError(403, "Invalid session storage");
    const temporary = join(directory, `binding-${randomUUID()}.tmp`);
    const handle = await open(temporary, "wx", 0o600);
    try {
      await handle.writeFile(JSON.stringify(binding));
      await handle.sync();
      try { await link(temporary, join(directory, "binding.json")); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
    } finally { await handle.close(); await unlink(temporary); }
    const persisted = this.binding(JSON.parse(await readFile(join(directory, "binding.json"), "utf8")), id);
    if (stableJson(persisted) !== stableJson(binding)) throw new RunnerError(409, "Session already exists with a different immutable owner, agent, model, or binding");
    if (binding.session.portable === true && this.config.portable) await this.config.portable.store.mark(id, directory);
    return this.get(id);
  }

  private async pullBackup(restore: RestoreDescriptor, targetSessionId: string): Promise<Uint8Array> {
    if (this.config.readBackup) return this.config.readBackup(restore, targetSessionId);
    if (this.config.connectorId) throw new RunnerError(503, "Connected restore requires its scoped download callback");
    const response = await (this.config.fetch ?? fetch)(`${this.config.controlPlaneUrl}/api/internal/restores/${assertId(restore.id)}/download`, {
      method: "POST", headers: { authorization: `Bearer ${this.config.sharedSecret}`, "content-type": "application/json" },
      body: JSON.stringify({ targetSessionId, sourceSessionId: restore.sourceSessionId, backupId: restore.backupId, downloadToken: restore.downloadToken }),
      signal: AbortSignal.timeout(30_000), redirect: "error",
    });
    if (!response.ok || response.headers.get("x-backup-sha256") !== restore.sha256
      || response.headers.get("content-length") !== String(restore.size) || !response.body) {
      await response.body?.cancel();
      throw new RunnerError(403, "Backup download denied or metadata mismatch");
    }
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        size += chunk.value.byteLength;
        if (size > restore.size || size > 24 * 1024 * 1024) throw new RunnerError(413, "Backup download exceeds its bound");
        chunks.push(chunk.value);
      }
    } finally { await reader.cancel(); reader.releaseLock(); }
    if (size !== restore.size) throw new RunnerError(400, "Truncated backup");
    return Buffer.concat(chunks, size);
  }

  async restore(input: RestoreInput, ticket: RunnerTicket): Promise<RunnerBinding> {
    if (this.closed) throw new RunnerError(503, "Runner service is closed");
    this.assertConnector(ticket);
    const id = assertId(ticket.sessionId);
    const binding = immutable(this.binding(input?.binding, id));
    if (ticket.actorId !== binding.owner.id || ticket.ownerId !== binding.owner.id)
      throw new RunnerError(403, "Only the immutable owner can restore a session");
    const authority = new RunnerSession(binding, join(this.dataDir, "sessions", id), this.config);
    await authority.authorize(ticket.actorId, "manage", ticket.policyVersion);
    await restoreSession({ dataDir: this.dataDir, readBackup: (descriptor, target) => this.pullBackup(descriptor, target),
      ...(this.config.toolDefinitions ? { toolDefinitions: this.config.toolDefinitions } : {}) },
      binding, input.restore, async (stage, manifest, options) => {
        if (this.closed) throw new RunnerError(503, "Runner service is closed");
        await authority.authorize(ticket.actorId, "manage", ticket.policyVersion);
        const staged = new RunnerSession(binding, stage, this.config);
        try { await staged.prepareRestore(manifest, options); }
        finally { await staged.sandbox.close(); }
      });
    return binding;
  }

  async fork(target: RunnerSession, ticket: RunnerTicket, input: unknown): Promise<{ conversationId: string; entries: number }> {
    const value = input as { sourceSessionId?: unknown; entryId?: unknown } | null;
    if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some(key => key !== "sourceSessionId" && key !== "entryId")
      || typeof value.sourceSessionId !== "string" || typeof value.entryId !== "string" || value.entryId.length > 64) throw new RunnerError(400, "Invalid fork request");
    const sourceId = assertId(value.sourceSessionId);
    if (sourceId === target.binding.session.id) throw new RunnerError(400, "A session can't be forked into itself");
    if (ticket.actorId !== target.binding.owner.id) throw new RunnerError(403, "Only the session's owner can fork into it");
    const source = await this.get(sourceId);
    if (source.binding.session.workspaceId !== target.binding.session.workspaceId) throw new RunnerError(403, "A session forks only into the same workspace");
    const entries = await source.forkEntries(ticket.actorId, value.entryId);
    return target.seed(ticket, { sessionId: sourceId, entryId: value.entryId }, entries);
  }

  async close(): Promise<void> {
    this.closed = true;
    if (this.sweep) clearInterval(this.sweep);
    for (const [id, pending] of this.sessions) {
      const session = await pending.catch(() => undefined);
      if (!session) continue;
      await session.close();
      await session.sandbox.close();
      if (this.portableOpen.has(id)) await this.leases.release(session.directory);
    }
    this.sessions.clear();
    this.portableOpen.clear();
    this.leases.close();
  }
}

function failureContext(method: string, url: string): string {
  const path = new URL(url).pathname;
  const session = /^\/v1\/sessions\/([A-Za-z0-9_-]{1,128})\/([a-z]+)/.exec(path);
  return session ? `Session ${session[1]}: ${session[2]} failed` : `Runner: ${method} ${path} failed`;
}

export function createRunnerApp(service: RunnerService): Hono {
  const app = new Hono();
  const revisions = new WeakMap<object, ViewRevisions>();
  app.use("*", bodyLimit({ maxSize: 1024 * 1024, onError: c => c.json({ error: "Request too large" }, 413) }));
  app.onError((error, c) => {
    if (error instanceof SyntaxError) return c.json({ error: "Invalid JSON" }, 400);
    if (!(error instanceof RunnerError) || error.status >= 500) service.reportFailure(failureContext(c.req.method, c.req.url), error);
    if (error instanceof RunnerError) return c.json({ error: error.message }, error.status as 400);
    return c.json({ error: "Runner operation failed" }, 500);
  });
  app.get("/health", c => c.json({ ok: true, runtime: "node24", execution: "pi-durable", faux: service.config.allowFaux }));
  app.post("/v1/sessions", async c => {
    const body = await c.req.text();
    const input = JSON.parse(body) as RunnerBinding;
    const id = assertId(input?.session?.id ?? "");
    const token = c.req.header("authorization")?.match(/^Bearer ([^ ]+)$/)?.[1] ?? "";
    const ticket = await verifyRunnerTicket(token, service.config.sharedSecret, "create", id, body);
    service.assertConnector(ticket);
    const session = await service.provision(input, ticket);
    return c.json({ session: session.binding.session }, 201);
  });
  app.all("/v1/sessions/:id/*", async c => {
    const id = assertId(c.req.param("id"));
    const url = new URL(c.req.url);
    const prefix = `/v1/sessions/${id}/`;
    if (!url.pathname.startsWith(prefix) || url.search) throw new RunnerError(400, "Invalid path");
    const route = url.pathname.slice(prefix.length);
    const since = /^view\/([0-9a-f]{32})$/.exec(route)?.[1];
    const actions: Record<string, RunnerAction> = { submit: "submit", ask: "ask", view: "view", events: "events", restart: "restart", backup: "backup", restore: "restore", stop: "stop", files: "files", changes: "changes", revert: "revert", fork: "fork", pack: "pack", unpack: "unpack", withdraw: "withdraw", upload: "upload", tunnel: "tunnel", image: "image", sudo: "sudo", attach: "attach", portable: "portable", artifacts: "artifacts", title: "title" };
    const action = since ? "view" : actions[route];
    if (!action) throw new RunnerError(404, "Unknown runner endpoint");
    if (c.req.method !== (action === "view" || action === "events" ? "GET" : "POST")) throw new RunnerError(405, "Method not allowed");
    const body = await c.req.text();
    const token = c.req.header("authorization")?.match(/^Bearer ([^ ]+)$/)?.[1] ?? "";
    const ticket = await verifyRunnerTicket(token, service.config.sharedSecret, action, id, body);
    service.assertConnector(ticket);
    if (action === "restore") {
      const input = JSON.parse(body) as RestoreInput;
      const binding = await service.restore(input, ticket);
      return c.json({ session: binding.session, restore: { id: input.restore.id, sha256: input.restore.sha256, targetSessionId: id } }, 201);
    }
    if (action === "attach") return c.json(await service.attach(JSON.parse(body), ticket), 201);
    if (action === "pack" || action === "unpack") {
      if (body && stableJson(JSON.parse(body)) !== "{}") throw new RunnerError(400, `Invalid ${action} request`);
      const session = await service.get(id);
      if (ticket.ownerId !== session.binding.owner.id) throw new RunnerError(403, "Ticket owner mismatch");
      return c.json(action === "pack" ? await service.pack(id, ticket) : await service.unpack(id, ticket));
    }
    const session = await service.get(id);
    if (ticket.ownerId !== session.binding.owner.id) throw new RunnerError(403, "Ticket owner mismatch");
    if (session.packed && action !== "view" && action !== "events" && action !== "artifacts") throw new RunnerError(409, "This session's files are packed. Unarchive it to use them");
    await session.authorize(ticket.actorId, permissionFor(action), ticket.policyVersion);
    if (action === "restart" || action === "backup" || action === "upload") await session.consumeTicket(ticket);
    if (action === "view") {
      let views = revisions.get(session);
      if (!views) revisions.set(session, views = new ViewRevisions());
      const current = views.record(await session.view());
      const patch = since === undefined ? null : views.since(since, current);
      return c.json(patch ? { patch } : { view: current.view, revision: current.revision });
    }
    if (action === "events") return streamSSE(c, async stream => {
      let last = "";
      let checking = false;
      const monitor = setInterval(() => {
        if (checking || stream.aborted) return;
        checking = true;
        void session.authorize(ticket.actorId, "read", ticket.policyVersion)
          .catch(() => stream.abort()).finally(() => { checking = false; });
      }, 1000);
      const expiry = setTimeout(() => stream.abort(), Math.max(0, ticket.exp * 1000 - Date.now()));
      try {
        while (!stream.aborted) {
          if (Date.now() >= ticket.exp * 1000) break;
          const view = JSON.stringify({ view: await session.view() });
          if (stream.aborted) break;
          if (view !== last) { await stream.writeSSE({ event: "view", data: view }); last = view; }
          else await stream.writeSSE({ event: "ping", data: "{}" });
          await delay(250);
        }
      } finally { clearInterval(monitor); clearTimeout(expiry); }
    });
    const input = body ? JSON.parse(body) : {};
    if (action === "submit" || action === "ask") return c.json(await session.submit(ticket, input as SubmitInput, action === "ask" ? "ask" : "write"));
    if (action === "stop") return c.json(await session.stop(ticket));
    if (action === "withdraw") return c.json(await session.withdraw(ticket, input));
    if (action === "tunnel") return c.json(await session.tunnelAction(ticket, input));
    if (action === "sudo") return c.json(await session.sudoAction(ticket, input));
    if (action === "title") return c.json(await session.title(ticket, input));
    if (action === "portable") return c.json(await service.keep(session, ticket, input));
    if (action === "revert") return c.json(await session.revert(ticket, input));
    if (action === "fork") return c.json(await service.fork(session, ticket, input));
    if (action === "files") {
      if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).some(key => key !== "path")
        || typeof input.path !== "string" || !input.path || input.path.length > 1024) throw new RunnerError(400, "Invalid file browser request");
      return c.json({ files: await session.browse(ticket, input.path) });
    }
    if (action === "changes") return c.json({ changes: await session.changes(ticket, input) });
    if (action === "upload") return c.json(await session.upload(ticket, input));
    if (action === "image") return c.json(await session.entryImage(ticket, input));
    if (action === "artifacts") return c.json(await session.artifacts(ticket, input));
    if (action === "restart") {
      if (ticket.actorId !== session.binding.owner.id) throw new RunnerError(403, "Only the owner can restart a session");
      await session.restart();
      return c.json({ ok: true, sessionId: id });
    }
    if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).some(key => key !== "conversationOnly")
      || (input.conversationOnly !== undefined && typeof input.conversationOnly !== "boolean")) throw new RunnerError(400, "Invalid backup request");
    return c.json(await session.backup(ticket, { conversationOnly: input.conversationOnly === true }));
  });
  app.notFound(c => c.json({ error: "Not found" }, 404));
  return app;
}
