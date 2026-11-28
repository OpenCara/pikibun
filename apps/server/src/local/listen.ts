import { isIP } from 'node:net';
import { networkInterfaces, type NetworkInterfaceInfo } from 'node:os';

export const LISTEN_ALL = 'all';
export const LISTEN_LOOPBACK = 'loopback';
export const DEFAULT_LISTEN: readonly string[] = [LISTEN_ALL];
export const LOOPBACK_ADDRESS = '127.0.0.1';
const EVERY_ADDRESS = '0.0.0.0';
const MAX_PLACES = 16;
const INTERFACE_NAME = /^[A-Za-z0-9][\w.@:-]{0,63}$/;

export interface NetworkInterfaceChoice { name: string; addresses: string[] }

type Interfaces = NodeJS.Dict<NetworkInterfaceInfo[]>;

export function listenError(value: unknown): string | undefined {
  if (!Array.isArray(value) || value.length < 1 || value.length > MAX_PLACES) {
    return `Choose where Pikibun listens: all, loopback, or up to ${MAX_PLACES} network interfaces or addresses.`;
  }
  if (value.some(item => typeof item !== 'string' || !(item === LISTEN_ALL || item === LISTEN_LOOPBACK || isIP(item) || INTERFACE_NAME.test(item)))) {
    return 'Pikibun listens on all, loopback, a network interface such as eth0, or an address such as 192.168.1.20.';
  }
  if (new Set(value).size !== value.length) return 'A network interface or address is listed twice.';
  if (value.length > 1 && (value.includes(LISTEN_ALL) || value.includes(LISTEN_LOOPBACK))) {
    return 'all and loopback stand alone: list network interfaces or addresses without them (this computer\'s own loopback is always included).';
  }
  return undefined;
}

export function parseListen(values: readonly string[]): string[] {
  return values.flatMap(value => value.split(',')).map(item => item.trim()).filter(Boolean);
}

function usable(info: NetworkInterfaceInfo): boolean {
  return info.family === 'IPv4' || !info.address.toLowerCase().startsWith('fe80:');
}

export function resolveListen(listen: readonly string[], interfaces: Interfaces = networkInterfaces()): { ok: true; addresses: string[] } | { ok: false; error: string } {
  const error = listenError(listen);
  if (error) return { ok: false, error };
  if (listen[0] === LISTEN_ALL) return { ok: true, addresses: [EVERY_ADDRESS] };
  if (listen[0] === LISTEN_LOOPBACK) return { ok: true, addresses: [LOOPBACK_ADDRESS] };
  const addresses = new Set([LOOPBACK_ADDRESS]);
  for (const place of listen) {
    if (isIP(place)) { addresses.add(place); continue; }
    const found = interfaces[place];
    if (!found) {
      const names = Object.keys(interfaces).sort();
      return { ok: false, error: `This computer has no network interface named ${place}${names.length ? ` (it has ${names.join(', ')})` : ''}.` };
    }
    const own = found.filter(usable).map(info => info.address);
    if (!own.length) return { ok: false, error: `The network interface ${place} has no address to listen on: is it up?` };
    for (const address of own) addresses.add(address);
  }
  return { ok: true, addresses: [...addresses] };
}

export function listenUrl(address: string, port: number): string {
  return `http://${isIP(address) === 6 ? `[${address}]` : address}:${port}`;
}

export function interfaceChoices(interfaces: Interfaces = networkInterfaces()): NetworkInterfaceChoice[] {
  return Object.entries(interfaces)
    .map(([name, infos]) => ({ name, addresses: (infos ?? []).filter(info => !info.internal && usable(info)).map(info => info.address) }))
    .filter(choice => choice.addresses.length && INTERFACE_NAME.test(choice.name))
    .sort((a, b) => a.name.localeCompare(b.name));
}

export function describeListen(listen: readonly string[]): string {
  if (listen[0] === LISTEN_ALL) return 'every network interface';
  if (listen[0] === LISTEN_LOOPBACK) return 'this computer only';
  return `this computer and ${listen.join(', ')}`;
}
