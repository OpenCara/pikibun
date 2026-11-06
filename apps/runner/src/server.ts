import { mkdir, readFile, open, link, unlink, chmod, realpath, lstat, readdir } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { streamSSE } from "hono/streaming";
import type { RunnerAction, RunnerBinding, RunnerTicket, SubmitInput, Operation } from "../../../packages/shared/src/types.js";
import type { RestoreDescriptor, RestoreInput } from "../../../packages/shared/src/connector.js";
import { ViewRevisions } from "../../../packages/shared/src/view-patch.js";
import { assertId, permissionFor, RunnerError, stableJson, validateBinding, verifyRunnerTicket } from "./protocol.js";
import { RunnerSession, WORK_MARKER, type RunnerConfig } from "./session.js";
import { restoreSession } from "./restore.js";
import { PACK_FILE, readPack, settlePack, unpackSandbox, writePack, type PackSummary } from "./pack.js";

function immutable<T>(value: T): T {
  if (value && typeof value === "object") {
    Object.freeze(value);
    for (const child of Object.values(value)) immutable(child);
  }
  return value;
}

export class RunnerService {
  private readonly sessions = new Map<string, Promise<RunnerSession>>();
  /** Packs and unpacks under way, by session: one at a time for each (see serialized). */
  private readonly packing = new Map<string, Promise<unknown>>();
  private closed = false;
  readonly dataDir: string;
  constructor(readonly config: RunnerConfig) {
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
  }

  async get(id: string): Promise<RunnerSession> {
    assertId(id);
    if (this.closed) throw new RunnerError(503, "Runner service is closed");
    const existing = this.sessions.get(id);
    if (existing) {
      const session = await existing;
      if (session.failed) await session.recover();
      return session;
    }
    const opening = this.openSession(id);
    this.sessions.set(id, opening);
    try { return await opening; } catch (error) { if (this.sessions.get(id) === opening) this.sessions.delete(id); throw error; }
  }

  private async openSession(id: string): Promise<RunnerSession> {
    const directory = join(this.dataDir, "sessions", id);
    let binding: RunnerBinding;
    try { binding = this.binding(JSON.parse(await readFile(join(directory, "binding.json"), "utf8")), id); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new RunnerError(404, "Session not found"); throw error; }
    if (await realpath(directory) !== directory) throw new RunnerError(403, "Invalid session storage");
    // A pack or unpack that a crash cut off is finished or undone before anything opens the session.
    await settlePack(directory);
    const session = new RunnerSession(immutable(binding), directory, this.config);
    try { await session.open(); }
    catch (error) {
      await session.close().catch(() => {});
      await session.sandbox.close().catch(() => {});
      throw error;
    }
    return session;
  }

