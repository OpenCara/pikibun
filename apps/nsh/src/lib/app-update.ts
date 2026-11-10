import { exists, mkdir, readdir, readFile, stat, unlink, writeFile } from "fs/promises";
import { platform, signal, untracked } from "nsh";
import { Window } from "nsh/desktop";
import nshProcess from "process";
import { APP_VERSION } from "../app-version";
import { thisComputer } from "./this-computer";
import { LINUX_INSTALL, MAC_INSTALL, utf16le, windowsUpdateTask } from "./update-scripts";

const REPOSITORY = "https://github.com/OpenCara/pikibun";
export const RELEASES_API = "https://api.github.com/repos/OpenCara/pikibun/releases?per_page=30";
const USER_AGENT = "Pikibun-App";
const TAG = /^app-v(.+)$/;
const VERSION = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-((?:0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*))*))?$/;
const DIGEST = /^sha256:([0-9a-f]{64})$/;
const UPDATES_FOLDER = "updates";
const PENDING = "pending.json";
const INSTALL_LOG = "install.log";
const WINDOWS_TASK = "Pikibun update";
const PART_BYTES = 4 * 1024 * 1024;
const PROGRESS_EVERY_MS = 100;
const FIRST_CHECK_MS = 5_000;
const CHECK_EVERY_MS = 6 * 60 * 60 * 1000;

export interface ReleaseAsset { name: string; url: string; size: number; sha256: string }

export interface AvailableUpdate {
  version: string;
  tag: string;
  page: string;
  asset: ReleaseAsset | null;
}

export const isVersion = (version: string) => VERSION.test(version);
const isPrerelease = (version: string) => VERSION.exec(version)?.[4] !== undefined;

export function compareVersions(a: string, b: string): number | undefined {
  const left = VERSION.exec(a);
  const right = VERSION.exec(b);
  if (!left || !right) return undefined;
  for (let index = 1; index <= 3; index++) {
    const difference = Number(left[index]) - Number(right[index]);
    if (difference) return Math.sign(difference);
  }
  const [leftPre, rightPre] = [left[4], right[4]];
  if (!leftPre || !rightPre) return leftPre ? -1 : rightPre ? 1 : 0;
  const leftIds = leftPre.split(".");
  const rightIds = rightPre.split(".");
  for (let index = 0; index < Math.max(leftIds.length, rightIds.length); index++) {
    const [x, y] = [leftIds[index], rightIds[index]];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    if (x === y) continue;
    const [xNumeric, yNumeric] = [/^[0-9]+$/.test(x), /^[0-9]+$/.test(y)];
    if (xNumeric && yNumeric) return Math.sign(Number(x) - Number(y));
    if (xNumeric !== yNumeric) return xNumeric ? -1 : 1;
    return x < y ? -1 : 1;
  }
  return 0;
}

export function assetSuffix(os: string, arch: string): string | null {
  if (os === "windows" && arch === "x86_64") return "windows-x64-setup.exe";
  if (os === "macos" && arch === "aarch64") return "macos-arm64.dmg";
  if (os === "linux" && arch === "x86_64") return "linux-x86_64.tar.gz";
  return null;
}

function releaseAsset(assets: unknown, tag: string, version: string, os: string, arch: string): ReleaseAsset | null {
  const suffix = assetSuffix(os, arch);
  if (!suffix || !Array.isArray(assets)) return null;
  const name = `Pikibun-${version}-${suffix}`;
  for (const asset of assets) {
    if (!asset || typeof asset !== "object") continue;
    const entry = asset as Record<string, unknown>;
    if (entry.name !== name || (entry.state !== undefined && entry.state !== "uploaded")) continue;
    const size = typeof entry.size === "number" && Number.isSafeInteger(entry.size) && entry.size > 0 ? entry.size : 0;
    const sha256 = typeof entry.digest === "string" ? DIGEST.exec(entry.digest)?.[1] : undefined;
    if (!sha256) return null;
    return { name, url: `${REPOSITORY}/releases/download/${tag}/${name}`, size, sha256 };
  }
  return null;
}

export function newerRelease(releases: unknown, current: string, os: string, arch: string): AvailableUpdate | undefined {
  if (!Array.isArray(releases) || !isVersion(current)) return undefined;
  const prereleases = isPrerelease(current);
  let best: { version: string; assets: unknown } | undefined;
  for (const release of releases) {
    if (!release || typeof release !== "object") continue;
    const { tag_name: tag, draft, prerelease, assets } = release as Record<string, unknown>;
    const version = typeof tag === "string" ? TAG.exec(tag)?.[1] : undefined;
    if (!version || !isVersion(version) || draft !== false) continue;
    if ((prerelease !== false || isPrerelease(version)) && !prereleases) continue;
    if (!best || compareVersions(version, best.version) === 1) best = { version, assets };
  }
  if (!best || compareVersions(best.version, current) !== 1) return undefined;
  const tag = `app-v${best.version}`;
  return { version: best.version, tag, page: `${REPOSITORY}/releases/tag/${tag}`, asset: releaseAsset(best.assets, tag, best.version, os, arch) };
}

