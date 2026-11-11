import { InstanceLockedError, InstanceLockLostError, type InstanceLock } from './types.js';

export interface HeldLock {
  stillHeld(): Promise<boolean>;
  release(): Promise<void>;
}

export interface WatchOptions {
  intervalMs: number;
  graceMs: number;
  log?: (message: string) => void;
  now?: () => number;
}

export async function watchInstanceLock(take: (wake: () => void) => Promise<HeldLock | null>, options: WatchOptions): Promise<InstanceLock> {
  const now = options.now ?? Date.now;
  const log = options.log ?? (message => console.error(`pikibun: ${message}`));
  const listeners = new Set<(error: Error) => void>();
  let current: HeldLock | null = null;
  let missingSince: number | undefined;
  let state: 'held' | 'released' | 'lost' = 'held';
  let running: Promise<void> | undefined;
  let lostError: Error | undefined;

  const wake = () => { if (state === 'held') void tick(); };
  current = await take(wake);
  if (!current) throw new InstanceLockedError();

  const lose = (error: Error) => {
    if (state !== 'held') return;
    state = 'lost';
    lostError = error;
    clearInterval(timer);
    for (const listener of listeners) {
      try { listener(error); } catch {}
    }
  };

  const check = async () => {
    if (current) {
      let held = false;
      try { held = await current.stillHeld(); } catch {}
      if (state !== 'held') return;
      if (held) { missingSince = undefined; return; }
      const dropped = current;
      current = null;
      missingSince ??= now();
      log('the single-instance lock\'s connection to the database was lost; taking the lock again.');
      await dropped.release().catch(() => {});
    }
    missingSince ??= now();
    let next: HeldLock | null;
    try { next = await take(wake); } catch (error) {
      if (now() - missingSince >= options.graceMs) {
        lose(new InstanceLockLostError(`the database was unreachable for ${Math.round((now() - missingSince) / 1000)} s (${error instanceof Error ? error.message : String(error)})`));
      }
      return;
    }
    if (state !== 'held') { await next?.release().catch(() => {}); return; }
    if (!next) { lose(new InstanceLockLostError('another server took it')); return; }
    current = next;
    missingSince = undefined;
    log('the single-instance lock is held again.');
  };

  const tick = (): Promise<void> => {
    running ??= check().finally(() => { running = undefined; });
    return running;
  };

  const timer = setInterval(() => { void tick(); }, options.intervalMs);
  timer.unref();

  return {
    async release() {
      if (state === 'released') return;
      state = 'released';
      clearInterval(timer);
      await running?.catch(() => {});
      const held = current;
      current = null;
      await held?.release();
    },
    onLost(listener) {
      if (lostError) { listener(lostError); return; }
      listeners.add(listener);
    },
  };
}
