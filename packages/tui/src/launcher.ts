import { spawn } from "node:child_process";
import { accessSync, chmodSync, constants, mkdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { constants as osConstants, homedir } from "node:os";
import path from "node:path";

export const TUI_HOSTS = ["linux-x64", "linux-arm64", "darwin-arm64", "darwin-x64", "win32-x64", "win32-arm64"] as const;
export type TuiHost = (typeof TUI_HOSTS)[number];

export const USAGE = `Usage: pikibun-tui [options]

Pikibun in this terminal: sign in, your sessions and their chats, as in the Pikibun app.

Options:
  --no-mouse                    Leave the mouse to the terminal and its own text selection
  --points-per-cell <WxH>       The size of one terminal Cell in points (8x16 by default)
  --fps                         Show the frame rate and frame times (Ctrl+H then P toggles it)
  --log-file <path>             Where the log goes (Ctrl+H then E shows it)
  --data-dir <path>             Where the app keeps its sign-ins and settings
  --help                        Show this help
  --version                     Show the installed version

Keys: Tab and the arrows move between controls, Enter presses, Escape goes back, Ctrl+S searches the screen,
F10 opens the menu bar, and Ctrl+C copies a selection or quits.
`;

export function hostKey(platform: string = process.platform, arch: string = process.arch): TuiHost | null {
  const key = `${platform}-${arch}`;
  return (TUI_HOSTS as readonly string[]).includes(key) ? (key as TuiHost) : null;
}

export const hostPackage = (host: TuiHost) => `@pikibun/tui-${host}`;
export const hostBinary = (platform: string = process.platform) => (platform === "win32" ? "nsh-tui-host.exe" : "nsh-tui-host");

export type Found = { path: string } | { error: string };

export function findHost(options: { env?: NodeJS.ProcessEnv; platform?: string; arch?: string; resolve: (id: string) => string }): Found {
  const env = options.env ?? process.env;
  if (env.PIKIBUN_TUI_HOST) return { path: env.PIKIBUN_TUI_HOST };
  const platform = options.platform ?? process.platform;
  const arch = options.arch ?? process.arch;
  const host = hostKey(platform, arch);
  if (!host) {
    return { error: `Pikibun's terminal app has no build for ${platform}-${arch}: it runs on Linux, macOS and Windows, on x64 and arm64.` };
  }
  try {
    return { path: options.resolve(`${hostPackage(host)}/bin/${hostBinary(platform)}`) };
  } catch {
    return {
      error: `${hostPackage(host)}, this computer's part of Pikibun's terminal app, isn't installed. npm installs it with @pikibun/tui `
        + "unless optional dependencies are left out (--omit=optional, --no-optional, or npm's omit setting): install @pikibun/tui again without that, "
        + "for example npm install -g @pikibun/tui --include=optional.",
    };
  }
}

export function logFile(env: NodeJS.ProcessEnv = process.env, platform: string = process.platform, home: string = homedir()): string {
  if (platform === "darwin") return path.join(home, "Library", "Logs", "Pikibun", "tui.log");
  if (platform === "win32") return path.win32.join(env.LOCALAPPDATA || path.win32.join(home, "AppData", "Local"), "Pikibun", "Logs", "tui.log");
  return path.join(env.XDG_STATE_HOME || path.join(home, ".local", "state"), "pikibun", "tui.log");
}

const named = (args: string[], option: string) => args.some(arg => arg === option || arg.startsWith(`${option}=`));

export function hostArguments(args: string[], bundle: string, log: string): string[] {
  return ["--bundle", bundle, ...(named(args, "--log-file") ? [] : ["--log-file", log]), ...args];
}

export function exitCode(code: number | null, signal: NodeJS.Signals | null): number {
  if (code !== null) return code;
  const number = signal ? osConstants.signals[signal] : undefined;
  return number ? 128 + number : 1;
}

function executable(file: string): void {
  if (process.platform === "win32") return;
  try {
    accessSync(file, constants.X_OK);
  } catch {
    chmodSync(file, 0o755);
  }
}

export async function main(args: string[], root: string): Promise<number> {
  if (args.includes("--help") || args.includes("-h")) {
    process.stdout.write(USAGE);
    return 0;
  }
  if (args.includes("--version") || args.includes("-v")) {
    process.stdout.write(`${(JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")) as { version: string }).version}\n`);
    return 0;
  }
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    process.stderr.write("pikibun-tui draws in a terminal: run it in one (its input and output aren't a terminal here).\n");
    return 1;
  }
  const require = createRequire(path.join(root, "package.json"));
  const found = findHost({ resolve: id => require.resolve(id) });
  if ("error" in found) {
    process.stderr.write(`${found.error}\n`);
    return 1;
  }
  const log = logFile();
  try {
    executable(found.path);
    if (!named(args, "--log-file")) mkdirSync(path.dirname(log), { recursive: true });
  } catch (error) {
    process.stderr.write(`Pikibun's terminal app can't start: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
  const ownSession = hostInOwnSession();
  const child = spawn(found.path, hostArguments(args, path.join(root, "app", "bundle.js"), log), { stdio: "inherit", detached: ownSession });
  const ignore = () => {};
  const forward = (signal: NodeJS.Signals) => () => { child.kill(signal); };
  const forwarded = forwardedSignals(ownSession).map(signal => [signal, forward(signal)] as const);
  if (!ownSession) process.on("SIGINT", ignore);
  for (const [signal, handler] of forwarded) process.on(signal, handler);
  try {
    return await new Promise<number>(resolve => {
      child.once("error", error => {
        process.stderr.write(`Pikibun's terminal app can't start: ${error.message}\n`);
        resolve(1);
      });
      child.once("exit", (code, signal) => resolve(exitCode(code, signal)));
    });
  } finally {
    process.off("SIGINT", ignore);
    for (const [signal, handler] of forwarded) process.off(signal, handler);
  }
}

export function hostInOwnSession(platform: string = process.platform): boolean {
  return platform !== "win32";
}

export function forwardedSignals(ownSession: boolean): NodeJS.Signals[] {
  return ownSession ? ["SIGTERM", "SIGHUP", "SIGINT", "SIGWINCH"] : ["SIGTERM", "SIGHUP"];
}