export interface CleanUp { installed?: string; failed?: string }

export interface UpdateRunner {
  download(asset: ReleaseAsset, progress: (loaded: number, total: number) => void): Promise<string>;
  install(file: string, update: AvailableUpdate): Promise<void>;
  restart(): Promise<void>;
  cleanUp(current: string): Promise<CleanUp>;
}

function separator(): string { return platform.os === "windows" ? "\\" : "/"; }

export function updatesFolder(os: string, dataDir: string | null | undefined): string | null {
  if (!dataDir) return null;
  return `${dataDir.replace(/[\\/]+$/, "")}${os === "windows" ? "\\" : "/"}${UPDATES_FOLDER}`;
}

function folder(): string {
  const dir = updatesFolder(platform.os, nshProcess.dataDir);
  if (!dir) throw new Error("This app has no data folder to download the update into.");
  return dir;
}

const inFolder = (dir: string, name: string) => `${dir}${separator()}${name}`;

async function emptyFolder(dir: string, keep: readonly string[] = []): Promise<void> {
  let names: string[];
  try { names = await readdir(dir); } catch { return; }
  for (const name of names) {
    if (keep.includes(name)) continue;
    try { await unlink(inFolder(dir, name)); } catch { }
  }
}

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error));
const lastLines = (text: string) => text.split(/\r?\n/).map(line => line.trim()).filter(Boolean).slice(-3).join(" ");

async function joinParts(dir: string, parts: readonly string[], name: string): Promise<void> {
  const output = platform.os === "windows"
    ? await nshProcess.run("cmd", ["/d", "/c", "copy", "/b", "/y", parts.join("+"), name], { cwd: dir, timeoutMs: 120_000 })
    : await nshProcess.run("sh", ["-c", "out=$1; shift; cat -- \"$@\" > \"$out\"", "pikibun-update", name, ...parts], { cwd: dir, timeoutMs: 120_000 });
  if (output.code !== 0) throw new Error(`The download couldn't be saved: ${lastLines(`${output.stderr}\n${output.stdout}`) || `exit code ${output.code ?? "unknown"}`}`);
  for (const part of parts) { try { await unlink(inFolder(dir, part)); } catch { } }
}

async function download(asset: ReleaseAsset, progress: (loaded: number, total: number) => void): Promise<string> {
  return downloadInto(folder(), asset, progress);
}

export async function downloadInto(dir: string, asset: ReleaseAsset, progress: (loaded: number, total: number) => void): Promise<string> {
  await mkdir(dir, { recursive: true });
  await emptyFolder(dir);
  const response = await fetch(asset.url, { headers: { Accept: "application/octet-stream", "User-Agent": USER_AGENT } });
  if (!response.ok || !response.body) throw new Error(`The download failed: GitHub answered ${response.status}.`);
  const total = asset.size || Number(response.headers.get("content-length") ?? 0) || 0;
  const hash = crypto.createHash("sha256");
  const reader = response.body.getReader();
  const parts: string[] = [];
  let pending: Uint8Array[] = [];
  let pendingBytes = 0;
  let loaded = 0;
  let reported = 0;
  const flush = async () => {
    if (!pendingBytes) return;
    const bytes = new Uint8Array(pendingBytes);
    let offset = 0;
    for (const chunk of pending) { bytes.set(chunk, offset); offset += chunk.length; }
    pending = [];
    pendingBytes = 0;
    for (let start = 0; start < bytes.length; start += PART_BYTES) {
      const name = `part-${String(parts.length).padStart(4, "0")}`;
      await writeFile(inFolder(dir, name), bytes.subarray(start, Math.min(bytes.length, start + PART_BYTES)));
      parts.push(name);
    }
  };
  progress(0, total);
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value?.length) continue;
    hash.update(value);
    pending.push(value);
    pendingBytes += value.length;
    loaded += value.length;
    if (total && loaded > total) throw new Error("The download is larger than GitHub said it is.");
    if (pendingBytes >= PART_BYTES) await flush();
    if (Date.now() - reported >= PROGRESS_EVERY_MS) { reported = Date.now(); progress(loaded, total); }
  }
  await flush();
  progress(loaded, total);
  if (asset.size && loaded !== asset.size) throw new Error(`The download stopped early (${loaded} of ${asset.size} bytes). Try again.`);
  if (hash.digest("hex") !== asset.sha256) throw new Error("The download doesn't match the checksum GitHub published for it. Try again.");
  if (!parts.length) throw new Error("The download was empty.");
  await joinParts(dir, parts, asset.name);
  const file = inFolder(dir, asset.name);
  if ((await stat(file)).size !== loaded) throw new Error("The download couldn't be saved whole.");
  return file;
}

