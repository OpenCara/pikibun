import { spawnSync } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { HELPER, type SandboxRequest } from "./sandbox.js";
import { egressPort, type HelperBackend, type HelperContext, type HelperLaunch, type HelperLayout } from "./helper-workspace.js";
import { connectorNode, toolchainPaths, type NodeToolchain } from "./node-toolchain.js";
import { firstExecutable } from "./platform.js";

export const SANDBOX_EXEC = "/usr/bin/sandbox-exec";

function developerDirectory(): string | undefined {
  const result = spawnSync("/usr/bin/xcode-select", ["-p"], { encoding: "utf8", env: { PATH: "/usr/bin:/bin" } });
  const path = result.status === 0 ? result.stdout.trim() : "";
  if (!path.startsWith("/")) return undefined;
  const app = /^(.*\.app)\/Contents\/Developer$/.exec(path);
  return app ? app[1] : path;
}

function xcrunFind(tool: string): string | undefined {
  const result = spawnSync("/usr/bin/xcrun", ["--find", tool], { encoding: "utf8", env: { PATH: "/usr/bin:/bin" } });
  const path = result.status === 0 ? result.stdout.trim() : "";
  return path.startsWith("/") && firstExecutable([path]) ? path : undefined;
}

export interface SeatbeltTools {
  sdk?: string;
  python: string;
  git: string;
  bash: string;
  roots: string[];
  nodeBin?: string;
  path: string;
}

export const SEATBELT_LOCAL_ROOTS = Object.freeze(["/opt/homebrew", "/usr/local/Homebrew", "/usr/local/Cellar", "/usr/local/opt", "/usr/local/bin", "/usr/local/lib",
  "/usr/local/share", "/usr/local/go", "/usr/local/cargo", "/usr/local/rustup"]);

export function seatbeltTools(node: NodeToolchain | undefined = connectorNode()): SeatbeltTools {
  const developer = developerDirectory();
  const python = xcrunFind("python3") ?? firstExecutable(["/opt/homebrew/bin/python3", "/usr/local/bin/python3"]);
  const git = xcrunFind("git") ?? firstExecutable(["/opt/homebrew/bin/git", "/usr/local/bin/git"]);
  if (!python || !git) throw new Error("The macOS sandbox needs Python 3 and Git from the developer tools: run xcode-select --install");
  const homebrew = SEATBELT_LOCAL_ROOTS.filter(path => existsSync(path));
  const roots = [...new Set([...[developer, ...homebrew, dirname(dirname(python)), dirname(dirname(git)), ...(node ? toolchainPaths(node) : [])].filter((path): path is string => !!path)
    .map(path => { try { return realpathSync(path); } catch { return path; } }),
    ...(node ? toolchainPaths(node) : [])])];
  const binaries = [existsSync("/opt/homebrew/bin") ? "/opt/homebrew/bin" : undefined, existsSync("/usr/local/bin") ? "/usr/local/bin" : undefined];
  const developerBin = (developer?.endsWith(".app") ? join(developer, "Contents", "Developer") : developer);
  const developerBins = developerBin ? [join(developerBin, "usr", "bin"), join(developerBin, "Toolchains", "XcodeDefault.xctoolchain", "usr", "bin")].filter(path => existsSync(path)) : [];
  const sdkResult = spawnSync("/usr/bin/xcrun", ["--show-sdk-path"], { encoding: "utf8", env: { PATH: "/usr/bin:/bin" } });
  const sdk = sdkResult.status === 0 && sdkResult.stdout.trim().startsWith("/") ? sdkResult.stdout.trim() : undefined;
  return {
    ...(sdk ? { sdk } : {}), python, git, bash: "/bin/bash", roots, ...(node ? { nodeBin: node.bin } : {}),
    path: [...developerBins, "/usr/bin", "/bin", "/usr/sbin", "/sbin", ...binaries.filter((path): path is string => !!path)].join(":"),
  };
}

