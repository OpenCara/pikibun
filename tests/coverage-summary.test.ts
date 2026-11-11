import assert from 'node:assert/strict';
import test from 'node:test';
import { coverageSummary } from '../scripts/coverage-summary.mjs';

test('CI\'s coverage summary adds up lcov records by area', () => {
  const lcov = [
    'SF:/repo/apps/server/src/a.ts', 'LF:10', 'LH:5', 'BRF:4', 'BRH:1', 'end_of_record',
    'SF:/repo/apps/server/src/b.ts', 'LF:10', 'LH:10', 'end_of_record',
    'SF:/repo/packages/shared/src/c.ts', 'LF:4', 'LH:3', 'BRF:0', 'BRH:0', 'end_of_record',
  ].join('\n');
  const summary = coverageSummary(lcov, '/repo');
  assert.match(summary, /\| apps\/server \| 2 \| 75\.0% \| 25\.0% \|/);
  assert.match(summary, /\| packages\/shared \| 1 \| 75\.0% \| – \|/);
  assert.match(summary, /\| \*\*All\*\* \| 3 \| 75\.0% \| 25\.0% \|/);
  assert.ok(summary.indexOf('apps/server') < summary.indexOf('packages/shared'));
});