async function writePending(dir: string, version: string): Promise<void> {
  await writeFile(inFolder(dir, PENDING), JSON.stringify({ version, at: new Date().toISOString() }));
}

async function forgetPending(dir: string): Promise<void> {
  try { await unlink(inFolder(dir, PENDING)); } catch { }
}

function windowsUser(): string | undefined {
  const env = nshProcess.env;
  const name = env.USERNAME?.trim();
  if (!name) return undefined;
  const domain = env.USERDOMAIN?.trim();
  return domain ? `${domain}\\${name}` : name;
}

async function installWindows(file: string, update: AvailableUpdate): Promise<void> {
  const dir = folder();
  const xml = inFolder(dir, "update-task.xml");
  await writeFile(xml, utf16le(windowsUpdateTask(file, inFolder(dir, INSTALL_LOG), windowsUser())));
  const created = await nshProcess.run("schtasks", ["/Create", "/TN", WINDOWS_TASK, "/XML", xml, "/F"], { cwd: dir, timeoutMs: 60_000 });
  if (created.code !== 0) throw new Error(`Windows' Task Scheduler didn't take the update: ${lastLines(`${created.stderr}\n${created.stdout}`) || `exit code ${created.code ?? "unknown"}`}`);
  await writePending(dir, update.version);
  const started = await nshProcess.run("schtasks", ["/Run", "/TN", WINDOWS_TASK], { cwd: dir, timeoutMs: 60_000 })
    .catch((error: unknown) => ({ code: null, stdout: "", stderr: messageOf(error) }));
  if (started.code !== 0) {
    await forgetPending(dir);
    await nshProcess.run("schtasks", ["/Delete", "/TN", WINDOWS_TASK, "/F"], { cwd: dir, timeoutMs: 60_000 }).catch(() => undefined);
    throw new Error(`The installer didn't start: ${lastLines(`${started.stderr}\n${started.stdout}`) || `exit code ${started.code ?? "unknown"}`}`);
  }
}

async function installUnix(file: string, update: AvailableUpdate): Promise<void> {
  const dir = folder();
  await writePending(dir, update.version);
  const script = platform.os === "macos" ? MAC_INSTALL : LINUX_INSTALL;
  const output = await nshProcess.run("sh", ["-c", script, "pikibun-update", file], { cwd: dir, timeoutMs: 5 * 60_000 })
    .catch((error: unknown) => ({ code: null, stdout: "", stderr: `The update didn't install: ${messageOf(error)}` }));
  if (output.code !== 0) {
    await forgetPending(dir);
    throw new Error(lastLines(output.stderr) || `The update didn't install (exit code ${output.code ?? "unknown"}).`);
  }
}

async function restart(): Promise<void> {
  await Promise.race([thisComputer().shutdown(), new Promise<void>(resolve => setTimeout(resolve, 12_000))]).catch(() => undefined);
  try { nshProcess.exit(0); return; } catch { }
  Window.close();
}

async function cleanUp(current: string): Promise<CleanUp> {
  const dir = updatesFolder(platform.os, nshProcess.dataDir);
  if (!dir || !(await exists(dir).catch(() => false))) return {};
  let version: string | undefined;
  try {
    const pending = JSON.parse(await readFile(inFolder(dir, PENDING), "utf8")) as { version?: unknown };
    if (typeof pending.version === "string" && isVersion(pending.version)) version = pending.version;
  } catch { }
  if (version && platform.os === "windows") {
    await nshProcess.run("schtasks", ["/Delete", "/TN", WINDOWS_TASK, "/F"], { cwd: dir, timeoutMs: 60_000 }).catch(() => undefined);
  }
  const installed = version !== undefined && compareVersions(current, version) !== -1;
  await emptyFolder(dir, version && !installed ? [INSTALL_LOG] : []);
  if (!version) return {};
  return installed ? { installed: version } : { failed: version };
}

export const nativeRunner: UpdateRunner = {
  download,
  install: (file, update) => (platform.os === "windows" ? installWindows(file, update) : installUnix(file, update)),
  restart,
  cleanUp,
};

