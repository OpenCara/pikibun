import { Worker } from "node:worker_threads";

export const searchLimits = Object.freeze({
  pattern: 1000,
  glob: 200,
  context: 5,
  defaultResults: 100,
  maxResults: 500,
  lineText: 500,
  fileBytes: 1024 * 1024,
  files: 20000,
  bytes: 64 * 1024 * 1024,
  seconds: 10,
  text: 256 * 1024,
});

export interface SearchRequest {
  kind: "search";
  path: string;
  pattern: string;
  literal: boolean;
  ignoreCase: boolean;
  glob?: string;
  context: number;
  maxResults: number;
  all: boolean;
}

export interface SearchMatch {
  path: string;
  line: number;
  text: string;
  before?: string[];
  after?: string[];
}

export interface SearchResult {
  matches: SearchMatch[];
  files: number;
  truncated: boolean;
}

const fail = (message: string): never => { throw new Error(message); };
const flag = (value: unknown, name: string): boolean => value === undefined ? false : typeof value === "boolean" ? value : fail(`${name} must be true or false`);

const whole = (value: unknown, name: string): number | undefined => value === undefined ? undefined
  : typeof value === "number" && Number.isFinite(value) ? value : fail(`${name} must be a number`);

export function searchRequest(args: { path?: unknown; pattern?: unknown; literal?: unknown; ignoreCase?: unknown; glob?: unknown; context?: unknown; limit?: unknown; all?: unknown }): SearchRequest {
  const { pattern } = args;
  if (typeof pattern !== "string" || !pattern || pattern.length > searchLimits.pattern || pattern.includes("\0")) fail(`pattern must be 1 to ${searchLimits.pattern} characters`);
  const glob = typeof args.glob === "string" ? args.glob.replace(/^(?:\.\/)+/, "") : args.glob;
  if (glob !== undefined && (typeof glob !== "string" || !glob || glob.length > searchLimits.glob || /[\0\\]/.test(glob))) fail(`glob must be 1 to ${searchLimits.glob} characters, with / between directories`);
  const path = args.path === undefined || args.path === "" ? "." : typeof args.path === "string" ? args.path.replace(/\/+$/, "") || "." : fail("path must be a path in the worktree");
  const context = whole(args.context, "context");
  const limit = whole(args.limit, "limit");
  return { kind: "search", path, pattern: pattern as string, literal: flag(args.literal, "literal"), ignoreCase: flag(args.ignoreCase, "ignoreCase"),
    ...(glob !== undefined ? { glob: glob as string } : {}), context: context && context > 0 ? Math.min(Math.floor(context), searchLimits.context) : 0,
    maxResults: Math.min(Math.max(1, Math.floor(limit ?? searchLimits.defaultResults)), searchLimits.maxResults), all: flag(args.all, "all") };
}

export function checkedSearch(value: unknown): SearchResult {
  const lines = (list: unknown) => Array.isArray(list) && list.length <= searchLimits.context && list.every(item => typeof item === "string");
  if (!value || typeof value !== "object") fail("Invalid sandbox search response");
  const { matches, files, truncated } = value as SearchResult;
  if (!Array.isArray(matches) || matches.length > searchLimits.maxResults + 1 || !Number.isInteger(files) || typeof truncated !== "boolean"
    || !matches.every(match => match && typeof match.path === "string" && Number.isInteger(match.line) && match.line > 0 && typeof match.text === "string"
      && (match.before === undefined || lines(match.before)) && (match.after === undefined || lines(match.after)))) fail("Invalid sandbox search response");
  return { matches, files, truncated };
}

export const findLimits = Object.freeze({
  pattern: 1000,
  defaultResults: 1000,
  maxResults: 5000,
  entries: 100000,
  seconds: 10,
});

export interface FindRequest {
  kind: "find";
  path: string;
  pattern: string;
  ignoreCase: boolean;
  maxResults: number;
  all: boolean;
}

export interface FindResult {
  paths: string[];
  truncated: boolean;
}

export function findRequest(args: { path?: unknown; pattern?: unknown; limit?: unknown; all?: unknown }): FindRequest {
  const { pattern } = args;
  if (typeof pattern !== "string" || !pattern || pattern.length > findLimits.pattern || /[\0\\]/.test(pattern)) fail(`pattern must be 1 to ${findLimits.pattern} characters, with / between directories`);
  const anchored = (pattern as string).replace(/^\/+/, "") || "**";
  const glob = anchored === pattern && anchored.includes("/") && !anchored.startsWith("**/") && anchored !== "**" ? `**/${anchored}` : anchored;
  const path = args.path === undefined || args.path === "" ? "." : typeof args.path === "string" ? args.path.replace(/\/+$/, "") || "." : fail("path must be a path in the worktree");
  const limit = whole(args.limit, "limit");
  return { kind: "find", path, pattern: glob, ignoreCase: (pattern as string) === (pattern as string).toLowerCase(),
    maxResults: Math.min(Math.max(1, Math.floor(limit ?? findLimits.defaultResults)), findLimits.maxResults), all: flag(args.all, "all") };
}