  /**
   * Runs `work` on `session` once requests already admitted to it are done, then closes it, sandbox included, and opens
   * it again: requests that come meanwhile wait for the session as it opens then. `work`'s result or error is returned.
   */
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
    reopened.catch(() => { if (this.sessions.get(id) === reopened) this.sessions.delete(id); });
    const outcome = await done;
    if ("error" in outcome) throw outcome.error;
    return outcome.value;
  }

  /**
   * Packs the files of the archived session `id` (pack.ts) for its owner, who asked through `ticket`. Packing a session
   * already packed changes nothing, so a retry after an unclear outcome is safe.
   */
  async pack(id: string, ticket: RunnerTicket): Promise<{ packed: true } & Partial<PackSummary>> {
    return this.serialized(id, () => this.packNow(id, ticket));
  }

  /**
   * Runs `work`, a pack or unpack of session `id`, after those already asked for it, claimed before anything awaits:
   * two of them never hold the same session, so one is always done, the session reopened, before the next looks at it.
   */
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
    // Refused before the session closes, when it can be: a refusal leaves it as it was.
    await session.requirePackable(ticket.actorId, ticket.policyVersion);
    await session.consumeTicket(ticket);
    return this.transition(session, async () => {
      const { bytes, files, clones } = await session.packContent(ticket);
      await session.sandbox.close();
      await writePack(session.directory, bytes);
      return { packed: true as const, files, clones, bytes: bytes.byteLength };
    });
  }

  /**
   * Brings back the packed files of the archived session `id` before its owner unarchives it. A session that isn't
   * packed is left as it is, so a retry is safe.
   */
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
      // Checked before anything is written: a damaged pack stays, and the session stays packed.
      const files = await readPack(session.directory, session.binding);
      await session.sandbox.close();
      await unpackSandbox(session.directory, session.binding, files);
      return { unpacked: true };
    });
  }

  /**
   * Opens every session that had work in progress when its runner last stopped (WORK_MARKER), one at a time, so that
   * work goes on rather than waiting until someone opens the session. Opening resumes it as any open does; a session
   * that can't open is left for its next request.
   */
  async resume(): Promise<void> {
    let names: string[];
    try { names = await readdir(join(this.dataDir, "sessions")); }
    catch { return; }
    for (const name of names.sort()) {
      if (this.closed) return;
      try { assertId(name); } catch { continue; }
      const marked = await lstat(join(this.dataDir, "sessions", name, WORK_MARKER)).then(stat => stat.isFile(), () => false);
      // A packed session has no work to go on with.
      const packed = await lstat(join(this.dataDir, "sessions", name, PACK_FILE)).then(stat => stat.isFile(), () => false);
      if (marked && !packed) await this.get(name).catch(() => {});
    }
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
    // Publish a complete fsynced immutable binding with an atomic no-replace link.
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

  /**
   * Starts `target`, a new session of the ticket's owner, from the shared conversation of `sourceSessionId`, another of
   * their sessions on this host, up to one of its messages. The transcript goes from one to the other here, on the host.
   */
  async fork(target: RunnerSession, ticket: RunnerTicket, input: unknown): Promise<{ conversationId: string; entries: number }> {
    const value = input as { sourceSessionId?: unknown; entryId?: unknown } | null;
    if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some(key => key !== "sourceSessionId" && key !== "entryId")
      || typeof value.sourceSessionId !== "string" || typeof value.entryId !== "string" || value.entryId.length > 64) throw new RunnerError(400, "Invalid fork request");
    const sourceId = assertId(value.sourceSessionId);
    if (sourceId === target.binding.session.id) throw new RunnerError(400, "A session can't be forked into itself");
    if (ticket.actorId !== target.binding.owner.id) throw new RunnerError(403, "Only the session's owner can fork into it");
    const source = await this.get(sourceId);
    if (source.binding.owner.id !== ticket.actorId || source.binding.session.workspaceId !== target.binding.session.workspaceId) {
      throw new RunnerError(403, "Only the session's owner can fork it, into the same workspace");
    }
    const entries = await source.forkEntries(ticket.actorId, value.entryId);
    return target.seed(ticket, { sessionId: sourceId, entryId: value.entryId }, entries);
  }

  async close(): Promise<void> {
    this.closed = true;
    for (const pending of this.sessions.values()) {
      // A session that failed to open again after packing or unpacking holds nothing to close.
      const session = await pending.catch(() => undefined);
      if (!session) continue;
      await session.close();
      await session.sandbox.close();
    }
    this.sessions.clear();
  }
}

