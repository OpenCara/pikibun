import { extensionPackageKey, normalizeExtensionSource, PACKAGE_NAME, parseExtensionSettings, type ExtensionSettings } from "./host-extensions.js";
import { defaultHostBrowserConfig, parseHostBrowserConfig, type HostBrowserConfig } from "./browser.js";
import { defaultHostTunnelConfig, parseHostTunnelConfig, serviceLifetimeLimits, type HostTunnelConfig } from "./tunnel.js";
import { buildCacheLimits, buildCacheModes, type BuildCacheMode } from "./build-caches.js";

export const repositoryCacheModes = ["off", "host", "owner"] as const;
export type RepositoryCacheMode = (typeof repositoryCacheModes)[number];

export const gpuKinds = ["dxg", "render"] as const;
export type GpuKind = (typeof gpuKinds)[number];

export const builtinExtensions = Object.freeze([
  Object.freeze({
    name: "pi:codemode", title: "Code mode", tools: Object.freeze(["codemode"]), core: true,
    description: "The codemode tool: the model writes JavaScript that calls the session's tools, run in a QuickJS sandbox in the connector, to batch, chain and filter calls. Each call it makes is decided like the model's own, and a script resumes where it was after a restart.",
  }),
  Object.freeze({
    name: "pi:tool-search", title: "Tool search", tools: Object.freeze(["tool_search"]),
    description: "Defers the session's rarely used tools: the model is offered the file tools, git, GitHub, Python, Node.js and code mode from the start, and finds the others (tunnel, schedule, other toolchains, extensions' tools and the like) with the tool_search tool, which loads them for the rest of the conversation. Loaded tools refuse as they do when offered from the start.",
  }),
] as const);
export type BuiltinExtensionName = (typeof builtinExtensions)[number]["name"];
export const builtinExtensionNames: readonly BuiltinExtensionName[] = Object.freeze(builtinExtensions.map(item => item.name));

export const newHostBuiltinExtensions: readonly BuiltinExtensionName[] = Object.freeze(["pi:tool-search"]);

export function normalizeBuiltinExtensionNames(names: readonly unknown[]): unknown[] {
  return names.map(name => typeof name === "string" && !name.includes(":") ? `pi:${name}` : name);
}

export interface CompactionTokens {
  reserveTokens?: number;
  keepRecentTokens?: number;
}

export interface HostCompaction extends CompactionTokens {
  modelOverrides?: Record<string, CompactionTokens>;
}

export interface HostConfig {
  commandTimeoutSeconds: number;
  commandTimeoutUnlimited: boolean;
  gpu: boolean;
  gitCredentials: boolean;
  repositoryCache: RepositoryCacheMode;
  hostSessions: boolean;
  compaction: HostCompaction;
  builtinExtensions: BuiltinExtensionName[];
  requiredExtensions: RequiredExtension[];
  browser: HostBrowserConfig;
  serviceLifetimeSeconds: number;
  tunnel: HostTunnelConfig;
  fakeIpTunnels: boolean;
  buildCaches: BuildCacheMode;
  buildCacheGiB: number;
  modelExtensions: string[];
  cacheWarming: boolean;
  extensionFiles: ExtensionFile[];
}

export interface ExtensionFile {
  extension: string;
  path: string;
  target: string;
}

export interface RequiredExtension {
  source: string;
  settings: ExtensionSettings;
  allowModelCalls?: true;
}

export const hostConfigLimits = Object.freeze({
  commandTimeoutSeconds: Object.freeze({ min: 30, max: 3600 }),
  serviceLifetimeSeconds: Object.freeze({ min: serviceLifetimeLimits.min, max: serviceLifetimeLimits.max }),
  compactionTokens: Object.freeze({ min: 0, max: 10_000_000 }),
  compactionModels: 200,
  requiredExtensions: 16,
  requiredExtensionsBytes: 32 * 1024,
  modelExtensions: 16,
  extensionFiles: 32,
  extensionFilePath: 1024,
  extensionFileTarget: 512,
});

export const unlimitedCommandSeconds = 2_000_000;

export function commandSeconds(config: Pick<HostConfig, "commandTimeoutSeconds" | "commandTimeoutUnlimited">): number {
  return config.commandTimeoutUnlimited ? unlimitedCommandSeconds : config.commandTimeoutSeconds;
}