export function checkedFind(value: unknown): FindResult {
  if (!value || typeof value !== "object") fail("Invalid sandbox find response");
  const { paths, truncated } = value as FindResult;
  if (!Array.isArray(paths) || paths.length > findLimits.maxResults + 1 || typeof truncated !== "boolean"
    || !paths.every(path => typeof path === "string" && path.length > 0 && !path.startsWith("/") && !path.includes("\0"))) fail("Invalid sandbox find response");
  return { paths, truncated };
}

export const SEARCH_CORE = String.raw`
function searchTree(fs, start, startPath, request) {
  const LIMITS = { fileBytes: ${searchLimits.fileBytes}, files: ${searchLimits.files}, bytes: ${searchLimits.bytes}, lineText: ${searchLimits.lineText}, seconds: ${searchLimits.seconds}, text: ${searchLimits.text} };
  const deadline = Date.now() + LIMITS.seconds * 1000;
  let expression;
  try {
    const source = request.literal ? request.pattern.replace(/[.*+?^$(){}|[\]\\]/g, "\\$&") : request.pattern;
    expression = new RegExp(source, request.ignoreCase ? "iu" : "u");
  } catch { throw new SearchRefusal("invalid regular expression"); }
  const glob = request.glob === undefined ? undefined : globExpression(request.glob, false);
  const matches = [];
  let files = 0, bytes = 0, characters = 0, truncated = false;
  const shown = line => { const chars = Array.from(line); return chars.length > LIMITS.lineText ? chars.slice(0, LIMITS.lineText).join("") + "\u2026" : line; };
  const length = line => Array.from(line).length;
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const done = () => { if (matches.length > request.maxResults) truncated = true; return truncated; };
  function searchFile(path, relative, size) {
    if (size > LIMITS.fileBytes) return;
    if (files >= LIMITS.files || bytes + size > LIMITS.bytes || Date.now() > deadline) { truncated = true; return; }
    let data;
    try { data = fs.read(path); } catch { return; }
    if (data.length > LIMITS.fileBytes || data.includes(0)) return;
    let text;
    try { text = decoder.decode(data); } catch { return; }
    files++;
    bytes += data.length;
    const lines = text.split("\n").map(line => line.endsWith("\r") ? line.slice(0, -1) : line);
    if (lines.length > 1 && lines.at(-1) === "") lines.pop();
    for (let index = 0; index < lines.length; index++) {
      if (!expression.test(lines[index])) continue;
      if (matches.length > request.maxResults) { truncated = true; return; }
      const match = { path: relative, line: index + 1, text: shown(lines[index]) };
      if (request.context > 0) {
        match.before = lines.slice(Math.max(0, index - request.context), index).map(shown);
        match.after = lines.slice(index + 1, index + 1 + request.context).map(shown);
      }
      const size = [match.text, ...(match.before || []), ...(match.after || [])].reduce((total, line) => total + length(line), 0);
      if (characters + size > LIMITS.text) { truncated = true; return; }
      characters += size;
      matches.push(match);
    }
  }
  const below = relative => startPath === "." ? relative : relative.slice(startPath.length + 1);
  function visit(directory, prefix) {
    let names;
    try { names = fs.list(directory); } catch { return; }
    names.sort((a, b) => a < b ? -1 : a > b ? 1 : 0);
    for (const name of names) {
      if (done()) return;
      if (Date.now() > deadline) { truncated = true; return; }
      const path = fs.join(directory, name);
      const relative = prefix === "." ? name : prefix + "/" + name;
      let info;
      try { info = fs.lstat(path); } catch { continue; }
      if (info.link) continue;
      if (info.directory) {
        if (name === ".git" || (!request.all && name === "node_modules")) continue;
        visit(path, relative);
      } else if (info.file && (!glob || glob.test(request.glob.includes("/") ? below(relative) : name))) searchFile(path, relative, info.size);
    }
  }
  const info = fs.lstat(start);
  if (info.link) throw new SearchRefusal("the path is a link");
  if (info.directory) visit(start, startPath);
  else if (info.file) searchFile(start, startPath, info.size);
  else throw new SearchRefusal("the path is not a file or directory");
  return { matches, files, truncated };
}

function findTree(fs, start, request) {
  const LIMITS = { entries: ${findLimits.entries}, seconds: ${findLimits.seconds} };
  const deadline = Date.now() + LIMITS.seconds * 1000;
  const byPath = request.pattern.includes("/");
  const glob = globExpression(request.pattern, request.ignoreCase);
  const paths = [];
  let entries = 0, truncated = false;
  function visit(directory, prefix) {
    let names;
    try { names = fs.list(directory); } catch { return; }
    names.sort((a, b) => a < b ? -1 : a > b ? 1 : 0);
    for (const name of names) {
      if (truncated) return;
      if (paths.length > request.maxResults || entries >= LIMITS.entries || Date.now() > deadline) { truncated = true; return; }
      entries++;
      const path = fs.join(directory, name);
      const relative = prefix === "" ? name : prefix + "/" + name;
      let info;
      try { info = fs.lstat(path); } catch { continue; }
      const inside = info.directory && !info.link;
      if (inside && (name === ".git" || (!request.all && name === "node_modules"))) continue;
      if (glob.test(byPath ? relative : name)) paths.push(inside ? relative + "/" : relative);
      if (inside) visit(path, relative);
    }
  }
  const info = fs.lstat(start);
  if (info.link || !info.directory) throw new SearchRefusal("the path is not a directory");
  visit(start, "");
  return { paths, truncated };
}

function globExpression(glob, ignoreCase) {
  let open = 0, closed = 0;
  for (const char of glob) { if (char === "{") open++; else if (char === "}") closed++; }
  const braces = open > 0 && open === closed;
  let source = "", depth = 0;
  for (let index = 0; index < glob.length; index++) {
    const char = glob[index];
    if (char === "*" && glob[index + 1] === "*") {
      index++;
      if (glob[index + 1] === "/") { index++; source += "(?:.*/)?"; } else source += ".*";
    } else if (char === "*") source += "[^/]*";
    else if (char === "?") source += "[^/]";
    else if (braces && char === "{") { depth++; source += "(?:"; }
    else if (braces && char === "}" && depth > 0) { depth--; source += ")"; }
    else if (braces && char === "," && depth > 0) source += "|";
    else if (char === "[" && glob.indexOf("]", index + 2) !== -1) {
      const end = glob.indexOf("]", index + 2);
      const body = glob.slice(index + 1, end);
      source += "[" + (body[0] === "!" ? "^" + body.slice(1) : body).replace(/[\\[]/g, "\\$&") + "]";
      index = end;
    }
    else source += char.replace(/[.+^$(){}|[\]\\]/g, "\\$&");
  }
  return new RegExp("^" + source + "$", ignoreCase ? "iu" : "u");
}

class SearchRefusal extends Error {}
`;

