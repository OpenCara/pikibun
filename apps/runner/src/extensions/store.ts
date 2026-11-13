import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { promisify } from "node:util";
import { extensionLimits, extensionPackageKey, extensionSourceString, ExtensionSourceError, parseExtensionSourceSpec,
  type ExtensionSourceSpec } from "../../../../packages/shared/src/host-extensions.js";
import { inManagedScope, MANAGED_EXTENSION_SCOPE, managedPinKey, type ManagedExtensionPin } from "../../../../packages/shared/src/managed-extensions.js";

const run = promisify(execFile);

export type ExtensionSource = Exclude<ExtensionSourceSpec, { kind: "piki" }> | { kind: "local"; path: string };

export interface InstalledSource {
  source: string;
  directory?: string;
  package?: string;
  path?: string;
}

export interface ManagedInstall {
  source: string;
  package: string;
  version: string;
  integrity: string;
  directory: string;
}

export { ExtensionSourceError };

const DIRECTORY = /^[0-9a-f]{16}$/;
const NPM_INSTALL = ["install", "--save-exact", "--no-audit", "--no-fund", "--legacy-peer-deps"];

export const managedDirectory = (pin: ManagedExtensionPin) => createHash("sha256").update(managedPinKey(pin)).digest("hex").slice(0, 16);

export const sameManaged = (installed: ManagedInstall, pin: ManagedExtensionPin) => installed.source === pin.source && installed.package === pin.package
  && installed.version === pin.version && installed.integrity === pin.integrity && installed.directory === managedDirectory(pin);

export function parseExtensionSource(spec: string, cwd = process.cwd()): ExtensionSource {
  if (spec.startsWith("piki:")) throw new ExtensionSourceError(`${spec} is built into the connector: every host has it, and a workspace that uses it runs it. Update the connector for newer ones.`);
  if (spec.startsWith("npm:") || spec.startsWith("git:")) return parseExtensionSourceSpec(spec) as ExtensionSource;
  const path = resolve(cwd, spec);
  if (!existsSync(path)) throw new ExtensionSourceError(`No such file or directory: ${path}`);
  return { kind: "local", path };
}

export function sourceString(source: ExtensionSource): string {
  return source.kind === "local" ? `local:${source.path}` : extensionSourceString(source);
}

type Npm = (args: string[], cwd: string, env?: Record<string, string>) => Promise<void>;

export class ExtensionStore {
  #queue: Promise<unknown> = Promise.resolve();

  constructor(readonly directory: string, private readonly npm: Npm = defaultNpm) {}

  static forStateDir(stateDir: string): ExtensionStore { return new ExtensionStore(join(stateDir, "extensions")); }

