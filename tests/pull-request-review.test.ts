import assert from 'node:assert/strict';
import test from 'node:test';
import { filePatch, reviewDirectoryIds, reviewFileOrder, reviewTree } from '../packages/shared/src/pull-request-review.js';
import type { PullRequestFileView } from '../packages/shared/src/types.js';

const file = (path: string, extra: Partial<PullRequestFileView> = {}): PullRequestFileView => ({ path, status: 'modified', additions: 1, deletions: 1, ...extra });

test('a pull request\'s files become a tree of directories, single-directory chains joined, directories before files', () => {
  const files = [file('README.md'), file('apps/nsh/src/ui.tsx'), file('apps/nsh/src/session-panel/Review.tsx'), file('apps/server/src/sessions.ts'), file('Zebra.md'), file('apps/nsh/App.tsx')];
  const tree = reviewTree(files);
  const shape = (nodes: ReturnType<typeof reviewTree>): unknown[] => nodes.map(node => (node.children ? [node.label, node.files, shape(node.children)] : node.label));
  assert.deepEqual(shape(tree), [
    ['apps', 4, [
      ['nsh', 3, [['src', 2, [['session-panel', 1, ['Review.tsx']], 'ui.tsx']], 'App.tsx']],
      ['server/src', 1, ['sessions.ts']],
    ]],
    'README.md', 'Zebra.md',
  ]);
  assert.deepEqual(reviewDirectoryIds(tree), ['dir:apps', 'dir:apps/nsh', 'dir:apps/nsh/src', 'dir:apps/nsh/src/session-panel', 'dir:apps/server/src']);
  assert.deepEqual(reviewFileOrder(tree), ['apps/nsh/src/session-panel/Review.tsx', 'apps/nsh/src/ui.tsx', 'apps/nsh/App.tsx', 'apps/server/src/sessions.ts', 'README.md', 'Zebra.md']);
  assert.equal(tree[0]!.children![1]!.path, 'apps/server/src');
  assert.equal(tree[1]!.id, 'file:README.md');
  assert.equal(tree[1]!.file, files[0]);
});

test('ungrouped, a pull request\'s files are one list by name', () => {
  const flat = reviewTree([file('src/b.ts'), file('a.ts'), file('lib/a.ts')], false);
  assert.deepEqual(flat.map(node => [node.label, node.path]), [['a.ts', 'a.ts'], ['a.ts', 'lib/a.ts'], ['b.ts', 'src/b.ts']]);
  assert.ok(flat.every(node => !node.children));
});

test('a file\'s hunks become a unified diff a diff viewer reads, with the headers git writes for its status', () => {
  const patch = '@@ -1 +1 @@\n-a\n+b';
  assert.equal(filePatch(file('src/a.ts', { patch })), `diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n${patch}\n`);
  assert.equal(filePatch(file('new.ts', { status: 'added', patch: `${patch}\n` })), `diff --git a/new.ts b/new.ts\nnew file mode 100644\n--- /dev/null\n+++ b/new.ts\n${patch}\n`);
  assert.equal(filePatch(file('gone.ts', { status: 'removed', patch })), `diff --git a/gone.ts b/gone.ts\ndeleted file mode 100644\n--- a/gone.ts\n+++ /dev/null\n${patch}\n`);
  assert.equal(filePatch(file('to.ts', { status: 'renamed', previousPath: 'from.ts', patch })),
    `diff --git a/from.ts b/to.ts\nrename from from.ts\nrename to to.ts\n--- a/from.ts\n+++ b/to.ts\n${patch}\n`);
  assert.equal(filePatch(file('logo.png')), null);
});
