import { lstatSync, readlinkSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

const PACKAGE_LINKS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  npm: ["npm"], npx: ["npm"], corepack: ["corepack"], pnpm: ["pnpm", "corepack"], pnpx: ["pnpm", "corepack"], yarn: ["yarn", "corepack"],
  yarnpkg: ["yarn", "corepack"],
});

export interface NodeToolchain {
  version: string;
  prefix: string;
  bin: string;
  packages: string[];
  links: { name: string; target: string }[];
  headers: boolean;
}

const directory = (path: string) => { try { return statSync(path).isDirectory(); } catch { return false; } };

export function connectorNode(execPath = process.execPath, versions: NodeJS.ProcessVersions = process.versions): NodeToolchain | undefined {
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

export function toolchainPaths(toolchain: NodeToolchain): string[] {
  return [join(toolchain.bin, "node"), ...toolchain.links.map(link => join(toolchain.bin, link.name)),
    ...toolchain.packages.map(name => join(toolchain.prefix, "lib", "node_modules", name)),
    ...(toolchain.headers ? [join(toolchain.prefix, "include", "node")] : [])];
}

export const SANDBOX_NODE_DIRECTORY = "/opt/pikibun/node";

export interface SandboxNodeMount {
  binds: { source: string; target: string }[];
  links: { path: string; target: string }[];
}

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
