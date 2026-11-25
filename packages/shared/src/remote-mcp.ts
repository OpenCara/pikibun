import { sanitizeInputSchema, type InputSchema } from "./input-schema.js";
import { reservedToolNames, type BrokeredToolDefinition } from "./tool-definitions.js";

export const REMOTE_MCP_EXTENSION = "piki:remote-mcp";

export const remoteMcpLimits = Object.freeze({
  servers: 8, connections: 32, tools: 64, headers: 8, headerName: 64, headerValue: 4096, url: 2048, name: 64, description: 2048,
  discoverSeconds: 15, callSeconds: 60, responseBytes: 1024 * 1024, listBytes: 8 * 1024 * 1024, resultCharacters: 64 * 1024,
});

export interface RemoteMcpToolsLeftOut { overLimit: number; unusable: number }

export interface RemoteMcpHttpRequest { url: string; method?: "GET" | "POST"; headers: Record<string, string>; body: string; timeoutMs: number; maxBytes: number; expectId?: number }
export interface RemoteMcpHttpResponse { status: number; headers: Record<string, string>; body: string }
export type RemoteMcpTransport = (request: RemoteMcpHttpRequest) => Promise<RemoteMcpHttpResponse>;

export interface RemoteMcpTool {
  name: string;
  description: string;
  inputSchema: InputSchema;
  readOnlyHint?: boolean;
}

export const remoteMcpSignInAsValues = ["workspace", "members", "members-then-workspace"] as const;
export type RemoteMcpSignInAs = typeof remoteMcpSignInAsValues[number];

export function isRemoteMcpSignInAs(value: unknown): value is RemoteMcpSignInAs {
  return typeof value === "string" && (remoteMcpSignInAsValues as readonly string[]).includes(value);
}

export const remoteMcpSignInAsOptions: readonly { value: RemoteMcpSignInAs; label: string; hint: string }[] = Object.freeze([
  { value: "workspace", label: "The workspace's sign-in", hint: "Every member's sessions call it with the sign-in kept here, as one account" },
  { value: "members", label: "Each member's own", hint: "Each request uses the requester's own connection, which they connect in their profile and bring here; without one, its tools don't run for them" },
  { value: "members-then-workspace", label: "Each member's own, else the workspace's", hint: "The requester's own connection where they brought one here, else the sign-in kept here" },
]);

export interface McpConnectionUse { id: string; name: string; using: boolean; signedIn: boolean; error?: string }

export interface WorkspaceMcpServer {
  id: string;
  name: string;
  prefix: string;
  url: string;
  enabled: boolean;
  signInAs: RemoteMcpSignInAs;
  headerNames: string[];
  oauth?: { signedInAt: string };
  connection?: McpConnectionUse;
  readOnlyTools: string[];
  tools: (RemoteMcpTool & { toolName: string; readOnly: boolean })[];
  toolsLeftOut?: RemoteMcpToolsLeftOut;
  discoveredAt?: string;
  error?: string;
  updatedAt: string;
}

