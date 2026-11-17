export const gpuVendors = ["nvidia", "amd", "intel", "apple", "microsoft", "other"] as const;
export type GpuVendor = (typeof gpuVendors)[number];

export interface HostGpu {
  vendor: GpuVendor;
  name?: string;
  memoryBytes?: number;
}

export interface HostHardware {
  platform: string;
  release: string;
  arch: string;
  wsl?: true;
  cpuModel: string;
  cpus: number;
  memoryBytes: number;
  freeMemoryBytes: number;
  diskBytes?: number;
  freeDiskBytes?: number;
  load?: [number, number, number];
  gpus: HostGpu[];
}

export interface ReportedHardware extends HostHardware {
  reportedAt: string;
}

export const hardwareLimits = {
  gpus: 16,
  text: 120,
  reportBytes: 8 * 1024,
  reportSeconds: 300,
  freshSeconds: 900,
  patterns: 20,
  hosts: 50,
} as const;

const GiB = 1024 ** 3;

const hardwareFields = ["platform", "release", "arch", "wsl", "cpuModel", "cpus", "memoryBytes", "freeMemoryBytes", "diskBytes", "freeDiskBytes", "load", "gpus"];
const gpuFields = ["vendor", "name", "memoryBytes"];

function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function boundedText(value: unknown, what: string, pattern?: RegExp): string {
  if (typeof value !== "string" || value.length > hardwareLimits.text || /[\x00-\x1f\x7f\u2028\u2029]/.test(value) || (pattern && !pattern.test(value))) {
    throw new Error(`Invalid hardware ${what}`);
  }
  return value;
}

function bytes(value: unknown, what: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw new Error(`Invalid hardware ${what}`);
  return value as number;
}

export function parseHardware(value: unknown): HostHardware {
  if (!record(value) || Object.keys(value).some(key => !hardwareFields.includes(key))) throw new Error("Invalid hardware report");
  const platform = boundedText(value.platform, "platform", /^[A-Za-z0-9._-]{1,40}$/);
  const release = boundedText(value.release, "release");
  const arch = boundedText(value.arch, "arch", /^[A-Za-z0-9._-]{1,40}$/);
  if (value.wsl !== undefined && value.wsl !== true) throw new Error("Invalid hardware wsl");
  const cpuModel = boundedText(value.cpuModel, "CPU model");
  if (!Number.isSafeInteger(value.cpus) || (value.cpus as number) < 1 || (value.cpus as number) > 65_536) throw new Error("Invalid hardware CPUs");
  const memoryBytes = bytes(value.memoryBytes, "memory");
  const freeMemoryBytes = bytes(value.freeMemoryBytes, "free memory");
  if (freeMemoryBytes > memoryBytes) throw new Error("Invalid hardware free memory");
  const diskBytes = value.diskBytes === undefined ? undefined : bytes(value.diskBytes, "disk");
  const freeDiskBytes = value.freeDiskBytes === undefined ? undefined : bytes(value.freeDiskBytes, "free disk");
  if ((diskBytes === undefined) !== (freeDiskBytes === undefined) || (diskBytes !== undefined && freeDiskBytes! > diskBytes)) throw new Error("Invalid hardware disk");
  let load: [number, number, number] | undefined;
  if (value.load !== undefined) {
    if (!Array.isArray(value.load) || value.load.length !== 3
      || value.load.some(item => typeof item !== "number" || !Number.isFinite(item) || item < 0 || item > 1_000_000)) throw new Error("Invalid hardware load");
    load = [value.load[0], value.load[1], value.load[2]];
  }
  if (!Array.isArray(value.gpus) || value.gpus.length > hardwareLimits.gpus) throw new Error("Invalid hardware GPUs");
  const gpus = value.gpus.map((gpu): HostGpu => {
    if (!record(gpu) || Object.keys(gpu).some(key => !gpuFields.includes(key)) || !gpuVendors.includes(gpu.vendor as GpuVendor)) throw new Error("Invalid hardware GPU");
    return { vendor: gpu.vendor as GpuVendor, ...(gpu.name !== undefined ? { name: boundedText(gpu.name, "GPU name") } : {}),
      ...(gpu.memoryBytes !== undefined ? { memoryBytes: bytes(gpu.memoryBytes, "GPU memory") } : {}) };
  });
  return { platform, release, arch, ...(value.wsl ? { wsl: true as const } : {}), cpuModel, cpus: value.cpus as number, memoryBytes, freeMemoryBytes,
    ...(diskBytes !== undefined ? { diskBytes, freeDiskBytes: freeDiskBytes! } : {}), ...(load ? { load } : {}), gpus };
}

