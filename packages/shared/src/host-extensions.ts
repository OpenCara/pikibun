/**
 * Extensions (docs/design/host-extensions.md): Pi extensions a workspace chooses for its sessions, pinned to exact
 * versions, which each host installs. A session runs with the workspace's enabled extensions its host has at that exact
 * version, and, in its host owner's own sessions, the host's dev extensions (installed from a local path).
 */

export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

/** How an extension's tool calls run: each decided like a host command, or at once (also needs the host owner's leave). */
export const extensionToolModes = ["approval", "automatic"] as const;
export type ExtensionToolMode = (typeof extensionToolModes)[number];

/**
 * A pinned source, normalized: `npm:<name>@<exact version>` or `git:<https url>@<full commit>`; or `piki:<name>`, an
 * extension built into the connector (piki-extensions.ts), whose version is the connector's own.
 */
export type ExtensionSourceSpec = { kind: "npm"; package: string; version: string } | { kind: "git"; url: string; commit: string }
  | { kind: "piki"; name: string };

export const EXACT_VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
export const PACKAGE_NAME = /^(?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*$/;
const COMMIT = /^[0-9a-f]{40}$/;
/** A Pikibun extension's name. Any such name parses, so a control plane takes ones built into newer connectors. */
export const PIKI_NAME = /^[a-z][a-z0-9-]{0,63}$/;

export class ExtensionSourceError extends Error {}

/**
 * Parses `npm:<name>@<version>`, `git:<url>@<commit>` (an https URL, `https://` optional) or `piki:<name>`; anything
 * else is refused.
 */
export function parseExtensionSourceSpec(spec: string): ExtensionSourceSpec {
  if (typeof spec !== "string" || spec.length > 512) throw new ExtensionSourceError("Invalid extension source");
  if (spec.startsWith("piki:")) {
    const name = spec.slice(5);
    if (!PIKI_NAME.test(name)) throw new ExtensionSourceError(`Invalid Pikibun extension name: ${name}`);
    return { kind: "piki", name };
  }
  if (spec.startsWith("npm:")) {
    const rest = spec.slice(4);
    const at = rest.lastIndexOf("@");
    const name = at > 0 ? rest.slice(0, at) : rest;
    const version = at > 0 ? rest.slice(at + 1) : "";
    if (!PACKAGE_NAME.test(name) || name.length > 214) throw new ExtensionSourceError(`Invalid npm package name: ${name}`);
    if (!EXACT_VERSION.test(version)) throw new ExtensionSourceError(`Pin an exact version, such as npm:${name}@1.2.3: ranges and tags could load different code later.`);
    return { kind: "npm", package: name, version };
  }
  if (spec.startsWith("git:")) {
    const rest = spec.slice(4);
    const at = rest.lastIndexOf("@");
    const url = at > 0 ? rest.slice(0, at) : rest;
    const commit = at > 0 ? rest.slice(at + 1) : "";
    let parsed: URL;
    try { parsed = new URL(url.startsWith("https://") ? url : `https://${url}`); }
    catch { throw new ExtensionSourceError(`Invalid Git URL: ${url}`); }
    if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.search || parsed.hash || parsed.port) {
      throw new ExtensionSourceError("Git extensions install from an https:// URL without credentials.");
    }
    if (!COMMIT.test(commit)) throw new ExtensionSourceError(`Pin a full commit, such as git:${url}@<40-character commit>: branches and tags could load different code later.`);
    return { kind: "git", url: parsed.href.replace(/\/$/, "").replace(/\.git$/, ""), commit };
  }
  throw new ExtensionSourceError("An extension source is npm:<package>@<version>, git:<https URL>@<commit> or piki:<name>.");
}

export function extensionSourceString(spec: ExtensionSourceSpec): string {
  return spec.kind === "npm" ? `npm:${spec.package}@${spec.version}` : spec.kind === "git" ? `git:${spec.url}@${spec.commit}` : `piki:${spec.name}`;
}

/** Whether `source` names an extension built into the connector: hosts never install or remove those. */
export function isPikiExtensionSource(source: string): boolean {
  return source.startsWith("piki:");
}

