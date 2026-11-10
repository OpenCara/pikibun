import type { IncomingMessage } from 'node:http';
import type { TLSSocket } from 'node:tls';

export function requestUrl(request: IncomingMessage, trustProxy: boolean): URL {
  const forwarded = (name: string) => trustProxy ? String(request.headers[name] ?? '').split(',')[0]!.trim() : '';
  const proto = forwarded('x-forwarded-proto');
  const scheme = proto === 'https' || proto === 'http' ? proto : (request.socket as TLSSocket).encrypted ? 'https' : 'http';
  const host = forwarded('x-forwarded-host') || request.headers.host;
  if (!host) throw new Error('Missing host header');
  return new URL(`${scheme}://${host}${request.url ?? '/'}`);
}

export function forwardedRequest(request: Request, incoming: IncomingMessage): Request {
  const url = requestUrl(incoming, true);
  if (url.href === request.url) return request;
  const hasBody = request.method !== 'GET' && request.method !== 'HEAD';
  return new Request(url, {
    method: request.method,
    headers: request.headers,
    body: hasBody ? request.body : null,
    duplex: 'half',
    signal: request.signal,
  } as RequestInit);
}

export function trustForwardedHeaders(
  fetch: (request: Request) => Response | Promise<Response>,
): (request: Request, bindings: { incoming: unknown }) => Response | Promise<Response> {
  return (request, bindings) => {
    let forwarded: Request;
    try { forwarded = forwardedRequest(request, bindings.incoming as IncomingMessage); } catch (error) {
      console.error('pikibun: could not rebuild a forwarded request:', error instanceof Error ? error.message : error);
      return Response.json({ error: 'Invalid request.', code: 'invalid_request' }, { status: 400 });
    }
    return fetch(forwarded);
  };
}
