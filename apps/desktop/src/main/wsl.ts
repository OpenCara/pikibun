import { execFile } from "node:child_process";
import { join } from "node:path";
import type { WslDistro, WslStatus } from "../shared/bridge.js";

// WSL2 on Windows: which distributions this computer has, and how the app starts its connector host in one of them
// (wsl-host.sh, over stdio: host-process.ts stdioHost). Sessions there run in WSL2's bubblewrap sandbox, with WSL2's
// own Pi configuration and connector state, as `pikibun connect` run in that distribution does. Pure but for wslStatus,
// so tests run it without Windows.

/** Distribution names as WSL registers them; nothing else ever reaches wsl.exe's command line. */
export const WSL_DISTRO = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/** Docker Desktop's own distributions run its engine, not a user's tools. */
const internal = (name: string) => /^docker-desktop(-data)?$/i.test(name);

export const wslExe = (): string => join(process.env.SystemRoot || "C:\\Windows", "System32", "wsl.exe");

/**
 * `wsl.exe --list --verbose`: a header, then one line per distribution, `*` marking the default, then its name, state
 * and WSL version. The header and states are localized; names and versions aren't. wsl.exe writes UTF-16 unless
 * WSL_UTF8 is set, so NULs and a byte-order mark are dropped first.
 */
export function parseWslList(output: string): WslDistro[] {
  const distros: WslDistro[] = [];
  for (const raw of output.replace(/\u0000/g, "").replace(/^\uFEFF/, "").split(/\r?\n/)) {
    const match = /^\s*(\*)?\s*(\S+)\s+.+?\s+(\d+)\s*$/.exec(raw);
    if (!match || !WSL_DISTRO.test(match[2]!) || internal(match[2]!)) continue;
    distros.push({ name: match[2]!, version: Number(match[3]), default: match[1] === "*" });
  }
  return distros;
}

/** What this computer has: wsl.exe's list, or why there is none. */
export function wslStatus(): Promise<WslStatus> {
  return new Promise(resolve => {
    execFile(wslExe(), ["--list", "--verbose"], { env: { ...process.env, WSL_UTF8: "1" }, encoding: "buffer", windowsHide: true, timeout: 20_000 }, (error, stdout) => {
      const text = (bytes: Buffer) => bytes.includes(0) ? bytes.toString("utf16le") : bytes.toString("utf8");
      const distros = error ? [] : parseWslList(text(stdout));
      resolve({ installed: !error, distros });
    });
  });
}

const SETUP = "In PowerShell, run wsl --install (it installs Ubuntu on WSL2), restart if it asks, and open Ubuntu once to create your user. Then install Node.js 24, Pi, bubblewrap, Python 3, Git and util-linux there (on Ubuntu: sudo apt install bubblewrap python3 git util-linux), and configure Pi's models in WSL2.";

/**
 * The distribution a host runs in: the owner's choice, else WSL's default, else the first WSL2 one. Refused, with what
 * to do, where there is none or it runs on WSL 1, whose kernel has no namespaces for the sandbox.
 */
export function chooseDistro(status: WslStatus, chosen: string | undefined): { ok: true; name: string } | { ok: false; error: string } {
  if (!status.installed || !status.distros.length) return { ok: false, error: `WSL2 isn't set up on this computer. ${SETUP} Or choose Native Windows as this host's sandbox.` };
  const named = chosen === undefined ? undefined : status.distros.find(distro => distro.name === chosen);
  if (chosen !== undefined && !named) return { ok: false, error: `This host runs in the WSL distribution ${chosen}, which this computer no longer has. Choose another one.` };
  const distro = named ?? status.distros.find(entry => entry.default && entry.version === 2) ?? status.distros.find(entry => entry.version === 2) ?? status.distros.find(entry => entry.default);
  if (!distro) return { ok: false, error: `WSL2 isn't set up on this computer. ${SETUP}` };
  if (distro.version !== 2) return { ok: false, error: `${distro.name} runs on WSL 1, which has no sandbox. In PowerShell, run wsl --set-version ${distro.name} 2, or choose another distribution.` };
  return { ok: true, name: distro.name };
}

/** A connection's state directory inside WSL2: the CLI's own for the primary one, as on every other platform. */
export const wslStateDir = (id: string, primary: boolean): string | undefined => primary ? undefined : `~/.local/share/pikibun/connections/${id}`;

/**
 * wsl.exe's arguments for the host: in `distro`, from the app's connector directory (a Windows path, which --cd
 * translates), wsl-host.sh with the app's build name and the host's own options. No secret is ever among them.
 */
export function wslHostArgs(input: { distro: string; connector: string; build: string; stateDir?: string }): string[] {
  if (!WSL_DISTRO.test(input.distro)) throw new Error("Invalid WSL distribution");
  if (!/^[0-9A-Za-z.+_-]{1,100}$/.test(input.build)) throw new Error("Invalid build name");
  return ["--distribution", input.distro, "--cd", input.connector, "--exec", "/bin/sh", "dist/wsl-host.sh", input.build,
    ...(input.stateDir ? ["--state-dir", input.stateDir] : [])];
}

/** The same host from a terminal, for reference. */
export function wslCommand(distro: string | undefined, server: string, stateDir: string | undefined, quote: (value: string) => string): string {
  return `wsl${distro ? ` -d ${distro}` : ""} -- npx pikibun@latest connect --server ${quote(server)}${stateDir ? ` --state-dir ${stateDir}` : ""}`;
}
