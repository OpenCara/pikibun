import { Worker } from "node:worker_threads";

/*
 * The search tool's file search (docs/design/piki-extensions.md, "piki:files"): a regular expression or literal text over
 * the worktree's text files, from a directory or one file, without leaving the worktree or following links. Sessions
 * read and searched code with grep, sed -n and head in a third of their shell commands (#163); this does that without a
 * shell, so it needs no approval, like read_file.
 *
 * Every workspace backend runs the same search and gives the same answer (tests/sandbox-conformance.test.ts): the
 * Linux and macOS sandboxes in their Python helper (`search` in sandbox-python/helper.py), native Windows in its Node
 * helper and unsandboxed hosts in a worker thread, both from SEARCH_CORE below.
 */

/** What one search may ask for and find; the Python helper mirrors these. */
export const searchLimits = Object.freeze({
  pattern: 1000,
  glob: 200,
  context: 5,
  defaultResults: 100,
  maxResults: 500,
  /** A line, or a context line, is shown up to this many characters (code points), then `…`. */
  lineText: 300,
  /** Files larger than this are skipped, as read_file refuses them. */
  fileBytes: 1024 * 1024,
  files: 20000,
  bytes: 64 * 1024 * 1024,
  /** It stops here and answers what it found, as truncated, within the helpers' 30-second operations. */
  seconds: 10,
});

export interface SearchRequest {
  kind: "search";
  /** The directory or file to search, relative to the worktree; `.` for all of it. */
  path: string;
  pattern: string;
  literal: boolean;
  ignoreCase: boolean;
  /** Only files whose path matches: `*.ts`, or with a slash, against the path from the worktree (`apps/** /*.ts`). */
  glob?: string;
  context: number;
  maxResults: number;
  /** Also search dependency directories (node_modules), which are skipped by default; `.git` never is searched. */
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
  /** Text files searched. */
  files: number;
  /** It stopped early: at `maxResults`, or at a limit on files, bytes or time. */
  truncated: boolean;
}

const fail = (message: string): never => { throw new Error(message); };
const flag = (value: unknown, name: string): boolean => value === undefined ? false : typeof value === "boolean" ? value : fail(`${name} must be true or false`);
const count = (value: unknown, name: string, min: number, max: number, fallback: number): number => value === undefined ? fallback
  : Number.isInteger(value) && (value as number) >= min && (value as number) <= max ? value as number : fail(`${name} must be a whole number from ${min} to ${max}`);

/** The tool's arguments as a request, or why not. */
export function searchRequest(args: { path?: unknown; pattern?: unknown; literal?: unknown; ignore_case?: unknown; glob?: unknown; context?: unknown; max_results?: unknown; all?: unknown }): SearchRequest {
  const { pattern, glob } = args;
  if (typeof pattern !== "string" || !pattern || pattern.length > searchLimits.pattern || pattern.includes("\0")) fail(`pattern must be 1 to ${searchLimits.pattern} characters`);
  if (glob !== undefined && (typeof glob !== "string" || !glob || glob.length > searchLimits.glob || /[\0\\]/.test(glob))) fail(`glob must be 1 to ${searchLimits.glob} characters, with / between directories`);
  const path = args.path === undefined || args.path === "" ? "." : typeof args.path === "string" ? args.path.replace(/\/+$/, "") || "." : fail("path must be a path in the worktree");
  return { kind: "search", path, pattern: pattern as string, literal: flag(args.literal, "literal"), ignoreCase: flag(args.ignore_case, "ignore_case"),
    ...(glob !== undefined ? { glob: glob as string } : {}), context: count(args.context, "context", 0, searchLimits.context, 0),
    maxResults: count(args.max_results, "max_results", 1, searchLimits.maxResults, searchLimits.defaultResults), all: flag(args.all, "all") };
}

