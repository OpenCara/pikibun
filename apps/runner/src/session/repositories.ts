import type { EgressGrant, EgressRepository } from "../../../../packages/shared/src/network.js";
import { bindingRemote } from "../../../../packages/shared/src/repositories.js";
import { repositoryPreparationPhases, type RepositoryPreparationItem, type RepositoryPreparationView } from "../../../../packages/shared/src/types.js";
import { repositoryForRemote, type MirrorProgress } from "../egress.js";
import { RunnerError } from "../protocol.js";
import type { IsolatedWorkspace } from "../workspace.js";

export function preparationFailure(reason: string): string {
  return `${reason.replace(/\.$/, "")}. Restart the session to try again.`;
}

export type RepositoryPreparation = { status: "ready" }
  | { status: "preparing"; done: Promise<void>; controller: AbortController; items: RepositoryPreparationItem[] }
  | { status: "failed"; reason: string; items: RepositoryPreparationItem[] };
type ProgressUpdate = (path: string, change: Partial<Omit<RepositoryPreparationItem, "path">>) => void;
export type CloneFailure = { path: string; reason: string };

export interface SessionRepositoriesOptions {
  grant(): Promise<EgressGrant>;
  cached: boolean;
  mirror(repository: EgressRepository, onProgress: (progress: MirrorProgress) => void): Promise<string>;
  workspace(): IsolatedWorkspace;
  authorize(): Promise<void>;
  changed(): void;
  exclusive(operation: () => Promise<void>): Promise<void>;
  opened(): boolean;
  closing(): boolean;
  resumed(): boolean;
  resume(): Promise<void>;
}

export class SessionRepositories {
  #preparation: RepositoryPreparation = { status: "ready" };
  #epoch = 0;
  #cloneFailures: CloneFailure[] = [];

  constructor(private readonly options: SessionRepositoriesOptions) {}

  get preparation(): RepositoryPreparation {
    return this.#preparation;
  }

  get status(): RepositoryPreparation["status"] {
    return this.#preparation.status;
  }

  get cloneFailures(): readonly CloneFailure[] {
    return this.#cloneFailures;
  }

  clearFailures(): void {
    this.#cloneFailures = [];
  }

  #track(epoch: number, preparing: Extract<RepositoryPreparation, { status: "preparing" }>): void {
    const { done, items } = preparing;
    this.#preparation = preparing;
    done.then(() => {
      if (this.#preparation !== preparing) return;
      this.#preparation = { status: "ready" };
      this.options.changed();
      void this.options.exclusive(async () => {
        if (epoch !== this.#epoch || !this.options.opened() || this.options.closing() || this.options.resumed() || this.#preparation.status !== "ready") return;
        await this.options.resume();
      }).catch(() => {
        if (epoch !== this.#epoch) return;
        this.#preparation = { status: "failed", reason: "This session could not resume its work after preparing its repositories", items };
        this.options.changed();
      });
    }, (error: unknown) => {
      if (this.#preparation !== preparing) return;
      this.#preparation = { status: "failed", reason: error instanceof RunnerError ? error.message : "Repositories could not be prepared on this host", items };
      this.options.changed();
    });
  }

  prepareClones(pending: { path: string; origin: string | null }[]): void {
    const epoch = ++this.#epoch;
    const controller = new AbortController();
    const authorize = async () => { controller.signal.throwIfAborted(); await this.options.authorize(); };
    const items: RepositoryPreparationItem[] = pending.map(({ path }) => ({ path, phase: "queued", percent: null, done: null, total: null, bytes: 0 }));
    const update: ProgressUpdate = (path, change) => { const item = items.find(each => each.path === path); if (item) Object.assign(item, change); };
    const done = (async () => {
      const failures: CloneFailure[] = [];
      for (const entry of pending) {
        controller.signal.throwIfAborted();
        update(entry.path, { phase: "connecting" });
        try {
          const repository = repositoryForRemote((await this.options.grant()).repositories, entry.origin ?? "");
          if (!repository) throw new RunnerError(409, "its origin is not one of this workspace's repositories");
          let reference: string | null = null;
          if (this.options.cached && repository.repositoryId !== undefined) {
            const progress = ({ phase, percent, done, total, bytes }: MirrorProgress) => {
              if (repositoryPreparationPhases.includes(phase as RepositoryPreparationItem["phase"])) update(entry.path, { phase: phase as RepositoryPreparationItem["phase"], percent, done, total, bytes });
            };
            try { reference = await this.options.mirror(repository, progress); } catch { }
          }
          update(entry.path, { phase: "receiving" });
          await this.options.workspace().cloneRestore(entry.path, bindingRemote(repository), reference, authorize);
        } catch (error) {
          if (controller.signal.aborted) throw error;
          const reason = error instanceof RunnerError ? error.message
            : error instanceof Error ? /sandbox: ([a-z0-9 ,.'()-]{1,160})$/i.exec(error.message.trim())?.[1] ?? "it could not be cloned again" : "it could not be cloned again";
          failures.push({ path: entry.path, reason });
        }
        update(entry.path, { phase: "done" });
      }
      this.#cloneFailures = failures;
    })();
    this.#track(epoch, { status: "preparing", done, controller, items });
  }

  requireReady(): void {
    const preparation = this.#preparation;
    if (preparation.status === "preparing") throw new RunnerError(409, "This session's repositories are still being prepared on its host. Try again once they are ready.");
    if (preparation.status === "failed") throw new RunnerError(502, preparationFailure(preparation.reason));
  }

  view(): RepositoryPreparationView | undefined {
    const preparation = this.#preparation;
    if (preparation.status === "ready") return undefined;
    return { status: preparation.status, items: preparation.items.map(item => ({ ...item })), ...(preparation.status === "failed" ? { error: preparation.reason } : {}) };
  }

  reset(): void {
    const preparation = this.#preparation;
    if (preparation.status === "preparing") preparation.controller.abort();
    this.#preparation = { status: "ready" };
    this.#epoch++;
  }
}
