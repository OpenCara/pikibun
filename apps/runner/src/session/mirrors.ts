import { setTimeout as sleep } from "node:timers/promises";
import type { EgressGrant, EgressRepository } from "../../../../packages/shared/src/network.js";
import { bindingRemote } from "../../../../packages/shared/src/repositories.js";
import { relayFetch, type MirrorProgress, type RelayRequest } from "../egress.js";
import { HostCredentialError, hostGitAuthorization } from "../git-credentials.js";
import { GitRemote, GitRemoteError } from "../git-remote.js";
import { RunnerError } from "../protocol.js";
import { mirrorPath, type MirrorRepository, type RepositoryCache } from "../repo-cache.js";
import { MIRROR_ROOT, type MirrorMount } from "../sandbox.js";

/*
 * The host repository cache's mirrors a clone session borrows from (see GIT_SHIM in sandbox.ts): which mirrors its steps
 * mount, and the relay's word, with the session owner's own access, that the owner may read each repository. Mirrors are
 * filled straight from the provider with the host's own Git credentials, never through the relay.
 */

/** How long the relay's word that a session's owner may read a repository lets the session borrow from its mirror. */
export const MIRROR_CONFIRM_MS = 10 * 60 * 1000;
/** How long a clone waits for the refresh of a mirror filled before; then it borrows the mirror as it is (see mirror). */
export const MIRROR_REFRESH_WAIT_MS = 10_000;
/** Pauses before the relay is asked again for a repository's refs, after a quick failure another attempt may get past. */
const OWNER_REFS_RETRY_MS = [500, 2_000];
/** How long one listing of a repository's refs through the relay may take. */
const OWNER_REFS_TIMEOUT_MS = 30_000;

/**
 * A definite refusal from the control plane or the provider: a 4xx other than a timeout or rate limit, as a RunnerError
 * from the relay or a GitRemoteError status (relayFetch turns the relay's refusals into HTTP statuses).
 */
export function refused(error: unknown): boolean {
  const status = error instanceof RunnerError ? error.status : error instanceof GitRemoteError ? error.status : undefined;
  return status !== undefined && status >= 400 && status < 500 && status !== 408 && status !== 429;
}

/** A grant's repository as the cache keys it; an older control plane that names no provider id offers no mirror. */
export function mirrorRepository(repository: EgressRepository): MirrorRepository & { bindingId: string } {
  if (repository.repositoryId === undefined) throw new RunnerError(409, "Update the Pikibun server to cache this repository on the host");
  return { bindingId: repository.bindingId, provider: repository.provider, host: repository.host, repositoryId: repository.repositoryId, fullName: repository.fullName };
}

/**
 * Why the host couldn't fill its mirror of `repository`, as the clone waiting for it is told (see GIT_SHIM): 503 for a
 * failure another attempt may get past, after the cache's own attempts, so the clone asks again or stops to be run again
 * rather than downloading the repository without the cache; any other status lets it go ahead without the cache.
 */
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
  /** The session's relay of one Git request (RunnerSession.relay), with the owner's access. */
  relay(request: RelayRequest): Promise<Response>;
  /** The session's current network grant: its workspace's repositories. */
  grant(): Promise<EgressGrant>;
  /** How the cache reads a repository (RunnerConfig.cacheRemote); by default from its provider with the host's credentials. */
  cacheRemote?: (repository: EgressRepository) => Promise<GitRemote>;
}

export class SessionMirrors {
  /**
   * The mirrors this session may borrow from, by sandbox path, and when the relay last let its owner read each (0: not
   * yet in this open). Mounted only while confirmed in the last MIRROR_CONFIRM_MS (see `mounts`).
   */
  readonly #mirrors = new Map<string, { mount: MirrorMount; repository: MirrorRepository & { bindingId: string }; confirmedAt: number }>();

  constructor(private readonly options: SessionMirrorsOptions) {}

  /** The relay refused the owner a read of the repository `bindingId` names: its mirror is no longer borrowed in this open. */
  forget(bindingId: string): void {
    for (const [target, entry] of this.#mirrors) if (entry.repository.bindingId === bindingId) this.#mirrors.delete(target);
  }

  /**
   * A workspace repository read through the relay, where the relay itself adds the owner's credential: how this session
   * confirms that its owner may read a repository before it borrows the host's mirror of it.
   */
  #relayRemote(repository: EgressRepository, signal?: AbortSignal): GitRemote {
    return new GitRemote({ url: bindingRemote(repository), authorization: "Bearer relay", fetch: relayFetch(repository.bindingId, request => this.options.relay(request)), signal });
  }

