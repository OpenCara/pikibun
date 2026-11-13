import type { OperationRecord, SessionActivity } from "../../../packages/shared/src/types.js";

export interface ActivityRun {
  mode: "write" | "ask";
  status: "queued" | "admitting" | "running" | "settled" | "interrupted";
  sequence?: number;
  startEntry: number;
  failure?: unknown;
  stopped?: { pending?: boolean };
}

export interface ActivityEntry {
  id: number;
  failed: boolean;
}

const activeRuns: readonly ActivityRun["status"][] = ["queued", "admitting", "running"];

export function latestSharedRun<T extends ActivityRun>(runs: Iterable<T>): T | undefined {
  let latest: T | undefined;
  for (const run of runs) if (run.mode === "write" && (!latest || (run.sequence ?? 0) >= (latest.sequence ?? 0))) latest = run;
  return latest;
}

export function sessionActivity(runs: readonly ActivityRun[], approvals: readonly Pick<OperationRecord, "status" | "operation">[], last?: ActivityEntry): SessionActivity {
  if (runs.some(run => run.stopped?.pending)) return "working";
  if (approvals.some(approval => approval.status === "pending")) return "waiting";
  if (runs.some(run => activeRuns.includes(run.status)) || approvals.some(approval => approval.status === "executing")) return "working";
  const latest = latestSharedRun(runs);
  if (!latest || latest.stopped) return "idle";
  if (latest.failure !== undefined || latest.status === "interrupted") return "failed";
  return last !== undefined && last.id > latest.startEntry && last.failed ? "failed" : "done";
}

export interface ActivityTiming {
  settleMs: number;
  firstRetryMs: number;
  maxRetryMs: number;
}

export const activityTiming: ActivityTiming = { settleMs: 300, firstRetryMs: 2_000, maxRetryMs: 60_000 };

export class ActivityReporter {
  readonly #read: () => Promise<SessionActivity>;
  readonly #send: (activity: SessionActivity) => Promise<void>;
  readonly #timing: ActivityTiming;
  #sent: SessionActivity | undefined;
  #dirty = false;
  #sending = false;
  #open = false;
  #failures = 0;
  #timer: NodeJS.Timeout | undefined;

  constructor(read: () => Promise<SessionActivity>, send: (activity: SessionActivity) => Promise<void>, timing: ActivityTiming = activityTiming) {
    this.#read = read;
    this.#send = send;
    this.#timing = timing;
  }

  start(): void {
    this.#open = true;
    this.changed();
  }

  changed(): void {
    if (!this.#open) return;
    this.#dirty = true;
    this.#schedule(this.#timing.settleMs);
  }

  stop(): void {
    this.#open = false;
    clearTimeout(this.#timer);
    this.#timer = undefined;
  }

  #schedule(delay: number): void {
    if (this.#timer !== undefined || this.#sending) return;
    this.#timer = setTimeout(() => {
      this.#timer = undefined;
      void this.#flush();
    }, delay);
    this.#timer.unref();
  }

  async #flush(): Promise<void> {
    if (this.#sending || !this.#open) return;
    this.#sending = true;
    let failed = false;
    try {
      while (this.#dirty && this.#open) {
        this.#dirty = false;
        const activity = await this.#read();
        if (activity === this.#sent || !this.#open) continue;
        await this.#send(activity);
        this.#sent = activity;
        this.#failures = 0;
      }
    } catch {
      this.#dirty = true;
      failed = true;
    } finally {
      this.#sending = false;
    }
    if (!this.#open || !this.#dirty) return;
    this.#schedule(failed ? Math.min(this.#timing.maxRetryMs, this.#timing.firstRetryMs * 2 ** this.#failures++) : this.#timing.settleMs);
  }
}
