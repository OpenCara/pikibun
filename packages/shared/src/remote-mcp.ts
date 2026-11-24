import { sanitizeInputSchema, type InputSchema } from "./input-schema.js";
import { reservedToolNames, type BrokeredToolDefinition } from "./tool-definitions.js";

export const REMOTE_MCP_EXTENSION = "piki:remote-mcp";

export const remoteMcpLimits = Object.freeze({
  servers: 8, tools: 64, headers: 8, headerName: 64, headerValue: 4096, url: 2048, name: 64, description: 2048,
  discoverSeconds: 15, callSeconds: 60, responseBytes: 1024 * 1024, resultCharacters: 64 * 1024,
});

export interface RemoteMcpHttpRequest { url: string; method?: "GET" | "POST"; headers: Record<string, string>; body: string; timeoutMs: number; maxBytes: number; expectId?: number }
export interface RemoteMcpHttpResponse { status: number; headers: Record<string, string>; body: string }
export type RemoteMcpTransport = (request: RemoteMcpHttpRequest) => Promise<RemoteMcpHttpResponse>;

export interface RemoteMcpTool {
  name: string;
  description: string;
  inputSchema: InputSchema;
  readOnlyHint?: boolean;
}

export interface WorkspaceMcpServer {
  id: string;
  name: string;
  prefix: string;
  url: string;
  enabled: boolean;
  headerNames: string[];
  oauth?: { signedInAt: string };
  readOnlyTools: string[];
  tools: (RemoteMcpTool & { toolName: string; readOnly: boolean })[];
  discoveredAt?: string;
  error?: string;
  updatedAt: string;
}

export interface RemoteMcpServerSummary {
  prefix: string;
  name: string;
}

const PREFIX = /^[a-z][a-z0-9]{0,15}$/;
const HEADER = /^[A-Za-z0-9!#$%&'*+.^_`|~-]{1,64}$/;
const forbiddenHeaders = new Set(["host", "content-length", "content-type", "accept", "connection", "transfer-encoding", "cookie", "mcp-session-id",
  "mcp-protocol-version", "upgrade", "te", "trailer", "proxy-authorization", "keep-alive", "expect"]);
const MCP_TOOL = /^[A-Za-z0-9_.\-/]{1,128}$/;

export function validRemoteMcpPrefix(value: unknown): value is string {
  return typeof value === "string" && PREFIX.test(value);
}

export function remoteMcpRoutePrefix(route: string): string | undefined {
  const prefix = /^mcp\/([^/]+)\/[^/]+$/.exec(route)?.[1];
  return validRemoteMcpPrefix(prefix) ? prefix : undefined;
}

export function parseRemoteMcpServers(value: unknown): RemoteMcpServerSummary[] {
  if (!Array.isArray(value)) throw new Error("remoteServers must be a list");
  const servers: RemoteMcpServerSummary[] = [];
  for (const item of value.slice(0, 64)) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const { prefix, name } = item as { prefix?: unknown; name?: unknown };
    if (!validRemoteMcpPrefix(prefix) || typeof name !== "string" || servers.some(other => other.prefix === prefix)) continue;
    const line = name.replace(/[\x00-\x1f\x7f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, remoteMcpLimits.name);
    servers.push({ prefix, name: line || prefix });
  }
  return servers;
}

export function remoteMcpUrl(value: unknown): string {
  if (typeof value !== "string" || value.length > remoteMcpLimits.url) throw new Error("url must be an https:// address of at most 2048 characters");
  let url: URL;
  try { url = new URL(value); } catch { throw new Error("url must be an https:// address"); }
  if (url.protocol !== "https:" || url.username || url.password || url.hash) throw new Error("url must be an https:// address without credentials or a fragment");
  return url.href;
}

export function remoteMcpHeaders(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("headers must be an object of header names and values");
  const entries = Object.entries(value);
  if (entries.length > remoteMcpLimits.headers) throw new Error(`At most ${remoteMcpLimits.headers} headers`);
  const headers: Record<string, string> = {};
  for (const [name, header] of entries) {
    if (!HEADER.test(name) || forbiddenHeaders.has(name.toLowerCase())) throw new Error(`${name.slice(0, 64)} can't be set as a header`);
    if (typeof header !== "string" || !header || header.length > remoteMcpLimits.headerValue || /[\r\n\0]/.test(header)) {
      throw new Error(`The value of ${name} must be one line of at most ${remoteMcpLimits.headerValue} characters`);
    }
    headers[name] = header;
  }
  return headers;
}

export function remoteMcpToolList(value: unknown): RemoteMcpTool[] {
  if (!Array.isArray(value)) throw new Error("tools/list answered without tools");
  const tools: RemoteMcpTool[] = [];
  for (const item of value) {
    if (tools.length >= remoteMcpLimits.tools) break;
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const tool = item as { name?: unknown; description?: unknown; inputSchema?: unknown; annotations?: { readOnlyHint?: unknown } };
    if (typeof tool.name !== "string" || !MCP_TOOL.test(tool.name) || tools.some(other => other.name === tool.name)) continue;
    const inputSchema = sanitizeInputSchema(tool.inputSchema ?? { type: "object" });
    if (!inputSchema) continue;
    const description = typeof tool.description === "string" ? tool.description.slice(0, remoteMcpLimits.description) : "";
    tools.push({ name: tool.name, description, inputSchema,
      ...(typeof tool.annotations?.readOnlyHint === "boolean" ? { readOnlyHint: tool.annotations.readOnlyHint } : {}) });
  }
  return tools;
}

export function remoteMcpToolKey(name: string): string {
  let a = 0x811c9dc5;
  let b = 0x01000193;
  for (let index = 0; index < name.length; index++) {
    const code = name.charCodeAt(index);
    a = Math.imul(a ^ code, 0x01000193) >>> 0;
    b = Math.imul(b ^ code, 0x5bd1e995) >>> 0;
  }
  return a.toString(16).padStart(8, "0") + b.toString(16).padStart(8, "0");
}

export function remoteMcpToolName(prefix: string, tool: string): string | undefined {
  const tail = tool.toLowerCase().replace(/[^a-z0-9_]+/g, "_").replace(/_+/g, "_").replace(/^_|_$/g, "");
  const name = `${prefix}_${tail}`.slice(0, 64).replace(/_$/, "");
  return /^[a-z][a-z0-9_]{0,63}$/.test(name) && tail && !reservedToolNames.includes(name) ? name : undefined;
}

export function remoteMcpDefinitions(server: { name: string; prefix: string; readOnlyTools: readonly string[]; tools: readonly RemoteMcpTool[] }): BrokeredToolDefinition[] {
  const definitions: BrokeredToolDefinition[] = [];
  for (const tool of server.tools) {
    const name = remoteMcpToolName(server.prefix, tool.name);
    if (!name || definitions.some(other => other.name === name)) continue;
    const readOnly = server.readOnlyTools.includes(tool.name);
    const label = `From the workspace's remote MCP server ${server.name} (${tool.name}), called through Pikibun with credentials no session sees`
      + `${readOnly ? "; its owners marked it read-only" : "; it may change things, so Read-only messages don't run it"}.`;
    definitions.push({
      kind: "brokered", name, extensions: [REMOTE_MCP_EXTENSION],
      description: `${tool.description.trim() ? `${tool.description.trim().slice(0, 4096 - label.length - 2)} ` : ""}${label}`,
      parameters: {}, target: [], route: `mcp/${server.prefix}/${remoteMcpToolKey(tool.name)}`, write: !readOnly, inputSchema: tool.inputSchema,
    });
  }
  return definitions;
}
