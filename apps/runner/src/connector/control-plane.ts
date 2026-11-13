import { z } from "zod";
import type { ConnectorCredentials, RestoreDescriptor } from "../../../../packages/shared/src/connector.js";
import { connectorLimits } from "../../../../packages/shared/src/connector.js";
import { sha256 } from "../../../../packages/shared/src/crypto.js";
import { bundledToolDefinitions, type ToolDefinition } from "../../../../packages/shared/src/tool-definitions.js";
import type { SessionTunnelReport } from "../../../../packages/shared/src/tunnel.js";
import { sessionActivities, type AuthorizationRequest, type AuthorizationResult, type SessionActivity, type SessionBranch } from "../../../../packages/shared/src/types.js";
import { buildVersion, CONNECTOR_VERSION_HEADER, DEVELOPMENT_CONNECTOR_VERSION } from "../../../../packages/shared/src/version.js";
import { MAX_CLONE_BRANCHES } from "../clone-branches.js";
import { RunnerError } from "../protocol.js";
import { ToolDefinitionsSource } from "../tool-definitions-source.js";
import type { Generation } from "./generation.js";
import { actorSchema, boundedBody, CALLBACK_LIMIT, CallbackRefused, decodeJson, IDENTIFIER, responseSummary, TOKEN } from "./wire.js";

const RPC_TIMEOUT = 30_000;
const TOOL_DEFINITIONS_LIMIT = 1024 * 1024;

export interface ControlPlaneCallsOptions {
  credentials(): ConnectorCredentials;
  settings: { fetch?: typeof fetch; version?: string };
  lifetime: AbortSignal;
  requireGeneration(generation: Generation): void;
  connection(): Promise<Generation>;
}

export class ControlPlaneCalls {
  #toolDefinitionsSource?: ToolDefinitionsSource;

  constructor(private readonly options: ControlPlaneCallsOptions) {}

