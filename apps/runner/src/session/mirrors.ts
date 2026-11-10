import { setTimeout as sleep } from "node:timers/promises";
import type { EgressGrant, EgressRepository } from "../../../../packages/shared/src/network.js";
import { bindingRemote } from "../../../../packages/shared/src/repositories.js";
import { relayFetch, type MirrorProgress, type RelayRequest } from "../egress.js";
import { HostCredentialError, hostGitAuthorization } from "../git-credentials.js";
import { GitRemote, GitRemoteError } from "../git-remote.js";
import { RunnerError } from "../protocol.js";
import { mirrorPath, type MirrorRepository, type RepositoryCache } from "../repo-cache.js";
import { MIRROR_ROOT, type MirrorMount } from "../sandbox.js";

export const MIRROR_CONFIRM_MS = 10 * 60 * 1000;
export const MIRROR_REFRESH_WAIT_MS = 10_000;
const OWNER_REFS_RETRY_MS = [500, 2_000];
const OWNER_REFS_TIMEOUT_MS = 30_000;

export function refused(error: unknown): boolean {
  const status = error instanceof RunnerError ? error.status : error instanceof GitRemoteError ? error.status : undefined;
  return status !== undefined && status >= 400 && status < 500 && status !== 408 && status !== 429;
}

export function mirrorRepository(repository: EgressRepository): MirrorRepository & { bindingId: string } {
  if (repository.repositoryId === undefined) throw new RunnerError(409, "Update the Pikibun server to cache this repository on the host");
  return { bindingId: repository.bindingId, provider: repository.provider, host: repository.host, repositoryId: repository.repositoryId, fullName: repository.fullName };
}

export function cacheFailure(error: unknown, repository: EgressRepository): RunnerError {
  if (error instanceof RunnerError) return error;
  if (error instanceof GitRemoteError && error.status !== undefined && [401, 403, 404].includes(error.status)) {
    return new RunnerError(502, `This host's Git credentials can't read ${repository.fullName}; its owner can set one up for ${repository.host} on it, for example with gh auth setup-git`);
  }
  const reason = error instanceof Error && /^[\x20-\x7e]{1,300}$/.test(error.message) ? error.message : "The repository could not be cached";
  return new RunnerError(error instanceof GitRemoteError && error.retryable ? 503 : 502, reason);
}

export interface SessionMirrorsOptions {
  cache: Pick<RepositoryCache, "mirrorDirectory" | "prepare" | "ready" | "touch">;
  ownerId: string;
  sessionId: string;
  relay(request: RelayRequest): Promise<Response>;
  grant(): Promise<EgressGrant>;
  cacheRemote?: (repository: EgressRepository) => Promise<GitRemote>;
}

export class SessionMirrors {
  readonly #mirrors = new Map<string, { mount: MirrorMount; repository: MirrorRepository & { bindingId: string }; confirmedAt: number }>();

  constructor(private readonly options: SessionMirrorsOptions) {}

  forget(bindingId: string): void {
    for (const [target, entry] of this.#mirrors) if (entry.repository.bindingId === bindingId) this.#mirrors.delete(target);
  }

  #relayRemote(repository: EgressRepository, signal?: AbortSignal): GitRemote {
    return new GitRemote({ url: bindingRemote(repository), authorization: "Bearer relay", fetch: relayFetch(repository.bindingId, request => this.options.relay(request)), signal });
  }

  async mirror(value: EgressRepository, onProgress?: (progress: MirrorProgress) => void): Promise<string> {
    const repository = mirrorRepository(value);
    const refs = await this.#ownerRefs(value);
    const confirmedAt = Date.now();
    try {
      const target = { repository, ownerId: this.options.ownerId, sessionId: this.options.sessionId, remote: await this.#cacheRemote(value), refs };
      await this.options.cache.ready(target, { ...(onProgress ? { onProgress } : {}), wait: MIRROR_REFRESH_WAIT_MS });
    } catch (error) {
      throw cacheFailure(error, value);
    }
    return this.#allow(repository, confirmedAt);
  }

  async #ownerRefs(value: EgressRepository): Promise<Map<string, string>> {
    for (let failures = 0; ; failures++) {
      const timeout = AbortSignal.timeout(OWNER_REFS_TIMEOUT_MS);
      try { return await this.#relayRemote(value, timeout).listRefs(); }
      catch (error) {
        if (refused(error)) throw new RunnerError(403, `Pikibun did not confirm that this session's owner can read ${value.fullName}`);
        if (!timeout.aborted && !(error instanceof GitRemoteError && error.retryable)) {
          throw new RunnerError(502, `Pikibun could not list ${value.fullName} for this session's owner`);
        }
        const pause = timeout.aborted ? undefined : OWNER_REFS_RETRY_MS[failures];
        if (pause === undefined) throw new RunnerError(503, `Pikibun could not confirm right now that this session's owner can read ${value.fullName}`);
        await sleep(pause);
      }
    }
  }

  async #cacheRemote(repository: EgressRepository): Promise<GitRemote> {
    if (this.options.cacheRemote) return this.options.cacheRemote(repository);
    const url = bindingRemote(repository);
    let authorization: string | undefined;
    try { authorization = await hostGitAuthorization(url); }
    catch (error) { if (!(error instanceof HostCredentialError)) throw error; }
    return new GitRemote({ url, ...(authorization ? { authorization } : {}) });
  }

  #allow(repository: MirrorRepository & { bindingId: string }, confirmedAt: number): string {
    const mount = { source: this.options.cache.mirrorDirectory(repository, this.options.ownerId), target: `${MIRROR_ROOT}/${mirrorPath(repository)}` };
    this.#mirrors.set(mount.target, { mount, repository, confirmedAt });
    return mount.target;
  }

  async mounts(): Promise<MirrorMount[]> {
    let repositories: EgressRepository[];
    try { repositories = (await this.options.grant()).repositories; }
    catch (error) {
      if (refused(error)) this.#mirrors.clear();
      return [];
    }
    const granted = new Set(repositories.map(repository => repository.bindingId));
    for (const [target, entry] of this.#mirrors) if (!granted.has(entry.repository.bindingId)) this.#mirrors.delete(target);
    const stale = [...this.#mirrors.values()].filter(entry => Date.now() - entry.confirmedAt > MIRROR_CONFIRM_MS);
    await Promise.all(stale.map(async entry => {
      try {
        await this.#relayRemote(entry.repository, AbortSignal.timeout(15_000)).listRefs();
        entry.confirmedAt = Date.now();
        await this.options.cache.touch(entry.repository, this.options.ownerId, this.options.sessionId).catch(() => {});
      } catch (error) {
        if (refused(error)) this.#mirrors.delete(entry.mount.target);
      }
    }));
    return [...this.#mirrors.values()].filter(entry => Date.now() - entry.confirmedAt <= MIRROR_CONFIRM_MS).map(entry => entry.mount);
  }

  async restore(repositories: readonly EgressRepository[]): Promise<void> {
    this.#mirrors.clear();
    for (const value of repositories) {
      if (value.repositoryId === undefined) continue;
      const repository = mirrorRepository(value);
      try { await this.options.cache.prepare(repository, this.options.ownerId); }
      catch { continue; }
      this.#allow(repository, 0);
    }
  }
}