const WORKER_TIMEOUT_MS = (searchLimits.seconds + 20) * 1000;

export async function searchInWorker(start: string, startPath: string, request: SearchRequest, timeoutMs = WORKER_TIMEOUT_MS): Promise<SearchResult> {
  return checkedSearch(await walkInWorker(start, startPath, request, timeoutMs));
}

export async function findInWorker(start: string, request: FindRequest, timeoutMs = WORKER_TIMEOUT_MS): Promise<FindResult> {
  return checkedFind(await walkInWorker(start, ".", request, timeoutMs));
}

async function walkInWorker(start: string, startPath: string, request: SearchRequest | FindRequest, timeoutMs: number): Promise<unknown> {
  const code = `
const { parentPort, workerData } = require("node:worker_threads");
const { lstatSync, readdirSync, readFileSync } = require("node:fs");
const { join } = require("node:path");
${SEARCH_CORE}
const fs = {
  lstat: path => { const info = lstatSync(path); return { directory: info.isDirectory(), file: info.isFile(), link: info.isSymbolicLink(), size: info.size }; },
  list: path => readdirSync(path),
  read: path => { const info = lstatSync(path); if (!info.isFile() || info.nlink !== 1) throw new Error("skipped"); return readFileSync(path); },
  join,
};
try { parentPort.postMessage({ result: workerData.request.kind === "find" ? findTree(fs, workerData.start, workerData.request)
  : searchTree(fs, workerData.start, workerData.startPath, workerData.request) }); }
catch (error) { parentPort.postMessage({ error: error instanceof SearchRefusal ? error.message : "search failed" }); }
`;
  const worker = new Worker(code, { eval: true, workerData: { start, startPath, request }, resourceLimits: { maxOldGenerationSizeMb: 512 } });
  try {
    return await new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`${request.kind} took too long; narrow it with path or ${request.kind === "find" ? "pattern" : "glob"}`)), timeoutMs);
      timer.unref();
      worker.once("message", (message: { result?: unknown; error?: string }) => {
        clearTimeout(timer);
        if (message.error !== undefined) reject(new Error(message.error));
        else resolve(message.result);
      });
      worker.once("error", error => { clearTimeout(timer); reject(error); });
      worker.once("exit", code => { clearTimeout(timer); reject(new Error(`${request.kind} stopped (${code})`)); });
    });
  } finally { await worker.terminate(); }
}
