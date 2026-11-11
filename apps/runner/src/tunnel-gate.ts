import { randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, request as httpRequest, type IncomingMessage, type OutgoingHttpHeaders, type Server, type ServerResponse } from "node:http";
import { connect, type Socket } from "node:net";
import type { Duplex } from "node:stream";

export const TUNNEL_GATE_NAME = "pikibun_tunnel";
const COOKIE_SECONDS = 24 * 3600;
const DENIED = "This preview is private: open it with the link its Pikibun session gave you.\n";

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

function cookies(header: string | undefined): { gate: string | undefined; rest: string | undefined } {
  let gate: string | undefined;
  const rest: string[] = [];
  for (const part of (header ?? "").split(";")) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const equals = trimmed.indexOf("=");
    if (equals > 0 && trimmed.slice(0, equals) === TUNNEL_GATE_NAME) gate = trimmed.slice(equals + 1);
    else rest.push(trimmed);
  }
  return { gate, rest: rest.length ? rest.join("; ") : undefined };
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
  const { gate, rest } = cookies(request.headers.cookie);
  return same(gate, token) ? { cookie: rest } : undefined;
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
      if (!same(given, token)) { response.writeHead(401, { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" }).end(DENIED); return; }
      url.searchParams.delete(TUNNEL_GATE_NAME);
      response.writeHead(303, {
        Location: pathOf(url),
        "Set-Cookie": `${TUNNEL_GATE_NAME}=${token}; Path=/; Max-Age=${COOKIE_SECONDS}; HttpOnly; Secure; SameSite=Lax`,
        "Cache-Control": "no-store", "Referrer-Policy": "no-referrer",
      }).end();
      return;
    }
    const admission = admitted(request, token);
    if (!admission) { response.writeHead(401, { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" }).end(DENIED); return; }
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
