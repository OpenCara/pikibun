import { mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises";
import { glob } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, isAbsolute, join, relative, resolve } from "node:path";
import { createEventBus, createExtensionRuntime, type Extension as PiExtension, type ExtensionFactory, type ExtensionRuntime,
  type LoadExtensionsResult } from "@earendil-works/pi-coding-agent";
import type { EventBus } from "@earendil-works/pi-coding-agent";
import { extensionLimits, type ExtensionModuleSummary, type InstalledExtension } from "../../../../packages/shared/src/host-extensions.js";
import { retiredToolNames, toolNames } from "../../../../packages/shared/src/types.js";
import type { ExtensionStore, InstalledSource } from "./store.js";
import { builtinModulePath, connectorBuiltins, type BuiltinExtension } from "./builtin/index.js";

/*
 * Loads Pi extensions through pi-coding-agent's own loader (docs/design/host-extensions.md): TypeScript, `pi` manifests and
 * the modules Pi provides its extensions (pi-coding-agent, pi-ai, pi-tui, typebox) work as they do in Pi. The connector
 * loads every installed source once to report what it offers; each session loads the ones it runs with again, so their
 * module state is the session's own (adapter.ts).
 */

/** Pi events Pikibun runs (adapter.ts). Others an extension handles are reported as ignored. */
export const supportedEvents = new Set(["session_start", "session_shutdown", "before_agent_start", "agent_start", "agent_end", "agent_settled",
  "turn_start", "turn_end", "message_end", "tool_call", "tool_result", "tool_execution_start", "tool_execution_end", "context",
  "context_with_system", "agent_before_settle", "session_before_compact"]);

interface PiLoader {
  loadExtensions(paths: string[], cwd: string, eventBus?: EventBus, runtime?: ExtensionRuntime): Promise<LoadExtensionsResult>;
  loadExtensionFromFactory(factory: ExtensionFactory, cwd: string, eventBus: EventBus, runtime: ExtensionRuntime, extensionPath?: string): Promise<PiExtension>;
}

let internals: Promise<PiLoader> | undefined;
/**
 * pi-coding-agent's `loadExtensions`, which loads the given files only. Its exported `discoverAndLoadExtensions` also
 * loads `<cwd>/.pi/extensions`, which in a session's worktree would be the repository's code, so it is never used.
 */
export function piLoader(): Promise<PiLoader> {
  internals ??= import(new URL("./core/extensions/loader.js", import.meta.resolve("@earendil-works/pi-coding-agent")).href) as Promise<PiLoader>;
  return internals;
}

const ENTRY = /\.(?:ts|js|mts|mjs)$/;
const isFile = (path: string) => stat(path).then(found => found.isFile(), () => false);
const isDirectory = (path: string) => stat(path).then(found => found.isDirectory(), () => false);

