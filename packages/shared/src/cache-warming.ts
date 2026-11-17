export const cacheWarmingModes = ["idle", "streaming", "off"] as const;
export type CacheWarmingMode = (typeof cacheWarmingModes)[number];
export const defaultCacheWarmingMode: CacheWarmingMode = "idle";

export interface CacheWarmingSettings {
  mode: CacheWarmingMode;
}

export function isCacheWarmingMode(value: unknown): value is CacheWarmingMode {
  return typeof value === "string" && (cacheWarmingModes as readonly string[]).includes(value);
}
