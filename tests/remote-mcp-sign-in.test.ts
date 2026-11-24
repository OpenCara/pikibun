import { test } from 'node:test';
import assert from 'node:assert/strict';
import { remoteMcpSignInHeaders, remoteMcpSignInMethods, remoteMcpSignInOf } from '../packages/shared/src/remote-mcp.js';

test('each remote MCP sign-in method becomes the headers Pikibun keeps for it', () => {
  assert.deepEqual(remoteMcpSignInMethods.map(method => method.value), ['oauth', 'token', 'basic', 'header', 'none']);
  assert.deepEqual(remoteMcpSignInHeaders({ method: 'oauth' }), {});
  assert.deepEqual(remoteMcpSignInHeaders({ method: 'none' }), {});
  assert.deepEqual(remoteMcpSignInHeaders({ method: 'token', token: ' ghp_abc ' }), { Authorization: 'Bearer ghp_abc' });
  assert.deepEqual(remoteMcpSignInHeaders({ method: 'token', token: 'Bearer ghp_abc' }), { Authorization: 'Bearer ghp_abc' }, 'a pasted Bearer prefix isn\'t doubled');
  assert.deepEqual(remoteMcpSignInHeaders({ method: 'basic', username: 'ana', password: 'pä:ss' }),
    { Authorization: `Basic ${Buffer.from('ana:pä:ss', 'utf8').toString('base64')}` });
  assert.deepEqual(remoteMcpSignInHeaders({ method: 'header', name: ' X-API-Key ', value: 'k-1' }), { 'X-API-Key': 'k-1' });
  assert.throws(() => remoteMcpSignInHeaders({ method: 'token', token: '  ' }), /Give the token/);
  assert.throws(() => remoteMcpSignInHeaders({ method: 'basic', username: 'a:b', password: 'p' }), /colon/);
  assert.throws(() => remoteMcpSignInHeaders({ method: 'basic', username: 'ana', password: '' }), /Give the password/);
  assert.throws(() => remoteMcpSignInHeaders({ method: 'header', name: 'Host', value: 'evil' }), /can't be set as a header/);
  assert.throws(() => remoteMcpSignInHeaders({ method: 'token', token: 'a\nb' }), /one line/);
});

test('a listed remote MCP server shows the sign-in method it uses', () => {
  assert.equal(remoteMcpSignInOf({ oauth: { signedInAt: 'now' }, headerNames: [] }), 'oauth');
  assert.equal(remoteMcpSignInOf({ headerNames: [] }), 'none');
  assert.equal(remoteMcpSignInOf({ headerNames: ['authorization'] }), 'token');
  assert.equal(remoteMcpSignInOf({ headerNames: ['X-API-Key'] }), 'header');
});
