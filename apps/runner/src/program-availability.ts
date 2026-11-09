import { accessSync, constants, realpathSync, statSync } from "node:fs";

/*
 * Which of a program tool's programs the Linux sandbox finds (piki:node, piki:python and the tools defined as data), so
 * the agent knows what the host lacks before a call fails with "command not found", and its people learn how the host's
 * owner installs it (program-install.ts). The sandbox mounts only the host's /usr, with /bin a link to /usr/bin, and the
 * connector's Node.js (node-toolchain.ts), and its PATH is /usr/bin:/bin with the tool's own directories after it and
 * the connector's Node.js before it: a session's environment can't change it (validateUserEnv takes APP_ names only).
 */

/** Whether the sandbox runs `path` as the host has it: an executable file whose real path, through links, is in /usr. */
export function sandboxExecutable(path: string): boolean {
  if (!path.startsWith("/usr/")) return false;
  try {
    const real = realpathSync(path);
    if (!real.startsWith("/usr/") || !statSync(real).isFile()) return false;
    accessSync(real, constants.X_OK);
    return true;
  } catch { return false; }
}

/** The connector's Node.js as the sandbox has it: its bin directory there, and the programs in it where it is mounted (not in /usr). */
export interface SandboxNodePrograms {
  bin: string;
  /** The names mounted in `bin`; absent where `bin` is in /usr, whose files the sandbox sees as the host has them. */
  programs?: readonly string[];
}

/**
 * The programs of `tool` the sandbox doesn't find: not in the connector's Node.js (a node toolchain's), nor in /usr/bin
 * or the tool's own directories (`path`). `executable` checks a host path, as sandboxExecutable does.
 */
export function sandboxMissingPrograms(tool: { programs: readonly string[]; path: string | readonly string[]; toolchain?: "node" },
  node?: SandboxNodePrograms, executable: (path: string) => boolean = sandboxExecutable): string[] {
  const directories = ["/usr/bin", ...(typeof tool.path === "string" ? [tool.path] : tool.path)];
  return tool.programs.filter(program => {
    if (tool.toolchain === "node" && node && (node.programs ? node.programs.includes(program) : executable(`${node.bin}/${program}`))) return false;
    return !directories.some(directory => executable(`${directory}/${program}`));
  });
}