  #post(generation: Generation, path: string, body: unknown, signal: AbortSignal): Promise<Response> {
    const version = this.options.settings.version ?? buildVersion ?? DEVELOPMENT_CONNECTOR_VERSION;
    return (this.options.settings.fetch ?? fetch)(`${this.options.credentials().controlPlaneUrl}${path}`, {
      method: "POST", redirect: "error", credentials: "omit",
      headers: { authorization: `Bearer ${this.options.credentials().token}`, "x-connection-token": generation.connectionToken!, "content-type": "application/json", accept: "application/json",
        ...(version ? { [CONNECTOR_VERSION_HEADER]: version } : {}) },
      body: JSON.stringify(body), signal,
    });
  }

  async #report(generation: Generation, path: string, body: unknown, unavailable: string): Promise<void> {
    this.options.requireGeneration(generation);
    const response = await this.#post(generation, path, body, AbortSignal.any([generation.abort.signal, this.options.lifetime, AbortSignal.timeout(15_000)]));
    await response.body?.cancel();
    this.options.requireGeneration(generation);
    if (!response.ok && (response.status >= 500 || response.status === 408 || response.status === 429)) throw new Error(unavailable);
  }

  async callbackResponse(generation: Generation, path: string, body: unknown, signal = AbortSignal.any([generation.abort.signal, this.options.lifetime, AbortSignal.timeout(15_000)])): Promise<Response> {
    this.options.requireGeneration(generation);
    const response = await this.#post(generation, path, body, signal);
    try {
      this.options.requireGeneration(generation);
      signal.throwIfAborted();
      if (!response.ok) throw new CallbackRefused(response.status);
    } catch (error) {
      await response.body?.cancel();
      throw error;
    }
    return response;
  }

  async callback(generation: Generation, path: string, body: unknown, limit = CALLBACK_LIMIT): Promise<unknown> {
    const response = await this.callbackResponse(generation, path, body);
    const bytes = await boundedBody(response, limit, AbortSignal.any([generation.abort.signal, AbortSignal.timeout(15_000)]));
    this.options.requireGeneration(generation);
    return bytes.length ? decodeJson(bytes, response) : undefined;
  }

  async brokerCallback(generation: Generation, path: string, body: unknown, limit = CALLBACK_LIMIT): Promise<unknown> {
    this.options.requireGeneration(generation);
    const signal = AbortSignal.any([generation.abort.signal, this.options.lifetime, AbortSignal.timeout(RPC_TIMEOUT)]);
    const response = await this.#post(generation, path, body, signal);
    const bytes = await boundedBody(response, limit, signal);
    this.options.requireGeneration(generation);
    if (!response.ok) {
      let value: unknown;
      try { value = bytes.length ? decodeJson(bytes, response) : undefined; } catch { value = undefined; }
      const error = value && typeof value === "object" && "error" in value ? value.error : undefined;
      throw new RunnerError(response.status, typeof error === "string" && /^[\x20-\x7e\u00a0-\uffff]{1,500}$/.test(error) ? error
        : value === undefined && bytes.length ? `Scoped connector callback denied or unavailable: the Pikibun server, or a proxy in front of it, answered ${responseSummary(response)}`
        : "Scoped connector callback denied or unavailable");
    }
    return bytes.length ? decodeJson(bytes, response) : undefined;
  }

  async authorize(generation: Generation, request: AuthorizationRequest): Promise<AuthorizationResult> {
    const payload = { sessionId: request.sessionId, actorId: request.actorId, ownerId: request.ownerId, permission: request.permission, ...(request.host ? { host: true } : {}),
      ...(request.host && request.hostSessions ? { hostSessions: true } : {}), ...(request.archived ? { archived: true } : {}) };
    const result = z.object({
      allowed: z.boolean(), ownerId: actorSchema, policyVersion: z.number().int().positive(), hostCommands: z.enum(["approve", "auto"]).optional().transform(level => level && "auto" as const),
      hostSessions: z.literal(true).optional(),
    }).strict().parse(await this.callback(generation, "/api/connectors/self/authorize", payload));
    if (result.ownerId !== request.ownerId) throw new Error("Invalid authorization response");
    return result;
  }

  async reportActivity(generation: Generation, sessionId: string, activity: SessionActivity): Promise<void> {
    if (!IDENTIFIER.test(sessionId) || !sessionActivities.includes(activity)) throw new Error("Invalid activity report");
    await this.#report(generation, "/api/connectors/self/activity", { sessionId, activity }, "Activity report unavailable");
  }

  async reportTunnel(generation: Generation, report: SessionTunnelReport): Promise<void> {
    if (!IDENTIFIER.test(report.sessionId)) throw new Error("Invalid tunnel report");
    await this.#report(generation, "/api/connectors/self/tunnel", report, "Tunnel report unavailable");
  }

  async reportBranches(generation: Generation, sessionId: string, branches: SessionBranch[]): Promise<void> {
    if (!IDENTIFIER.test(sessionId) || branches.length > MAX_CLONE_BRANCHES) throw new Error("Invalid branch report");
    await this.#report(generation, "/api/connectors/self/branches", { sessionId, branches: branches.map(({ repository, branch }) => ({ repository, branch })) }, "Branch report unavailable");
  }

  async readBackup(generation: Generation, restore: RestoreDescriptor, targetSessionId: string): Promise<Uint8Array> {
    const ids = [restore.id, restore.sourceSessionId, restore.backupId, targetSessionId];
    if (ids.some(id => typeof id !== "string" || !IDENTIFIER.test(id))
      || typeof restore.downloadToken !== "string" || !TOKEN.test(restore.downloadToken)
      || typeof restore.sha256 !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(restore.sha256)
      || !Number.isSafeInteger(restore.size) || restore.size < 1 || restore.size > connectorLimits.responseBytes) throw new Error("Invalid restore descriptor");
    const response = await this.callbackResponse(generation, `/api/connectors/self/restores/${restore.id}/download`, {
      targetSessionId, sourceSessionId: restore.sourceSessionId, backupId: restore.backupId, downloadToken: restore.downloadToken,
    });
    const bytes = await boundedBody(response, restore.size, AbortSignal.any([generation.abort.signal, AbortSignal.timeout(15_000)]));
    this.options.requireGeneration(generation);
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    if (bytes.length !== restore.size || response.headers.get("x-backup-sha256") !== restore.sha256 || await sha256(text) !== restore.sha256) throw new Error("Backup integrity mismatch");
    return bytes;
  }

  async toolDefinitions(): Promise<readonly ToolDefinition[]> {
    this.#toolDefinitionsSource ??= new ToolDefinitionsSource(async () =>
      this.callback(await this.options.connection(), "/api/connectors/self/tools", {}, TOOL_DEFINITIONS_LIMIT));
    return await this.#toolDefinitionsSource.get() ?? bundledToolDefinitions;
  }
}
