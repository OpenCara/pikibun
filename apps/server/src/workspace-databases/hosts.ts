import { lookup as dnsLookup } from 'node:dns/promises';
import { BlockList, isIP } from 'node:net';
import { WorkspaceDatabaseError } from './types.js';

export type HostLookup = (host: string) => Promise<string[]>;

const lookupTimeoutMs = 10_000;

const nonPublicIpv4 = new BlockList();
for (const [network, prefix] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12],
  ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.88.99.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15],
  ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
] as const) nonPublicIpv4.addSubnet(network, prefix, 'ipv4');
const nonPublicIpv6 = new BlockList();
for (const [network, prefix] of [
  ['::', 127], ['::ffff:0:0', 96], ['64:ff9b::', 96], ['64:ff9b:1::', 48], ['100::', 64], ['2001::', 23], ['2001:db8::', 32],
  ['2002::', 16], ['3fff::', 20], ['5f00::', 16], ['fc00::', 7], ['fe80::', 10], ['fec0::', 10], ['ff00::', 8],
] as const) nonPublicIpv6.addSubnet(network, prefix, 'ipv6');

export function publicAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 0 || address.includes('%')) return false;
  try {
    return family === 4 ? !nonPublicIpv4.check(address, 'ipv4') : !nonPublicIpv6.check(address, 'ipv6');
  } catch {
    return false;
  }
}

export interface DatabaseAddress {
  address: string;
  public: boolean;
}

async function systemLookup(host: string): Promise<string[]> {
  return (await dnsLookup(host, { all: true })).map(record => record.address);
}

export async function resolveDatabaseHost(host: string, options: { privateHosts: boolean; lookup?: HostLookup | undefined }): Promise<DatabaseAddress> {
  let addresses: string[];
  if (isIP(host)) addresses = [host];
  else {
    let timer: NodeJS.Timeout | undefined;
    try {
      addresses = await Promise.race([
        (options.lookup ?? systemLookup)(host),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(new Error('DNS lookup timed out.')), lookupTimeoutMs);
        }),
      ]);
    } catch (error) {
      throw new WorkspaceDatabaseError('host_not_found', { cause: error });
    } finally {
      clearTimeout(timer);
    }
  }
  const first = addresses[0];
  if (first === undefined || addresses.some(address => isIP(address) === 0)) throw new WorkspaceDatabaseError('host_not_found');
  if (!options.privateHosts && !addresses.every(publicAddress)) throw new WorkspaceDatabaseError('host_not_allowed');
  return { address: first, public: publicAddress(first) };
}
