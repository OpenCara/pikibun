import { mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { BlockList, connect as tcpConnect, isIP, type Socket } from "node:net";
import { lookup as dnsLookup } from "node:dns/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash, timingSafeEqual } from "node:crypto";
import { Readable, type Duplex } from "node:stream";
import { bindingRemote, gitProviders, validGitHost, validRepositoryId, validRepositoryName, type GitProvider } from "../../../packages/shared/src/repositories.js";
import { documentItemTypes, documentKind, sourceLimits, type DocumentItemType, type GrantSource } from "../../../packages/shared/src/sources.js";
import { API_TOKEN_PLACEHOLDER, credentialedApiHosts, credentialedApiProviders, type ApiAccessKind, type CredentialedApiProvider, egressPushService, hostAllowed, hostNamed, lfsLimits, parseLfsBatchRequest, parseNetworkPolicy, validLfsOid, validLfsSize,
  type EgressApi, type EgressGitService, type EgressGrant, type EgressRepository, type LfsBatchResult, type NetworkPolicy } from "../../../packages/shared/src/network.js";
import { boundedStream, drainStream, PUSH_REQUEST_BYTES, pushRejection, PushRequestError, readPushCommands, sessionBranchRefusal, type PushCommand } from "../../../packages/shared/src/git-push.js";
import { RunnerError } from "./protocol.js";
import { CA_BUNDLE, CA_BUNDLE_VARIABLES } from "./trust-store.js";
import { ApiAccess, type ApiUpstream } from "./api-access.js";
import type { InterceptionAuthority } from "./interception-ca.js";

export const EGRESS_PORT = 41080;
export const EGRESS_SOCKET = "/run/pikibun/egress.sock";
export const EGRESS_GIT_BASE = `http://127.0.0.1:${EGRESS_PORT}/git/`;
const SSH_HOSTS = ["github.com", "gitlab.com", "bitbucket.org"];

const GRANT_TTL_MS = 60_000;
const CONNECT_TIMEOUT_MS = 10_000;
const GRANT_STALE_MS = 5 * 60_000;
const UPLOAD_REQUEST_BYTES = 64 * 1024 * 1024;
const LFS_BATCH_BYTES = 1024 * 1024;
const LFS_TYPE = "application/vnd.git-lfs+json";
const LOG_ENTRIES = 200;
const MIRROR_HEARTBEAT_MS = 5_000;
const MIRROR_PROGRESS_MS = 1_000;

export interface RelayRequest {
  bindingId: string; service: EgressGitService;
  userAgent?: string; gitProtocol?: string; contentType?: string; contentEncoding?: string;
  body?: Uint8Array<ArrayBuffer> | ReadableStream<Uint8Array>;
  command?: PushCommand;
}
export const TRANSPORT_HEADER = "x-pikibun-transport";
export interface EgressEntry { at: string; kind: "git" | "connect" | "http" | "api" | "fetch"; target: string; outcome: "allowed" | "refused"; reason?: string }
export interface MirrorProgress { phase: string; percent: number | null; done: number | null; total: number | null; bytes: number }
export interface EgressOptions {
  socketPath: string;
  tcp?: { token: string };
  grant: () => Promise<EgressGrant>;
  relay: (request: RelayRequest) => Promise<Response>;
  lookup?: (host: string) => Promise<{ address: string; family: number }[]>;
  connect?: (port: number, address: string) => Duplex;
  mirror?: (repository: EgressRepository, onProgress: (progress: MirrorProgress) => void) => Promise<string>;
  sessionBranch?: string;
  apiCredential?: (host: string, access: ApiAccessKind) => Promise<unknown>;
  apiAuthority?: InterceptionAuthority;
  apiUpstream?: ApiUpstream;
}

export function egressEnvironment(sessionBranch?: string, endpoint?: EgressEndpoint, caBundle = CA_BUNDLE): Record<string, string> {
  const proxy = endpoint ? endpointUrl(endpoint) : `http://127.0.0.1:${EGRESS_PORT}`;
  const base = `${proxy}/git/`;
  const rewrites: [string, string][] = [["https://", base],
    ...SSH_HOSTS.flatMap((host): [string, string][] => [[`git@${host}:`, `${base}${host}/`], [`ssh://git@${host}/`, `${base}${host}/`]])];
  const config: Record<string, string> = { GIT_CONFIG_COUNT: String(rewrites.length) };
  rewrites.forEach(([from, to], index) => {
    config[`GIT_CONFIG_KEY_${index}`] = `url.${to}.insteadOf`;
    config[`GIT_CONFIG_VALUE_${index}`] = from;
  });
  return {
    HTTPS_PROXY: proxy, https_proxy: proxy, HTTP_PROXY: proxy, http_proxy: proxy,
    NO_PROXY: "localhost,127.0.0.1,::1", no_proxy: "localhost,127.0.0.1,::1",
    NODE_USE_ENV_PROXY: "1",
    ...Object.fromEntries(CA_BUNDLE_VARIABLES.map(name => [name, caBundle])),
    PIKIBUN_EGRESS_STATUS: `${proxy}/__pikibun/status`,
    GH_TOKEN: API_TOKEN_PLACEHOLDER, GITHUB_TOKEN: API_TOKEN_PLACEHOLDER, GITLAB_TOKEN: API_TOKEN_PLACEHOLDER, AZURE_DEVOPS_EXT_PAT: API_TOKEN_PLACEHOLDER,
    ...(sessionBranch ? { PIKIBUN_SESSION_BRANCH: sessionBranch } : {}),
    ...config,
  };
}

export interface EgressEndpoint { port: number; token: string }
export const EGRESS_USER = "pikibun";
export function endpointUrl(endpoint: EgressEndpoint): string {
  return `http://${EGRESS_USER}:${endpoint.token}@127.0.0.1:${endpoint.port}`;
}

export function egressAuthorized(header: string | undefined, token: string): boolean {
  const match = /^Basic\s+([A-Za-z0-9+/=]{1,512})$/i.exec(header ?? "");
  if (!match) return false;
  const given = Buffer.from(Buffer.from(match[1]!, "base64").toString("utf8"));
  const expected = Buffer.from(`${EGRESS_USER}:${token}`);
  return given.length === expected.length && timingSafeEqual(given, expected);
}

let directory: string | undefined;
export function egressSocketPath(sessionId: string, dataDir: string): string {
  directory ??= mkdtempSync(join(tmpdir().length < 40 ? tmpdir() : "/tmp", "pikibun-egress-"));
  return join(directory, `${createHash("sha256").update(`${dataDir}\0${sessionId}`).digest("hex").slice(0, 24)}.sock`);
}

const blocked = new BlockList();
for (const [network, prefix] of [["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16],
  ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.0.2.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15], ["198.51.100.0", 24],
  ["203.0.113.0", 24], ["224.0.0.0", 4], ["240.0.0.0", 4]] as const) blocked.addSubnet(network, prefix, "ipv4");
for (const [network, prefix] of [["::", 128], ["::1", 128], ["64:ff9b::", 96], ["100::", 64], ["2001:db8::", 32], ["fc00::", 7],
  ["fe80::", 10], ["ff00::", 8]] as const) blocked.addSubnet(network, prefix, "ipv6");

export function publicAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return !blocked.check(address, "ipv4");
  if (family !== 6) return false;
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address);
  if (mapped) return publicAddress(mapped[1]!);
  return !blocked.check(address, "ipv6");
}