export const defaultHostConfig: Readonly<HostConfig> = Object.freeze({
  commandTimeoutSeconds: 3600, commandTimeoutUnlimited: false, gpu: false, gitCredentials: false, repositoryCache: "off", hostSessions: false, compaction: Object.freeze({}),
  builtinExtensions: Object.freeze([]) as unknown as BuiltinExtensionName[],
  requiredExtensions: Object.freeze([]) as unknown as RequiredExtension[],
  browser: defaultHostBrowserConfig as HostBrowserConfig,
  serviceLifetimeSeconds: serviceLifetimeLimits.default,
  tunnel: defaultHostTunnelConfig as HostTunnelConfig,
  fakeIpTunnels: false,
  buildCaches: "off",
  buildCacheGiB: buildCacheLimits.gib.default,
  modelExtensions: Object.freeze([]) as unknown as string[],
  cacheWarming: true,
  extensionFiles: Object.freeze([]) as unknown as ExtensionFile[],
});

const ZERO_COMMIT = "0".repeat(40);
const UNSAFE_PATH = /[\x00-\x1f\x7f]/;
const SESSION_HOME_FILES = new Set([".gitconfig", ".tmp"]);

export function extensionFilePackage(input: string): string {
  const value = input.trim();
  if (value.startsWith("npm:")) {
    const rest = value.slice(4);
    const name = rest.lastIndexOf("@") > 0 ? rest.slice(0, rest.lastIndexOf("@")) : rest;
    if (!PACKAGE_NAME.test(name) || name.length > 214) throw new Error(`Invalid npm package name: ${name}`);
    return `npm:${name}`;
  }
  if (value.startsWith("git:")) {
    const hash = value.indexOf("#");
    const base = hash < 0 ? value : value.slice(0, hash);
    const path = hash < 0 ? "" : value.slice(hash);
    const pinned = /@[0-9a-f]{40}$/.test(base) ? base : `${base}@${ZERO_COMMIT}`;
    return extensionPackageKey(normalizeExtensionSource(`${pinned}${path}`));
  }
  throw new Error("Files are shared with an extension installed from npm or Git: npm:<package> or git:<https URL>");
}

export function validExtensionFilePath(path: string): boolean {
  return path.length <= hostConfigLimits.extensionFilePath && !UNSAFE_PATH.test(path) && (path.startsWith("/") || path.startsWith("~/"))
    && path.split("/").every(segment => segment !== "..") && path.replace(/^~?\/+/, "").length > 0;
}

export function validExtensionFileTarget(target: string): boolean {
  if (!target || target.length > hostConfigLimits.extensionFileTarget || UNSAFE_PATH.test(target) || target.startsWith("/") || target.endsWith("/")) return false;
  const segments = target.split("/");
  return segments.every(segment => segment !== "" && segment !== "." && segment !== "..") && !SESSION_HOME_FILES.has(segments[0]!);
}

export function parseExtensionFiles(input: unknown): ExtensionFile[] {
  if (!Array.isArray(input)) throw new Error("Invalid shared extension files");
  if (input.length > hostConfigLimits.extensionFiles) throw new Error(`A host shares at most ${hostConfigLimits.extensionFiles} files with extensions`);
  const targets = new Set<string>();
  return input.map(item => {
    if (!item || typeof item !== "object" || Array.isArray(item) || Object.keys(item).some(key => key !== "extension" && key !== "path" && key !== "target")) {
      throw new Error("Invalid shared extension file");
    }
    const { extension, path, target } = item as Record<string, unknown>;
    if (typeof extension !== "string" || typeof path !== "string" || typeof target !== "string") throw new Error("Invalid shared extension file");
    let key: string;
    try { key = extensionFilePackage(extension); }
    catch (error) { throw new Error(`Invalid shared extension file: ${error instanceof Error ? error.message : "its extension"}`); }
    const file = path.trim();
    const inside = target.trim();
    if (!validExtensionFilePath(file)) throw new Error(`A shared file is named by its absolute path on the host, or one from ~/, without ..: ${file.slice(0, 80) || "(empty)"}`);
    if (!validExtensionFileTarget(inside)) throw new Error(`A shared file's place is a path in the session's home, such as .config/pi/web-search.json, without . or .., and not .gitconfig or .tmp: ${inside.slice(0, 80) || "(empty)"}`);
    if (targets.has(inside)) throw new Error(`Two shared files go to ${inside}`);
    targets.add(inside);
    return { extension: key, path: file, target: inside };
  });
}

export function parseModelExtensions(input: unknown): string[] {
  if (!Array.isArray(input)) throw new Error("Invalid model extensions");
  if (input.length > hostConfigLimits.modelExtensions) throw new Error(`At most ${hostConfigLimits.modelExtensions} extensions provide a host's models`);
  const packages = new Set<string>();
  return input.map(source => {
    if (typeof source !== "string") throw new Error("Invalid model extension");
    let normalized: string;
    try { normalized = normalizeExtensionSource(source); }
    catch (error) { throw new Error(`Invalid model extension: ${error instanceof Error ? error.message : "its source"}`); }
    if (!normalized.startsWith("npm:") && !normalized.startsWith("git:")) throw new Error(`${normalized} can't provide models: only an extension installed from npm or Git can`);
    const key = extensionPackageKey(normalized);
    if (packages.has(key)) throw new Error(`One version of ${key} provides models`);
    packages.add(key);
    return normalized;
  });
}

