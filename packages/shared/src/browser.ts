export const BROWSER_OUTPUT = "browser-output";
export const BROWSER_KEPT = 30;

export const browserActions = Object.freeze(["goto", "click", "type", "press", "select", "hover", "scroll", "wait", "evaluate", "screenshot",
  "back", "forward", "reload"] as const);
export type BrowserActionName = (typeof browserActions)[number];

export const browserKeys = Object.freeze(["Enter", "Tab", "Escape", "Backspace", "Delete", "Space", "ArrowUp", "ArrowDown", "ArrowLeft",
  "ArrowRight", "Home", "End", "PageUp", "PageDown"] as const);

export const browserLimits = Object.freeze({
  actions: 50,
  url: 4096,
  selector: 1024,
  text: 4096,
  expression: 4096,
  timeoutSeconds: { min: 1, max: 120, default: 30 },
  serveSeconds: { min: 1, max: 600, default: 60 },
  waitMs: 60_000,
  viewport: { minWidth: 200, maxWidth: 3840, minHeight: 200, maxHeight: 2160, width: 1280, height: 800 },
});

export interface BrowserAction {
  action: BrowserActionName;
  url?: string;
  selector?: string;
  text?: string;
  key?: string;
  value?: string;
  x?: number;
  y?: number;
  ms?: number;
  expression?: string;
  full_page?: boolean;
  submit?: boolean;
  clear?: boolean;
}

export interface BrowserServe {
  program: string;
  args?: string[];
  directory?: string;
  venv?: string;
  port: number;
  timeout_seconds?: number;
}

export interface BrowserRequest {
  url?: string;
  actions?: BrowserAction[];
  viewport?: { width: number; height: number };
  full_page?: boolean;
  timeout_seconds?: number;
  serve?: BrowserServe;
}

export interface BrowserElement {
  selector: string;
  tag: string;
  type?: string;
  text?: string;
  href?: string;
  disabled?: boolean;
  checked?: boolean;
}

export interface BrowserReport {
  time?: string;
  request?: BrowserRequest;
  reopened?: string;
  actions?: { action: string; ok: boolean; error?: string; value?: string; note?: string; screenshot?: string }[];
  error?: string;
  skipped?: number;
  url?: string;
  title?: string;
  status?: number;
  text?: string;
  text_truncated?: boolean;
  elements?: BrowserElement[];
  page_size?: { width: number; height: number };
  screenshot?: string;
  console?: { level: string; text: string; source?: string }[];
  page_errors?: string[];
  failed_requests?: { url: string; error?: string; status?: number }[];
  serve_output?: string;
  seconds?: number;
  report?: string;
}

export const BROWSER_REPORT_NAME = /^(\d{8}-\d{6}-\d{3})\.json$/;
export const BROWSER_SCREENSHOT_PATH = new RegExp(`^${BROWSER_OUTPUT}/\\d{8}-\\d{6}-\\d{3}(?:-\\d{1,3})?\\.(?:png|jpg)$`);

const isObject = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);

function typed(value: Record<string, unknown>, type: "string" | "number" | "boolean", keys: readonly string[]): Record<string, unknown> {
  return Object.fromEntries(keys.flatMap(key => typeof value[key] === type && (type !== "number" || Number.isFinite(value[key])) ? [[key, value[key]]] : []));
}

function reportRequest(value: unknown): BrowserRequest | undefined {
  if (!isObject(value)) return undefined;
  const request: BrowserRequest = { ...typed(value, "string", ["url"]), ...typed(value, "boolean", ["full_page"]), ...typed(value, "number", ["timeout_seconds"]) };
  if (Array.isArray(value.actions)) {
    request.actions = value.actions.flatMap(item => isObject(item) && (browserActions as readonly unknown[]).includes(item.action) ? [{
      action: item.action as BrowserActionName, ...typed(item, "string", ["url", "selector", "text", "key", "value", "expression"]),
      ...typed(item, "number", ["x", "y", "ms"]), ...typed(item, "boolean", ["full_page", "submit", "clear"]),
    }] : []);
  }
  if (isObject(value.viewport) && typeof value.viewport.width === "number" && typeof value.viewport.height === "number") {
    request.viewport = { width: value.viewport.width, height: value.viewport.height };
  }
  const serve = value.serve;
  if (isObject(serve) && typeof serve.program === "string" && typeof serve.port === "number") {
    request.serve = { program: serve.program, port: serve.port, ...typed(serve, "string", ["directory", "venv"]), ...typed(serve, "number", ["timeout_seconds"]),
      ...(Array.isArray(serve.args) ? { args: serve.args.filter((arg): arg is string => typeof arg === "string") } : {}) };
  }
  return request;
}

