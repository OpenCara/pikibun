import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { promisify } from "node:util";

/*
 * The extensions installed on this host (docs/design/host-extensions.md): `<state-dir>/extensions`, a private npm
 * project whose dependencies are the npm and git extensions, and `sources.json`, which lists every installed source in
 * order, local paths too. Only `pikibun extensions` on the host changes it: the control plane never names code to install.
 */

const run = promisify(execFile);

/** An exact npm version: no ranges or tags, so what loads is what the owner chose. */
const EXACT_VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const PACKAGE_NAME = /^(?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*$/;
const COMMIT = /^[0-9a-f]{40}$/;

export type ExtensionSource =
  | { kind: "npm"; package: string; version: string }
  | { kind: "git"; url: string; commit: string; package?: string }
  | { kind: "local"; path: string };

export interface InstalledSource {
  /** As the owner wrote it, normalized: `npm:<name>@<version>`, `git:<url>@<commit>` or `local:<absolute path>`. */
  source: string;
  /** npm and git: the package's name in the project's node_modules. */
  package?: string;
  /** local: the file or directory. */
  path?: string;
}

export class ExtensionStoreError extends Error {}

/** Parses what `pikibun extensions add` takes: `npm:<name>@<version>`, `git:<https url>@<commit>`, or a path. */
export function parseExtensionSource(spec: string, cwd = process.cwd()): ExtensionSource {
  if (spec.startsWith("npm:")) {
    const rest = spec.slice(4);
    const at = rest.lastIndexOf("@");
    const name = at > 0 ? rest.slice(0, at) : rest;
    const version = at > 0 ? rest.slice(at + 1) : "";
    if (!PACKAGE_NAME.test(name)) throw new ExtensionStoreError(`Invalid npm package name: ${name}`);
    if (!EXACT_VERSION.test(version)) throw new ExtensionStoreError(`Pin an exact version, such as npm:${name}@1.2.3: ranges and tags could load different code later.`);
    return { kind: "npm", package: name, version };
  }
  if (spec.startsWith("git:")) {
    const rest = spec.slice(4);
    const at = rest.lastIndexOf("@");
    const url = at > 0 ? rest.slice(0, at) : rest;
    const commit = at > 0 ? rest.slice(at + 1) : "";
    let parsed: URL;
    try { parsed = new URL(url.startsWith("https://") ? url : `https://${url}`); }
    catch { throw new ExtensionStoreError(`Invalid Git URL: ${url}`); }
    if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.search || parsed.hash) throw new ExtensionStoreError("Git extensions install from an https:// URL without credentials.");
    if (!COMMIT.test(commit)) throw new ExtensionStoreError(`Pin a full commit, such as git:${url}@<40-character commit>: branches and tags could load different code later.`);
    return { kind: "git", url: parsed.href.replace(/\/$/, ""), commit };
  }
  const path = resolve(cwd, spec);
  if (!existsSync(path)) throw new ExtensionStoreError(`No such file or directory: ${path}`);
  return { kind: "local", path };
}

export function sourceString(source: ExtensionSource): string {
  return source.kind === "npm" ? `npm:${source.package}@${source.version}` : source.kind === "git" ? `git:${source.url}@${source.commit}` : `local:${source.path}`;
}

export class ExtensionStore {
  constructor(readonly directory: string, private readonly npm: (args: string[], cwd: string, env?: Record<string, string>) => Promise<void> = defaultNpm) {}

  static forStateDir(stateDir: string): ExtensionStore { return new ExtensionStore(join(stateDir, "extensions")); }

  async list(): Promise<InstalledSource[]> {
    let text: string;
    try { text = await readFile(join(this.directory, "sources.json"), "utf8"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
    const value: unknown = JSON.parse(text);
    if (!Array.isArray(value) || value.some(item => !item || typeof item !== "object" || typeof item.source !== "string")) throw new ExtensionStoreError(`${join(this.directory, "sources.json")} is not a list of sources`);
    return value as InstalledSource[];
  }

  /** Where an installed source's code is: a package directory in the project, or the local file or directory. */
  location(installed: InstalledSource): string {
    if (installed.path) return installed.path;
    if (!installed.package || !PACKAGE_NAME.test(installed.package)) throw new ExtensionStoreError(`Invalid installed source ${installed.source}`);
    return join(this.directory, "node_modules", ...installed.package.split("/"));
  }

  async add(source: ExtensionSource, options: { allowScripts?: boolean } = {}): Promise<InstalledSource> {
    const sources = await this.list();
    const normalized = sourceString(source);
    if (source.kind === "local") {
      if (sources.some(item => item.path === source.path)) throw new ExtensionStoreError(`${source.path} is already installed.`);
      const installed = { source: normalized, path: source.path };
      await this.save([...sources, installed]);
      return installed;
    }
    await this.project();
    const spec = source.kind === "npm" ? `${source.package}@${source.version}` : `git+${source.url}.git#${source.commit}`.replace(/\.git\.git#/, ".git#");
    const before = await this.dependencies();
    // npm 12 fetches no Git dependencies unless told: only the extension itself, never Git dependencies of its own.
    await this.npm(["install", "--save-exact", "--no-audit", "--no-fund", ...(options.allowScripts ? [] : ["--ignore-scripts"]), spec], this.directory,
      source.kind === "git" ? { npm_config_allow_git: "root" } : undefined);
    const after = await this.dependencies();
    const name = source.kind === "npm" ? source.package
      : Object.keys(after).find(key => before[key] !== after[key] && after[key]!.includes(source.commit));
    if (!name || !after[name]) throw new ExtensionStoreError(`npm installed ${spec}, but its package isn't in ${this.directory}/package.json.`);
    const installed = { source: normalized, package: name };
    await this.save([...sources.filter(item => item.package !== name), installed]);
    return installed;
  }

  /** Removes the source whose package name, source or path is `name`. */
  async remove(name: string): Promise<InstalledSource> {
    const sources = await this.list();
    const path = isAbsolute(name) || name.startsWith(".") ? resolve(name) : undefined;
    const installed = sources.find(item => item.package === name || item.source === name || (path !== undefined && item.path === path));
    if (!installed) throw new ExtensionStoreError(`${name} is not installed. Run "pikibun extensions list".`);
    if (installed.package) await this.npm(["uninstall", "--no-audit", "--no-fund", "--ignore-scripts", installed.package], this.directory);
    await this.save(sources.filter(item => item !== installed));
    return installed;
  }

  private async project(): Promise<void> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const file = join(this.directory, "package.json");
    if (!(await stat(file).then(() => true, () => false))) {
      await writeFile(file, `${JSON.stringify({ name: "pikibun-host-extensions", private: true, dependencies: {} }, null, 2)}\n`, { mode: 0o600 });
    }
  }

  private async dependencies(): Promise<Record<string, string>> {
    try { return (JSON.parse(await readFile(join(this.directory, "package.json"), "utf8")) as { dependencies?: Record<string, string> }).dependencies ?? {}; }
    catch { return {}; }
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
  catch (error) {
    const stderr = (error as { stderr?: string }).stderr?.trim();
    throw new ExtensionStoreError(`npm ${args[0]} failed${stderr ? `:\n${stderr.split("\n").slice(-20).join("\n")}` : "."}`);
  }
}
