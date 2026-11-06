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

/*
 * Credentialed APIs (see `credentialedApiHosts`): HTTPS to these hosts ends at the session's egress proxy, which answers
 * with a certificate from the connector's own authority (interception-ca.ts), checks each request, and makes it at the
 * API itself with the session's credential from the control plane. The sandbox holds only API_TOKEN_PLACEHOLDER.
 *
 * Reads go with the session's read credential: for api.github.com a GitHub App installation token that can only read
 * the workspace's repositories the session owner can read; for gitlab.com and dev.azure.com the session owner's own
 * personal access token, which the control plane gives only to the owner's own hosts. Writes go only with a write lease
 * (`lease`): one approved call of a Pikibun extension's command (gh, glab, az) gets a placeholder naming it, and its
 * requests then go with the session owner's own credential, which again only the owner's own hosts get. Every other
 * write is refused here: comments, issues, merges and pushes stay with Pikibun's approved tools.
 */

/** A GraphQL request's body; GitHub's own limit on a query is far below this. */
const GRAPHQL_BYTES = 1024 * 1024;
/** Another request's body (a write's JSON, a form of the website): read whole, as the upstream wants its length. */
const BODY_BYTES = 16 * 1024 * 1024;
const PATH_LENGTH = 8192;
/** An answer's headers must arrive within this; its body may then take as long as it streams. */
const UPSTREAM_TIMEOUT_MS = 60_000;
/** An unavailable credential is asked for again after this, not at every request. */
const UNAVAILABLE_CACHE_MS = 10_000;
/** A credential isn't used within this much of its expiry. */
const EXPIRY_MARGIN_MS = 5 * 60_000;
const REDIRECTS = 3;
/**
 * Where GitHub's API sends downloads (Actions logs and artifacts, release assets, archives): the proxy follows its
 * redirects there itself, without the credential, so `gh run view --log` works whatever the network policy. Redirects
 * anywhere else reach the client as they are.
 */
const GITHUB_DOWNLOAD_HOSTS = [/^codeload\.github\.com$/, /\.githubusercontent\.com$/, /\.blob\.core\.windows\.net$/];
const HOP_BY_HOP = new Set(["connection", "keep-alive", "proxy-authenticate", "proxy-authorization", "proxy-connection", "te", "trailer",
  "transfer-encoding", "upgrade", "host", "authorization", "private-token", "cookie", "content-length", "expect"]);

export interface ApiEntry { target: string; outcome: "allowed" | "refused"; reason?: string }
export interface UpstreamRequest { url: URL; method: string; headers: Record<string, string>; body?: Uint8Array; signal?: AbortSignal }
export interface UpstreamResponse { status: number; headers: IncomingHttpHeaders; body: Readable }
export type ApiUpstream = (request: UpstreamRequest) => Promise<UpstreamResponse>;

export interface ApiAccessOptions {
  /** Asks the control plane for the session's `access` credential for `host` (an ApiCredentialGrant); refusals throw. */
  credential: (host: string, access: ApiAccessKind) => Promise<unknown>;
  /** The session's current grant, for its network policy. */
  grant: () => Promise<EgressGrant>;
  record: (entry: ApiEntry) => void;
  /** Overridable for tests: the authority, and requests to the API (by default, to its public addresses only). */
  authority?: InterceptionAuthority;
  upstream?: ApiUpstream;
}

/** What one credentialed API host is, for the proxy: which of its requests are the API's, and how a credential is chosen. */
export interface ApiRules {
  provider: CredentialedApiProvider;
  name: string;
  /** Whether a request to `pathname` is the API's; others go on as through a tunnel, without a credential. */
  api(pathname: string): boolean;
  /** Whether `pathname` is its GraphQL endpoint, where a POST of a query only reads. */
  graphql(pathname: string): boolean;
  /** What picks the credential for `pathname`: the repository (owner/name) or the account (an organization) it is about. */
  scope(pathname: string): { repository?: string; account?: string };
  /** Only requests that carry the placeholder (from a tool Pikibun set up) get a credential, not every request to the host. */
  placeholderOnly: boolean;
  /** Where its API redirects downloads: fetched here, without the credential. */
  downloads: readonly RegExp[];
}