/** The normalized form of `spec`, or an error. */
export function normalizeExtensionSource(spec: string): string {
  return extensionSourceString(parseExtensionSourceSpec(spec));
}

/**
 * What stays the same across versions of one extension: `npm:<name>`, `git:<url>`, or the built-in source itself. A
 * workspace has one version of each.
 */
export function extensionPackageKey(source: string): string {
  const spec = parseExtensionSourceSpec(source);
  return spec.kind === "npm" ? `npm:${spec.package}` : spec.kind === "git" ? `git:${spec.url}` : `piki:${spec.name}`;
}

/** A Pi flag an extension registers: one of its settings. */
export interface ExtensionFlag {
  name: string;
  type: "boolean" | "string";
  description?: string;
  default?: boolean | string;
}

/** One extension module (a factory) of an installed source, as the connector loaded it. */
export interface ExtensionModuleSummary {
  /** Its file, relative to the package (or the local path's base name). */
  path: string;
  tools: { name: string; description: string }[];
  /** Pi events it handles that Pikibun runs. */
  events: string[];
  flags: ExtensionFlag[];
  /** What it registers that does nothing here, as in Pi's print mode: commands, shortcuts, renderers, UI. */
  noops: string[];
  /** What it registers that Pikibun doesn't run: providers, MCP servers, events without a counterpart. */
  ignored: string[];
  error?: string;
}

/** One source installed on a host, with what it holds. */
export interface InstalledExtension {
  /** Normalized npm, Git or built-in source; for a dev extension, `local:<path>`. */
  source: string;
  /** Installed from a local path: runs only in the host owner's own sessions. */
  dev: boolean;
  name?: string;
  version?: string;
  description?: string;
  modules: ExtensionModuleSummary[];
  /** Why none of it loads. */
  error?: string;
}

/** What a connector reports of its extensions. */
export interface HostExtensionsReport {
  installed: InstalledExtension[];
  /** The connector installs and removes extensions when its owner asks in Pikibun (not `--no-remote-installs`). */
  remoteInstalls: boolean;
}

/** Flag values, by flag name. */
export type ExtensionSettings = Record<string, boolean | string>;

/** An extension a workspace uses, as its owners and admins set it. */
export interface WorkspaceExtension {
  /** Normalized npm, Git or built-in source. */
  source: string;
  enabled: boolean;
  tools: ExtensionToolMode;
  settings: ExtensionSettings;
}

/**
 * Popular Pi extensions every workspace starts with, in this order, turned off and with tools on approval: its owners
 * and admins turn on the ones they want, once their hosts install them. Existing workspaces got them in migration
 * sqlite/0049 (postgres/0042), which lists the same sources. `pi-web-access` and `pi-web-search` both offer
 * `web_search`, so a workspace turns on one of them (with both, sessions keep the first's).
 */
export const defaultWorkspaceExtensions: readonly string[] = Object.freeze([
  "npm:pi-web-access@0.46.0",
  "npm:pi-web-search@1.7.0",
  "npm:cc-safety-net@2.7.2",
]);

export const extensionLimits = Object.freeze({
  /** Sources a workspace uses, and a host installs. */
  workspace: 32,
  installed: 64,
  /** Pikibun extensions a connector reports besides what it installed (piki-extensions.ts). */
  connector: 16,
  modulesPerSource: 16,
  toolsPerModule: 64,
  flagsPerModule: 64,
  text: 1024,
  toolDescription: 4096,
  settingsBytes: 16 * 1024,
  /** A reported list, as JSON. */
  reportBytes: 512 * 1024,
});

const isPlainObject = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value)
  && Object.getPrototypeOf(value) === Object.prototype;
const text = (value: unknown, limit: number): value is string => typeof value === "string" && value.length <= limit && !value.includes("\0");
const strings = (value: unknown, limit: number, max = 256): value is string[] => Array.isArray(value) && value.length <= max && value.every(item => text(item, limit));
const FLAG = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const TOOL = /^[A-Za-z0-9_][A-Za-z0-9_.:/-]{0,127}$/;

function only(value: Record<string, unknown>, keys: string[], what: string): void {
  if (Object.keys(value).some(key => !keys.includes(key))) throw new Error(`Invalid ${what}`);
}

