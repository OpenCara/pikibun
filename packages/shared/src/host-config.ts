import { extensionPackageKey, normalizeExtensionSource, parseExtensionSettings, type ExtensionSettings } from "./host-extensions.js";
import { defaultHostBrowserConfig, parseHostBrowserConfig, type HostBrowserConfig } from "./browser.js";
import { defaultHostTunnelConfig, parseHostTunnelConfig, serviceLifetimeLimits, type HostTunnelConfig } from "./tunnel.js";

/**
 * How a host runs its sessions. Its owner sets this in Pikibun (Settings → Hosts → the host → Configuration), and so do
 * its admins, except for the settings that decide whose Git credentials the host uses (`ownerOnlyHostConfig`). The
 * connector reads it from the control plane instead of taking connect options; a connector that predates this (no
 * `hostConfig` capability) keeps its options.
 */

/** A Git mirror of each repository on the host: none, one for every session on it, or one per session owner. */
export const repositoryCacheModes = ["off", "host", "owner"] as const;
export type RepositoryCacheMode = (typeof repositoryCacheModes)[number];

/** The GPU device a host can lend its sandboxed commands: WSL's /dev/dxg, or Linux DRM render nodes. */
export const gpuKinds = ["dxg", "render"] as const;
export type GpuKind = (typeof gpuKinds)[number];

/**
 * Pi's built-in extensions a host's owner and admins turn on for every session on it (HostConfig.builtinExtensions), with
 * nothing to install: they ship with Pikibun, from pi-durable (docs/design/host-extensions.md). Each runs in the
 * connector; its tool calls are the session's own, decided as usual. Pi's other built-ins have no counterpart here:
 * `mcp` and `llama.cpp` register MCP servers and providers, which Pikibun doesn't run, and `tool-search` finds deferred
 * tools, which Pikibun has none of. Each is named `pi:<name>`, beside Pikibun's own built-ins, which workspaces choose as
 * `piki:<name>` (piki-extensions.ts). A `core` one runs in every session whatever the host's configuration lists: its
 * owner can't turn it off (a workspace extension offering a tool by its name still replaces it).
 */
export const builtinExtensions = Object.freeze([
  Object.freeze({
    // Core (#163): it chains, loops over and filters other tools' results, as shell pipelines did, so every session has it.
    name: "pi:codemode", title: "Code mode", tools: Object.freeze(["codemode"]), core: true,
    description: "The codemode tool: the model writes JavaScript that calls the session's tools, run in a QuickJS sandbox in the connector, to batch, chain and filter calls. Each call it makes is decided like the model's own, and a script resumes where it was after a restart.",
  }),
] as const);
export type BuiltinExtensionName = (typeof builtinExtensions)[number]["name"];
export const builtinExtensionNames: readonly BuiltinExtensionName[] = Object.freeze(builtinExtensions.map(item => item.name));

/**
 * `names` with Pi's built-ins named `pi:<name>`: they were named bare (`codemode`) before, as configurations saved then
 * and clients of then still name them.
 */
export function normalizeBuiltinExtensionNames(names: readonly unknown[]): unknown[] {
  return names.map(name => typeof name === "string" && !name.includes(":") ? `pi:${name}` : name);
}

/** A model's compaction token counts, or the whole host's; each one left out keeps the host's Pi setting. */
export interface CompactionTokens {
  /**
   * The context left free for compaction: a conversation is summarized once it is within this many tokens of the model's
   * context window, and Pi gives the summary up to 80% of it.
   */
  reserveTokens?: number;
  /** The most recent context kept word for word, unsummarized, in tokens. */
  keepRecentTokens?: number;
}

/**
 * When a long conversation is summarized, as the host's owner and admins set it in Pikibun: for every model, and for
 * models by exact `provider/modelId`. Each count it sets replaces the one in Pi's settings.json on the host; the counts
 * it leaves out keep that file's, or the defaults (see the runner's hostCompaction).
 */
export interface HostCompaction extends CompactionTokens {
  modelOverrides?: Record<string, CompactionTokens>;
}