/** A helper's answer, checked: it comes from inside the sandbox. */
export function checkedSearch(value: unknown): SearchResult {
  const lines = (list: unknown) => Array.isArray(list) && list.length <= searchLimits.context && list.every(item => typeof item === "string");
  if (!value || typeof value !== "object") fail("Invalid sandbox search response");
  const { matches, files, truncated } = value as SearchResult;
  if (!Array.isArray(matches) || matches.length > searchLimits.maxResults || !Number.isInteger(files) || typeof truncated !== "boolean"
    || !matches.every(match => match && typeof match.path === "string" && Number.isInteger(match.line) && match.line > 0 && typeof match.text === "string"
      && (match.before === undefined || lines(match.before)) && (match.after === undefined || lines(match.after)))) fail("Invalid sandbox search response");
  return { matches, files, truncated };
}

/**
 * The search itself, as JavaScript source with no imports: the Node helper embeds it (node-helper.ts) and unsandboxed
 * hosts run it in a worker (`searchInWorker`). `searchTree(fs, start, startPath, request)` walks from `start`, the
 * absolute path of `startPath` (relative to the worktree, `.` for its root), which the caller already checked is inside
 * the worktree; `fs` gives `lstat(path)` (`{ directory, file, link, size }`), `list(path)` and `read(path)` (a Buffer),
 * and `join(directory, name)`. Mirrors `search` in sandbox-python/helper.py: change both together.
 */
export const SEARCH_CORE = String.raw`
function searchTree(fs, start, startPath, request) {
  const LIMITS = { fileBytes: ${searchLimits.fileBytes}, files: ${searchLimits.files}, bytes: ${searchLimits.bytes}, lineText: ${searchLimits.lineText}, seconds: ${searchLimits.seconds} };
  const deadline = Date.now() + LIMITS.seconds * 1000;
  let expression;
  try {
    const source = request.literal ? request.pattern.replace(/[.*+?^$(){}|[\]\\]/g, "\\$&") : request.pattern;
    expression = new RegExp(source, request.ignoreCase ? "iu" : "u");
  } catch { throw new SearchRefusal("invalid regular expression"); }
  const glob = request.glob === undefined ? undefined : globExpression(request.glob);
  const matches = [];
  let files = 0, bytes = 0, truncated = false;
  const shown = line => { const chars = Array.from(line); return chars.length > LIMITS.lineText ? chars.slice(0, LIMITS.lineText).join("") + "\u2026" : line; };
  const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
  const done = () => truncated || matches.length >= request.maxResults;
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
      if (matches.length >= request.maxResults) { truncated = true; return; }
      const match = { path: relative, line: index + 1, text: shown(lines[index]) };
      if (request.context > 0) {
        match.before = lines.slice(Math.max(0, index - request.context), index).map(shown);
        match.after = lines.slice(index + 1, index + 1 + request.context).map(shown);
      }
      matches.push(match);
    }
  }
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
      } else if (info.file && (!glob || glob.test(request.glob.includes("/") ? relative : name))) searchFile(path, relative, info.size);
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

/** How long a worker search may take before it is stopped, beyond its own time limit. */
const WORKER_TIMEOUT_MS = (searchLimits.seconds + 20) * 1000;

/**
 * Runs SEARCH_CORE in a worker thread, for unsandboxed hosts, whose file operations run in the connector itself: a
 * pattern that backtracks without end, or a huge tree, then stops the worker, never the connector.
 */
export async function searchInWorker(start: string, startPath: string, request: SearchRequest, timeoutMs = WORKER_TIMEOUT_MS): Promise<SearchResult> {
  const code = `
const { parentPort, workerData } = require("node:worker_threads");
const { lstatSync, readdirSync, readFileSync } = require("node:fs");
const { join } = require("node:path");
${SEARCH_CORE}
const fs = {
  lstat: path => { const info = lstatSync(path); return { directory: info.isDirectory(), file: info.isFile(), link: info.isSymbolicLink(), size: info.size }; },
  list: path => readdirSync(path),
  // Like the helpers' reads: a regular file with one link, never a hard link to a file outside the worktree.
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
