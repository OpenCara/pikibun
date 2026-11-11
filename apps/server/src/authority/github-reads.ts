import { createHash } from 'node:crypto';

export interface RememberedRead { etag: string; bytes: Uint8Array; link: string | null }

const entryLimit = 1000;
const entryBytes = 4 * 1024 * 1024;
const totalBytes = 64 * 1024 * 1024;
const reads = new Map<string, RememberedRead>();
let held = 0;

function key(token: string, url: string): string {
  return `${createHash('sha256').update(token).digest('base64url')} ${url}`;
}

function drop(id: string): void {
  const entry = reads.get(id);
  if (!entry) return;
  reads.delete(id);
  held -= entry.bytes.byteLength;
}

export function recallRead(token: string, url: string): RememberedRead | undefined {
  const id = key(token, url);
  const entry = reads.get(id);
  if (!entry) return undefined;
  reads.delete(id);
  reads.set(id, entry);
  return entry;
}

export function conditionalHeaders(remembered: RememberedRead | undefined): Record<string, string> {
  return remembered ? { 'If-None-Match': remembered.etag } : {};
}

export function rememberRead(token: string, url: string, response: Response, bytes: Uint8Array): void {
  const id = key(token, url);
  drop(id);
  const etag = response.headers.get('etag');
  if (!etag || !/^(?:W\/)?"[\x21\x23-\x7e]{1,200}"$/.test(etag) || bytes.byteLength > entryBytes) return;
  reads.set(id, { etag, bytes, link: response.headers.get('link') });
  held += bytes.byteLength;
  for (const oldest of reads.keys()) {
    if (reads.size <= entryLimit && held <= totalBytes) break;
    drop(oldest);
  }
}

export function forgetRead(token: string, url: string): void {
  drop(key(token, url));
}

export function githubRateLimited(response: Response): boolean {
  return response.status === 429 || (response.status === 403
    && (response.headers.get('x-ratelimit-remaining') === '0' || response.headers.has('retry-after')));
}

export function forgetGitHubReads(): void {
  reads.clear();
  held = 0;
}