  /**
   * Makes the host's mirror of `repository` ready and lets this session's shell commands borrow from it. The relay first
   * lists the repository's branches and tags with the session owner's own account, which confirms they may read it; then
   * the mirror fetches those tips straight from the provider with this host's own Git credentials (cacheRemote), never
   * through the relay. A mirror no fill has completed yet is waited for, however long its first fill takes; a filled one
   * for at most MIRROR_REFRESH_WAIT_MS, then it is borrowed as it is while its refresh goes on. Answers its sandbox path.
   */
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

  /**
   * `repository`'s branches and tags as the session owner's own account lists them, through the relay (which checks the
   * repository's identity too): what confirms that the session may borrow its mirror, and what the mirror mirrors.
   * - A refusal is final (403).
   * - A failure another attempt may get past (the relay busy or failing, its connection failing or breaking off, or the
   *   listing running out of its time) ends in 503, which the clone asks again: a quick one only once the relay was asked
   *   again (OWNER_REFS_RETRY_MS), one that ran out of its time at once.
   * - Anything else will fail again just the same: 502, so the clone goes ahead without the cache, through the relay,
   *   where Git says what is wrong.
   */
  async #ownerRefs(value: EgressRepository): Promise<Map<string, string>> {
    for (let failures = 0; ; failures++) {
      const timeout = AbortSignal.timeout(OWNER_REFS_TIMEOUT_MS);
      try { return await this.#relayRemote(value, timeout).listRefs(); }
      catch (error) {
        // A refused read already ended borrowing for this open (see RunnerSession.relay).
        if (refused(error)) throw new RunnerError(403, `Pikibun did not confirm that this session's owner can read ${value.fullName}`);
        // GitRemote calls a request its caller's signal aborted final; here that signal is the listing's own time limit.
        if (!timeout.aborted && !(error instanceof GitRemoteError && error.retryable)) {
          throw new RunnerError(502, `Pikibun could not list ${value.fullName} for this session's owner`);
        }
        const pause = timeout.aborted ? undefined : OWNER_REFS_RETRY_MS[failures];
        if (pause === undefined) throw new RunnerError(503, `Pikibun could not confirm right now that this session's owner can read ${value.fullName}`);
        await sleep(pause);
      }
    }
  }

  /** How the host's repository cache reads `repository` (see RunnerConfig.cacheRemote). */
  async #cacheRemote(repository: EgressRepository): Promise<GitRemote> {
    if (this.options.cacheRemote) return this.options.cacheRemote(repository);
    const url = bindingRemote(repository);
    let authorization: string | undefined;
    // A host with no credential for the provider still fills public repositories.
    try { authorization = await hostGitAuthorization(url); }
    catch (error) { if (!(error instanceof HostCredentialError)) throw error; }
    return new GitRemote({ url, ...(authorization ? { authorization } : {}) });
  }

  #allow(repository: MirrorRepository & { bindingId: string }, confirmedAt: number): string {
    // The cache's own layout, at a path every session sees the same way.
    const mount = { source: this.options.cache.mirrorDirectory(repository, this.options.ownerId), target: `${MIRROR_ROOT}/${mirrorPath(repository)}` };
    this.#mirrors.set(mount.target, { mount, repository, confirmedAt });
    return mount.target;
  }

  /**
   * The mirrors a step that runs Git in a clone gets: those of repositories still in the workspace's grant, each read
   * through the relay with the owner's access in the last MIRROR_CONFIRM_MS (older ones are confirmed again first, and
   * their keep refs marked used). A repository the grant or the relay no longer allows is dropped for this open.
   */
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
        // A refusal ends borrowing for this open; anything else (a timeout, a rate limit, an outage) only skips this step,
        // and the next one asks again.
        if (refused(error)) this.#mirrors.delete(entry.mount.target);
      }
    }));
    return [...this.#mirrors.values()].filter(entry => Date.now() - entry.confirmedAt <= MIRROR_CONFIRM_MS).map(entry => entry.mount);
  }

  /**
   * Lists the mirror of every workspace repository for this open, creating the ones this host doesn't have yet, empty:
   * each is mounted only once the relay confirms the owner can read its repository (see `mounts`). Created before any
   * command runs, so the command that first clones a repository already mounts the mirror its clone waits to fill (see
   * GIT_SHIM), and clones made earlier still borrow from theirs after a reopen.
   */
  async restore(repositories: readonly EgressRepository[]): Promise<void> {
    this.#mirrors.clear();
    for (const value of repositories) {
      if (value.repositoryId === undefined) continue;
      const repository = mirrorRepository(value);
      // A cache root that isn't private can't be used; the clone hears why when it asks for the mirror.
      try { await this.options.cache.prepare(repository, this.options.ownerId); }
      catch { continue; }
      this.#allow(repository, 0);
    }
  }
}
