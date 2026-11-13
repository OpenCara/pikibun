import { accessSync, closeSync, constants, openSync, readdirSync, readSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, relative, sep } from "node:path";

export interface BrowserToolchain {
  executable: string;
  directory: string;
}

const MARKERS = ["icudtl.dat", "resources.pak", "chrome_100_percent.pak", "headless_lib_data.pak", "v8_context_snapshot.bin", "snapshot_blob.bin"];

export const SYSTEM_BROWSERS: readonly string[] = Object.freeze([
  "/usr/lib/chromium/chromium", "/usr/lib64/chromium/chromium", "/usr/lib/chromium-browser/chromium-browser",
  "/usr/lib64/chromium-browser/chromium-browser", "/opt/google/chrome/chrome", "/opt/microsoft/msedge/msedge",
]);

const has = (path: string) => { try { statSync(path); return true; } catch { return false; } };

function elf(path: string): boolean {
  let fd: number | undefined;
  try {
    fd = openSync(path, constants.O_RDONLY);
    const head = Buffer.alloc(4);
    return readSync(fd, head, 0, 4, 0) === 4 && head.equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46]));
  } catch { return false; }
  finally { if (fd !== undefined) closeSync(fd); }
}

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
  let home = options.home ?? homedir();
  try { home = realpathSync(home); } catch { }
  const inside = relative(directory, home);
  if (directory === sep || inside === "" || (!inside.startsWith("..") && !inside.startsWith(sep))) {
    return { error: `${directory} is / or a home directory, which sessions would get whole: give a Chromium in a directory of its own` };
  }
  if (!elf(executable)) return { error: `${executable} isn't a program but a script or another file: give the Chromium executable itself, such as /usr/lib/chromium/chromium rather than /usr/bin/chromium` };
  if (!MARKERS.some(name => has(join(directory, name)))) return { error: `${directory} doesn't hold Chromium's own files (icudtl.dat or its .pak files) beside ${basename(executable)}` };
  return { browser: { executable, directory } };
}

export function browserAt(path: string, options: { platform?: NodeJS.Platform; home?: string } = {}): BrowserToolchain | undefined {
  const found = inspectBrowser(path, options);
  return "browser" in found ? found.browser : undefined;
}

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

export function hostBrowser(options: { env?: NodeJS.ProcessEnv; platform?: NodeJS.Platform; home?: string } = {}): BrowserToolchain | undefined {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const home = options.home ?? homedir();
  const at = (path: string) => browserAt(path, { platform, home });
  if (platform !== "linux") return undefined;
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
export function connectorBrowser(): BrowserToolchain | undefined {
  detected ??= { value: hostBrowser() };
  return detected.value;
}

export function browserEnvironment(executable: string | undefined): Record<string, string> {
  return executable ? { CHROME_BIN: executable, PUPPETEER_EXECUTABLE_PATH: executable } : {};
}

export const SANDBOX_BROWSER_DIRECTORY = "/opt/pikibun/chromium";
export const SANDBOX_BROWSER_DRIVER = "/opt/pikibun/browser/pikibun-browser";

export function sandboxBrowserMount(browser: BrowserToolchain | undefined): { mount?: { source: string; target: string }; executable: string } | undefined {
  if (!browser) return undefined;
  if (["/usr", "/lib", "/lib64"].some(root => browser.directory.startsWith(`${root}/`))) return { executable: browser.executable };
  return { mount: { source: browser.directory, target: SANDBOX_BROWSER_DIRECTORY }, executable: `${SANDBOX_BROWSER_DIRECTORY}/${basename(browser.executable)}` };
}