/** The owner/name a REST path is about, as `/repos/{owner}/{name}/...` names it. */
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
  // gitlab.com is its website too: only /api/ is the API, and only what carries the placeholder (glab's GITLAB_TOKEN) gets a credential.
  "gitlab.com": {
    provider: "gitlab", name: "GitLab", api: (pathname: string) => pathname.startsWith("/api/"), graphql: (pathname: string) => pathname === "/api/graphql",
    scope: () => ({}), placeholderOnly: true, downloads: [],
  },
  // dev.azure.com/{organization}/...: a personal access token is per organization.
  "dev.azure.com": {
    provider: "azure-devops", name: "Azure DevOps", api: () => true, graphql: () => false,
    scope: (pathname: string) => { const account = pathname.split("/")[1]; return account ? { account: account.toLowerCase() } : {}; },
    placeholderOnly: true, downloads: [],
  },
} satisfies Record<string, ApiRules>);

/** A credential grant as the control plane sends it; anything else is refused rather than half-used. */
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

/** What a request may do: read (GET, HEAD), what its GraphQL document says (a POST to the GraphQL endpoint), or write. */
export function apiRule(rules: Pick<ApiRules, "graphql">, method: string, pathname: string): "read" | "graphql" | "write" {
  if (method === "GET" || method === "HEAD") return "read";
  if (method === "POST" && rules.graphql(pathname)) return "graphql";
  return "write";
}

/** Why a write without a write lease is refused. */
function unleasedWrite(rules: ApiRules, what: string): string {
  if (rules.provider === "github") return `${what}: ${READ_ONLY}, or the gh tool (piki:gh), approved, on the session owner's own host`;
  const tool = rules.provider === "gitlab" ? "the glab tool (piki:glab)" : "the az tool (piki:azure-cli)";
  return `${what}: sandboxed commands only read through the ${rules.name} API; it writes only with ${tool}, approved, on the session owner's own host`;
}

/**
 * Whether a request carries Pikibun's placeholder, and the write lease it names: in its Authorization (`Bearer`, `token`,
 * or Basic with it as the password, as az devops sends a PAT) or GitLab's PRIVATE-TOKEN. `own`: a credential of the
 * command's own instead.
 */
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
  // GitHub's own error shape, which gh and Octokit show as they are; glab and az show `message` too.
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

/**
 * The addresses the proxy connects to for `host`, an API host or a download host of its redirects: public ones only,
 * or the fake-IP addresses of a proxy on the host (fakeIpAddress). Those are let through here, unlike for tunnels: these
 * hosts are fixed names, and the request goes over TLS checked against the name with Node's own roots, so a fake-IP
 * proxy can only pass it on to the API itself, while tunnels go wherever the workspace's network policy lets a session
 * name. Hosts behind such a proxy (where DNS answers 198.18.0.1 for api.github.com) otherwise get no API at all.
 */
export async function upstreamAddresses(host: string, lookup: (host: string) => Promise<{ address: string; family: number }[]>
  = name => dnsLookup(name, { all: true, verbatim: true })): Promise<{ address: string; family: number }[]> {
  let addresses: { address: string; family: number }[];
  try { addresses = isIP(host) ? [{ address: host, family: isIP(host) }] : await lookup(host); }
  catch { addresses = []; }
  const usable = (address: string) => publicAddress(address) || (!isIP(host) && fakeIpAddress(address));
  if (!addresses.length || addresses.some(entry => !usable(entry.address))) {
    throw new RunnerError(502, `${host.slice(0, 253)} does not resolve to a public address${addresses.length ? ` (it resolves to ${addresses[0]!.address} on this host)` : ""}`);
  }
  return addresses.slice(0, 8);
}

