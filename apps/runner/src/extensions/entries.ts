import { createHash, randomUUID } from "node:crypto";
import { extensionPackageKey } from "../../../../packages/shared/src/host-extensions.js";
import type { StoredEntry } from "./protocol.js";

export const entryLimits = { perSource: 256, entryBytes: 64 * 1024, sourceBytes: 1024 * 1024, customType: 128, writeIntervalMs: 500 };

export function entriesKey(source: string): string {
  let name = source;
  if (source.startsWith("npm:") || source.startsWith("git:")) {
    try { name = extensionPackageKey(source); } catch { }
  }
  return createHash("sha256").update(name).digest("hex").slice(0, 32);
}

const ENTRY_ID = /^[A-Za-z0-9_-]{1,64}$/;
const isObject = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const entryBytes = (entry: StoredEntry) => Buffer.byteLength(entry.customType) + Buffer.byteLength(entry.data) + 128;

export function dataText(data: unknown): string | undefined {
  if (data === undefined) return "";
  try {
    const text = JSON.stringify(data);
    return typeof text === "string" ? text : "";
  } catch { return undefined; }
}

export function entryRefusal(customType: unknown, data: string | undefined): string | undefined {
  if (typeof customType !== "string" || !customType || customType.length > entryLimits.customType) return `an entry's type is text of at most ${entryLimits.customType} characters`;
  if (data === undefined) return "an entry's data must be JSON";
  if (Buffer.byteLength(data) > entryLimits.entryBytes) return `an entry holds at most ${entryLimits.entryBytes / 1024} KB of JSON`;
  return undefined;
}

export function storedEntry(value: unknown, taken: ReadonlySet<string> = new Set()): StoredEntry | string {
  if (!isObject(value)) return "an entry is an object";
  const data = typeof value.data === "string" ? value.data : undefined;
  const refusal = entryRefusal(value.customType, data);
  if (refusal) return refusal;
  if (data) {
    try { JSON.parse(data); } catch { return "an entry's data must be JSON"; }
  }
  let id = typeof value.id === "string" && ENTRY_ID.test(value.id) && !taken.has(value.id) ? value.id : "";
  while (!id || taken.has(id)) id = randomUUID().slice(0, 8);
  const timestamp = typeof value.timestamp === "string" && value.timestamp.length <= 40 && !Number.isNaN(Date.parse(value.timestamp)) ? value.timestamp : new Date().toISOString();
  return { id, timestamp, customType: value.customType as string, data: data ?? "" };
}

export function boundEntries(entries: readonly StoredEntry[]): StoredEntry[] {
  const kept = entries.slice(-entryLimits.perSource);
  let bytes = kept.reduce((sum, entry) => sum + entryBytes(entry), 0);
  while (kept.length > 1 && bytes > entryLimits.sourceBytes) bytes -= entryBytes(kept.shift()!);
  return kept;
}

export function storedEntries(value: unknown): StoredEntry[] {
  if (!Array.isArray(value)) return [];
  const taken = new Set<string>();
  const entries: StoredEntry[] = [];
  for (const item of value) {
    const entry = storedEntry(item, taken);
    if (typeof entry === "string") continue;
    taken.add(entry.id);
    entries.push(entry);
  }
  return boundEntries(entries);
}

export interface EntryStorage {
  read(key: string): Promise<unknown>;
  write(key: string, entries: StoredEntry[]): Promise<void>;
}

export class SessionEntries {
  readonly #lists = new Map<string, StoredEntry[]>();
  readonly #loading = new Map<string, Promise<StoredEntry[]>>();
  readonly #early = new Map<string, StoredEntry[]>();
  readonly #dirty = new Map<string, string>();
  readonly #written = new Map<string, number>();
  readonly #refused = new Set<string>();
  #writing: Promise<void> | undefined;

  constructor(private readonly storage: EntryStorage | undefined, private readonly warn: (source: string, message: string) => void) {}

  list(source: string): StoredEntry[] | undefined {
    return this.#lists.get(entriesKey(source));
  }

  load(source: string): Promise<StoredEntry[]> {
    const key = entriesKey(source);
    const loaded = this.#lists.get(key);
    if (loaded) return Promise.resolve(loaded);
    let loading = this.#loading.get(key);
    if (!loading) {
      loading = (async () => {
        const stored = this.storage ? storedEntries(await this.storage.read(key)) : [];
        const early = this.#early.get(key) ?? [];
        this.#early.delete(key);
        const taken = new Set(stored.map(entry => entry.id));
        const list = boundEntries([...stored, ...early.map(entry => taken.has(entry.id) ? { ...entry, id: randomUUID().slice(0, 8) } : entry)]);
        this.#lists.set(key, list);
        if (early.length) this.#save(source, key);
        return list;
      })().finally(() => this.#loading.delete(key));
      this.#loading.set(key, loading);
    }
    return loading;
  }

  append(source: string, raw: unknown): void {
    const key = entriesKey(source);
    const list = this.#lists.get(key);
    const pending = list ?? this.#early.get(key) ?? [];
    const entry = storedEntry(raw, new Set(pending.map(item => item.id)));
    if (typeof entry === "string") {
      if (!this.#refused.has(`${source}\0${entry}`)) {
        this.#refused.add(`${source}\0${entry}`);
        this.warn(source, `appendEntry() kept nothing: ${entry}`);
      }
      return;
    }
    const next = boundEntries([...pending, entry]);
    if (next.length <= pending.length && !this.#refused.has(`${source}\0full`)) {
      this.#refused.add(`${source}\0full`);
      this.warn(source, `it keeps more entries than a session holds for an extension (${entryLimits.perSource}, ${entryLimits.sourceBytes / 1024} KB); its oldest are dropped`);
    }
    if (!list) {
      this.#early.set(key, next);
      return;
    }
    this.#lists.set(key, next);
    this.#save(source, key);
  }

  #save(source: string, key: string): void {
    if (!this.storage) return;
    this.#dirty.set(key, source);
    this.#writing ??= this.#write().finally(() => { this.#writing = undefined; });
  }

  async #write(): Promise<void> {
    const storage = this.storage!;
    while (this.#dirty.size) {
      const [key, source] = this.#dirty.entries().next().value!;
      const wait = (this.#written.get(key) ?? 0) + entryLimits.writeIntervalMs - Date.now();
      if (wait > 0 && !this.#flushing) {
        await new Promise<void>(resolve => {
          const timer = setTimeout(resolve, wait);
          timer.unref();
          this.#hurry = () => { clearTimeout(timer); resolve(); };
        });
      }
      this.#hurry = undefined;
      this.#dirty.delete(key);
      this.#written.set(key, Date.now());
      try { await storage.write(key, this.#lists.get(key) ?? []); }
      catch (error) { this.warn(source, `its entries couldn't be kept: ${error instanceof Error ? error.message : String(error)}`); }
    }
  }

  #hurry: (() => void) | undefined;
  #flushing = false;

  async flush(): Promise<void> {
    this.#flushing = true;
    this.#hurry?.();
    try { await this.#writing; } finally { this.#flushing = false; }
  }
}
