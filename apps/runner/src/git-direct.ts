import { fetchGit, gitUpstreamHeaders, GitTransferError, lfsBatchResult, lfsDownload, lfsProviderBatch, type GitSmartService, type LfsTarget }
  from "../../../packages/shared/src/git-transfer.js";
import { GIT_DIRECT_CACHE_SECONDS, gitDirectAccess, parseLfsBatchRequest, parseLfsObject, type GitDirectAccess, type GitDirectGrant, type GitDirectRequest }
  from "../../../packages/shared/src/network.js";
import { RunnerError } from "./protocol.js";
import { lookup as dnsLookup } from "node:dns/promises";
import { Agent as HttpsAgent, request as httpsRequest } from "node:https";
import { isIP, type LookupFunction } from "node:net";
import { Readable } from "node:stream";
import { publicAddress, TRANSPORT_HEADER, type RelayRequest } from "./egress.js";

const UNREACHABLE_RELAY_MS = 5 * 60_000;
const EXPIRY_MARGIN_MS = 5 * 60_000;
const REVOKE_TIMEOUT_MS = 20_000;

export function parseGitDirectGrant(value: unknown): GitDirectGrant {
  const invalid = () => new RunnerError(502, "Invalid direct Git grant from the control plane");
  if (!value || typeof value !== "object" || Array.isArray(value)) throw invalid();
  const input = value as Record<string, unknown>;
  const cacheSeconds = input.cacheSeconds;
  if (!Number.isSafeInteger(cacheSeconds) || (cacheSeconds as number) < 0 || (cacheSeconds as number) > 3600) throw invalid();
  if (input.direct === false) {
    if (typeof input.reason !== "string" || !/^[\x20-\x7e]{1,500}$/.test(input.reason)) throw invalid();
    return { direct: false, reason: input.reason, cacheSeconds: cacheSeconds as number };
  }
  if (input.direct !== true) throw invalid();
  const https = (text: unknown) => {
    if (typeof text !== "string" || text.length > 2048) return false;
    try { const url = new URL(text); return url.protocol === "https:" && !url.username && !url.password && !url.search && !url.hash; } catch { return false; }
  };
  const header = (text: unknown) => typeof text === "string" && /^[\x21-\x7e][\x20-\x7e]{0,16383}$/.test(text);
  const expiresAt = typeof input.expiresAt === "string" ? Date.parse(input.expiresAt) : NaN;
  const revoke = input.revoke as Record<string, unknown> | undefined;
  if (!https(input.remote) || (input.authorization !== null && !header(input.authorization))
    || !["public", "repository-token", "owner-account", "push-identity"].includes(input.kind as string) || !Number.isFinite(expiresAt)
    || (revoke !== undefined && (!revoke || typeof revoke !== "object" || !https(revoke.url) || !header(revoke.authorization)))) throw invalid();
  return {
    direct: true, remote: input.remote as string, authorization: input.authorization as string | null, kind: input.kind as Extract<GitDirectGrant, { direct: true }>["kind"],
    expiresAt: input.expiresAt as string, cacheSeconds: cacheSeconds as number,
    ...(revoke ? { revoke: { url: revoke.url as string, authorization: revoke.authorization as string } } : {}),
  };
}

export interface DirectGitOptions {
  grant: (request: Omit<GitDirectRequest, "sessionId">) => Promise<unknown>;
  fetch?: typeof fetch;
  onFallback?: (request: RelayRequest, reason: string) => void;
  lookup?: (host: string) => Promise<ResolvedAddress[]>;
  pinnedFetch?: (url: URL, init: RequestInit | undefined, addresses: ResolvedAddress[]) => Promise<Response>;
}
export interface ResolvedAddress { address: string; family: number }

