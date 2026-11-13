import { Buffer } from "node:buffer";
import { randomUUID } from "node:crypto";
import { isAbsolute, posix, relative, resolve, sep } from "node:path";
import {
  createEditToolDefinition, createGrepToolDefinition, createLsToolDefinition, createReadToolDefinition, createWriteToolDefinition,
  DEFAULT_MAX_BYTES, formatSize, truncateHead, truncateLine, type EditToolDetails, type TruncationResult,
} from "@earendil-works/pi-coding-agent";
import type { SearchMatch, SearchResult } from "./search.js";

export const EDIT_ROOT = resolve(sep, `pikibun-edit-${randomUUID()}`);

export const GREP_LINE_CHARS = 500;
export const LS_DEFAULT_ENTRIES = 500;
export const PI_OUTPUT_LIMITS = { maxBytes: DEFAULT_MAX_BYTES + 4096, maxLines: Number.MAX_SAFE_INTEGER };

const grepSchema = createGrepToolDefinition(EDIT_ROOT).parameters;

export const piParameters = {
  read: createReadToolDefinition(EDIT_ROOT).parameters,
  write: createWriteToolDefinition(EDIT_ROOT).parameters,
  edit: createEditToolDefinition(EDIT_ROOT).parameters,
  ls: createLsToolDefinition(EDIT_ROOT).parameters,
  grep: { ...grepSchema, properties: { ...grepSchema.properties, all: { type: "boolean", description: "Search node_modules too (default: false)" } } },
};

export const prepareEditArguments = (args: unknown): unknown => createEditToolDefinition(EDIT_ROOT).prepareArguments!(structuredClone(args));

export class PathRefusal extends Error {}

export function worktreePath(path: string): string {
  if (path === "~" || path.startsWith("~/") || path.startsWith("~\\")) throw new PathRefusal(`${path} is not a worktree path: paths start at the worktree's top, and ~ is not a home directory here`);
  return path;
}

const UNICODE_SPACES = /[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g;

export function editTarget(path: string): string {
  let normalized = path.replace(UNICODE_SPACES, " ");
  if (normalized.startsWith("@")) normalized = normalized.slice(1);
  const refused = () => new PathRefusal(`${path} is not a worktree path: give it from the worktree's top, without a leading / or ~, a drive or ..`);
  if (!normalized || normalized.includes("\0") || normalized === "~" || /^~[\\/]/.test(normalized) || /^file:/i.test(normalized)
    || /^[\\/]/.test(normalized) || /^[A-Za-z]:/.test(normalized) || isAbsolute(normalized)) throw refused();
  const target = resolve(EDIT_ROOT, normalized);
  const inside = relative(EDIT_ROOT, target);
  if (!inside || inside === ".." || inside.startsWith(`..${sep}`) || isAbsolute(inside)) throw refused();
  return target;
}

export interface EditFile {
  read(): Promise<string>;
  write(content: string): Promise<void>;
}

export interface EditInput {
  path: string;
  edits: { oldText: string; newText: string }[];
}

export async function runPiEdit(input: EditInput, file: EditFile, signal?: AbortSignal): Promise<{ text: string; details: EditToolDetails }> {
  const target = editTarget(input.path);
  const expected = (path: string) => {
    if (path !== target) throw new Error(`Pi's edit asked for ${path}, not the file that was checked; nothing was written`);
  };
  const tool = createEditToolDefinition(EDIT_ROOT, { operations: {
    access: async path => { expected(path); },
    readFile: async path => { expected(path); return Buffer.from(await file.read(), "utf-8"); },
    writeFile: async (path, content) => { expected(path); await file.write(content); },
  } });
  const result = await tool.execute("pikibun-edit", input, signal, undefined, undefined as never);
  const text = result.content.flatMap(part => part.type === "text" ? [part.text] : []).join("\n");
  return { text, details: result.details as EditToolDetails };
}

export function readText(text: string, offset: number | undefined, limit: number | undefined, whole: boolean): { text: string; details?: { truncation: TruncationResult } } {
  const allLines = text.split("\n");
  const startLine = offset ? Math.max(0, offset - 1) : 0;
  const endLine = limit === undefined ? undefined : Math.min(startLine + limit, allLines.length);
  const selected = allLines.slice(startLine, endLine).join("\n");
  const totalFileLines = allLines.length;
  if (startLine >= totalFileLines) throw new Error(`Offset ${offset} is beyond end of file (${totalFileLines} lines total)`);
  if (whole) return { text: selected };
  const truncation = truncateHead(selected);
  const startLineDisplay = startLine + 1;
  const userLimitedLines = limit === undefined ? undefined : Math.min(startLine + limit, totalFileLines) - startLine;
  if (truncation.firstLineExceedsLimit) {
    const size = formatSize(Buffer.byteLength(allLines[startLine]!, "utf-8"));
    return { text: `[Line ${startLineDisplay} is ${size}, exceeds ${formatSize(DEFAULT_MAX_BYTES)} limit. A code mode script's read gets whole lines.]`, details: { truncation } };
  }
  if (truncation.truncated) {
    const endLineDisplay = startLineDisplay + truncation.outputLines - 1;
    const nextOffset = endLineDisplay + 1;
    const why = truncation.truncatedBy === "lines" ? "" : ` (${formatSize(DEFAULT_MAX_BYTES)} limit)`;
    return { text: `${truncation.content}\n\n[Showing lines ${startLineDisplay}-${endLineDisplay} of ${totalFileLines}${why}. Use offset=${nextOffset} to continue.]`, details: { truncation } };
  }
  if (userLimitedLines !== undefined && startLine + userLimitedLines < totalFileLines) {
    const remaining = totalFileLines - (startLine + userLimitedLines);
    return { text: `${truncation.content}\n\n[${remaining} more lines in file. Use offset=${startLine + userLimitedLines + 1} to continue.]` };
  }
  return { text: truncation.content };
}

export function imageText(mimeType: string): string {
  return `Read image file [${mimeType}]`;
}

export function lsText(entries: readonly string[], limit: number | undefined): { text: string; details?: { entryLimitReached?: number; truncation?: TruncationResult } } {
  const effectiveLimit = Math.max(1, Math.floor(limit ?? LS_DEFAULT_ENTRIES));
  const listed = entries.map(entry => entry.endsWith("/") ? { name: entry.slice(0, -1), suffix: "/" } : { name: entry, suffix: "" })
    .sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()));
  const results = listed.slice(0, effectiveLimit).map(entry => entry.name + entry.suffix);
  const entryLimitReached = listed.length > effectiveLimit;
  if (results.length === 0) return { text: "(empty directory)" };
  const truncation = truncateHead(results.join("\n"), { maxLines: Number.MAX_SAFE_INTEGER });
  const details: { entryLimitReached?: number; truncation?: TruncationResult } = {};
  const notices: string[] = [];
  if (entryLimitReached) {
    notices.push(`${effectiveLimit} entries limit reached. Use limit=${effectiveLimit * 2} for more`);
    details.entryLimitReached = effectiveLimit;
  }
  if (truncation.truncated) {
    notices.push(`${formatSize(DEFAULT_MAX_BYTES)} limit reached`);
    details.truncation = truncation;
  }
  const text = notices.length ? `${truncation.content}\n\n[${notices.join(". ")}]` : truncation.content;
  return Object.keys(details).length ? { text, details } : { text };
}

