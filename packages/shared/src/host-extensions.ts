import { pikiExtension, pikiExtensions, pikiSessionToolExtensions } from "./piki-extensions.js";
import { parseHostBrowserStatus, type HostBrowserStatus } from "./browser.js";
import { parseHostTunnelStatus, type HostTunnelStatus } from "./tunnel.js";
import { parseMemberToolGroups, type MemberToolGroup } from "./tool-groups.js";
import { parseManagedExtensions, type ManagedExtensionPin } from "./managed-extensions.js";
import { parseToolDefinition, toolDefinitionLimits, type BrokeredToolDefinition } from "./tool-definitions.js";
import { parseRemoteMcpServers, type RemoteMcpServerSummary } from "./remote-mcp.js";

export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

export const extensionToolModes = ["approval", "automatic"] as const;
export type ExtensionToolMode = (typeof extensionToolModes)[number];

export type ExtensionSourceSpec = { kind: "npm"; package: string; version: string } | { kind: "git"; url: string; commit: string; path?: string }
  | { kind: "piki"; name: string };

export const EXACT_VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
export const PACKAGE_NAME = /^(?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*$/;
const COMMIT = /^[0-9a-f]{40}$/;
export const PIKI_NAME = /^[a-z][a-z0-9-]{0,63}$/;
export const EXTENSION_INTEGRITY = /^sha512-[A-Za-z0-9+/]{86}==$/;

export function isExtensionIntegrity(value: unknown): value is string {
  return typeof value === "string" && EXTENSION_INTEGRITY.test(value);
}

export class ExtensionSourceError extends Error {}

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
    const hash = spec.indexOf("#");
    const path = hash < 0 ? undefined : spec.slice(hash + 1);
    const rest = spec.slice(4, hash < 0 ? undefined : hash);
    if (path !== undefined && !gitSourcePath(path)) {
      throw new ExtensionSourceError(`Name a directory of the repository after #, such as extensions/name: relative, without . or .., in letters, digits and ._@-`);
    }
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
    return { kind: "git", url: parsed.href.replace(/\/$/, "").replace(/\.git$/, ""), commit, ...(path !== undefined ? { path } : {}) };
  }
  throw new ExtensionSourceError("An extension source is npm:<package>@<version>, git:<https URL>@<commit>[#<directory>] or piki:<name>.");
}

export function extensionSourceString(spec: ExtensionSourceSpec): string {
  return spec.kind === "npm" ? `npm:${spec.package}@${spec.version}` : spec.kind === "git" ? `git:${spec.url}@${spec.commit}${spec.path ? `#${spec.path}` : ""}` : `piki:${spec.name}`;
}

export const GIT_PATH_LIMIT = 200;
const GIT_PATH_SEGMENT = /^[A-Za-z0-9._@-]+$/;

export function gitSourcePath(path: string): boolean {
  if (!path || path.length > GIT_PATH_LIMIT) return false;
  return path.split("/").every(segment => GIT_PATH_SEGMENT.test(segment) && segment !== "." && segment !== "..");
}

export function inRepositoryDirectory(source: string): boolean {
  return source.startsWith("git:") && source.includes("#");
}

export function isPikiExtensionSource(source: string): boolean {
  return source.startsWith("piki:");
}

export function normalizeExtensionSource(spec: string): string {
  return extensionSourceString(parseExtensionSourceSpec(spec));
}

export function extensionPackageKey(source: string): string {
  const spec = parseExtensionSourceSpec(source);
  return spec.kind === "npm" ? `npm:${spec.package}` : spec.kind === "git" ? `git:${spec.url}${spec.path ? `#${spec.path}` : ""}` : `piki:${spec.name}`;
}

export interface ExtensionFlag {
  name: string;
  type: "boolean" | "string";
  description?: string;
  default?: boolean | string;
}

export interface ExtensionModuleSummary {
  path: string;
  tools: { name: string; description: string }[];
  events: string[];
  flags: ExtensionFlag[];
  noops: string[];
  ignored: string[];
  error?: string;
}

