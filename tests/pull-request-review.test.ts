import assert from 'node:assert/strict';
import test from 'node:test';
import { filePatch, redactPatch, reviewDirectoryIds, reviewFileOrder, reviewTree } from '../packages/shared/src/pull-request-review.js';
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

test('a patch\'s secrets are hidden line by line, on deleted lines as on added ones, and every line keeps its place', () => {
  const body = 'MIIEowIBAAKCAQEAx123abcDEFghiJKLmnoPQRstuVWXyz0123456789abcDEFghiJKL';
  const begin = '-----BEGIN RSA PRIVATE KEY-----';
  const end = '-----END RSA PRIVATE KEY-----';
  const token = 'sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGHIJ';
  const lines = (patch: string) => patch.split('\n');
  for (const sign of ['-', '+', ' ']) {
    const patch = `@@ -1,5 +1,5 @@\n${sign}${begin}\n${sign}${body}\n${sign}${body}\n${sign}${end}\n${sign}after`;
    const shown = redactPatch(patch);
    assert.deepEqual(lines(shown), ['@@ -1,5 +1,5 @@', `${sign}${begin}`, `${sign}[redacted]`, `${sign}[redacted]`, `${sign}[redacted]`, `${sign}after`]);
  }
  const replaced = redactPatch(`@@ -1,3 +1,3 @@\n-${begin}\n+const key = 1;\n-${body}\n-${end}\n+API_KEY=${token}\n context`);
  assert.deepEqual(lines(replaced), ['@@ -1,3 +1,3 @@', `-${begin}`, '+const key = 1;', '-[redacted]', '-[redacted]', '+API_KEY=[redacted]', ' context']);
  const cut = redactPatch(`@@ -1,2 +0,0 @@\n-${begin}\n-${body}\n@@ -9,1 +7,1 @@ const next = 1;\n-plain\n+plain too\n\\ No newline at end of file`);
  assert.deepEqual(lines(cut), ['@@ -1,2 +0,0 @@', `-${begin}`, '-[redacted]', '@@ -9,1 +7,1 @@ const next = 1;', '-plain', '+plain too', '\\ No newline at end of file']);
  const inline = redactPatch(`@@ -1 +1 @@\n-const pem = "${begin}\\n${body}\\n${end}";\n+const pem = "${begin}\\n${body}`);
  assert.ok(!inline.includes(body), inline);
  assert.equal(lines(inline).length, 3);
  const plain = '@@ -1,2 +1,2 @@\n const a = 1;\n-const b = 2;\n+const b = 3;';
  assert.equal(redactPatch(plain), plain);
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
