import { randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, request as httpRequest, type IncomingMessage, type OutgoingHttpHeaders, type Server, type ServerResponse } from "node:http";
import { connect, type Socket } from "node:net";
import type { Duplex } from "node:stream";
import { TUNNEL_LINK_NAME } from "../../../packages/shared/src/tunnel.js";

export const TUNNEL_GATE_NAME = TUNNEL_LINK_NAME;
export const TUNNEL_FRAME_COOKIE = "pikibun_tunnel_frame";
const COOKIE_SECONDS = 24 * 3600;
const DENIED = "This preview is private: open it with the link its Pikibun session gave you.\n";
const DENIED_FRAMED = "This preview is private, and this browser keeps no cookie for it inside another page: open it in a tab of its own (Open, in the session's App tab).\n";

export function tunnelGateToken(): string {
  return randomBytes(24).toString("base64url");
}

export function gatedLink(url: string, token: string): string {
  return `${url}/?${TUNNEL_GATE_NAME}=${token}`;
}

function same(given: string | undefined, token: string): boolean {
  if (given === undefined) return false;
  const a = Buffer.from(given);
  const b = Buffer.from(token);
  return a.length === b.length && timingSafeEqual(a, b);
}

function cookies(header: string | undefined): { gates: string[]; rest: string | undefined } {
  const gates: string[] = [];
  const rest: string[] = [];
  for (const part of (header ?? "").split(";")) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const equals = trimmed.indexOf("=");
    const name = equals > 0 ? trimmed.slice(0, equals) : "";
    if (name === TUNNEL_GATE_NAME || name === TUNNEL_FRAME_COOKIE) gates.push(trimmed.slice(equals + 1));
    else rest.push(trimmed);
  }
  return { gates, rest: rest.length ? rest.join("; ") : undefined };
}

function framed(request: IncomingMessage): boolean {
  const destination = request.headers["sec-fetch-dest"];
  return destination === "iframe" || destination === "frame";
}

function admissionCookies(request: IncomingMessage, token: string): string[] {
  const lasting = `Path=/; Max-Age=${COOKIE_SECONDS}; HttpOnly; Secure`;
  return [`${TUNNEL_GATE_NAME}=${token}; ${lasting}; SameSite=Lax`,
    ...(framed(request) ? [`${TUNNEL_FRAME_COOKIE}=${token}; ${lasting}; SameSite=None; Partitioned`] : [])];
}

function denied(request: IncomingMessage, response: ServerResponse): void {
  response.writeHead(401, { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" }).end(framed(request) ? DENIED_FRAMED : DENIED);
}

function forwardedHeaders(request: IncomingMessage, cookie: string | undefined): OutgoingHttpHeaders {
  const headers: OutgoingHttpHeaders = {};
  for (let i = 0; i < request.rawHeaders.length; i += 2) {
    const name = request.rawHeaders[i]!;
    if (name.toLowerCase() === "cookie") continue;
    const value = request.rawHeaders[i + 1]!;
    const existing = headers[name];
    headers[name] = existing === undefined ? value : Array.isArray(existing) ? [...existing, value] : [String(existing), value];
  }
  if (cookie) headers.Cookie = cookie;
  return headers;
}

function admitted(request: IncomingMessage, token: string): { cookie: string | undefined } | undefined {
  const { gates, rest } = cookies(request.headers.cookie);
  return gates.some(gate => same(gate, token)) ? { cookie: rest } : undefined;
}

function target(request: IncomingMessage): URL | undefined {
  try { return new URL(`http://tunnel/${(request.url ?? "/").replace(/^[/\\]+/, "")}`); } catch { return undefined; }
}

const pathOf = (url: URL) => `/${url.pathname.replace(/^[/\\]+/, "")}${url.search}`;

export function createTunnelGate(socket: string, token: string, track: (connection: Socket | Duplex) => void): Server {
  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    const url = target(request);
    if (!url) { response.writeHead(400).end(); return; }
    if (url.searchParams.has(TUNNEL_GATE_NAME)) {
      const given = url.searchParams.get(TUNNEL_GATE_NAME) ?? undefined;
      if (!same(given, token)) { denied(request, response); return; }
      url.searchParams.delete(TUNNEL_GATE_NAME);
      response.writeHead(303, {
        Location: pathOf(url),
        "Set-Cookie": admissionCookies(request, token),
        "Cache-Control": "no-store", "Referrer-Policy": "no-referrer",
      }).end();
      return;
    }
    const admission = admitted(request, token);
    if (!admission) { denied(request, response); return; }
    const upstream = httpRequest({ socketPath: socket, method: request.method, path: pathOf(url), headers: forwardedHeaders(request, admission.cookie) }, answer => {
      answer.on("error", () => response.destroy());
      response.writeHead(answer.statusCode ?? 502, answer.statusMessage, answer.rawHeaders);
      answer.pipe(response);
    });
    upstream.on("error", () => { if (!response.headersSent) response.writeHead(502).end(); else response.destroy(); });
    response.on("close", () => { if (!response.writableFinished) upstream.destroy(); });
    request.pipe(upstream);
  });
  server.on("connection", connection => track(connection));
  server.on("upgrade", (request: IncomingMessage, client: Duplex, head: Buffer) => {
    track(client);
    const url = target(request);
    const given = url?.searchParams.get(TUNNEL_GATE_NAME) ?? undefined;
    const admission = given === undefined ? admitted(request, token) : same(given, token) ? { cookie: cookies(request.headers.cookie).rest } : undefined;
    if (url && given !== undefined) url.searchParams.delete(TUNNEL_GATE_NAME);
    if (!admission || !url) { client.end("HTTP/1.1 401 Unauthorized\r\nContent-Type: text/plain; charset=utf-8\r\nConnection: close\r\n\r\n" + DENIED); return; }
    const upstream = connect({ path: socket });
    track(upstream);
    const end = () => { client.destroy(); upstream.destroy(); };
    client.on("error", end).on("close", end);
    upstream.on("error", end).on("close", end);
    upstream.once("connect", () => {
      const headers = forwardedHeaders(request, admission.cookie);
      const lines = [`${request.method} ${pathOf(url)} HTTP/${request.httpVersion}`];
      for (const [name, value] of Object.entries(headers)) for (const item of Array.isArray(value) ? value : [value]) lines.push(`${name}: ${item}`);
      upstream.write(`${lines.join("\r\n")}\r\n\r\n`);
      if (head.length) upstream.write(head);
      client.pipe(upstream);
      upstream.pipe(client);
    });
  });
  return server;
}