  async list(): Promise<InstalledSource[]> {
    let text: string;
    try { text = await readFile(join(this.directory, "sources.json"), "utf8"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
    const value: unknown = JSON.parse(text);
    if (!Array.isArray(value) || value.some(item => !item || typeof item !== "object" || typeof item.source !== "string")) {
      throw new ExtensionSourceError(`${join(this.directory, "sources.json")} is not a list of sources`);
    }
    return value as InstalledSource[];
  }

  async listManaged(): Promise<ManagedInstall[]> {
    let text: string;
    try { text = await readFile(join(this.directory, "managed.json"), "utf8"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
    const value: unknown = JSON.parse(text);
    if (!Array.isArray(value) || value.some(item => !item || typeof item !== "object" || ["source", "package", "version", "integrity", "directory"]
      .some(key => typeof item[key] !== "string") || !DIRECTORY.test(item.directory))) {
      throw new ExtensionSourceError(`${join(this.directory, "managed.json")} is not a list of managed packages`);
    }
    return value as ManagedInstall[];
  }

  managedLocation(installed: ManagedInstall): string {
    if (!DIRECTORY.test(installed.directory) || !inManagedScope(installed.package)) throw new ExtensionSourceError(`Invalid managed package ${installed.source}`);
    return join(this.directory, "managed", installed.directory, "node_modules", ...installed.package.split("/"));
  }

  addManaged(pin: ManagedExtensionPin): Promise<ManagedInstall> {
    if (!inManagedScope(pin.package)) return Promise.reject(new ExtensionSourceError(`${pin.package} is not a ${MANAGED_EXTENSION_SCOPE} package`));
    return this.exclusive(async () => {
      const managed = await this.listManaged().catch(() => []);
      const existing = managed.find(item => sameManaged(item, pin));
      if (existing) return existing;
      const directory = managedDirectory(pin);
      const project = join(this.directory, "managed", directory);
      await rm(project, { recursive: true, force: true });
      await mkdir(project, { recursive: true, mode: 0o700 });
      await writeFile(join(project, "package.json"), `${JSON.stringify({ name: "pikibun-managed-extension", private: true, dependencies: {} }, null, 2)}\n`, { mode: 0o600 });
      try {
        await this.npm([...NPM_INSTALL, "--ignore-scripts", `${pin.package}@${pin.version}`], project);
        await checkLock(project, pin);
        const installed: ManagedInstall = { source: pin.source, package: pin.package, version: pin.version, integrity: pin.integrity, directory };
        await this.saveManaged([...managed.filter(item => item.directory !== directory), installed]);
        return installed;
      } catch (error) {
        await rm(project, { recursive: true, force: true }).catch(() => {});
        throw error;
      }
    });
  }

  removeManaged(installed: ManagedInstall): Promise<void> {
    return this.exclusive(async () => {
      const managed = await this.listManaged().catch(() => []);
      const others = managed.filter(item => item.directory !== installed.directory);
      if (others.length !== managed.length) await this.saveManaged(others);
      if (DIRECTORY.test(installed.directory)) await rm(join(this.directory, "managed", installed.directory), { recursive: true, force: true });
    });
  }

  pruneManaged(pins: readonly ManagedExtensionPin[]): Promise<ManagedInstall[]> {
    return this.exclusive(async () => {
      const managed = await this.listManaged().catch(() => []);
      const kept = managed.filter(item => pins.some(pin => sameManaged(item, pin)));
      const removed = managed.filter(item => !kept.includes(item));
      if (removed.length) await this.saveManaged(kept);
      let entries: string[] = [];
      try { entries = await readdir(join(this.directory, "managed")); } catch { }
      for (const entry of entries) {
        if (!kept.some(item => item.directory === entry)) await rm(join(this.directory, "managed", entry), { recursive: true, force: true });
      }
      return removed;
    });
  }

  location(installed: InstalledSource): string {
    if (installed.path) return installed.path;
    if (!installed.directory || !installed.package || !/^[0-9a-f]{16}$/.test(installed.directory)) throw new ExtensionSourceError(`Invalid installed source ${installed.source}`);
    return join(this.directory, "packages", installed.directory, "node_modules", ...installed.package.split("/"));
  }

  add(source: ExtensionSource, options: { allowScripts?: boolean } = {}): Promise<InstalledSource> {
    if ((source as { kind: string }).kind === "piki") return Promise.reject(new ExtensionSourceError("Pikibun extensions come with the connector: they aren't installed."));
    return this.exclusive(async () => {
      const sources = await this.list();
      const normalized = sourceString(source);
      const existing = sources.find(item => item.source === normalized);
      if (existing) return existing;
      if (sources.length >= extensionLimits.installed) throw new ExtensionSourceError(`A host has at most ${extensionLimits.installed} extensions installed.`);
      if (source.kind === "local") {
        const installed = { source: normalized, path: source.path };
        await this.save([...sources, installed]);
        return installed;
      }
      const directory = createHash("sha256").update(normalized).digest("hex").slice(0, 16);
      const project = join(this.directory, "packages", directory);
      await rm(project, { recursive: true, force: true });
      await mkdir(project, { recursive: true, mode: 0o700 });
      await writeFile(join(project, "package.json"), `${JSON.stringify({ name: "pikibun-extension", private: true, dependencies: {} }, null, 2)}\n`, { mode: 0o600 });
      const spec = source.kind === "npm" ? `${source.package}@${source.version}` : `git+${source.url}.git#${source.commit}`;
      try {
        await this.npm(["install", "--save-exact", "--no-audit", "--no-fund", "--legacy-peer-deps", ...(options.allowScripts ? [] : ["--ignore-scripts"]), spec], project,
          source.kind === "git" ? { npm_config_allow_git: "root" } : undefined);
        const dependencies = (JSON.parse(await readFile(join(project, "package.json"), "utf8")) as { dependencies?: Record<string, string> }).dependencies ?? {};
        const name = Object.keys(dependencies)[0];
        if (!name || Object.keys(dependencies).length !== 1) throw new ExtensionSourceError(`npm installed ${spec}, but not as the one package of ${project}.`);
        if (source.kind === "npm" && name !== source.package) throw new ExtensionSourceError(`npm installed ${name} for ${spec}.`);
        const installed = { source: normalized, directory, package: name };
        await this.save([...sources, installed]);
        return installed;
      } catch (error) {
        await rm(project, { recursive: true, force: true }).catch(() => {});
        throw error;
      }
    });
  }

  remove(name: string): Promise<InstalledSource> {
    if (name.startsWith("piki:")) return Promise.reject(new ExtensionSourceError(`${name} is built into the connector: it can't be removed. A workspace that doesn't want it removes it from its extensions.`));
    return this.exclusive(async () => {
      const sources = await this.list();
      const path = isAbsolute(name) || name.startsWith(".") ? resolve(name) : undefined;
      let matches = sources.filter(item => item.source === name || (path !== undefined && item.path === path));
      if (!matches.length) {
        const key = name.startsWith("npm:") || name.startsWith("git:") ? name : `npm:${name}`;
        matches = sources.filter(item => !item.path && extensionPackageKey(item.source) === key);
      }
      if (!matches.length) {
        const managed = (await this.listManaged().catch(() => [])).find(item => item.package === name || item.source === name);
        if (managed) throw new ExtensionSourceError(`${managed.package}@${managed.version} is ${managed.source}, which Pikibun manages: it can't be removed. A workspace that doesn't want it removes it from its extensions.`);
        throw new ExtensionSourceError(`${name} is not installed. Run "pikibun extensions list".`);
      }
      if (matches.length > 1) throw new ExtensionSourceError(`${name} is installed at several versions: name one, such as ${matches[0]!.source}.`);
      const installed = matches[0]!;
      await this.save(sources.filter(item => item !== installed));
      if (installed.directory) await rm(join(this.directory, "packages", installed.directory), { recursive: true, force: true });
      return installed;
    });
  }

  private exclusive<T>(work: () => Promise<T>): Promise<T> {
    const next = this.#queue.then(work, work);
    this.#queue = next.catch(() => {});
    return next;
  }

  private save(sources: InstalledSource[]): Promise<void> { return this.saveIndex("sources.json", sources); }

  private saveManaged(managed: ManagedInstall[]): Promise<void> { return this.saveIndex("managed.json", managed); }

  private async saveIndex(name: string, value: unknown[]): Promise<void> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const file = join(this.directory, name);
    await writeFile(`${file}.tmp`, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
    await rename(`${file}.tmp`, file);
  }
}

async function checkLock(project: string, pin: ManagedExtensionPin): Promise<void> {
  let lock: { packages?: Record<string, { version?: unknown; integrity?: unknown; link?: unknown }> };
  try { lock = JSON.parse(await readFile(join(project, "package-lock.json"), "utf8")); }
  catch { throw new ExtensionSourceError(`npm wrote no package-lock.json for ${pin.package}@${pin.version}, so its digest can't be checked.`); }
  const packages = lock.packages && typeof lock.packages === "object" ? Object.entries(lock.packages).filter(([path]) => path !== "") : [];
  const expected = `node_modules/${pin.package}`;
  const others = packages.filter(([path]) => path !== expected).map(([path]) => path.replace(/^node_modules\//, ""));
  if (others.length) throw new ExtensionSourceError(`npm installed ${others.slice(0, 5).join(", ")} with ${pin.package}@${pin.version}: a managed package installs nothing else.`);
  const entry = packages.find(([path]) => path === expected)?.[1];
  if (!entry || entry.link) throw new ExtensionSourceError(`npm's lock file doesn't name ${pin.package}.`);
  if (entry.version !== pin.version) throw new ExtensionSourceError(`npm installed ${pin.package}@${String(entry.version)}, not ${pin.version}.`);
  if (entry.integrity !== pin.integrity) throw new ExtensionSourceError(`${pin.package}@${pin.version}'s digest isn't the one Pikibun pinned.`);
  const dependencies = (JSON.parse(await readFile(join(project, "package.json"), "utf8")) as { dependencies?: Record<string, string> }).dependencies ?? {};
  if (Object.keys(dependencies).join() !== pin.package) throw new ExtensionSourceError(`npm installed ${pin.package}@${pin.version}, but not as the one package of ${project}.`);
}

async function defaultNpm(args: string[], cwd: string, env?: Record<string, string>): Promise<void> {
  try { await run(process.platform === "win32" ? "npm.cmd" : "npm", args, { cwd, maxBuffer: 16 * 1024 * 1024, shell: process.platform === "win32", env: { ...process.env, ...env } }); }
  catch (error) { throw npmFailure(error, args); }
}

const NPM_MISSING = [
  /^'npm(\.cmd)?' is not recognized as an internal or external command/im,
  /^(\S*sh: )?((line )?\d+: )?npm(\.cmd)?: (command )?not found/im,
  /^env: '?node'?: No such file or directory/im,
];

export function nodeInstallHint(platform: NodeJS.Platform = process.platform): string {
  return platform === "darwin" ? "Install Node.js (brew install node, or the installer from https://nodejs.org), then quit and reopen Pikibun, or restart the connector."
    : platform === "win32" ? "Install Node.js from https://nodejs.org (or winget install OpenJS.NodeJS.LTS), then quit and reopen Pikibun, or restart the connector."
    : "Install Node.js and npm (from https://nodejs.org or this system's packages), then restart the connector.";
}

export function npmFailure(error: unknown, args: readonly string[], platform: NodeJS.Platform = process.platform, path = process.env.PATH ?? ""): ExtensionSourceError {
  const failed = error as { code?: unknown; stderr?: string };
  const stderr = failed.stderr?.trim() ?? "";
  const missing = failed.code === "ENOENT" || NPM_MISSING.some(pattern => pattern.test(stderr));
  if (missing) return new ExtensionSourceError(`npm, which installs extensions from npm and Git, wasn't found on this host's PATH (${path || "empty"}). ${nodeInstallHint(platform)}`);
  return new ExtensionSourceError(`npm ${args[0]} failed${stderr ? `:\n${stderr.split("\n").slice(-20).join("\n")}` : "."}`);
}