export interface HostConfig {
  /**
   * The longest a shell command in this host's sessions runs, in seconds. Commands longer than the default also get
   * room for builds: their CPU-time, file-size and open-file limits grow with it (see the runner's `commandLimits`).
   */
  commandTimeoutSeconds: number;
  /**
   * Sandboxed commands get the host's GPU render device (WSL's /dev/dxg or Linux DRM render nodes) for rendering and
   * compute. Never a display, window system or input device.
   */
  gpu: boolean;
  /** Pushes in the host owner's own sessions may use the credentials of the host's Git credential helpers. */
  gitCredentials: boolean;
  /**
   * A full-history Git mirror of each repository on the host, which sessions' clones borrow objects from. A change takes
   * effect when the connector next connects.
   */
  repositoryCache: RepositoryCacheMode;
  /**
   * The host's owner, and members they granted that (HostCommandGrant.hostSessions), may start sessions that run
   * directly on the host's own environment, without the sandbox (SessionRecord.hostEnvironment): their commands run as the connector's OS user, with its files, credentials,
   * network and GPU. Turning it off stops those sessions' commands at once.
   */
  hostSessions: boolean;
  /** Compaction token counts over the host's Pi settings; empty keeps those. Sessions pick a change up within a minute (the connector's refresh), with their next message. */
  compaction: HostCompaction;
  /**
   * Pi's built-in extensions every session on the host runs with (`builtinExtensions`), in that list's order. Sessions
   * pick a change up with their next message, within a minute.
   */
  builtinExtensions: BuiltinExtensionName[];
  /**
   * Extensions every session on the host runs, whatever its workspace chose, before the workspace's own, with the
   * settings the host's owner gave them (RequiredExtension): Pikibun's own (`piki:<name>`, such as `piki:prompt-audit`)
   * or ones installed on the host. A session whose host lacks one, or can't load it, takes no messages until it has it.
   * Only the host's owner changes them. Sessions pick a change up with their next message, within a minute.
   */
  requiredExtensions: RequiredExtension[];
  /**
   * Where the browser tool's Chromium comes from (piki:browser): found on the host, at a path its owner gives, downloaded
   * by the connector, or none. Only the host's owner changes it: it decides which of the host's files every sandboxed
   * session gets, read-only. The connector applies a change within a minute, as it next reports its extensions.
   */
  browser: HostBrowserConfig;
  /**
   * The longest a session service runs, in seconds: a process a session starts in its sandbox that outlives the call
   * that started it (the tunnel tool's server, piki:tunnel). It stops then, whatever else, and its tunnel with it.
   */
  serviceLifetimeSeconds: number;
  /**
   * Where the tunnel tool's cloudflared comes from (piki:tunnel): found on the host, at a path its owner gives,
   * downloaded by the connector, or none, which refuses tunnels on the host. Only the host's owner changes it: a tunnel
   * publishes from the host's network. The connector applies a change within a minute, as it next reports its extensions.
   */
  tunnel: HostTunnelConfig;
}

/** An extension a host's owner requires of every session on it, and its settings (the extension's Pi flags). */
export interface RequiredExtension {
  /** A normalized source: `piki:<name>`, `npm:<name>@<version>` or `git:<url>@<commit>`; never a dev extension. */
  source: string;
  settings: ExtensionSettings;
}