/** A request to `url` at its public addresses only, connected to exactly the addresses checked, without redirects. */
export const publicUpstream: ApiUpstream = async ({ url, method, headers, body, signal }) => {
  const host = url.hostname.replace(/^\[|\]$/g, "");
  const checked = await upstreamAddresses(host);
  const lookup: LookupFunction = (_name, options, callback) => {
    if (options.all) (callback as (error: null, addresses: { address: string; family: number }[]) => void)(null, checked);
    else callback(null, checked[0]!.address, checked[0]!.family);
  };
  return new Promise((resolve, reject) => {
    // Its own agent: never a proxy from the connector's environment, which would resolve the name itself.
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

/**
 * The credential for a request: about `repository` (owner/name), the one that covers it, or none; about `account` (an
 * Azure DevOps organization the path names), that account's, or none; otherwise the one for the owner a GraphQL query
 * names, `owner`, or the first.
 */
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

/** One session's credentialed APIs, inside its egress proxy (see EgressProxy's tunnels). */
export class ApiAccess {
  readonly #options: ApiAccessOptions;
  readonly #authority: InterceptionAuthority;
  readonly #upstream: ApiUpstream;
  readonly #server: Server;
  readonly #hosts = new WeakMap<object, string>();
  readonly #credentials = new Map<string, { grant: ApiCredentialGrant; until: number }>();
  readonly #pending = new Map<string, Promise<ApiCredentialGrant>>();
  /** The write leases of the calls running now (see `lease`). */
  readonly #leases = new Set<string>();

  constructor(options: ApiAccessOptions) {
    this.#options = options;
    this.#authority = options.authority ?? interceptionAuthority();
    this.#upstream = options.upstream ?? publicUpstream;
    this.#server = createServer((request, response) => void this.#request(request, response).catch(() => json(response, 502, "The API request could not be completed")));
    this.#server.on("clientError", (_error, socket) => socket.destroy());
  }

  /** Whether the proxy answers for `host` itself. */
  handles(host: string): boolean { return this.#authority.hosts.includes(host) && apiRules[host] !== undefined; }

  /**
   * A write lease for one approved call: the placeholder its command gets instead of the plain one, whose requests may
   * write as the session owner (where the control plane gives this host the owner's credential) until it is released.
   */
  lease(): { token: string; release(): void } {
    const lease = randomBytes(32).toString("base64url");
    this.#leases.add(lease);
    return { token: apiWriteToken(lease), release: () => { this.#leases.delete(lease); } };
  }

  /** Takes over a tunnel to `host` the client asked for, answered by the proxy itself over TLS. */
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
    // The API's requests, as its rules and the placeholder say; anything else to the host (gitlab.com's website) goes on as
    // through a tunnel, where the policy allows the host, without a credential.
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
    if (!isApi) {
      if (!open) return refuse(403, `This workspace's network policy doesn't allow ${host}; Pikibun answers only its API (${rules.name}'s command-line tool) for this session`);
      // As it would have gone through a tunnel; only the placeholder is held back.
      if (carried.own) {
        if (request.headers.authorization) headers.authorization = request.headers.authorization;
        if (request.headers["private-token"] !== undefined) headers["private-token"] = [request.headers["private-token"]].flat().join(", ");
      }
      reason = "not the API, without a credential";
    } else if (carried.own) {
      // A credential the command brought itself, as it could have sent through a tunnel the policy allows.
      if (!open) return refuse(403, `This request carries its own credential, and this workspace's network policy doesn't allow ${host}; leave the token Pikibun sets (GH_TOKEN, GITLAB_TOKEN, AZURE_DEVOPS_EXT_PAT) as it is`);
      if (request.headers.authorization) headers.authorization = request.headers.authorization;
      if (request.headers["private-token"] !== undefined) headers["private-token"] = [request.headers["private-token"]].flat().join(", ");
      reason = "the command's own credential";
    } else {
      const scope = rules.scope(pathname);
      // Only a grant that names the API comes with a credential for it; the placeholder goes no further either way.
      const named = grant.apis?.some(api => api.host === host) === true;
      const none = (what: string): ApiCredentialGrant => ({ available: false, cacheSeconds: 0,
        reason: `Pikibun gives this session no credential for the ${rules.name} API (only sessions that clone their workspace's ${what} repositories get one)` });
      // An approved call's requests all go as the session owner where this host gets their credential; its reads otherwise
      // as any other.
      let available: ApiCredentialGrant = named ? await this.#credential(host, "read") : none(rules.name);
      if (leased && named) {
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
      // Downloads the API points elsewhere are fetched here, without the credential.
      // Each hop's Location is relative to the URL that answered it.
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
    // A credential the API no longer takes is asked for again at the next request.
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

/**
 * Whether a GraphQL document may define a mutation or subscription: strings and comments are set aside, then any word
 * `mutation` or `subscription` outside every selection set (`{ ... }`) counts, wherever it stands. GraphQL ignores
 * commas and a byte order mark as it does spaces, so an operation needn't start a line or follow a `}` (`,mutation{...}`,
 * `query{a},mutation{b}`). A document it can't read as balanced braces counts too: the proxy rather refuses a read than
 * lets a write through as one, and for gitlab.com and dev.azure.com, nothing but this stands between the session owner's
 * own token and a write no one approved.
 */
export function graphqlWrites(query: string): boolean {
  const text = query.replace(/"""[\s\S]*?"""|"(?:[^"\\\n]|\\.)*"|#[^\n\r]*/g, " ");
  // A string or block string left open is no document to read.
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
