import { randomUUID } from "node:crypto";
import { open, readFile, rename, unlink } from "node:fs/promises";
import { join } from "node:path";
import type { RunnerBinding } from "../../../packages/shared/src/types.js";
import { RunnerError } from "./protocol.js";

export const RAN_FILE = "ran.json";
const RAN_BYTES = 1024;

export const LEFT_SANDBOX = "This session last ran in the sandbox, and this host now runs without one. Start the host with its sandbox to open it, "
  + "or restart the host with --sessions-leave-sandbox to run it directly on this computer";

export interface RanRecord {
  sandboxed: boolean;
  since: string;
  leftSandboxAt?: string;
}

export function runsSandboxed(binding: { session: Pick<RunnerBinding["session"], "hostEnvironment"> }, config: { unsandboxed?: boolean }): boolean {
  return config.unsandboxed !== true && binding.session.hostEnvironment !== true;
}

export async function lastRan(directory: string): Promise<RanRecord | undefined> {
  let value: unknown;
  try {
    const text = await readFile(join(directory, RAN_FILE), "utf8");
    if (text.length > RAN_BYTES) return undefined;
    value = JSON.parse(text);
  } catch { return undefined; }
  const record = value as { sandboxed?: unknown; since?: unknown; leftSandboxAt?: unknown } | null;
  if (!record || typeof record !== "object" || typeof record.sandboxed !== "boolean" || typeof record.since !== "string") return undefined;
  return { sandboxed: record.sandboxed, since: record.since, ...(typeof record.leftSandboxAt === "string" ? { leftSandboxAt: record.leftSandboxAt } : {}) };
}

export function assertSandboxKept(last: RanRecord | undefined, sandboxed: boolean, acknowledged: boolean): void {
  if (last?.sandboxed === true && !sandboxed && !acknowledged) throw new RunnerError(422, LEFT_SANDBOX);
}

export async function recordRan(directory: string, sandboxed: boolean, last?: RanRecord, now = new Date()): Promise<{ record: RanRecord; leftSandbox: boolean }> {
  const previous = last ?? await lastRan(directory);
  if (previous && previous.sandboxed === sandboxed) return { record: previous, leftSandbox: false };
  const leftSandbox = previous?.sandboxed === true && !sandboxed;
  const record: RanRecord = { sandboxed, since: now.toISOString(), ...(leftSandbox ? { leftSandboxAt: now.toISOString() } : {}) };
  const path = join(directory, RAN_FILE);
  const temporary = `${path}.${randomUUID()}.tmp`;
  const handle = await open(temporary, "wx", 0o600);
  try { await handle.writeFile(JSON.stringify(record)); await handle.sync(); }
  finally { await handle.close(); }
  try { await rename(temporary, path); }
  catch (error) { await unlink(temporary).catch(() => {}); throw error; }
  return { record, leftSandbox };
}