export interface InstalledExtension {
  source: string;
  dev: boolean;
  name?: string;
  version?: string;
  description?: string;
  modules: ExtensionModuleSummary[];
  error?: string;
}

export interface HostExtensionsReport {
  installed: InstalledExtension[];
  remoteInstalls: boolean;
  browser?: HostBrowserStatus;
  tunnel?: HostTunnelStatus;
  autoCache?: boolean;
  autoCacheRefused?: true;
}

export type ExtensionSettings = Record<string, boolean | string>;

export interface WorkspaceExtension {
  source: string;
  enabled: boolean;
  tools: ExtensionToolMode;
  settings: ExtensionSettings;
  integrity?: string;
}

export interface RegistryExtensionMetadata {
  name: string;
  version: string;
  description?: string;
}

export function withoutExtensionLocks(extensions: readonly WorkspaceExtension[]): WorkspaceExtension[] {
  return extensions.map(({ integrity: _integrity, ...rest }) => rest);
}

const WEB_ACCESS = "npm:pi-web-access@0.46.0";

export const defaultExtensionIntegrity: Readonly<Record<string, string>> = Object.freeze({
  [WEB_ACCESS]: "sha512-UfeJKU0TPmQU/3hmfAC5Ot/e5Ib0uHkg2+VHM7Ae4kVilLZf7ocGqHFzBzOkYuGLZ87LobzkrhwTAq8lO/N7cQ==",
});

export const starterWorkspaceExtensions: readonly string[] = Object.freeze([
  WEB_ACCESS,
  "piki:context-files",
  "piki:git",
  "piki:gh",
  "piki:github",
  "piki:node",
  "piki:python",
  "piki:schedule",
  "piki:sessions",
  "piki:workspace",
  "piki:artifacts",
  "piki:skills",
]);

export const defaultWorkspaceExtensions: readonly string[] = Object.freeze([
  WEB_ACCESS,
  "npm:pi-web-search@1.7.0",
  "npm:cc-safety-net@2.7.2",
  "piki:prompt-audit",
  ...starterWorkspaceExtensions.filter(source => source !== WEB_ACCESS),
]);

export function withSessionToolsListed(extensions: readonly WorkspaceExtension[]): WorkspaceExtension[] {
  const listed = new Set(extensions.map(item => extensionPackageKey(item.source)));
  const replaced = new Set<string>(pikiExtensions.flatMap(item => item.replaces ? [item.replaces] : []));
  const unlisted = pikiSessionToolExtensions().filter(item => !item.core && !replaced.has(item.source) && !listed.has(item.source));
  return [...extensions, ...unlisted.map(item => ({ source: item.source, enabled: false, tools: "automatic" as const, settings: {} }))];
}

