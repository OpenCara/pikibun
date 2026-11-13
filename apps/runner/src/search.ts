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
const count = (value: unknown, name: string, min: number, max: number, fallback: number): number => value === undefined ? fallback
  : Number.isInteger(value) && (value as number) >= min && (value as number) <= max ? value as number : fail(`${name} must be a whole number from ${min} to ${max}`);

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

export const SEARCH_CORE = String.raw`
function searchTree(fs, start, startPath, request) {
  const LIMITS = { fileBytes: ${searchLimits.fileBytes}, files: ${searchLimits.files}, bytes: ${searchLimits.bytes}, lineText: ${searchLimits.lineText}, seconds: ${searchLimits.seconds}, text: ${searchLimits.text} };
  const deadline = Date.now() + LIMITS.seconds * 1000;
  let expression;
  try {
    const source = request.literal ? request.pattern.replace(/[.*+?^$(){}|[\]\\]/g, "\\$&") : request.pattern;
    expression = new RegExp(source, request.ignoreCase ? "iu" : "u");
  } catch { throw new SearchRefusal("invalid regular expression"); }
  const glob = request.glob === undefined ? undefined : globExpression(request.glob);
  const matches = [];
  let files = 0, bytes = 0, characters = 0, truncated = false;
  const shown = line => { const chars = Array.from(line); return chars.length > LIMITS.lineText ? chars.slice(0, LIMITS.lineText).join("") + "\u2026" : line; };
  const length = line => Array.from(line).length;
  const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
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

function globExpression(glob) {
  let source = "";
  for (let index = 0; index < glob.length; index++) {
    const char = glob[index];
    if (char === "*" && glob[index + 1] === "*") {
      index++;
      if (glob[index + 1] === "/") { index++; source += "(?:.*/)?"; } else source += ".*";
    } else if (char === "*") source += "[^/]*";
    else if (char === "?") source += "[^/]";
    else source += char.replace(/[.+^$(){}|[\]\\]/g, "\\$&");
  }
  return new RegExp("^" + source + "$", "u");
}

class SearchRefusal extends Error {}
`;

const WORKER_TIMEOUT_MS = (searchLimits.seconds + 20) * 1000;

export async function searchInWorker(start: string, startPath: string, request: SearchRequest, timeoutMs = WORKER_TIMEOUT_MS): Promise<SearchResult> {
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
try { parentPort.postMessage({ result: searchTree(fs, workerData.start, workerData.startPath, workerData.request) }); }
catch (error) { parentPort.postMessage({ error: error instanceof SearchRefusal ? error.message : "search failed" }); }
`;
  const worker = new Worker(code, { eval: true, workerData: { start, startPath, request }, resourceLimits: { maxOldGenerationSizeMb: 512 } });
  try {
    return await new Promise<SearchResult>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("search took too long; narrow it with path or glob")), timeoutMs);
      timer.unref();
      worker.once("message", (message: { result?: unknown; error?: string }) => {
        clearTimeout(timer);
        if (message.error !== undefined) reject(new Error(message.error));
        else { try { resolve(checkedSearch(message.result)); } catch (error) { reject(error); } }
      });
      worker.once("error", error => { clearTimeout(timer); reject(error); });
      worker.once("exit", code => { clearTimeout(timer); reject(new Error(`search stopped (${code})`)); });
    });
  } finally { await worker.terminate(); }
}
