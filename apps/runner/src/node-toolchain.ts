import { realpathSync } from "node:fs";
import { dirname, relative, sep } from "node:path";

/*
 * The Node.js the node tool runs (piki:node, #163): the connector's own. The connector needs Node.js 24 or newer to run
 * at all, so every host that runs one has it, while what a sandbox finds in the host's /usr may be older or missing:
 * sessions spent 18 calls in 4 sessions fetching Node 24 themselves. Its installation (the directory holding bin/node,
 * and npm, npx and corepack beside it in lib/node_modules) is given to the session's commands read-only, and the node
 * tool looks there first.
 */

export interface NodeToolchain {
  /** Its version, such as 24.11.0. */
  version: string;
  /** The installation: the directory above bin. */
  prefix: string;
  /** Its bin directory on the host, holding node (and, in most installations, npm, npx and corepack). */
  bin: string;
}

/**
 * The connector's own Node.js, where the connector runs on it: none in the desktop app, which runs on Electron's
 * embedded Node (the app's own executable, which can't run as plain Node), and none where its executable can't be
 * resolved.
 */
export function connectorNode(execPath = process.execPath, versions: NodeJS.ProcessVersions = process.versions): NodeToolchain | undefined {
  if (versions.electron) return undefined;
  let real: string;
  try { real = realpathSync(execPath); } catch { return undefined; }
  const bin = dirname(real);
  const prefix = dirname(bin);
  if (prefix === bin) return undefined;
  return { version: versions.node, prefix, bin };
}

/** Where the Linux sandbox mounts the connector's Node.js when the sandbox doesn't already see it (in /usr). */
export const SANDBOX_NODE_DIRECTORY = "/opt/pikibun/node";

/**
 * How the Linux sandbox gives `toolchain` to shell commands: nothing to mount where it is already in what every sandbox
 * mounts (/usr), otherwise its installation read-only at SANDBOX_NODE_DIRECTORY; and where its bin directory is then.
 */
export function sandboxNodeMount(toolchain: NodeToolchain | undefined): { mount?: { source: string; target: string }; bin: string } | undefined {
  if (!toolchain) return undefined;
  if (toolchain.bin === "/usr/bin" || toolchain.bin.startsWith("/usr/")) return { bin: toolchain.bin };
  // An installation at the root itself (/bin/node) or in the runtime mounts is either visible already or nothing to give.
  if (toolchain.prefix === sep || ["/lib", "/lib64"].some(path => toolchain.prefix === path || toolchain.prefix.startsWith(`${path}/`))) return undefined;
  const inside = relative(toolchain.prefix, toolchain.bin).split(sep).join("/");
  return { mount: { source: toolchain.prefix, target: SANDBOX_NODE_DIRECTORY }, bin: `${SANDBOX_NODE_DIRECTORY}/${inside}` };
}
