import { accessSync, constants, realpathSync, statSync } from "node:fs";

export function sandboxExecutable(path: string): boolean {
  if (!path.startsWith("/usr/")) return false;
  try {
    const real = realpathSync(path);
    if (!real.startsWith("/usr/") || !statSync(real).isFile()) return false;
    accessSync(real, constants.X_OK);
    return true;
  } catch { return false; }
}

export interface SandboxNodePrograms {
  bin: string;
  programs?: readonly string[];
}

export function sandboxMissingPrograms(tool: { programs: readonly string[]; path: string | readonly string[]; toolchain?: "node" },
  node?: SandboxNodePrograms, executable: (path: string) => boolean = sandboxExecutable): string[] {
  const directories = ["/usr/bin", ...(typeof tool.path === "string" ? [tool.path] : tool.path)];
  return tool.programs.filter(program => {
    if (tool.toolchain === "node" && node && (node.programs ? node.programs.includes(program) : executable(`${node.bin}/${program}`))) return false;
    return !directories.some(directory => executable(`${directory}/${program}`));
  });
}