const fakeIp = new BlockList();
fakeIp.addSubnet("198.18.0.0", 15, "ipv4");
export function fakeIpAddress(address: string): boolean {
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address);
  const plain = mapped ? mapped[1]! : address;
  return isIP(plain) === 4 && fakeIp.check(plain, "ipv4");
}

function authority(value: string | undefined): { host: string; port: number } | undefined {
  const match = /^(\[[0-9a-fA-F:.]+\]|[A-Za-z0-9.-]{1,253}):(\d{1,5})$/.exec(value ?? "");
  if (!match) return undefined;
  const port = Number(match[2]);
  if (port < 1 || port > 65535) return undefined;
  return { host: match[1]!.replace(/^\[|\]$/g, "").toLowerCase(), port };
}

function repositoryKey(hostAndPath: string): string {
  let value = hostAndPath;
  try { value = decodeURIComponent(value); } catch { }
  return value.toLowerCase().replace(/\/+$/, "").replace(/\.git$/, "");
}

function exactRepositoryKey(hostAndPath: string): string {
  let value = hostAndPath;
  try { value = decodeURIComponent(value); } catch { }
  const slash = value.indexOf("/");
  const host = slash < 0 ? value : value.slice(0, slash);
  return `${host.toLowerCase()}${slash < 0 ? "" : value.slice(slash)}`.replace(/\/+$/, "");
}

const remoteKeyPath = (repository: EgressRepository) => bindingRemote(repository).replace(/^https:\/\//, "");

export function findRepository(repositories: readonly EgressRepository[], target: string, lfs = false): EgressRepository | undefined {
  const exact = exactRepositoryKey(target);
  const servers = repositories.filter(repository => repository.provider === "git");
  const server = servers.find(repository => exactRepositoryKey(remoteKeyPath(repository)) === exact)
    ?? (lfs ? servers.find(repository => !repository.fullName.endsWith(".git") && `${exactRepositoryKey(remoteKeyPath(repository))}.git` === exact) : undefined);
  if (server) return server;
  const key = repositoryKey(target);
  return repositories.find(repository => repository.provider !== "git" && repositoryKey(remoteKeyPath(repository)) === key);
}

function lfsRequest(path: string): { target: string; kind: "batch" | "object" | "other"; oid?: string } | undefined {
  const match = /^(.+)\/info\/lfs((?:\/(?:objects|locks)(?:\/[^/]*)*)?)$/.exec(path);
  if (!match) return undefined;
  const [, target, rest] = match as unknown as [string, string, string];
  if (rest === "/objects/batch") return { target, kind: "batch" };
  const object = /^\/objects\/([0-9a-f]{64})$/.exec(rest);
  if (object) return { target, kind: "object", oid: object[1]! };
  return { target, kind: "other" };
}

function json(value: unknown): Uint8Array<ArrayBuffer> {
  return new Uint8Array(Buffer.from(JSON.stringify(value), "utf8"));
}

function transport(response: Response): string {
  const value = response.headers.get(TRANSPORT_HEADER);
  return value && /^direct [a-z-]{1,40}$/.test(value) ? ` (${value})` : "";
}

function relayStatus(error: unknown): number {
  return error instanceof RunnerError && error.status >= 400 && error.status < 600 ? error.status : 502;
}

export function parseLfsBatchResult(value: unknown, count: number): LfsBatchResult {
  const objects = (value as { objects?: unknown } | null)?.objects;
  if (!Array.isArray(objects) || objects.length !== count) throw new RunnerError(502, "Invalid Git LFS answer from the control plane");
  return {
    objects: objects.map((item: unknown) => {
      const object = item as Record<string, unknown> | null;
      const error = object?.error as { code?: unknown; message?: unknown } | undefined;
      if (!object || !validLfsOid(object.oid) || !validLfsSize(object.size) || typeof object.download !== "boolean"
        || (error !== undefined && (!Number.isInteger(error.code) || typeof error.message !== "string" || !/^[\x20-\x7e]{1,300}$/.test(error.message)))) {
        throw new RunnerError(502, "Invalid Git LFS answer from the control plane");
      }
      return { oid: object.oid, size: object.size, download: object.download,
        ...(error ? { error: { code: error.code as number, message: error.message as string } } : {}) };
    }),
  };
}

function refuseLfs(response: ServerResponse, status: number, message: string): void {
  if (response.headersSent) { response.destroy(); return; }
  response.writeHead(status, { "Content-Type": LFS_TYPE, "Cache-Control": "no-store", Connection: "close" });
  response.end(`${JSON.stringify({ message })}\n`);
}

function gitRequest(path: string, search: string): { target: string; service: EgressGitService } | undefined {
  const service = new URLSearchParams(search).get("service");
  if (path.endsWith("/info/refs")) {
    if (service === "git-upload-pack") return { target: path.slice(0, -"/info/refs".length), service: "info-refs" };
    if (service === "git-receive-pack") return { target: path.slice(0, -"/info/refs".length), service: "receive-refs" };
    return undefined;
  }
  if (path.endsWith("/git-upload-pack")) return { target: path.slice(0, -"/git-upload-pack".length), service: "upload-pack" };
  if (path.endsWith("/git-receive-pack")) return { target: path.slice(0, -"/git-receive-pack".length), service: "receive-pack" };
  return undefined;
}

async function boundedBody(request: IncomingMessage, limit: number): Promise<Uint8Array<ArrayBuffer>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size > limit) throw new RunnerError(413, "The Git request is too large");
    chunks.push(chunk);
  }
  const body = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { body.set(chunk, offset); offset += chunk.length; }
  return body;
}