export function pinnedFetch(url: URL, init: RequestInit | undefined, addresses: ResolvedAddress[]): Promise<Response> {
  if (url.protocol !== "https:" || !addresses.length) return Promise.reject(new TypeError("Only checked https addresses are fetched"));
  const lookup: LookupFunction = (_host, options, callback) => {
    if (options.all) (callback as (error: null, addresses: ResolvedAddress[]) => void)(null, addresses);
    else callback(null, addresses[0]!.address, addresses[0]!.family);
  };
  return new Promise((resolve, reject) => {
    const request = httpsRequest(url, { method: init?.method ?? "GET", headers: Object.fromEntries(new Headers(init?.headers)), lookup,
      agent: new HttpsAgent({ keepAlive: false, lookup }),
      ...(init?.signal ? { signal: init.signal } : {}) }, response => {
      const status = response.statusCode ?? 502;
      const headers = new Headers();
      for (const [name, value] of Object.entries(response.headers)) for (const item of [value ?? []].flat()) headers.append(name, item);
      const empty = status === 204 || status === 205 || status === 304;
      if (empty) response.resume();
      resolve(new Response(empty ? null : Readable.toWeb(response) as ReadableStream<Uint8Array>, { status, headers }));
    });
    request.on("error", reject);
    request.end();
  });
}

export class DirectGit {
  readonly #options: DirectGitOptions;
  readonly #grants = new Map<string, { grant: GitDirectGrant; until: number }>();
  readonly #unreachable = new Map<string, number>();

  constructor(options: DirectGitOptions) {
    this.#options = options;
  }

