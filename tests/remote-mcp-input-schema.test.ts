import assert from 'node:assert/strict';
import test from 'node:test';
import { fitInputSchema, inputSchemaLimits, sanitizeInputSchema } from '../packages/shared/src/input-schema.js';
import { remoteMcpToolList } from '../packages/shared/src/remote-mcp.js';

const fits = (schema: unknown) => {
  const fitted = fitInputSchema(schema);
  assert.ok(fitted, 'the schema fits');
  assert.deepEqual(sanitizeInputSchema(fitted), fitted, 'what it fits to passes the strict check unchanged, so every connector takes it');
  return fitted as Record<string, unknown>;
};

const depthOf = (schema: unknown): number => {
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) return 0;
  const node = schema as Record<string, unknown>;
  const children = [
    ...Object.values((node.properties ?? {}) as Record<string, unknown>),
    node.items, node.additionalProperties, ...((node.anyOf ?? []) as unknown[]), ...((node.allOf ?? []) as unknown[]),
  ];
  return 1 + Math.max(0, ...children.map(depthOf));
};

test('a Pydantic schema with $defs and $ref is inlined rather than left out', () => {
  const schema = {
    $defs: {
      Voice: { title: 'Voice', type: 'object', properties: { voice_id: { type: 'string' }, stability: { anyOf: [{ type: 'number' }, { type: 'null' }], default: null } }, required: ['voice_id'] },
    },
    title: 'CreateAgentArgs', type: 'object',
    properties: { name: { type: 'string' }, voice: { $ref: '#/$defs/Voice', description: 'The voice it speaks with' }, backup: { anyOf: [{ $ref: '#/$defs/Voice' }, { type: 'null' }] } },
    required: ['name'],
  };
  assert.equal(sanitizeInputSchema(schema), undefined, 'the strict check still refuses it, as connectors do');
  const voice = { title: 'Voice', type: 'object', properties: { voice_id: { type: 'string' }, stability: { anyOf: [{ type: 'number' }, { type: 'null' }], default: null } }, required: ['voice_id'] };
  assert.deepEqual(fits(schema), {
    title: 'CreateAgentArgs', type: 'object',
    properties: { name: { type: 'string' }, voice: { ...voice, description: 'The voice it speaks with' }, backup: { anyOf: [voice, { type: 'null' }] } },
    required: ['name'],
  });
  assert.deepEqual(fits({ $ref: '#/definitions/Args', definitions: { Args: { type: 'object', properties: { a: { type: 'string' } } } } }),
    { type: 'object', properties: { a: { type: 'string' } } }, 'a root that is a $ref takes what it points to');
  assert.deepEqual(fits({ type: 'object', properties: { a: { $ref: '#/$defs/A', minLength: 2 } }, $defs: { A: { type: 'string' } } }),
    { type: 'object', properties: { a: { minLength: 2, allOf: [{ type: 'string' }] } } }, 'a $ref beside constraints of its own keeps both');
});

test('a reference that cycles, points nowhere or leaves the document allows any value there', () => {
  const tree = fits({ type: 'object', properties: { root: { $ref: '#/$defs/Node' } },
    $defs: { Node: { type: 'object', description: 'A node', properties: { children: { type: 'array', items: { $ref: '#/$defs/Node' } } } } } });
  assert.deepEqual(tree, { type: 'object', properties: { root: { type: 'object', description: 'A node', properties: { children: { type: 'array', items: {} } } } } });
  assert.deepEqual(fits({ type: 'object', properties: { a: { $ref: '#/$defs/missing', description: 'gone' }, b: { $ref: 'https://example.com/s.json' } } }),
    { type: 'object', properties: { a: { description: 'gone' }, b: {} } });
});

