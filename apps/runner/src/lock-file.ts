import { randomUUID } from "node:crypto";
import { link, open, rename, unlink, utimes } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";

export const LOCK_BEAT = "beat";
export const LOCK_BEAT_MS = 1_000;
export const LOCK_STALE_MS = 15_000;
export const LOCK_CONFIRM_MS = 3_000;
const CONFIRM_POLL_MS = 250;

export interface LockTiming { staleMs?: number; confirmMs?: number }

export interface SeenLock { content: string; mtimeMs: number }

export function processAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code === "EPERM"; }
}

export async function readLock(path: string): Promise<SeenLock | undefined> {
  let handle;
  try { handle = await open(path, "r"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
  try {
    const stat = await handle.stat();
    return { content: await handle.readFile("utf8"), mtimeMs: stat.mtimeMs };
  } finally { await handle.close(); }
}

const same = (a: SeenLock, b: SeenLock): boolean => a.content === b.content && a.mtimeMs === b.mtimeMs;

export async function beatOf(path: string, seen: SeenLock, timing: LockTiming = {}): Promise<"beating" | "stopped" | "changed"> {
  if (Math.abs(Date.now() - seen.mtimeMs) <= (timing.staleMs ?? LOCK_STALE_MS)) return "beating";
  const deadline = Date.now() + (timing.confirmMs ?? LOCK_CONFIRM_MS);
  for (;;) {
    await delay(Math.max(1, Math.min(CONFIRM_POLL_MS, deadline - Date.now())));
    let now: SeenLock | undefined;
    try { now = await readLock(path); } catch { return "beating"; }
    if (!now || now.content !== seen.content) return "changed";
    if (now.mtimeMs !== seen.mtimeMs) return "beating";
    if (Date.now() >= deadline) return "stopped";
  }
}

export async function beatLock(path: string, content: string): Promise<"kept" | "lost" | "missing" | "unknown"> {
  let seen: SeenLock | undefined;
  try { seen = await readLock(path); } catch { return "unknown"; }
  if (!seen) return "missing";
  if (seen.content !== content) return "lost";
  const now = new Date();
  try { await utimes(path, now, now); } catch { return "unknown"; }
  return "kept";
}

export async function takeAway(path: string, seen: SeenLock): Promise<void> {
  const aside = `${path}.${randomUUID()}.stale`;
  try { await rename(path, aside); } catch { return; }
  let moved: SeenLock | undefined;
  try { moved = await readLock(aside); } catch { }
  if (!moved || !same(moved, seen)) await link(aside, path).catch(() => {});
  await unlink(aside).catch(() => {});
}
