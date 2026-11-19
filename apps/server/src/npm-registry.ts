import { extensionLimits, isExtensionIntegrity, parseExtensionSourceSpec, parseRegistryExtensionMetadata, type RegistryExtensionMetadata,
  type WorkspaceExtension } from '../../../packages/shared/src/host-extensions.js';
import type { Env } from './types.js';

const REGISTRY_TIMEOUT_MS = 5000;
const REGISTRY_MAX_BYTES = 1024 * 1024;

function registryUrl(pkg: string, version: string): string {
  const encoded = pkg.startsWith('@')
    ? `@${encodeURIComponent(pkg.slice(1, pkg.indexOf('/')))}/${encodeURIComponent(pkg.slice(pkg.indexOf('/') + 1))}`
    : encodeURIComponent(pkg);
  return `https://registry.npmjs.org/${encoded}/${encodeURIComponent(version)}`;
}

async function boundedJson(response: Response): Promise<unknown> {
  if (!response.body) return JSON.parse(await response.text());
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > REGISTRY_MAX_BYTES) throw new Error('Registry response exceeded size limit');
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return JSON.parse(new TextDecoder().decode(bytes));
}

export async function resolveNpmExtensionPackage(env: Env, source: string): Promise<{ integrity: string; metadata: RegistryExtensionMetadata } | undefined> {
  const spec = parseExtensionSourceSpec(source);
  if (spec.kind !== 'npm') return undefined;
  const fetcher = env.NPM_REGISTRY_FETCH ?? (env.TEST_AUTH_ENABLED === 'true' ? undefined : fetch);
  if (!fetcher) return undefined;
  let response: Response;
  try {
    response = await fetcher(registryUrl(spec.package, spec.version), {
      headers: { Accept: 'application/json' },
      redirect: 'error',
      signal: AbortSignal.timeout(REGISTRY_TIMEOUT_MS),
    });
  } catch {
    return undefined;
  }
  if (!response.ok) return undefined;
  let body: unknown;
  try { body = await boundedJson(response); }
  catch { return undefined; }
  if (!body || typeof body !== 'object' || Array.isArray(body)) return undefined;
  const data = body as { name?: unknown; version?: unknown; description?: unknown; dist?: { integrity?: unknown } };
  if (data.name !== spec.package || data.version !== spec.version || !isExtensionIntegrity(data.dist?.integrity)) return undefined;
  const description = typeof data.description === 'string'
    ? data.description.replace(/[\x00-\x1f\x7f]+/g, ' ').trim().slice(0, extensionLimits.text)
    : '';
  try {
    const metadata = parseRegistryExtensionMetadata({
      name: spec.package,
      version: spec.version,
      ...(description ? { description } : {}),
    });
    return { integrity: data.dist.integrity, metadata };
  } catch {
    return undefined;
  }
}

export async function saveRegistryExtensionMetadata(env: Env, source: string, integrity: string, metadata: RegistryExtensionMetadata, at: string): Promise<void> {
  await env.DB.query(`INSERT INTO extension_descriptions (source, integrity, metadata_json, updated_at) VALUES (?, ?, ?, ?)
    ON CONFLICT (source, integrity) DO UPDATE SET metadata_json = excluded.metadata_json, updated_at = excluded.updated_at`)
    .bind(source, integrity, JSON.stringify(metadata), at).run();
}

export async function workspaceRegistryMetadata(env: Env, extensions: readonly WorkspaceExtension[]): Promise<Record<string, RegistryExtensionMetadata>> {
  const locked = extensions.filter((item): item is WorkspaceExtension & { integrity: string } =>
    item.source.startsWith('npm:') && isExtensionIntegrity(item.integrity));
  if (!locked.length) return {};
  const sources = [...new Set(locked.map(item => item.source))];
  const rows = await env.DB.query<{ source: string; integrity: string; metadata_json: string }>(
    `SELECT source, integrity, metadata_json FROM extension_descriptions WHERE source IN (${sources.map(() => '?').join(', ')})`)
    .bind(...sources).all();
  const result: Record<string, RegistryExtensionMetadata> = {};
  for (const item of locked) {
    const row = rows.find(candidate => candidate.source === item.source && candidate.integrity === item.integrity);
    if (!row) continue;
    try { result[item.source] = parseRegistryExtensionMetadata(JSON.parse(row.metadata_json)); }
    catch { }
  }
  return result;
}
