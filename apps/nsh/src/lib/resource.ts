import { effect, lifecycle, signal, untracked, type Accessor } from "nsh";
import { errorMessage } from "../shared";
import { session } from "./auth";

/** In the background the app makes no requests; "inactive" (the app switcher, another window focused) still shows it. */
export const inBackground = () => untracked(lifecycle) === "background";

export interface Resource<T> {
  data: Accessor<T | null>;
  loading: Accessor<boolean>;
  error: Accessor<string>;
  refresh: () => void;
}

/**
 * GET `path()` (null: nothing to load), again whenever the path changes. With `pollMs` it reloads on that interval
 * while the app is in the foreground, and right away when the app comes back to it. A new path drops the previous
 * data; a refresh keeps it on screen. Create it in a component: it lives as long as the component.
 */
export function createResource<T>(path: Accessor<string | null>, pollMs?: Accessor<number | undefined> | number): Resource<T> {
  const data = signal<T | null>(null);
  const loading = signal(false);
  const error = signal("");
  const revision = signal(0);
  let previousPath: string | null | undefined;
  effect(() => {
    const current = path();
    revision();
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
        if (!controller.signal.aborted) loading.set(false);
      }
    };
    void load();
    if (!interval) return () => controller.abort();
    const timer = setInterval(() => { if (!inBackground()) void load(); }, interval);
    return () => { controller.abort(); clearInterval(timer); };
  });
  // Back in the foreground: what was polled may be stale.
  let wasActive = untracked(lifecycle) !== "background";
  effect(() => {
    const active = lifecycle() !== "background";
    if (active && !wasActive && pollMs) revision.update(value => value + 1);
    wasActive = active;
  });
  return { data, loading, error, refresh: () => revision.update(value => value + 1) };
}

export interface Action {
  busy: Accessor<boolean>;
  error: Accessor<string>;
  notice: Accessor<string>;
  /** Runs `task` unless one is running; failures become `error`, success shows `notice`. Resolves true on success. */
  run: (task: () => Promise<void>, notice?: string) => Promise<boolean>;
  clear: () => void;
}

/** One user-triggered mutation at a time, with its outcome to show. */
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
