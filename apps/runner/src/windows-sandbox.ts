import { spawnSync } from "node:child_process";
import { chmod, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { egressPort, type HelperBackend, type HelperContext, type HelperLaunch, type HelperLayout } from "./helper-workspace.js";
import { NODE_HELPER, NODE_HELPER_KINDS } from "./node-helper.js";
import { gitForWindowsRoot, SANDBOX_SHELL_HINT, sandboxNodePath, sandboxShellPath } from "./platform.js";
import { mxcEntry, mxcInstallHint, validWindowsLimits, type WindowsJobLimits } from "./sandbox-backend.js";
import type { SandboxRequest } from "./sandbox.js";
import { WindowsJob } from "./windows-job.js";

export const WINDOWS_RUNNER = String.raw`
import { pathToFileURL } from "node:url";

const pending = [];
let config;
let buffered = Buffer.alloc(0);
const first = new Promise((resolve, reject) => {
  const onData = chunk => {
    buffered = Buffer.concat([buffered, chunk]);
    const end = buffered.indexOf(10);
    if (end < 0) { if (buffered.length > 1024 * 1024) reject(new Error("configuration too large")); return; }
    process.stdin.off("data", onData);
    process.stdin.pause();
    try { config = JSON.parse(buffered.subarray(0, end).toString("utf8")); } catch { reject(new Error("invalid configuration")); return; }
    if (buffered.length > end + 1) pending.push(buffered.subarray(end + 1));
    resolve();
  };
  process.stdin.on("data", onData);
  process.stdin.on("end", () => { if (!config) reject(new Error("no configuration")); });
});

function fail(message, code = 70) {
  process.stderr.write("sandbox: " + message + "\n");
  process.exit(code);
}

try { await first; } catch (error) { fail(error.message); }
const sdk = await import(pathToFileURL(config.sdk).href).catch(() => fail("the MXC SDK could not be loaded from " + config.sdk));
let probe;
try { probe = sdk.probe(config.request); } catch (error) { fail("this Windows can't run the process container: " + (error && error.message || "probe failed")); }
if (probe.error || probe.tier !== "base-container" || (probe.warnings && probe.warnings.length)) {
  fail("this Windows can't run the OS process container (MXC chose " + (probe.tier || "nothing") + (probe.error ? ": " + probe.error : "")
    + "); Pikibun never uses MXC's AppContainer fallbacks. it needs Windows 11 24H2 or later with the latest update, or run the connector in WSL2");
}
let child;
try { child = await sdk.spawn(config.request); } catch (error) { fail("the process container could not start: " + (error && error.message || "unknown error")); }
const input = child.standardInput;
if (!input) fail("the process container has no standard input");
for (const chunk of pending) input.write(chunk);
if (process.stdin.readableEnded) input.end();
else {
  process.stdin.on("data", chunk => input.write(chunk));
  process.stdin.on("end", () => input.end());
  process.stdin.resume();
}
const copies = [[child.standardOutput, process.stdout], [child.standardError, process.stderr]].filter(([from]) => from).map(([from, to]) =>
  new Promise(resolve => { from.on("data", chunk => to.write(chunk)); from.on("end", resolve); from.on("error", resolve); }));
const result = await child.wait();
await Promise.all(copies);
process.exitCode = result.timedOut ? 124 : result.exitCode;
`;

export const WINDOWS_SUPPORT_CHECK = String.raw`
import { pathToFileURL } from "node:url";
import { dirname } from "node:path";
const [sdkPath, directory, system] = process.argv.slice(1);
const done = value => { process.stdout.write(JSON.stringify(value) + "\n"); process.exit(0); };
let sdk;
try { sdk = await import(pathToFileURL(sdkPath).href); } catch { done({ error: "the MXC SDK could not be loaded from " + sdkPath }); }
const resolve = "process.stdout.write(JSON.stringify(require('fs').realpathSync.native('.')))";
const request = {
  command: '"' + process.execPath + '" -e "' + resolve + '"',
  containment: { type: "processcontainer" },
  filesystem: { readwritePaths: [directory], readonlyPaths: [system, dirname(process.execPath)], deniedPaths: [] },
  network: { egress: { default: "deny" }, ingress: { default: "allow", hostLoopback: "allow" }, runtimeConfig: { networkProxy: "http://127.0.0.1:9" } },
  ui: { disable: false }, workingDirectory: directory, inheritDefaultEnvironment: false, timeoutMs: 30000,
  environment: { SystemRoot: system, windir: system, PATH: system + "\\System32", LOCALAPPDATA: directory, TEMP: directory, TMP: directory },
};
let probe;
try { probe = sdk.probe(request); } catch (error) { done({ error: "MXC's probe failed: " + (error && error.message || "unknown error") }); }
const result = { tier: probe.tier || null, warnings: probe.warnings || [], probeError: probe.error || null,
  identitylessProxy: !!(probe.probes && probe.probes.baseContainerSupportsIdentitylessLoopbackProxy) };
if (result.tier !== "base-container" || result.warnings.length || result.probeError || !result.identitylessProxy) done(result);
try {
  const child = await sdk.spawn(request);
  let stdout = "", stderr = "";
  child.standardInput && child.standardInput.end();
  const copies = [[child.standardOutput, chunk => stdout += chunk], [child.standardError, chunk => stderr += chunk]].filter(([from]) => from)
    .map(([from, add]) => new Promise(resolve => { from.on("data", add); from.on("end", resolve); from.on("error", resolve); }));
  const exit = await child.wait();
  await Promise.all(copies);
  let resolved = null;
  try { resolved = JSON.parse(stdout); } catch {}
  done({ ...result, resolved, exitCode: exit.exitCode, stderr: stderr.slice(0, 500) });
} catch (error) { done({ ...result, error: "the process container could not start: " + (error && error.message || "unknown error") }); }
`;

export function windowsBuild(): string | undefined {
  if (process.platform !== "win32") return undefined;
  const result = spawnSync("reg", ["query", "HKLM\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion", "/v", "CurrentBuild"], { encoding: "utf8", windowsHide: true });
  const ubr = spawnSync("reg", ["query", "HKLM\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion", "/v", "UBR"], { encoding: "utf8", windowsHide: true });
  const build = /CurrentBuild\s+REG_SZ\s+(\d+)/.exec(result.stdout ?? "")?.[1];
  const update = /UBR\s+REG_DWORD\s+0x([0-9a-f]+)/i.exec(ubr.stdout ?? "")?.[1];
  return build ? `${build}${update ? `.${Number.parseInt(update, 16)}` : ""}` : undefined;
}

export interface WindowsSandboxSupport {
  container: boolean;
  paths: boolean;
  detail?: string;
}

export async function windowsSandboxSupport(sdk: string, node: string): Promise<WindowsSandboxSupport> {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "pikibun-sandbox-check-")));
  try {
    const system = process.env.SystemRoot ?? "C:\\Windows";
    const run = spawnSync(node, ["--input-type=module", "-e", WINDOWS_SUPPORT_CHECK, sdk, directory, system], {
      encoding: "utf8", windowsHide: true, timeout: 60_000, cwd: directory,
      env: { SystemRoot: system, windir: system, PATH: [join(system, "System32"), system].join(";"), TEMP: directory, TMP: directory,
        ...(process.env.LOCALAPPDATA ? { LOCALAPPDATA: process.env.LOCALAPPDATA } : {}), ...(process.env.SystemDrive ? { SystemDrive: process.env.SystemDrive } : {}) },
    });
    let result: { error?: string; tier?: string | null; warnings?: string[]; probeError?: string | null; identitylessProxy?: boolean; resolved?: unknown; exitCode?: number; stderr?: string };
    try { result = JSON.parse(run.stdout.trim().split("\n").at(-1) ?? ""); }
    catch { return { container: false, paths: false, detail: `the check could not run${run.error ? ` (${run.error.message})` : ""}` }; }
    const container = !result.error && result.tier === "base-container" && !result.warnings?.length && !result.probeError && result.identitylessProxy === true;
    if (!container) {
      return { container: false, paths: false, detail: result.error ?? `MXC chose ${result.tier ?? "nothing"}${result.probeError ? `: ${result.probeError}` : ""}${result.warnings?.length ? ` (${result.warnings.join("; ")})` : ""}${result.identitylessProxy === false ? ", without proxy-only egress for the connector's proxy" : ""}` };
    }
    const paths = typeof result.resolved === "string" && result.resolved.toLowerCase() === directory.toLowerCase();
    return paths ? { container, paths } : { container, paths, detail: result.error ?? `resolving a path in the container failed${result.stderr ? `: ${result.stderr.trim().split("\n").find(line => /Error|EPERM|denied/i.test(line)) ?? result.stderr.trim().split("\n")[0]}` : ""}` };
  } finally {
    await rm(directory, { recursive: true, force: true }).catch(() => undefined);
  }
}