export function parseBrowserReport(text: string): BrowserReport | undefined {
  let value: unknown;
  try { value = JSON.parse(text); } catch { return undefined; }
  if (!isObject(value)) return undefined;
  const string = (key: string) => typeof value[key] === "string" ? value[key] as string : undefined;
  const list = <T>(key: string, item: (entry: Record<string, unknown>) => T | undefined): T[] | undefined =>
    Array.isArray(value[key]) ? (value[key] as unknown[]).flatMap(entry => { const parsed = isObject(entry) ? item(entry) : undefined; return parsed === undefined ? [] : [parsed]; }) : undefined;
  const text_ = (entry: Record<string, unknown>, key: string) => typeof entry[key] === "string" ? entry[key] as string : undefined;
  const report: BrowserReport = {};
  for (const key of ["time", "reopened", "error", "url", "title", "text", "serve_output", "report"] as const) {
    const found = string(key);
    if (found !== undefined) report[key] = found;
  }
  const screenshot = string("screenshot");
  if (screenshot !== undefined && BROWSER_SCREENSHOT_PATH.test(screenshot)) report.screenshot = screenshot;
  for (const key of ["status", "skipped", "seconds"] as const) if (typeof value[key] === "number" && Number.isFinite(value[key])) report[key] = value[key] as number;
  if (value.text_truncated === true) report.text_truncated = true;
  if (isObject(value.page_size) && typeof value.page_size.width === "number" && typeof value.page_size.height === "number") {
    report.page_size = { width: value.page_size.width, height: value.page_size.height };
  }
  const request = reportRequest(value.request);
  if (request) report.request = request;
  const actions = list("actions", entry => typeof entry.action === "string" && typeof entry.ok === "boolean" ? {
    action: entry.action, ok: entry.ok,
    ...Object.fromEntries((["error", "value", "note"] as const).flatMap(key => text_(entry, key) !== undefined ? [[key, text_(entry, key)]] : [])),
    ...(typeof entry.screenshot === "string" && BROWSER_SCREENSHOT_PATH.test(entry.screenshot) ? { screenshot: entry.screenshot } : {}),
  } : undefined);
  if (actions) report.actions = actions;
  const elements = list("elements", entry => typeof entry.selector === "string" && typeof entry.tag === "string" ? {
    selector: entry.selector, tag: entry.tag,
    ...Object.fromEntries((["type", "text", "href"] as const).flatMap(key => text_(entry, key) !== undefined ? [[key, text_(entry, key)]] : [])),
    ...(entry.disabled === true ? { disabled: true } : {}), ...(typeof entry.checked === "boolean" ? { checked: entry.checked } : {}),
  } : undefined);
  if (elements) report.elements = elements;
  const console = list("console", entry => typeof entry.level === "string" && typeof entry.text === "string"
    ? { level: entry.level, text: entry.text, ...(typeof entry.source === "string" && entry.source ? { source: entry.source } : {}) } : undefined);
  if (console) report.console = console;
  if (Array.isArray(value.page_errors)) report.page_errors = value.page_errors.filter((entry): entry is string => typeof entry === "string");
  const failed = list("failed_requests", entry => typeof entry.url === "string" ? {
    url: entry.url, ...(typeof entry.error === "string" ? { error: entry.error } : {}), ...(typeof entry.status === "number" ? { status: entry.status } : {}),
  } : undefined);
  if (failed) report.failed_requests = failed;
  return report;
}