/** A workspace's settings of one extension: flag values, booleans or strings, 16 KB at most. */
export function parseExtensionSettings(value: unknown): ExtensionSettings {
  if (!isPlainObject(value)) throw new Error("An extension's settings are an object of flag values");
  const names = Object.keys(value);
  if (names.some(name => !FLAG.test(name))) throw new Error("Invalid setting name");
  if (Object.values(value).some(item => typeof item !== "boolean" && !text(item, 4096))) throw new Error("A setting is true, false or text");
  if (new TextEncoder().encode(JSON.stringify(value)).length > extensionLimits.settingsBytes) throw new Error(`An extension's settings are at most ${extensionLimits.settingsBytes / 1024} KB`);
  return Object.fromEntries(names.sort().map(name => [name, value[name] as boolean | string]));
}

export function parseWorkspaceExtension(value: unknown): WorkspaceExtension {
  if (!isPlainObject(value)) throw new Error("Invalid extension");
  only(value, ["source", "enabled", "tools", "settings"], "extension");
  if (typeof value.source !== "string") throw new Error("Invalid extension source");
  const source = normalizeExtensionSource(value.source);
  const enabled = value.enabled ?? true;
  const tools = value.tools ?? "approval";
  if (typeof enabled !== "boolean") throw new Error("Invalid extension setting");
  if (!extensionToolModes.includes(tools as ExtensionToolMode)) throw new Error("An extension's tools run with approval or automatically");
  return { source, enabled, tools: tools as ExtensionToolMode, settings: parseExtensionSettings(value.settings ?? {}) };
}

/** A workspace's extensions: one version per package. */
export function parseWorkspaceExtensions(value: unknown): WorkspaceExtension[] {
  if (!Array.isArray(value) || value.length > extensionLimits.workspace) throw new Error("Invalid extensions");
  const extensions = value.map(parseWorkspaceExtension);
  const keys = extensions.map(extension => extensionPackageKey(extension.source));
  if (new Set(keys).size !== keys.length) throw new Error("A workspace uses one version of each extension");
  return extensions;
}

function parseModule(value: unknown): ExtensionModuleSummary {
  if (!isPlainObject(value)) throw new Error("Invalid extension module");
  only(value, ["path", "tools", "events", "flags", "noops", "ignored", "error"], "extension module");
  if (!text(value.path, 512) || !value.path) throw new Error("Invalid extension module");
  if (!Array.isArray(value.tools) || value.tools.length > extensionLimits.toolsPerModule) throw new Error("Invalid extension tools");
  const tools = value.tools.map(tool => {
    if (!isPlainObject(tool) || Object.keys(tool).sort().join() !== "description,name" || !text(tool.name, 128) || !TOOL.test(tool.name)
      || !text(tool.description, extensionLimits.toolDescription)) throw new Error("Invalid extension tool");
    return { name: tool.name, description: tool.description };
  });
  if (!Array.isArray(value.flags) || value.flags.length > extensionLimits.flagsPerModule) throw new Error("Invalid extension flags");
  const flags = value.flags.map(flag => {
    if (!isPlainObject(flag)) throw new Error("Invalid extension flag");
    only(flag, ["name", "type", "description", "default"], "extension flag");
    if (!text(flag.name, 128) || !FLAG.test(flag.name) || (flag.type !== "boolean" && flag.type !== "string")
      || (flag.description !== undefined && !text(flag.description, extensionLimits.text))
      || (flag.default !== undefined && typeof flag.default !== flag.type) || (typeof flag.default === "string" && !text(flag.default, 4096))) throw new Error("Invalid extension flag");
    return { name: flag.name, type: flag.type, ...(flag.description !== undefined ? { description: flag.description as string } : {}),
      ...(flag.default !== undefined ? { default: flag.default as boolean | string } : {}) } satisfies ExtensionFlag;
  });
  for (const key of ["events", "noops", "ignored"] as const) if (!strings(value[key], 128)) throw new Error("Invalid extension module");
  if (value.error !== undefined && !text(value.error, extensionLimits.text)) throw new Error("Invalid extension error");
  return { path: value.path, tools, events: value.events as string[], flags, noops: value.noops as string[], ignored: value.ignored as string[],
    ...(value.error !== undefined ? { error: value.error as string } : {}) };
}

