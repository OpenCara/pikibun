import { randomBytes } from "node:crypto";
import { lookup as dnsLookup } from "node:dns/promises";
import { createServer, type IncomingHttpHeaders, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { Agent as HttpsAgent, request as httpsRequest } from "node:https";
import { isIP, type LookupFunction } from "node:net";
import { Readable, type Duplex } from "node:stream";
import { TLSSocket } from "node:tls";
import { API_CREDENTIAL_CACHE_SECONDS, API_TOKEN_PLACEHOLDER, apiWriteLease, apiWriteToken, hostAllowed, type ApiAccessKind, type ApiCredential,
  type ApiCredentialGrant, type CredentialedApiProvider, type EgressGrant } from "../../../packages/shared/src/network.js";
import { fakeIpAddress, publicAddress } from "./egress.js";
import { interceptionAuthority, type InterceptionAuthority } from "./interception-ca.js";
import { RunnerError } from "./protocol.js";

const GRAPHQL_BYTES = 1024 * 1024;
const BODY_BYTES = 16 * 1024 * 1024;
const PATH_LENGTH = 8192;
const UPSTREAM_TIMEOUT_MS = 60_000;
const UNAVAILABLE_CACHE_MS = 10_000;
const EXPIRY_MARGIN_MS = 5 * 60_000;
const REDIRECTS = 3;
const GITHUB_DOWNLOAD_HOSTS = [/^codeload\.github\.com$/, /\.githubusercontent\.com$/, /\.blob\.core\.windows\.net$/];
const HOP_BY_HOP = new Set(["connection", "keep-alive", "proxy-authenticate", "proxy-authorization", "proxy-connection", "te", "trailer",
  "transfer-encoding", "upgrade", "host", "authorization", "private-token", "cookie", "content-length", "expect"]);

export interface ApiEntry { target: string; outcome: "allowed" | "refused"; reason?: string }
export interface UpstreamRequest { url: URL; method: string; headers: Record<string, string>; body?: Uint8Array; signal?: AbortSignal }
export interface UpstreamResponse { status: number; headers: IncomingHttpHeaders; body: Readable }
export type ApiUpstream = (request: UpstreamRequest) => Promise<UpstreamResponse>;

export interface ApiAccessOptions {
  credential: (host: string, access: ApiAccessKind) => Promise<unknown>;
  grant: () => Promise<EgressGrant>;
  record: (entry: ApiEntry) => void;
  authority?: InterceptionAuthority;
  upstream?: ApiUpstream;
}

export interface ApiRules {
  provider: CredentialedApiProvider;
  name: string;
  api(pathname: string): boolean;
  graphql(pathname: string): boolean;
  scope(pathname: string): { repository?: string; account?: string };
  placeholderOnly: boolean;
  downloads: readonly RegExp[];
}

export function restRepository(pathname: string): string | undefined {
  const parts = pathname.split("/");
  if (parts[1] !== "repos" || !parts[2] || !parts[3]) return undefined;
  try { return `${decodeURIComponent(parts[2])}/${decodeURIComponent(parts[3])}`; } catch { return undefined; }
}

export const apiRules: Readonly<Record<string, ApiRules>> = Object.freeze({
  "api.github.com": {
    provider: "github", name: "GitHub", api: () => true, graphql: (pathname: string) => pathname === "/graphql",
    scope: (pathname: string) => { const repository = restRepository(pathname); return repository ? { repository } : {}; },
    placeholderOnly: false, downloads: GITHUB_DOWNLOAD_HOSTS,
  },
  "gitlab.com": {
    provider: "gitlab", name: "GitLab", api: (pathname: string) => pathname.startsWith("/api/"), graphql: (pathname: string) => pathname === "/api/graphql",
    scope: () => ({}), placeholderOnly: true, downloads: [],
  },
  "dev.azure.com": {
    provider: "azure-devops", name: "Azure DevOps", api: () => true, graphql: () => false,
    scope: (pathname: string) => { const account = pathname.split("/")[1]; return account ? { account: account.toLowerCase() } : {}; },
    placeholderOnly: true, downloads: [],
  },
} satisfies Record<string, ApiRules>);

export function parseApiCredentialGrant(value: unknown): ApiCredentialGrant {
  const invalid = () => new RunnerError(502, "Invalid API credential from the control plane");
  if (!value || typeof value !== "object" || Array.isArray(value)) throw invalid();
  const input = value as Record<string, unknown>;
  const cacheSeconds = input.cacheSeconds;
  if (!Number.isSafeInteger(cacheSeconds) || (cacheSeconds as number) < 0 || (cacheSeconds as number) > 3600) throw invalid();
  if (input.available === false) {
    if (typeof input.reason !== "string" || !/^[\x20-\x7e]{1,500}$/.test(input.reason)) throw invalid();
    return { available: false, reason: input.reason, cacheSeconds: cacheSeconds as number };
  }
  if (input.available !== true || !Array.isArray(input.credentials) || !input.credentials.length || input.credentials.length > 100) throw invalid();
  const credentials = input.credentials.map((item: unknown): ApiCredential => {
    const credential = item as Record<string, unknown> | null;
    if (!credential || typeof credential.account !== "string" || !/^[A-Za-z0-9_.-]{1,100}$/.test(credential.account)
      || typeof credential.authorization !== "string" || !/^[\x21-\x7e][\x20-\x7e]{0,16383}$/.test(credential.authorization)
      || !Array.isArray(credential.repositories) || credential.repositories.length > 100
      || credential.repositories.some(name => typeof name !== "string" || !/^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/.test(name))
      || typeof credential.expiresAt !== "string" || !Number.isFinite(Date.parse(credential.expiresAt))) throw invalid();
    return { account: credential.account, authorization: credential.authorization, repositories: [...credential.repositories as string[]], expiresAt: credential.expiresAt };
  });
  return { available: true, credentials, cacheSeconds: cacheSeconds as number };
}

const READ_ONLY = "sandboxed commands only read through the GitHub API. Comments, issues, merges and pushes go through Pikibun's approved tools "
  + "(github_comment, github_issue, github_merge, git_push)";

export function apiRule(rules: Pick<ApiRules, "graphql">, method: string, pathname: string): "read" | "graphql" | "write" {
  if (method === "GET" || method === "HEAD") return "read";
  if (method === "POST" && rules.graphql(pathname)) return "graphql";
  return "write";
}

function unleasedWrite(rules: ApiRules, what: string): string {
  if (rules.provider === "github") return `${what}: ${READ_ONLY}, or the gh tool (piki:gh), on the session owner's own host`;
  const tool = rules.provider === "gitlab" ? "the glab tool (piki:glab)" : "the az tool (piki:azure-cli)";
  return `${what}: sandboxed commands only read through the ${rules.name} API; it writes only with ${tool}, on the session owner's own host`;
}

export function placeholderOf(headers: IncomingHttpHeaders): { placeholder: boolean; lease?: string; own: boolean } {
  const values: string[] = [];
  const authorization = headers.authorization;
  if (authorization) {
    values.push(authorization);
    const basic = /^Basic\s+([A-Za-z0-9+/=]+)\s*$/i.exec(authorization);
    if (basic) values.push(Buffer.from(basic[1]!, "base64").toString("latin1"));
  }
  const privateToken = headers["private-token"];
  if (privateToken !== undefined) values.push([privateToken].flat().join(","));
  const placeholder = values.some(value => value.includes(API_TOKEN_PLACEHOLDER));
  const lease = values.map(apiWriteLease).find(Boolean);
  return { placeholder, ...(lease ? { lease } : {}), own: !placeholder && (authorization !== undefined || privateToken !== undefined) };
}

function json(response: ServerResponse, status: number, message: string): void {
  if (response.headersSent) { response.destroy(); return; }
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  response.end(`${JSON.stringify({ message, documentation_url: "https://github.com/OpenCara/pikibun#network-access" })}\n`);
}

async function body(request: IncomingMessage, limit: number): Promise<Uint8Array> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size > limit) throw new RunnerError(413, "The API request is too large");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

