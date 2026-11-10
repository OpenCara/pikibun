import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { accessSync, constants } from "node:fs";
import { dirname, join } from "node:path";
import { WindowsJob } from "./windows-job.js";

export const windows = process.platform === "win32";

export const OPEN_FILE = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0);
export const OPEN_DIRECTORY = constants.O_RDONLY | (constants.O_DIRECTORY ?? 0) | (constants.O_NOFOLLOW ?? 0);
export const CREATE_FILE = constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0);

export function privateEntry(info: { uid: number | bigint; mode: number | bigint }, mask = 0o077): boolean {
  if (windows) return true;
  return Number(info.uid) === process.getuid?.() && (Number(info.mode) & mask) === 0;
}

export function exactMode(info: { uid: number | bigint; mode: number | bigint }, mode: number): boolean {
  if (windows) return true;
  return Number(info.uid) === process.getuid?.() && (Number(info.mode) & 0o777) === mode;
}

function executable(path: string): boolean {
  try { accessSync(path, constants.X_OK); return true; } catch { return false; }
}

export function firstExecutable(paths: readonly (string | undefined)[]): string | undefined {
  return paths.find((path): path is string => !!path && executable(path));
}

export function bashPath(): string | undefined {
  if (!windows) return firstExecutable(["/bin/bash", "/usr/bin/bash"]);
  const programs = [process.env.ProgramW6432, process.env.ProgramFiles, process.env["ProgramFiles(x86)"]];
  return firstExecutable([
    process.env.PIKIBUN_BASH,
    ...programs.map(root => root && join(root, "Git", "bin", "bash.exe")),
    process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA, "Programs", "Git", "bin", "bash.exe"),
    gitForWindowsRoot() && join(gitForWindowsRoot()!, "bin", "bash.exe"),
  ]);
}

export function sandboxShellPath(): string | undefined {
  if (!windows) return undefined;
  if (process.env.PIKIBUN_SANDBOX_SHELL) return firstExecutable([process.env.PIKIBUN_SANDBOX_SHELL]);
  const root = gitForWindowsRoot();
  return firstExecutable([
    process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA, "Programs", "busybox", "busybox.exe"),
    root && join(root, "mingw64", "bin", "busybox.exe"),
  ]);
}

export const SANDBOX_SHELL_HINT = "download busybox64.exe from https://frippery.org/busybox/ and save it as %LOCALAPPDATA%\\Programs\\busybox\\busybox.exe";

export function sandboxNodePath(): string {
  return process.execPath;
}

let gitRoot: string | null | undefined;
export function gitForWindowsRoot(): string | undefined {
  if (!windows) return undefined;
  if (gitRoot === undefined) {
    const result = spawnSync("git", ["--exec-path"], { encoding: "utf8", windowsHide: true, env: { PATH: process.env.PATH ?? "" } });
    const exec = result.status === 0 ? result.stdout.trim() : "";
    gitRoot = exec ? dirname(dirname(dirname(exec))) : null;
  }
  return gitRoot ?? undefined;
}

export function windowsSystemEnvironment(): Record<string, string> {
  const names = ["SystemRoot", "windir", "SystemDrive", "ComSpec", "PATHEXT", "ProgramData", "ProgramFiles", "ProgramFiles(x86)", "ProgramW6432",
    "CommonProgramFiles", "CommonProgramW6432", "LOCALAPPDATA", "APPDATA", "USERPROFILE", "USERNAME", "USERDOMAIN", "COMPUTERNAME",
    "NUMBER_OF_PROCESSORS", "PROCESSOR_ARCHITECTURE", "OS"];
  return Object.fromEntries(names.flatMap(name => process.env[name] === undefined ? [] : [[name, process.env[name]!]]));
}

export const NULL_DEVICE = windows ? "NUL" : "/dev/null";

const WINDOWS_HOST_BASH = "IFS= read -r -d '' __pikibun_command || exit 125; exec 0</dev/null; eval \"unset __pikibun_command; $__pikibun_command\"";

export function hostBashArgs(command: string): string[] {
  return ["--noprofile", "--norc", "-c", windows ? WINDOWS_HOST_BASH : command];
}

const hostJobs = new WeakMap<ChildProcess, WindowsJob>();

export function startHostBash(child: ChildProcess, command: string): void {
  if (!windows) { child.stdin?.end(); return; }
  if (child.pid) {
    const job = WindowsJob.hostJob();
    if (job) {
      try {
        job.assign(child.pid);
        hostJobs.set(child, job);
        child.once("close", () => job.release());
      } catch { job.release(); }
    }
  }
  child.stdin?.end(`${command}\0`);
}

export function killTree(child: ChildProcess): void {
  if (!child.pid) return;
  const job = hostJobs.get(child);
  if (job) { job.terminate(); return; }
  if (windows) {
    const killer = spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
    killer.on("error", () => child.kill());
    return;
  }
  try { process.kill(-child.pid, "SIGKILL"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") child.kill("SIGKILL"); }
}
