import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { DRAWN_WIDTH, PATCHED_MEASURE_TEXT } from '../scripts/nsh-web-fixes.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const shipped = ['apps/nsh/App.tsx', 'apps/nsh/src', 'apps/nsh/web', 'packages/client/src', 'packages/shared/src'];

const sinks: [RegExp, string][] = [
  [/\.innerHTML\b/, 'innerHTML'],
  [/\.outerHTML\b/, 'outerHTML'],
  [/insertAdjacentHTML/, 'insertAdjacentHTML'],
  [/dangerouslySetInnerHTML/, 'dangerouslySetInnerHTML'],
  [/document\.write(ln)?\s*\(/, 'document.write'],
  [/createContextualFragment/, 'createContextualFragment'],
  [/\bDOMParser\b/, 'DOMParser'],
  [/\bsrcdoc\b/, 'srcdoc'],
  [/(set|parse)HTMLUnsafe/, 'setHTMLUnsafe'],
  [/\bnew\s+Function\s*\(/, 'new Function'],
  [/(^|[^.\w])eval\s*\(/, 'eval'],
  [/["'`]javascript:/i, 'a javascript: URL'],
];

function files(path: string): string[] {
  const full = join(root, path);
  if (statSync(full).isFile()) return [full];
  return readdirSync(full, { withFileTypes: true }).flatMap(entry => entry.name === 'node_modules' ? []
    : entry.isDirectory() ? files(relative(root, join(full, entry.name)))
    : /\.(m?[jt]sx?)$/.test(entry.name) ? [join(full, entry.name)] : []);
}

test('nothing the client ships writes text into the page as HTML or runs it as code', () => {
  const found: string[] = [];
  const sources = shipped.flatMap(files);
  assert.ok(sources.length > 50, 'the client\'s sources are scanned');
  for (const file of sources) {
    const text = readFileSync(file, 'utf8');
    for (const [pattern, name] of sinks) if (pattern.test(text)) found.push(`${relative(root, file)}: ${name}`);
  }
  assert.deepEqual(found, [], 'transcript text, tool output and Markdown reach the page only as text: the page\'s policy allows inline scripts (see docs/design/security-rationale.md)');
});

test('the code the build adds to Native Shell\'s web runtime writes only text and attributes into the page', () => {
  for (const [name, code] of Object.entries({ DRAWN_WIDTH, PATCHED_MEASURE_TEXT })) {
    for (const [pattern, sink] of sinks) assert.equal(pattern.test(code), false, `${name} uses ${sink}`);
  }
  assert.match(DRAWN_WIDTH, /\.textContent=s/, 'measured text goes in as text');
});
