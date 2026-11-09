import { createHash } from "node:crypto";

/*
 * How much of a tool's output reaches the model. pi-durable bounds every tool result itself, after the tool returns: it
 * keeps the first 50 KiB or 2000 lines (DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES in its truncate.ts, unless the tool's
 * registration sets `outputLimits`) and drops the rest. That loses a command's end, where a test run or a build says
 * what failed, and keeps nothing of what it dropped. So the tools that return long output bound it first, within those
 * limits: the whole output goes to a file in the worktree, which read_file and search read, and the model gets its
 * start and end, with a line between them saying what was left out and where the rest is.
 */

/** pi-durable's own bound of a tool result's text (see above). */
export const MODEL_OUTPUT = { bytes: 50 * 1024, lines: 2000 } as const;
/** The excerpt a long output becomes: well within MODEL_OUTPUT, with room for what the tool says around it. */
export const SHOWN_OUTPUT = { bytes: 44 * 1024, lines: 1600 } as const;
/** The most of an output saved to its file: the sandbox writes files of at most 1 MiB (MAX_FILE_BYTES). */
export const SAVED_OUTPUT_BYTES = 1024 * 1024 - 1024;
/** Where long outputs are saved, in the worktree. */
export const TOOL_OUTPUT_DIRECTORY = "tool-output";

export type OutputLimits = { readonly bytes: number; readonly lines: number };

const byteLength = (text: string) => Buffer.byteLength(text, "utf8");

function lineCount(text: string): number {
  let count = 1;
  for (let index = text.indexOf("\n"); index !== -1; index = text.indexOf("\n", index + 1)) count++;
  return count;
}

/** Whether `text` reaches the model whole, as pi-durable bounds it. */
export function fitsModel(text: string): boolean {
  return byteLength(text) <= MODEL_OUTPUT.bytes && lineCount(text) <= MODEL_OUTPUT.lines;
}

/** At most the first `bytes` of `text`, never part of a character. */
function startBytes(text: string, bytes: number): string {
  const data = Buffer.from(text, "utf8");
  if (data.length <= bytes) return text;
  let end = bytes;
  while (end > 0 && (data[end]! & 0xc0) === 0x80) end--;
  return data.subarray(0, end).toString("utf8");
}

/** At most the last `bytes` of `text`, never part of a character. */
function endBytes(text: string, bytes: number): string {
  const data = Buffer.from(text, "utf8");
  if (data.length <= bytes) return text;
  let start = data.length - bytes;
  while (start < data.length && (data[start]! & 0xc0) === 0x80) start++;
  return data.subarray(start).toString("utf8");
}

/** The whole lines `text` starts with, within `bytes` and `lines`; the start of its first line where that alone is longer. */
function head(text: string, bytes: number, lines: number): string {
  let end = 0;
  let used = 0;
  for (let count = 0; end < text.length && count < lines; count++) {
    const newline = text.indexOf("\n", end);
    const next = newline === -1 ? text.length : newline + 1;
    const size = byteLength(text.slice(end, next));
    if (used + size > bytes) return count === 0 ? startBytes(text.slice(0, next), bytes) : text.slice(0, end);
    used += size;
    end = next;
  }
  return text.slice(0, end);
}

/** The whole lines `text` ends with, within `bytes` and `lines`; the end of its last line where that alone is longer. */
function tail(text: string, bytes: number, lines: number): string {
  let start = text.length;
  let used = 0;
  for (let count = 0; start > 0 && count < lines; count++) {
    // The newline before the line that ends at `start` (lastIndexOf reads a negative position as 0).
    const newline = start >= 2 ? text.lastIndexOf("\n", start - 2) : -1;
    const previous = newline === -1 ? 0 : newline + 1;
    const size = byteLength(text.slice(previous, start));
    if (used + size > bytes) return count === 0 ? endBytes(text.slice(previous), bytes) : text.slice(start);
    used += size;
    start = previous;
  }
  return text.slice(start);
}

/**
 * `text`'s start and end within `limits`, a quarter of them for its start and the rest for its end (where a command says
 * how it went), and between them the line `note` makes of how many bytes were left out; `text` itself where it fits.
 */
export function excerpt(text: string, limits: OutputLimits, note: (omittedBytes: number) => string): string {
  if (byteLength(text) <= limits.bytes && lineCount(text) <= limits.lines) return text;
  const room = Math.max(0, limits.bytes - 512);
  const lines = Math.max(2, limits.lines - 2);
  const start = head(text, Math.floor(room / 4), Math.floor(lines / 4));
  const end = tail(text, room - byteLength(start), lines - lineCount(start));
  const omitted = byteLength(text) - byteLength(start) - byteLength(end);
  return `${start.endsWith("\n") || !start ? start : `${start}\n`}${note(omitted)}\n${end}`;
}

/** What is saved of `text`: all of it, or its start and end within SAVED_OUTPUT_BYTES. */
export function savedOutput(text: string): string {
  return excerpt(text, { bytes: SAVED_OUTPUT_BYTES, lines: Number.MAX_SAFE_INTEGER }, omitted => `[… ${omitted} bytes of the output left out here …]`);
}

/**
 * Where the output of tool `tool`'s call `callId` is saved: the same file for the same call, as a rerun after a restart
 * writes it again, and another for any other call, whose names may read alike once shortened.
 */
export function toolOutputPath(tool: string, callId: string): string {
  const name = (value: string) => value.replace(/[^A-Za-z0-9_-]+/g, "_").slice(0, 60) || "call";
  const digest = createHash("sha256").update(`${tool}\0${callId}`).digest("hex").slice(0, 8);
  return `${TOOL_OUTPUT_DIRECTORY}/${name(tool)}-${name(callId)}-${digest}.txt`;
}

export type BoundOptions = {
  /** Saves the whole output (as `savedOutput` makes it) and answers where, in the worktree; or, without it, `unsaved` says why it isn't. */
  save?: (whole: string) => Promise<string>;
  unsaved?: string;
  /** Whether what the tool returns with this output in it reaches the model whole; by default, the output alone. */
  fits?: (shown: string) => boolean;
};

/**
 * `text` as the tool returns it to the model: all of it where that fits; otherwise saved whole, where the call can, and
 * its start and end, which fit, with a line between them saying what was left out and where the rest is.
 */
export async function boundOutput(text: string, options: BoundOptions = {}): Promise<string> {
  const fits = options.fits ?? fitsModel;
  if (fits(text)) return text;
  let saved: string | undefined;
  let unsaved = options.unsaved ?? "this call can't write it to the worktree";
  if (options.save) {
    try { saved = await options.save(savedOutput(text)); }
    catch (error) { unsaved = `saving it failed: ${(error instanceof Error ? error.message : String(error)).slice(0, 200)}`; }
  }
  const note = (omitted: number) => saved
    ? `[… ${omitted} bytes left out here. The whole output is in ${saved}: read it with read_file (offset and limit) or search it …]`
    : `[… ${omitted} bytes left out here, and not saved: ${unsaved} …]`;
  // What surrounds the output (a card's JSON, its escapes) may still not fit: smaller excerpts until one does.
  let limits: OutputLimits = SHOWN_OUTPUT;
  let shown = excerpt(text, limits, note);
  for (let attempt = 0; attempt < 8 && !fits(shown); attempt++) {
    limits = { bytes: Math.floor(limits.bytes * 0.7), lines: Math.floor(limits.lines * 0.7) };
    shown = excerpt(text, limits, note);
  }
  // Where even that doesn't fit, only the line saying where the output is: never one pi-durable would cut again.
  return fits(shown) ? shown : note(byteLength(text));
}
