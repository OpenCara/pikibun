import { realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, posix } from "node:path";
import { extensionPackageKey } from "../../../../packages/shared/src/host-extensions.js";
import type { ExtensionFile } from "../../../../packages/shared/src/host-config.js";

export interface FileBind {
  source: string;
  target: string;
}

export interface ExtensionFileBinds {
  binds: FileBind[];
  missing: string[];
}

function packageOf(source: string): string | undefined {
  try { return extensionPackageKey(source); }
  catch { return undefined; }
}

export function hostFilePath(path: string, home: string = homedir()): string {
  return path.startsWith("~/") ? join(home, path.slice(2)) : path;
}

export function extensionFileBinds(files: readonly ExtensionFile[], source: string, sessionHome: string, hostHome: string = homedir()): ExtensionFileBinds {
  const key = packageOf(source);
  const binds: FileBind[] = [];
  const missing: string[] = [];
  if (!key) return { binds, missing };
  for (const file of files) {
    if (file.extension !== key) continue;
    let real: string;
    try {
      real = realpathSync(hostFilePath(file.path, hostHome));
      if (!statSync(real).isFile()) throw new Error("not a file");
    } catch {
      missing.push(file.path);
      continue;
    }
    binds.push({ source: real, target: posix.join(sessionHome, file.target) });
  }
  return { binds, missing };
}
