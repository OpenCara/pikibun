export const cacheWarmingModes = ["idle", "streaming", "off"] as const;
export type CacheWarmingMode = (typeof cacheWarmingModes)[number];
export const defaultCacheWarmingMode: CacheWarmingMode = "idle";

export interface CacheWarmingSettings {
  mode: CacheWarmingMode;
}

export interface SessionCacheWarming {
  mode: CacheWarmingMode;
  child: boolean;
}

export function sessionCacheWarmingMode(workspace: CacheWarmingMode, host: { cacheWarming: boolean }): CacheWarmingMode {
  return host.cacheWarming ? workspace : "off";
}

export function isCacheWarmingMode(value: unknown): value is CacheWarmingMode {
  return typeof value === "string" && (cacheWarmingModes as readonly string[]).includes(value);
}
