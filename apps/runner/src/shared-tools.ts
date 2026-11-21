import { realpathSync, statSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { isAbsolute, join, posix, resolve, sep, win32 } from "node:path";
import { privateEntry } from "./platform.js";

export const SHARED_TOOLS_DIRECTORY = "tools";
export const SANDBOX_SHARED_TOOLS = "/opt/pikibun/tools";
const AZURE_EXTENSIONS = "azure-cli-extensions";

export function sharedToolsPath(stateDirectory: string): string {
  return join(stateDirectory, SHARED_TOOLS_DIRECTORY);
}

export async function prepareSharedTools(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
}

export function sharedToolsDirectory(path: string | undefined): string | undefined {
  if (!path || !isAbsolute(path) || resolve(path) === sep || /[\x00-\x1f\x7f]/.test(path)) return undefined;
  try {
    const real = realpathSync(path);
    if (resolve(real) === resolve(real, "..") || /[\x00-\x1f\x7f]/.test(real)) return undefined;
    const info = statSync(real);
    return info.isDirectory() && privateEntry(info, 0o022) ? real : undefined;
  } catch {
    return undefined;
  }
}

export function sharedToolsEnvironment(root: string, path: string, windows: boolean = process.platform === "win32"): Record<string, string> {
  const paths = windows ? win32 : posix;
  return {
    PIKIBUN_TOOLS: root,
    PATH: `${path}${paths.delimiter}${paths.join(root, "bin")}`,
    AZURE_EXTENSION_SYS_DIR: paths.join(root, AZURE_EXTENSIONS),
  };
}