  async forward(request: RelayRequest): Promise<Response | undefined> {
    const access = gitDirectAccess(request.service);
    const key = `${request.bindingId}\0${access}`;
    if ((this.#unreachable.get(request.bindingId) ?? 0) > Date.now()) return undefined;
    let grant: GitDirectGrant;
    try { grant = await this.#grant(key, request, access); }
    catch {
      this.#grants.set(key, { grant: { direct: false, reason: "unavailable", cacheSeconds: GIT_DIRECT_CACHE_SECONDS }, until: Date.now() + GIT_DIRECT_CACHE_SECONDS * 1000 });
      return undefined;
    }
    if (!grant.direct) return undefined;
    try {
      return await this.#transfer(grant, request);
    } catch (error) {
      this.#grants.delete(key);
      if (!(error instanceof GitTransferError)) throw error;
      if (error.status === 415 || access === "push" || request.body instanceof ReadableStream) throw new RunnerError(error.status, error.message);
      if (error.status === 502) this.#unreachable.set(request.bindingId, Date.now() + UNREACHABLE_RELAY_MS);
      this.#options.onFallback?.(request, error.message);
      return undefined;
    }
  }

  async #grant(key: string, request: RelayRequest, access: GitDirectAccess): Promise<GitDirectGrant> {
    const cached = this.#grants.get(key);
    if (cached && cached.until > Date.now()) return cached.grant;
    this.#grants.delete(key);
    const grant = parseGitDirectGrant(await this.#options.grant({ bindingId: request.bindingId, access, ...(request.command ? { command: request.command } : {}) }));
    const expiry = grant.direct ? Date.parse(grant.expiresAt) - EXPIRY_MARGIN_MS : Infinity;
    if (grant.direct && expiry <= Date.now()) throw new RunnerError(502, "The direct Git grant has expired");
    const until = Math.min(Date.now() + Math.min(grant.cacheSeconds, GIT_DIRECT_CACHE_SECONDS) * 1000, expiry);
    if (until > Date.now()) this.#grants.set(key, { grant, until });
    return grant;
  }

  #publicOnly(remote: string, fetchImpl: typeof fetch): typeof fetch {
    const origin = new URL(remote).origin;
    const lookup = this.#options.lookup ?? (name => dnsLookup(name, { all: true, verbatim: true }));
    const pinned = this.#options.pinnedFetch ?? pinnedFetch;
    return (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      if (url.origin === origin) return fetchImpl(input, init);
      const host = url.hostname.replace(/^\[|\]$/g, "");
      let addresses: ResolvedAddress[];
      try { addresses = isIP(host) ? [{ address: host, family: isIP(host) }] : await lookup(host); }
      catch { addresses = []; }
      if (!addresses.length || addresses.some(entry => !publicAddress(entry.address))) {
        throw new GitTransferError(502, "lfs_unavailable", `${url.hostname.slice(0, 253)} does not resolve to a public address; Git LFS objects are downloaded only from public addresses`);
      }
      return pinned(url, init, addresses.slice(0, 8));
    }) as typeof fetch;
  }

  async #transfer(grant: Extract<GitDirectGrant, { direct: true }>, request: RelayRequest): Promise<Response> {
    const fetchImpl = this.#options.fetch ?? fetch;
    const provider = new URL(grant.remote).host;
    const fullName = new URL(grant.remote).pathname.replace(/^\/+|\.git$/g, "");
    const headers = { "Content-Type": "", "Cache-Control": "no-store", [TRANSPORT_HEADER]: `direct ${grant.kind}` };
    if (request.service === "lfs-batch" || request.service === "lfs-object") {
      const target: LfsTarget = { remote: grant.remote, provider, fullName, authorization: grant.authorization, fetch: this.#publicOnly(grant.remote, fetchImpl) };
      const input = lfsInput(request.body);
      if (request.service === "lfs-batch") {
        const batch = parseOr400(() => parseLfsBatchRequest(input));
        const result = lfsBatchResult(batch.objects, await lfsProviderBatch(target, batch.objects, batch.ref));
        return new Response(JSON.stringify(result), { headers: { ...headers, "Content-Type": "application/json" } });
      }
      const object = parseOr400(() => parseLfsObject(input));
      return new Response(await lfsDownload(target, object), { headers: { ...headers, "Content-Type": "application/octet-stream" } });
    }
    const service = request.service as GitSmartService;
    const revoke = grant.revoke;
    let done = false;
    const settle = () => {
      if (done || !revoke) return;
      done = true;
      void fetchImpl(revoke.url, { method: "DELETE", redirect: "manual", headers: { Authorization: revoke.authorization, Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28", "User-Agent": "OpenCara-Agent-Workspace" }, signal: AbortSignal.timeout(REVOKE_TIMEOUT_MS) })
        .then(response => response.body?.cancel()).catch(() => {});
    };
    let upstream: { body: ReadableStream<Uint8Array>; contentType: string };
    try {
      const upstreamHeaders = gitUpstreamHeaders(service, { userAgent: request.userAgent, gitProtocol: request.gitProtocol,
        contentType: request.contentType, contentEncoding: request.contentEncoding });
      upstream = await fetchGit({ remote: grant.remote, service, authorization: grant.authorization, headers: upstreamHeaders, body: request.body,
        provider, fullName, identity: grant.kind === "push-identity" ? "push" : "owner", fetch: fetchImpl });
    } catch (error) {
      settle();
      throw error;
    }
    return new Response(revoke ? settled(upstream.body, settle) : upstream.body, { headers: { ...headers, "Content-Type": upstream.contentType } });
  }
}

function lfsInput(body: RelayRequest["body"]): unknown {
  if (!(body instanceof Uint8Array)) throw new RunnerError(400, "Invalid Git LFS request");
  try { return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body)); }
  catch { throw new RunnerError(400, "Invalid Git LFS request"); }
}

function parseOr400<T>(parse: () => T): T {
  try { return parse(); }
  catch (error) { throw new RunnerError(400, error instanceof Error && /^[\x20-\x7e]{1,200}$/.test(error.message) ? error.message : "Invalid Git LFS request"); }
}

function settled(body: ReadableStream<Uint8Array>, done: () => void): ReadableStream<Uint8Array> {
  const reader = body.getReader();
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const part = await reader.read();
        if (part.done) { done(); controller.close(); }
        else controller.enqueue(part.value);
      } catch (error) {
        done();
        controller.error(error);
      }
    },
    async cancel(reason) {
      done();
      await reader.cancel(reason).catch(() => {});
    },
  });
}
