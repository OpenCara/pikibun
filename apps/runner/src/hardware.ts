import { execFile } from "node:child_process";
import { existsSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { statfs } from "node:fs/promises";
import { arch, availableParallelism, cpus, freemem, loadavg, release, totalmem } from "node:os";
import { join } from "node:path";
import { gpuVendors, hardwareLimits, parseHardware, type GpuVendor, type HostGpu, type HostHardware } from "../../../packages/shared/src/hardware.js";

const PROBE_TIMEOUT_MS = 5000;
const PROBE_OUTPUT_BYTES = 256 * 1024;
const MiB = 1024 * 1024;
const CARD = /^card\d{1,4}$/;
const PCI_VENDORS: Record<string, GpuVendor> = { "0x10de": "nvidia", "0x1002": "amd", "0x1022": "amd", "0x8086": "intel", "0x106b": "apple" };
const WSL_NVIDIA_SMI = "/usr/lib/wsl/lib/nvidia-smi";

export type ProbeRun = (file: string, args: string[]) => Promise<string>;

export interface HardwareProbeOptions {
  root?: string;
  platform?: NodeJS.Platform;
  run?: ProbeRun;
}

function runProgram(file: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(file, args, { timeout: PROBE_TIMEOUT_MS, maxBuffer: PROBE_OUTPUT_BYTES, windowsHide: true, encoding: "utf8" }, (error, stdout) => {
      if (error) reject(error); else resolve(stdout);
    });
  });
}

export function cleanText(value: unknown): string {
  return typeof value === "string" ? value.replace(/[\x00-\x1f\x7f\u2028\u2029]+/g, " ").replace(/\s+/g, " ").trim().slice(0, hardwareLimits.text) : "";
}

function vendorOf(text: string): GpuVendor {
  const lower = text.toLowerCase();
  return lower.includes("nvidia") ? "nvidia" : lower.includes("amd") || lower.includes("radeon") || lower.includes("ati ") ? "amd"
    : lower.includes("intel") ? "intel" : lower.includes("apple") ? "apple" : "other";
}

function readText(path: string): string | undefined {
  try { return readFileSync(path, "utf8").trim(); } catch { return undefined; }
}

export function sysfsGpus(root = "/"): HostGpu[] {
  const drm = join(root, "sys/class/drm");
  let names: string[];
  try { names = readdirSync(drm).filter(name => CARD.test(name)).sort(); } catch { return []; }
  const seen = new Set<string>();
  const gpus: HostGpu[] = [];
  for (const name of names) {
    const device = join(drm, name, "device");
    let real: string;
    try { real = realpathSync(device); } catch { continue; }
    if (seen.has(real)) continue;
    seen.add(real);
    const vendorId = readText(join(device, "vendor"))?.toLowerCase();
    const vendor: GpuVendor = (vendorId ? PCI_VENDORS[vendorId] : undefined) ?? "other";
    const vram = Number(readText(join(device, "mem_info_vram_total")));
    const product = cleanText(readText(join(device, "product_name")));
    gpus.push({ vendor, ...(product ? { name: product } : {}), ...(Number.isSafeInteger(vram) && vram > 0 ? { memoryBytes: vram } : {}) });
  }
  return gpus;
}

export function parseNvidiaSmi(output: string): HostGpu[] {
  return output.split(/\r?\n/).map(line => line.trim()).filter(Boolean).map(line => {
    const [name, memory] = line.split(",").map(part => part.trim());
    const mib = Number(memory);
    const label = cleanText(name);
    return { vendor: "nvidia" as const, ...(label ? { name: label } : {}), ...(Number.isFinite(mib) && mib > 0 ? { memoryBytes: Math.round(mib * MiB) } : {}) };
  });
}

