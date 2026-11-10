import { extensionPackageKey, normalizeExtensionSource, parseExtensionSettings, type ExtensionSettings } from "./host-extensions.js";
import { defaultHostBrowserConfig, parseHostBrowserConfig, type HostBrowserConfig } from "./browser.js";
import { defaultHostTunnelConfig, parseHostTunnelConfig, serviceLifetimeLimits, type HostTunnelConfig } from "./tunnel.js";

export const repositoryCacheModes = ["off", "host", "owner"] as const;
export type RepositoryCacheMode = (typeof repositoryCacheModes)[number];

export const gpuKinds = ["dxg", "render"] as const;
export type GpuKind = (typeof gpuKinds)[number];

export const builtinExtensions = Object.freeze([
  Object.freeze({
    name: "pi:codemode", title: "Code mode", tools: Object.freeze(["codemode"]), core: true,
    description: "The codemode tool: the model writes JavaScript that calls the session's tools, run in a QuickJS sandbox in the connector, to batch, chain and filter calls. Each call it makes is decided like the model's own, and a script resumes where it was after a restart.",
  }),
] as const);
export type BuiltinExtensionName = (typeof builtinExtensions)[number]["name"];
export const builtinExtensionNames: readonly BuiltinExtensionName[] = Object.freeze(builtinExtensions.map(item => item.name));

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
}

export interface RequiredExtension {
  source: string;
  settings: ExtensionSettings;
}

export const hostConfigLimits = Object.freeze({
  commandTimeoutSeconds: Object.freeze({ min: 30, max: 3600 }),
  serviceLifetimeSeconds: Object.freeze({ min: serviceLifetimeLimits.min, max: serviceLifetimeLimits.max }),
  compactionTokens: Object.freeze({ min: 0, max: 10_000_000 }),
  compactionModels: 200,
  requiredExtensions: 16,
  requiredExtensionsBytes: 32 * 1024,
});

export const defaultHostConfig: Readonly<HostConfig> = Object.freeze({
  commandTimeoutSeconds: 30, gpu: false, gitCredentials: false, repositoryCache: "off", hostSessions: false, compaction: Object.freeze({}),
  builtinExtensions: Object.freeze([]) as unknown as BuiltinExtensionName[],
  requiredExtensions: Object.freeze([]) as unknown as RequiredExtension[],
  browser: defaultHostBrowserConfig as HostBrowserConfig,
  serviceLifetimeSeconds: serviceLifetimeLimits.default,
  tunnel: defaultHostTunnelConfig as HostTunnelConfig,
});

export function parseRequiredExtensions(input: unknown): RequiredExtension[] {
  if (!Array.isArray(input)) throw new Error("Invalid required extensions");
  if (input.length > hostConfigLimits.requiredExtensions) throw new Error(`A host requires at most ${hostConfigLimits.requiredExtensions} extensions`);
  const packages = new Set<string>();
  const parsed = input.map(item => {
    if (!item || typeof item !== "object" || Array.isArray(item) || Object.keys(item).some(key => key !== "source" && key !== "settings")) {
      throw new Error("Invalid required extension");
    }
    const { source, settings } = item as { source?: unknown; settings?: unknown };
    if (typeof source !== "string") throw new Error("Invalid required extension");
    let normalized: string;
    try { normalized = normalizeExtensionSource(source); }
    catch (error) { throw new Error(`Invalid required extension: ${error instanceof Error ? error.message : "its source"}`); }
    const key = extensionPackageKey(normalized);
    if (packages.has(key)) throw new Error(`A host requires one version of ${key}`);
    packages.add(key);
    return { source: normalized, settings: parseExtensionSettings(settings ?? {}) };
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

export const ownerOnlyHostConfig: readonly (keyof HostConfig)[] = Object.freeze(["gitCredentials", "repositoryCache", "hostSessions", "requiredExtensions", "browser", "tunnel"]);

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
  if (typeof input.gpu !== "boolean") throw new Error("Invalid GPU setting");
  if (typeof input.gitCredentials !== "boolean") throw new Error("Invalid Git credentials setting");
  if (!repositoryCacheModes.includes(input.repositoryCache as RepositoryCacheMode)) throw new Error("Invalid repository cache setting");
  if (typeof input.hostSessions !== "boolean") throw new Error("Invalid host sessions setting");
  const lifetime = input.serviceLifetimeSeconds;
  const lifetimes = hostConfigLimits.serviceLifetimeSeconds;
  if (typeof lifetime !== "number" || !Number.isSafeInteger(lifetime) || lifetime < lifetimes.min || lifetime > lifetimes.max) {
    throw new Error(`The service lifetime is between ${lifetimes.min} and ${lifetimes.max} seconds`);
  }
  return { commandTimeoutSeconds: timeout, gpu: input.gpu, gitCredentials: input.gitCredentials, repositoryCache: input.repositoryCache as RepositoryCacheMode,
    hostSessions: input.hostSessions, compaction: parseHostCompaction(input.compaction), builtinExtensions: parseBuiltinExtensions(input.builtinExtensions),
    requiredExtensions: parseRequiredExtensions(input.requiredExtensions), browser: parseHostBrowserConfig(input.browser),
    serviceLifetimeSeconds: lifetime, tunnel: parseHostTunnelConfig(input.tunnel) };
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
