import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { open, readFile, rm, unlink } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { createFilled, STALE_LOCK_MS } from "./identity.js";
import { beatLock, beatOf, LOCK_BEAT, processAlive, readLock, takeAway, type LockTiming, type SeenLock } from "./lock-file.js";
import { RunnerError } from "./protocol.js";

const LEASE_FILE = "open.lock";
const RELEASE_FILE = "release";
const RECHECKS = 3;
const liveLeases = new Set<string>();

export type LeaseHolder = "none" | "self" | "other";

interface Inspected { holder: LeaseHolder; seen?: SeenLock }

export class PortableLeases {
  readonly #token = randomUUID();
  readonly #content = `${process.pid} ${this.#token} ${LOCK_BEAT}`;
  readonly #held = new Set<string>();
  readonly #lost = new Set<string>();
  #beating?: Promise<void>;

  constructor(private readonly timing: LockTiming = {}) { liveLeases.add(this.#token); }

  close(): void { liveLeases.delete(this.#token); }

  async #inspect(path: string): Promise<Inspected> {
    for (let check = 0; check < RECHECKS; check++) {
      const seen = await readLock(path);
      if (!seen) return { holder: "none" };
      const [pidText, token, beat] = seen.content.trim().split(" ");
      const pid = Number.parseInt(pidText ?? "", 10);
      if (token === this.#token && pid === process.pid) return { holder: "self", seen };
      if (!Number.isSafeInteger(pid) || pid < 1 || !token) return { holder: Date.now() - seen.mtimeMs > STALE_LOCK_MS ? "none" : "other", seen };
      if (pid === process.pid) return { holder: liveLeases.has(token) ? "other" : "none", seen };
      if (!processAlive(pid)) return { holder: "none", seen };
      if (beat !== LOCK_BEAT) return { holder: "other", seen };
      const state = await beatOf(path, seen, this.timing);
      if (state === "beating") return { holder: "other", seen };
      if (state === "stopped") return { holder: "none", seen };
    }
    return { holder: "other" };
  }

  async holder(directory: string): Promise<LeaseHolder> {
    return (await this.#inspect(join(directory, LEASE_FILE))).holder;
  }

  async acquire(directory: string): Promise<void> {
    const path = join(directory, LEASE_FILE);
    for (let attempt = 0; attempt < RECHECKS; attempt++) {
      if (await createFilled(path, this.#content)) { this.#hold(directory); return; }
      const { holder, seen } = await this.#inspect(path);
      if (holder === "self") { this.#hold(directory); return; }
      if (holder === "other") break;
      if (seen) await takeAway(path, seen);
    }
    throw new RunnerError(409, "This session is open on another of this computer's connections. Try again shortly");
  }

  #hold(directory: string): void {
    this.#lost.delete(directory);
    this.#held.add(directory);
  }

  lost(directory: string): boolean { return this.#lost.has(directory); }

  async release(directory: string): Promise<void> {
    this.#held.delete(directory);
    this.#lost.delete(directory);
    if (await this.holder(directory).catch(() => "none") === "self") await unlink(join(directory, LEASE_FILE)).catch(() => {});
  }

  refresh(): Promise<void> {
    this.#beating ??= (async () => {
      for (const directory of [...this.#held]) {
        if (await beatLock(join(directory, LEASE_FILE), this.#content) === "lost" && this.#held.delete(directory)) this.#lost.add(directory);
      }
    })().finally(() => { this.#beating = undefined; });
    return this.#beating;
  }

  async releaseRequested(directory: string): Promise<boolean> {
    return readFile(join(directory, RELEASE_FILE)).then(() => true, () => false);
  }

  async requestRelease(directory: string, timeoutMs: number, pollMs = 100): Promise<boolean> {
    const path = join(directory, RELEASE_FILE);
    const handle = await open(path, constants.O_CREAT | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
    await handle.close();
    try {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        if (await this.holder(directory) !== "other") return true;
        if (Date.now() >= deadline) return false;
        await delay(pollMs);
      }
    } finally { await rm(path, { force: true }); }
  }
}
