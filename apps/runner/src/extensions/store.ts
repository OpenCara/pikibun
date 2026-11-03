import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { promisify } from "node:util";
import { extensionLimits, extensionPackageKey, extensionSourceString, ExtensionSourceError, parseExtensionSourceSpec,
  type ExtensionSourceSpec } from "../../../../packages/shared/src/host-extensions.js";

/*
 * The extensions installed on this host (docs/design/host-extensions.md), in `<state-dir>/extensions`:
 * - `sources.json`: every installed source, in order.
 * - `packages/<digest>/`: one private npm project per npm or Git source, so versions sit side by side and a new one loads
 *   without restarting the connector (Node caches modules by path).
 * Local paths (dev extensions) load in place. `pikibun extensions` on the host and, unless the connector runs with
 * `--no-remote-installs`, its owner in Pikibun change it.
 */

const run = promisify(execFile);

/** What a host installs: an npm or Git source, or a local path. Pikibun extensions come with the connector. */
export type ExtensionSource = Exclude<ExtensionSourceSpec, { kind: "piki" }> | { kind: "local"; path: string };

export interface InstalledSource {
  /** Normalized: `npm:<name>@<version>`, `git:<url>@<commit>` or `local:<absolute path>`. */
  source: string;
  /** npm and Git: the project directory, under `packages/`, and the package's name in its node_modules. */
  directory?: string;
  package?: string;
  /** Dev extensions: the file or directory. */
  path?: string;
}

export { ExtensionSourceError };

/** What `pikibun extensions add` takes: `npm:<name>@<version>`, `git:<https url>@<commit>`, or a path (a dev extension). */
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

  /** Where an installed source's code is: its package in its project, or the dev extension's file or directory. */
  location(installed: InstalledSource): string {
    if (installed.path) return installed.path;
    if (!installed.directory || !installed.package || !/^[0-9a-f]{16}$/.test(installed.directory)) throw new ExtensionSourceError(`Invalid installed source ${installed.source}`);
    return join(this.directory, "packages", installed.directory, "node_modules", ...installed.package.split("/"));
  }

  /** Installs `source`; one already installed is left as it is. Another version of the same package stays too. */
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
        // No install scripts unless asked, no peer dependencies (the loader provides Pi's own packages, as Pi does), and
        // no Git dependencies of the extension's own (npm 12 refuses them unless told; `root` allows the extension itself).
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

  /**
   * Removes the source named `name`: its normalized source, a dev extension's path, or a package name (`npm:<name>` or
   * the bare name), which must then match one installed version.
   */
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
      if (!matches.length) throw new ExtensionSourceError(`${name} is not installed. Run "pikibun extensions list".`);
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

  private async save(sources: InstalledSource[]): Promise<void> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const file = join(this.directory, "sources.json");
    await writeFile(`${file}.tmp`, `${JSON.stringify(sources, null, 2)}\n`, { mode: 0o600 });
    await rename(`${file}.tmp`, file);
  }
}

async function defaultNpm(args: string[], cwd: string, env?: Record<string, string>): Promise<void> {
  try { await run(process.platform === "win32" ? "npm.cmd" : "npm", args, { cwd, maxBuffer: 16 * 1024 * 1024, shell: process.platform === "win32", env: { ...process.env, ...env } }); }
  catch (error) { throw npmFailure(error, args); }
}

/** How to install Node.js, which brings npm, on this platform. */
export function nodeInstallHint(platform: NodeJS.Platform = process.platform): string {
  return platform === "darwin" ? "Install Node.js (brew install node, or the installer from https://nodejs.org), then restart Pikibun or the connector."
    : platform === "win32" ? "Install Node.js from https://nodejs.org (or winget install OpenJS.NodeJS.LTS), then restart Pikibun or the connector."
    : "Install Node.js and npm (from https://nodejs.org or this system's packages), then restart the connector.";
}

/**
 * Why npm failed, as the owner reads it: npm missing from PATH (a Mac app started from Finder sees only the system's
 * PATH; Windows' shell answers 127 or "is not recognized") says so and how to get it, rather than an empty failure.
 */
export function npmFailure(error: unknown, args: readonly string[], platform: NodeJS.Platform = process.platform, path = process.env.PATH ?? ""): ExtensionSourceError {
  const failed = error as { code?: unknown; stderr?: string };
  const stderr = failed.stderr?.trim() ?? "";
  const missing = failed.code === "ENOENT" || failed.code === 127 || /is not recognized as an internal or external command|npm: (command )?not found|env: node: No such file/i.test(stderr);
  if (missing) return new ExtensionSourceError(`npm, which installs extensions from npm and Git, wasn't found on this host's PATH (${path || "empty"}). ${nodeInstallHint(platform)}`);
  return new ExtensionSourceError(`npm ${args[0]} failed${stderr ? `:\n${stderr.split("\n").slice(-20).join("\n")}` : "."}`);
}