export interface WindowsBackendOptions {
  runtime: string;
  limits: WindowsJobLimits;
}

export class WindowsBackend implements HelperBackend {
  readonly name = "Windows";
  readonly limitedShell = true;
  readonly path: string;
  readonly #runtime: string;
  readonly #sdk: string;
  readonly #limits: Readonly<WindowsJobLimits>;
  readonly #git: string;
  readonly #bash: string;
  readonly #gitRoot: string;
  readonly #node: string;

  constructor(options: WindowsBackendOptions) {
    if (process.platform !== "win32") throw new Error("The Windows sandbox runs only on Windows");
    const sdk = mxcEntry(options.runtime);
    if (!sdk) throw new Error(`The Windows sandbox needs Microsoft's MXC SDK. Install it with: ${mxcInstallHint(options.runtime)}`);
    const gitRoot = gitForWindowsRoot();
    if (!gitRoot) throw new Error("The Windows sandbox needs Git for Windows: install it from https://git-scm.com/download/win");
    const bash = sandboxShellPath();
    if (!bash) throw new Error(`The Windows sandbox needs busybox-w32 as its shell (Git for Windows' bash can't start in the process container): ${SANDBOX_SHELL_HINT}`);
    const node = sandboxNodePath();
    this.#node = node;
    this.#runtime = options.runtime;
    this.#sdk = sdk;
    this.#limits = validWindowsLimits(options.limits);
    this.#gitRoot = gitRoot;
    this.#git = join(gitRoot, "cmd", "git.exe");
    this.#bash = bash;
    const system = process.env.SystemRoot ?? "C:\\Windows";
    this.path = [join(gitRoot, "usr", "bin"), join(gitRoot, "mingw64", "bin"), join(gitRoot, "cmd"), dirname(node),
      join(system, "System32"), system, join(system, "System32", "WindowsPowerShell", "v1.0")].join(";");
  }

