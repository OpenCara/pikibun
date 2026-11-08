import type { SandboxChoice } from "./settings.js";
import { wslCommand } from "./wsl.js";

// The `pikibun connect` command that runs the same host as one of the app's connections from a terminal, shown for
// reference and copied by its owner. Pure, so tests run it without Electron.

export interface ConnectCommandInput {
  server: string;
  /** The connection's state directory where it runs here, or undefined for the CLI's own. */
  stateDir: string | undefined;
  /** In WSL2, inside the distribution: `~/…`, which its shell expands, or undefined for the CLI's own. */
  wslStateDir: string | undefined;
  /** Windows and macOS: where the host's sessions run. */
  sandbox: SandboxChoice | undefined;
  home: string;
  windows: boolean;
}

/** A shell word: as is when safe, else quoted for the terminal it is run in (cmd and PowerShell, or a POSIX shell). */
export function quoteFor(windows: boolean): (value: string) => string {
  return value => /^[A-Za-z0-9_./:@~-]+$/.test(value) ? value : windows ? `"${value}"` : `'${value.replace(/'/g, "'\\''")}'`;
}

export function connectCommand(input: ConnectCommandInput): string {
  const quote = quoteFor(input.windows);
  if (input.sandbox?.sandbox === "wsl2") return wslCommand(input.sandbox.distro, input.server, input.wslStateDir, quote);
  // A POSIX shell expands a leading ~; cmd and PowerShell don't for a program's arguments, so Windows shows the whole path.
  const directory = input.stateDir;
  const shown = !input.windows && directory?.startsWith(`${input.home}/`) ? `~${directory.slice(input.home.length)}` : directory;
  // macOS's CLI wants a choice: its own sandbox, or none (the app asks for consent at each start, the CLI at its prompt).
  const sandbox = input.sandbox?.sandbox;
  const flag = sandbox === "native" || sandbox === "seatbelt" ? " --experimental-sandbox" : sandbox === "none" ? " --unsafe-no-sandbox" : "";
  return `npx pikibun@latest connect --server ${quote(input.server)}${flag}${shown ? ` --state-dir ${quote(shown)}` : ""}`;
}
