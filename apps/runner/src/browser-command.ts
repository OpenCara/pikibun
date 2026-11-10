import { browserActions, browserKeys, browserLimits, type BrowserAction, type BrowserActionName, type BrowserRequest, type BrowserServe } from "../../../packages/shared/src/browser.js";
import { nodePrograms, nodeRequest } from "./node-command.js";
import { pythonPrograms, pythonRequest } from "./python-command.js";
import { programShellCommand, shellQuote } from "./program-command.js";

export interface SessionBrowser {
  driver: string;
  chromium: string;
}

const fields: Record<BrowserActionName, { needs: readonly string[]; takes: readonly string[] }> = {
  goto: { needs: ["url"], takes: [] },
  click: { needs: [], takes: ["selector", "x", "y"] },
  hover: { needs: [], takes: ["selector", "x", "y"] },
  type: { needs: ["text"], takes: ["selector", "submit", "clear"] },
  press: { needs: ["key"], takes: [] },
  select: { needs: ["selector", "value"], takes: [] },
  scroll: { needs: [], takes: ["selector", "x", "y"] },
  wait: { needs: [], takes: ["selector", "text", "ms"] },
  evaluate: { needs: ["expression"], takes: [] },
  screenshot: { needs: [], takes: ["full_page"] },
  back: { needs: [], takes: [] },
  forward: { needs: [], takes: [] },
  reload: { needs: [], takes: [] },
};

const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);

function text(value: unknown, name: string, max: number, empty = false): string {
  if (typeof value !== "string" || (!empty && !value.trim()) || value.length > max || value.includes("\0")) {
    throw new Error(`${name} is ${empty ? "" : "non-empty "}text of at most ${max} characters`);
  }
  return value;
}

function integer(value: unknown, name: string, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) throw new Error(`${name} is a whole number from ${min} to ${max}`);
  return value;
}

function flag(value: unknown, name: string): boolean {
  if (typeof value !== "boolean") throw new Error(`${name} is true or false`);
  return value;
}

export function browserUrl(value: unknown, name = "url"): string {
  const url = text(value, name, browserLimits.url).trim();
  let parsed: URL;
  try { parsed = new URL(url); } catch { throw new Error(`${name} is a whole URL, such as http://localhost:5173/ or https://example.com/`); }
  if (!["http:", "https:", "file:"].includes(parsed.protocol) && url !== "about:blank") {
    throw new Error(`${name} is an http, https or file URL, or about:blank`);
  }
  return url;
}

function action(value: unknown, index: number): BrowserAction {
  const at = `actions[${index}]`;
  if (!object(value) || typeof value.action !== "string" || !(browserActions as readonly string[]).includes(value.action)) {
    throw new Error(`${at}.action is one of ${browserActions.join(", ")}`);
  }
  const kind = value.action as BrowserActionName;
  const { needs, takes } = fields[kind];
  for (const key of Object.keys(value)) {
    if (key !== "action" && !needs.includes(key) && !takes.includes(key) && value[key] !== undefined) {
      throw new Error(`${at}: ${kind} takes ${[...needs, ...takes].join(", ") || "nothing else"}, not ${key}`);
    }
  }
  for (const key of needs) if (value[key] === undefined) throw new Error(`${at}: ${kind} needs ${key}`);
  const result: BrowserAction = { action: kind };
  if (value.url !== undefined) result.url = browserUrl(value.url, `${at}.url`);
  if (value.selector !== undefined) result.selector = text(value.selector, `${at}.selector`, browserLimits.selector);
  if (value.text !== undefined) result.text = text(value.text, `${at}.text`, browserLimits.text, kind === "type");
  if (value.key !== undefined) {
    result.key = text(value.key, `${at}.key`, 16);
    if (!(browserKeys as readonly string[]).includes(result.key) && [...result.key].length !== 1) {
      throw new Error(`${at}.key is one of ${browserKeys.join(", ")}, or a single character`);
    }
  }
  if (value.value !== undefined) result.value = text(value.value, `${at}.value`, browserLimits.text, true);
  for (const key of ["x", "y"] as const) if (value[key] !== undefined) result[key] = integer(value[key], `${at}.${key}`, kind === "scroll" ? -100_000 : 0, 100_000);
  if (value.ms !== undefined) result.ms = integer(value.ms, `${at}.ms`, 0, browserLimits.waitMs);
  if (value.expression !== undefined) result.expression = text(value.expression, `${at}.expression`, browserLimits.expression);
  for (const key of ["full_page", "submit", "clear"] as const) if (value[key] !== undefined) result[key] = flag(value[key], `${at}.${key}`);
  if ((kind === "click" || kind === "hover") && result.selector === undefined && (result.x === undefined || result.y === undefined)) {
    throw new Error(`${at}: ${kind} needs a selector, or x and y`);
  }
  if ((kind === "click" || kind === "hover") && result.selector !== undefined && (result.x !== undefined || result.y !== undefined)) {
    throw new Error(`${at}: ${kind} takes a selector or x and y, not both`);
  }
  if (kind === "wait" && [result.selector, result.text, result.ms].filter(part => part !== undefined).length !== 1) {
    throw new Error(`${at}: wait takes one of selector, text or ms`);
  }
  return result;
}

