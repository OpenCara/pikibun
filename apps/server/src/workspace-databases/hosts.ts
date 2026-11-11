import { lookup as dnsLookup } from 'node:dns/promises';
import { BlockList, isIP } from 'node:net';
import { NON_PUBLIC_IPV4, NON_PUBLIC_IPV6 } from '../../../../packages/shared/src/non-public-addresses.js';
import { WorkspaceDatabaseError } from './types.js';

export type HostLookup = (host: string) => Promise<string[]>;

const lookupTimeoutMs = 10_000;

const nonPublicIpv4 = new BlockList();
for (const [network, prefix] of NON_PUBLIC_IPV4) nonPublicIpv4.addSubnet(network, prefix, 'ipv4');
const nonPublicIpv6 = new BlockList();
for (const [network, prefix] of NON_PUBLIC_IPV6) nonPublicIpv6.addSubnet(network, prefix, 'ipv6');

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
