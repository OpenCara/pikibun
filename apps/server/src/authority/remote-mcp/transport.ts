import { lookup as dnsLookup } from 'node:dns';
import { request as httpsRequest } from 'node:https';
import { BlockList, isIP, type LookupFunction } from 'node:net';
import { NON_PUBLIC_IPV4, NON_PUBLIC_IPV6 } from '../../../../../packages/shared/src/non-public-addresses.js';
import type { RemoteMcpHttpRequest, RemoteMcpHttpResponse, RemoteMcpTransport } from '../../../../../packages/shared/src/remote-mcp.js';
import { answersId, eventStreamMessages } from './client.js';

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

export function publicHttpsTransport(resolve?: AddressLookup): RemoteMcpTransport {
  const lookup = publicLookup(resolve);
  return (request: RemoteMcpHttpRequest) => new Promise<RemoteMcpHttpResponse>((done, reject) => {
    const url = new URL(request.url);
    if (url.protocol !== 'https:') return reject(new RemoteMcpRefused('Remote MCP servers are reached over https:// only'));
    const host = url.hostname.replace(/^\[|\]$/g, '');
    if (isIP(host) && !publicAddress(host)) return reject(new RemoteMcpRefused(`${host} isn't a public address`));
    const method = request.method ?? 'POST';
    const body = Buffer.from(method === 'GET' ? '' : request.body);
    const call = httpsRequest(url, {
      method, lookup, agent: false,
      headers: { ...request.headers, ...(method === 'GET' ? {} : { 'Content-Length': String(body.byteLength) }) },
    }, response => {
      const chunks: Buffer[] = [];
      let total = 0;
      let finished = false;
      const headers: Record<string, string> = {};
      for (const [name, value] of Object.entries(response.headers)) if (typeof value === 'string') headers[name.toLowerCase()] = value;
      const streaming = request.expectId !== undefined && (headers['content-type'] ?? '').includes('text/event-stream');
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
        if (streaming && eventStreamMessages(Buffer.concat(chunks).toString('utf8')).some(message => answersId(message, request.expectId!))) {
          finish();
          call.destroy();
        }
      });
      response.on('end', finish);
      response.on('error', error => { if (!finished) reject(error); });
    });
    const timer = setTimeout(() => call.destroy(new RemoteMcpRefused(`No answer within ${Math.round(request.timeoutMs / 1000)} seconds`)), request.timeoutMs);
    call.on('error', error => reject(error));
    call.on('close', () => clearTimeout(timer));
    call.end(body);
  });
}