export async function upstreamAddresses(host: string, lookup: (host: string) => Promise<{ address: string; family: number }[]>
  = name => dnsLookup(name, { all: true, verbatim: true })): Promise<{ address: string; family: number }[]> {
  let addresses: { address: string; family: number }[];
  try { addresses = isIP(host) ? [{ address: host, family: isIP(host) }] : await lookup(host); }
  catch { addresses = []; }
  const usable = (address: string) => publicAddress(address) || (!isIP(host) && fakeIpAddress(address));
  const unusable = addresses.find(entry => !usable(entry.address));
  if (!addresses.length || unusable) {
    throw new RunnerError(502, `${host.slice(0, 253)} does not resolve to a public address${unusable ? ` (it resolves to ${unusable.address} on this host)` : ""}`);
  }
  return addresses.slice(0, 8);
}

export const publicUpstream: ApiUpstream = async ({ url, method, headers, body, signal }) => {
  const host = url.hostname.replace(/^\[|\]$/g, "");
  const checked = await upstreamAddresses(host);
  const lookup: LookupFunction = (_name, options, callback) => {
    if (options.all) (callback as (error: null, addresses: { address: string; family: number }[]) => void)(null, checked);
    else callback(null, checked[0]!.address, checked[0]!.family);
  };
  return new Promise((resolve, reject) => {
    const request = httpsRequest(url, { method, headers: body ? { ...headers, "content-length": String(body.byteLength) } : headers,
      lookup, agent: new HttpsAgent({ keepAlive: false, lookup }), ...(signal ? { signal } : {}) }, response => {
      request.setTimeout(0);
      resolve({ status: response.statusCode ?? 502, headers: response.headers, body: response });
    });
    request.setTimeout(UPSTREAM_TIMEOUT_MS, () => request.destroy(new Error("The API did not answer in time")));
    request.on("error", reject);
    request.end(body);
  });
};

