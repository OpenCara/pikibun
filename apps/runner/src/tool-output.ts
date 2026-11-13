import { createHash } from "node:crypto";

export const MODEL_OUTPUT = { bytes: 50 * 1024, lines: 2000 } as const;
export const SHOWN_OUTPUT = { bytes: 44 * 1024, lines: 1600 } as const;
export const SAVED_OUTPUT_BYTES = 1024 * 1024 - 1024;
export const TOOL_OUTPUT_DIRECTORY = "tool-output";
export const CODEMODE_OUTPUT_DIRECTORY = "codemode-output";
export const KEPT_OUTPUTS = 40;

const PRUNED_ENTRIES = new Map<string, RegExp>([
  [TOOL_OUTPUT_DIRECTORY, /^[A-Za-z0-9_-]+-[0-9a-f]{8}\.txt$/],
  [CODEMODE_OUTPUT_DIRECTORY, /^[0-9a-f]{8}$/],
]);

export type OutputLimits = { readonly bytes: number; readonly lines: number };

const byteLength = (text: string) => Buffer.byteLength(text, "utf8");

function lineCount(text: string): number {
  let count = 1;
  for (let index = text.indexOf("\n"); index !== -1; index = text.indexOf("\n", index + 1)) count++;
  return count;
}

export function fitsModel(text: string): boolean {
  return byteLength(text) <= MODEL_OUTPUT.bytes && lineCount(text) <= MODEL_OUTPUT.lines;
}

function startBytes(text: string, bytes: number): string {
  const data = Buffer.from(text, "utf8");
  if (data.length <= bytes) return text;
  let end = bytes;
  while (end > 0 && (data[end]! & 0xc0) === 0x80) end--;
  return data.subarray(0, end).toString("utf8");
}

function endBytes(text: string, bytes: number): string {
  const data = Buffer.from(text, "utf8");
  if (data.length <= bytes) return text;
  let start = data.length - bytes;
  while (start < data.length && (data[start]! & 0xc0) === 0x80) start++;
  return data.subarray(start).toString("utf8");
}

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

function tail(text: string, bytes: number, lines: number): string {
  let start = text.length;
  let used = 0;
  for (let count = 0; start > 0 && count < lines; count++) {
    const newline = start >= 2 ? text.lastIndexOf("\n", start - 2) : -1;
    const previous = newline === -1 ? 0 : newline + 1;
    const size = byteLength(text.slice(previous, start));
    if (used + size > bytes) return count === 0 ? endBytes(text.slice(previous), bytes) : text.slice(start);
    used += size;
    start = previous;
  }
  return text.slice(start);
}

export function excerpt(text: string, limits: OutputLimits, note: (omittedBytes: number) => string): string {
  if (byteLength(text) <= limits.bytes && lineCount(text) <= limits.lines) return text;
  const room = Math.max(0, limits.bytes - 512);
  const lines = Math.max(2, limits.lines - 2);
  const start = head(text, Math.floor(room / 4), Math.floor(lines / 4));
  const end = tail(text, room - byteLength(start), lines - lineCount(start));
  const omitted = byteLength(text) - byteLength(start) - byteLength(end);
  return `${start.endsWith("\n") || !start ? start : `${start}\n`}${note(omitted)}\n${end}`;
}

export function savedOutput(text: string): string {
  return excerpt(text, { bytes: SAVED_OUTPUT_BYTES, lines: Number.MAX_SAFE_INTEGER }, omitted => `[… ${omitted} bytes of the output left out here …]`);
}

export function scriptOutput(text: string, fits: (shown: string) => boolean = shown => byteLength(shown) <= SAVED_OUTPUT_BYTES): string {
  if (fits(text)) return text;
  const note = (omitted: number) => `[… ${omitted} bytes of the output left out here …]`;
  let bytes = SAVED_OUTPUT_BYTES;
  let shown = excerpt(text, { bytes, lines: Number.MAX_SAFE_INTEGER }, note);
  for (let attempt = 0; attempt < 16 && !fits(shown); attempt++) {
    bytes = Math.floor(bytes * 0.7);
    shown = excerpt(text, { bytes, lines: Number.MAX_SAFE_INTEGER }, note);
  }
  return fits(shown) ? shown : note(byteLength(text));
}

export function toolOutputPath(tool: string, callId: string): string {
  const name = (value: string) => value.replace(/[^A-Za-z0-9_-]+/g, "_").slice(0, 60) || "call";
  const digest = createHash("sha256").update(`${tool}\0${callId}`).digest("hex").slice(0, 8);
  return `${TOOL_OUTPUT_DIRECTORY}/${name(tool)}-${name(callId)}-${digest}.txt`;
}

export type BoundOptions = {
  save?: (whole: string) => Promise<string>;
  unsaved?: string;
  fits?: (shown: string) => boolean;
};

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
    ? `[… ${omitted} bytes left out here. The whole output is in ${saved}: read it with read (offset and limit) or grep it …]`
    : `[… ${omitted} bytes left out here, and not saved: ${unsaved} …]`;
  let limits: OutputLimits = SHOWN_OUTPUT;
  let shown = excerpt(text, limits, note);
  for (let attempt = 0; attempt < 8 && !fits(shown); attempt++) {
    limits = { bytes: Math.floor(limits.bytes * 0.7), lines: Math.floor(limits.lines * 0.7) };
    shown = excerpt(text, limits, note);
  }
  return fits(shown) ? shown : note(byteLength(text));
}

export function outputsToPrune(existing: readonly string[], savedNewestLast: readonly string[], keep = KEPT_OUTPUTS): string[] {
  if (existing.length <= keep) return [];
  const savedOrder = new Map(savedNewestLast.map((name, index) => [name, index]));
  const savedBeforeThisProcess = -1;
  const oldestFirst = [...existing].sort((a, b) => (savedOrder.get(a) ?? savedBeforeThisProcess) - (savedOrder.get(b) ?? savedBeforeThisProcess));
  return oldestFirst.slice(0, existing.length - keep);
}

export interface OutputDirectories {
  list(directory: string): Promise<string[]>;
  remove(path: string): Promise<void>;
}

export class SavedOutputs {
  readonly #savedNewestLast = new Map<string, string[]>();

  async saved(path: string, directories: OutputDirectories): Promise<void> {
    const [directory, entry] = path.split("/");
    const prunable = directory ? PRUNED_ENTRIES.get(directory) : undefined;
    if (!directory || !entry || !prunable?.test(entry)) return;
    const order = [...(this.#savedNewestLast.get(directory) ?? []).filter(name => name !== entry), entry].slice(-KEPT_OUTPUTS);
    this.#savedNewestLast.set(directory, order);
    const existing = (await directories.list(directory)).filter(name => prunable.test(name));
    for (const name of outputsToPrune(existing, order)) await directories.remove(`${directory}/${name}`);
  }
}
