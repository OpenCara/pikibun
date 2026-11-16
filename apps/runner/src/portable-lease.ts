import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { open, readFile, rm, unlink } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { RunnerError } from "./protocol.js";

const LEASE_FILE = "open.lock";
const RELEASE_FILE = "release";
const liveLeases = new Set<string>();

function processAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code === "EPERM"; }
}

export type LeaseHolder = "none" | "self" | "other";

export class PortableLeases {
  readonly #token = randomUUID();

  constructor() { liveLeases.add(this.#token); }

  close(): void { liveLeases.delete(this.#token); }

  async holder(directory: string): Promise<LeaseHolder> {
    let content: string;
    try { content = await readFile(join(directory, LEASE_FILE), "utf8"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return "none"; throw error; }
    const [pidText, token] = content.trim().split(" ");
    const pid = Number.parseInt(pidText ?? "", 10);
    if (token === this.#token && pid === process.pid) return "self";
    if (!Number.isSafeInteger(pid) || pid < 1 || !token) return "none";
    const alive = pid === process.pid ? liveLeases.has(token) : processAlive(pid);
    return alive ? "other" : "none";
  }

  async acquire(directory: string): Promise<void> {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const handle = await open(join(directory, LEASE_FILE), constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
        try { await handle.writeFile(`${process.pid} ${this.#token}`); } finally { await handle.close(); }
        return;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        const holder = await this.holder(directory);
        if (holder === "self") return;
        if (holder === "other") throw new RunnerError(409, "This session is open on another of this computer's connections. Try again shortly");
        await unlink(join(directory, LEASE_FILE)).catch(() => {});
      }
    }
    throw new RunnerError(409, "This session is open on another of this computer's connections. Try again shortly");
  }

  async release(directory: string): Promise<void> {
    if (await this.holder(directory).catch(() => "none") === "self") await unlink(join(directory, LEASE_FILE)).catch(() => {});
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
