import type { EgressRepository } from "../../../../packages/shared/src/network.js";
import type { SessionBranch } from "../../../../packages/shared/src/types.js";
import { reportedBranches, type CloneBranch } from "../clone-branches.js";

export interface BranchReportsOptions {
  sessionId: string;
  send: (sessionId: string, branches: SessionBranch[]) => Promise<void>;
  repositories: () => Promise<EgressRepository[]>;
  clones: () => Promise<CloneBranch[]>;
  closing: () => boolean;
  warn?: (message: string) => void;
}

export class BranchReports {
  #repositories: EgressRepository[] = [];
  #sent: string | undefined;
  #reporting: Promise<void> | undefined;
  #wanted = false;

  constructor(readonly options: BranchReportsOptions) {}

  useRepositories(repositories: EgressRepository[]): void {
    this.#repositories = repositories;
  }

  request(): void {
    if (this.options.closing()) return;
    if (this.#reporting) { this.#wanted = true; return; }
    this.#reporting = (async () => {
      try {
        do {
          this.#wanted = false;
          if (!this.#repositories.length) this.#repositories = await this.options.repositories();
          if (!this.#repositories.length) break;
          const branches = reportedBranches(await this.options.clones(), this.#repositories);
          const json = JSON.stringify(branches);
          if (json === this.#sent) continue;
          await this.options.send(this.options.sessionId, branches);
          this.#sent = json;
        } while (this.#wanted && !this.options.closing());
      } catch (error) {
        const warn = this.options.warn ?? console.warn;
        warn(`Session ${this.options.sessionId}: could not report its clones' branches: ${error instanceof Error ? error.message : String(error)}`);
      } finally {
        this.#reporting = undefined;
      }
    })();
  }

  settled(): Promise<void> {
    return this.#reporting ?? Promise.resolve();
  }
}