export function parseRequiredExtensions(input: unknown): RequiredExtension[] {
  if (!Array.isArray(input)) throw new Error("Invalid required extensions");
  if (input.length > hostConfigLimits.requiredExtensions) throw new Error(`A host requires at most ${hostConfigLimits.requiredExtensions} extensions`);
  const packages = new Set<string>();
  const parsed = input.map(item => {
    if (!item || typeof item !== "object" || Array.isArray(item) || Object.keys(item).some(key => key !== "source" && key !== "settings" && key !== "allowModelCalls")) {
      throw new Error("Invalid required extension");
    }
    const { source, settings, allowModelCalls } = item as { source?: unknown; settings?: unknown; allowModelCalls?: unknown };
    if (typeof source !== "string" || (allowModelCalls !== undefined && typeof allowModelCalls !== "boolean")) throw new Error("Invalid required extension");
    let normalized: string;
    try { normalized = normalizeExtensionSource(source); }
    catch (error) { throw new Error(`Invalid required extension: ${error instanceof Error ? error.message : "its source"}`); }
    const key = extensionPackageKey(normalized);
    if (packages.has(key)) throw new Error(`A host requires one version of ${key}`);
    packages.add(key);
    return { source: normalized, settings: parseExtensionSettings(settings ?? {}), ...(allowModelCalls === true ? { allowModelCalls: true as const } : {}) };
  });
  if (new TextEncoder().encode(JSON.stringify(parsed)).length > hostConfigLimits.requiredExtensionsBytes) {
    throw new Error(`Required extensions and their settings take at most ${hostConfigLimits.requiredExtensionsBytes / 1024} KB`);
  }
  return parsed;
}

export function parseBuiltinExtensions(input: unknown): BuiltinExtensionName[] {
  if (!Array.isArray(input) || input.length > builtinExtensionNames.length) throw new Error("Invalid built-in extensions");
  const value = normalizeBuiltinExtensionNames(input);
  if (value.some(name => !(builtinExtensionNames as readonly unknown[]).includes(name)) || new Set(value).size !== value.length) {
    throw new Error(`Built-in extensions are ${builtinExtensionNames.join(", ")}`);
  }
  return builtinExtensionNames.filter(name => value.includes(name));
}

const compactionTokenKeys = ["reserveTokens", "keepRecentTokens"] as const;
const COMPACTION_MODEL = /^[^/\s]{1,80}\/\S{1,200}$/;

const isPlainObject = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value)
  && Object.getPrototypeOf(value) === Object.prototype;

function compactionTokens(value: unknown): CompactionTokens {
  if (!isPlainObject(value) || Object.keys(value).some(key => !(compactionTokenKeys as readonly string[]).includes(key))) {
    throw new Error("Invalid compaction setting");
  }
  const { min, max } = hostConfigLimits.compactionTokens;
  const tokens: CompactionTokens = {};
  for (const key of compactionTokenKeys) {
    const count = value[key];
    if (count === undefined) continue;
    if (typeof count !== "number" || !Number.isSafeInteger(count) || count < min || count > max) {
      throw new Error(`Compaction token counts are whole numbers from ${min} to ${max.toLocaleString("en-US")}`);
    }
    tokens[key] = count;
  }
  return tokens;
}

export function parseHostCompaction(value: unknown): HostCompaction {
  if (!isPlainObject(value)) throw new Error("Invalid compaction setting");
  const { modelOverrides, ...overall } = value;
  const compaction: HostCompaction = compactionTokens(overall);
  if (modelOverrides === undefined) return compaction;
  if (!isPlainObject(modelOverrides)) throw new Error("Invalid compaction setting");
  const models = Object.keys(modelOverrides);
  if (models.length > hostConfigLimits.compactionModels) throw new Error(`Compaction is set for at most ${hostConfigLimits.compactionModels} models`);
  if (models.some(model => !COMPACTION_MODEL.test(model))) throw new Error("Compaction names each model as provider/modelId");
  const overrides = Object.fromEntries(models.sort().map(model => [model, compactionTokens(modelOverrides[model])])
    .filter(([, tokens]) => Object.keys(tokens as CompactionTokens).length));
  return Object.keys(overrides).length ? { ...compaction, modelOverrides: overrides } : compaction;
}