export function createRunnerApp(service: RunnerService): Hono {
  const app = new Hono();
  // Each session's recent views, so a caller holding one gets only what changed since.
  const revisions = new WeakMap<object, ViewRevisions>();
  app.use("*", bodyLimit({ maxSize: 1024 * 1024, onError: c => c.json({ error: "Request too large" }, 413) }));
  app.onError((error, c) => {
    if (error instanceof RunnerError) return c.json({ error: error.message }, error.status as 400);
    if (error instanceof SyntaxError) return c.json({ error: "Invalid JSON" }, 400);
    // Never send stack traces, host paths, provider errors, or credential material to clients.
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
    const approval = /^approvals\/([A-Za-z0-9][A-Za-z0-9_-]{0,127})$/.exec(route);
    // view/<revision>: what changed since a view this caller already holds.
    const since = /^view\/([0-9a-f]{32})$/.exec(route)?.[1];
    const actions: Record<string, RunnerAction> = { submit: "submit", ask: "ask", view: "view", events: "events", operations: "operations", restart: "restart", backup: "backup", restore: "restore", stop: "stop", files: "files", revert: "revert", fork: "fork", pack: "pack", unpack: "unpack", withdraw: "withdraw", upload: "upload", tunnel: "tunnel" };
    const action = approval ? "approve" : since ? "view" : actions[route];
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
    // Packing and unpacking act on an archived session, which the control plane authorizes for nothing else; both check
    // that themselves, and take an empty body.
    if (action === "pack" || action === "unpack") {
      if (body && stableJson(JSON.parse(body)) !== "{}") throw new RunnerError(400, `Invalid ${action} request`);
      const session = await service.get(id);
      if (ticket.ownerId !== session.binding.owner.id) throw new RunnerError(403, "Ticket owner mismatch");
      return c.json(action === "pack" ? await service.pack(id, ticket) : await service.unpack(id, ticket));
    }
    const session = await service.get(id);
    if (ticket.ownerId !== session.binding.owner.id) throw new RunnerError(403, "Ticket owner mismatch");
    // A session whose files are packed only shows its conversation until it is unpacked.
    if (session.packed && action !== "view" && action !== "events") throw new RunnerError(409, "This session's files are packed. Unarchive it to use them");
    // A decision needs approve permission, but the host's owner decides a host command with any access to the session:
    // decide() checks which one the card's operation needs.
    await session.authorize(ticket.actorId, action === "approve" ? "read" : permissionFor(action), ticket.policyVersion);
    // An upload's chunk goes in once: the desktop app hands the host chunks itself, outside the relay's replay checks.
    if (action === "operations" || action === "restart" || action === "backup" || action === "upload") await session.consumeTicket(ticket);
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
      // This watchdog is independent of response backpressure and never aborts the model run.
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
    if (action === "operations") return c.json({ approval: await session.createApproval(ticket.actorId, input.operation as Operation) }, 201);
    if (action === "stop") return c.json(await session.stop(ticket));
    if (action === "withdraw") return c.json(await session.withdraw(ticket, input));
    if (action === "tunnel") return c.json(await session.tunnelAction(ticket, input));
    if (action === "revert") return c.json(await session.revert(ticket, input));
    if (action === "fork") return c.json(await service.fork(session, ticket, input));
    if (action === "files") {
      // One worktree path, relative, as the file browser asks for it; the sandbox checks it again.
      if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).some(key => key !== "path")
        || typeof input.path !== "string" || !input.path || input.path.length > 1024) throw new RunnerError(400, "Invalid file browser request");
      return c.json({ files: await session.browse(ticket, input.path) });
    }
    if (action === "upload") return c.json(await session.upload(ticket, input));
    if (action === "approve") {
      if (input.approvalId !== approval![1]) throw new RunnerError(403, "Approval ticket path mismatch");
      return c.json({ approval: await session.decide(ticket, approval![1]!, input) });
    }
    if (action === "restart") {
      if (ticket.actorId !== session.binding.owner.id) throw new RunnerError(403, "Only the owner can restart a session");
      await session.restart();
      return c.json({ ok: true, sessionId: id });
    }
    // A backup's body is empty, or asks for the conversation only.
    if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).some(key => key !== "conversationOnly")
      || (input.conversationOnly !== undefined && typeof input.conversationOnly !== "boolean")) throw new RunnerError(400, "Invalid backup request");
    return c.json(await session.backup(ticket, { conversationOnly: input.conversationOnly === true }));
  });
  app.notFound(c => c.json({ error: "Not found" }, 404));
  return app;
}
