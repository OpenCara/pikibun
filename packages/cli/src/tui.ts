import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { constants as osConstants } from "node:os";
import path from "node:path";

export const TUI_PACKAGE = "@pikibun/tui";
export const TUI_COMMAND = "pikibun-tui";

export const TUI_USAGE = `Usage: pikibun tui [options]

Pikibun in this terminal: the app's sign-in, sessions and chats, drawn in the terminal. It is its own npm package,
${TUI_PACKAGE}, released with the Pikibun app: this command starts the ${TUI_COMMAND} that is installed, or runs
${TUI_PACKAGE} from npm when none is (install it with npm install -g ${TUI_PACKAGE} to skip that).

The options are ${TUI_COMMAND}'s: run "pikibun tui --help" with it installed for the whole list.
`;

export function findOnPath(name: string, env: NodeJS.ProcessEnv = process.env, platform: string = process.platform, exists: (file: string) => boolean = existsSync): string | null {
  const separator = platform === "win32" ? ";" : ":";
  const join = platform === "win32" ? path.win32.join : path.posix.join;
  const pathVariable = platform === "win32" ? Object.entries(env).find(([key]) => key.toUpperCase() === "PATH")?.[1] : env.PATH;
  const extensions = platform === "win32" ? (env.PATHEXT || ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean) : [""];
  for (const directory of (pathVariable ?? "").split(separator)) {
    if (!directory) continue;
    for (const extension of extensions) {
      const file = join(directory, `${name}${extension.toLowerCase()}`);
      if (exists(file)) return file;
    }
  }
  return null;
}

export type TuiLaunch = { command: string; args: string[]; shell: boolean; fromNpm: boolean };

export function tuiLaunch(args: string[], installed: string | null, platform: string = process.platform): TuiLaunch {
  const shell = (file: string) => platform === "win32" && /\.(?:cmd|bat)$/i.test(file);
  if (installed) return { command: installed, args, shell: shell(installed), fromNpm: false };
  const npx = platform === "win32" ? "npx.cmd" : "npx";
  return { command: npx, args: ["--yes", `${TUI_PACKAGE}@latest`, ...args], shell: platform === "win32", fromNpm: true };
}

export async function tuiMain(args: string[]): Promise<void> {
  const installed = findOnPath(TUI_COMMAND);
  if (!installed && (args.includes("--help") || args.includes("-h"))) {
    process.stdout.write(TUI_USAGE);
    return;
  }
  const launch = tuiLaunch(args, installed);
  if (launch.fromNpm) {
    process.stderr.write(`${TUI_COMMAND} isn't installed: running ${TUI_PACKAGE} from npm. Install it to start it at once: npm install -g ${TUI_PACKAGE}\n`);
  }
  const child = spawn(launch.command, launch.args, { stdio: "inherit", shell: launch.shell });
  const ignore = () => {};
  process.on("SIGINT", ignore);
  try {
    process.exitCode = await new Promise<number>(resolve => {
      child.once("error", error => {
        process.stderr.write(launch.fromNpm
          ? `Couldn't run ${TUI_PACKAGE} from npm (${error.message}): install it with npm install -g ${TUI_PACKAGE}, then run pikibun tui again.\n`
          : `Couldn't start ${launch.command}: ${error.message}\n`);
        resolve(1);
      });
      child.once("exit", (code, signal) => resolve(code ?? (signal ? 128 + (osConstants.signals[signal] ?? 0) : 1)));
    });
  } finally {
    process.off("SIGINT", ignore);
  }
}