export function credentialFor(credentials: ApiCredential[], scope: { repository?: string; account?: string }, owner?: string): ApiCredential | undefined {
  if (scope.repository) {
    const name = scope.repository.toLowerCase();
    return credentials.find(credential => credential.repositories.some(item => item.toLowerCase() === name));
  }
  if (scope.account !== undefined) {
    const account = scope.account.toLowerCase();
    return credentials.find(credential => credential.account.toLowerCase() === account);
  }
  const wanted = owner?.toLowerCase();
  return credentials.find(credential => credential.account.toLowerCase() === wanted) ?? credentials[0];
}

export class ApiAccess {
  readonly #options: ApiAccessOptions;
  readonly #authority: InterceptionAuthority;
  readonly #upstream: ApiUpstream;
  readonly #server: Server;
  readonly #hosts = new WeakMap<object, string>();
  readonly #credentials = new Map<string, { grant: ApiCredentialGrant; until: number }>();
  readonly #pending = new Map<string, Promise<ApiCredentialGrant>>();
  readonly #leases = new Set<string>();

  constructor(options: ApiAccessOptions) {
    this.#options = options;
    this.#authority = options.authority ?? interceptionAuthority();
    this.#upstream = options.upstream ?? publicUpstream;
    this.#server = createServer((request, response) => void this.#request(request, response).catch(() => json(response, 502, "The API request could not be completed")));
    this.#server.on("clientError", (_error, socket) => socket.destroy());
  }

