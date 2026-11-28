import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const app = fileURLToPath(new URL('../apps/nsh/', import.meta.url));
const languages = ['en', 'zh', 'zh-Hant', 'ja', 'ko'];
const file = JSON.parse(readFileSync(join(app, 'locales/app.json'), 'utf8')) as Record<string, unknown>;
const entries = Object.entries(file).filter(([key]) => key !== '_version') as [string, Record<string, string>][];

const placeholders = (text: string) => [...text.matchAll(/%\{(\w+)\}/g)].map(match => match[1]).sort();

function sources(directory: string): string[] {
  return readdirSync(directory).flatMap(name => {
    const path = join(directory, name);
    return statSync(path).isDirectory() ? sources(path) : /\.tsx?$/.test(name) ? [path] : [];
  });
}

test('the app translations are one file with every language', () => {
  assert.equal(file._version, 2);
  assert.ok(entries.length > 0);
});

test('every key has a text in each language, with the same placeholders as English', () => {
  for (const [key, texts] of entries) {
    assert.deepEqual(Object.keys(texts).sort(), [...languages].sort(), key);
    for (const language of languages) {
      assert.equal(typeof texts[language], 'string', `${key} ${language}`);
      assert.ok(texts[language]!.trim(), `${key} ${language}`);
      assert.deepEqual(placeholders(texts[language]!), placeholders(texts.en!), `${key} ${language}`);
    }
  }
});

test('every key the app asks for is translated, and every translation is asked for', () => {
  const keys = new Set(entries.map(([key]) => key));
  const asked = new Set<string>();
  for (const path of sources(join(app, 'src'))) {
    for (const match of readFileSync(path, 'utf8').matchAll(/\bt\(\s*["'`]([\w.-]+)["'`]/g)) asked.add(match[1]!);
  }
  const index = readFileSync(join(app, 'src/settings/index.tsx'), 'utf8');
  for (const match of index.matchAll(/\{ id: "([\w-]+)", icon:/g)) asked.add(`settings.section.${match[1]}`);
  assert.deepEqual([...asked].filter(key => !keys.has(key)).sort(), []);
  assert.deepEqual([...keys].filter(key => !asked.has(key)).sort(), []);
});
