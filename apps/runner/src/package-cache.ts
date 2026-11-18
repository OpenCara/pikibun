import { createHash } from "node:crypto";
import { mkdirSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, join, posix, resolve, win32 } from "node:path";
import { privateEntry } from "./platform.js";

export const PACKAGE_CACHE_DIRECTORY = "package-cache";
export const SANDBOX_PACKAGE_CACHE = "/opt/pikibun/cache";
export const PACKAGE_CACHES = Object.freeze({ pip: "PIP_CACHE_DIR", npm: "npm_config_cache", uv: "UV_CACHE_DIR" } as const);

export function packageCacheRoot(stateDirectory: string): string {
  return join(stateDirectory, PACKAGE_CACHE_DIRECTORY);
}

export function ownerPackageCache(root: string, ownerId: string): string {
  return join(root, createHash("sha256").update(`pikibun-package-cache\0${ownerId}`).digest("hex").slice(0, 32));
}

export function packageCacheDirectory(path: string | undefined): string | undefined {
  if (!path || !isAbsolute(path) || resolve(path) === resolve(path, "..") || /[\x00-\x1f\x7f]/.test(path)) return undefined;
  try {
    for (const name of ["", ...Object.keys(PACKAGE_CACHES)]) mkdirSync(join(path, name), { recursive: true, mode: 0o700 });
    const real = realpathSync(path);
    if (resolve(real) === resolve(real, "..") || /[\x00-\x1f\x7f]/.test(real)) return undefined;
    const info = statSync(real);
    return info.isDirectory() && privateEntry(info) ? real : undefined;
  } catch {
    return undefined;
  }
}

export function packageCacheEnvironment(root: string, windows: boolean = process.platform === "win32"): Record<string, string> {
  const paths = windows ? win32 : posix;
  return Object.fromEntries(Object.entries(PACKAGE_CACHES).map(([name, variable]) => [variable, paths.join(root, name)]));
}
