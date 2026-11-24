import { lookup as dnsLookup } from 'node:dns';
import { request as httpsRequest } from 'node:https';
import { BlockList, isIP, type LookupFunction } from 'node:net';
import { StringDecoder } from 'node:string_decoder';
import { NON_PUBLIC_IPV4, NON_PUBLIC_IPV6 } from '../../../../../packages/shared/src/non-public-addresses.js';
import type { RemoteMcpHttpRequest, RemoteMcpHttpResponse, RemoteMcpTransport } from '../../../../../packages/shared/src/remote-mcp.js';
import { answersId, EventStreamReader } from './client.js';

const nonPublicIpv4 = new BlockList();
for (const [network, prefix] of NON_PUBLIC_IPV4) nonPublicIpv4.addSubnet(network, prefix, 'ipv4');
const nonPublicIpv6 = new BlockList();
for (const [network, prefix] of NON_PUBLIC_IPV6) nonPublicIpv6.addSubnet(network, prefix, 'ipv6');

export class RemoteMcpRefused extends Error {}

export function publicAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 0 || address.includes('%')) return false;
  try {
    return family === 4 ? !nonPublicIpv4.check(address, 'ipv4') : !nonPublicIpv6.check(address, 'ipv6');
  } catch {
    return false;
  }
}

export type AddressLookup = (host: string, callback: (error: Error | null, addresses: { address: string; family: number }[]) => void) => void;

const systemLookup: AddressLookup = (host, callback) => dnsLookup(host, { all: true, verbatim: true }, (error, addresses) => callback(error, addresses ?? []));

export function publicLookup(resolve: AddressLookup = systemLookup): LookupFunction {
  return (hostname, options, callback) => {
    resolve(hostname, (error, addresses) => {
      if (error) return callback(error, '', 0);
      const refused = !addresses.length || addresses.some(entry => !publicAddress(entry.address));
      if (refused) return callback(new RemoteMcpRefused(`${hostname} resolves to an address that isn't public`), '', 0);
      if ((options as { all?: boolean }).all) return (callback as unknown as (error: Error | null, addresses: { address: string; family: number }[]) => void)(null, addresses);
      callback(null, addresses[0]!.address, addresses[0]!.family);
    });
  };
}

export const remoteMcpConcurrency = Object.freeze({ perServer: 8, total: 64, waitingPerServer: 32, waiting: 256 });

export type RemoteMcpConcurrency = Readonly<Record<keyof typeof remoteMcpConcurrency, number>>;

interface Waiter { key: string; start(): void }

export class RemoteMcpGate {
  readonly #running = new Map<string, number>();
  readonly #waiting: Waiter[] = [];
  #total = 0;

  constructor(private readonly limits: RemoteMcpConcurrency = remoteMcpConcurrency) {}

  get running(): number { return this.#total; }
  get waiting(): number { return this.#waiting.length; }

  #free(key: string): boolean {
    return this.#total < this.limits.total && (this.#running.get(key) ?? 0) < this.limits.perServer;
  }

  #take(key: string): () => void {
    this.#running.set(key, (this.#running.get(key) ?? 0) + 1);
    this.#total++;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const left = this.#running.get(key)! - 1;
      if (left) this.#running.set(key, left);
      else this.#running.delete(key);
      this.#total--;
      for (let index = 0; index < this.#waiting.length && this.#total < this.limits.total;) {
        const waiter = this.#waiting[index]!;
        if (!this.#free(waiter.key)) { index++; continue; }
        this.#waiting.splice(index, 1);
        waiter.start();
      }
    };
  }

  enter(key: string, timeoutMs: number): Promise<() => void> {
    if (this.#free(key)) return Promise.resolve(this.#take(key));
    if (this.#waiting.length >= this.limits.waiting || this.#waiting.filter(waiter => waiter.key === key).length >= this.limits.waitingPerServer) {
      return Promise.reject(new RemoteMcpRefused('Too many calls to this remote MCP server are running and waiting already: try again shortly'));
    }
    return new Promise((resolve, reject) => {
      const waiter: Waiter = { key, start: () => { clearTimeout(timer); resolve(this.#take(key)); } };
      const timer = setTimeout(() => {
        const index = this.#waiting.indexOf(waiter);
        if (index !== -1) this.#waiting.splice(index, 1);
        reject(new RemoteMcpRefused(`No answer within ${Math.round(timeoutMs / 1000)} seconds: other calls to this remote MCP server were still running`));
      }, timeoutMs);
      this.#waiting.push(waiter);
    });
  }
}

export interface PublicHttpsOptions { request?: typeof httpsRequest; gate?: RemoteMcpGate }

export function publicHttpsTransport(resolve?: AddressLookup, options: PublicHttpsOptions = {}): RemoteMcpTransport {
  const lookup = publicLookup(resolve);
  const send = options.request ?? httpsRequest;
  const gate = options.gate ?? new RemoteMcpGate();
  const exchange = (request: RemoteMcpHttpRequest, url: URL, timeoutMs: number) => new Promise<RemoteMcpHttpResponse>((done, reject) => {
    const body = Buffer.from(request.body);
    const call = send(url, {
      method: 'POST', lookup, agent: false,
      headers: { ...request.headers, 'Content-Length': String(body.byteLength) },
    }, response => {
      const chunks: Buffer[] = [];
      let total = 0;
      let finished = false;
      const headers: Record<string, string> = {};
      for (const [name, value] of Object.entries(response.headers)) if (typeof value === 'string') headers[name.toLowerCase()] = value;
      const streaming = request.expectId !== undefined && (headers['content-type'] ?? '').includes('text/event-stream');
      const decoder = new StringDecoder('utf8');
      const events = new EventStreamReader();
      const finish = () => {
        if (finished) return;
        finished = true;
        done({ status: response.statusCode ?? 0, headers, body: Buffer.concat(chunks).toString('utf8') });
      };
      response.on('data', (chunk: Buffer) => {
        if (finished) return;
        total += chunk.byteLength;
        if (total > request.maxBytes) {
          call.destroy(new RemoteMcpRefused(`The answer was larger than ${request.maxBytes} bytes`));
          return;
        }
        chunks.push(chunk);
        if (streaming && events.push(decoder.write(chunk)).some(message => answersId(message, request.expectId!))) {
          finish();
          call.destroy();
        }
      });
      response.on('end', finish);
      response.on('error', error => { if (!finished) reject(error); });
    });
    const timer = setTimeout(() => call.destroy(new RemoteMcpRefused(`No answer within ${Math.round(request.timeoutMs / 1000)} seconds`)), timeoutMs);
    call.on('error', error => reject(error));
    call.on('close', () => clearTimeout(timer));
    call.end(body);
  });
  return async (request: RemoteMcpHttpRequest) => {
    const url = new URL(request.url);
    if (url.protocol !== 'https:') throw new RemoteMcpRefused('Remote MCP servers are reached over https:// only');
    const host = url.hostname.replace(/^\[|\]$/g, '');
    if (isIP(host) && !publicAddress(host)) throw new RemoteMcpRefused(`${host} isn't a public address`);
    const asked = Date.now();
    const release = await gate.enter(url.origin, request.timeoutMs);
    try { return await exchange(request, url, Math.max(1, request.timeoutMs - (Date.now() - asked))); }
    finally { release(); }
  };
}