  handles(host: string): boolean { return this.#authority.hosts.includes(host) && apiRules[host] !== undefined; }

  lease(): { token: string; release(): void } {
    const lease = randomBytes(32).toString("base64url");
    this.#leases.add(lease);
    return { token: apiWriteToken(lease), release: () => { this.#leases.delete(lease); } };
  }

  intercept(client: Duplex, head: Buffer, host: string): void {
    if (head.length) client.unshift(head);
    const socket = new TLSSocket(client, { isServer: true, secureContext: this.#authority.context(host), ALPNProtocols: ["http/1.1"] });
    socket.on("error", () => socket.destroy());
    socket.once("close", () => client.destroy());
    this.#hosts.set(socket, host);
    this.#server.emit("connection", socket);
  }

  async #credential(host: string, access: ApiAccessKind): Promise<ApiCredentialGrant> {
    const key = `${access} ${host}`;
    const cached = this.#credentials.get(key);
    if (cached && cached.until > Date.now()) return cached.grant;
    let pending = this.#pending.get(key);
    if (!pending) {
      pending = (async () => {
        let grant: ApiCredentialGrant;
        try { grant = parseApiCredentialGrant(await this.#options.credential(host, access)); }
        catch (error) {
          const reason = error instanceof RunnerError && /^[\x20-\x7e]{1,300}$/.test(error.message) ? error.message : "Pikibun gave no credential for this API";
          const unavailable: ApiCredentialGrant = { available: false, reason, cacheSeconds: 0 };
          this.#credentials.set(key, { grant: unavailable, until: Date.now() + UNAVAILABLE_CACHE_MS });
          return unavailable;
        }
        const expiry = grant.available ? Math.min(...grant.credentials.map(item => Date.parse(item.expiresAt))) - EXPIRY_MARGIN_MS : Infinity;
        const seconds = Math.min(grant.cacheSeconds, API_CREDENTIAL_CACHE_SECONDS);
        const until = Math.min(Date.now() + (grant.available ? seconds * 1000 : Math.max(seconds * 1000, UNAVAILABLE_CACHE_MS)), expiry);
        if (until > Date.now()) this.#credentials.set(key, { grant, until });
        return grant;
      })().finally(() => this.#pending.delete(key));
      this.#pending.set(key, pending);
    }
    return pending;
  }

  async #request(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const host = this.#hosts.get(request.socket);
    const method = request.method ?? "GET";
    const path = request.url ?? "";
    if (!host) return json(response, 421, "Unknown API connection");
    const rules = apiRules[host]!;
    const pathname = path.split("?")[0]!;
    const target = `${method} ${host}${pathname}`.slice(0, 300);
    const refuse = (status: number, reason: string) => {
      this.#options.record({ target, outcome: "refused", reason });
      request.resume();
      json(response, status, reason);
    };
    const named = (request.headers.host ?? "").toLowerCase().replace(/:443$/, "");
    if (named !== host) return refuse(421, `This connection is for ${host}, not ${named.slice(0, 253) || "no host"}`);
    if (!path.startsWith("/") || path.length > PATH_LENGTH) return refuse(400, "Invalid API request path");
    const carried = placeholderOf(request.headers);
    const leased = carried.lease !== undefined && this.#leases.has(carried.lease);
    const isApi = rules.api(pathname) && (!rules.placeholderOnly || carried.placeholder);
    const rule = isApi ? apiRule(rules, method, pathname) : "read";
    if (isApi && rule === "write" && !leased) return refuse(403, unleasedWrite(rules, `${method} ${pathname.slice(0, 200)}`));

    let payload: Uint8Array | undefined;
    let owner: string | undefined;
    let mutates = false;
    if (method !== "GET" && method !== "HEAD") {
      try { payload = await body(request, rule === "graphql" ? GRAPHQL_BYTES : BODY_BYTES); }
      catch (error) { return refuse(error instanceof RunnerError ? error.status : 400, error instanceof RunnerError ? error.message : "Invalid API request"); }
    } else request.resume();
    if (rule === "graphql") {
      let document: { query?: unknown; variables?: unknown };
      try { document = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(payload)) as typeof document; }
      catch { return refuse(400, "A GraphQL request is a JSON object with a query"); }
      if (!document || typeof document !== "object" || typeof document.query !== "string") return refuse(400, "A GraphQL request is a JSON object with a query");
      mutates = graphqlWrites(document.query);
      if (mutates && !leased) return refuse(403, rules.provider === "github" ? `GraphQL mutations: ${READ_ONLY}` : unleasedWrite(rules, "GraphQL mutations"));
      const variables = document.variables as Record<string, unknown> | null | undefined;
      if (variables && typeof variables === "object" && typeof variables.owner === "string") owner = variables.owner;
    }

    const grant = await this.#options.grant();
    const open = hostAllowed(grant.policy, host);
    const headers: Record<string, string> = {};
    for (const [name, value] of Object.entries(request.headers)) {
      if (!HOP_BY_HOP.has(name) && !name.startsWith("proxy-") && value !== undefined) headers[name] = [value].flat().join(", ");
    }
    headers.host = host;
    let reason: string;
    let credential: ApiCredential | undefined;
    let access: ApiAccessKind = "read";
    let ownerInstead: (() => Promise<ApiCredential | undefined>) | undefined;
    if (!isApi) {
      if (!open) return refuse(403, `This workspace's network policy doesn't allow ${host}; Pikibun answers only its API (${rules.name}'s command-line tool) for this session`);
      if (carried.own) {
        if (request.headers.authorization) headers.authorization = request.headers.authorization;
        if (request.headers["private-token"] !== undefined) headers["private-token"] = [request.headers["private-token"]].flat().join(", ");
      }
      reason = "not the API, without a credential";
    } else if (carried.own) {
      if (!open) return refuse(403, `This request carries its own credential, and this workspace's network policy doesn't allow ${host}; leave the token Pikibun sets (GH_TOKEN, GITLAB_TOKEN, AZURE_DEVOPS_EXT_PAT) as it is`);
      if (request.headers.authorization) headers.authorization = request.headers.authorization;
      if (request.headers["private-token"] !== undefined) headers["private-token"] = [request.headers["private-token"]].flat().join(", ");
      reason = "the command's own credential";
    } else {
      const scope = rules.scope(pathname);
      const named = grant.apis?.some(api => api.host === host) === true;
      const none = (what: string): ApiCredentialGrant => ({ available: false, cacheSeconds: 0,
        reason: `Pikibun gives this session no credential for the ${rules.name} API (only sessions that clone their workspace's ${what} repositories get one)` });
      let available: ApiCredentialGrant = named ? await this.#credential(host, "read") : none(rules.name);
      const appRead = rules.provider === "github" && rule === "read" && scope.repository !== undefined && available.available
        && credentialFor(available.credentials, scope) !== undefined;
      if (leased && named && appRead) {
        ownerInstead = async () => {
          const write = await this.#credential(host, "write");
          return write.available ? credentialFor(write.credentials, scope) : undefined;
        };
      }
      if (leased && named && !appRead) {
        const write = await this.#credential(host, "write");
        if (write.available) { available = write; access = "write"; }
        else if (rule === "write" || mutates) {
          return refuse(403, `${write.reason}; ${method} ${pathname.slice(0, 200)} didn't reach ${rules.name}`);
        }
      }
      credential = available.available ? credentialFor(available.credentials, scope, owner) : undefined;
      if (credential) {
        headers.authorization = credential.authorization;
        reason = access === "write" || rules.provider !== "github" ? `the session owner's token for ${credential.account}` : `read-only token for ${credential.account}`;
      } else if (open) reason = "without a credential";
      else if (!available.available) return refuse(403, `${available.reason}; ${host} is reachable only with that credential under this workspace's network policy`);
      else if (scope.account !== undefined) return refuse(403, `${scope.account.slice(0, 100)} is not an organization of this workspace's repositories that the session owner has an account for`);
      else return refuse(403, `${scope.repository ?? pathname.slice(0, 200)} is not one of this workspace's repositories that the session owner can read`);
    }

    let upstream: UpstreamResponse;
    try {
      upstream = await this.#upstream({ url: new URL(`https://${host}${path}`), method, headers, ...(payload ? { body: payload } : {}) });
      const refused = (upstream.status === 403 || upstream.status === 404) && upstream.headers["x-ratelimit-remaining"] !== "0"
        && upstream.headers["retry-after"] === undefined;
      const instead = refused && ownerInstead ? await ownerInstead() : undefined;
      if (instead) {
        upstream.body.resume();
        credential = instead;
        access = "write";
        reason = `the session owner's token for ${instead.account}, as the read-only token was refused (${upstream.status})`;
        upstream = await this.#upstream({ url: new URL(`https://${host}${path}`), method, headers: { ...headers, authorization: instead.authorization } });
      }
      let current = new URL(`https://${host}${path}`);
      for (let hop = 0; isApi && method === "GET" && hop < REDIRECTS && [301, 302, 303, 307, 308].includes(upstream.status); hop++) {
        let location: URL;
        try { location = new URL(String(upstream.headers.location ?? ""), current); } catch { break; }
        if (location.protocol !== "https:" || location.username || location.password || !rules.downloads.some(pattern => pattern.test(location.hostname))) break;
        upstream.body.resume();
        const follow: Record<string, string> = {};
        for (const name of ["accept", "user-agent", "range"]) if (headers[name]) follow[name] = headers[name]!;
        upstream = await this.#upstream({ url: location, method: "GET", headers: { ...follow, host: location.host } });
        reason += `, then ${location.hostname.slice(0, 100)}`;
        current = location;
      }
    } catch (error) {
      return refuse(502, error instanceof RunnerError ? error.message : `${host} could not be reached`);
    }
    if (upstream.status === 401 && credential) this.#credentials.delete(`${access} ${host}`);
    this.#options.record({ target, outcome: "allowed", reason: `${reason} (${upstream.status})` });
    const answer: Record<string, string | string[]> = {};
    for (const [name, value] of Object.entries(upstream.headers)) {
      if (value !== undefined && (!HOP_BY_HOP.has(name) || name === "content-length")) answer[name] = value;
    }
    response.writeHead(upstream.status, answer);
    response.once("close", () => upstream.body.destroy());
    upstream.body.on("error", () => response.destroy());
    upstream.body.pipe(response);
  }
}

export function graphqlWrites(query: string): boolean {
  const text = query.replace(/"""[\s\S]*?"""|"(?:[^"\\\n]|\\.)*"|#[^\n\r]*/g, " ");
  if (/"/.test(text)) return true;
  let depth = 0;
  let outside = "";
  for (const character of text) {
    if (character === "{") depth++;
    else if (character === "}") { depth--; if (depth < 0) return true; }
    else if (depth === 0) outside += character;
    if (depth === 0 && (character === "{" || character === "}")) outside += " ";
  }
  if (depth !== 0) return true;
  return /(?:^|[^A-Za-z0-9_])(?:mutation|subscription)(?![A-Za-z0-9_])/.test(outside);
}
