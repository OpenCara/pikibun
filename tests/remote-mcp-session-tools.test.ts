import assert from 'node:assert/strict';
import test from 'node:test';
import { parseWorkspaceExtensionsAnswer } from '../packages/shared/src/host-extensions.js';
import {
  REMOTE_MCP_ALL_TOOLS, REMOTE_MCP_SESSION_TOOLS, remoteMcpAnswerBytes, remoteMcpLeftOutNote, remoteMcpLimits, remoteMcpSessionTools, remoteMcpToolList,
  type RemoteMcpSessionServer,
} from '../packages/shared/src/remote-mcp.js';
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

test('a current host takes every tool of every server: nothing is shared out', () => {
  const servers = [server('eleven', 247), server('higgs', 30), server('runway', 20)];
  const all = remoteMcpSessionTools(servers, REMOTE_MCP_ALL_TOOLS);
  assert.deepEqual([all.offered, all.notOffered, all.definitions.length], [[247, 30, 20], [0, 0, 0], 297]);
  assert.deepEqual(remoteMcpSessionTools(servers).offered, [22, 22, 20], 'an older host still gets the 64 it accepts, shared evenly');
  assert.equal(REMOTE_MCP_ALL_TOOLS, remoteMcpLimits.servers * remoteMcpLimits.tools);
});

test('a host parses an answer with more than 64 remote tools, up to every tool of every server', () => {
  const definitions = remoteMcpSessionTools([server('eleven', 200)], REMOTE_MCP_ALL_TOOLS).definitions;
  const answer = (remoteTools: unknown[]) => parseWorkspaceExtensionsAnswer({ extensions: [], automaticTools: true, remoteTools });
  assert.equal(answer(definitions).remoteTools!.length, 200);
  assert.throws(() => answer(Array.from({ length: REMOTE_MCP_ALL_TOOLS + 1 }, () => definitions[0])), /Invalid workspace extensions/);
  assert.ok(remoteMcpAnswerBytes > remoteMcpLimits.servers * remoteMcpLimits.toolsBytes, 'the answer may carry every server\'s tools');
});

test('tools an owner or admin turned off are never offered, and don\'t count against an older host\'s share', () => {
  const eleven = { ...server('eleven', 64), offTools: Array.from({ length: 60 }, (_, index) => `tool_${index}`) };
  const all = remoteMcpSessionTools([eleven, server('higgs', 3)], REMOTE_MCP_ALL_TOOLS);
  assert.deepEqual(all.definitions.map(definition => definition.name), ['eleven_tool_60', 'eleven_tool_61', 'eleven_tool_62', 'eleven_tool_63', 'higgs_tool_0', 'higgs_tool_1', 'higgs_tool_2']);
  const older = remoteMcpSessionTools([eleven, server('higgs', 64)]);
  assert.deepEqual([older.offered, older.notOffered], [[4, 60], [0, 4]], 'the share a server doesn\'t use goes to the others');
});

test('Pikibun keeps up to 1024 tools and 2 MB from one server, and counts the rest as left out', () => {
  const listed = (count: number, description = '') => Array.from({ length: count }, (_, index) => ({ name: `tool_${index}`, description, inputSchema: { type: 'object' } }));
  const many = remoteMcpToolList(listed(1030));
  assert.deepEqual([many.tools.length, many.leftOut], [1024, { overLimit: 6, unusable: 0 }]);
  const large = remoteMcpToolList(listed(1200, 'd'.repeat(2000)));
  assert.ok(large.tools.length < 1200 && large.tools.length > 900);
  assert.ok(JSON.stringify(large.tools).length <= remoteMcpLimits.toolsBytes + large.tools.length);
  assert.equal(large.leftOut.overLimit, 1200 - large.tools.length);
  assert.equal(remoteMcpLeftOutNote(many.leftOut), 'Left out 6 tools past what Pikibun keeps from one server (1024 tools, 2 MB).');
  const wide = remoteMcpToolList(listed(1000, '音'.repeat(2000)));
  const bytes = new TextEncoder().encode(JSON.stringify(wide.tools)).length;
  assert.ok(bytes <= remoteMcpLimits.toolsBytes + wide.tools.length, 'the 2 MB are UTF-8 bytes, not characters (review of #557)');
  assert.ok(wide.tools.length < 400 && wide.leftOut.overLimit === 1000 - wide.tools.length);
});
