import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import test from 'node:test';
import * as fixes from '../scripts/nsh-web-fixes.mjs';

const root = new URL('../', import.meta.url);
const list = readFileSync(new URL('docs/design/upstream-workarounds.md', root), 'utf8');

test('every patch the build applies to Native Shell\'s web runtime is on the list of upstream workarounds', () => {
  const patches = Object.entries(fixes).filter(([, value]) => typeof value === 'string').map(([name]) => name);
  assert.ok(patches.length >= 6);
  for (const name of patches) assert.ok(list.includes(`\`${name}\``), `${name} is listed in docs/design/upstream-workarounds.md`);
});

test('every file the list of upstream workarounds names exists', () => {
  const rows = list.split('\n').filter(line => line.startsWith('| **'));
  assert.ok(rows.length > 0);
  for (const row of rows) {
    const where = row.split(' | ')[1] ?? '';
    for (const [, path] of where.matchAll(/`([^`]+)`/g)) {
      if (!/^[\w.-]+\//.test(path!)) continue;
      assert.ok(existsSync(new URL(path!.replace(/ \(.*$/, ''), root)), `${path} exists`);
    }
  }
});
