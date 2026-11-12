import { effect, lifecycle, signal, untracked, type Accessor } from "nsh";
import { errorMessage } from "../shared";
import { session } from "./auth";

export const inBackground = () => untracked(lifecycle) === "background";

export interface Resource<T> {
  data: Accessor<T | null>;
  loading: Accessor<boolean>;
  error: Accessor<string>;
  refresh: () => Promise<void>;
}

export function createResource<T>(path: Accessor<string | null>, pollMs?: Accessor<number | undefined> | number): Resource<T> {
  const data = signal<T | null>(null);
  const loading = signal(false);
  const error = signal("");
  const revision = signal(0);
  let previousPath: string | null | undefined;
  let waiting: { revision: number; done: () => void }[] = [];
  const settle = (upTo: number) => {
    const done = waiting.filter(item => item.revision <= upTo);
    waiting = waiting.filter(item => item.revision > upTo);
    for (const item of done) item.done();
  };
  effect(() => {
    const current = path();
    const run = revision();
    const interval = typeof pollMs === "function" ? pollMs() : pollMs;
    const { api } = untracked(session);
    const controller = new AbortController();
    if (previousPath !== current) {
      previousPath = current;
      data.set(null);
    }
    error.set("");
    if (!current) {
      loading.set(false);
      settle(run);
      return () => controller.abort();
    }
    loading.set(true);
    let pending = false;
    const load = async () => {
      if (pending) return;
      pending = true;
      try {
        const result = await api<T>(current, { signal: controller.signal });
        if (!controller.signal.aborted) { data.set(result); error.set(""); }
      } catch (reason) {
        if (!controller.signal.aborted) error.set(errorMessage(reason));
      } finally {
        pending = false;
        if (!controller.signal.aborted) { loading.set(false); settle(run); }
      }
    };
    void load();
    if (!interval) return () => controller.abort();
    const timer = setInterval(() => { if (!inBackground()) void load(); }, interval);
    return () => { controller.abort(); clearInterval(timer); };
  });
  let wasActive = untracked(lifecycle) !== "background";
  effect(() => {
    const active = lifecycle() !== "background";
    if (active && !wasActive && pollMs) revision.update(value => value + 1);
    wasActive = active;
  });
  return {
    data, loading, error,
    refresh: () => new Promise<void>(done => {
      const next = untracked(revision) + 1;
      waiting.push({ revision: next, done });
      revision.set(next);
    }),
  };
}

export interface Action {
  busy: Accessor<boolean>;
  error: Accessor<string>;
  notice: Accessor<string>;
  run: (task: () => Promise<void>, notice?: string) => Promise<boolean>;
  clear: () => void;
}

export function createAction(): Action {
  const busy = signal(false);
  const error = signal("");
  const notice = signal("");
  let running = false;
  return {
    busy, error, notice,
    async run(task, success = "") {
      if (running) return false;
      running = true;
      busy.set(true);
      error.set("");
      notice.set("");
      try {
        await task();
        notice.set(success);
        return true;
      } catch (reason) {
        error.set(errorMessage(reason));
        return false;
      } finally {
        running = false;
        busy.set(false);
      }
    },
    clear() { error.set(""); notice.set(""); },
  };
}