export const browserSources = Object.freeze(["auto", "path", "download", "off"] as const);
export type BrowserSource = (typeof browserSources)[number];

export interface HostBrowserConfig {
  source: BrowserSource;
  path?: string;
}

export const defaultHostBrowserConfig: Readonly<HostBrowserConfig> = Object.freeze({ source: "auto" });
const BROWSER_PATH_LIMIT = 4096;

export function parseHostBrowserConfig(value: unknown): HostBrowserConfig {
  if (!isObject(value) || Object.keys(value).some(key => key !== "source" && key !== "path")) throw new Error("Invalid browser setting");
  if (!(browserSources as readonly unknown[]).includes(value.source)) throw new Error(`The browser comes from ${browserSources.join(", ")}`);
  const source = value.source as BrowserSource;
  if (source !== "path") {
    if (value.path !== undefined) throw new Error("A browser path goes with source path");
    return { source };
  }
  const path = value.path;
  if (typeof path !== "string" || !path.startsWith("/") || path.length > BROWSER_PATH_LIMIT || path.includes("\0") || /[\r\n]/.test(path)) {
    throw new Error("The browser's path is the absolute path of a Chromium executable on the host, such as /usr/lib/chromium/chromium");
  }
  return { source, path };
}

export const browserStates = Object.freeze(["ready", "missing", "downloading", "failed", "off", "unsupported"] as const);
export type BrowserState = (typeof browserStates)[number];

export interface HostBrowserStatus {
  source: BrowserSource;
  state: BrowserState;
  executable?: string;
  version?: string;
  error?: string;
  downloadable: boolean;
}

const BROWSER_TEXT_LIMIT = 1024;
export const hostBrowserStatusLimits = Object.freeze({ executable: BROWSER_PATH_LIMIT, text: BROWSER_TEXT_LIMIT });

export function parseHostBrowserStatus(value: unknown): HostBrowserStatus {
  if (!isObject(value) || Object.keys(value).some(key => !["source", "state", "executable", "version", "error", "downloadable"].includes(key))) {
    throw new Error("Invalid browser status");
  }
  if (!(browserSources as readonly unknown[]).includes(value.source) || !(browserStates as readonly unknown[]).includes(value.state)
    || typeof value.downloadable !== "boolean") throw new Error("Invalid browser status");
  const status: HostBrowserStatus = { source: value.source as BrowserSource, state: value.state as BrowserState, downloadable: value.downloadable };
  for (const key of ["executable", "version", "error"] as const) {
    const item = value[key];
    if (item === undefined) continue;
    if (typeof item !== "string" || item.length > (key === "executable" ? BROWSER_PATH_LIMIT : BROWSER_TEXT_LIMIT) || item.includes("\0")) throw new Error("Invalid browser status");
    status[key] = item;
  }
  return status;
}

export const browserUnavailableReasons = Object.freeze(["on-host", "sandbox", "off", "missing", "downloading", "failed"] as const);
export type BrowserUnavailableReason = (typeof browserUnavailableReasons)[number];

const browserUnavailableTexts: Readonly<Record<BrowserUnavailableReason, string>> = Object.freeze({
  "on-host": "The browser runs only in a session's sandbox, and this session runs on its host itself.",
  sandbox: "This host's sandbox can't run the browser yet: it runs in the Linux sandbox only.",
  off: "This host's owner turned the browser off for its sessions.",
  missing: "This host has no Chromium for the browser. Its owner can find one installed there, give its path or download one, under Settings → Hosts → the host → Extensions.",
  downloading: "This host is downloading Chromium for the browser: the tool is offered once it is ready, within a few minutes.",
  failed: "This host couldn't download Chromium for the browser. It tries again later; its owner can see why, or set one up another way, under Settings → Hosts → the host → Extensions.",
});

export function browserUnavailableText(reason: string): string {
  return browserUnavailableTexts[reason as BrowserUnavailableReason] ?? "This session can't use the browser on its host.";
}

export function browserUnavailableReason(state: BrowserState): BrowserUnavailableReason | undefined {
  return state === "ready" ? undefined : state === "unsupported" ? "sandbox" : state;
}
