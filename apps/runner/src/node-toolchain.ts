import { lstatSync, readlinkSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

/*
 * The Node.js the node tool runs (piki:node, #163): the connector's own. The connector needs Node.js 24 or newer to run
 * at all, so every host that runs one has it, while what a sandbox finds in the host's /usr may be older or missing:
 * sessions spent 18 calls in 4 sessions fetching Node 24 themselves.
 *
 * Only the parts of its installation the tool runs are given to the session's commands, read-only, never the directory
 * they are in: the `node` executable, the packages its bin directory links to that are package managers (npm with npx,
 * corepack, and pnpm and yarn where installed globally), and its C headers (include/node) for native builds. Where the
 * installation is (a home's bin, ~/.local, ~/.nvm) then never decides what else of the host a session can read.
 */

/**
 * The package managers the node tool runs from the installation's lib/node_modules, by the names its bin directory
 * links, and the packages each may link into: its own, or corepack's, whose `corepack enable` links pnpm and yarn to
 * its own shims (bin/pnpm → ../lib/node_modules/corepack/dist/pnpm.js).
 */
const PACKAGE_LINKS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  npm: ["npm"], npx: ["npm"], corepack: ["corepack"], pnpm: ["pnpm", "corepack"], pnpx: ["pnpm", "corepack"], yarn: ["yarn", "corepack"],
  yarnpkg: ["yarn", "corepack"],
});

export interface NodeToolchain {
  /** Its version, such as 24.11.0. */
  version: string;
  /** The installation: the directory above bin, as found through links. */
  prefix: string;
  /** Its bin directory on the host, holding node. */
  bin: string;
  /** The packages of lib/node_modules commands get (npm, corepack, pnpm, yarn), each a directory there. */
  packages: string[];
  /** The links in bin to them, such as npm → ../lib/node_modules/npm/bin/npm-cli.js. */
  links: { name: string; target: string }[];
  /** Whether include/node, the headers native modules build against, is there. */
  headers: boolean;
}

const directory = (path: string) => { try { return statSync(path).isDirectory(); } catch { return false; } };

/**
 * The connector's own Node.js, where the connector runs on it: none in the desktop app, which runs on Electron's
 * embedded Node (the app's own executable, which can't run as plain Node), and none where its executable can't be
 * resolved or isn't an installation's bin/node.
 */
export function connectorNode(execPath = process.execPath, versions: NodeJS.ProcessVersions = process.versions): NodeToolchain | undefined {
  if (versions.electron) return undefined;
  let real: string;
  try { real = realpathSync(execPath); } catch { return undefined; }
  const bin = dirname(real);
  const prefix = dirname(bin);
  if (basename(real) !== "node" || basename(bin) !== "bin" || prefix === bin) return undefined;
  const modules = join(prefix, "lib", "node_modules");
  const packages = new Set<string>();
  const links: { name: string; target: string }[] = [];
  for (const [name, wanted] of Object.entries(PACKAGE_LINKS)) {
    const path = join(bin, name);
    try { if (!lstatSync(path).isSymbolicLink()) continue; } catch { continue; }
    let target: string;
    try { target = readlinkSync(path); } catch { continue; }
    // Only a link to a file of one of those packages, within the installation's own lib/node_modules.
    const owner = isAbsolute(target) ? undefined : wanted.find(pkg => {
      const inside = relative(join(modules, pkg), resolve(bin, target));
      return !!inside && !inside.startsWith("..") && !isAbsolute(inside) && directory(join(modules, pkg));
    });
    if (!owner) continue;
    packages.add(owner);
    links.push({ name, target });
  }
  return { version: versions.node, prefix, bin, packages: [...packages], links, headers: directory(join(prefix, "include", "node")) };
}

/**
 * What of `toolchain` steps may read and run, as host paths: its node, its packages and links, and its headers. The
 * macOS sandbox adds them to its tool roots.
 */
export function toolchainPaths(toolchain: NodeToolchain): string[] {
  return [join(toolchain.bin, "node"), ...toolchain.links.map(link => join(toolchain.bin, link.name)),
    ...toolchain.packages.map(name => join(toolchain.prefix, "lib", "node_modules", name)),
    ...(toolchain.headers ? [join(toolchain.prefix, "include", "node")] : [])];
}

/** Where the Linux sandbox puts the connector's Node.js when the sandbox doesn't already see it (in /usr). */
export const SANDBOX_NODE_DIRECTORY = "/opt/pikibun/node";

export interface SandboxNodeMount {
  /** Host paths mounted read-only at sandbox paths. */
  binds: { source: string; target: string }[];
  /** Links made in the sandbox: `path` pointing to `target`. */
  links: { path: string; target: string }[];
}

/**
 * How the Linux sandbox gives `toolchain` to shell commands: nothing to mount where it is already in what every sandbox
 * mounts (/usr), otherwise its node, packages and headers read-only below SANDBOX_NODE_DIRECTORY, laid out as they are
 * on the host, with its links; and where its bin directory is then.
 */
export function sandboxNodeMount(toolchain: NodeToolchain | undefined): { mount?: SandboxNodeMount; bin: string } | undefined {
  if (!toolchain) return undefined;
  if (toolchain.bin === "/usr/bin" || toolchain.bin.startsWith("/usr/")) return { bin: toolchain.bin };
  if (toolchain.prefix === sep || ["/lib", "/lib64"].some(path => toolchain.prefix === path || toolchain.prefix.startsWith(`${path}/`))) return undefined;
  const at = (...parts: string[]) => [SANDBOX_NODE_DIRECTORY, ...parts].join("/");
  return {
    bin: at("bin"),
    mount: {
      binds: [
        { source: join(toolchain.bin, "node"), target: at("bin", "node") },
        ...toolchain.packages.map(name => ({ source: join(toolchain.prefix, "lib", "node_modules", name), target: at("lib", "node_modules", name) })),
        ...(toolchain.headers ? [{ source: join(toolchain.prefix, "include", "node"), target: at("include", "node") }] : []),
      ],
      links: toolchain.links.map(link => ({ path: at("bin", link.name), target: link.target.split(sep).join("/") })),
    },
  };
}