export function readReportedHardware(json: string | null | undefined, at: string | null | undefined): ReportedHardware | undefined {
  if (!json || !at) return undefined;
  try { return { ...parseHardware(JSON.parse(json)), reportedAt: at }; } catch { return undefined; }
}

export function hardwareFresh(hardware: Pick<ReportedHardware, "reportedAt"> | undefined, now = Date.now()): boolean {
  if (!hardware) return false;
  const at = Date.parse(hardware.reportedAt);
  return Number.isFinite(at) && now - at <= hardwareLimits.freshSeconds * 1000;
}

function gigabytes(value: number): string {
  const gb = value / GiB;
  return `${gb >= 10 ? Math.round(gb) : Math.round(gb * 10) / 10} GB`;
}

const vendorNames: Record<GpuVendor, string> = { nvidia: "NVIDIA", amd: "AMD", intel: "Intel", apple: "Apple", microsoft: "WSL GPU", other: "GPU" };

export function gpuLabel(gpu: HostGpu): string {
  const name = gpu.name ?? vendorNames[gpu.vendor];
  return gpu.memoryBytes ? `${name} (${gigabytes(gpu.memoryBytes)})` : name;
}

const platformNames: Record<string, string> = { linux: "Linux", darwin: "macOS", win32: "Windows" };

export function hardwareSummary(hardware: ReportedHardware | HostHardware, now = Date.now()): string {
  const fresh = !("reportedAt" in hardware) || hardwareFresh(hardware, now);
  const parts = [
    `${platformNames[hardware.platform] ?? hardware.platform}${hardware.wsl ? " (WSL)" : ""} ${hardware.release} ${hardware.arch}`.replace(/\s+/g, " ").trim(),
    `${hardware.cpus} CPU${hardware.cpus === 1 ? "" : "s"}${hardware.cpuModel ? ` (${hardware.cpuModel})` : ""}`,
    `${gigabytes(hardware.memoryBytes)} memory${fresh ? `, ${gigabytes(hardware.freeMemoryBytes)} free` : ""}`,
    ...(hardware.freeDiskBytes !== undefined ? [`${gigabytes(hardware.freeDiskBytes)} free disk`] : []),
    hardware.gpus.length ? hardware.gpus.map(gpuLabel).join(", ") : "no GPU found",
  ];
  return parts.join(" · ");
}

export interface PlacementRequirements {
  hosts?: string[];
  models?: string[];
  gpu?: boolean;
  gpuVendor?: GpuVendor;
  gpuMemoryGb?: number;
  minCpus?: number;
  minMemoryGb?: number;
  minFreeMemoryGb?: number;
  minFreeDiskGb?: number;
  platform?: string;
  arch?: string;
}

export const placementWireFields = {
  hosts: "hosts", models: "models", gpu: "gpu", gpu_vendor: "gpuVendor", gpu_memory_gb: "gpuMemoryGb", min_cpus: "minCpus", min_memory_gb: "minMemoryGb",
  min_free_memory_gb: "minFreeMemoryGb", min_free_disk_gb: "minFreeDiskGb", platform: "platform", arch: "arch",
} as const satisfies Record<string, keyof PlacementRequirements>;

const numberFields = ["gpuMemoryGb", "minCpus", "minMemoryGb", "minFreeMemoryGb", "minFreeDiskGb"] as const;

export function parsePlacement(value: unknown): PlacementRequirements {
  if (!record(value)) throw new Error("placement is an object of conditions");
  const known = Object.values(placementWireFields) as string[];
  const unknown = Object.keys(value).find(key => !known.includes(key));
  if (unknown) throw new Error(`placement takes no ${unknown}; it takes ${Object.keys(placementWireFields).join(", ")}`);
  const result: PlacementRequirements = {};
  const list = (key: "hosts" | "models", max: number) => {
    const items = value[key];
    if (items === undefined) return;
    if (!Array.isArray(items) || !items.length || items.length > max
      || items.some(item => typeof item !== "string" || !item || item.length > 200 || /[\x00-\x1f\x7f]/.test(item))) {
      throw new Error(`placement ${key} is a list of 1 to ${max} names`);
    }
    result[key] = [...new Set(items as string[])];
  };
  list("hosts", hardwareLimits.hosts);
  list("models", hardwareLimits.patterns);
  if (value.gpu !== undefined) {
    if (typeof value.gpu !== "boolean") throw new Error("placement gpu is true or false");
    result.gpu = value.gpu;
  }
  if (value.gpuVendor !== undefined) {
    if (!gpuVendors.includes(value.gpuVendor as GpuVendor)) throw new Error(`placement gpu_vendor is ${gpuVendors.join(", ")}`);
    result.gpuVendor = value.gpuVendor as GpuVendor;
  }
  for (const key of numberFields) {
    const item = value[key];
    if (item === undefined) continue;
    if (typeof item !== "number" || !Number.isFinite(item) || item < 0 || item > 1_000_000) throw new Error("placement sizes are numbers from 0");
    result[key] = item;
  }
  for (const key of ["platform", "arch"] as const) {
    const item = value[key];
    if (item === undefined) continue;
    if (typeof item !== "string" || !/^[A-Za-z0-9._-]{1,40}$/.test(item)) throw new Error(`placement ${key} is a name such as ${key === "platform" ? "linux" : "x64"}`);
    result[key] = item;
  }
  if ((result.gpuVendor !== undefined || result.gpuMemoryGb !== undefined) && result.gpu === false) throw new Error("placement gpu false asks for no GPU at all, so it takes no gpu_vendor or gpu_memory_gb");
  return result;
}

