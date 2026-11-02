import { readdir, readFile, stat } from "node:fs/promises";
import { basename, extname, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { Type, type TSchema } from "@earendil-works/pi-ai";
import { HOST_EXTENSION_NAME, HOST_EXTENSION_TOOL_NAME, hostExtensionEvents, hostExtensionLimits, isJsonValue, type HostExtensionEvent,
  type HostExtensionSummary, type JsonObject } from "../../../../packages/shared/src/host-extensions.js";
import { toolNames } from "../../../../packages/shared/src/types.js";
import type { ExtensionHandlers, ExtensionTool, PikibunExtensionAPI, PikibunExtensionFactory } from "./api.js";
import type { ExtensionStore, InstalledSource } from "./store.js";

/*
 * Loads the host's installed extensions once, when the connector starts: each module's default export is a factory
 * (PikibunExtensionAPI). Running it once with a recording API tells what the extension offers, which the connector
 * advertises; each session runs it again for its own registrations (adapter.ts). An extension that fails to load is
 * advertised with its error and never runs.
 */

const ENTRY = /\.(?:m?js|ts|mts)$/;
const FACTORY_TIMEOUT_MS = 10_000;

/** What one run of a factory registered. */
export interface Registrations {
  description?: string;
  settingsSchema?: TSchema;
  tools: ExtensionTool[];
  handlers: { [Event in HostExtensionEvent]?: ExtensionHandlers[Event][] };
}

export interface LoadedExtension {
  summary: HostExtensionSummary;
  /** Absent for one that failed to load. */
  factory?: PikibunExtensionFactory;
}

/** Runs `factory` with an API that records what it registers. Throws what the extension did wrong. */
export async function register(name: string, factory: PikibunExtensionFactory, settings: () => unknown = () => ({}),
  warn: (message: string) => void = message => { process.stderr.write(`Host extension ${name}: ${message}\n`); }): Promise<Registrations> {
  const registrations: Registrations = { tools: [], handlers: {} };
  let open = true;
  // Late registrations are ignored rather than thrown: a throw from a timer would stop the connector.
  const late = () => {
    if (open) return false;
    warn("registered something after its factory returned; it was ignored. Register everything while the factory runs.");
    return true;
  };
  const api: PikibunExtensionAPI = {
    name,
    Type,
    describe(description) {
      if (late()) return;
      if (typeof description !== "string") throw new Error("describe() takes a string");
      registrations.description = description.slice(0, hostExtensionLimits.description);
    },
    settings(schema) {
      if (late()) return settings as never;
      if (registrations.settingsSchema) throw new Error("settings() is called once");
      if (!schema || typeof schema !== "object" || (schema as { type?: unknown }).type !== "object") throw new Error("settings() takes an object schema, such as pi.Type.Object({...})");
      registrations.settingsSchema = schema;
      return settings as never;
    },
    registerTool(tool) {
      if (late()) return;
      if (!tool || typeof tool !== "object" || typeof tool.name !== "string" || !HOST_EXTENSION_TOOL_NAME.test(tool.name)) {
        throw new Error(`Tool names are letters, digits, _ and -, starting with a letter: ${String(tool?.name)}`);
      }
      if ((toolNames as readonly string[]).includes(tool.name)) throw new Error(`${tool.name} is one of Pikibun's own tools`);
      if (registrations.tools.some(other => other.name === tool.name)) throw new Error(`${tool.name} is registered twice`);
      if (typeof tool.description !== "string" || !tool.description.trim()) throw new Error(`${tool.name} needs a description`);
      if (!tool.parameters || typeof tool.parameters !== "object") throw new Error(`${tool.name} needs parameters, such as pi.Type.Object({})`);
      if (typeof tool.execute !== "function") throw new Error(`${tool.name} needs execute()`);
      if (tool.replay !== undefined && tool.replay !== "safe" && tool.replay !== "unsafe") throw new Error(`${tool.name}: replay is safe or unsafe`);
      if (tool.executionMode !== undefined && tool.executionMode !== "parallel" && tool.executionMode !== "sequential") throw new Error(`${tool.name}: executionMode is parallel or sequential`);
      if (registrations.tools.length >= hostExtensionLimits.toolsPerExtension) throw new Error(`An extension registers at most ${hostExtensionLimits.toolsPerExtension} tools`);
      registrations.tools.push(tool as unknown as ExtensionTool);
    },
    on(event, handler) {
      if (late()) return;
      if (!hostExtensionEvents.includes(event)) {
        throw new Error(`Pikibun has no "${String(event)}" event; it offers ${hostExtensionEvents.join(", ")}`);
      }
      if (typeof handler !== "function") throw new Error(`The ${event} handler must be a function`);
      ((registrations.handlers[event] ??= []) as unknown[]).push(handler);
    },
  };
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      Promise.resolve().then(() => factory(api)),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`The factory didn't return within ${FACTORY_TIMEOUT_MS / 1000} seconds`)), FACTORY_TIMEOUT_MS); }),
    ]);
  } finally {
    clearTimeout(timer);
    open = false;
  }
  return registrations;
}