export interface GrepDetails {
  truncation?: TruncationResult;
  matchLimitReached?: number;
  linesTruncated?: boolean;
}

export function grepText(result: SearchResult, startPath: string, limit: number, maxLimit: number): { text: string; details?: GrepDetails } {
  const more = result.matches.length > limit;
  const stoppedEarly = result.truncated && !more;
  const stopped = "Search stopped early at Pikibun's file, size or time limit; narrow it with path or glob";
  const shown = result.matches.slice(0, limit);
  if (!shown.length) return { text: stoppedEarly ? `No matches found\n\n[${stopped}]` : "No matches found" };
  const display = (path: string) => path === startPath ? posix.basename(path) : startPath === "." ? path : path.slice(startPath.length + 1);
  const lines: string[] = [];
  let linesTruncated = false;
  const files: { path: string; rows: Map<number, { text: string; match: boolean }> }[] = [];
  const row = (rows: Map<number, { text: string; match: boolean }>, line: number, text: string, match: boolean) => {
    const known = rows.get(line);
    if (!known) rows.set(line, { text, match });
    else if (match) known.match = true;
  };
  for (const match of shown as SearchMatch[]) {
    let file = files.at(-1);
    if (!file || file.path !== match.path) files.push(file = { path: match.path, rows: new Map() });
    const before = match.before ?? [];
    before.forEach((text, index) => row(file!.rows, match.line - before.length + index, text, false));
    row(file.rows, match.line, match.text, true);
    (match.after ?? []).forEach((text, index) => row(file!.rows, match.line + 1 + index, text, false));
  }
  for (const file of files) {
    const path = display(file.path);
    for (const [number, { text, match }] of [...file.rows].sort(([a], [b]) => a - b)) {
      const cut = truncateLine(text, GREP_LINE_CHARS);
      if (cut.wasTruncated) linesTruncated = true;
      lines.push(match ? `${path}:${number}: ${cut.text}` : `${path}-${number}- ${cut.text}`);
    }
  }
  const raw = lines.join("\n");
  const truncation = truncateHead(raw, { maxLines: Number.MAX_SAFE_INTEGER });
  truncation.totalLines = lines.length;
  truncation.totalBytes = Buffer.byteLength(raw, "utf-8");
  const details: GrepDetails = {};
  const notices: string[] = [];
  if (more) {
    notices.push(limit < maxLimit ? `${limit} matches limit reached. Use limit=${limit * 2} for more, or refine pattern` : `${limit} matches limit reached. Refine pattern, path or glob`);
    details.matchLimitReached = limit;
  }
  if (truncation.truncated) {
    notices.push(`${formatSize(DEFAULT_MAX_BYTES)} limit reached`);
    details.truncation = truncation;
  }
  if (linesTruncated) {
    notices.push(`Some lines truncated to ${GREP_LINE_CHARS} chars. Use read tool to see full lines`);
    details.linesTruncated = true;
  }
  if (stoppedEarly) notices.push(stopped);
  const text = notices.length ? `${truncation.content}\n\n[${notices.join(". ")}]` : truncation.content;
  return Object.keys(details).length ? { text, details } : { text };
}
