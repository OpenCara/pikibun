import { bindingRemote, gitProviderNames } from '../../../../packages/shared/src/repositories.js';
import { parseLfsBatchRequest, parseLfsObject } from '../../../../packages/shared/src/network.js';
import { lfsBatchResult, lfsDownload, lfsProviderBatch, type LfsTarget } from '../../../../packages/shared/src/git-transfer.js';
import type { AppContext, RepositoryRow } from '../types.js';
import type { Database } from '../db/types.js';
import { fail, failTransfer } from '../http.js';
import { recheckAccess, verifyRepository, type RepositoryAccess } from './repositories.js';
import { ownerGitAuthorization } from './push/targets.js';

export const lfsRequestBytes = 64 * 1024;

export async function lfsEnabled(db: Database, binding: RepositoryRow): Promise<boolean> {
  const row = await db.query<{ enabled: number }>('SELECT enabled FROM repository_lfs_settings WHERE binding_id = ? AND workspace_id = ?')
    .bind(binding.id, binding.workspace_id).first();
  return row?.enabled === 1;
}

export function lfsDisabled(binding: RepositoryRow): never {
  return fail(403, 'lfs_disabled', `Git LFS is off for ${binding.full_name} in this workspace; a workspace owner or admin can turn it on in the workspace's repository settings.`);
}

function lfsInput<T>(body: Uint8Array, parse: (value: unknown) => T): T {
  try { return parse(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(body))); }
  catch (error) { return fail(400, 'invalid_lfs_request', error instanceof Error && /^[\x20-\x7e]{1,200}$/.test(error.message) ? error.message : 'Invalid Git LFS request.'); }
}

export async function lfsRelay(c: AppContext, options: {
  binding: RepositoryRow; access: RepositoryAccess; service: 'lfs-batch' | 'lfs-object'; body: Uint8Array; authorize: () => Promise<void>;
}): Promise<Response> {
  const { binding, access, service, body, authorize } = options;
  if (!await lfsEnabled(c.env.DB, binding)) lfsDisabled(binding);
  const target: LfsTarget = { remote: bindingRemote({ provider: binding.provider, host: binding.host, fullName: binding.full_name }),
    provider: gitProviderNames[binding.provider], fullName: binding.full_name, authorization: ownerGitAuthorization(access) };
  if (service === 'lfs-batch') {
    const request = lfsInput(body, parseLfsBatchRequest);
    await verifyRepository(access, { repositoryId: binding.repository_id, fullName: binding.full_name });
    await recheckAccess(c.env, access);
    await authorize();
    let answer;
    try { answer = await lfsProviderBatch(target, request.objects, request.ref); }
    catch (error) { failTransfer(error); }
    return c.json(lfsBatchResult(request.objects, answer), 200, { 'Cache-Control': 'private, no-store' });
  }
  const object = lfsInput(body, parseLfsObject);
  await verifyRepository(access, { repositoryId: binding.repository_id, fullName: binding.full_name });
  await recheckAccess(c.env, access);
  await authorize();
  let content: ReadableStream<Uint8Array>;
  try { content = await lfsDownload(target, object); }
  catch (error) { failTransfer(error); }
  return new Response(content, { headers: { 'Content-Type': 'application/octet-stream', 'Cache-Control': 'private, no-store' } });
}
