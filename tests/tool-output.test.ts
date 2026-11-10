import assert from 'node:assert/strict';
import test from 'node:test';
import { boundOutput, excerpt, fitsModel, KEPT_OUTPUTS, MODEL_OUTPUT, outputsToPrune, SAVED_OUTPUT_BYTES, SavedOutputs, savedOutput, toolOutputPath } from '../apps/runner/src/tool-output.js';

const bytes = (text: string) => Buffer.byteLength(text, 'utf8');
const lines = (text: string) => text.split('\n').length;
/** A test run's log: many passing lines, then the failure at its end. */
const log = (count: number) => `${Array.from({ length: count }, (_, index) => `ok ${index} - a passing test with some words in it`).join('\n')}\nnot ok ${count} - the failure\nFAILED: 1 test`;

test('an output that fits reaches the model as it is, saved nowhere', async () => {
  let saved = 0;
  const text = log(10);
  assert.equal(await boundOutput(text, { save: async () => { saved++; return 'x'; } }), text);
  assert.equal(saved, 0);
  assert.ok(fitsModel('x'.repeat(MODEL_OUTPUT.bytes)) && !fitsModel('x'.repeat(MODEL_OUTPUT.bytes + 1)));
  assert.ok(fitsModel('\n'.repeat(MODEL_OUTPUT.lines - 1)) && !fitsModel('\n'.repeat(MODEL_OUTPUT.lines)));
});