function parseInstalled(value: unknown): InstalledExtension {
  if (!isPlainObject(value)) throw new Error("Invalid installed extension");
  only(value, ["source", "dev", "name", "version", "description", "modules", "error"], "installed extension");
  if (typeof value.dev !== "boolean" || typeof value.source !== "string") throw new Error("Invalid installed extension");
  const source = value.dev ? (text(value.source, 1024) && value.source.startsWith("local:") ? value.source : undefined) : normalizeExtensionSource(value.source);
  if (!source) throw new Error("Invalid dev extension source");
  for (const key of ["name", "version", "description", "error"] as const) {
    if (value[key] !== undefined && !text(value[key], extensionLimits.text)) throw new Error("Invalid installed extension");
  }
  if (!Array.isArray(value.modules) || value.modules.length > extensionLimits.modulesPerSource) throw new Error("Invalid extension modules");
  return { source, dev: value.dev, ...(value.name !== undefined ? { name: value.name as string } : {}), ...(value.version !== undefined ? { version: value.version as string } : {}),
    ...(value.description !== undefined ? { description: value.description as string } : {}), modules: value.modules.map(parseModule),
    ...(value.error !== undefined ? { error: value.error as string } : {}) };
}

/** A connector's report, as the control plane accepts it. */
export function parseHostExtensionsReport(value: unknown): HostExtensionsReport {
  if (!isPlainObject(value)) throw new Error("Invalid extensions report");
  only(value, ["installed", "remoteInstalls"], "extensions report");
  if (typeof value.remoteInstalls !== "boolean" || !Array.isArray(value.installed) || value.installed.length > extensionLimits.installed + extensionLimits.connector) throw new Error("Invalid extensions report");
  const installed = value.installed.map(parseInstalled);
  if (new Set(installed.map(item => item.source)).size !== installed.length) throw new Error("An extension is reported twice");
  return { installed, remoteInstalls: value.remoteInstalls };
}

/**
 * How a workspace's extension stands on one host: installed at its version, at another, or missing. A built-in one is
 * missing only from connectors that predate it, which an update of the connector brings.
 */
export type ExtensionAvailability = { status: "installed" } | { status: "other-version"; installed: string } | { status: "missing" };

export function extensionAvailability(source: string, installed: readonly InstalledExtension[]): ExtensionAvailability {
  if (installed.some(item => !item.dev && item.source === source)) return { status: "installed" };
  const key = extensionPackageKey(source);
  const other = installed.find(item => !item.dev && extensionPackageKey(item.source) === key);
  return other ? { status: "other-version", installed: other.source } : { status: "missing" };
}

/** An extension the host's owner requires of every session on the host (HostConfig.requiredExtensions in host-config.ts). */
export interface HostRequiredExtension { source: string; settings: ExtensionSettings }

/** One extension a session runs with, and who chose it: the host's owner (`required`), its workspace, or neither (dev). */
export interface ChosenExtension { source: string; dev: boolean; workspace?: WorkspaceExtension; required?: HostRequiredExtension }

/** Whether the host has `source` loaded and usable: installed (or built in) at that exact version, not a dev one, without error. */
const usable = (installed: readonly InstalledExtension[], source: string) => installed.some(item => !item.dev && item.source === source && !item.error);
/**
 * Whether the host has a required `source` whole: usable, and every one of its modules loaded. A guard with a module
 * that failed may be missing the very part that guards, so it counts as missing.
 */
const whole = (installed: readonly InstalledExtension[], source: string) => installed.some(item => !item.dev && item.source === source && !item.error
  && item.modules.every(module => !module.error));

/**
 * The extensions a session runs with: first those its host's owner requires of every session there that the host has,
 * with the owner's settings; then the workspace's enabled ones its host has at that exact version and that loaded, but
 * for a package the host requires (its version and settings win); then, in the host owner's own sessions, the host's dev
 * extensions.
 */
