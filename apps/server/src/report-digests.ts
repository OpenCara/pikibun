import { sha256 } from '../../../packages/shared/src/crypto.js';

export const REPORT_FRESH_MS = 60 * 60_000;

interface HeldReport { digest?: string; appliedAt: number; heardAt: number; version: number }

const reports = new WeakMap<object, Map<string, HeldReport>>();
let versions = 0;

function held(db: object): Map<string, HeldReport> {
  let map = reports.get(db);
  if (!map) reports.set(db, map = new Map());
  return map;
}

export async function reportDigest(value: unknown): Promise<string> {
  return sha256(JSON.stringify(value));
}

export function reportHeld(db: object, key: string, digest: string, at = Date.now()): boolean {
  const report = held(db).get(key);
  if (!report || report.digest !== digest || at - report.appliedAt >= REPORT_FRESH_MS || at < report.appliedAt) return false;
  report.heardAt = at;
  return true;
}

export function dropReport(db: object, key: string): number {
  const map = held(db);
  const report = map.get(key);
  const version = ++versions;
  map.set(key, { appliedAt: 0, heardAt: report?.heardAt ?? 0, version });
  return version;
}

export function holdReport(db: object, key: string, digest: string, version: number, at = Date.now()): boolean {
  const map = held(db);
  const report = map.get(key);
  if (report?.version !== version) return false;
  map.set(key, { digest, appliedAt: at, heardAt: at, version });
  return true;
}

export function reportHeardAt(db: object, key: string): number | undefined {
  return held(db).get(key)?.heardAt || undefined;
}
