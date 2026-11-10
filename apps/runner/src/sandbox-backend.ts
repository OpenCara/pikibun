import { existsSync } from "node:fs";
import { join } from "node:path";
import { MXC_SDK_VERSION } from "./app-host-protocol.js";

export type SandboxBackendConfig =
  | { kind: "seatbelt" }
  | { kind: "windows"; runtime: string; limits: WindowsJobLimits };

export interface WindowsJobLimits {
  memoryBytes: number;
  processes: number;
  cpuPercent: number;
}

export const DEFAULT_WINDOWS_LIMITS: Readonly<WindowsJobLimits> = Object.freeze({ memoryBytes: 4 * 1024 ** 3, processes: 256, cpuPercent: 50 });

export { MXC_SDK_VERSION };

export function windowsRuntimeDirectory(stateDir: string): string {
  return process.env.PIKIBUN_MXC_RUNTIME || join(stateDir, "mxc");
}

export function mxcEntry(runtime: string): string | undefined {
  const entry = join(runtime, "node_modules", "@microsoft", "mxc-sdk", "dist", "v1", "index.js");
  return existsSync(entry) ? entry : undefined;
}

export function mxcInstallHint(runtime: string): string {
  return `npm install --prefix "${runtime}" @microsoft/mxc-sdk@${MXC_SDK_VERSION}`;
}

export function validWindowsLimits(limits: WindowsJobLimits): Readonly<WindowsJobLimits> {
  const { memoryBytes, processes, cpuPercent } = limits;
  if (!Number.isSafeInteger(memoryBytes) || memoryBytes < 64 * 1024 ** 2) throw new Error("Windows sandbox memory limit must be at least 64 MiB");
  if (!Number.isSafeInteger(processes) || processes < 4 || processes > 65_536) throw new Error("Windows sandbox process limit must be 4–65536");
  if (!Number.isSafeInteger(cpuPercent) || cpuPercent < 1 || cpuPercent > 100) throw new Error("Windows sandbox CPU limit must be 1–100 percent");
  return Object.freeze({ memoryBytes, processes, cpuPercent });
}
