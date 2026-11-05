import { accessSync, closeSync, constants, openSync, readdirSync, readSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, relative, sep } from "node:path";

/*
 * The Chromium the browser tool runs in the session's Linux sandbox (piki:browser): the host's own, as its owner
 * installed it, since sessions have no way to download one. It never runs on the host itself: its DevTools connection
 * would reach the host's files and network as its user. It is found once, where the connector starts its sessions:
 * - PIKIBUN_BROWSER, the path of a Chromium executable (Chromium, Google Chrome, Edge, or a headless shell), set for the
 *   connector by the host's owner;
 * - else a system install, such as Debian's and Fedora's chromium packages (/usr/lib/chromium/chromium; not the snap,
 *   which can't run in another sandbox), Google Chrome or Edge in /opt;
 * - else the newest one Playwright or Puppeteer downloaded to the host user's cache (`npx playwright install chromium`).
 * Only an installation is taken: a real executable beside the files every Chromium has (its ICU data, resource packs or
 * V8 snapshot), never a wrapper script or a lone binary in a directory that holds anything else. The Linux sandbox
 * gives commands that directory alone, read-only, and only where they don't already see it in /usr.
 */

export interface BrowserToolchain {
  /** The Chromium executable on the host, through links. */
  executable: string;
  /** Its installation: the directory it is in, with its resources and libraries. */
  directory: string;
}

/** Files a Chromium installation has beside its executable; one of them is enough. */
const MARKERS = ["icudtl.dat", "resources.pak", "chrome_100_percent.pak", "headless_lib_data.pak", "v8_context_snapshot.bin", "snapshot_blob.bin"];

/** Where Linux distributions and vendors install Chromium's executable itself (not their /usr/bin wrapper scripts). */
export const SYSTEM_BROWSERS: readonly string[] = Object.freeze([
  "/usr/lib/chromium/chromium", "/usr/lib64/chromium/chromium", "/usr/lib/chromium-browser/chromium-browser",
  "/usr/lib64/chromium-browser/chromium-browser", "/opt/google/chrome/chrome", "/opt/microsoft/msedge/msedge",
]);

const has = (path: string) => { try { statSync(path); return true; } catch { return false; } };

/** Whether `path` starts as a Linux executable does, rather than a script that runs one. */
function elf(path: string): boolean {
  let fd: number | undefined;
  try {
    fd = openSync(path, constants.O_RDONLY);
    const head = Buffer.alloc(4);
    return readSync(fd, head, 0, 4, 0) === 4 && head.equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46]));
  } catch { return false; }
  finally { if (fd !== undefined) closeSync(fd); }
}

/**
 * The installation `path` names, or why it isn't one: a real executable file, an ELF beside one of a Chromium's own
 * files, in a directory that is neither / nor the host user's home or above it. The reasons are for the host's owner,
 * who chose the path.
 */
export function inspectBrowser(path: string, options: { platform?: NodeJS.Platform; home?: string } = {}): { browser: BrowserToolchain } | { error: string } {
  const platform = options.platform ?? process.platform;
  if (platform !== "linux") return { error: "The browser runs in the Linux sandbox only" };
  let executable: string;
  try { executable = realpathSync(path); } catch { return { error: `Nothing is at ${path}` }; }
  try {
    if (!statSync(executable).isFile()) return { error: `${executable} isn't a file` };
    accessSync(executable, constants.X_OK);
  } catch { return { error: `${executable} isn't executable` }; }
  const directory = dirname(executable);
  // Through links too, as the executable is: a home at /home/jo that is /var/home/jo is still the home.
  let home = options.home ?? homedir();
  try { home = realpathSync(home); } catch { /* A home that isn't there holds no browser. */ }
  const inside = relative(directory, home);
  if (directory === sep || inside === "" || (!inside.startsWith("..") && !inside.startsWith(sep))) {
    return { error: `${directory} is / or a home directory, which sessions would get whole: give a Chromium in a directory of its own` };
  }
  if (!elf(executable)) return { error: `${executable} isn't a program but a script or another file: give the Chromium executable itself, such as /usr/lib/chromium/chromium rather than /usr/bin/chromium` };
  if (!MARKERS.some(name => has(join(directory, name)))) return { error: `${directory} doesn't hold Chromium's own files (icudtl.dat or its .pak files) beside ${basename(executable)}` };
  return { browser: { executable, directory } };
}