export function sessionExtensions(workspace: readonly WorkspaceExtension[], installed: readonly InstalledExtension[],
  session: { ownerId: string; connectorOwnerId?: string | null }, required: readonly HostRequiredExtension[] = []): ChosenExtension[] {
  const chosen: ChosenExtension[] = [];
  const requiredPackages = new Set(required.map(item => extensionPackageKey(item.source)));
  for (const extension of required) if (whole(installed, extension.source)) chosen.push({ source: extension.source, dev: false, required: extension });
  for (const extension of workspace) {
    if (extension.enabled && !requiredPackages.has(extensionPackageKey(extension.source)) && usable(installed, extension.source)) {
      chosen.push({ source: extension.source, dev: false, workspace: extension });
    }
  }
  if (session.connectorOwnerId && session.ownerId === session.connectorOwnerId) {
    for (const item of installed) if (item.dev && !item.error) chosen.push({ source: item.source, dev: true });
  }
  return chosen;
}

/**
 * The extensions the host's owner requires that the host can't run: not installed at that version (or, for a `piki:`
 * one, not built into its connector), or failing to load, whole or any of its modules. Sessions there take no messages while any is.
 */
export function missingRequiredExtensions(required: readonly HostRequiredExtension[], installed: readonly InstalledExtension[]): string[] {
  return required.filter(item => !whole(installed, item.source)).map(item => item.source);
}

/** An install or removal the host's owner asked for in Pikibun, which the connector carries out when it next syncs. */
export interface ExtensionRequest {
  id: string;
  action: "install" | "remove";
  /** Normalized npm or Git source; never a built-in one. */
  source: string;
}

/** How a request went: done, or why not. */
export interface ExtensionRequestResult {
  id: string;
  ok: boolean;
  error?: string;
}

/**
 * Connector → control plane (`POST /api/connectors/self/extensions`): what is installed, and how the requests it was
 * last given went. The answer lists the requests still to carry out.
 */
export interface ExtensionsSync {
  report: HostExtensionsReport;
  results: ExtensionRequestResult[];
}
export interface ExtensionsSyncAnswer {
  requests: ExtensionRequest[];
}

/** Connector → control plane (`POST /api/connectors/self/extensions/workspace`): one workspace's extensions, for its sessions. */
export interface WorkspaceExtensionsAnswer {
  extensions: WorkspaceExtension[];
  /** The host's owner lets workspaces run extension tools without approval on this host (rule 5). */
  automaticTools: boolean;
}

const REQUEST_ID = /^[A-Za-z0-9_-]{1,64}$/;

export function parseExtensionsSyncAnswer(value: unknown): ExtensionsSyncAnswer {
  if (!isPlainObject(value) || !Array.isArray(value.requests) || value.requests.length > extensionLimits.installed) throw new Error("Invalid extensions answer");
  return { requests: value.requests.map(item => {
    if (!isPlainObject(item) || Object.keys(item).sort().join() !== "action,id,source" || typeof item.id !== "string" || !REQUEST_ID.test(item.id)
      || (item.action !== "install" && item.action !== "remove") || typeof item.source !== "string") throw new Error("Invalid extension request");
    return { id: item.id, action: item.action, source: normalizeExtensionSource(item.source) };
  }) };
}

export function parseWorkspaceExtensionsAnswer(value: unknown): WorkspaceExtensionsAnswer {
  if (!isPlainObject(value) || typeof value.automaticTools !== "boolean") throw new Error("Invalid workspace extensions");
  return { extensions: parseWorkspaceExtensions(value.extensions), automaticTools: value.automaticTools };
}

export function parseExtensionsSync(value: unknown): ExtensionsSync {
  if (!isPlainObject(value) || Object.keys(value).sort().join() !== "report,results" || !Array.isArray(value.results) || value.results.length > extensionLimits.installed) {
    throw new Error("Invalid extensions sync");
  }
  return { report: parseHostExtensionsReport(value.report), results: value.results.map(item => {
    if (!isPlainObject(item) || typeof item.id !== "string" || !REQUEST_ID.test(item.id) || typeof item.ok !== "boolean"
      || Object.keys(item).some(key => !["id", "ok", "error"].includes(key)) || (item.error !== undefined && !text(item.error, extensionLimits.text))) throw new Error("Invalid extension result");
    return { id: item.id, ok: item.ok, ...(item.error !== undefined ? { error: item.error as string } : {}) };
  }) };
}
