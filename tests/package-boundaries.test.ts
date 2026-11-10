import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const mayImport: Record<string, readonly string[]> = {
  'packages/shared': [],
  'packages/client': ['packages/shared'],
  'packages/cli': ['apps/runner', 'apps/server'],
  'apps/server': ['packages/shared', 'apps/runner'],
  'apps/runner': ['packages/shared', 'extensions'],
  'apps/nsh': ['packages/shared', 'packages/client', 'apps/runner'],
  extensions: [],
};
const areas = Object.keys(mayImport);
const platformNeutral = ['packages/shared', 'packages/client'];
const runnerFilesTheClientReads = ['apps/runner/src/app-host-protocol'];

interface Import { file: string; specifier: string }

function sources(directory: string, found: string[] = []): string[] {
  for (const name of readdirSync(join(repository, directory))) {
    if (name === 'node_modules' || name === 'dist' || name.startsWith('.')) continue;
    const path = `${directory}/${name}`;
    if (statSync(join(repository, path)).isDirectory()) sources(path, found);
    else if (/\.(ts|tsx|mjs)$/.test(name)) found.push(path);
  }
  return found;
}

const importedSpecifier = /(?:^|\n)\s*(?:import|export)\s[^;'"]*?from\s*["']([^"']+)["']|import\(\s*["']([^"']+)["']\s*\)|(?:^|\n)import\s+["']([^"']+)["']/g;

function imports(area: string): Import[] {
  return sources(area).flatMap(file => [...readFileSync(join(repository, file), 'utf8').matchAll(importedSpecifier)]
    .map(match => ({ file, specifier: (match[1] ?? match[2] ?? match[3])! })));
}

const targetOf = ({ file, specifier }: Import) => relative(repository, resolve(repository, dirname(file), specifier)).replaceAll('\\', '/');
const areaOf = (path: string) => areas.find(area => path.startsWith(`${area}/`));

test('each part of the repository imports only the parts below it', () => {
  const crossing = areas.flatMap(area => imports(area)
    .filter(({ specifier }) => specifier.startsWith('.'))
    .map(found => ({ ...found, target: targetOf(found) }))
    .filter(({ target }) => areaOf(target) !== area && !mayImport[area]!.includes(areaOf(target) ?? 'outside every part'))
    .map(({ file, target }) => `${file} imports ${target}`));
  assert.deepEqual(crossing, []);
});

test('the shared and client packages import no npm package and nothing of Node.js', () => {
  const bare = platformNeutral.flatMap(area => imports(area)
    .filter(({ specifier }) => !specifier.startsWith('.'))
    .map(({ file, specifier }) => `${file} imports ${specifier}`));
  assert.deepEqual(bare, []);
});

test('the client reads only the app host protocol of the connector', () => {
  const others = imports('apps/nsh')
    .filter(({ specifier }) => specifier.startsWith('.'))
    .map(found => ({ ...found, target: targetOf(found) }))
    .filter(({ target }) => areaOf(target) === 'apps/runner' && !runnerFilesTheClientReads.includes(target.replace(/\.(ts|js)$/, '')))
    .map(({ file, target }) => `${file} imports ${target}`);
  assert.deepEqual(others, []);
});
