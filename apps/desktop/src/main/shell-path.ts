import { execFile } from "node:child_process";

// A Mac app started from Finder, the Dock or at login gets launchd's PATH (/usr/bin:/bin:/usr/sbin:/sbin), not the one
// its owner's shell sets up: Homebrew (/opt/homebrew/bin), /usr/local/bin, nvm and the like are missing, so the host
// would find no npm (extensions) and only Apple's Git where `pikibun connect` in a terminal finds the owner's. The app
// asks the owner's login shell for its PATH, as a terminal would see it, and starts its native hosts with it.

const MARK = "__PIKIBUN_ENV__";

/**
 * The PATH in `output` of `env` printed between two marks: a shell's startup files may print anything around it (a
 * banner, a warning), and fish quotes a list joined with spaces, so the value is read from env's own `PATH=` line.
 */
export function parseShellPath(output: string): string | undefined {
  const start = output.indexOf(`${MARK}\n`);
  const end = output.lastIndexOf(MARK);
  if (start < 0 || end <= start) return undefined;
  const line = output.slice(start + MARK.length + 1, end).split("\n").find(entry => entry.startsWith("PATH="));
  const value = line?.slice("PATH=".length).trim();
  return value || undefined;
}

/** `first`'s directories, then `second`'s that it lacks: absolute ones only, each once. */
export function mergePath(first: string | undefined, second: string | undefined): string {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const entry of `${first ?? ""}:${second ?? ""}`.split(":")) {
    if (!entry.startsWith("/") || seen.has(entry)) continue;
    seen.add(entry);
    out.push(entry);
  }
  return out.join(":");
}

/**
 * The owner's login shell's PATH (`$SHELL -ilc`, as Terminal starts it), or undefined if it fails or takes longer than
 * `timeoutMs`: then the app keeps its own. Runs only the owner's own shell and its startup files, with a fixed command.
 */
export function loginShellPath(shell = process.env.SHELL || "/bin/zsh", timeoutMs = 5_000): Promise<string | undefined> {
  if (!shell.startsWith("/")) return Promise.resolve(undefined);
  return new Promise(resolve => {
    execFile(shell, ["-ilc", `echo ${MARK}; /usr/bin/env; echo ${MARK}`],
      { encoding: "utf8", timeout: timeoutMs, maxBuffer: 1024 * 1024, env: { ...process.env, TERM: "dumb" } },
      (_error, stdout) => resolve(parseShellPath(String(stdout ?? ""))));
  });
}

/** `env` with the login shell's PATH ahead of its own; `env` unchanged if the shell didn't answer. */
export async function withLoginShellPath(env: NodeJS.ProcessEnv, lookup: () => Promise<string | undefined> = loginShellPath): Promise<NodeJS.ProcessEnv> {
  const shellPath = await lookup().catch(() => undefined);
  return shellPath ? { ...env, PATH: mergePath(shellPath, env.PATH) } : env;
}
