import { existsSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { availableParallelism } from "node:os";
import { join, relative, sep } from "node:path";
import { defaultHostConfig, hostConfigLimits, readHostConfig, type GpuKind, type HostConfig, type RequiredExtension } from "../../../packages/shared/src/host-config.js";

const CONFIG_TTL_MS = 30_000;
const CONFIG_STALE_MS = 5 * 60_000;

export class HostConfigSource {
  #cached?: { value: HostConfig; at: number };
  #refresh?: Promise<HostConfig>;
  #expired = false;
  #answers = 0;
  #required?: RequiredExtension[];

  constructor(private readonly load: () => Promise<unknown>, private readonly options: { ttlMs?: number; staleMs?: number; now?: () => number } = {}) {}

  async current(): Promise<HostConfig> {
    const now = this.options.now ?? Date.now;
    const cached = this.#cached;
    if (cached && !this.#expired && now() - cached.at < (this.options.ttlMs ?? CONFIG_TTL_MS)) return cached.value;
    this.#refresh ??= this.load().then(value => {
      const config = readHostConfig(value);
      this.#cached = { value: config, at: now() };
      this.#answers++;
      this.#required = config.requiredExtensions;
      return config;
    }).finally(() => { this.#refresh = undefined; this.#expired = false; });
    try { return await this.#refresh; }
    catch {
      if (cached && now() - cached.at < (this.options.staleMs ?? CONFIG_STALE_MS)) return cached.value;
      return { ...defaultHostConfig };
    }
  }

  async required(): Promise<RequiredExtension[] | undefined> {
    await this.current();
    return this.#required;
  }

  async refresh(): Promise<{ config: HostConfig; answered: boolean }> {
    const answers = this.#answers;
    this.#expired = true;
    const config = await this.current();
    return { config, answered: this.#answers !== answers };
  }
}

export interface CommandLimits {
  seconds: number;
  cpuSeconds: number;
  fileBytes: number;
  openFiles: number;
}

const MiB = 1024 * 1024;

export function commandLimits(seconds: number, cpus = availableParallelism()): CommandLimits {
  const { min, max } = hostConfigLimits.commandTimeoutSeconds;
  const bounded = Math.min(Math.max(Math.trunc(Number.isFinite(seconds) ? seconds : min), min), max);
  if (bounded <= min) return { seconds: min, cpuSeconds: 25, fileBytes: 64 * MiB, openFiles: 256 };
  return { seconds: bounded, cpuSeconds: bounded * Math.max(1, Math.trunc(cpus)), fileBytes: 16 * 1024 * MiB, openFiles: 8192 };
}

/** The most a tool call's timeout_seconds asks for: never more than the longest command time limit a host can have. */
export const CALL_TIMEOUT_MAX_SECONDS = hostConfigLimits.commandTimeoutSeconds.max;

/** A tool call's own timeout_seconds, checked: whole seconds, from 1 to CALL_TIMEOUT_MAX_SECONDS, or none. */
export function callTimeout(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > CALL_TIMEOUT_MAX_SECONDS) {
    throw new Error(`timeout_seconds is whole seconds, from 1 to ${CALL_TIMEOUT_MAX_SECONDS}`);
  }
  return value as number;
}

/** The host's limits for a command, ended sooner by a call's own timeout: it never lengthens them, nor changes the rest of them. */
export function callLimits(limits: CommandLimits, timeoutSeconds?: number): CommandLimits {
  return timeoutSeconds === undefined || timeoutSeconds >= limits.seconds ? limits : { ...limits, seconds: timeoutSeconds };
}

export interface GpuMounts { kind: GpuKind; args: string[]; env: Record<string, string> }

const DXG = "dev/dxg";
const WSL_LIBRARIES = "usr/lib/wsl/lib";
const RENDER_NODE = /^renderD\d{1,4}$/;
const DEVICE_NUMBER = /^\d{1,6}:\d{1,6}$/;

export function gpuMounts(root = "/"): GpuMounts | undefined {
  let base: string;
  try { base = realpathSync(root); }
  catch { return undefined; }
  const at = (path: string) => join(base, path);
  const inside = (path: string) => `/${relative(base, path).split(sep).join("/")}`;
  if (existsSync(at(DXG))) {
    return { kind: "dxg", args: ["--dev-bind", at(DXG), "/dev/dxg"], env: existsSync(at(WSL_LIBRARIES)) ? { LD_LIBRARY_PATH: `/${WSL_LIBRARIES}` } : {} };
  }
  let names: string[];
  try { names = readdirSync(at("dev/dri")).filter(name => RENDER_NODE.test(name)).sort(); }
  catch { return undefined; }
  const devices = at("sys/devices");
  const args: string[] = [];
  const bound = new Set<string>();
  for (const name of names) {
    try {
      const number = readFileSync(at(`sys/class/drm/${name}/dev`), "utf8").trim();
      const node = realpathSync(at(`sys/class/drm/${name}`));
      const device = realpathSync(at(`sys/class/drm/${name}/device`));
      if (!DEVICE_NUMBER.test(number) || ![node, device].every(path => path.startsWith(`${devices}${sep}`))) continue;
      args.push("--dev-bind", at(`dev/dri/${name}`), `/dev/dri/${name}`);
      if (!bound.has(device)) { args.push("--ro-bind", device, inside(device)); bound.add(device); }
      args.push("--symlink", inside(node), `/sys/dev/char/${number}`);
    } catch { }
  }
  return args.length ? { kind: "render", args, env: {} } : undefined;
}

export function detectGpu(root = "/"): GpuKind | undefined {
  return gpuMounts(root)?.kind;
}
