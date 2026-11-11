import assert from 'node:assert/strict';
import { BlockList } from 'node:net';
import test from 'node:test';
import { publicAddress as proxyPublic } from '../apps/runner/src/egress.js';
import { publicAddress as databasePublic } from '../apps/server/src/workspace-databases/hosts.js';
import { blockedAddress } from '../extensions/context-files/context-files.ts';
import { NON_PUBLIC_IPV4, NON_PUBLIC_IPV6 } from '../packages/shared/src/non-public-addresses.js';
// @ts-expect-error The script is plain JavaScript without declarations.
import { staleCopies } from '../scripts/copy-shared-files.mjs';

test('the extension\'s copy of the non-public address table is the shared one', () => {
  assert.deepEqual(staleCopies(), [], 'run node scripts/copy-shared-files.mjs');
});

const nonPublic = [
  '0.1.2.3', '10.0.0.1', '100.64.0.1', '127.0.0.1', '169.254.169.254', '172.16.0.1', '192.0.0.8', '192.0.2.1', '192.88.99.1', '192.168.1.1',
  '198.18.0.1', '198.51.100.7', '203.0.113.9', '224.0.0.1', '255.255.255.255',
  '::', '::1', '::ffff:10.0.0.1', '::ffff:a00:1', '64:ff9b::a00:1', '64:ff9b:1::1', '100::1', '2001::1', '2001:1ff::1', '2001:db8::1', '2002:a00:1::1',
  '3fff::1', '5f00::1', 'fc00::1', 'fd12:3456::1', 'fe80::1', 'fec0::1', 'ff02::1',
];
const publicAddresses = ['1.1.1.1', '8.8.8.8', '140.82.112.3', '2606:4700::1111', '2a00:1450::1', '2001:4860:4860::8888'];

test('the session proxy, workspace databases and context files refuse the same non-public addresses', () => {
  for (const address of nonPublic) {
    assert.equal(proxyPublic(address), false, `proxy: ${address}`);
    assert.equal(databasePublic(address), false, `databases: ${address}`);
    assert.equal(blockedAddress(address, new BlockList()), true, `context files: ${address}`);
  }
  for (const address of publicAddresses) {
    assert.equal(proxyPublic(address), true, `proxy: ${address}`);
    assert.equal(databasePublic(address), true, `databases: ${address}`);
    assert.equal(blockedAddress(address, new BlockList()), false, `context files: ${address}`);
  }
});

test('every range of the table is refused at its first and last address', () => {
  const list = new BlockList();
  for (const [network, prefix] of NON_PUBLIC_IPV4) list.addSubnet(network, prefix, 'ipv4');
  for (const [network, prefix] of NON_PUBLIC_IPV6) list.addSubnet(network, prefix, 'ipv6');
  for (const [network] of NON_PUBLIC_IPV4) {
    assert.equal(proxyPublic(network), false, network);
    assert.equal(databasePublic(network), false, network);
  }
  for (const [network] of NON_PUBLIC_IPV6) {
    assert.equal(proxyPublic(network), false, network);
    assert.equal(databasePublic(network), false, network);
    assert.equal(blockedAddress(network, new BlockList()), true, network);
  }
});
