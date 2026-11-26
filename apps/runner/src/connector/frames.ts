import { Buffer } from "node:buffer";
import { setTimeout as delay } from "node:timers/promises";
import type { ConnectorCredentials, ConnectorRpcRequest, ConnectorRpcResponse } from "../../../../packages/shared/src/connector.js";
import { connectorLimits, connectorRequestTimeoutMs } from "../../../../packages/shared/src/connector.js";
import { parsePrivateForwardRequest, type PrivateForwardRequest, type PrivateForwardResponse } from "../../../../packages/shared/src/private-sessions.js";
import { parseHostDirectoriesRequest, type HostDirectoriesRequest, type HostDirectoryListing } from "../../../../packages/shared/src/host-directory.js";
import type { Generation } from "./generation.js";
import { requestSchema, validateRelayRequest } from "./relay-request.js";
import { boundedBody } from "./wire.js";
import { FailureLog, type LogLine } from "../failure-log.js";

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
  privateForward?(request: PrivateForwardRequest, signal: AbortSignal): Promise<PrivateForwardResponse>;
  hostDirectories?(request: HostDirectoriesRequest): Promise<HostDirectoryListing>;
  disconnect(generation: Generation, reason: string): void;
  requireGeneration(generation: Generation): void;
  log?: LogLine;
}

export class RelayFrames {
  readonly #relayed = new Map<string, number>();
  readonly #executing = new Set<Promise<void>>();
  readonly #failures: FailureLog;

  constructor(private readonly options: RelayFramesOptions) {
    this.#failures = new FailureLog(options.log);
  }

  async settled(): Promise<void> {
    await Promise.allSettled([...this.#executing]);
  }

  #claim(rpc: ConnectorRpcRequest): "claimed" | "replayed" | "full" {
    const now = Date.now();
    const seen = this.#relayed;
    for (const [key, expiry] of seen) if (expiry <= now) seen.delete(key);
    const keys = [`request:${rpc.id}`, `ticket:${rpc.ticket.jti}`];
    if (keys.some(key => seen.has(key))) return "replayed";
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
    const claim = this.#claim(rpc);
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
    if (rpc.ticket.action === "private") return this.#forward(generation, rpc);
    if (rpc.ticket.action === "directories") return this.#directories(generation, rpc);
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
      this.#failures.report(`Relay request ${rpc.method} ${rpc.path} failed`, error);
      return failed(502, "The host could not complete the request.");
    }
    this.options.requireGeneration(generation);
    const reply = frame(JSON.stringify(result));
    if (reply.payloadSize > connectorLimits.frameBytes) return failed(502, "The host's reply is too large to relay.");
    return reply;
  }

  async #directories(generation: Generation, rpc: ConnectorRpcRequest): Promise<Frame> {
    const list = this.options.hostDirectories;
    let request: HostDirectoriesRequest | null = null;
    try { request = parseHostDirectoriesRequest(JSON.parse(rpc.body)); } catch { request = null; }
    if (!request) return this.#errorFrame(rpc, 400, "That isn't a directory of this host.");
    if (!list) return this.#errorFrame(rpc, 503, "This host doesn't list its directories.");
    let directories: HostDirectoryListing;
    try { directories = await list(request); }
    catch (error) {
      this.options.requireGeneration(generation);
      this.#failures.report("Listing a host directory failed", error);
      return this.#errorFrame(rpc, 502, "The host could not list that directory.");
    }
    this.options.requireGeneration(generation);
    const payload = JSON.stringify({ type: "response", id: rpc.id, status: 200, body: JSON.stringify({ directories }) } satisfies ConnectorRpcResponse);
    const size = Buffer.byteLength(payload, "utf8");
    if (size > connectorLimits.frameBytes) return this.#errorFrame(rpc, 502, "The reply is too large to relay.");
    return { payload, payloadSize: size };
  }

  async #forward(generation: Generation, rpc: ConnectorRpcRequest): Promise<Frame> {
    const forward = this.options.privateForward;
    let request: PrivateForwardRequest | null = null;
    try { request = parsePrivateForwardRequest(JSON.parse(rpc.body)); } catch { request = null; }
    if (!request) return this.#errorFrame(rpc, 400, "That request isn't one a computer forwards for its private sessions.");
    if (!forward) return this.#errorFrame(rpc, 503, "This computer doesn't run the Pikibun that holds its private sessions.");
    let answer: PrivateForwardResponse;
    try { answer = await forward(request, generation.abort.signal); }
    catch (error) {
      this.options.requireGeneration(generation);
      this.#failures.report(`Private request ${request.method} ${request.path.split("?")[0]} failed`, error);
      return this.#errorFrame(rpc, 503, "The Pikibun on this computer, which holds its private sessions, isn't answering yet. Try again shortly.");
    }
    this.options.requireGeneration(generation);
    const payload = JSON.stringify({ type: "response", id: rpc.id, status: 200, body: JSON.stringify(answer) } satisfies ConnectorRpcResponse);
    const size = Buffer.byteLength(payload, "utf8");
    if (size > connectorLimits.frameBytes || answer.data.length > connectorLimits.responseBytes) return this.#errorFrame(rpc, 502, "The reply is too large to relay.");
    return { payload, payloadSize: size };
  }
}
