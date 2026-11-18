export const resourceSources = ["cgroup", "processes", "unmeasured"] as const;
export type ResourceSource = (typeof resourceSources)[number];

export interface SessionResourcesView {
  sampledAt: string;
  source: ResourceSource;
  processes: number;
  cpuSeconds?: number;
  cpuCores?: number;
  memoryBytes?: number;
  peakMemoryBytes?: number;
  limits?: { cpuCores: number; memoryBytes: number };
  diskBytes?: number;
  diskPartial?: true;
  gpuMemoryBytes?: number;
}

export const resourceLimits = {
  sampleSeconds: 5,
  diskSeconds: 300,
  diskEntries: 200_000,
  diskWalkSeconds: 10,
};

const fields = ["sampledAt", "source", "processes", "cpuSeconds", "cpuCores", "memoryBytes", "peakMemoryBytes", "limits", "diskBytes", "diskPartial", "gpuMemoryBytes"];
const MAX = 2 ** 53 - 1;

function amount(value: unknown, integer: boolean): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= MAX && (!integer || Number.isSafeInteger(value));
}

export function parseSessionResources(value: unknown): SessionResourcesView | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const input = value as Record<string, unknown>;
  if (Object.keys(input).some(key => !fields.includes(key))) return undefined;
  if (typeof input.sampledAt !== "string" || input.sampledAt.length > 40 || !Number.isFinite(Date.parse(input.sampledAt))) return undefined;
  if (!resourceSources.includes(input.source as ResourceSource) || !amount(input.processes, true)) return undefined;
  for (const [key, integer] of [["cpuSeconds", false], ["cpuCores", false], ["memoryBytes", true], ["peakMemoryBytes", true], ["diskBytes", true], ["gpuMemoryBytes", true]] as const) {
    if (input[key] !== undefined && !amount(input[key], integer)) return undefined;
  }
  if (input.diskPartial !== undefined && input.diskPartial !== true) return undefined;
  let limits: SessionResourcesView["limits"];
  if (input.limits !== undefined) {
    const given = input.limits as Record<string, unknown> | null;
    if (!given || typeof given !== "object" || Array.isArray(given) || Object.keys(given).some(key => key !== "cpuCores" && key !== "memoryBytes")
      || !amount(given.cpuCores, false) || !amount(given.memoryBytes, true)) return undefined;
    limits = { cpuCores: given.cpuCores, memoryBytes: given.memoryBytes };
  }
  const result: SessionResourcesView = { sampledAt: input.sampledAt, source: input.source as ResourceSource, processes: input.processes };
  if (input.cpuSeconds !== undefined) result.cpuSeconds = input.cpuSeconds as number;
  if (input.cpuCores !== undefined) result.cpuCores = input.cpuCores as number;
  if (input.memoryBytes !== undefined) result.memoryBytes = input.memoryBytes as number;
  if (input.peakMemoryBytes !== undefined) result.peakMemoryBytes = input.peakMemoryBytes as number;
  if (limits) result.limits = limits;
  if (input.diskBytes !== undefined) result.diskBytes = input.diskBytes as number;
  if (input.diskPartial) result.diskPartial = true;
  if (input.gpuMemoryBytes !== undefined) result.gpuMemoryBytes = input.gpuMemoryBytes as number;
  return result;
}

const KiB = 1024;
const units = ["KB", "MB", "GB", "TB"];

export function resourceBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "?";
  if (bytes < KiB) return `${Math.round(bytes)} B`;
  let value = bytes / KiB;
  let unit = 0;
  while (value >= 1000 && unit < units.length - 1) { value /= KiB; unit++; }
  return `${value >= 10 ? Math.round(value) : Math.round(value * 10) / 10} ${units[unit]}`;
}

export function cpuTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "?";
  if (seconds < 60) return `${seconds < 10 ? Math.round(seconds * 10) / 10 : Math.round(seconds)} s`;
  if (seconds < 3600) return `${Math.round(seconds / 6) / 10} min`;
  return `${Math.round(seconds / 360) / 10} h`;
}

export function cores(value: number): string {
  const rounded = value >= 10 ? Math.round(value) : Math.round(value * 100) / 100;
  return `${rounded} CPU${rounded === 1 ? "" : "s"}`;
}

export interface ResourceLine {
  key: "cpu" | "memory" | "processes" | "disk" | "gpu";
  title: string;
  hint: string;
}

export function resourceLines(view: SessionResourcesView): ResourceLine[] {
  const lines: ResourceLine[] = [];
  if (view.cpuCores !== undefined || view.cpuSeconds !== undefined) {
    const now = view.cpuCores !== undefined ? `${cores(view.cpuCores)} in use${view.limits ? ` of ${cores(view.limits.cpuCores)} it may use` : ""}` : "CPU";
    lines.push({ key: "cpu", title: now, hint: view.cpuSeconds !== undefined ? `${cpuTime(view.cpuSeconds)} of CPU time since the session opened on its host` : "" });
  }
  if (view.memoryBytes !== undefined) {
    const limit = view.limits ? ` of ${resourceBytes(view.limits.memoryBytes)} it may use` : "";
    lines.push({ key: "memory", title: `${resourceBytes(view.memoryBytes)} memory${limit}`,
      hint: view.peakMemoryBytes !== undefined ? `At most ${resourceBytes(view.peakMemoryBytes)} since the session opened on its host` : "" });
  }
  lines.push({ key: "processes", title: view.processes === 0 ? "Nothing running" : `${view.processes} process${view.processes === 1 ? "" : "es"} running`,
    hint: view.source === "unmeasured" ? "This host can't measure its processes' CPU and memory" : "Commands, servers and tools the session started on its host" });
  if (view.gpuMemoryBytes !== undefined) lines.push({ key: "gpu", title: `${resourceBytes(view.gpuMemoryBytes)} GPU memory`, hint: "What its processes hold on the host's NVIDIA GPUs" });
  if (view.diskBytes !== undefined) {
    lines.push({ key: "disk", title: `${view.diskPartial ? "More than " : ""}${resourceBytes(view.diskBytes)} on disk`,
      hint: view.diskPartial ? "The session's folder on the host holds too many files to count them all" : "The session's folder on the host: its files, clones and conversation" });
  }
  return lines;
}