function refuse(response: ServerResponse, status: number, message: string): void {
  if (response.headersSent) { response.destroy(); return; }
  response.writeHead(status, { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store", Connection: "close" });
  response.end(`${message}\n`);
}

export class EgressProxy {
  readonly socketPath: string;
  readonly #options: EgressOptions;
  readonly #log: EgressEntry[] = [];
  readonly #sockets = new Set<Socket | Duplex>();
  readonly #pushes = new Set<Promise<void>>();
  #server: Server | undefined;
  #tcpServer: Server | undefined;
  #port: number | undefined;
  #grant: { value: EgressGrant; at: number } | undefined;
  #refresh: Promise<EgressGrant> | undefined;
  readonly #api: ApiAccess | undefined;

  constructor(options: EgressOptions) {
    this.socketPath = options.socketPath;
    this.#options = options;
    const credential = options.apiCredential;
    this.#api = credential && new ApiAccess({
      credential, grant: () => this.#currentGrant(),
      record: entry => this.#record({ kind: "api", ...entry }),
      ...(options.apiAuthority ? { authority: options.apiAuthority } : {}),
      ...(options.apiUpstream ? { upstream: options.apiUpstream } : {}),
    });
  }

  apiLease(): { token: string; release(): void } | undefined { return this.#api?.lease(); }

  #credentialedApi(grant: EgressGrant, host: string): EgressApi | undefined {
    if (!this.#api?.handles(host)) return undefined;
    return grant.apis?.find(api => api.host === host);
  }

  async start(): Promise<void> {
    if (this.#server || this.#tcpServer) return;
    const tcp = this.#options.tcp;
    if (!tcp) {
      await rm(this.socketPath, { force: true });
      const server = this.#createServer(undefined);
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(this.socketPath, () => { server.off("error", reject); resolve(); });
      });
      this.#server = server;
    } else {
      const listener = this.#createServer(tcp.token);
      try {
        await new Promise<void>((resolve, reject) => {
          listener.once("error", reject);
          listener.listen({ host: "127.0.0.1", port: 0 }, () => { listener.off("error", reject); resolve(); });
        });
      } catch (error) {
        await this.close();
        throw error;
      }
      this.#port = (listener.address() as { port: number }).port;
      this.#tcpServer = listener;
    }
  }

  get endpoint(): EgressEndpoint | undefined {
    return this.#port !== undefined && this.#options.tcp ? { port: this.#port, token: this.#options.tcp.token } : undefined;
  }

  #createServer(token: string | undefined): Server {
    const server = createServer((request, response) => {
      if (token !== undefined && !egressAuthorized(request.headers.authorization ?? request.headers["proxy-authorization"], token)) {
        const proxied = /^[a-z]+:/i.test(request.url ?? "");
        response.writeHead(proxied ? 407 : 401, { [proxied ? "Proxy-Authenticate" : "WWW-Authenticate"]: 'Basic realm="Pikibun egress"',
          "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store", Connection: "close" });
        response.end("This session's egress proxy needs its credentials, which are in HTTPS_PROXY\n");
        return;
      }
      void this.#request(request, response);
    });
    server.on("connect", (request: IncomingMessage, socket: Duplex, head: Buffer) => {
      if (token !== undefined && !egressAuthorized(request.headers["proxy-authorization"], token)) {
        socket.on("error", () => socket.destroy());
        socket.end("HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Basic realm=\"Pikibun egress\"\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
        return;
      }
      void this.#tunnel(request, socket, head);
    });
    server.on("clientError", (_error, socket) => socket.destroy());
    server.requestTimeout = 60 * 60 * 1000;
    server.unref();
    return server;
  }

  async close(): Promise<void> {
    const server = this.#server;
    this.#server = undefined;
    const tcp = this.#tcpServer;
    this.#tcpServer = undefined;
    this.#port = undefined;
    const tcpClosed = tcp && new Promise<void>(resolve => tcp.close(() => resolve()));
    const closed = server && new Promise<void>(resolve => server.close(() => resolve()));
    await Promise.allSettled([...this.#pushes]);
    for (const socket of this.#sockets) socket.destroy();
    if (server) { server.closeAllConnections(); await closed; }
    if (tcp) { tcp.closeAllConnections(); await tcpClosed; }
    if (!this.#options.tcp) await rm(this.socketPath, { force: true });
  }

  grant(): Promise<EgressGrant> { return this.#currentGrant(); }

  entries(): EgressEntry[] { return [...this.#log]; }

  noteFallback(bindingId: string, reason: string): void {
    const repository = this.#grant?.value.repositories.find(item => item.bindingId === bindingId);
    const target = repository ? repositoryKey(bindingRemote(repository).replace(/^https:\/\//, "")) : bindingId;
    this.#record({ kind: "git", target: target.slice(0, 300), outcome: "allowed", reason: `relayed: ${reason.replace(/[^\x20-\x7e]/g, " ").slice(0, 300)}` });
  }

  #record(entry: Omit<EgressEntry, "at">): void {
    this.#log.push({ at: new Date().toISOString(), ...entry });
    if (this.#log.length > LOG_ENTRIES) this.#log.splice(0, this.#log.length - LOG_ENTRIES);
  }

  async #currentGrant(): Promise<EgressGrant> {
    const cached = this.#grant;
    if (cached && Date.now() - cached.at < GRANT_TTL_MS) return cached.value;
    this.#refresh ??= this.#options.grant().then(value => {
      this.#grant = { value, at: Date.now() };
      return value;
    }).finally(() => { this.#refresh = undefined; });
    try { return await this.#refresh; }
    catch (error) {
      const refused = error instanceof RunnerError && error.status >= 400 && error.status < 500 && ![408, 429].includes(error.status);
      if (refused) this.#grant = undefined;
      else if (cached && Date.now() - cached.at < GRANT_STALE_MS) return cached.value;
      throw error instanceof RunnerError ? error : new RunnerError(503, "The session's network policy is unavailable");
    }
  }

  async #addresses(host: string, policy: NetworkPolicy): Promise<{ addresses: string[] } | { reason: string }> {
    const refused = { reason: `${host} does not resolve to a public address` };
    if (isIP(host)) return publicAddress(host) ? { addresses: [host] } : refused;
    const results = await (this.#options.lookup ?? (name => dnsLookup(name, { all: true, verbatim: true })))(host);
    if (!results.length || results.some(result => !publicAddress(result.address) && !fakeIpAddress(result.address))) return refused;
    const fake = results.find(result => fakeIpAddress(result.address));
    if (fake && !hostNamed(policy, host)) {
      return { reason: `${host} resolves to ${fake.address}, a fake-IP address of a proxy on this host; tunnels go to such addresses only for `
        + `hosts the network policy names exactly (an allowlist entry without *. or a package registry), or exclude ${host} from the proxy's fake-IP mode` };
    }
    return { addresses: results.map(result => result.address) };
  }

  async #open(port: number, addresses: string[]): Promise<Duplex> {
    let failure: unknown = new Error("No address");
    for (const address of addresses.slice(0, 8)) {
      const socket = (this.#options.connect ?? ((port, address) => tcpConnect({ port, host: address })))(port, address);
      try {
        await new Promise<void>((resolve, reject) => {
          const failed = (error: unknown) => { clearTimeout(timer); reject(error); };
          const timer = setTimeout(() => failed(new Error("Connection timed out")), CONNECT_TIMEOUT_MS);
          socket.once("error", failed);
          socket.once("connect", () => { clearTimeout(timer); socket.off("error", failed); resolve(); });
        });
        return socket;
      } catch (error) {
        socket.destroy();
        failure = error;
      }
    }
    throw failure;
  }

  async #tunnel(request: IncomingMessage, client: Duplex, head: Buffer): Promise<void> {
    client.on("error", () => client.destroy());
    const target = authority(request.url);
    const name = request.url ?? "";
    const deny = (status: number, reason: string) => {
      this.#record({ kind: "connect", target: name.slice(0, 300), outcome: "refused", reason });
      if (!client.destroyed) client.end(`HTTP/1.1 ${status} ${status === 403 ? "Forbidden" : "Bad Gateway"}\r\nContent-Type: text/plain\r\nConnection: close\r\n\r\n${reason}\n`);
    };
    try {
      if (!target) return deny(403, "Invalid tunnel target");
      if (target.port !== 443) return deny(403, `Only HTTPS on port 443 is allowed, not port ${target.port}`);
      const grant = await this.#currentGrant();
      if (this.#api?.handles(target.host)) {
        if (client.destroyed) return;
        this.#sockets.add(client);
        client.once("close", () => this.#sockets.delete(client));
        client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        return this.#api!.intercept(client, head, target.host);
      }
      if (!hostAllowed(grant.policy, target.host)) {
        return deny(403, grant.policy.mode === "off"
          ? `${target.host} is not reachable: this workspace's network access is off`
          : `${target.host} is not allowed by this workspace's network policy`);
      }
      const resolved = await this.#addresses(target.host, grant.policy);
      if ("reason" in resolved) return deny(403, resolved.reason);
      const { addresses } = resolved;
      if (client.destroyed) return;
      this.#sockets.add(client);
      let upstream: Duplex;
      try { upstream = await this.#open(target.port, addresses); }
      catch {
        this.#sockets.delete(client);
        return deny(502, `${target.host} could not be reached`);
      }
      this.#sockets.add(upstream);
      const cleanup = () => { upstream.destroy(); client.destroy(); this.#sockets.delete(upstream); this.#sockets.delete(client); };
      for (const socket of [upstream, client]) {
        socket.once("error", cleanup);
        socket.once("close", cleanup);
      }
      if (client.destroyed) return cleanup();
      this.#record({ kind: "connect", target: `${target.host}:${target.port}`, outcome: "allowed" });
      client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head.length) upstream.write(head);
      upstream.pipe(client);
      client.pipe(upstream);
    } catch (error) {
      deny(error instanceof RunnerError ? error.status === 503 ? 502 : 403 : 502, error instanceof RunnerError ? error.message : "The tunnel could not be opened");
    }
  }

  async #request(request: IncomingMessage, response: ServerResponse): Promise<void> {
    try {
      let url: URL;
      try { url = new URL(request.url ?? "/", "http://127.0.0.1"); }
      catch { return refuse(response, 400, "Invalid request"); }
      const port = this.#port ?? EGRESS_PORT;
      if (/^[a-z]+:/i.test(request.url ?? "") && url.host !== `127.0.0.1:${port}` && url.host !== `localhost:${port}`) {
        this.#record({ kind: "http", target: `${url.protocol}//${url.host}`.slice(0, 300), outcome: "refused", reason: "plain HTTP" });
        return refuse(response, 403, "Plain HTTP is not allowed through the Pikibun egress proxy; use HTTPS");
      }
      if (url.pathname === "/__pikibun/status" && request.method === "GET") return await this.#status(response);
      if (url.pathname === "/__pikibun/mirror" && request.method === "GET") return await this.#mirror(response, url.searchParams.get("remote") ?? "");
      if (url.pathname === "/__pikibun/lfs" && request.method === "GET") return await this.#lfsEnabled(response, url.searchParams.get("remote") ?? "");
      if (url.pathname.startsWith("/git/")) return await this.#git(request, response, url);
      return refuse(response, 404, "Unknown Pikibun egress endpoint");
    } catch (error) {
      refuse(response, error instanceof RunnerError ? error.status : 502, error instanceof RunnerError ? error.message : "The request could not be completed");
    }
  }

  async #status(response: ServerResponse): Promise<void> {
    let grant: EgressGrant | undefined;
    let error: string | undefined;
    try { grant = await this.#currentGrant(); }
    catch (cause) { error = cause instanceof Error ? cause.message : "unavailable"; }
    response.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
    response.end(`${JSON.stringify({
      network: grant?.policy ?? null,
      ...(error ? { error } : {}),
      repositories: grant?.repositories.map(repository => bindingRemote(repository)) ?? [],
      apis: grant && this.#api ? credentialedApiHosts.map(host => ({ host,
        access: this.#credentialedApi(grant!, host)
          ? `the proxy answers HTTPS to ${host} itself and adds the session owner's access to the workspace's repositories, to read; GH_TOKEN, GITLAB_TOKEN and AZURE_DEVOPS_EXT_PAT hold only a placeholder`
          : `the proxy answers HTTPS to ${host} itself, without a credential for this session, where the network policy allows ${host}` })) : [],
      lfs: grant?.repositories.filter(repository => repository.lfs).map(repository => bindingRemote(repository)) ?? [],
      gitRemotes: `https:// remotes go through ${this.#port === undefined ? EGRESS_GIT_BASE : `http://127.0.0.1:${this.#port}/git/`}<host>/<path>; the workspace's repositories are read with the session owner's access`
        + (this.#options.sessionBranch ? `, and this session's branch ${this.#options.sessionBranch} is pushed with the workspace's push identity` : "")
        + ". The host fetches them from the forge itself when Pikibun grants it a credential (\"direct\" in recent), else Pikibun relays them",
      sessionBranch: this.#options.sessionBranch ?? null,
      recent: this.#log.slice(-50),
    }, null, 2)}\n`);
  }

  async #mirror(response: ServerResponse, remote: string): Promise<void> {
    if (!this.#options.mirror) return refuse(response, 404, "This host keeps no repository cache");
    const repository = repositoryForRemote((await this.#currentGrant()).repositories, remote.slice(0, 2048));
    if (!repository) return refuse(response, 404, "Not one of this workspace's repositories");
    const label = bindingRemote(repository).slice(0, 300);
    response.writeHead(200, { "Content-Type": "application/x-ndjson", "Cache-Control": "no-store" });
    const send = (line: object) => { if (!response.writableEnded && !response.destroyed) response.write(`${JSON.stringify(line)}\n`); };
    let last: MirrorProgress = { phase: "waiting", percent: null, done: null, total: null, bytes: 0 };
    let sent = 0;
    const progress = (value: MirrorProgress) => {
      const changed = value.phase !== last.phase;
      last = { phase: value.phase, percent: value.percent, done: value.done, total: value.total, bytes: value.bytes };
      if (changed || Date.now() - sent >= MIRROR_PROGRESS_MS) { sent = Date.now(); send({ progress: last }); }
    };
    const heartbeat = setInterval(() => { sent = Date.now(); send({ progress: last }); }, MIRROR_HEARTBEAT_MS);
    try {
      const path = await this.#options.mirror(repository, progress);
      this.#record({ kind: "git", target: label, outcome: "allowed", reason: "mirror" });
      send({ path });
    } catch (error) {
      const reason = error instanceof Error && /^[\x20-\x7e]{1,300}$/.test(error.message) ? error.message : "The repository could not be cached";
      this.#record({ kind: "git", target: label, outcome: "refused", reason: `mirror: ${reason}` });
      send({ error: reason, ...(error instanceof RunnerError && error.status === 503 ? { retry: true } : {}) });
    } finally {
      clearInterval(heartbeat);
      if (!response.destroyed) response.end();
    }
  }

  async #lfsEnabled(response: ServerResponse, remote: string): Promise<void> {
    const repository = repositoryForRemote((await this.#currentGrant()).repositories, remote.slice(0, 2048));
    response.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
    response.end(`${JSON.stringify({ lfs: repository?.lfs === true })}\n`);
  }

  async #git(request: IncomingMessage, response: ServerResponse, url: URL): Promise<void> {
    const parsed = gitRequest(url.pathname.slice("/git/".length), url.search);
    if (!parsed) {
      const lfs = lfsRequest(url.pathname.slice("/git/".length));
      if (lfs) return this.#lfs(request, response, url, lfs);
      return refuse(response, 404, "Not a Git smart-HTTP request");
    }
    const target = parsed.target.replace(/^[^@/]*@/, "");
    const key = repositoryKey(target);
    const label = key.slice(0, 300);
    const push = egressPushService(parsed.service);
    if (push && !this.#options.sessionBranch) {
      this.#record({ kind: "git", target: label, outcome: "refused", reason: "push" });
      return refuse(response, 403, "Pushes don't go through the egress proxy in this session: commit, then use the git_push tool");
    }
    const grant = await this.#currentGrant();
    const repository = findRepository(grant.repositories, target);
    if (repository) return push ? this.#push(request, response, repository, parsed.service, label) : this.#relay(request, response, repository, parsed.service, label);
    if (push) {
      this.#record({ kind: "git", target: label, outcome: "refused", reason: "push: not a workspace repository" });
      return refuse(response, 403, `${target.slice(0, 300)} is not one of this workspace's repositories; pushes go only to them`);
    }
    const host = key.split("/")[0]!;
    if (parsed.service === "info-refs" && hostAllowed(grant.policy, host)) {
      this.#record({ kind: "git", target: label, outcome: "allowed", reason: "not a workspace repository: fetched directly, without credentials" });
      response.writeHead(302, { Location: `https://${target}/info/refs${url.search}`, "Cache-Control": "no-store" });
      return void response.end();
    }
    this.#record({ kind: "git", target: label, outcome: "refused", reason: "not a workspace repository" });
    return refuse(response, 403, hostAllowed(grant.policy, host)
      ? `${target.slice(0, 300)} is not one of this workspace's repositories; fetch it from https://${target.slice(0, 300)} directly`
      : `${target.slice(0, 300)} is not one of this workspace's repositories, and its network policy doesn't allow ${host.slice(0, 253)}`);
  }

  async #push(request: IncomingMessage, response: ServerResponse, repository: EgressRepository, service: EgressGitService, label: string): Promise<void> {
    const branch = this.#options.sessionBranch!;
    if (service === "receive-refs") return this.#relay(request, response, repository, service, label);
    if (request.method !== "POST") return refuse(response, 405, "Git pushes use POST");
    if (request.headers["content-type"]?.toLowerCase() !== "application/x-git-receive-pack-request" || request.headers["content-encoding"])
      return refuse(response, 415, "Expected a Git receive-pack request");
    let parsed: Awaited<ReturnType<typeof readPushCommands>>;
    try { parsed = await readPushCommands(Readable.toWeb(request) as ReadableStream<Uint8Array>); }
    catch (error) {
      if (error instanceof PushRequestError) return refuse(response, 400, error.message);
      throw error;
    }
    if (!parsed.commands.length) {
      if (!await drainStream(parsed.body, PUSH_REQUEST_BYTES)) return refuse(response, 413, "The push is too large");
      response.writeHead(200, { "Content-Type": "application/x-git-receive-pack-result", "Cache-Control": "no-store" });
      return void response.end();
    }
    const refusal = sessionBranchRefusal(parsed.commands, branch);
    if (refusal) {
      this.#record({ kind: "git", target: label, outcome: "refused", reason: `push: ${refusal}` });
      if (!await drainStream(parsed.body, PUSH_REQUEST_BYTES)) return refuse(response, 413, "The push is too large");
      const rejection = pushRejection(parsed.commands, parsed.capabilities, refusal);
      if (!rejection) return refuse(response, 403, refusal);
      response.writeHead(200, { "Content-Type": "application/x-git-receive-pack-result", "Cache-Control": "no-store" });
      return void response.end(rejection);
    }
    const pushed = this.#relay(request, response, repository, service, label, boundedStream(parsed.body, PUSH_REQUEST_BYTES, "The push is too large"), parsed.commands[0]);
    this.#pushes.add(pushed);
    try { await pushed; } finally { this.#pushes.delete(pushed); }
  }

  async #lfs(request: IncomingMessage, response: ServerResponse, url: URL, lfs: NonNullable<ReturnType<typeof lfsRequest>>): Promise<void> {
    const target = lfs.target.replace(/^[^@/]*@/, "");
    const label = repositoryKey(target).slice(0, 300);
    const deny = (status: number, reason: string) => {
      this.#record({ kind: "git", target: label, outcome: "refused", reason: `lfs: ${reason}` });
      refuseLfs(response, status, reason);
    };
    const repository = findRepository((await this.#currentGrant()).repositories, target, true);
    if (!repository) return deny(403, `${target.slice(0, 300)} is not one of this workspace's repositories; Git LFS goes only to them`);
    if (!repository.lfs) {
      return deny(403, `Git LFS is off for ${repository.fullName} in this workspace; a workspace owner or admin can turn it on in the workspace's repository settings`);
    }
    if (lfs.kind === "other") return deny(403, "Only Git LFS downloads go through the Pikibun egress proxy; uploads and locks are not supported in sessions");
    if (lfs.kind === "object") {
      if (request.method !== "GET") return deny(405, "Git LFS downloads use GET");
      const size = Number(url.searchParams.get("size"));
      if (!/^\d{1,16}$/.test(url.searchParams.get("size") ?? "") || !validLfsSize(size)) return deny(400, "Invalid Git LFS object size");
      return this.#relayLfs(response, repository, label, "lfs-object", { oid: lfs.oid!, size }, deny);
    }
    if (request.method !== "POST") return deny(405, "The Git LFS batch API uses POST");
    let input: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(await boundedBody(request, LFS_BATCH_BYTES)));
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not an object");
      input = parsed as Record<string, unknown>;
    } catch (error) {
      return deny(error instanceof RunnerError ? error.status : 400, error instanceof RunnerError ? error.message : "Invalid Git LFS batch request");
    }
    if (input.operation !== "download") return deny(403, "Git LFS uploads are not supported in Pikibun sessions; only downloads go through the egress proxy");
    if (input.transfers !== undefined && (!Array.isArray(input.transfers) || !input.transfers.includes("basic"))) {
      return deny(422, "Only the basic Git LFS transfer is supported");
    }
    if (input.hash_algo !== undefined && input.hash_algo !== "sha256") return deny(422, "Only sha256 Git LFS objects are supported");
    const ref = (input.ref as { name?: unknown } | undefined)?.name;
    let batch;
    try {
      batch = parseLfsBatchRequest({
        objects: Array.isArray(input.objects) ? input.objects.map(item => ({ oid: (item as { oid?: unknown })?.oid, size: (item as { size?: unknown })?.size })) : input.objects,
        ...(typeof ref === "string" && /^refs\/[\x21-\x7e]{1,250}$/.test(ref) ? { ref } : {}),
      });
    } catch (error) {
      return deny(input.objects && Array.isArray(input.objects) && input.objects.length > lfsLimits.batchObjects ? 413 : 422,
        error instanceof Error ? error.message : "Invalid Git LFS batch request");
    }
    let upstream: Response;
    try { upstream = await this.#options.relay({ bindingId: repository.bindingId, service: "lfs-batch", contentType: "application/json", body: json(batch) }); }
    catch (error) { return deny(relayStatus(error), error instanceof RunnerError ? error.message : "The control plane could not relay the request"); }
    let result: LfsBatchResult;
    try { result = parseLfsBatchResult(await upstream.json(), batch.objects.length); }
    catch { return deny(502, "The control plane returned an invalid Git LFS answer"); }
    const base = `${EGRESS_GIT_BASE}${target}/info/lfs/objects/`;
    this.#record({ kind: "git", target: label, outcome: "allowed", reason: `lfs batch (${result.objects.length} objects)${transport(upstream)}` });
    response.writeHead(200, { "Content-Type": LFS_TYPE, "Cache-Control": "no-store" });
    response.end(`${JSON.stringify({
      transfer: "basic", hash_algo: "sha256",
      objects: result.objects.map(object => object.download
        ? { oid: object.oid, size: object.size, authenticated: true, actions: { download: { href: `${base}${object.oid}?size=${object.size}` } } }
        : { oid: object.oid, size: object.size, error: object.error ?? { code: 404, message: "Object does not exist on the server" } }),
    })}\n`);
  }

  async #relayLfs(response: ServerResponse, repository: EgressRepository, label: string, service: "lfs-object", object: { oid: string; size: number },
    deny: (status: number, reason: string) => void): Promise<void> {
    let upstream: Response;
    try { upstream = await this.#options.relay({ bindingId: repository.bindingId, service, contentType: "application/json", body: json(object) }); }
    catch (error) { return deny(relayStatus(error), error instanceof RunnerError ? error.message : "The control plane could not relay the request"); }
    this.#record({ kind: "git", target: label, outcome: "allowed", reason: `lfs object ${object.oid.slice(0, 12)}${transport(upstream)}` });
    return this.#stream(response, upstream, "application/octet-stream");
  }

  async #relay(request: IncomingMessage, response: ServerResponse, repository: EgressRepository, service: EgressGitService, label: string,
    stream?: ReadableStream<Uint8Array>, command?: PushCommand): Promise<void> {
    const header = (name: string) => { const value = request.headers[name]; return typeof value === "string" ? value : undefined; };
    if (service === "upload-pack" && request.method !== "POST") return refuse(response, 405, "Git fetches use POST");
    const body = service === "upload-pack" ? await boundedBody(request, UPLOAD_REQUEST_BYTES) : stream;
    let upstream: Response;
    try {
      upstream = await this.#options.relay({
        bindingId: repository.bindingId, service,
        userAgent: header("user-agent"), gitProtocol: header("git-protocol"),
        contentType: header("content-type"), contentEncoding: header("content-encoding"), ...(body ? { body } : {}), ...(command ? { command } : {}),
      });
    } catch (error) {
      const reason = error instanceof RunnerError ? error.message : "The control plane could not relay the request";
      this.#record({ kind: "git", target: label, outcome: "refused", reason });
      return refuse(response, relayStatus(error), reason);
    }
    this.#record({ kind: "git", target: label, outcome: "allowed", reason: `${service === "receive-pack" ? `push ${this.#options.sessionBranch}` : service}${transport(upstream)}` });
    return this.#stream(response, upstream, upstream.headers.get("content-type") ?? "application/octet-stream");
  }

  async #stream(response: ServerResponse, upstream: Response, contentType: string): Promise<void> {
    response.writeHead(200, { "Content-Type": contentType, "Cache-Control": "no-store" });
    if (!upstream.body) return void response.end();
    const reader = upstream.body.getReader();
    response.once("close", () => { void reader.cancel().catch(() => {}); });
    try {
      while (true) {
        const part = await reader.read();
        if (part.done) break;
        if (!response.write(part.value)) await new Promise<void>(resolve => {
          const done = () => { response.off("drain", done); response.off("close", done); resolve(); };
          response.once("drain", done);
          response.once("close", done);
        });
        if (response.destroyed) break;
      }
      response.end();
    } catch {
      response.destroy();
    }
  }
}

export function repositoryForRemote(repositories: readonly EgressRepository[], url: string): EgressRepository | undefined {
  let target: string | undefined;
  if (url.startsWith(EGRESS_GIT_BASE)) target = url.slice(EGRESS_GIT_BASE.length);
  else if (url.startsWith("https://")) target = url.slice("https://".length).replace(/^[^@/]*@/, "");
  else {
    const ssh = /^(?:ssh:\/\/)?git@([^:/]+)[:/](.+)$/.exec(url);
    if (ssh) target = `${ssh[1]}/${ssh[2]}`;
  }
  if (!target) return undefined;
  return findRepository(repositories, target.split(/[?#]/)[0]!);
}

const IDENTIFIER = /^[A-Za-z0-9_-]{1,128}$/;

export function parseEgressGrant(value: unknown): EgressGrant {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new RunnerError(502, "Invalid network policy from the control plane");
  const input = value as Record<string, unknown>;
  let policy;
  try { policy = parseNetworkPolicy(input.policy); }
  catch { throw new RunnerError(502, "Invalid network policy from the control plane"); }
  if (!Array.isArray(input.repositories) || input.repositories.length > 100) throw new RunnerError(502, "Invalid repositories from the control plane");
  const repositories = input.repositories.map((item: unknown): EgressRepository => {
    const repository = item as Partial<EgressRepository> | null;
    if (!repository || typeof repository.bindingId !== "string" || !IDENTIFIER.test(repository.bindingId)
      || !gitProviders.includes(repository.provider as GitProvider) || !validGitHost(repository.host) || (repository.repositoryId !== undefined && !validRepositoryId(repository.repositoryId))
      || !validRepositoryName(repository.provider!, repository.fullName)
      || (repository.lfs !== undefined && typeof repository.lfs !== "boolean")) throw new RunnerError(502, "Invalid repositories from the control plane");
    return { bindingId: repository.bindingId, provider: repository.provider!, host: repository.host, fullName: repository.fullName,
      ...(repository.repositoryId !== undefined ? { repositoryId: repository.repositoryId } : {}), ...(repository.lfs ? { lfs: true } : {}) };
  });
  if (input.sources !== undefined && (!Array.isArray(input.sources) || input.sources.length > 100)) throw new RunnerError(502, "Invalid sources from the control plane");
  const sources = (input.sources as unknown[] | undefined)?.map((item): GrantSource => {
    const source = item as Partial<GrantSource> | null;
    if (!source || typeof source.id !== "string" || !IDENTIFIER.test(source.id) || !documentKind(source.kind)
      || !documentItemTypes.includes(source.type as DocumentItemType) || typeof source.title !== "string" || source.title.length > sourceLimits.title) {
      throw new RunnerError(502, "Invalid sources from the control plane");
    }
    return { id: source.id, kind: source.kind, type: source.type!, title: source.title };
  });
  if (input.apis !== undefined && (!Array.isArray(input.apis) || input.apis.length > 10)) throw new RunnerError(502, "Invalid APIs from the control plane");
  const apis = ((input.apis ?? []) as unknown[]).flatMap((item): EgressApi[] => {
    const api = item as Partial<EgressApi> | null;
    if (!api || typeof api.host !== "string" || typeof api.provider !== "string") throw new RunnerError(502, "Invalid APIs from the control plane");
    return credentialedApiHosts.includes(api.host) && credentialedApiProviders[api.host] === api.provider ? [{ host: api.host, provider: api.provider as CredentialedApiProvider }] : [];
  });
  return { policy, repositories, ...(apis.length ? { apis } : {}), ...(sources ? { sources } : {}) };
}

export async function relayGitRequest(fetchImpl: typeof fetch, url: string, authorization: Record<string, string>, request: RelayRequest, signal: AbortSignal): Promise<Response> {
  const headers: Record<string, string> = { ...authorization };
  if (request.userAgent) headers["user-agent"] = request.userAgent;
  if (request.gitProtocol) headers["git-protocol"] = request.gitProtocol;
  if (request.contentType) headers["content-type"] = request.contentType;
  if (request.contentEncoding) headers["content-encoding"] = request.contentEncoding;
  const response = await fetchImpl(url, { method: "POST", redirect: "error", credentials: "omit", headers, body: request.body ?? new Uint8Array(),
    ...(request.body instanceof ReadableStream ? { duplex: "half" } : {}), signal } as RequestInit);
  if (response.ok) return response;
  const text = (await response.text().catch(() => "")).slice(0, 4096);
  let error: unknown;
  try { error = (JSON.parse(text) as { error?: unknown }).error; } catch { error = undefined; }
  throw new RunnerError(response.status, typeof error === "string" && /^[\x20-\x7e -￿]{1,500}$/.test(error) ? error : "The control plane refused the Git request");
}

export function relayFetch(bindingId: string, relay: (request: RelayRequest) => Promise<Response>): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const service: EgressGitService | undefined = url.pathname.endsWith("/info/refs") && url.searchParams.get("service") === "git-upload-pack" ? "info-refs"
      : url.pathname.endsWith("/git-upload-pack") && !url.search ? "upload-pack" : undefined;
    if (!service) throw new RunnerError(403, "Only Git reads go through the relay");
    const signal = init?.signal ?? undefined;
    signal?.throwIfAborted();
    const headers = new Headers(init?.headers);
    const body = init?.body ? new Uint8Array(await new Response(init.body).arrayBuffer()) : undefined;
    if (body && body.byteLength > UPLOAD_REQUEST_BYTES) throw new RunnerError(413, "The Git request is too large");
    try {
      const answer = relay({ bindingId, service, userAgent: headers.get("user-agent") ?? undefined, gitProtocol: headers.get("git-protocol") ?? undefined,
        contentType: headers.get("content-type") ?? undefined, contentEncoding: headers.get("content-encoding") ?? undefined, ...(body ? { body } : {}) });
      return await (signal ? abandonable(answer, signal) : answer);
    } catch (error) {
      if (error instanceof RunnerError) return new Response(null, { status: error.status >= 400 && error.status < 600 ? error.status : 502 });
      throw error;
    }
  }) as typeof fetch;
}

function abandonable(answer: Promise<Response>, signal: AbortSignal): Promise<Response> {
  return new Promise<Response>((resolve, reject) => {
    const abort = () => {
      reject(signal.reason);
      void answer.then(response => response.body?.cancel(), () => {});
    };
    if (signal.aborted) return abort();
    signal.addEventListener("abort", abort, { once: true });
    answer.then(response => { signal.removeEventListener("abort", abort); resolve(response); },
      error => { signal.removeEventListener("abort", abort); reject(error); });
  });
}

export function relayPath(prefix: string, sessionId: string, request: RelayRequest): string {
  return `${prefix}/git/relay/${encodeURIComponent(request.bindingId)}/${request.service}?sessionId=${encodeURIComponent(sessionId)}`;
}
