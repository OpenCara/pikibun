import assert from 'node:assert/strict';
import test from 'node:test';
import { REMOTE_MCP_SESSION_TOOLS, remoteMcpNotOfferedNote, remoteMcpSessionTools, type RemoteMcpSessionServer } from '../packages/shared/src/remote-mcp.js';
import { toolDefinitionLimits } from '../packages/shared/src/tool-definitions.js';

const server = (prefix: string, count: number, names: (index: number) => string = index => `tool_${index}`): RemoteMcpSessionServer => ({
  name: prefix, prefix, readOnlyTools: [], tools: Array.from({ length: count }, (_, index) => ({ name: names(index), description: '', inputSchema: { type: 'object' } })),
});

test('a session takes as many remote MCP tools as a host accepts in a workspace\'s answer', () => {
  assert.equal(REMOTE_MCP_SESSION_TOOLS, toolDefinitionLimits.definitions);
  assert.equal(REMOTE_MCP_SESSION_TOOLS, 64);
});

test('the session\'s remote MCP tools are shared evenly, the rest of a small server\'s share going to the others', () => {
  const shared = remoteMcpSessionTools([server('big', 64), server('mid', 10), server('small', 3)]);
  assert.deepEqual(shared.offered, [51, 10, 3]);
  assert.deepEqual(shared.notOffered, [13, 0, 0]);
  assert.equal(shared.definitions.length, 64);
  assert.deepEqual(shared.definitions.map(definition => definition.name.split('_')[0]),
    [...Array(51).fill('big'), ...Array(10).fill('mid'), ...Array(3).fill('small')], 'each server\'s tools stay together, in the servers\' order');
  assert.deepEqual(shared.definitions.slice(0, 3).map(definition => definition.name), ['big_tool_0', 'big_tool_1', 'big_tool_2'], 'a server keeps its first tools');
});

test('servers with more tools than their share split the session evenly, the earlier ones taking what doesn\'t divide', () => {
  assert.deepEqual(remoteMcpSessionTools([server('a', 64), server('b', 64), server('c', 64)]).offered, [22, 21, 21]);
  assert.deepEqual(remoteMcpSessionTools([server('a', 64), server('b', 64)], 5).offered, [3, 2]);
});

test('everything fits when the servers have fewer tools than the session takes, and no server gets nothing', () => {
  const few = remoteMcpSessionTools([server('a', 20), server('b', 30)]);
  assert.deepEqual([few.offered, few.notOffered, few.definitions.length], [[20, 30], [0, 0], 50]);
  const many = remoteMcpSessionTools(Array.from({ length: 8 }, (_, index) => server(`s${index}`, 64)));
  assert.deepEqual(many.offered, Array(8).fill(8));
  assert.deepEqual(remoteMcpSessionTools([]), { definitions: [], offered: [], notOffered: [] });
});

test('a name two servers\' tools both come to stays with the earlier server and costs the later one nothing', () => {
  const long = 'x'.repeat(70);
  const shared = remoteMcpSessionTools([server('a', 1, () => `${long}1`), server('a', 2, index => `${long}${index + 1}`)]);
  assert.deepEqual(shared.offered, [1, 0], 'the later server\'s tools all come to the name the earlier one took');
  assert.deepEqual(shared.notOffered, [0, 0]);
  assert.equal(shared.definitions.length, 1);
});

test('settings say how many of a server\'s tools sessions don\'t get, and why', () => {
  assert.equal(remoteMcpNotOfferedNote(undefined), '');
  assert.equal(remoteMcpNotOfferedNote(0), '');
  assert.match(remoteMcpNotOfferedNote(13), /^Sessions don't get 13 of its tools: a session takes at most 64 remote MCP tools in all, shared evenly/);
});
