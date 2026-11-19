import { remoteMcpLimits, remoteMcpToolList, type RemoteMcpTool, type RemoteMcpTransport } from '../../../../../packages/shared/src/remote-mcp.js';

const PROTOCOL_VERSION = '2025-06-18';
const CLIENT = { name: 'pikibun', version: '1' };
const MAX_PAGES = 4;

export class RemoteMcpError extends Error {}

interface JsonRpcAnswer { id?: unknown; result?: unknown; error?: { code?: unknown; message?: unknown } }

function answerFrom(body: string, contentType: string, id: number): JsonRpcAnswer {
  const candidates: unknown[] = [];
  if (contentType.includes('text/event-stream')) {
    for (const event of body.split(/\r?\n\r?\n/)) {
      const data = event.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => line.slice(5).replace(/^ /, '')).join('\n');
      if (!data) continue;
      try { candidates.push(JSON.parse(data)); } catch { }
    }
  } else {
    try { candidates.push(JSON.parse(body)); } catch { throw new RemoteMcpError('The server answered with something other than JSON'); }
  }
  const flat = candidates.flatMap(item => Array.isArray(item) ? item : [item]);
  const found = flat.find(item => !!item && typeof item === 'object' && (item as JsonRpcAnswer).id === id) as JsonRpcAnswer | undefined;
  if (!found) throw new RemoteMcpError('The server answered without a response to the request');
  return found;
}

export class RemoteMcpSession {
  #sessionId: string | undefined;
  #next = 1;
  #initialized = false;

  constructor(private readonly transport: RemoteMcpTransport, private readonly url: string, private readonly headers: Readonly<Record<string, string>>,
    private readonly timeoutMs: number) {}

  private async post(payload: Record<string, unknown>, expectAnswer: boolean): Promise<JsonRpcAnswer | undefined> {
    const response = await this.transport({
      url: this.url,
      headers: {
        ...this.headers, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream',
        ...(this.#initialized ? { 'MCP-Protocol-Version': PROTOCOL_VERSION } : {}), ...(this.#sessionId ? { 'Mcp-Session-Id': this.#sessionId } : {}),
      },
      body: JSON.stringify({ jsonrpc: '2.0', ...payload }),
      timeoutMs: this.timeoutMs,
      maxBytes: remoteMcpLimits.responseBytes,
    });
    const session = response.headers['mcp-session-id'];
    if (session && /^[\x21-\x7e]{1,256}$/.test(session)) this.#sessionId = session;
    if (response.status === 401 || response.status === 403) throw new RemoteMcpError(`The server refused the credentials (HTTP ${response.status})`);
    if (response.status < 200 || response.status >= 300) throw new RemoteMcpError(`The server answered HTTP ${response.status}`);
    if (!expectAnswer) return undefined;
    return answerFrom(response.body, response.headers['content-type'] ?? '', payload.id as number);
  }

  async call(method: string, params: Record<string, unknown>): Promise<unknown> {
    if (!this.#initialized && method !== 'initialize') await this.initialize();
    const id = this.#next++;
    const answer = await this.post({ id, method, params }, true);
    if (answer!.error) {
      const message = typeof answer!.error.message === 'string' ? answer!.error.message.slice(0, 500) : 'unknown error';
      throw new RemoteMcpError(`${method} failed: ${message}`);
    }
    return answer!.result;
  }

  async initialize(): Promise<void> {
    if (this.#initialized) return;
    await this.call('initialize', { protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: CLIENT });
    this.#initialized = true;
    await this.post({ method: 'notifications/initialized' }, false);
  }
}

export async function discoverRemoteMcpTools(transport: RemoteMcpTransport, url: string, headers: Readonly<Record<string, string>>): Promise<RemoteMcpTool[]> {
  const session = new RemoteMcpSession(transport, url, headers, remoteMcpLimits.discoverSeconds * 1000);
  const listed: unknown[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < MAX_PAGES; page++) {
    const result = await session.call('tools/list', cursor ? { cursor } : {}) as { tools?: unknown; nextCursor?: unknown } | undefined;
    if (!result || !Array.isArray(result.tools)) throw new RemoteMcpError('tools/list answered without tools');
    listed.push(...result.tools);
    if (typeof result.nextCursor !== 'string' || !result.nextCursor || listed.length >= remoteMcpLimits.tools) break;
    cursor = result.nextCursor;
  }
  return remoteMcpToolList(listed);
}

export interface RemoteMcpCallResult { result: string; isError?: true; truncated?: true }

function shown(result: unknown): RemoteMcpCallResult {
  const value = result as { content?: unknown; structuredContent?: unknown; isError?: unknown } | undefined;
  const parts: string[] = [];
  if (Array.isArray(value?.content)) {
    for (const item of value.content) {
      const part = item as { type?: unknown; text?: unknown; resource?: { uri?: unknown; text?: unknown }; uri?: unknown; name?: unknown };
      if (part.type === 'text' && typeof part.text === 'string') parts.push(part.text);
      else if (part.type === 'resource' && typeof part.resource?.text === 'string') parts.push(part.resource.text);
      else if (part.type === 'resource_link' && typeof part.uri === 'string') parts.push(`[resource ${typeof part.name === 'string' ? part.name : ''} ${part.uri}]`);
      else if (typeof part.type === 'string') parts.push(`[${part.type} content left out]`);
    }
  }
  if (!parts.length && value?.structuredContent !== undefined) parts.push(JSON.stringify(value.structuredContent));
  let text = parts.join('\n');
  const truncated = text.length > remoteMcpLimits.resultCharacters;
  if (truncated) text = text.slice(0, remoteMcpLimits.resultCharacters);
  return { result: text, ...(value?.isError === true ? { isError: true as const } : {}), ...(truncated ? { truncated: true as const } : {}) };
}

export async function callRemoteMcpTool(transport: RemoteMcpTransport, url: string, headers: Readonly<Record<string, string>>, name: string,
  args: Record<string, unknown>): Promise<RemoteMcpCallResult> {
  const session = new RemoteMcpSession(transport, url, headers, remoteMcpLimits.callSeconds * 1000);
  return shown(await session.call('tools/call', { name, arguments: args }));
}
