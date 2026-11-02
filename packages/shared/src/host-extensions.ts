/**
 * Host extensions (docs/design/host-extensions.md): code the host's owner installed on the host (`pikibun extensions
 * add`), which the connector loads into its sessions' agents. The connector advertises what it loaded
 * (HostExtensionSummary); the host's owner and admins turn each one on or off and set its settings in Pikibun
 * (HostExtensionSetting), and the connector reads those with the host's configuration (HostConfig.extensions).
 */

/** Which sessions on the host an enabled extension joins. */
export const hostExtensionScopes = ["owner", "host", "all"] as const;
/**
 * - `owner`: sessions the host's owner started.
 * - `host`: sessions that run directly on the host (Sessions on the host, or an unsandboxed host).
 * - `all`: every session on the host.
 */
export type HostExtensionScope = (typeof hostExtensionScopes)[number];

/**
 * How an extension's tool calls run: each decided like a host command (`approval`), or at once (`automatic`). Either way
 * they run in the connector, outside the sandbox.
 */
export const hostExtensionToolModes = ["approval", "automatic"] as const;
export type HostExtensionToolMode = (typeof hostExtensionToolModes)[number];

/** The agent events an extension can handle (PikibunExtensionAPI.on). */
export const hostExtensionEvents = ["before_agent_start", "context", "tool_call", "tool_result", "turn_end", "message_end",
  "agent_before_settle", "session_before_compact"] as const;
export type HostExtensionEvent = (typeof hostExtensionEvents)[number];

export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };

export interface HostExtensionTool {
  name: string;
  description: string;
}

/** One extension as the connector loaded it, advertised to the control plane. */
export interface HostExtensionSummary {
  /** Unique on the host: the package's name, or the file's for a local file, with `/<entry>` for a package's further entries. */
  name: string;
  /** Where it was installed from: `npm:<name>@<version>`, `git:<url>@<commit>` or `local:<path>`. */
  source: string;
  version?: string;
  description?: string;
  tools: HostExtensionTool[];
  /** The events it handles, in `hostExtensionEvents` order. */
  events: HostExtensionEvent[];
  /** JSON Schema of its settings (PikibunExtensionAPI.settings), when it takes any. */
  settingsSchema?: JsonObject;
  /** Why it didn't load; such an extension has no tools or events and never runs. */
  error?: string;
}

/** How the host's owner and admins set one extension. */
export interface HostExtensionSetting {
  enabled: boolean;
  scope: HostExtensionScope;
  tools: HostExtensionToolMode;
  /** Plain JSON, never secrets: the extension reads those on the host. */
  settings: JsonObject;
}

export type HostExtensionsConfig = Record<string, HostExtensionSetting>;

export const hostExtensionLimits = Object.freeze({
  extensions: 32,
  toolsPerExtension: 32,
  name: 128,
  source: 512,
  description: 1024,
  toolDescription: 4096,
  /** Each extension's settings schema and settings, as JSON. */
  schemaBytes: 16 * 1024,
  settingsBytes: 16 * 1024,
  error: 1024,
});

export const defaultHostExtensionSetting: Readonly<HostExtensionSetting> = Object.freeze({ enabled: false, scope: "owner", tools: "approval", settings: Object.freeze({}) });

/** An extension's name: a package name (`pkg`, `@scope/pkg`), optionally with `/<entry>`, or a file's base name. */
export const HOST_EXTENSION_NAME = /^(?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*(?:\/[a-z0-9][a-z0-9._~-]*)?$/;
/** A tool name as providers accept it. */
export const HOST_EXTENSION_TOOL_NAME = /^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/;

const isPlainObject = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value)
  && Object.getPrototypeOf(value) === Object.prototype;

const jsonBytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).length;

/** Whether `value` is plain JSON: no functions, symbols, undefined, non-finite numbers or class instances. */
export function isJsonValue(value: unknown, depth = 0): value is JsonValue {
  if (depth > 32) return false;
  if (value === null || typeof value === "boolean" || typeof value === "string") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(item => isJsonValue(item, depth + 1));
  return isPlainObject(value) && Object.values(value).every(item => isJsonValue(item, depth + 1));
}

/** One extension's setting; anything invalid is refused. */
export function parseHostExtensionSetting(value: unknown): HostExtensionSetting {
  if (!isPlainObject(value)) throw new Error("Invalid extension setting");
  const keys = Object.keys(value);
  if (keys.some(key => !Object.hasOwn(defaultHostExtensionSetting, key))) throw new Error("Invalid extension setting");
  const { enabled = false, scope = "owner", tools = "approval", settings = {} } = value;
  if (typeof enabled !== "boolean") throw new Error("Invalid extension setting");
  if (!hostExtensionScopes.includes(scope as HostExtensionScope)) throw new Error("An extension's scope is owner, host or all");
  if (!hostExtensionToolModes.includes(tools as HostExtensionToolMode)) throw new Error("An extension's tools run with approval or automatically");
  if (!isPlainObject(settings) || !isJsonValue(settings)) throw new Error("An extension's settings are a JSON object");
  if (jsonBytes(settings) > hostExtensionLimits.settingsBytes) throw new Error(`An extension's settings are at most ${hostExtensionLimits.settingsBytes / 1024} KB`);
  return { enabled, scope: scope as HostExtensionScope, tools: tools as HostExtensionToolMode, settings };
}

