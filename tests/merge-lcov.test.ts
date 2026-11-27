import assert from 'node:assert/strict';
import test from 'node:test';
import { coverageSummary } from '../scripts/coverage-summary.mjs';
import { mergeLcov } from '../scripts/merge-lcov.mjs';

const record = (path: string, body: string[]) => ['TN:', `SF:${path}`, ...body, 'end_of_record'].join('\n');

test('CI\'s test shards\' coverage merges into one record per file, hits added up', () => {
  const first = record('/repo/apps/server/src/a.ts', [
    'FN:1,f', 'FN:5,anonymous_0', 'FNDA:1,f', 'FNDA:0,anonymous_0', 'FNF:2', 'FNH:1',
    'BRDA:1,0,0,1', 'BRDA:2,1,0,0', 'BRF:2', 'BRH:1',
    'DA:1,1', 'DA:2,1', 'DA:3,0', 'DA:5,0', 'LH:2', 'LF:4',
  ]);
  const second = [
    record('/repo/apps/server/src/a.ts', [
      'FN:1,f', 'FN:5,anonymous_0', 'FN:9,anonymous_1', 'FNDA:2,f', 'FNDA:3,anonymous_0', 'FNDA:1,anonymous_1', 'FNF:3', 'FNH:3',
      'BRDA:1,0,0,0', 'BRDA:2,1,0,4', 'BRDA:9,2,0,-', 'BRF:3', 'BRH:1',
      'DA:1,2', 'DA:2,0', 'DA:3,0', 'DA:5,3', 'DA:9,1', 'LH:3', 'LF:5',
    ]),
    record('/repo/packages/shared/src/b.ts', ['DA:1,1', 'LH:1', 'LF:1']),
  ].join('\n');

  const merged = mergeLcov([first, second]);
  const a = merged.split('end_of_record')[0]!;
  assert.match(a, /FN:1,f\nFN:5,anonymous_0\nFN:9,anonymous_1\n/);
  assert.match(a, /FNDA:3,f\nFNDA:3,anonymous_0\nFNDA:1,anonymous_1\nFNF:3\nFNH:3\n/);
  assert.match(a, /BRDA:1,0,0,1\nBRDA:2,1,0,4\nBRDA:9,2,0,-\nBRF:3\nBRH:2\n/);
  assert.match(a, /DA:1,3\nDA:2,1\nDA:3,0\nDA:5,3\nDA:9,1\nLH:4\nLF:5\n$/);
  assert.equal(merged.match(/^SF:/gm)?.length, 2);

  const summary = coverageSummary(merged, '/repo');
  assert.match(summary, /\| apps\/server \| 1 \| 80\.0% \| 66\.7% \|/);
  assert.match(summary, /\| \*\*All\*\* \| 2 \| 83\.3% \| 66\.7% \|/);
});

test('one shard\'s coverage merges into itself, and none into nothing', () => {
  const only = record('/repo/extensions/x/index.ts', ['DA:1,1', 'DA:2,0', 'LH:1', 'LF:2']);
  assert.equal(mergeLcov([only]), `TN:\nSF:/repo/extensions/x/index.ts\nFNF:0\nFNH:0\nBRF:0\nBRH:0\nDA:1,1\nDA:2,0\nLH:1\nLF:2\nend_of_record\n`);
  assert.equal(mergeLcov([]), '');
});