export interface McpConnection {
  id: string;
  name: string;
  url: string;
  headerNames: string[];
  oauth?: { signedInAt: string };
  error?: string;
  workspaces: { id: string; name: string }[];
  offeredIn: { id: string; name: string }[];
  createdAt: string;
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

export type RemoteMcpSignInMethod = "oauth" | "token" | "basic" | "header" | "none";

export type RemoteMcpSignIn =
  | { method: "oauth" | "none" }
  | { method: "token"; token: string }
  | { method: "basic"; username: string; password: string }
  | { method: "header"; name: string; value: string };

export const remoteMcpSignInMethods: readonly { value: RemoteMcpSignInMethod; label: string; hint: string }[] = Object.freeze([
  { value: "oauth", label: "OAuth", hint: "Sign in on the server's own page with Sign in once it's added. The server must offer OAuth with dynamic client registration" },
  { value: "token", label: "Token", hint: "An API key or personal access token, sent as Authorization: Bearer <token>" },
  { value: "basic", label: "Username and password", hint: "Sent as Authorization: Basic, HTTP basic authentication" },
  { value: "header", label: "Custom header", hint: "Any header the server asks for, such as X-API-Key" },
  { value: "none", label: "None", hint: "A public server that needs no sign-in" },
]);

function base64(value: string): string {
  let binary = "";
  for (const byte of new TextEncoder().encode(value)) binary += String.fromCharCode(byte);
  return btoa(binary);
}

export function remoteMcpSignInHeaders(signIn: RemoteMcpSignIn): Record<string, string> {
  switch (signIn.method) {
    case "oauth":
    case "none":
      return {};
    case "token": {
      const token = signIn.token.trim().replace(/^Bearer\s+/i, "");
      if (!token) throw new Error("Give the token");
      return remoteMcpHeaders({ Authorization: `Bearer ${token}` });
    }
    case "basic": {
      const username = signIn.username.trim();
      if (!username) throw new Error("Give the username");
      if (username.includes(":")) throw new Error("A username for basic authentication can't hold a colon");
      if (!signIn.password) throw new Error("Give the password");
      return remoteMcpHeaders({ Authorization: `Basic ${base64(`${username}:${signIn.password}`)}` });
    }
    case "header": {
      const name = signIn.name.trim();
      if (!name) throw new Error("Give the header's name");
      if (!signIn.value) throw new Error("Give the header's value");
      return remoteMcpHeaders({ [name]: signIn.value });
    }
  }
}

export function remoteMcpSignInOf(server: Pick<WorkspaceMcpServer, "oauth" | "headerNames">): RemoteMcpSignInMethod {
  if (server.oauth) return "oauth";
  if (!server.headerNames.length) return "none";
  return server.headerNames.some(name => name.toLowerCase() === "authorization") ? "token" : "header";
}

export const REMOTE_MCP_APP_LINK = "pikibun://mcp/sign-in";
const APP_SIGN_IN_CODE = /^[A-Za-z0-9_-]{43}$/;

export function remoteMcpAppLink(server: string, code: string): string {
  return `${REMOTE_MCP_APP_LINK}?${new URLSearchParams({ server, code }).toString()}`;
}

export function parseRemoteMcpAppCode(input: string): { server: string | null; code: string } | null {
  const text = input.trim();
  if (APP_SIGN_IN_CODE.test(text)) return { server: null, code: text };
  let url: URL;
  try { url = new URL(text); } catch { return null; }
  if (`${url.protocol}//${url.host}${url.pathname}` !== REMOTE_MCP_APP_LINK) return null;
  const code = url.searchParams.get("code") ?? "";
  return APP_SIGN_IN_CODE.test(code) ? { server: url.searchParams.get("server"), code } : null;
}

export function remoteMcpToolList(value: unknown): { tools: RemoteMcpTool[]; leftOut: RemoteMcpToolsLeftOut } {
  if (!Array.isArray(value)) throw new Error("tools/list answered without tools");
  const tools: RemoteMcpTool[] = [];
  const leftOut: RemoteMcpToolsLeftOut = { overLimit: 0, unusable: 0 };
  for (const item of value) {
    if (!item || typeof item !== "object" || Array.isArray(item)) { leftOut.unusable++; continue; }
    const tool = item as { name?: unknown; description?: unknown; inputSchema?: unknown; annotations?: { readOnlyHint?: unknown } };
    if (typeof tool.name === "string" && tools.some(other => other.name === tool.name)) continue;
    if (typeof tool.name !== "string" || !MCP_TOOL.test(tool.name)) { leftOut.unusable++; continue; }
    const inputSchema = sanitizeInputSchema(tool.inputSchema ?? { type: "object" });
    if (!inputSchema) { leftOut.unusable++; continue; }
    if (tools.length >= remoteMcpLimits.tools) { leftOut.overLimit++; continue; }
    const description = typeof tool.description === "string" ? tool.description.slice(0, remoteMcpLimits.description) : "";
    tools.push({ name: tool.name, description, inputSchema,
      ...(typeof tool.annotations?.readOnlyHint === "boolean" ? { readOnlyHint: tool.annotations.readOnlyHint } : {}) });
  }
  return { tools, leftOut };
}

export function remoteMcpLeftOutNote(leftOut: RemoteMcpToolsLeftOut | undefined): string {
  if (!leftOut || (!leftOut.overLimit && !leftOut.unusable)) return "";
  const count = (n: number) => `${n} ${n === 1 ? "tool" : "tools"}`;
  const parts = [
    ...(leftOut.overLimit ? [`${count(leftOut.overLimit)} past the ${remoteMcpLimits.tools} Pikibun offers from one server`] : []),
    ...(leftOut.unusable ? [`${count(leftOut.unusable)} whose names or input schemas Pikibun can't offer`] : []),
  ];
  return `Left out ${parts.join(" and ")}.`;
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
