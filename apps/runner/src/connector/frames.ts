import { Buffer } from "node:buffer";
import { setTimeout as delay } from "node:timers/promises";
import type { ConnectorCredentials, ConnectorRpcRequest, ConnectorRpcResponse } from "../../../../packages/shared/src/connector.js";
import { connectorLimits, connectorRequestTimeoutMs } from "../../../../packages/shared/src/connector.js";
import type { ControlPlaneCalls } from "./control-plane.js";
import type { Generation } from "./generation.js";
import { requestSchema, ticketSchema, validateRelayRequest } from "./relay-request.js";
import { boundedBody, encoder } from "./wire.js";
import { describeFailure, stderrLine, type LogLine } from "../failure-log.js";

const DRAIN_TIMEOUT = 30_000;
const REPLAY_KEYS_LIMIT = 8192;

type Frame = { payload: string; payloadSize: number };

export interface RelayRuntime {
  fetch(request: Request): Response | Promise<Response>;
}

export interface RelayFramesOptions {
  secret: string;
  state(): ConnectorCredentials | undefined;
  restarting(): boolean;
  runtime(): RelayRuntime | undefined;
  welcomed(): Generation | undefined;
  calls: Pick<ControlPlaneCalls, "callback">;
  disconnect(generation: Generation, reason: string): void;
  requireGeneration(generation: Generation): void;
  log?: LogLine;
}

export class RelayFrames {
  readonly #relayed = new Map<string, number>();
  readonly #uploaded = new Map<string, number>();
  readonly #executing = new Set<Promise<void>>();

  constructor(private readonly options: RelayFramesOptions) {}

  async settled(): Promise<void> {
    await Promise.allSettled([...this.#executing]);
  }

  #claim(seen: Map<string, number>, rpc: ConnectorRpcRequest): "claimed" | "replayed" | "full" {
    const now = Date.now();
    const all = [this.#relayed, this.#uploaded];
    for (const each of all) for (const [key, expiry] of each) if (expiry <= now) each.delete(key);
    const keys = [`request:${rpc.id}`, `ticket:${rpc.ticket.jti}`];
    if (keys.some(key => all.some(each => each.has(key)))) return "replayed";
    if (seen.size > REPLAY_KEYS_LIMIT) return "full";
    const expiry = Math.min((rpc.ticket.exp + 5) * 1000, now + 70_000);
    for (const key of keys) seen.set(key, expiry);
    return "claimed";
  }

  dispatch(generation: Generation, value: unknown, frameSize: number): void {
    if (generation.active.size >= connectorLimits.pendingRequests) return this.options.disconnect(generation, "Relay exceeded the pending request limit");
    if (generation.incomingBytes + frameSize > connectorLimits.bufferedBytes) return this.options.disconnect(generation, "Relay exceeded the queued request byte limit");
    const parsed = requestSchema.safeParse(value);
    if (!parsed.success) return this.options.disconnect(generation, "Invalid relay request");
    const rpc = parsed.data;
    const claim = this.#claim(this.#relayed, rpc);
    if (claim !== "claimed") return this.options.disconnect(generation, claim === "full" ? "Relay exceeded the recent request limit" : "Replayed relay request");
    generation.incomingBytes += frameSize;
    const previous = generation.tail;
    const task = this.#execute(generation, rpc, previous).catch((error: unknown) => {
      const message = error instanceof Error && /^[A-Za-z][A-Za-z ]{0,119}$/.test(error.message) ? error.message : "";
      this.options.disconnect(generation, message ? `Relay request failed: ${message}` : "Relay request failed");
    }).finally(() => {
      generation.active.delete(task);
      generation.incomingBytes -= frameSize;
    });
    generation.tail = Promise.all([previous, task]).then(() => {});
    generation.active.add(task);
  }