/** What `registrations` offer, as the connector advertises them. */
export function summarize(name: string, source: string, version: string | undefined, registrations: Registrations): HostExtensionSummary {
  let settingsSchema: JsonObject | undefined;
  if (registrations.settingsSchema) {
    // TypeBox marks its schemas with symbols, which JSON leaves out; what's left is JSON Schema.
    const schema: unknown = JSON.parse(JSON.stringify(registrations.settingsSchema));
    if (!isJsonValue(schema) || new TextEncoder().encode(JSON.stringify(schema)).length > hostExtensionLimits.schemaBytes) {
      throw new Error(`The settings schema is over ${hostExtensionLimits.schemaBytes / 1024} KB`);
    }
    settingsSchema = schema as JsonObject;
  }
  return {
    name, source, ...(version ? { version } : {}), ...(registrations.description ? { description: registrations.description } : {}),
    tools: registrations.tools.map(tool => ({ name: tool.name, description: tool.description.slice(0, hostExtensionLimits.toolDescription) })),
    events: hostExtensionEvents.filter(event => registrations.handlers[event]?.length),
    ...(settingsSchema ? { settingsSchema } : {}),
  };
}

interface Entry { name: string; file: string; source: string; version?: string }

/** The extension modules of an installed source, with their names. */
async function entries(store: ExtensionStore, installed: InstalledSource): Promise<Entry[]> {
  const location = store.location(installed);
  const info = await stat(location);
  if (info.isFile()) {
    if (!ENTRY.test(location)) throw new Error(`${location} is not a .js, .mjs or .ts file`);
    return [{ name: entryName(basename(location, extname(location))), file: location, source: installed.source }];
  }
  let manifest: { name?: unknown; version?: unknown; pikibun?: { extensions?: unknown } } = {};
  try { manifest = JSON.parse(await readFile(join(location, "package.json"), "utf8")); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new Error(`Its package.json can't be read`); }
  const packageName = typeof manifest.name === "string" ? manifest.name : entryName(basename(location));
  const version = typeof manifest.version === "string" ? manifest.version : undefined;
  let files: string[];
  if (manifest.pikibun?.extensions !== undefined) {
    const declared = manifest.pikibun.extensions;
    if (!Array.isArray(declared) || !declared.length || declared.some(item => typeof item !== "string")) throw new Error(`"pikibun.extensions" in its package.json lists module paths`);
    files = (declared as string[]).map(file => resolve(location, file));
    if (files.some(file => relative(location, file).startsWith("..") || !ENTRY.test(file))) throw new Error(`"pikibun.extensions" names modules inside the package: .js, .mjs or .ts files`);
  } else if (installed.package) {
    // An npm or Git package says it is one, so a package that isn't (its default export some other function) never runs.
    throw new Error(`${packageName} isn't a Pikibun extension package: its package.json has no "pikibun": { "extensions": [...] }`);
  } else if (await stat(join(location, "extensions")).then(found => found.isDirectory(), () => false)) {
    files = [];
    for (const item of (await readdir(join(location, "extensions"), { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      if (item.isFile() && ENTRY.test(item.name) && !item.name.endsWith(".d.ts")) files.push(join(location, "extensions", item.name));
      else if (item.isDirectory()) {
        for (const index of ["index.js", "index.mjs", "index.ts"]) {
          if (await stat(join(location, "extensions", item.name, index)).then(found => found.isFile(), () => false)) { files.push(join(location, "extensions", item.name, index)); break; }
        }
      }
    }
  } else {
    files = [];
    for (const index of ["index.js", "index.mjs", "index.ts"]) {
      if (await stat(join(location, index)).then(found => found.isFile(), () => false)) { files.push(join(location, index)); break; }
    }
  }
  if (!files.length) throw new Error(`No extension modules: list them under "pikibun": { "extensions": [...] } in its package.json, put them in extensions/, or add index.js`);
  return files.map(file => ({
    name: files.length === 1 ? packageName : `${packageName}/${entryName(basename(file).replace(ENTRY, "") === "index" ? basename(join(file, "..")) : basename(file).replace(ENTRY, ""))}`,
    file, source: installed.source, ...(version ? { version } : {}),
  }));
}

function entryName(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9._~-]+/g, "-").replace(/^[^a-z0-9]+/, "") || "extension";
}

const message = (error: unknown) => (error instanceof Error ? error.message : String(error)).slice(0, hostExtensionLimits.error);

/**
 * Loads every installed extension: its module, and one run of its factory to record what it offers. Names and tool
 * names must be unique on the host; a later extension that repeats one fails to load.
 */
export async function loadExtensions(store: ExtensionStore, importModule: (file: string) => Promise<unknown> = file => import(pathToFileURL(file).href)): Promise<LoadedExtension[]> {
  const loaded: LoadedExtension[] = [];
  const failed = (name: string, source: string, error: unknown) => loaded.push({ summary: { name, source, tools: [], events: [], error: message(error) } });
  let installed: InstalledSource[];
  try { installed = await store.list(); }
  catch (error) { return [{ summary: { name: "extensions", source: `local:${store.directory}`, tools: [], events: [], error: message(error) } }]; }
  const tools = new Set<string>();
  for (const source of installed) {
    let found: Entry[];
    try { found = await entries(store, source); }
    catch (error) { failed(entryName(source.package ?? basename(source.path ?? source.source)), source.source, error); continue; }
    for (const entry of found) {
      if (loaded.length >= hostExtensionLimits.extensions) break;
      if (!HOST_EXTENSION_NAME.test(entry.name) || entry.name.length > hostExtensionLimits.name) { failed(entryName(entry.name), entry.source, new Error("Invalid extension name")); continue; }
      if (loaded.some(other => other.summary.name === entry.name)) { failed(`${entry.name}-${loaded.length}`, entry.source, new Error(`Another extension is named ${entry.name}`)); continue; }
      try {
        if (entry.file.includes(`${sep}node_modules${sep}`) && /\.m?ts$/.test(entry.file)) {
          throw new Error("Node.js runs TypeScript only outside node_modules: publish the extension as JavaScript, or install it from a local path");
        }
        const module = await importModule(entry.file) as { default?: unknown };
        if (typeof module.default !== "function") throw new Error("Its module's default export must be a function taking the PikibunExtensionAPI");
        const factory = module.default as PikibunExtensionFactory;
        const registrations = await register(entry.name, factory);
        const repeated = registrations.tools.find(tool => tools.has(tool.name));
        if (repeated) throw new Error(`Another extension has a tool named ${repeated.name}`);
        const summary = summarize(entry.name, entry.source, entry.version, registrations);
        for (const tool of registrations.tools) tools.add(tool.name);
        loaded.push({ summary, factory });
      } catch (error) { failed(entry.name, entry.source, error); }
    }
  }
  return loaded;
}