/** The extension modules of a package directory, as Pi finds them: its `pi.extensions`, its `extensions/` directory, or its index. */
async function packageEntries(directory: string, requireManifest: boolean): Promise<{ files: string[]; name?: string; version?: string; description?: string }> {
  let manifest: { name?: unknown; version?: unknown; description?: unknown; keywords?: unknown; pi?: { extensions?: unknown } } = {};
  try { manifest = JSON.parse(await readFile(join(directory, "package.json"), "utf8")); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new Error("Its package.json can't be read"); }
  const about = { ...(typeof manifest.name === "string" ? { name: manifest.name } : {}), ...(typeof manifest.version === "string" ? { version: manifest.version } : {}),
    ...(typeof manifest.description === "string" ? { description: manifest.description.slice(0, extensionLimits.text) } : {}) };
  const files: string[] = [];
  const declared = manifest.pi?.extensions;
  if (declared !== undefined) {
    if (!Array.isArray(declared) || declared.some(item => typeof item !== "string")) throw new Error(`"pi.extensions" in its package.json lists module paths`);
    const excluded = new Set<string>();
    for (const pattern of declared as string[]) {
      const negated = pattern.startsWith("!");
      const matches: string[] = [];
      if (/[*?[{]/.test(pattern)) for await (const match of glob(negated ? pattern.slice(1) : pattern, { cwd: directory })) matches.push(match);
      else matches.push(negated ? pattern.slice(1) : pattern);
      for (const match of matches) {
        const file = resolve(directory, match);
        if (relative(directory, file).startsWith("..") || isAbsolute(relative(directory, file))) throw new Error(`"pi.extensions" names ${pattern}, outside the package`);
        if (negated) excluded.add(file);
        else if (await isDirectory(file)) files.push(...(await directoryEntries(file)));
        else if (await isFile(file)) files.push(file);
      }
    }
    return { files: files.filter(file => !excluded.has(file)), ...about };
  }
  if (await isDirectory(join(directory, "extensions"))) return { files: await directoryEntries(join(directory, "extensions")), ...about };
  if (requireManifest) throw new Error(`${about.name ?? basename(directory)} isn't a Pi extension package: its package.json has no "pi": { "extensions": [...] } and it has no extensions/ directory`);
  for (const index of ["index.ts", "index.js"]) if (await isFile(join(directory, index))) return { files: [join(directory, index)], ...about };
  return { files, ...about };
}

/** Pi's discovery in a directory: its .ts/.js files, and subdirectories with an index. */
async function directoryEntries(directory: string): Promise<string[]> {
  const files: string[] = [];
  for (const item of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    if (item.isFile() && ENTRY.test(item.name) && !item.name.endsWith(".d.ts")) files.push(join(directory, item.name));
    else if (item.isDirectory()) {
      for (const index of ["index.ts", "index.js"]) {
        if (await isFile(join(directory, item.name, index))) { files.push(join(directory, item.name, index)); break; }
      }
    }
  }
  return files;
}

/** An installed source and its extension modules. */
export interface LoadedSource {
  installed: InstalledSource;
  /** Where its paths in the summary are relative to. */
  root: string;
  /** Its modules' files; for a built-in extension, its module's path (`<builtin:name>`), whose factory is `factories`'. */
  files: string[];
  factories?: { path: string; factory: ExtensionFactory }[];
  summary: InstalledExtension;
}

/**
 * Runs the factories of `loaded`'s modules, as Pi's loader does when it loads them: from their files, or a built-in
 * extension's from the connector's own code.
 */
export async function loadSource(loaded: Pick<LoadedSource, "files" | "factories">, cwd: string, eventBus: EventBus = createEventBus(),
  runtime: ExtensionRuntime = createExtensionRuntime()): Promise<LoadExtensionsResult> {
  const loader = await piLoader();
  if (!loaded.factories) return loader.loadExtensions(loaded.files, cwd, eventBus, runtime);
  const result: LoadExtensionsResult = { extensions: [], errors: [], runtime } as unknown as LoadExtensionsResult;
  for (const { path, factory } of loaded.factories) {
    try { result.extensions.push(await loader.loadExtensionFromFactory(factory, cwd, eventBus, runtime, path)); }
    catch (error) { result.errors.push({ path, error: `Failed to load extension: ${message(error)}` }); }
  }
  return result;
}

/** A built-in extension as an installed source, which every connector of this version has. */
async function loadBuiltin(builtin: BuiltinExtension, cwd: string): Promise<LoadedSource> {
  const path = builtinModulePath(builtin.info.name);
  const factories = [{ path, factory: builtin.factory }];
  const summary: InstalledExtension = { source: builtin.info.source, dev: false, name: builtin.info.title, description: builtin.info.description, modules: [] };
  try { summary.modules = summarizeModules("", [path], await loadSource({ files: [path], factories }, cwd), new Set()); }
  catch (error) { summary.error = message(error); }
  return { installed: { source: builtin.info.source }, root: "", files: [path], factories, summary };
}

const message = (error: unknown) => (error instanceof Error ? error.message : String(error)).slice(0, extensionLimits.text);

/**
 * What one source's Pi extensions offer Pikibun, from what loading them registered. A tool named like one of Pikibun's
 * own (not a retired one), or like one an earlier module of the source offers (`taken`), is ignored.
 */
export function summarizeModules(root: string, files: string[], result: LoadExtensionsResult, taken: Set<string>): ExtensionModuleSummary[] {
  const modules: ExtensionModuleSummary[] = [];
  const providers = [...result.runtime.pendingProviderRegistrations.map(item => ({ path: item.extensionPath, name: item.name })),
    ...result.runtime.pendingNativeProviderRegistrations.map(item => ({ path: item.extensionPath, name: item.provider.id }))];
  const models = result.runtime.pendingVirtualModelRegistrations;
  const servers = result.runtime.mcpServers.list() as { name: string; extensionPath?: string }[];
  for (const file of files.slice(0, extensionLimits.modulesPerSource)) {
    const path = relative(root, file) || basename(file);
    const extension: PiExtension | undefined = result.extensions.find(item => item.path === file || item.resolvedPath === file);
    const error = result.errors.find(item => item.path === file || resolve(item.path) === file)?.error;
    if (!extension) {
      modules.push({ path, tools: [], events: [], flags: [], noops: [], ignored: [], error: message(error ?? "It didn't load") });
      continue;
    }
    const tools: ExtensionModuleSummary["tools"] = [];
    const ignored: string[] = [];
    for (const [name, tool] of extension.tools) {
      if ((toolNames as readonly string[]).includes(name) && !(retiredToolNames as readonly string[]).includes(name)) { ignored.push(`tool ${name} (one of Pikibun's own)`); continue; }
      if (taken.has(name)) { ignored.push(`tool ${name} (another module's)`); continue; }
      if (tools.length >= extensionLimits.toolsPerModule) { ignored.push(`tool ${name} (too many tools)`); continue; }
      taken.add(name);
      tools.push({ name, description: String(tool.definition.description ?? "").slice(0, extensionLimits.toolDescription) });
    }
    const events = [...extension.handlers.keys()];
    ignored.push(...events.filter(event => !supportedEvents.has(event)).map(event => `${event} event`));
    ignored.push(...providers.filter(item => item.path === file).map(item => `provider ${item.name}`));
    ignored.push(...models.filter(item => item.extensionPath === file).map(item => `model ${item.definition.provider}/${item.definition.id}`));
    ignored.push(...servers.filter(item => item.extensionPath === file).map(item => `MCP server ${item.name}`));
    const noops = [...[...extension.commands.keys()].map(name => `/${name}`), ...[...extension.shortcuts.keys()].map(key => `shortcut ${key}`),
      ...(extension.messageRenderers.size || extension.entryRenderers?.size || extension.toolRenderers?.length || extension.markdownTransformer ? ["renderers"] : [])];
    const flags = [...extension.flags.values()].slice(0, extensionLimits.flagsPerModule).map(flag => ({ name: flag.name, type: flag.type,
      ...(flag.description ? { description: flag.description.slice(0, extensionLimits.text) } : {}), ...(flag.default !== undefined ? { default: flag.default } : {}) }));
    modules.push({ path, tools, events: events.filter(event => supportedEvents.has(event)), flags,
      noops: noops.slice(0, 256).map(item => item.slice(0, 128)), ignored: ignored.slice(0, 256).map(item => item.slice(0, 128)) });
  }
  return modules;
}

/**
 * Loads the connector's built-in extensions (`builtins`), then every installed source, to learn what they offer, with
 * `cwd` an empty directory: each module's factory runs, as Pi runs it when it starts.
 */
export async function loadInstalled(store: ExtensionStore, builtins: readonly BuiltinExtension[] = connectorBuiltins): Promise<LoadedSource[]> {
  const loaded: LoadedSource[] = [];
  let installed: InstalledSource[] = [];
  let failure: unknown;
  try { installed = await store.list(); }
  catch (error) { failure = error; }
  if (failure) process.stderr.write(`Host extensions: ${message(failure)}\n`);
  const { loadExtensions } = await piLoader();
  const cwd = await mkdtemp(join(tmpdir(), "pikibun-extensions-"));
  try {
    for (const builtin of builtins) loaded.push(await loadBuiltin(builtin, cwd));
    for (const source of installed) {
      const dev = source.source.startsWith("local:");
      const location = store.location(source);
      const root = (await isDirectory(location)) ? location : join(location, "..");
      const summary: InstalledExtension = { source: source.source, dev, modules: [] };
      let files: string[] = [];
      try {
        if (await isDirectory(location)) {
          const entries = await packageEntries(location, !dev);
          files = entries.files;
          Object.assign(summary, entries.name ? { name: entries.name } : {}, entries.version ? { version: entries.version } : {}, entries.description ? { description: entries.description } : {});
          if (!files.length) throw new Error("It has no extension modules");
        } else if (await isFile(location) && ENTRY.test(location)) files = [location];
        else throw new Error(`${location} is not an extension file or package`);
        const result = await loadExtensions(files, cwd, undefined, createExtensionRuntime());
        // Tools of different sources may share a name: a session that runs both keeps the first (SessionExtensions).
        summary.modules = summarizeModules(root, files, result, new Set());
      } catch (error) {
        summary.error = message(error);
      }
      loaded.push({ installed: source, root, files, summary });
    }
  } finally {
    await rm(cwd, { recursive: true, force: true }).catch(() => {});
  }
  return loaded;
}