test('what the bounds can\'t say is loosened, never tightened', () => {
  const languages = Array.from({ length: 100 }, (_, index) => `l${index}`);
  assert.deepEqual(fits({ type: 'object', properties: {
    language: { type: 'string', enum: languages, description: 'Its language' },
    slug: { type: 'string', pattern: '^(?P<slug>[a-z]+)$' },
    kind: { oneOf: [{ type: 'string' }, { type: 'number', format: 'x-unknown' }] },
    note: { type: 'string', nullable: true },
    labels: { type: 'object', patternProperties: { '^x-': { type: 'string' } }, additionalProperties: false },
    pair: { type: 'array', prefixItems: [{ type: 'string' }], items: false },
    tuple: { type: 'array', items: [{ type: 'string' }] },
    odd: { type: 'decimal' },
    flag: true,
  } }), { type: 'object', properties: {
    language: { type: 'string', description: 'Its language' },
    slug: { type: 'string' },
    kind: { anyOf: [{ type: 'string' }, { type: 'number', format: 'x-unknown' }] },
    note: { type: ['string', 'null'] },
    labels: { type: 'object' },
    pair: { type: 'array' },
    tuple: { type: 'array' },
    odd: {},
    flag: {},
  } });
});

test('a schema too deep, with too many properties or too large keeps as much as fits', () => {
  const deep = (depth: number): Record<string, unknown> => depth ? { type: 'object', description: `level ${depth}`, properties: { next: deep(depth - 1) } } : { type: 'string' };
  const fittedDeep = fits(deep(10));
  assert.equal(depthOf(fittedDeep), inputSchemaLimits.depth, 'it keeps the levels the bounds allow');
  const wide = { type: 'object', properties: Object.fromEntries(Array.from({ length: 12 }, (_, index) => [`section${index}`,
    { type: 'object', description: `Section ${index}`, properties: Object.fromEntries(Array.from({ length: 12 }, (_, n) => [`field${n}`, { type: 'string' }])) }])),
  required: ['section0'] };
  const fittedWide = fits(wide);
  assert.deepEqual(Object.keys(fittedWide.properties as object), Object.keys(wide.properties), 'every top-level argument stays');
  assert.deepEqual((fittedWide.properties as Record<string, unknown>).section3, { type: 'object', description: 'Section 3' }, 'what is under them is left open');
  assert.deepEqual(fittedWide.required, ['section0']);
  const large = { type: 'object', properties: Object.fromEntries(Array.from({ length: 40 }, (_, index) => [`p${index}`, { type: 'string', description: 'x'.repeat(2000) }])) };
  const fittedLarge = fits(large);
  assert.equal(Object.keys(fittedLarge.properties as object).length, 40);
  assert.ok(JSON.stringify(fittedLarge).length <= inputSchemaLimits.bytes, 'descriptions are cut to fit');
});

test('references that multiply are bounded, and what can never fit is still refused', () => {
  const defs: Record<string, unknown> = { L0: { type: 'string' } };
  for (let level = 1; level <= 12; level++) defs[`L${level}`] = { type: 'object', properties: Object.fromEntries(Array.from({ length: 8 }, (_, n) => [`p${n}`, { $ref: `#/$defs/L${level - 1}` }])) };
  const started = performance.now();
  const fitted = fitInputSchema({ type: 'object', properties: { top: { $ref: '#/$defs/L12' } }, $defs: defs });
  assert.ok(performance.now() - started < 2000, 'a reference bomb doesn\'t run away');
  if (fitted) assert.deepEqual(sanitizeInputSchema(fitted), fitted);
  for (const [why, schema] of [
    ['another root type', { type: 'array' }],
    ['not an object', 'object'],
    ['more top-level arguments than the bounds', { type: 'object', properties: Object.fromEntries(Array.from({ length: 65 }, (_, index) => [`p${index}`, { type: 'string' }])) }],
    ['a top-level argument with a name too long', { type: 'object', properties: { ['a'.repeat(129)]: { type: 'string' } } }],
    ['too large to read', { type: 'object', description: 'x'.repeat(1024 * 1024) }],
  ] as const) assert.equal(fitInputSchema(schema), undefined, why);
});

test('a listed tool whose schema uses $ref is offered, not counted among those left out', () => {
  const { tools, leftOut } = remoteMcpToolList([
    { name: 'agents_create', inputSchema: { type: 'object', properties: { voice: { $ref: '#/$defs/V' } }, $defs: { V: { type: 'string' } } } },
    { name: 'bad name!', inputSchema: { type: 'object' } },
    { name: 'listing', inputSchema: { type: 'array' } },
  ]);
  assert.deepEqual(tools.map(tool => tool.name), ['agents_create']);
  assert.deepEqual(tools[0]!.inputSchema, { type: 'object', properties: { voice: { type: 'string' } } });
  assert.deepEqual(leftOut, { overLimit: 0, unusable: 2 });
});
