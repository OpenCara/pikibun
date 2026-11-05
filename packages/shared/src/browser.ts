/*
 * The browser tool (piki:browser; docs/design/piki-extensions.md, "A browser"): a headless Chromium the agent drives
 * in the session's sandbox, one sandboxed command per call. What the connector, which runs it, and the apps, whose
 * Browser tab shows what it left in the worktree, both need.
 */

/** Where the browser leaves each call's report and screenshots, relative to the worktree (browser.py's OUTPUT). */
export const BROWSER_OUTPUT = "browser-output";
/** How many calls' reports and screenshots it keeps there, the newest (browser.py's KEPT). */
export const BROWSER_KEPT = 30;

/** What a call can do on the page, in order, after opening its url. */
export const browserActions = Object.freeze(["goto", "click", "type", "press", "select", "hover", "scroll", "wait", "evaluate", "screenshot",
  "back", "forward", "reload"] as const);
export type BrowserActionName = (typeof browserActions)[number];

/** The keys `press` names; any single character goes as well. */
export const browserKeys = Object.freeze(["Enter", "Tab", "Escape", "Backspace", "Delete", "Space", "ArrowUp", "ArrowDown", "ArrowLeft",
  "ArrowRight", "Home", "End", "PageUp", "PageDown"] as const);

export const browserLimits = Object.freeze({
  actions: 50,
  url: 4096,
  selector: 1024,
  text: 4096,
  expression: 4096,
  /** Seconds a navigation or a wait may take; the command's own time limit bounds the whole call. */
  timeoutSeconds: { min: 1, max: 120, default: 30 },
  /** Seconds a serve command's port may take to answer. */
  serveSeconds: { min: 1, max: 600, default: 60 },
  waitMs: 60_000,
  viewport: { minWidth: 200, maxWidth: 3840, minHeight: 200, maxHeight: 2160, width: 1280, height: 800 },
});

export interface BrowserAction {
  action: BrowserActionName;
  url?: string;
  /** A CSS selector, or text=<visible text>. */
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

/**
 * The web app under test, started for the call without a shell: one of the node or python tools' programs, with its
 * arguments, in a worktree directory (and for Python's, optionally a virtual environment there), and the port it
 * listens on.
 */
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

/** One call's report, as the driver writes it (browser-output/<stamp>.json) and prints it. */
export interface BrowserReport {
  time?: string;
  /** The call's request, in the report file; the printed report leaves it out. */
  request?: BrowserRequest;
  /** The page the call opened again, as it named none. */
  reopened?: string;
  actions?: { action: string; ok: boolean; error?: string; value?: string; note?: string; screenshot?: string }[];
  /** What went wrong: an action that failed (the rest are `skipped`), or the page or browser itself. */
  error?: string;
  skipped?: number;
  url?: string;
  title?: string;
  status?: number;
  text?: string;
  text_truncated?: boolean;
  elements?: BrowserElement[];
  page_size?: { width: number; height: number };
  /** The page as the call left it, a worktree path. */
  screenshot?: string;
  console?: { level: string; text: string; source?: string }[];
  page_errors?: string[];
  failed_requests?: { url: string; error?: string; status?: number }[];
  serve_output?: string;
  seconds?: number;
  /** Where the report itself is, in the printed report. */
  report?: string;
}

/** A report file's name in BROWSER_OUTPUT: its call's time, which its screenshots' names start with. */
export const BROWSER_REPORT_NAME = /^(\d{8}-\d{6}-\d{3})\.json$/;
/** A screenshot's worktree path, as a report names it. */
export const BROWSER_SCREENSHOT_PATH = new RegExp(`^${BROWSER_OUTPUT}/\\d{8}-\\d{6}-\\d{3}(?:-\\d{1,3})?\\.(?:png|jpg)$`);

const isObject = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);

/** The fields of `value` named in `keys` that are of `type`, as an object holding only those. */
function typed(value: Record<string, unknown>, type: "string" | "number" | "boolean", keys: readonly string[]): Record<string, unknown> {
  return Object.fromEntries(keys.flatMap(key => typeof value[key] === type && (type !== "number" || Number.isFinite(value[key])) ? [[key, value[key]]] : []));
}

/** A report's copy of its call's request, rebuilt from what has the expected types: the Browser tab renders it. */
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

/**
 * `text` as a browser report, or undefined. The driver writes it, but the worktree is the agent's to change, so whoever
 * shows one takes only what has the expected shape.
 */
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

/*
 * Where a host's Chromium comes from (HostConfig.browser), as its owner chooses on its page: found on the host, at a path
 * they give, downloaded by the connector, or none.
 */
export const browserSources = Object.freeze(["auto", "path", "download", "off"] as const);
export type BrowserSource = (typeof browserSources)[number];

export interface HostBrowserConfig {
  /**
   * auto: the connector looks for one (PIKIBUN_BROWSER, the distributions' and vendors' installs, Playwright's and
   * Puppeteer's downloads, then one it downloaded); path: the Chromium executable at `path`, or none; download: Chrome for
   * Testing's headless shell, which the connector downloads and keeps up to date; off: no browser for sessions here.
   */
  source: BrowserSource;
  /** With `path`: the executable's absolute path on the host. */
  path?: string;
}

export const defaultHostBrowserConfig: Readonly<HostBrowserConfig> = Object.freeze({ source: "auto" });
const BROWSER_PATH_LIMIT = 4096;

/** A host's browser setting: a known source, and an absolute path with `path` only. */
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

/**
 * How a host's browser stands, as its connector reports it with its extensions:
 * - ready: sessions in its sandbox get the browser tool;
 * - missing: none was found, or the path its owner gave isn't a Chromium installation (`error` says which);
 * - downloading: the connector is downloading one (`error` says why the last try failed, if it did);
 * - failed: its download failed (`error`), and is tried again later;
 * - off: its owner turned the browser off;
 * - unsupported: its sessions have no Linux sandbox for it (macOS and Windows sandboxes, hosts without the sandbox).
 */
export const browserStates = Object.freeze(["ready", "missing", "downloading", "failed", "off", "unsupported"] as const);
export type BrowserState = (typeof browserStates)[number];

export interface HostBrowserStatus {
  source: BrowserSource;
  state: BrowserState;
  /** The Chromium sessions run, as its host has it: its owner's to see, not the workspaces'. */
  executable?: string;
  /** Its version, where the connector knows it: one it downloaded. */
  version?: string;
  error?: string;
  /** The connector can download one on this host (Linux on x86-64, which Chrome for Testing builds for). */
  downloadable: boolean;
}

const BROWSER_TEXT_LIMIT = 1024;

/** A reported browser status, as the control plane accepts it. */
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

/**
 * Why a session whose workspace has the browser tool on can't use it (SessionView.extensions.unavailable): fixed reasons,
 * so nothing of its host's files or errors reaches the session's viewers.
 */
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

/** What to tell a session's people, and its agent, of why it has no browser. */
export function browserUnavailableText(reason: string): string {
  return browserUnavailableTexts[reason as BrowserUnavailableReason] ?? "This session can't use the browser on its host.";
}

/** The reason a session on a host whose browser stands at `state` has none; undefined when it has one. */
export function browserUnavailableReason(state: BrowserState): BrowserUnavailableReason | undefined {
  return state === "ready" ? undefined : state === "unsupported" ? "sandbox" : state;
}