export const servePrograms: readonly string[] = Object.freeze([...nodePrograms, ...pythonPrograms]);

export function serveRequest(serve: unknown): BrowserServe {
  const keys = ["program", "args", "directory", "venv", "port", "timeout_seconds"];
  if (!object(serve) || Object.keys(serve).some(key => !keys.includes(key) && serve[key] !== undefined)) {
    throw new Error("serve is {program, args?, directory?, venv?, port, timeout_seconds?}");
  }
  if (typeof serve.program !== "string" || !servePrograms.includes(serve.program)) {
    throw new Error(`serve.program is one of the node and python tools' programs: ${servePrograms.join(", ")}`);
  }
  const python = (pythonPrograms as readonly string[]).includes(serve.program);
  if (!python && serve.venv !== undefined) throw new Error("serve.venv is a virtual environment, for Python's programs");
  let launched: { program: string; args: string[]; directory: string; venv?: string };
  try {
    launched = python ? pythonRequest({ program: serve.program, args: serve.args, directory: serve.directory, venv: serve.venv })
      : nodeRequest({ program: serve.program, args: serve.args, directory: serve.directory });
  } catch (error) { throw new Error(`serve: ${error instanceof Error ? error.message : "invalid program"}`); }
  const result: BrowserServe = { program: launched.program, ...(launched.args.length ? { args: launched.args } : {}),
    ...(launched.directory !== "." ? { directory: launched.directory } : {}), ...(launched.venv ? { venv: launched.venv } : {}),
    port: integer(serve.port, "serve.port", 1, 65535) };
  if (serve.timeout_seconds !== undefined) {
    result.timeout_seconds = integer(serve.timeout_seconds, "serve.timeout_seconds", browserLimits.serveSeconds.min, browserLimits.serveSeconds.max);
  }
  return result;
}

export function browserRequest(input: Record<string, unknown>): BrowserRequest {
  const known = ["url", "actions", "viewport", "full_page", "timeout_seconds", "serve"];
  for (const key of Object.keys(input)) if (!known.includes(key) && input[key] !== undefined) throw new Error(`the browser tool takes ${known.join(", ")}, not ${key}`);
  const request: BrowserRequest = {};
  if (input.url !== undefined) request.url = browserUrl(input.url);
  if (input.actions !== undefined) {
    if (!Array.isArray(input.actions) || input.actions.length > browserLimits.actions) throw new Error(`actions is a list of at most ${browserLimits.actions} actions`);
    request.actions = input.actions.map(action);
  }
  if (input.viewport !== undefined) {
    const { viewport } = browserLimits;
    if (!object(input.viewport) || Object.keys(input.viewport).some(key => key !== "width" && key !== "height")) throw new Error("viewport is {width, height}");
    request.viewport = { width: integer(input.viewport.width, "viewport.width", viewport.minWidth, viewport.maxWidth),
      height: integer(input.viewport.height, "viewport.height", viewport.minHeight, viewport.maxHeight) };
  }
  if (input.full_page !== undefined) request.full_page = flag(input.full_page, "full_page");
  if (input.timeout_seconds !== undefined) request.timeout_seconds = integer(input.timeout_seconds, "timeout_seconds", browserLimits.timeoutSeconds.min, browserLimits.timeoutSeconds.max);
  if (input.serve !== undefined) request.serve = serveRequest(input.serve);
  return request;
}

export function browserTarget(request: BrowserRequest): string {
  const serve = request.serve && [request.serve.program, ...(request.serve.args ?? [])].join(" ");
  const parts = [request.url ?? "(the last page)", ...(request.actions ?? []).map(item => item.action), ...(serve ? [`serve: ${serve}`] : [])];
  return parts.join(" → ").slice(0, 8192);
}

export function browserShellCommand(request: BrowserRequest, browser: SessionBrowser, options: { seconds: number; nodeBin?: string | undefined }): string {
  const node = request.serve && options.nodeBin && (nodePrograms as readonly string[]).includes(request.serve.program) ? ["--node-bin", options.nodeBin] : [];
  return programShellCommand({ directory: ".", program: shellQuote(browser.driver),
    args: ["--chrome", browser.chromium, "--time-limit", String(Math.trunc(options.seconds)), ...node, JSON.stringify(request)] });
}
