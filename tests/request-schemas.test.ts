import assert from 'node:assert/strict';
import test from 'node:test';
import { Hono } from 'hono';
import { z } from 'zod';
import { body, identifier, parsed, text, userIdentifier } from '../apps/server/src/schemas.ts';
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