export const extensionLimits = Object.freeze({
  workspace: 32,
  installed: 64,
  connector: 32,
  modulesPerSource: 16,
  toolsPerModule: 64,
  flagsPerModule: 64,
  text: 1024,
  toolDescription: 4096,
  settingsBytes: 16 * 1024,
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
  only(value, ["source", "enabled", "tools", "settings", "integrity"], "extension");
  if (typeof value.source !== "string") throw new Error("Invalid extension source");
  const source = normalizeExtensionSource(value.source);
  const enabled = value.enabled ?? true;
  const tools = value.tools ?? "automatic";
  if (typeof enabled !== "boolean") throw new Error("Invalid extension setting");
  if (!extensionToolModes.includes(tools as ExtensionToolMode)) throw new Error("Invalid extension tools mode");
  if (value.integrity !== undefined && (!source.startsWith("npm:") || !isExtensionIntegrity(value.integrity))) {
    throw new Error("An extension's integrity is a sha512-... digest of an npm package");
  }
  return { source, enabled, tools: "automatic", settings: parseExtensionSettings(value.settings ?? {}),
    ...(value.integrity !== undefined ? { integrity: value.integrity } : {}) };
}

export function parseRegistryExtensionMetadata(value: unknown): RegistryExtensionMetadata {
  if (!isPlainObject(value)) throw new Error("Invalid registry metadata");
  only(value, ["name", "version", "description"], "registry metadata");
  if (!text(value.name, 214) || !PACKAGE_NAME.test(value.name) || !text(value.version, 64) || !EXACT_VERSION.test(value.version)) {
    throw new Error("Invalid registry metadata");
  }
  if (value.description !== undefined && !text(value.description, extensionLimits.text)) throw new Error("Invalid registry metadata");
  return { name: value.name, version: value.version, ...(value.description !== undefined ? { description: value.description } : {}) };
}

export function parseWorkspaceExtensions(value: unknown): WorkspaceExtension[] {
  const sessionTools = pikiSessionToolExtensions().map(item => item.source as string);
  if (!Array.isArray(value) || value.length > extensionLimits.workspace + sessionTools.length + extensionLimits.connector) throw new Error("Invalid extensions");
  const extensions = value.map(parseWorkspaceExtension);
  const placed = extensions.filter(extension => !sessionTools.includes(extension.source) && !(isPikiExtensionSource(extension.source) && !pikiExtension(extension.source)));
  if (placed.length > extensionLimits.workspace) throw new Error("Invalid extensions");
  const keys = extensions.map(extension => extensionPackageKey(extension.source));
  if (new Set(keys).size !== keys.length) throw new Error("A workspace uses one version of each extension");
  return extensions;
}

export function parseExtensionModules(value: unknown): ExtensionModuleSummary[] {
  if (!Array.isArray(value) || value.length > extensionLimits.modulesPerSource) throw new Error("Invalid extension modules");
  return value.map(parseModule);
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

export function parseHostExtensionsReport(value: unknown): HostExtensionsReport {
  if (!isPlainObject(value)) throw new Error("Invalid extensions report");
  only(value, ["installed", "remoteInstalls", "browser", "tunnel", "autoCache", "autoCacheRefused"], "extensions report");
  if ((value.autoCache !== undefined && typeof value.autoCache !== "boolean") || (value.autoCacheRefused !== undefined && value.autoCacheRefused !== true)) {
    throw new Error("Invalid extensions report");
  }
  if (typeof value.remoteInstalls !== "boolean" || !Array.isArray(value.installed) || value.installed.length > extensionLimits.installed + extensionLimits.connector) throw new Error("Invalid extensions report");
  const installed = value.installed.map(parseInstalled);
  if (new Set(installed.map(item => item.source)).size !== installed.length) throw new Error("An extension is reported twice");
  return { installed, remoteInstalls: value.remoteInstalls, ...(value.browser !== undefined ? { browser: parseHostBrowserStatus(value.browser) } : {}),
    ...(value.tunnel !== undefined ? { tunnel: parseHostTunnelStatus(value.tunnel) } : {}),
    ...(typeof value.autoCache === "boolean" ? { autoCache: value.autoCache } : {}),
    ...(value.autoCacheRefused === true ? { autoCacheRefused: true as const } : {}) };
}

export type ExtensionAvailability = { status: "installed" } | { status: "auto-cache" } | { status: "other-version"; installed: string } | { status: "missing" };

export function extensionAvailability(source: string, installed: readonly InstalledExtension[],
  options?: { integrity?: string; autoCache?: boolean }): ExtensionAvailability {
  if (installed.some(item => !item.dev && item.source === source)) return { status: "installed" };
  if (options?.autoCache && source.startsWith("npm:") && isExtensionIntegrity(options.integrity)) return { status: "auto-cache" };
  const key = extensionPackageKey(source);
  const other = installed.find(item => !item.dev && extensionPackageKey(item.source) === key);
  return other ? { status: "other-version", installed: other.source } : { status: "missing" };
}

export interface HostRequiredExtension { source: string; settings: ExtensionSettings; allowModelCalls?: true }

export interface ChosenExtension { source: string; dev: boolean; workspace?: WorkspaceExtension; required?: HostRequiredExtension }

const usable = (installed: readonly InstalledExtension[], source: string) => installed.some(item => !item.dev && item.source === source && !item.error);
const whole = (installed: readonly InstalledExtension[], source: string) => installed.some(item => !item.dev && item.source === source && !item.error
  && item.modules.every(module => !module.error));

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

export function missingRequiredExtensions(required: readonly HostRequiredExtension[], installed: readonly InstalledExtension[]): string[] {
  return required.filter(item => !whole(installed, item.source)).map(item => item.source);
}

export interface ExtensionRequest {
  id: string;
  action: "install" | "remove";
  source: string;
}

export interface ExtensionRequestResult {
  id: string;
  ok: boolean;
  error?: string;
}

export interface ExtensionsSync {
  report: HostExtensionsReport;
  results: ExtensionRequestResult[];
}
export interface ExtensionsSyncAnswer {
  requests: ExtensionRequest[];
  managed?: ManagedExtensionPin[];
  reportAutoCache?: true;
}

export interface WorkspaceExtensionsAnswer {
  extensions: WorkspaceExtension[];
  automaticTools: boolean;
  autoCache?: boolean;
  toolGroups?: Record<string, MemberToolGroup>;
  ownerPrivate?: true;
  remoteTools?: BrokeredToolDefinition[];
  remoteServers?: RemoteMcpServerSummary[];
}

function parseRemoteTools(value: unknown): BrokeredToolDefinition[] {
  if (!Array.isArray(value) || value.length > toolDefinitionLimits.definitions) throw new Error("Invalid workspace extensions");
  const tools: BrokeredToolDefinition[] = [];
  for (const item of value) {
    let definition;
    try { definition = parseToolDefinition(item); } catch { continue; }
    if (definition.kind === "brokered" && definition.inputSchema && !tools.some(other => other.name === definition.name)) tools.push(definition);
  }
  return tools;
}

const REQUEST_ID = /^[A-Za-z0-9_-]{1,64}$/;

export function parseExtensionsSyncAnswer(value: unknown): ExtensionsSyncAnswer {
  if (!isPlainObject(value) || !Array.isArray(value.requests) || value.requests.length > extensionLimits.installed) throw new Error("Invalid extensions answer");
  return { requests: value.requests.map(item => {
    if (!isPlainObject(item) || Object.keys(item).sort().join() !== "action,id,source" || typeof item.id !== "string" || !REQUEST_ID.test(item.id)
      || (item.action !== "install" && item.action !== "remove") || typeof item.source !== "string") throw new Error("Invalid extension request");
    return { id: item.id, action: item.action, source: normalizeExtensionSource(item.source) };
  }), ...(value.managed !== undefined ? { managed: parseManagedExtensions(value.managed) } : {}),
    ...(value.reportAutoCache === true ? { reportAutoCache: true as const } : {}) };
}

export function parseWorkspaceExtensionsAnswer(value: unknown): WorkspaceExtensionsAnswer {
  if (!isPlainObject(value) || typeof value.automaticTools !== "boolean") throw new Error("Invalid workspace extensions");
  if (value.autoCache !== undefined && typeof value.autoCache !== "boolean") throw new Error("Invalid workspace extensions");
  const toolGroups = parseMemberToolGroups(value.toolGroups);
  return { extensions: parseWorkspaceExtensions(value.extensions), automaticTools: value.automaticTools,
    ...(typeof value.autoCache === "boolean" ? { autoCache: value.autoCache } : {}), ...(Object.keys(toolGroups).length ? { toolGroups } : {}),
    ...(value.ownerPrivate === true ? { ownerPrivate: true as const } : {}),
    ...(value.remoteTools !== undefined ? { remoteTools: parseRemoteTools(value.remoteTools) } : {}),
    ...(value.remoteServers !== undefined ? { remoteServers: parseRemoteMcpServers(value.remoteServers) } : {}) };
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