export const ownerOnlyHostConfig: readonly (keyof HostConfig)[] = Object.freeze(["gitCredentials", "repositoryCache", "hostSessions", "requiredExtensions", "browser", "tunnel", "fakeIpTunnels", "buildCaches", "buildCacheGiB", "modelExtensions", "cacheWarming", "extensionFiles"]);

export function parseHostConfig(value: unknown): HostConfig {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid host configuration");
  const input = value as Record<string, unknown>;
  const keys = Object.keys(input);
  if (keys.length !== Object.keys(defaultHostConfig).length || keys.some(key => !Object.hasOwn(defaultHostConfig, key))) {
    throw new Error("Invalid host configuration");
  }
  const { min, max } = hostConfigLimits.commandTimeoutSeconds;
  const timeout = input.commandTimeoutSeconds;
  if (typeof timeout !== "number" || !Number.isSafeInteger(timeout) || timeout < min || timeout > max) {
    throw new Error(`The command time limit is between ${min} and ${max} seconds`);
  }
  if (typeof input.commandTimeoutUnlimited !== "boolean") throw new Error("Invalid command time limit setting");
  if (typeof input.gpu !== "boolean") throw new Error("Invalid GPU setting");
  if (typeof input.gitCredentials !== "boolean") throw new Error("Invalid Git credentials setting");
  if (!repositoryCacheModes.includes(input.repositoryCache as RepositoryCacheMode)) throw new Error("Invalid repository cache setting");
  if (typeof input.hostSessions !== "boolean") throw new Error("Invalid host sessions setting");
  if (typeof input.fakeIpTunnels !== "boolean") throw new Error("Invalid fake-IP tunnels setting");
  if (typeof input.cacheWarming !== "boolean") throw new Error("Invalid prompt cache warming setting");
  if (!buildCacheModes.includes(input.buildCaches as BuildCacheMode)) throw new Error("Invalid build caches setting");
  const gib = input.buildCacheGiB;
  if (typeof gib !== "number" || !Number.isSafeInteger(gib) || gib < buildCacheLimits.gib.min || gib > buildCacheLimits.gib.max) {
    throw new Error(`The build caches' size limit is between ${buildCacheLimits.gib.min} and ${buildCacheLimits.gib.max} GiB`);
  }
  const lifetime = input.serviceLifetimeSeconds;
  const lifetimes = hostConfigLimits.serviceLifetimeSeconds;
  if (typeof lifetime !== "number" || !Number.isSafeInteger(lifetime) || lifetime < lifetimes.min || lifetime > lifetimes.max) {
    throw new Error(`The service lifetime is between ${lifetimes.min} and ${lifetimes.max} seconds`);
  }
  return { commandTimeoutSeconds: timeout, commandTimeoutUnlimited: input.commandTimeoutUnlimited, gpu: input.gpu, gitCredentials: input.gitCredentials, repositoryCache: input.repositoryCache as RepositoryCacheMode,
    hostSessions: input.hostSessions, compaction: parseHostCompaction(input.compaction), builtinExtensions: parseBuiltinExtensions(input.builtinExtensions),
    requiredExtensions: parseRequiredExtensions(input.requiredExtensions), browser: parseHostBrowserConfig(input.browser),
    serviceLifetimeSeconds: lifetime, tunnel: parseHostTunnelConfig(input.tunnel), fakeIpTunnels: input.fakeIpTunnels,
    buildCaches: input.buildCaches as BuildCacheMode, buildCacheGiB: gib, modelExtensions: parseModelExtensions(input.modelExtensions), cacheWarming: input.cacheWarming,
    extensionFiles: parseExtensionFiles(input.extensionFiles) };
}

export function parseHostConfigChange(value: unknown): Partial<HostConfig> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid host configuration");
  const keys = Object.keys(value);
  if (!keys.length || keys.some(key => !Object.hasOwn(defaultHostConfig, key))) throw new Error("Invalid host configuration");
  const whole = parseHostConfig({ ...defaultHostConfig, ...value });
  return Object.fromEntries(keys.map(key => [key, whole[key as keyof HostConfig]])) as Partial<HostConfig>;
}

export function readHostConfig(value: unknown): HostConfig {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid host configuration");
  const input = value as Record<string, unknown>;
  const known = Object.fromEntries(Object.keys(defaultHostConfig).filter(key => Object.hasOwn(input, key)).map(key => [key, input[key]]));
  if (Array.isArray(known.builtinExtensions)) known.builtinExtensions = normalizeBuiltinExtensionNames(known.builtinExtensions).filter(name => (builtinExtensionNames as readonly unknown[]).includes(name));
  return parseHostConfig({ ...defaultHostConfig, ...known });
}