/** The settings of a host's extensions, by name. */
export function parseHostExtensionsConfig(value: unknown): HostExtensionsConfig {
  if (!isPlainObject(value)) throw new Error("Invalid extensions setting");
  const names = Object.keys(value);
  if (names.length > hostExtensionLimits.extensions * 4) throw new Error("Too many extension settings");
  if (names.some(name => name.length > hostExtensionLimits.name || !HOST_EXTENSION_NAME.test(name))) throw new Error("Invalid extension name");
  return Object.fromEntries(names.sort().map(name => [name, parseHostExtensionSetting(value[name])]));
}

const text = (value: unknown, limit: number): value is string => typeof value === "string" && value.length <= limit && !value.includes("\0");

/** One advertised extension, as the control plane accepts it. */
export function parseHostExtensionSummary(value: unknown): HostExtensionSummary {
  if (!isPlainObject(value)) throw new Error("Invalid extension");
  const allowed = ["name", "source", "version", "description", "tools", "events", "settingsSchema", "error"];
  if (Object.keys(value).some(key => !allowed.includes(key))) throw new Error("Invalid extension");
  const { name, source, version, description, tools, events, settingsSchema, error } = value;
  if (!text(name, hostExtensionLimits.name) || !HOST_EXTENSION_NAME.test(name)) throw new Error("Invalid extension name");
  if (!text(source, hostExtensionLimits.source) || !source) throw new Error("Invalid extension source");
  if (version !== undefined && !text(version, 128)) throw new Error("Invalid extension version");
  if (description !== undefined && !text(description, hostExtensionLimits.description)) throw new Error("Invalid extension description");
  if (error !== undefined && !text(error, hostExtensionLimits.error)) throw new Error("Invalid extension error");
  if (!Array.isArray(tools) || tools.length > hostExtensionLimits.toolsPerExtension) throw new Error("Invalid extension tools");
  const parsedTools = tools.map(tool => {
    if (!isPlainObject(tool) || Object.keys(tool).sort().join() !== "description,name"
      || !text(tool.name, 64) || !HOST_EXTENSION_TOOL_NAME.test(tool.name) || !text(tool.description, hostExtensionLimits.toolDescription)) throw new Error("Invalid extension tool");
    return { name: tool.name, description: tool.description };
  });
  if (new Set(parsedTools.map(tool => tool.name)).size !== parsedTools.length) throw new Error("Invalid extension tools");
  if (!Array.isArray(events) || events.some(event => !hostExtensionEvents.includes(event)) || new Set(events).size !== events.length) throw new Error("Invalid extension events");
  if (settingsSchema !== undefined && (!isPlainObject(settingsSchema) || !isJsonValue(settingsSchema) || jsonBytes(settingsSchema) > hostExtensionLimits.schemaBytes)) {
    throw new Error("Invalid extension settings schema");
  }
  return { name, source, ...(version !== undefined ? { version } : {}), ...(description !== undefined ? { description } : {}), tools: parsedTools,
    events: hostExtensionEvents.filter(event => events.includes(event)), ...(settingsSchema !== undefined ? { settingsSchema: settingsSchema as JsonObject } : {}),
    ...(error !== undefined ? { error } : {}) };
}

/** The advertised list: at most `hostExtensionLimits.extensions`, names and tool names unique across the host. */
export function parseHostExtensionSummaries(value: unknown): HostExtensionSummary[] {
  if (!Array.isArray(value) || value.length > hostExtensionLimits.extensions) throw new Error("Invalid extensions");
  const extensions = value.map(parseHostExtensionSummary);
  if (new Set(extensions.map(extension => extension.name)).size !== extensions.length) throw new Error("Extension names repeat");
  const tools = extensions.flatMap(extension => extension.tools.map(tool => tool.name));
  if (new Set(tools).size !== tools.length) throw new Error("Extension tool names repeat");
  return extensions;
}

/** Whether an extension set so joins a session: enabled, and the session within its scope. */
export function hostExtensionApplies(setting: HostExtensionSetting | undefined,
  session: { ownerId: string; connectorOwnerId?: string | null; onHost: boolean }): boolean {
  if (!setting?.enabled) return false;
  if (setting.scope === "all") return true;
  if (setting.scope === "host") return session.onHost;
  return !!session.connectorOwnerId && session.ownerId === session.connectorOwnerId;
}
