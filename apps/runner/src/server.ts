import { mkdir, readFile, open, link, unlink, chmod, realpath, lstat, readdir } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { streamSSE } from "hono/streaming";
import type { RunnerAction, RunnerBinding, RunnerTicket, SubmitInput } from "../../../packages/shared/src/types.js";
import type { RestoreDescriptor, RestoreInput } from "../../../packages/shared/src/connector.js";
import { ViewRevisions } from "../../../packages/shared/src/view-patch.js";
import { assertId, permissionFor, RunnerError, stableJson, validateBinding, verifyRunnerTicket } from "./protocol.js";
import { RunnerSession, WORK_MARKER, type RunnerConfig } from "./session.js";
import { restoreSession } from "./restore.js";
import { PACK_FILE, readPack, settlePack, unpackSandbox, writePack, type PackSummary } from "./pack.js";
import { LocalViews } from "./local-view.js";
import type { LocalPage, LocalView } from "./app-host-protocol.js";

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

  async localView(id: string, options: { since?: string; brief?: boolean }): Promise<LocalView> {
    const session = await this.get(id);
    return this.localViews.view(session, await session.view(), options);
  }

  async localEntries(id: string, options: { conversation: string; before: string; limit: number; brief?: boolean }): Promise<LocalPage | null> {
    const session = await this.get(id);
    return this.localViews.entries(await session.view(), options);
  }

  private async openSession(id: string): Promise<RunnerSession> {
    const directory = join(this.dataDir, "sessions", id);
    let binding: RunnerBinding;
    try { binding = this.binding(JSON.parse(await readFile(join(directory, "binding.json"), "utf8")), id); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new RunnerError(404, "Session not found"); throw error; }
    if (await realpath(directory) !== directory) throw new RunnerError(403, "Invalid session storage");
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
    for (const pending of this.sessions.values()) {
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
  const revisions = new WeakMap<object, ViewRevisions>();
  app.use("*", bodyLimit({ maxSize: 1024 * 1024, onError: c => c.json({ error: "Request too large" }, 413) }));
  app.onError((error, c) => {
    if (error instanceof RunnerError) return c.json({ error: error.message }, error.status as 400);
    if (error instanceof SyntaxError) return c.json({ error: "Invalid JSON" }, 400);
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
    const actions: Record<string, RunnerAction> = { submit: "submit", ask: "ask", view: "view", events: "events", restart: "restart", backup: "backup", restore: "restore", stop: "stop", files: "files", revert: "revert", fork: "fork", pack: "pack", unpack: "unpack", withdraw: "withdraw", upload: "upload", tunnel: "tunnel", image: "image" };
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
    if (action === "pack" || action === "unpack") {
      if (body && stableJson(JSON.parse(body)) !== "{}") throw new RunnerError(400, `Invalid ${action} request`);
      const session = await service.get(id);
      if (ticket.ownerId !== session.binding.owner.id) throw new RunnerError(403, "Ticket owner mismatch");
      return c.json(action === "pack" ? await service.pack(id, ticket) : await service.unpack(id, ticket));
    }
    const session = await service.get(id);
    if (ticket.ownerId !== session.binding.owner.id) throw new RunnerError(403, "Ticket owner mismatch");
    if (session.packed && action !== "view" && action !== "events") throw new RunnerError(409, "This session's files are packed. Unarchive it to use them");
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
    if (action === "revert") return c.json(await session.revert(ticket, input));
    if (action === "fork") return c.json(await service.fork(session, ticket, input));
    if (action === "files") {
      if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).some(key => key !== "path")
        || typeof input.path !== "string" || !input.path || input.path.length > 1024) throw new RunnerError(400, "Invalid file browser request");
      return c.json({ files: await session.browse(ticket, input.path) });
    }
    if (action === "upload") return c.json(await session.upload(ticket, input));
    if (action === "image") return c.json(await session.entryImage(ticket, input));
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