export const hostConfigLimits = Object.freeze({
  commandTimeoutSeconds: Object.freeze({ min: 30, max: 3600 }),
  serviceLifetimeSeconds: Object.freeze({ min: serviceLifetimeLimits.min, max: serviceLifetimeLimits.max }),
  /** Each compaction token count, and the number of models with their own (a host offers at most 200). */
  compactionTokens: Object.freeze({ min: 0, max: 10_000_000 }),
  compactionModels: 200,
  /** Extensions a host requires of its sessions, and their sources and settings together, as JSON. */
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

/**
 * The extensions a host requires: normalized sources, one version of each package, each with valid settings, in the
 * owner's order (the order sessions run them in).
 */
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
  // The whole configuration reaches the connector in one answer of at most 128 KiB, beside compaction counts for every model.
  if (new TextEncoder().encode(JSON.stringify(parsed)).length > hostConfigLimits.requiredExtensionsBytes) {
    throw new Error(`Required extensions and their settings take at most ${hostConfigLimits.requiredExtensionsBytes / 1024} KB`);
  }
  return parsed;
}

/** The built-in extensions a host runs: known names, each once, in the catalog's order, so equal settings are equal JSON. */
export function parseBuiltinExtensions(input: unknown): BuiltinExtensionName[] {
  if (!Array.isArray(input) || input.length > builtinExtensionNames.length) throw new Error("Invalid built-in extensions");
  const value = normalizeBuiltinExtensionNames(input);
  if (value.some(name => !(builtinExtensionNames as readonly unknown[]).includes(name)) || new Set(value).size !== value.length) {
    throw new Error(`Built-in extensions are ${builtinExtensionNames.join(", ")}`);
  }
  return builtinExtensionNames.filter(name => value.includes(name));
}

const compactionTokenKeys = ["reserveTokens", "keepRecentTokens"] as const;
/** A model as Pi's compaction overrides name it: `provider/modelId`, as the host advertises them (80 and 200 characters at most). */
const COMPACTION_MODEL = /^[^/\s]{1,80}\/\S{1,200}$/;

const isPlainObject = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value)
  && Object.getPrototypeOf(value) === Object.prototype;

function compactionTokens(value: unknown): CompactionTokens {
  if (!isPlainObject(value) || Object.keys(value).some(key => !(compactionTokenKeys as readonly string[]).includes(key))) {
    throw new Error("Invalid compaction setting");
  }
  const { min, max } = hostConfigLimits.compactionTokens;
  const tokens: CompactionTokens = {};
  // In a fixed order, so equal settings are equal JSON.
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

/** A compaction setting: token counts for every model and per model, each a whole number in bounds; a model with none is left out. */
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

/**
 * Only the host's owner changes these: they decide whose Git credentials the host uses, whether anything runs on it
 * without the sandbox, what runs as its OS user in every session on it, which of its files sessions get (the browser),
 * and whether sessions publish from its network (the tunnel). Its admins change the rest.
 */
export const ownerOnlyHostConfig: readonly (keyof HostConfig)[] = Object.freeze(["gitCredentials", "repositoryCache", "hostSessions", "requiredExtensions", "browser", "tunnel"]);

/** A whole configuration, as the control plane reports it; anything else is refused. */
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

/**
 * A change of configuration, as the host's page sends it (`PATCH /api/connectors/:id/config`): one or more settings, each
 * valid, and nothing else. The settings it leaves out keep their values, so a form sends only what its user changed and
 * never undoes someone else's change of another setting.
 */
export function parseHostConfigChange(value: unknown): Partial<HostConfig> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid host configuration");
  const keys = Object.keys(value);
  if (!keys.length || keys.some(key => !Object.hasOwn(defaultHostConfig, key))) throw new Error("Invalid host configuration");
  // Each named setting is checked as in a whole configuration; the defaults fill in the rest, and are valid.
  const whole = parseHostConfig({ ...defaultHostConfig, ...value });
  return Object.fromEntries(keys.map(key => [key, whole[key as keyof HostConfig]])) as Partial<HostConfig>;
}

/**
 * A configuration as a connector reads it from the control plane: settings it doesn't know (from a newer control plane)
 * are left out, and ones the control plane doesn't send (an older one) keep their defaults; so are built-in extensions
 * it doesn't ship. What it does read must be valid, or none of it is used.
 */
export function readHostConfig(value: unknown): HostConfig {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid host configuration");
  const input = value as Record<string, unknown>;
  const known = Object.fromEntries(Object.keys(defaultHostConfig).filter(key => Object.hasOwn(input, key)).map(key => [key, input[key]]));
  if (Array.isArray(known.builtinExtensions)) known.builtinExtensions = normalizeBuiltinExtensionNames(known.builtinExtensions).filter(name => (builtinExtensionNames as readonly unknown[]).includes(name));
  return parseHostConfig({ ...defaultHostConfig, ...known });
}