test('a long output: its start and end, which fit, and the whole of it saved, which the line between them names', async () => {
  const text = log(20_000);
  const saves: string[] = [];
  const shown = await boundOutput(text, { save: async whole => { saves.push(whole); return 'tool-output/gh-call.txt'; } });
  assert.ok(fitsModel(shown), 'pi-durable keeps all of it');
  assert.ok(shown.startsWith('ok 0 - a passing test'), 'its start');
  assert.ok(shown.endsWith('not ok 20000 - the failure\nFAILED: 1 test'), 'its end, where the failure is');
  assert.match(shown, /\n\[… \d+ bytes left out here\. The whole output is in tool-output\/gh-call\.txt: read it with read_file \(offset and limit\) or search it …\]\n/);
  assert.deepEqual(saves, [text], 'saved whole, since it is under the file limit');
  const omitted = Number(/\[… (\d+) bytes left out/.exec(shown)![1]);
  const [start, end] = shown.split(/\n\[….*…\]\n/);
  assert.equal(bytes(start!) + 1 + omitted + bytes(end!), bytes(text), 'it says exactly how much it left out');
  assert.ok(lines(start!) < lines(end!), 'more of its end than its start');
});

test('many short lines are bounded by pi-durable\'s line limit too', async () => {
  const text = 'x\n'.repeat(10_000);
  assert.ok(bytes(text) < MODEL_OUTPUT.bytes && !fitsModel(text));
  const shown = await boundOutput(text);
  assert.ok(fitsModel(shown));
  assert.match(shown, /bytes left out here, and not saved: this call can't write it to the worktree/);
});

test('one long line keeps its start and end, never part of a character', async () => {
  const text = `${'é'.repeat(40_000)}${'😀'.repeat(20_000)}`;
  const shown = await boundOutput(text, { unsaved: 'a Read-only message doesn\'t write to the worktree' });
  assert.ok(fitsModel(shown));
  assert.ok(!shown.includes('\uFFFD'), 'no character cut in two');
  assert.ok(shown.startsWith('éé') && shown.endsWith('😀😀'));
  assert.match(shown, /and not saved: a Read-only message doesn't write to the worktree/);
});

test('a save that fails says so, and the call still gets its excerpt', async () => {
  const shown = await boundOutput(log(5_000), { save: async () => { throw new Error('File exceeds size limit'); } });
  assert.ok(fitsModel(shown) && shown.endsWith('FAILED: 1 test'));
  assert.match(shown, /and not saved: saving it failed: File exceeds size limit/);
});

test('an output inside a card fits with the card around it, escapes and all', async () => {
  const card = { id: 'tool-1', operation: { kind: 'program', tool: 'git', command: 'git log' }, status: 'executed' };
  const text = '\u001b[31mred\u001b[0m "quoted"\t\\\n'.repeat(20_000);
  const fits = (shown: string) => bytes(JSON.stringify({ ...card, result: shown })) <= MODEL_OUTPUT.bytes;
  const shown = await boundOutput(text, { fits, save: async () => 'tool-output/git-call.txt' });
  assert.ok(fits(shown));
  assert.match(shown, /tool-output\/git-call\.txt/);
});

test('what is saved of an output longer than a file may be keeps its start and end', () => {
  const text = log(100_000);
  assert.ok(bytes(text) > SAVED_OUTPUT_BYTES);
  const saved = savedOutput(text);
  assert.ok(bytes(saved) <= SAVED_OUTPUT_BYTES);
  assert.ok(saved.startsWith('ok 0 -') && saved.endsWith('FAILED: 1 test'));
  assert.match(saved, /\[… \d+ bytes of the output left out here …\]/);
  assert.equal(savedOutput('short'), 'short');
});

test('excerpts keep whole lines, and an output\'s path is the same for the same call', () => {
  const shown = excerpt(log(5_000), { bytes: 4096, lines: 100 }, omitted => `[${omitted}]`);
  for (const line of shown.split('\n')) assert.match(line, /^(ok \d+ - a passing test with some words in it|not ok 5000 - the failure|FAILED: 1 test|\[\d+\])$/);
  assert.match(toolOutputPath('gh', 'toolu_01/../x y'), /^tool-output\/gh-toolu_01_x_y-[0-9a-f]{8}\.txt$/);
  assert.equal(toolOutputPath('gh', 'toolu_01/../x y'), toolOutputPath('gh', 'toolu_01/../x y'));
  const long = 'a'.repeat(100);
  assert.notEqual(toolOutputPath('gh', `${long}1`), toolOutputPath('gh', `${long}2`), 'calls whose shortened names read alike');
  assert.notEqual(toolOutputPath('gh', 'a b'), toolOutputPath('gh', 'a/b'));
});

test('where even the smallest excerpt doesn\'t fit, the call gets the line saying where the output is', async () => {
  const around = 'x'.repeat(MODEL_OUTPUT.bytes - 300);
  const fits = (shown: string) => bytes(around) + bytes(shown) <= MODEL_OUTPUT.bytes;
  const shown = await boundOutput(log(20_000), { fits, save: async () => 'tool-output/gh-call.txt' });
  assert.ok(fits(shown));
  assert.match(shown, /^\[… \d+ bytes left out here\. The whole output is in tool-output\/gh-call\.txt/);
});

test('saved outputs beyond the newest are pruned, oldest first, and only the files the tools name themselves', async () => {
  assert.deepEqual(outputsToPrune(['a', 'b', 'c'], ['a', 'b', 'c'], 3), []);
  assert.deepEqual(outputsToPrune(['a', 'b', 'c', 'old'], ['b', 'a', 'c'], 2), ['old', 'b']);

  const name = (index: number) => toolOutputPath('gh', `call-${index}`).split('/')[1]!;
  const files = new Set(['notes.md', name(1000), name(1001)]);
  const removed: string[] = [];
  const directories = {
    list: async (directory: string) => { assert.equal(directory, 'tool-output'); return [...files]; },
    remove: async (path: string) => { removed.push(path); files.delete(path.split('/')[1]!); },
  };
  const outputs = new SavedOutputs();
  for (let index = 0; index < KEPT_OUTPUTS; index++) {
    files.add(name(index));
    await outputs.saved(`tool-output/${name(index)}`, directories);
  }
  assert.deepEqual(removed.sort(), [`tool-output/${name(1000)}`, `tool-output/${name(1001)}`].sort(), 'files from before this process go first');
  files.add(name(KEPT_OUTPUTS));
  await outputs.saved(`tool-output/${name(KEPT_OUTPUTS)}`, directories);
  assert.equal(removed.at(-1), `tool-output/${name(0)}`);
  assert.ok(files.has('notes.md'));
  assert.equal(files.size, KEPT_OUTPUTS + 1);

  const calls: string[] = [];
  await outputs.saved('src/index.ts', { list: async directory => { calls.push(directory); return []; }, remove: async () => {} });
  await outputs.saved('codemode-output/0a1b2c3d/output.txt', { list: async directory => { calls.push(directory); return ['0a1b2c3d']; }, remove: async () => {} });
  assert.deepEqual(calls, ['codemode-output']);
});