/** The installation `path` names, or undefined where it isn't one (inspectBrowser). */
export function browserAt(path: string, options: { platform?: NodeJS.Platform; home?: string } = {}): BrowserToolchain | undefined {
  const found = inspectBrowser(path, options);
  return "browser" in found ? found.browser : undefined;
}

/** Chromium builds Playwright and Puppeteer downloaded under `cache` (the host user's ~/.cache), newest first. */
export function downloadedBrowsers(cache: string, playwright = join(cache, "ms-playwright")): string[] {
  const entries = (directory: string) => { try { return readdirSync(directory); } catch { return []; } };
  const found: { path: string; order: number[] }[] = [];
  const version = (text: string) => text.split(/[.-]/).map(Number).filter(Number.isFinite);
  for (const name of entries(playwright)) {
    const match = /^chromium(?:_headless_shell)?-(\d+)$/.exec(name);
    if (!match) continue;
    for (const inner of ["chrome-headless-shell-linux64/chrome-headless-shell", "chrome-linux/headless_shell", "chrome-linux64/chrome", "chrome-linux/chrome"]) {
      found.push({ path: join(playwright, name, inner), order: [Number(match[1])] });
    }
  }
  for (const [kind, inner] of [["chrome-headless-shell", "chrome-headless-shell-linux64/chrome-headless-shell"], ["chrome", "chrome-linux64/chrome"]] as const) {
    const root = join(cache, "puppeteer", kind);
    for (const name of entries(root)) {
      const match = /^linux-([\d.]+)$/.exec(name);
      if (match) found.push({ path: join(root, name, inner), order: version(match[1]!) });
    }
  }
  const newer = (a: number[], b: number[]) => { for (let index = 0; index < Math.max(a.length, b.length); index++) { const d = (b[index] ?? 0) - (a[index] ?? 0); if (d) return d; } return 0; };
  return found.sort((a, b) => newer(a.order, b.order)).map(item => item.path);
}

/**
 * The host's Chromium for the browser tool, or undefined where it has none the Linux sandbox can run (and on other
 * systems, whose sandboxes can't run one yet). `env`, `platform` and `home`: the connector's, unless a test gives others.
 */
export function hostBrowser(options: { env?: NodeJS.ProcessEnv; platform?: NodeJS.Platform; home?: string } = {}): BrowserToolchain | undefined {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const home = options.home ?? homedir();
  const at = (path: string) => browserAt(path, { platform, home });
  if (platform !== "linux") return undefined;
  // A path the host's owner chose is that one or none: never a different browser than they named.
  if (env.PIKIBUN_BROWSER) return at(env.PIKIBUN_BROWSER);
  const cache = env.XDG_CACHE_HOME || join(home, ".cache");
  const candidates = [...SYSTEM_BROWSERS, ...downloadedBrowsers(cache, env.PLAYWRIGHT_BROWSERS_PATH || join(cache, "ms-playwright"))];
  for (const path of candidates) {
    const found = at(path);
    if (found) return found;
  }
  return undefined;
}

let detected: { value: BrowserToolchain | undefined } | undefined;
/**
 * hostBrowser(), found once per process, for a runner no connector gives a browser: a connector applies its owner's
 * choice instead, and keeps it current (HostBrowserSource, browser-host.ts).
 */
export function connectorBrowser(): BrowserToolchain | undefined {
  detected ??= { value: hostBrowser() };
  return detected.value;
}

/** Where the Linux sandbox puts the host's Chromium when commands don't already see it (in /usr). */
export const SANDBOX_BROWSER_DIRECTORY = "/opt/pikibun/chromium";
/** Where the Linux sandbox puts the browser tool's driver. */
export const SANDBOX_BROWSER_DRIVER = "/opt/pikibun/browser/pikibun-browser";

/**
 * How the Linux sandbox gives `browser` to shell commands: nothing to mount where it is in what every sandbox mounts
 * (/usr, /lib, /lib64), otherwise its installation directory read-only at SANDBOX_BROWSER_DIRECTORY; and the executable
 * as commands see it.
 */
export function sandboxBrowserMount(browser: BrowserToolchain | undefined): { mount?: { source: string; target: string }; executable: string } | undefined {
  if (!browser) return undefined;
  if (["/usr", "/lib", "/lib64"].some(root => browser.directory.startsWith(`${root}/`))) return { executable: browser.executable };
  return { mount: { source: browser.directory, target: SANDBOX_BROWSER_DIRECTORY }, executable: `${SANDBOX_BROWSER_DIRECTORY}/${basename(browser.executable)}` };
}