export function placementTarget(placement: PlacementRequirements): string {
  const wire = Object.entries(placementWireFields) as [string, keyof PlacementRequirements][];
  const parts = wire.filter(([, key]) => placement[key] !== undefined).map(([name, key]) => {
    const item = placement[key];
    return `${name} ${Array.isArray(item) ? item.join(",") : String(item)}`;
  });
  return parts.length ? parts.join(", ") : "any host";
}

export function modelPatternMatches(pattern: string, model: { id: string; provider: string; modelId: string }): boolean {
  if (pattern === model.id) return true;
  const name = `${model.provider}/${model.modelId}`;
  if (!/[*?]/.test(pattern)) return pattern === name;
  const expression = new RegExp(`^${pattern.split("").map(char => char === "*" ? ".*" : char === "?" ? "." : char.replace(/[\\^$.|+()[\]{}]/g, "\\$&")).join("")}$`, "i");
  return expression.test(name);
}

export interface PlacementHost {
  id: string;
  hardware?: ReportedHardware;
  gpuUsable: boolean;
}

export type PlacementCondition = Exclude<keyof PlacementRequirements, "hosts" | "models">;

export function unmetConditions(host: PlacementHost, requirements: PlacementRequirements, now = Date.now()): PlacementCondition[] {
  const unmet: PlacementCondition[] = [];
  const hardware = host.hardware;
  const fresh = hardwareFresh(hardware, now);
  const gpus = hardware?.gpus ?? [];
  if (requirements.gpu === true && !host.gpuUsable) unmet.push("gpu");
  if (requirements.gpu === false && host.gpuUsable) unmet.push("gpu");
  const usable = host.gpuUsable ? gpus : [];
  if (requirements.gpuVendor !== undefined && !usable.some(gpu => gpu.vendor === requirements.gpuVendor)) unmet.push("gpuVendor");
  if (requirements.gpuMemoryGb !== undefined && !usable.some(gpu => (gpu.memoryBytes ?? 0) >= requirements.gpuMemoryGb! * GiB)) unmet.push("gpuMemoryGb");
  if (requirements.minCpus !== undefined && !(hardware && hardware.cpus >= requirements.minCpus)) unmet.push("minCpus");
  if (requirements.minMemoryGb !== undefined && !(hardware && hardware.memoryBytes >= requirements.minMemoryGb * GiB)) unmet.push("minMemoryGb");
  if (requirements.minFreeMemoryGb !== undefined && !(hardware && fresh && hardware.freeMemoryBytes >= requirements.minFreeMemoryGb * GiB)) unmet.push("minFreeMemoryGb");
  if (requirements.minFreeDiskGb !== undefined && !(hardware?.freeDiskBytes !== undefined && fresh && hardware.freeDiskBytes >= requirements.minFreeDiskGb * GiB)) unmet.push("minFreeDiskGb");
  if (requirements.platform !== undefined && hardware?.platform.toLowerCase() !== requirements.platform.toLowerCase()) unmet.push("platform");
  if (requirements.arch !== undefined && hardware?.arch.toLowerCase() !== requirements.arch.toLowerCase()) unmet.push("arch");
  return unmet;
}

export function loadScore(host: Pick<PlacementHost, "hardware">, activeSessions: number, now = Date.now()): number {
  const hardware = host.hardware;
  const fresh = hardwareFresh(hardware, now);
  const cpu = fresh && hardware?.load ? hardware.load[0] / Math.max(1, hardware.cpus) : 0.5;
  const memory = fresh && hardware && hardware.memoryBytes > 0 ? 1 - hardware.freeMemoryBytes / hardware.memoryBytes : 0.5;
  return Math.round((activeSessions + cpu + memory) * 1000) / 1000;
}
