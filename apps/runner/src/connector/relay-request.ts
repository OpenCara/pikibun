import { z } from "zod";
import type { ConnectorRpcRequest } from "../../../../packages/shared/src/connector.js";
import { connectorLimits } from "../../../../packages/shared/src/connector.js";
import { signToken } from "../../../../packages/shared/src/crypto.js";
import type { RunnerAction, RunnerBinding } from "../../../../packages/shared/src/types.js";
import { assertId, verifyRunnerTicket } from "../protocol.js";
import { actorSchema, decodeJson, encoder, IDENTIFIER } from "./wire.js";

export const ticketSchema = z.object({
  aud: z.literal("runner"), sessionId: z.string().regex(IDENTIFIER), actorId: actorSchema, ownerId: actorSchema,
  action: z.enum(["create", "view", "events", "submit", "ask", "backup", "restart", "restore", "stop", "files", "changes", "revert", "fork", "pack", "unpack", "withdraw", "upload", "tunnel", "image", "sudo"]),
  policyVersion: z.number().int().positive(), iat: z.number().int(), exp: z.number().int(),
  jti: z.string().regex(IDENTIFIER), bodyHash: z.string().regex(/^[A-Za-z0-9_-]{43}$/), connectorId: z.string().regex(IDENTIFIER),
}).strict();
export const requestSchema = z.object({
  type: z.literal("request"), id: z.string().regex(IDENTIFIER), method: z.enum(["GET", "POST"]),
  path: z.string().max(512), body: z.string().max(connectorLimits.requestBytes), ticket: ticketSchema,
}).strict();

export async function validateRelayRequest(value: unknown, connectorId: string, verifierSecret: string): Promise<{ rpc: ConnectorRpcRequest; authorization: string }> {
  const rpc = requestSchema.parse(value);
  if (encoder.encode(rpc.body).length > connectorLimits.requestBytes) throw new Error("Invalid relay request");
  let action: RunnerAction;
  let sessionId: string;
  if (rpc.path === "/v1/sessions" && rpc.method === "POST") {
    action = "create";
    let binding: RunnerBinding;
    try { binding = JSON.parse(rpc.body); } catch { throw new Error("Invalid create binding"); }
    sessionId = assertId(binding?.session?.id ?? "");
    if (binding.session.connectorId !== connectorId || binding.model?.connectorId !== connectorId
      || binding.owner?.id !== rpc.ticket?.ownerId || binding.session.ownerId !== rpc.ticket?.ownerId) throw new Error("Foreign connector binding");
  } else {
    const match = /^\/v1\/sessions\/([A-Za-z0-9][A-Za-z0-9_-]{0,127})\/(view|view\/[0-9a-f]{32}|submit|ask|restart|backup|restore|stop|files|revert|fork|pack|unpack|withdraw|upload|tunnel|image|sudo)$/.exec(rpc.path);
    if (!match) throw new Error("Relay path is not allowed");
    sessionId = match[1]!;
    action = match[2]!.startsWith("view/") ? "view" : match[2] as RunnerAction;
    if (rpc.method !== (action === "view" ? "GET" : "POST")) throw new Error("Relay method is not allowed");
    if (action === "restore") {
      const input = decodeJson(encoder.encode(rpc.body)) as { binding?: RunnerBinding };
      if (input.binding?.session?.id !== sessionId || input.binding.session.connectorId !== connectorId
        || input.binding.model?.connectorId !== connectorId || input.binding.owner?.id !== rpc.ticket?.ownerId
        || input.binding.session.ownerId !== rpc.ticket?.ownerId) throw new Error("Foreign restore binding");
    }
  }
  const ticket = rpc.ticket;
  if (ticket.connectorId !== connectorId
    || (rpc.method === "GET" && rpc.body !== "")
    || (["create", "restore", "restart", "fork", "pack", "unpack"].includes(action) && ticket.actorId !== ticket.ownerId)) throw new Error("Invalid relay ticket");
  const authorization = await signToken(ticket, verifierSecret);
  await verifyRunnerTicket(authorization, verifierSecret, action, sessionId, rpc.body);
  return { rpc, authorization };
}