export type UpdatePhase =
  | { name: "idle" }
  | { name: "downloading"; loaded: number; total: number }
  | { name: "installing" }
  | { name: "restarting" }
  | { name: "failed"; error: string };

export interface UpdaterOptions {
  current: string;
  os: string;
  arch: string;
  runner: UpdateRunner;
}

const desktopOs = (os: string) => os === "macos" || os === "windows" || os === "linux";

export class AppUpdater {
  readonly available = signal<AvailableUpdate | null>(null);
  readonly phase = signal<UpdatePhase>({ name: "idle" });
  readonly checking = signal(false);
  readonly checked = signal(false);
  readonly checkError = signal("");
  readonly notice = signal("");
  private timers: ReturnType<typeof setTimeout>[] = [];
  private started = false;
  private cleaned: Promise<void> = Promise.resolve();

  constructor(readonly options: UpdaterOptions) {}

  get current(): string { return this.options.current; }
  get offered(): boolean { return desktopOs(this.options.os) && isVersion(this.options.current); }
  get busy(): boolean {
    const name = untracked(this.phase).name;
    return name === "downloading" || name === "installing" || name === "restarting";
  }

  async check(): Promise<boolean> {
    if (!this.offered || untracked(this.checking)) return false;
    this.checking.set(true);
    try {
      const response = await fetch(RELEASES_API, { headers: { Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28", "User-Agent": USER_AGENT } });
      if (!response.ok) throw new Error(response.status === 403 || response.status === 429 ? "GitHub limits how often it is asked: try again later." : `GitHub answered ${response.status}.`);
      const releases: unknown = await response.json();
      if (!Array.isArray(releases)) throw new Error("GitHub's answer had no releases.");
      const next = newerRelease(releases, this.options.current, this.options.os, this.options.arch) ?? null;
      if (!this.busy && (next?.version !== untracked(this.available)?.version || next?.asset?.url !== untracked(this.available)?.asset?.url)) this.available.set(next);
      this.checkError.set("");
      this.checked.set(true);
      return true;
    } catch (error) {
      this.checkError.set(`Couldn't check for updates: ${messageOf(error)}`);
      return false;
    } finally {
      this.checking.set(false);
    }
  }

  start(delay = FIRST_CHECK_MS, interval = CHECK_EVERY_MS): void {
    if (this.started || !this.offered) return;
    this.started = true;
    this.cleaned = this.options.runner.cleanUp(this.options.current).then(result => {
      if (result.installed) this.notice.set(`Pikibun was updated to ${result.installed}.`);
      else if (result.failed && untracked(this.phase).name === "idle") {
        this.phase.set({ name: "failed", error: `The update to ${result.failed} didn't install${this.options.os === "windows" ? `: its installer's log is ${INSTALL_LOG} in Pikibun's updates folder` : ""}. Try again, or install it from its release page.` });
      }
    }, () => undefined);
    const schedule = (wait: number) => {
      this.timers.push(setTimeout(() => {
        void this.check();
        schedule(interval);
      }, wait));
    };
    schedule(delay);
  }

  stop(): void {
    for (const timer of this.timers) clearTimeout(timer);
    this.timers = [];
    this.started = false;
  }

  async install(): Promise<boolean> {
    const update = untracked(this.available);
    if (!update?.asset || this.busy) return false;
    const asset = update.asset;
    const runner = this.options.runner;
    this.notice.set("");
    try {
      this.phase.set({ name: "downloading", loaded: 0, total: asset.size });
      await this.cleaned;
      const file = await runner.download(asset, (loaded, total) => this.phase.set({ name: "downloading", loaded, total }));
      this.phase.set({ name: "installing" });
      await runner.install(file, update);
      this.phase.set({ name: "restarting" });
      await runner.restart();
      return true;
    } catch (error) {
      this.phase.set({ name: "failed", error: messageOf(error) });
      return false;
    }
  }
}

const defaults = (): UpdaterOptions => ({ current: APP_VERSION, os: platform.os, arch: nshProcess.arch, runner: nativeRunner });
let configured: Partial<UpdaterOptions> = {};
let shared: AppUpdater | undefined;

export function configureAppUpdate(options: Partial<UpdaterOptions>): AppUpdater {
  shared?.stop();
  configured = options;
  shared = undefined;
  return appUpdate();
}

export function appUpdate(): AppUpdater {
  shared ??= new AppUpdater({ ...defaults(), ...configured });
  return shared;
}

export function startUpdateChecks(): void {
  const updater = appUpdate();
  if (updater.offered) updater.start();
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.max(0, Math.round(bytes / 1024))} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
