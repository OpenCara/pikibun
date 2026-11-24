import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import type { request as httpsRequest } from 'node:https';
import { answersId, eventStreamMessages, EventStreamReader } from '../apps/server/src/authority/remote-mcp/client.js';
import { publicHttpsTransport, remoteMcpConcurrency, RemoteMcpGate, RemoteMcpRefused } from '../apps/server/src/authority/remote-mcp/transport.js';

interface FakeResponse extends EventEmitter { statusCode: number; headers: Record<string, string> }
interface FakeCall extends EventEmitter { url: string; destroyed: boolean; destroy(error?: Error): FakeCall; end(body: Buffer): void; respond(headers: Record<string, string>, status?: number): FakeResponse }

function fakeHttps() {
  const calls: FakeCall[] = [];
  const request = ((url: URL, _options: unknown, onResponse: (response: FakeResponse) => void) => {
    const call = new EventEmitter() as FakeCall;
    call.url = url.href;
    call.destroyed = false;
    call.destroy = error => {
      if (call.destroyed) return call;
      call.destroyed = true;
      queueMicrotask(() => { if (error) call.emit('error', error); call.emit('close'); });
      return call;
    };
    call.end = () => { calls.push(call); };
    call.respond = (headers, status = 200) => {
      const response = Object.assign(new EventEmitter(), { statusCode: status, headers }) as FakeResponse;
      onResponse(response);
      return response;
    };
    return call;
  }) as unknown as typeof httpsRequest;
  return { calls, request };
}

const tick = () => new Promise<void>(resolve => setImmediate(resolve));
const post = (url: string, extra: { expectId?: number; timeoutMs?: number; maxBytes?: number } = {}) => ({ url, headers: {}, body: '{}', timeoutMs: 5000, maxBytes: 1024 * 1024, ...extra });

test('an event stream is read event by event: each complete event is parsed once, however its bytes are cut', () => {
  const stream = 'event: message\r\ndata: {"jsonrpc":"2.0","method":"notifications/progress"}\r\n\r\n: ping\n\ndata: {"jsonrpc":"2.0",\ndata: "id":3,"result":{"text":"héllo ✓"}}\n\ndata: {"id":4,"result":{}}\n\n';
  const whole = eventStreamMessages(stream);
  assert.equal(whole.length, 3);
  for (const size of [1, 2, 3, 5, 7, 64, stream.length]) {
    const reader = new EventStreamReader();
    const found: unknown[] = [];
    for (let at = 0; at < stream.length; at += size) found.push(...reader.push(stream.slice(at, at + size)));
    assert.deepEqual(found, whole, `in pieces of ${size}`);
  }
  const reader = new EventStreamReader();
  assert.deepEqual(reader.push('data: {"id":3,"result":{}}\n'), [], 'an event without its blank line answers nothing yet');
  assert.deepEqual(reader.push('\n'), [{ id: 3, result: {} }]);
  assert.deepEqual(reader.push('\n\n'), []);
});

test('the transport parses a streamed answer once, not again on every chunk, and answers as soon as the response arrives', async () => {
  const https = fakeHttps();
  const transport = publicHttpsTransport(undefined, { request: https.request });
  const pending = transport(post('https://mcp.example.com/mcp', { expectId: 7 }));
  await tick();
  const call = https.calls[0]!;
  const response = call.respond({ 'content-type': 'text/event-stream' });
  const parse = JSON.parse;
  let parsed = 0;
  JSON.parse = ((text: string) => { parsed++; return parse(text); }) as typeof JSON.parse;
  const events = 2000;
  try {
    for (let index = 0; index < events; index++) response.emit('data', Buffer.from(`data: {"jsonrpc":"2.0","method":"notifications/progress","params":{"progress":${index}}}\n\n`));
    const answer = Buffer.from('data: {"jsonrpc":"2.0","id":7,"result":{"content":[{"type":"text","text":"dönë"}]}}\n\n');
    const cut = answer.indexOf(0xc3) + 1;
    response.emit('data', answer.subarray(0, cut));
    assert.equal(call.destroyed, false);
    response.emit('data', answer.subarray(cut));
  } finally {
    JSON.parse = parse;
  }
  assert.ok(parsed <= events + 1, `${parsed} parses for ${events + 1} events`);
  assert.equal(call.destroyed, true, 'the stream is closed once the answer is there');
  const answered = await pending;
  assert.equal(answered.status, 200);
  const messages = eventStreamMessages(answered.body);
  assert.equal(messages.length, events + 1);
  assert.ok(answersId(messages.at(-1), 7));
  assert.match(answered.body, /dönë/);
});