export interface SeatbeltPolicy {
  layout: HelperLayout;
  readOnly: boolean;
  gitWritable: boolean;
  egressPort?: number;
  toolRoots: readonly string[];
}

export function seatbeltProfile(policy: SeatbeltPolicy): { profile: string; parameters: Record<string, string> } {
  const { layout } = policy;
  const parameters: Record<string, string> = {
    ROOT: layout.root, HOME_DIR: layout.home, WORKTREE: layout.worktree, GIT_DIR: layout.git, GIT_POINTER: join(layout.worktree, ".git"),
    OWNER_CONFIG: layout.ownerConfig, CA_BUNDLE: layout.caBundle, BIN: layout.bin,
  };
  policy.toolRoots.forEach((root, index) => { parameters[`TOOL_${index}`] = root; });
  const tools = policy.toolRoots.map((_, index) => `(subpath (param "TOOL_${index}"))`).join(" ");
  const lines = [
    "(version 1)",
    "(deny default)",
    "(allow process-exec process-fork)",
    "(allow signal (target same-sandbox))",
    "(allow process-info* (target same-sandbox))",
    `(allow sysctl-read ${SYSCTLS.map(name => name.endsWith(".") ? `(sysctl-name-prefix "${name}")` : `(sysctl-name "${name}")`).join(" ")})`,
    "(allow mach-lookup (global-name \"com.apple.system.opendirectoryd.libinfo\") (global-name \"com.apple.system.opendirectoryd.membership\") (global-name \"com.apple.bsd.dirhelper\"))",
    "(allow ipc-posix-sem)",
    "(allow pseudo-tty)",
    "(allow file-read* file-write* file-ioctl (literal \"/dev/ptmx\") (regex #\"^/dev/ttys[0-9]+$\"))",
    "(allow file-read* file-write-data (literal \"/dev/null\") (literal \"/dev/zero\") (literal \"/dev/random\") (literal \"/dev/urandom\") (literal \"/dev/dtracehelper\"))",
    "(allow file-read* file-write-data (subpath \"/dev/fd\"))",
    "(allow file-read-metadata)",
    `(allow file-read* ${SYSTEM_PATHS.map(path => `(subpath "${path}")`).join(" ")} (literal "/"))`,
    `(allow file-map-executable ${EXECUTABLE_PATHS.map(path => `(subpath "${path}")`).join(" ")}${tools ? ` ${tools}` : ""})`,
    ...(tools ? [`(allow file-read* ${tools})`] : []),
    "(allow file-read* (subpath (param \"HOME_DIR\")) (subpath (param \"WORKTREE\")) (subpath (param \"GIT_DIR\")) (subpath (param \"BIN\"))"
      + " (literal (param \"OWNER_CONFIG\")) (literal (param \"CA_BUNDLE\"))"
      + " (literal (param \"ROOT\")))",
  ];
  if (!policy.readOnly) {
    lines.push("(allow file-write* (subpath (param \"HOME_DIR\")) (subpath (param \"WORKTREE\")))");
    lines.push("(allow network-bind (local unix-socket (subpath (param \"HOME_DIR\"))) (local unix-socket (subpath (param \"WORKTREE\"))))");
    lines.push("(allow network-outbound (remote unix-socket (subpath (param \"HOME_DIR\"))) (remote unix-socket (subpath (param \"WORKTREE\"))))");
  }
  if (policy.gitWritable) lines.push("(allow file-write* (subpath (param \"GIT_DIR\")))");
  if (policy.egressPort !== undefined) {
    if (!Number.isInteger(policy.egressPort) || policy.egressPort < 1 || policy.egressPort > 65535) throw new Error("Invalid egress port");
    lines.push(`(allow network-outbound (remote ip "localhost:${policy.egressPort}"))`);
  }
  lines.push("(deny file-write* (literal (param \"GIT_POINTER\")))");
  if (!policy.gitWritable) lines.push("(deny file-write* (subpath (param \"GIT_DIR\")))");
  return { profile: `${lines.join("\n")}\n`, parameters };
}

