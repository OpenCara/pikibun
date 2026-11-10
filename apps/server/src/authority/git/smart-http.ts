import { boundedRepositoryBody } from '../repositories.js';

export type AdvertisedService = 'git-upload-pack' | 'git-receive-pack';

export interface Advertisement {
  refs: Map<string, string>;
  head: string | null;
  sha256: boolean;
}

export type AdvertisementFailure = 'denied' | 'redirected' | 'not-smart' | 'unavailable' | 'invalid';
export type AdvertisementResult = { ok: true; advertisement: Advertisement } | { ok: false; failure: AdvertisementFailure };

export const advertisementBytes = 8 * 1024 * 1024;
const timeout = 20_000;
const userAgent = 'git/2 (OpenCara-Agent-Workspace)';
const objectId = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const zero = /^0+$/;

export async function readAdvertisement(remote: string, service: AdvertisedService, authorization: string | null,
  fetcher: typeof fetch = fetch): Promise<AdvertisementResult> {
  let response: Response;
  try {
    response = await fetcher(`${remote}/info/refs?service=${service}`, {
      headers: { 'User-Agent': userAgent, Accept: '*/*', ...(authorization ? { Authorization: authorization } : {}) },
      redirect: 'manual', signal: AbortSignal.timeout(timeout),
    });
  } catch { return { ok: false, failure: 'unavailable' }; }
  if (response.status !== 200) {
    await response.body?.cancel().catch(() => {});
    if ([401, 403, 404].includes(response.status)) return { ok: false, failure: 'denied' };
    if (response.status >= 300 && response.status < 400) return { ok: false, failure: 'redirected' };
    return { ok: false, failure: 'unavailable' };
  }
  if ((response.headers.get('content-type') ?? '').split(';')[0]!.trim().toLowerCase() !== `application/x-${service}-advertisement`) {
    await response.body?.cancel().catch(() => {});
    return { ok: false, failure: 'not-smart' };
  }
  let body: Uint8Array;
  try { body = await boundedRepositoryBody(response, advertisementBytes); } catch { return { ok: false, failure: 'unavailable' }; }
  const advertisement = parseAdvertisement(body, service);
  return advertisement ? { ok: true, advertisement } : { ok: false, failure: 'invalid' };
}

function packets(body: Uint8Array): (string | null)[] | null {
  const decoder = new TextDecoder('utf-8', { fatal: true });
  const lines: (string | null)[] = [];
  let offset = 0;
  while (offset < body.length) {
    if (offset + 4 > body.length) return null;
    const header = String.fromCharCode(...body.subarray(offset, offset + 4));
    if (!/^[0-9a-f]{4}$/.test(header)) return null;
    const length = parseInt(header, 16);
    if (length === 0) { lines.push(null); offset += 4; continue; }
    if (length < 4 || offset + length > body.length) return null;
    let text: string;
    try { text = decoder.decode(body.subarray(offset + 4, offset + length)); } catch { return null; }
    lines.push(text.endsWith('\n') ? text.slice(0, -1) : text);
    offset += length;
  }
  return lines;
}

export function parseAdvertisement(body: Uint8Array, service: AdvertisedService): Advertisement | null {
  const lines = packets(body);
  if (!lines) return null;
  let index = 0;
  if (lines[0] === `# service=${service}`) {
    if (lines[1] !== null) return null;
    index = 2;
  }
  const refs = new Map<string, string>();
  let head: string | null = null;
  let sha256 = false;
  let first = true;
  for (; index < lines.length; index++) {
    const line = lines[index];
    if (line === null) break;
    if (first && line.startsWith('version ')) return null;
    let ref = line;
    if (first) {
      const nul = line.indexOf('\0');
      if (nul < 0) return null;
      ref = line.slice(0, nul);
      for (const capability of line.slice(nul + 1).split(' ')) {
        if (capability.startsWith('symref=HEAD:')) head = capability.slice('symref=HEAD:'.length);
        if (capability === 'object-format=sha256') sha256 = true;
      }
      first = false;
    }
    const space = ref.indexOf(' ');
    const id = ref.slice(0, space);
    const name = ref.slice(space + 1);
    if (space < 0 || !objectId.test(id) || !name || /[\x00-\x20\x7f]/.test(name)) return null;
    if (id.length === 64) sha256 = true;
    if (zero.test(id) && name === 'capabilities^{}') continue;
    refs.set(name, id);
  }
  if (first) return null;
  return { refs, head, sha256 };
}

export function defaultBranch(advertisement: Advertisement): string | null {
  const branches = [...advertisement.refs.keys()].filter(name => name.startsWith('refs/heads/'));
  if (advertisement.head?.startsWith('refs/heads/') && advertisement.refs.has(advertisement.head)) return advertisement.head.slice('refs/heads/'.length);
  const tip = advertisement.refs.get('HEAD');
  if (tip) {
    const preferred = ['refs/heads/main', 'refs/heads/master'];
    const match = [...preferred.filter(name => branches.includes(name)), ...branches.sort()].find(name => advertisement.refs.get(name) === tip);
    if (match) return match.slice('refs/heads/'.length);
  }
  return branches.length === 1 ? branches[0]!.slice('refs/heads/'.length) : null;
}

export function resolveRef(advertisement: Advertisement, ref: string): string | null {
  return advertisement.refs.get(`refs/heads/${ref}`)
    ?? advertisement.refs.get(`refs/tags/${ref}^{}`) ?? advertisement.refs.get(`refs/tags/${ref}`) ?? null;
}