  supports(kind: SandboxRequest["kind"]): boolean { return NODE_HELPER_KINDS.has(kind); }

  async prepare(layout: HelperLayout): Promise<void> {
    for (const [name, source] of [["helper.mjs", NODE_HELPER], ["runner.mjs", WINDOWS_RUNNER]] as const) {
      const path = join(layout.bin, name);
      await chmod(path, 0o600).catch(() => undefined);
      await rm(path, { force: true });
      await writeFile(path, source, { mode: 0o400 });
      await chmod(path, 0o400);
    }
  }

  async launch(request: SandboxRequest, context: HelperContext, layout: HelperLayout): Promise<HelperLaunch> {
    const system = process.env.SystemRoot ?? "C:\\Windows";
    const port = egressPort(context);
    const environment: Record<string, string> = {
      ...context.environment,
      SANDBOX_GITDIR: layout.git, SANDBOX_GIT: this.#git, SANDBOX_BASH: this.#bash, SANDBOX_OWNER_CONFIG: layout.ownerConfig,
      SystemRoot: system, windir: system, PATH: this.path,
      TEMP: join(layout.home, ".tmp"), TMP: join(layout.home, ".tmp"), USERPROFILE: layout.home,
      LOCALAPPDATA: join(layout.home, "AppData", "Local"), APPDATA: join(layout.home, "AppData", "Roaming"),
      MSYSTEM: "MINGW64", CHERE_INVOKING: "1",
      NODE_OPTIONS: "--preserve-symlinks --preserve-symlinks-main",
      ...(port !== undefined ? { SANDBOX_EGRESS_PROXY: context.environment.HTTPS_PROXY!, SANDBOX_EGRESS_NO_PROXY: context.environment.NO_PROXY ?? "" } : {}),
    };
    const readonly = [system, dirname(this.#node), this.#gitRoot, this.#bash, layout.bin, layout.ownerConfig, layout.caBundle, join(layout.worktree, ".git"),
      ...(context.gitWritable ? [] : [layout.git])];
    const readwrite = context.readOnly ? [] : [layout.home, layout.worktree, ...(context.gitWritable ? [layout.git] : [])];
    if (context.readOnly) readonly.push(layout.home, layout.worktree);
    const containerRequest = {
      command: `"${this.#node}" --preserve-symlinks-main --preserve-symlinks "${join(layout.bin, "helper.mjs")}"`,
      containment: { type: "processcontainer" },
      filesystem: { readwritePaths: readwrite, readonlyPaths: readonly, deniedPaths: [] },
      network: port !== undefined
        ? { egress: { default: "deny" }, ingress: { default: "allow", hostLoopback: "allow" }, runtimeConfig: { networkProxy: `http://127.0.0.1:${port}` } }
        : { egress: { default: "deny" }, ingress: { default: "deny", hostLoopback: "deny" } },
      ui: { disable: false },
      workingDirectory: layout.worktree,
      environment,
      inheritDefaultEnvironment: false,
      timeoutMs: context.deadlineMs,
    };
    let job: WindowsJob | undefined;
    void request;
    return {
      command: this.#node,
      args: [join(layout.bin, "runner.mjs")],
      cwd: layout.root,
      env: { SystemRoot: system, windir: system, PATH: [join(system, "System32"), system].join(";"), TEMP: join(layout.home, ".tmp"), TMP: join(layout.home, ".tmp"),
        ...(process.env.LOCALAPPDATA ? { LOCALAPPDATA: process.env.LOCALAPPDATA } : {}), ...(process.env.SystemDrive ? { SystemDrive: process.env.SystemDrive } : {}) },
      started: async child => {
        if (!child.pid) throw new Error("the sandbox runner did not start");
        job = WindowsJob.create(this.#runtime, this.#limits);
        job.assign(child.pid);
        return JSON.stringify({ sdk: this.#sdk, request: containerRequest });
      },
      finished: () => { job?.close(); job = undefined; },
    };
  }
}