export function parseSystemProfiler(output: string): HostGpu[] {
  let value: unknown;
  try { value = JSON.parse(output); } catch { return []; }
  const items = (value as { SPDisplaysDataType?: unknown })?.SPDisplaysDataType;
  if (!Array.isArray(items)) return [];
  return items.filter(item => item && typeof item === "object").map(item => {
    const entry = item as Record<string, unknown>;
    const name = cleanText(entry.sppci_model ?? entry._name);
    const vendor = vendorOf(`${cleanText(entry.spdisplays_vendor)} ${name}`);
    const vram = /^(\d+(?:\.\d+)?)\s*(MB|GB)$/i.exec(cleanText(entry.spdisplays_vram ?? entry.spdisplays_vram_shared));
    const memoryBytes = vram ? Math.round(Number(vram[1]) * (vram[2]!.toUpperCase() === "GB" ? 1024 : 1) * MiB) : undefined;
    return { vendor, ...(name ? { name } : {}), ...(memoryBytes ? { memoryBytes } : {}) };
  });
}

export async function probeGpus(options: HardwareProbeOptions = {}): Promise<HostGpu[]> {
  const root = options.root ?? "/";
  const platform = options.platform ?? process.platform;
  const run = options.run ?? runProgram;
  const attempt = async (file: string, args: string[]) => { try { return await run(file, args); } catch { return undefined; } };
  if (platform === "darwin") {
    const output = await attempt("system_profiler", ["SPDisplaysDataType", "-json"]);
    return output ? parseSystemProfiler(output).slice(0, hardwareLimits.gpus) : [];
  }
  const nvidiaArgs = ["--query-gpu=name,memory.total", "--format=csv,noheader,nounits"];
  let nvidia: HostGpu[] = [];
  for (const file of platform === "linux" && existsSync(join(root, WSL_NVIDIA_SMI.slice(1))) ? [WSL_NVIDIA_SMI, "nvidia-smi"] : ["nvidia-smi"]) {
    const output = await attempt(file, nvidiaArgs);
    if (output) { nvidia = parseNvidiaSmi(output); break; }
  }
  const found = platform === "linux" ? sysfsGpus(root) : [];
  const gpus = nvidia.length ? [...nvidia, ...found.filter(gpu => gpu.vendor !== "nvidia")] : found;
  if (!gpus.length && platform === "linux" && existsSync(join(root, "dev/dxg"))) gpus.push({ vendor: "microsoft" });
  return gpus.filter(gpu => gpuVendors.includes(gpu.vendor)).slice(0, hardwareLimits.gpus);
}

function isWsl(root: string): boolean {
  return /microsoft|wsl/i.test(readText(join(root, "proc/sys/kernel/osrelease")) ?? "");
}

export class HardwareProbe {
  #gpus?: Promise<HostGpu[]>;

  constructor(private readonly dataDir: string, private readonly options: HardwareProbeOptions = {}) {}

  async report(): Promise<HostHardware> {
    const platform = this.options.platform ?? process.platform;
    const root = this.options.root ?? "/";
    this.#gpus ??= probeGpus(this.options).catch(() => []);
    const gpus = await this.#gpus;
    let disk: { diskBytes: number; freeDiskBytes: number } | undefined;
    try {
      const stats = await statfs(this.dataDir);
      const diskBytes = Number(stats.blocks) * Number(stats.bsize);
      const freeDiskBytes = Number(stats.bavail) * Number(stats.bsize);
      if (Number.isSafeInteger(diskBytes) && Number.isSafeInteger(freeDiskBytes) && freeDiskBytes <= diskBytes) disk = { diskBytes, freeDiskBytes };
    } catch { }
    const memoryBytes = totalmem();
    const load = platform === "win32" ? undefined : loadavg().map(value => Math.round(Math.max(0, value) * 100) / 100) as [number, number, number];
    return parseHardware({
      platform, release: cleanText(release()), arch: arch(), ...(platform === "linux" && isWsl(root) ? { wsl: true } : {}),
      cpuModel: cleanText(cpus()[0]?.model), cpus: Math.max(1, availableParallelism()),
      memoryBytes, freeMemoryBytes: Math.min(freemem(), memoryBytes), ...(disk ?? {}), ...(load ? { load } : {}), gpus,
    });
  }
}
