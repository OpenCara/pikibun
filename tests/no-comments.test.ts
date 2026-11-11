import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const root = fileURLToPath(new URL('../', import.meta.url));
const tracked = execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8' }).split('\0').filter(Boolean);

const directive = /^(\/\/\/\s*<reference\b|\/\/\s*@ts-(expect-error|ignore|nocheck|check)\b|\/\*\*?\s*@jsx\w*\s|\/\/\s*@jsx\w*\s|\/\/\s*#\s*sourceMappingURL=|\/\*\s*@vite-ignore\s*\*\/|\/\*\s*#__PURE__\s*\*\/)/;

function comments(file: string): string[] {
  const text = readFileSync(`${root}${file}`, 'utf8');
  const kind = /\.tsx$/.test(file) ? ts.ScriptKind.TSX : /\.jsx$/.test(file) ? ts.ScriptKind.JSX : /\.[cm]?js$/.test(file) ? ts.ScriptKind.JS : ts.ScriptKind.TS;
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, kind);
  const found = new Map<number, string>();
  const collect = (position: number) => {
    for (const range of [...ts.getLeadingCommentRanges(text, position) ?? [], ...ts.getTrailingCommentRanges(text, position) ?? []]) {
      const comment = text.slice(range.pos, range.end);
      if (range.pos === 0 && comment.startsWith('#!')) continue;
      if (!directive.test(comment)) found.set(range.pos, comment);
    }
  };
  const visit = (node: ts.Node) => {
    collect(node.getFullStart());
    collect(node.getEnd());
    for (const child of node.getChildren(source)) visit(child);
  };
  visit(source);
  return [...found.entries()].map(([position, comment]) => `${file}:${source.getLineAndCharacterOfPosition(position).line + 1}: ${comment.split('\n')[0]!.slice(0, 80)}`);
}

function lineComments(file: string): string[] {
  return readFileSync(`${root}${file}`, 'utf8').split('\n').flatMap((line, index) =>
    /^\s*#/.test(line) && !(index === 0 && line.startsWith('#!')) && !/^\s*#\s*(type:|noqa|pyright:|ruff:|shellcheck )/.test(line) ? [`${file}:${index + 1}: ${line.trim().slice(0, 80)}`] : []);
}

test('the TypeScript and JavaScript sources have no comments but directives: reasons go in docs/design', () => {
  const sources = tracked.filter(file => /\.(m|c)?[jt]sx?$/.test(file) && !file.endsWith('.d.ts') && !file.includes('node_modules/'));
  assert.ok(sources.length > 400);
  assert.deepEqual(sources.flatMap(comments), []);
});

test('the Python and shell sources have no comments either', () => {
  const sources = tracked.filter(file => /\.(py|sh)$/.test(file));
  assert.ok(sources.length > 0);
  assert.deepEqual(sources.flatMap(lineComments), []);
});