const SYSTEM_PATHS = ["/bin", "/sbin", "/usr/bin", "/usr/sbin", "/usr/lib", "/usr/libexec", "/usr/share", "/System", "/Library/Apple",
  "/Library/Preferences", "/private/etc", "/private/var/db/timezone", "/private/var/db/dyld", "/private/var/select"];
const EXECUTABLE_PATHS = ["/usr/lib", "/System/Library/Frameworks", "/System/Library/PrivateFrameworks", "/System/Library/SubFrameworks",
  "/System/Library/Extensions", "/Library/Apple/System/Library/Frameworks", "/Library/Apple/System/Library/PrivateFrameworks", "/Library/Apple/usr/lib"];
const SYSCTLS = ["hw.activecpu", "hw.byteorder", "hw.cacheconfig", "hw.cachelinesize_compat", "hw.cpufamily", "hw.cputype", "hw.logicalcpu", "hw.logicalcpu_max",
  "hw.machine", "hw.model", "hw.memsize", "hw.ncpu", "hw.nperflevels", "hw.optional.", "hw.packages", "hw.pagesize", "hw.pagesize_compat",
  "hw.perflevel", "hw.physicalcpu", "hw.physicalcpu_max", "hw.tbfrequency_compat", "hw.vectorunit", "machdep.cpu.brand_string",
  "kern.argmax", "kern.hostname", "kern.maxfilesperproc", "kern.maxproc", "kern.osproductversion", "kern.osrelease", "kern.ostype",
  "kern.osvariant_status", "kern.osversion", "kern.secure_kernel", "kern.sysv.semmns", "kern.usrstack64", "kern.version",
  "sysctl.proc_cputype", "vm.loadavg", "kern.proc.pid.", "kern.proc.pgrp."];

export class SeatbeltBackend implements HelperBackend {
  readonly name = "macOS";
  readonly limitedShell = false;
  readonly #tools: SeatbeltTools;

  constructor(tools: SeatbeltTools = seatbeltTools()) {
    if (process.platform !== "darwin") throw new Error("The Seatbelt sandbox runs only on macOS");
    if (!firstExecutable([SANDBOX_EXEC])) throw new Error("The macOS sandbox needs /usr/bin/sandbox-exec");
    this.#tools = tools;
  }

  get path(): string { return this.#tools.path; }
  get nodeBin(): string | undefined { return this.#tools.nodeBin; }

  supports(_kind: SandboxRequest["kind"]): boolean { return true; }

  async prepare(_layout: HelperLayout): Promise<void> {}

  async launch(request: SandboxRequest, context: HelperContext, layout: HelperLayout): Promise<HelperLaunch> {
    const port = egressPort(context);
    const { profile, parameters } = seatbeltProfile({
      layout, readOnly: context.readOnly, gitWritable: context.gitWritable, toolRoots: this.#tools.roots,
      ...(port !== undefined ? { egressPort: port } : {}),
    });
    void request;
    return {
      command: SANDBOX_EXEC,
      args: ["-p", profile, ...Object.entries(parameters).flatMap(([name, value]) => ["-D", `${name}=${value}`]), this.#tools.python, "-I", "-c", HELPER],
      cwd: layout.worktree,
      env: {
        ...context.environment,
        SANDBOX_GITDIR: layout.git, SANDBOX_GIT: this.#tools.git, SANDBOX_BASH: this.#tools.bash, SANDBOX_OWNER_CONFIG: layout.ownerConfig,
        TMPDIR: join(layout.home, ".tmp"),
        CLANG_MODULE_CACHE_PATH: join(layout.home, ".cache", "clang", "ModuleCache"),
        ...(this.#tools.sdk ? { SDKROOT: this.#tools.sdk } : {}),
      },
    };
  }
}