  async #execute(generation: Generation, value: ConnectorRpcRequest, previous: Promise<void>): Promise<void> {
    const { rpc, authorization } = await validateRelayRequest(value, this.options.state()!.connectorId, this.options.secret);
    this.options.requireGeneration(generation);
    if (this.options.restarting()) return this.#send(generation, this.#restartingFrame(rpc));
    const interrupt = Promise.withResolvers<"restarting">();
    generation.waiting.add(interrupt);
    let woke: "ready" | "restarting";
    try {
      woke = await Promise.race([Promise.all([previous, generation.runtimeReady.promise]).then(() => "ready" as const), interrupt.promise]);
    } finally {
      generation.waiting.delete(interrupt);
    }
    this.options.requireGeneration(generation);
    if (woke === "restarting") return this.#send(generation, this.#restartingFrame(rpc));
    await this.#send(generation, await this.#answer(generation, rpc, authorization));
  }

  async #send(generation: Generation, { payload, payloadSize }: Frame): Promise<void> {
    const drained = Date.now() + DRAIN_TIMEOUT;
    while (generation.socket.bufferedAmount + payloadSize > connectorLimits.bufferedBytes) {
      if (Date.now() >= drained) return this.options.disconnect(generation, "Socket output did not drain within 30s");
      await delay(10, undefined, { signal: generation.abort.signal });
      this.options.requireGeneration(generation);
    }
    generation.socket.send(payload);
  }

  async #answer(generation: Generation, rpc: ConnectorRpcRequest, authorization: string): Promise<Frame> {
    if (rpc.ticket.exp * 1000 <= Date.now()) return this.#errorFrame(rpc, 504, "The request waited too long on the host; inspect the session before retrying.");
    const work = this.#reply(generation, rpc, authorization);
    const executing = work.then(() => {}, () => {});
    this.#executing.add(executing);
    void executing.finally(() => this.#executing.delete(executing));
    let timer: NodeJS.Timeout | undefined;
    const expired = new Promise<Frame>(resolve => {
      timer = setTimeout(() => resolve(this.#errorFrame(rpc, 504, "The host did not answer in time; inspect the session before retrying.")), connectorRequestTimeoutMs(rpc.ticket.action));
    });
    try { return await Promise.race([work, expired]); }
    finally { clearTimeout(timer); }
  }

  #restartingFrame(rpc: ConnectorRpcRequest): Frame {
    return this.#errorFrame(rpc, 503, "The host's runner is restarting; try again shortly.");
  }

  #errorFrame(rpc: ConnectorRpcRequest, status: number, error: string): Frame {
    const payload = JSON.stringify({
      type: "response", id: rpc.id, status, body: JSON.stringify({ error, code: "connector_reply_error" }),
    } satisfies ConnectorRpcResponse);
    return { payload, payloadSize: Buffer.byteLength(payload, "utf8") };
  }

  async #reply(generation: Generation, rpc: ConnectorRpcRequest, authorization: string): Promise<Frame> {
    const frame = (payload: string) => ({ payload, payloadSize: Buffer.byteLength(payload, "utf8") });
    const failed = (status: number, error: string) => this.#errorFrame(rpc, status, error);
    const runtime = this.options.runtime();
    if (!runtime) return failed(503, "The host's runner is restarting; try again.");
    let result: ConnectorRpcResponse;
    try {
      const response = await runtime.fetch(new Request(`http://local.invalid${rpc.path}`, {
        method: rpc.method, headers: { authorization: `Bearer ${authorization}`, "content-type": "application/json" },
        ...(rpc.method === "POST" ? { body: rpc.body } : {}), signal: generation.abort.signal,
      }));
      let bytes: Uint8Array;
      try { bytes = await boundedBody(response, connectorLimits.responseBytes, generation.abort.signal); }
      catch (error) {
        this.options.requireGeneration(generation);
        if (error instanceof Error && error.message === "Response exceeds connector limit") return failed(502, "The host's reply is too large to relay.");
        throw error;
      }
      result = { type: "response", id: rpc.id, status: response.status, body: new TextDecoder("utf-8", { fatal: true }).decode(bytes) };
    } catch (error) {
      this.options.requireGeneration(generation);
      (this.options.log ?? stderrLine)(`Relay request ${rpc.method} ${rpc.path.slice(0, 300)} failed: ${describeFailure(error)}`);
      return failed(502, "The host could not complete the request.");
    }
    this.options.requireGeneration(generation);
    const reply = frame(JSON.stringify(result));
    if (reply.payloadSize > connectorLimits.frameBytes) return failed(502, "The host's reply is too large to relay.");
    return reply;
  }

  async direct(input: { grant: string; body: string }): Promise<{ status: number; body: string }> {
    const refused = (status: number, error: string) => ({ status, body: JSON.stringify({ error, code: "connector_reply_error" }) });
    const generation = this.options.welcomed();
    const state = this.options.state();
    if (!state || !generation || generation.abort.signal.aborted || !generation.connectionToken) return refused(503, "The host is not connected.");
    if (typeof input?.grant !== "string" || input.grant.length > 16_384 || typeof input.body !== "string"
      || encoder.encode(input.body).length > connectorLimits.requestBytes) return refused(400, "Invalid upload request.");
    let verified: { ticket: ConnectorRpcRequest["ticket"]; size: number; path: string };
    try {
      const value = await this.options.calls.callback(generation, "/api/connectors/self/uploads/verify", { grant: input.grant }) as Record<string, unknown> | undefined;
      const ticket = ticketSchema.parse(value?.ticket);
      if (ticket.action !== "upload" || ticket.connectorId !== state.connectorId || !Number.isSafeInteger(value?.size)
        || value?.path !== `/v1/sessions/${ticket.sessionId}/upload`) throw new Error("Invalid upload grant");
      verified = { ticket, size: value.size as number, path: value.path };
    } catch { return refused(403, "The control plane refused the upload grant."); }
    let declared: unknown;
    try { declared = (JSON.parse(input.body) as { size?: unknown } | null)?.size; } catch { declared = undefined; }
    if (declared !== verified.size) return refused(400, "The upload doesn't match its grant.");
    const rpc: ConnectorRpcRequest = { type: "request", id: verified.ticket.jti, method: "POST", path: verified.path, body: input.body, ticket: verified.ticket };
    const claim = this.#claim(this.#uploaded, rpc);
    if (claim === "replayed") return refused(409, "That upload grant was already used.");
    if (claim === "full") return refused(503, "The host is taking too many requests at once; try again shortly.");
    let authorization: string;
    try { ({ authorization } = await validateRelayRequest(rpc, state.connectorId, this.options.secret)); }
    catch { return refused(400, "Invalid upload request."); }
    if (this.options.restarting()) return refused(503, "The host's runner is restarting; try again shortly.");
    try {
      await generation.runtimeReady.promise;
      const { payload } = await this.#answer(generation, rpc, authorization);
      const reply = JSON.parse(payload) as ConnectorRpcResponse;
      return { status: reply.status, body: reply.body };
    } catch { return refused(503, "The host lost its connection; inspect the session before retrying."); }
  }
}
