import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { lstat, opendir, readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { resourceLimits, type SessionResourcesView } from "../../../packages/shared/src/session-resources.js";

const TABLE_MS = 1000;
const GPU_MS = 10_000;
const MIN_RATE_MS = 1000;
const PROBE_TIMEOUT_MS = 5000;
const PROBE_OUTPUT_BYTES = 1024 * 1024;
const READ_BATCH = 64;
const WSL_NVIDIA_SMI = "/usr/lib/wsl/lib/nvidia-smi";

export class ProcessRoots {
  readonly #pids = new Map<number, number>();
  readonly #listeners = new Set<() => void>();
  #version = 0;

  add(pid: number | undefined): () => void {
    if (pid === undefined || !Number.isSafeInteger(pid) || pid <= 0) return () => {};
    this.#pids.set(pid, (this.#pids.get(pid) ?? 0) + 1);
    this.#changed();
    let done = false;
    return () => {
      if (done) return;
      done = true;
      const left = (this.#pids.get(pid) ?? 1) - 1;
      if (left > 0) this.#pids.set(pid, left); else this.#pids.delete(pid);
      this.#changed();
    };
  }

  list(): number[] { return [...this.#pids.keys()]; }

  get size(): number { return this.#pids.size; }

  get version(): number { return this.#version; }

  onChange(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  #changed(): void {
    this.#version++;
    for (const listener of this.#listeners) listener();
  }
}

export interface ProcessInfo {
  pid: number;
  ppid: number;
  start: string;
  cpuSeconds: number;
  childSeconds: number;
  rssBytes: number;
}

export type ProcessTable = ReadonlyMap<number, ProcessInfo>;
export type ProcessTableReader = () => Promise<ProcessTable | undefined>;
export type Run = (file: string, args: string[]) => Promise<string>;

function runProgram(file: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(file, args, { timeout: PROBE_TIMEOUT_MS, maxBuffer: PROBE_OUTPUT_BYTES, windowsHide: true, encoding: "utf8" }, (error, stdout) => {
      if (error) reject(error); else resolve(stdout);
    });
  });
}

export function parseProcStat(text: string, ticks: number, pageBytes: number): ProcessInfo | undefined {
  const open = text.indexOf("(");
  const close = text.lastIndexOf(")");
  if (open < 1 || close < open) return undefined;
  const pid = Number(text.slice(0, open).trim());
  const rest = text.slice(close + 2).trim().split(/\s+/);
  if (rest.length < 22) return undefined;
  const ppid = Number(rest[1]);
  const [utime, stime, cutime, cstime] = [rest[11], rest[12], rest[13], rest[14]].map(Number);
  const rss = Number(rest[21]);
  if (!Number.isSafeInteger(pid) || !Number.isSafeInteger(ppid) || [utime, stime, cutime, cstime, rss].some(value => !Number.isFinite(value!) || value! < 0)) return undefined;
  return { pid, ppid, start: rest[19]!, cpuSeconds: (utime! + stime!) / ticks, childSeconds: (cutime! + cstime!) / ticks, rssBytes: rss * pageBytes };
}

function psTime(value: string): number | undefined {
  const match = /^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+(?:\.\d+)?)$/.exec(value);
  if (!match) return undefined;
  const [, days, hours, minutes, seconds] = match;
  return Number(days ?? 0) * 86400 + Number(hours ?? 0) * 3600 + Number(minutes) * 60 + Number(seconds);
}

export function parsePs(output: string): Map<number, ProcessInfo> {
  const table = new Map<number, ProcessInfo>();
  for (const line of output.split(/\r?\n/)) {
    const [pid, ppid, rss, time] = line.trim().split(/\s+/);
    const cpuSeconds = time === undefined ? undefined : psTime(time);
    const info = { pid: Number(pid), ppid: Number(ppid), start: "", cpuSeconds: cpuSeconds ?? NaN, childSeconds: 0, rssBytes: Number(rss) * 1024 };
    if (!Number.isSafeInteger(info.pid) || info.pid <= 0 || !Number.isSafeInteger(info.ppid) || !Number.isFinite(info.cpuSeconds) || !Number.isFinite(info.rssBytes)) continue;
    table.set(info.pid, info);
  }
  return table;
}

async function systemNumber(run: Run, name: string, fallback: number): Promise<number> {
  try {
    const value = Number((await run("getconf", [name])).trim());
    return Number.isSafeInteger(value) && value > 0 ? value : fallback;
  } catch { return fallback; }
}

export function procTableReader(root = "/proc", run: Run = runProgram): ProcessTableReader {
  let units: Promise<{ ticks: number; page: number }> | undefined;
  return async () => {
    units ??= Promise.all([systemNumber(run, "CLK_TCK", 100), systemNumber(run, "PAGESIZE", 4096)]).then(([ticks, page]) => ({ ticks, page }));
    const { ticks, page } = await units;
    let names: string[];
    try { names = (await readdir(root)).filter(name => /^\d+$/.test(name)); } catch { return undefined; }
    const table = new Map<number, ProcessInfo>();
    for (let offset = 0; offset < names.length; offset += READ_BATCH) {
      const batch = await Promise.all(names.slice(offset, offset + READ_BATCH)
        .map(name => readFile(join(root, name, "stat"), "utf8").then(text => parseProcStat(text, ticks, page), () => undefined)));
      for (const info of batch) if (info) table.set(info.pid, info);
    }
    return table;
  };
}

export function psTableReader(run: Run = runProgram): ProcessTableReader {
  return async () => {
    try { return parsePs(await run("/bin/ps", ["-A", "-o", "pid=,ppid=,rss=,time="])); } catch { return undefined; }
  };
}

function platformReader(): ProcessTableReader | undefined {
  if (process.platform === "linux") return procTableReader();
  if (process.platform === "darwin") return psTableReader();
  return undefined;
}

export function cachedReader(read: ProcessTableReader, ms = TABLE_MS): ProcessTableReader {
  let last: { at: number; table: Promise<ProcessTable | undefined> } | undefined;
  return () => {
    const now = Date.now();
    if (!last || now - last.at > ms) last = { at: now, table: read().catch(() => undefined) };
    return last.table;
  };
}

export function descendants(table: ProcessTable, roots: readonly number[]): ProcessInfo[] {
  const children = new Map<number, number[]>();
  for (const info of table.values()) {
    const list = children.get(info.ppid);
    if (list) list.push(info.pid); else children.set(info.ppid, [info.pid]);
  }
  const seen = new Set<number>();
  const found: ProcessInfo[] = [];
  const stack = roots.filter(pid => table.has(pid));
  while (stack.length) {
    const pid = stack.pop()!;
    if (seen.has(pid)) continue;
    seen.add(pid);
    found.push(table.get(pid)!);
    for (const child of children.get(pid) ?? []) if (!seen.has(child)) stack.push(child);
  }
  return found;
}

export function parseNvidiaApps(output: string): Map<number, number> {
  const used = new Map<number, number>();
  for (const line of output.split(/\r?\n/)) {
    const [pid, memory] = line.split(",").map(part => part.trim());
    const mib = Number(memory);
    const id = Number(pid);
    if (Number.isSafeInteger(id) && id > 0 && Number.isFinite(mib) && mib >= 0) used.set(id, (used.get(id) ?? 0) + Math.round(mib * 1024 * 1024));
  }
  return used;
}

export type GpuReader = () => Promise<ReadonlyMap<number, number> | undefined>;

export function nvidiaReader(run: Run = runProgram, ms = GPU_MS): GpuReader {
  let disabled = process.platform !== "linux";
  let last: { at: number; used: Promise<ReadonlyMap<number, number> | undefined> } | undefined;
  const programs = process.platform === "linux" && existsSync(WSL_NVIDIA_SMI) ? [WSL_NVIDIA_SMI, "nvidia-smi"] : ["nvidia-smi"];
  const query = async () => {
    for (const program of programs) {
      try { return parseNvidiaApps(await run(program, ["--query-compute-apps=pid,used_memory", "--format=csv,noheader,nounits"])); } catch { }
    }
    disabled = true;
    return undefined;
  };
  return () => {
    if (disabled) return Promise.resolve(undefined);
    const now = Date.now();
    if (!last || now - last.at > ms) last = { at: now, used: query() };
    return last.used;
  };
}

export interface ResourceGroups {
  directories: readonly string[];
  limits: { cpuCores: number; memoryBytes: number };
}

interface CgroupReading { cpuSeconds: number; memoryBytes: number; processes: number }

async function cgroupNumber(path: string): Promise<number | undefined> {
  try {
    const value = Number((await readFile(path, "utf8")).trim());
    return Number.isSafeInteger(value) && value >= 0 ? value : undefined;
  } catch { return undefined; }
}

async function cgroupCpu(directory: string): Promise<number> {
  try {
    const match = /^usage_usec\s+(\d+)$/m.exec(await readFile(join(directory, "cpu.stat"), "utf8"));
    return match ? Number(match[1]) / 1e6 : 0;
  } catch { return 0; }
}

export async function readCgroups(directories: readonly string[]): Promise<CgroupReading> {
  const readings = await Promise.all(directories.map(async directory => ({
    cpuSeconds: await cgroupCpu(directory),
    memoryBytes: await cgroupNumber(join(directory, "memory.current")) ?? 0,
    processes: await cgroupNumber(join(directory, "pids.current")) ?? 0,
  })));
  return readings.reduce((sum, item) => ({ cpuSeconds: sum.cpuSeconds + item.cpuSeconds, memoryBytes: sum.memoryBytes + item.memoryBytes,
    processes: sum.processes + item.processes }), { cpuSeconds: 0, memoryBytes: 0, processes: 0 });
}

export interface DiskUsage { bytes: number; partial: boolean }

export async function diskUsage(root: string, options: { maxEntries?: number; maxMs?: number } = {}): Promise<DiskUsage> {
  const maxEntries = options.maxEntries ?? resourceLimits.diskEntries;
  const deadline = Date.now() + (options.maxMs ?? resourceLimits.diskWalkSeconds * 1000);
  const allocated = (stat: { blocks?: number; size: number }) => (typeof stat.blocks === "number" && Number.isFinite(stat.blocks) ? stat.blocks * 512 : stat.size);
  let bytes = 0;
  let entries = 0;
  const stack = [root];
  while (stack.length) {
    const directory = stack.pop()!;
    let handle;
    try { handle = await opendir(directory); } catch { continue; }
    try {
      for await (const entry of handle) {
        if (++entries > maxEntries || Date.now() > deadline) return { bytes, partial: true };
        const path = join(directory, entry.name);
        try {
          const stat = await lstat(path);
          bytes += allocated(stat);
          if (stat.isDirectory()) stack.push(path);
        } catch { }
      }
    } finally { await handle.close().catch(() => {}); }
  }
  return { bytes, partial: false };
}

export interface SessionResourcesOptions {
  roots: ProcessRoots | undefined;
  directory: string;
  groups?: ResourceGroups | undefined;
  table?: ProcessTableReader | undefined;
  gpu?: GpuReader | undefined;
  disk?: (root: string) => Promise<DiskUsage>;
  sampleMs?: number;
  diskMs?: number;
  now?: () => number;
}

let sharedTable: ProcessTableReader | undefined | null = null;
let sharedGpu: GpuReader | undefined;

function hostTable(): ProcessTableReader | undefined {
  if (sharedTable === null) {
    const reader = platformReader();
    sharedTable = reader && cachedReader(reader);
  }
  return sharedTable;
}

function hostGpu(): GpuReader {
  sharedGpu ??= nvidiaReader();
  return sharedGpu;
}

export class SessionResources {
  readonly #roots: ProcessRoots | undefined;
  readonly #directory: string;
  readonly #groups: ResourceGroups | undefined;
  readonly #table: ProcessTableReader | undefined;
  readonly #gpu: GpuReader | undefined;
  readonly #disk: (root: string) => Promise<DiskUsage>;
  readonly #sampleMs: number;
  readonly #diskMs: number;
  readonly #now: () => number;
  #seen = new Map<string, Seen>();
  #cpuSeconds = 0;
  #baseline: Promise<number> | undefined;
  #peak = 0;
  #last: { at: number; cpuSeconds: number } | undefined;
  #view: SessionResourcesView | undefined;
  #sampledVersion = -1;
  #sampledAt = 0;
  #sampling: Promise<SessionResourcesView> | undefined;
  #timer: NodeJS.Timeout | undefined;
  #diskAt = 0;
  #diskUsage: DiskUsage | undefined;
  #walking: Promise<void> | undefined;
  #stopListening: (() => void) | undefined;
  #closed = false;

  constructor(options: SessionResourcesOptions) {
    this.#roots = options.roots;
    this.#directory = options.directory;
    this.#groups = options.groups;
    this.#table = options.table === undefined && !options.groups ? hostTable() : options.table;
    this.#gpu = options.gpu === undefined ? hostGpu() : options.gpu;
    this.#disk = options.disk ?? (root => diskUsage(root));
    this.#sampleMs = options.sampleMs ?? resourceLimits.sampleSeconds * 1000;
    this.#diskMs = options.diskMs ?? resourceLimits.diskSeconds * 1000;
    this.#now = options.now ?? Date.now;
    if (this.#groups) this.#baseline = readCgroups(this.#groups.directories).then(reading => reading.cpuSeconds, () => 0);
    this.#stopListening = this.#roots?.onChange(() => this.#schedule());
    this.#schedule();
  }

  async view(): Promise<SessionResourcesView> {
    this.#refreshDisk();
    const fresh = this.#view && this.#now() - this.#sampledAt < this.#sampleMs && this.#sampledVersion === (this.#roots?.version ?? 0);
    const view = fresh ? this.#view! : await this.#sample();
    return this.#withDisk(view);
  }

  close(): void {
    this.#closed = true;
    this.#stopListening?.();
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = undefined;
  }

  #schedule(): void {
    if (this.#closed || this.#timer || !this.#roots?.size) return;
    this.#timer = setTimeout(() => {
      this.#timer = undefined;
      void this.#sample().finally(() => this.#schedule());
    }, this.#sampleMs);
    this.#timer.unref?.();
  }

  #sample(): Promise<SessionResourcesView> {
    this.#sampling ??= this.#measure().finally(() => { this.#sampling = undefined; });
    return this.#sampling;
  }

  async #processes(): Promise<{ list: ReturnType<typeof descendants>; measured: boolean }> {
    const roots = this.#roots?.list() ?? [];
    if (!this.#table) return { list: [], measured: false };
    if (!roots.length) return { list: [], measured: true };
    const table = await this.#table();
    return table ? { list: descendants(table, roots), measured: true } : { list: [], measured: false };
  }

  async #measure(): Promise<SessionResourcesView> {
    const at = this.#now();
    const version = this.#roots?.version ?? 0;
    let view: SessionResourcesView;
    if (this.#groups) {
      const [reading, baseline] = await Promise.all([readCgroups(this.#groups.directories), this.#baseline!]);
      const cpuSeconds = Math.max(0, reading.cpuSeconds - baseline);
      this.#peak = Math.max(this.#peak, reading.memoryBytes);
      view = { sampledAt: new Date(at).toISOString(), source: "cgroup", processes: reading.processes, cpuSeconds: round(cpuSeconds, 1),
        cpuCores: this.#rate(at, cpuSeconds), memoryBytes: reading.memoryBytes, peakMemoryBytes: this.#peak, limits: { ...this.#groups.limits } };
    } else {
      const { list, measured } = await this.#processes();
      if (!measured) {
        view = { sampledAt: new Date(at).toISOString(), source: "unmeasured", processes: this.#roots?.size ?? 0 };
      } else {
        const { seen, credit } = cpuCredit(this.#seen, list);
        this.#seen = seen;
        this.#cpuSeconds += credit;
        const memoryBytes = list.reduce((sum, info) => sum + info.rssBytes, 0);
        this.#peak = Math.max(this.#peak, memoryBytes);
        view = { sampledAt: new Date(at).toISOString(), source: "processes", processes: list.length, cpuSeconds: round(this.#cpuSeconds, 1),
          cpuCores: this.#rate(at, this.#cpuSeconds), memoryBytes, peakMemoryBytes: this.#peak };
      }
    }
    const gpu = await this.#gpuMemory();
    if (gpu !== undefined) view.gpuMemoryBytes = gpu;
    this.#view = view;
    this.#sampledVersion = version;
    this.#sampledAt = at;
    return view;
  }

  #rate(at: number, cpuSeconds: number): number {
    const last = this.#last;
    if (last && at - last.at < MIN_RATE_MS) return this.#view?.cpuCores ?? 0;
    this.#last = { at, cpuSeconds };
    if (!last) return 0;
    return round(Math.max(0, cpuSeconds - last.cpuSeconds) / ((at - last.at) / 1000), 2);
  }

  async #gpuMemory(): Promise<number | undefined> {
    const reader = this.#table ?? hostTable();
    if (!this.#gpu || !reader || !this.#roots?.size) return undefined;
    const used = await this.#gpu();
    if (!used?.size) return undefined;
    const table = await reader();
    if (!table) return undefined;
    const total = descendants(table, this.#roots.list()).reduce((sum, info) => sum + (used.get(info.pid) ?? 0), 0);
    return total || undefined;
  }

  #refreshDisk(): void {
    if (this.#walking || this.#closed || (this.#diskUsage && this.#now() - this.#diskAt < this.#diskMs)) return;
    this.#walking = this.#disk(this.#directory)
      .then(usage => { this.#diskUsage = usage; this.#diskAt = this.#now(); }, () => { this.#diskAt = this.#now(); })
      .finally(() => { this.#walking = undefined; });
  }

  #withDisk(view: SessionResourcesView): SessionResourcesView {
    const disk = this.#diskUsage;
    return disk ? { ...view, diskBytes: disk.bytes, ...(disk.partial ? { diskPartial: true as const } : {}) } : view;
  }
}

export interface Seen { pid: number; ppid: number; total: number }

export function cpuCredit(previous: ReadonlyMap<string, Seen>, list: readonly ProcessInfo[]): { seen: Map<string, Seen>; credit: number } {
  const seen = new Map<string, Seen>();
  let credit = 0;
  for (const info of list) {
    const key = `${info.pid}:${info.start}`;
    const total = info.cpuSeconds + info.childSeconds;
    seen.set(key, { pid: info.pid, ppid: info.ppid, total });
    credit += total - (previous.get(key)?.total ?? 0);
  }
  const live = new Set(list.map(info => info.pid));
  const parents = new Map<number, number>();
  for (const item of previous.values()) parents.set(item.pid, item.ppid);
  const reapedInside = (ppid: number) => {
    let pid: number | undefined = ppid;
    for (let step = 0; pid !== undefined && step < 256; step++) {
      if (live.has(pid)) return true;
      pid = parents.get(pid);
    }
    return false;
  };
  for (const [key, item] of previous) if (!seen.has(key) && reapedInside(item.ppid)) credit -= item.total;
  return { seen, credit: Math.max(0, credit) };
}

function round(value: number, digits: number): number {
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
}
