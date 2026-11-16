import assert from 'node:assert/strict';
import test from 'node:test';
import { readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { Hono } from 'hono';
import { z } from 'zod';
import { body, fields, identifier, parsed, text, userIdentifier } from '../apps/server/src/schemas.ts';
import type { AppEnv } from '../apps/server/src/types.ts';

function app(schema: z.ZodType, options?: Parameters<typeof body>[2]) {
  const server = new Hono<AppEnv>();
  server.post('/', async c => c.json({ value: await body(c, schema, options) }));
  server.onError((error, c) => 'getResponse' in error && typeof error.getResponse === 'function' ? error.getResponse() : c.text(String(error), 500));
  return async (value: unknown, type = 'application/json') => {
    const response = await server.request('/', { method: 'POST', headers: { 'content-type': type }, body: JSON.stringify(value) });
    return { status: response.status, body: await response.json() as Record<string, unknown> };
  };
}

test('a valid body comes back parsed and typed', async () => {
  const post = app(z.strictObject({ name: text('name').transform(name => name.trim()), id: identifier() }));
  assert.deepEqual(await post({ name: ' build ', id: 'a_1' }), { status: 200, body: { value: { name: 'build', id: 'a_1' } } });
});

test('field schemas answer with the messages the hand-written checks gave', async () => {
  const post = app(z.object({ name: text('name', 5), id: identifier(), user: userIdentifier() }));
  assert.deepEqual(await post({ name: 'toolong', id: 'a', user: 'github:1' }), { status: 400, body: { error: 'Invalid name.', code: 'invalid_input' } });
  assert.deepEqual(await post({ name: 'a\0', id: 'a', user: 'github:1' }), { status: 400, body: { error: 'Invalid name.', code: 'invalid_input' } });
  assert.deepEqual(await post({ name: 'a', id: 'a b', user: 'github:1' }), { status: 400, body: { error: 'Invalid id.', code: 'invalid_input' } });
  assert.deepEqual(await post({ name: 'a', id: 'a', user: 'github:0' }), { status: 400, body: { error: 'Invalid userId.', code: 'invalid_input' } });
  assert.equal((await post({ name: 'a', id: 'a', user: 'password:alice' })).status, 200);
  assert.equal((await post({ name: 'a', id: 'a', user: 'test:alice' })).status, 200);
});

test('a route can answer every invalid body with one message', async () => {
  const post = app(z.strictObject({ on: z.boolean() }), { message: 'Set on to true or false.' });
  for (const value of [{}, { on: 'yes' }, { on: true, off: false }]) {
    assert.deepEqual(await post(value), { status: 400, body: { error: 'Set on to true or false.', code: 'invalid_input' } });
  }
});

test('fields checks the keys first, with the route\'s message, and only then each field', async () => {
  const post = app(fields({ name: text('name'), id: identifier().nullable().optional() }, 'A thing has a name and an id.', { required: ['name'] }));
  const refused = (error: string) => ({ status: 400, body: { error, code: 'invalid_input' } });
  assert.deepEqual(await post({ name: '', extra: 1 }), refused('A thing has a name and an id.'));
  assert.deepEqual(await post({ id: 'a' }), refused('A thing has a name and an id.'));
  assert.deepEqual(await post({ name: '' }), refused('Invalid name.'));
  assert.deepEqual(await post({ name: 'a', id: 'a b' }), refused('Invalid id.'));
  assert.deepEqual(await post({ name: 'a', id: null }), { status: 200, body: { value: { name: 'a', id: null } } });
  const some = app(fields({ a: z.boolean().optional(), b: z.boolean().optional() }, 'Change a or b.', { some: true }));
  assert.deepEqual(await some({}), refused('Change a or b.'));
  assert.deepEqual(await some({ b: true }), { status: 200, body: { value: { b: true } } });
});

test('a parser of packages/shared keeps its own error message', async () => {
  const post = app(z.object({ list: parsed(value => { if (!Array.isArray(value)) throw new Error('Expected a list.'); return value as unknown[]; }, 'Invalid list.') }));
  assert.deepEqual(await post({ list: 1 }), { status: 400, body: { error: 'Expected a list.', code: 'invalid_input' } });
  assert.deepEqual(await post({ list: [1] }), { status: 200, body: { value: { list: [1] } } });
});

test('the body still has to be a JSON object of bounded size', async () => {
  const post = app(z.object({}), { maxBytes: 16 });
  assert.equal((await post({}, 'text/plain')).status, 415);
  assert.equal((await post([])).status, 400);
  assert.equal((await post({ padding: 'x'.repeat(32) })).status, 413);
});

test('fields() answers a fault of its keys with the route\'s code when it names one', async () => {
  const post = app(fields({ token: z.string() }, 'Only token is accepted.', { code: 'invalid_account' }));
  assert.deepEqual(await post({ token: 'x', other: 1 }), { status: 400, body: { error: 'Only token is accepted.', code: 'invalid_account' } });
  assert.equal((await post({ token: 'x' })).status, 200);
});

const handChecked: Record<string, number> = {
  'authority/api-access.ts': 1,
  'authority/auth.ts': 4,
  'authority/authorize.ts': 1,
  'authority/git/accounts.ts': 1,
  'authority/github-broker.ts': 4,
  'authority/host-access.ts': 1,
  'authority/network.ts': 3,
  'authority/password-auth.ts': 6,
  'authority/push/broker.ts': 2,
  'authority/push/identities.ts': 2,
  'authority/repositories.ts': 2,
  'authority/sources/sources.ts': 3,
  'authority/tool-checks.ts': 1,
  'authority/workspace-connections.ts': 2,
  'backups.ts': 1,
  'catalog.ts': 5,
  'connectors.ts': 4,
  'cross-session.ts': 1,
  'extensions.ts': 5,
  'file-uploads.ts': 2,
  'host-config.ts': 1,
  'host-migrations.ts': 1,
  'host-models.ts': 1,
  'notifications.ts': 2,
  'restore-routes.ts': 2,
  'scheduled-prompts.ts': 3,
  'session-branches.ts': 1,
  'session-tunnels.ts': 1,
  'sessions.ts': 7,
  'workspace-databases/routes.ts': 4,
  'workspace-invites.ts': 2,
};

test('new routes check their bodies with body(): hand-checked bodies only go away (#9)', async () => {
  const root = join(import.meta.dirname, '..', 'apps', 'server', 'src');
  const found: Record<string, number> = {};
  for (const entry of await readdir(root, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.ts')) continue;
    const path = join(entry.parentPath, entry.name);
    const file = relative(root, path).split('\\').join('/');
    if (file === 'schemas.ts' || file === 'http.ts') continue;
    const count = (await readFile(path, 'utf8')).match(/jsonObject\(c\b/g)?.length ?? 0;
    if (count) found[file] = count;
  }
  for (const [file, count] of Object.entries(found)) {
    assert.ok(count <= (handChecked[file] ?? 0), `${file} reads ${count} bodies with jsonObject(), more than the ${handChecked[file] ?? 0} it had: check a new body with body() and a schema (docs/design/request-schemas.md)`);
  }
  for (const [file, count] of Object.entries(handChecked)) {
    assert.ok((found[file] ?? 0) >= count, `${file} moved a body to body(): lower its count in handChecked to ${found[file] ?? 0}`);
  }
});
