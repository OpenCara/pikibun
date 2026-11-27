import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { mergeTimings, shardFiles } from '../scripts/test-shards.mjs';
import testTimes from '../scripts/test-times-reporter.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));

test('CI\'s shards split the test files by their recorded time, slowest first, each to the lightest shard', () => {
  const timings = { 'tests/a.test.ts': 60, 'tests/b.test.ts': 50, 'tests/c.test.ts': 40, 'tests/d.test.ts': 10, 'tests/e.test.ts': 5 };
  const files = Object.keys(timings);
  assert.deepEqual(shardFiles(files, timings, 2), [['tests/a.test.ts', 'tests/d.test.ts', 'tests/e.test.ts'], ['tests/b.test.ts', 'tests/c.test.ts']]);
  assert.deepEqual(shardFiles(files, timings, 3), [['tests/a.test.ts'], ['tests/b.test.ts', 'tests/e.test.ts'], ['tests/c.test.ts', 'tests/d.test.ts']]);
  assert.deepEqual(shardFiles([...files].reverse(), timings, 3), shardFiles(files, timings, 3));
  assert.deepEqual(shardFiles(['tests/a.test.ts'], timings, 2), [['tests/a.test.ts'], []]);
});

test('a test file without a recorded time weighs as the median, and every file lands in exactly one shard', () => {
  const timings = { 'tests/slow.test.ts': 100, 'tests/mid.test.ts': 20, 'tests/fast.test.ts': 1 };
  const files = ['tests/new.test.ts', ...Object.keys(timings)];
  const shards = shardFiles(files, timings, 2);
  assert.deepEqual(shards, [['tests/slow.test.ts'], ['tests/fast.test.ts', 'tests/mid.test.ts', 'tests/new.test.ts']]);
  assert.deepEqual(shards.flat().sort(), [...files].sort());
  assert.deepEqual(shardFiles(['tests/x.test.ts', 'tests/y.test.ts'], {}, 2), [['tests/x.test.ts'], ['tests/y.test.ts']]);
});

test('the recorded times name test files that exist, and pick prints one shard\'s files', () => {
  const timings = JSON.parse(readFileSync(new URL('timings.json', new URL('./', import.meta.url)), 'utf8')) as Record<string, number>;
  const existing = new Set(readdirSync(new URL('./', import.meta.url)).filter(name => name.endsWith('.test.ts')).map(name => `tests/${name}`));
  assert.ok(Object.keys(timings).length > 100);
  for (const [file, seconds] of Object.entries(timings)) {
    assert.ok(existing.has(file), `${file} is in tests/timings.json but not in tests/`);
    assert.equal(typeof seconds, 'number');
  }
  const files = [...existing].sort();
  const picked = [1, 2, 3].map(index => execFileSync(process.execPath, ['scripts/test-shards.mjs', 'pick', `${index}/3`, ...files], { cwd: root, encoding: 'utf8' }).trim().split('\n'));
  assert.deepEqual(picked.flat().sort(), files);
  assert.throws(() => execFileSync(process.execPath, ['scripts/test-shards.mjs', 'pick', '4/3', ...files], { cwd: root, stdio: 'pipe' }));
});

test('the times reporter keeps each file\'s own time in seconds, not its tests\', and the job\'s reports merge', async () => {
  const a = `${process.cwd()}/tests/a.test.ts`;
  const b = `${process.cwd()}/tests/b.test.ts`;
  const events = [
    { type: 'test:complete', data: { file: a, name: 'a test', nesting: 0, details: { duration_ms: 900 } } },
    { type: 'test:pass', data: { file: a, name: 'a test', nesting: 0, details: { duration_ms: 900 } } },
    { type: 'test:complete', data: { file: a, name: 'tests/a.test.ts', nesting: 0, details: { duration_ms: 1540 } } },
    { type: 'test:complete', data: { file: b, name: 'tests/b.test.ts', nesting: 1, details: { duration_ms: 9000 } } },
    { type: 'test:complete', data: { file: b, name: './tests/b.test.ts', nesting: 0, details: { duration_ms: 50 } } },
    { type: 'test:diagnostic', data: { message: 'tests 3' } },
  ];
  async function* source() { yield* events; }
  let output = '';
  for await (const chunk of testTimes(source())) output += chunk;
  assert.deepEqual(JSON.parse(output), { 'tests/a.test.ts': 1.5, 'tests/b.test.ts': 0.1 });
  assert.deepEqual(Object.keys(mergeTimings([{ 'tests/b.test.ts': 2 }, { 'tests/a.test.ts': 1 }])), ['tests/a.test.ts', 'tests/b.test.ts']);
});