test('the transport keeps its size and time bounds', async () => {
  const https = fakeHttps();
  const transport = publicHttpsTransport(undefined, { request: https.request });
  const large = transport(post('https://mcp.example.com/mcp', { expectId: 1, maxBytes: 100 }));
  await tick();
  const response = https.calls[0]!.respond({ 'content-type': 'text/event-stream' });
  response.emit('data', Buffer.alloc(60, 0x20));
  response.emit('data', Buffer.alloc(60, 0x20));
  await assert.rejects(large, /larger than 100 bytes/);
  const slow = transport(post('https://mcp.example.com/mcp', { expectId: 1, timeoutMs: 40 }));
  await assert.rejects(slow, /No answer within 0 seconds/);
  assert.equal(https.calls[1]!.destroyed, true);
  await assert.rejects(transport(post('http://mcp.example.com/mcp')), RemoteMcpRefused);
  await assert.rejects(transport(post('https://127.0.0.1/mcp')), /isn't a public address/);
  assert.equal(https.calls.length, 2);
});

test('calls to one remote MCP server are capped, the rest wait their turn within their own time limit, and a full queue refuses', async () => {
  const gate = new RemoteMcpGate({ perServer: 2, total: 3, waitingPerServer: 1, waiting: 2 });
  const a1 = await gate.enter('https://a.example', 1000);
  const a2 = await gate.enter('https://a.example', 1000);
  let third: (() => void) | undefined;
  const waiting = gate.enter('https://a.example', 1000).then(release => { third = release; });
  await tick();
  assert.equal(third, undefined, 'a third call to the same server waits');
  await assert.rejects(gate.enter('https://a.example', 1000), /Too many calls/);
  const b1 = await gate.enter('https://b.example', 1000);
  assert.deepEqual([gate.running, gate.waiting], [3, 1]);
  let overall: (() => void) | undefined;
  const second = gate.enter('https://b.example', 1000).then(release => { overall = release; });
  await tick();
  assert.equal(overall, undefined, 'the overall cap holds a call to a server with room');
  await assert.rejects(gate.enter('https://c.example', 1000), /Too many calls/);
  a1();
  a1();
  await waiting;
  assert.ok(third, 'the waiting call starts when one ends');
  assert.equal(overall, undefined);
  b1();
  await second;
  assert.deepEqual([gate.running, gate.waiting], [3, 0]);
  await assert.rejects(gate.enter('https://a.example', 30), /No answer within 0 seconds: other calls/);
  assert.equal(gate.waiting, 0);
  a2(); third!(); overall!();
  assert.equal(gate.running, 0);
  assert.deepEqual(remoteMcpConcurrency, { perServer: 8, total: 64, waitingPerServer: 32, waiting: 256 });
});

test('the transport holds a request back while its server has as many running as allowed, and counts the wait against its time limit', async () => {
  const https = fakeHttps();
  const transport = publicHttpsTransport(undefined, { request: https.request, gate: new RemoteMcpGate({ perServer: 1, total: 8, waitingPerServer: 4, waiting: 8 }) });
  const first = transport(post('https://mcp.example.com/mcp'));
  const second = transport(post('https://mcp.example.com/other'));
  const elsewhere = transport(post('https://other.example.com/mcp'));
  const late = transport(post('https://mcp.example.com/mcp', { timeoutMs: 30 }));
  await tick();
  assert.deepEqual(https.calls.map(call => call.url), ['https://mcp.example.com/mcp', 'https://other.example.com/mcp']);
  await assert.rejects(late, /other calls to this remote MCP server were still running/);
  const answer = (index: number) => { const response = https.calls[index]!.respond({ 'content-type': 'application/json' }); response.emit('data', Buffer.from('{}')); response.emit('end'); };
  answer(0);
  assert.equal((await first).body, '{}');
  await tick();
  assert.deepEqual(https.calls.map(call => call.url), ['https://mcp.example.com/mcp', 'https://other.example.com/mcp', 'https://mcp.example.com/other']);
  answer(1); answer(2);
  await Promise.all([second, elsewhere]);
});
